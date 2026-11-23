import { GOAL_CONTINUE_CUSTOM_TYPE, type AgentMessage, type ContentBlock, type PiEvent, type Usage } from '@shared/types'
import { goalResumeTime, normalizePiEvent, type StreamContext, type StreamEvent, type StreamEventStatus } from './stream-events'

export type { StreamContext } from './stream-events'

/* ------------------------------------------------------------------ *
 * Run / turn identity
 *
 * Pi's protocol has no run or turn id of its own, so the client mints
 * them: one run per `agent_start` (a prompt plus the automatic work that
 * follows it) and one turn per `turn_start`. They are what makes a live
 * stream and a replayed history comparable, and they are the key the
 * session-isolation guard uses. `StreamContext` lives in the adapter now;
 * it is re-exported here because `applyEvent` is the public entry point.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Thread items
 * ------------------------------------------------------------------ */

export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; redacted?: true }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'toolCall'; id: string; name: string; argsText?: string; args?: Record<string, unknown> }

/**
 * A tool call moves through `proposed` (the model named it) → `running`
 * (Pi is executing it) → `ok` / `error` / `aborted`. A call that is
 * intercepted before it runs stays `proposed`: it was never executed, so
 * it must not be shown as a success.
 */
export type ToolStatus = 'proposed' | 'running' | 'ok' | 'error' | 'aborted'

export interface UserItem {
  id: string
  kind: 'user'
  text: string
  images: { data: string; mimeType: string }[]
  /** The user message's persisted Pi session entry. */
  entryId?: string
  timestamp: number
  order: number
  /** Adapter-minted message identity, used to ignore a duplicated start. */
  messageId?: string
  runId?: string
  turnId?: string
  /** Session key of the normalized event that created the item. */
  threadId?: string
  /** Sequence of that event, monotonic per thread. */
  sequence?: number
  /**
   * A prompt the reader sent that Pi has not echoed back yet.
   *
   * It can be waiting for the working-folder lock in the main process, so the
   * composer is already empty while the message is still on its way. The
   * bubble keeps the prompt visible instead of letting it vanish into a status
   * line until `message_start` returns it.
   */
  pending?: boolean
}

export interface AssistantItem {
  id: string
  kind: 'assistant'
  blocks: AssistantBlock[]
  usage?: Usage
  model?: string
  stopReason?: string
  error?: string
  /**
   * Time Pi spent generating this answer, when it reported one.
   *
   * The message timestamp marks the start of the answer, so a replayed turn
   * can still tell when its last answer finished: timestamp + durationMs.
   */
  durationMs?: number
  streaming: boolean
  timestamp: number
  order: number
  /** Adapter-minted message identity, used to ignore a duplicated start. */
  messageId?: string
  runId?: string
  turnId?: string
  threadId?: string
  sequence?: number
}

export interface ToolItem {
  id: string
  kind: 'tool'
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  status: ToolStatus
  result?: string
  /** Structured tool progress, preserved for projections such as the subagent tree. */
  details?: unknown
  isError?: boolean
  durationMs?: number
  /**
   * The newest partial result of a running tool.
   *
   * Pi reports the *latest* partial result, not an increment, so this is
   * replaced on every update instead of being appended to.
   */
  progress?: string
  /** Exit code of a shell command, when the tool reported one. */
  exitCode?: number
  /** Milliseconds since the epoch, from the monotonic-ish event timestamps. */
  startedAt?: number
  finishedAt?: number
  timestamp: number
  order: number
  runId?: string
  turnId?: string
  threadId?: string
  sequence?: number
}

export interface BashItem {
  id: string
  kind: 'bash'
  command: string
  output: string
  exitCode?: number
  excludeFromContext?: boolean
  timestamp: number
  order: number
  threadId?: string
  sequence?: number
}

export interface NoticeItem {
  id: string
  kind: 'notice'
  level: 'info' | 'warn' | 'error' | 'success'
  text: string
  timestamp: number
  order: number
  runId?: string
  source?: 'retry'
  threadId?: string
  sequence?: number
  status?: StreamEventStatus
}

export interface RoundBreakItem {
  id: string
  kind: 'roundBreak'
  entryId?: string
  resumed?: boolean
  timestamp: number
  order: number
  runId?: string
  turnId?: string
  threadId?: string
  sequence?: number
}

export type ThreadItem = UserItem | AssistantItem | ToolItem | BashItem | NoticeItem | RoundBreakItem

interface ThreadItemsChange {
  base: WeakRef<ThreadItem[]>
  firstChangedIndex: number
}

interface ThreadItemIndexes {
  byId: Map<string, number>
  byToolCallId: Map<string, number>
  byMessageId: Map<string, number>
}

interface MutableThreadItemsDraft {
  base: ThreadItem[]
  indexes?: ThreadItemIndexes
  firstChangedIndex: number
  changed: boolean
}

const threadItemsChanges = new WeakMap<ThreadItem[], ThreadItemsChange>()
const threadItemIndexes = new WeakMap<ThreadItem[], ThreadItemIndexes>()
const mutableThreadItemsDrafts = new WeakMap<ThreadItem[], MutableThreadItemsDraft>()

function cloneIndexes(indexes: ThreadItemIndexes): ThreadItemIndexes {
  return {
    byId: new Map(indexes.byId),
    byToolCallId: new Map(indexes.byToolCallId),
    byMessageId: new Map(indexes.byMessageId)
  }
}

function indexesFor(items: ThreadItem[]): ThreadItemIndexes {
  const cached = threadItemIndexes.get(items)
  if (cached) return cached
  const draft = mutableThreadItemsDrafts.get(items)
  if (draft) {
    // Borrow `draft.base`'s index maps read-only until an item is appended,
    // avoiding O(N) Map clones on every delta-only frame batch.
    return draft.indexes ?? indexesFor(draft.base)
  }
  const indexes: ThreadItemIndexes = {
    byId: new Map(),
    byToolCallId: new Map(),
    byMessageId: new Map()
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    indexes.byId.set(item.id, index)
    if (item.kind === 'tool') indexes.byToolCallId.set(item.toolCallId, index)
    if ((item.kind === 'user' || item.kind === 'assistant') && item.messageId) {
      indexes.byMessageId.set(item.messageId, index)
    }
  }
  threadItemIndexes.set(items, indexes)
  return indexes
}

function writableDraftIndexes(items: ThreadItem[], draft: MutableThreadItemsDraft): ThreadItemIndexes {
  if (!draft.indexes) {
    // Detach lazily on the first append inside `applyEventBatch` so `draft.base` keeps its own maps.
    draft.indexes = cloneIndexes(indexesFor(draft.base))
    threadItemIndexes.set(items, draft.indexes)
  }
  return draft.indexes
}

function indexOfItem(items: ThreadItem[], id: string): number {
  const index = indexesFor(items).byId.get(id)
  return index !== undefined && items[index]?.id === id ? index : -1
}

function indexOfTool(items: ThreadItem[], toolCallId: string): number {
  const index = indexesFor(items).byToolCallId.get(toolCallId)
  const item = index === undefined ? undefined : items[index]
  return index !== undefined && item?.kind === 'tool' && item.toolCallId === toolCallId ? index : -1
}

function hasMessageId(items: ThreadItem[], messageId: string): boolean {
  const index = indexesFor(items).byMessageId.get(messageId)
  const item = index === undefined ? undefined : items[index]
  return (item?.kind === 'user' || item?.kind === 'assistant') && item.messageId === messageId
}

/**
 * The newest optimistic prompt Pi has not acknowledged yet.
 *
 * Matching on text (not id) is deliberate: the prompt that left the composer
 * has no Pi identity until its `message_start` comes back, and a steer typed
 * on top of a queued prompt must claim the right bubble.
 */
function findPendingUser(items: ThreadItem[], text: string): UserItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.kind === 'user' && item.pending && item.text === text) return item
  }
  return undefined
}

/**
 * Drop optimistic prompts the reader cancelled before Pi accepted them.
 *
 * A prompt waiting on the working-folder lock never reaches Pi, so no
 * `message_start` will ever replace it. Stop and clear-queue restore its text
 * to the composer, and the bubble goes with it. Without an id every pending
 * prompt of the thread is dropped, which is what a stop of the whole run does.
 */
export function clearPendingPrompts(items: ThreadItem[], id?: string): ThreadItem[] {
  let changed = false
  const next = items.filter((item) => {
    const match = item.kind === 'user' && item.pending === true && (id === undefined || item.id === id)
    if (match) changed = true
    return !match
  })
  return changed ? next : items
}

function changeDraftItem(items: ThreadItem[], index: number, item: ThreadItem): ThreadItem[] {
  const draft = mutableThreadItemsDrafts.get(items)
  if (!draft) {
    const copy = items.slice()
    copy[index] = item
    return markThreadItemsChanged(items, copy, index)
  }
  items[index] = item
  draft.firstChangedIndex = Math.min(draft.firstChangedIndex, index)
  draft.changed = true
  return items
}

function markThreadItemsChanged(
  base: ThreadItem[],
  next: ThreadItem[],
  changedIndex: number
): ThreadItem[] {
  threadItemsChanges.set(next, { base: new WeakRef(base), firstChangedIndex: changedIndex })
  const baseIndexes = indexesFor(base)
  // Only clone index maps when items are appended; in-place item updates keep the same positions.
  let indexes = baseIndexes
  if (next.length > base.length) {
    indexes = cloneIndexes(baseIndexes)
    for (let index = base.length; index < next.length; index += 1) {
      const item = next[index]
      if (item) indexes.byId.set(item.id, index)
      if (item?.kind === 'tool') indexes.byToolCallId.set(item.toolCallId, index)
      if ((item?.kind === 'user' || item?.kind === 'assistant') && item.messageId) {
        indexes.byMessageId.set(item.messageId, index)
      }
    }
  }
  threadItemIndexes.set(next, indexes)
  return next
}

/** Earliest item changed since `base`, when the live reducer recorded it. */
export function changedThreadItemsFrom(
  items: ThreadItem[],
  base: ThreadItem[]
): number | undefined {
  let current = items
  let firstChangedIndex = Number.POSITIVE_INFINITY
  while (current !== base) {
    const change = threadItemsChanges.get(current)
    if (!change) return undefined
    firstChangedIndex = Math.min(firstChangedIndex, change.firstChangedIndex)
    const baseItems = change.base.deref()
    if (!baseItems) return undefined
    current = baseItems
  }
  return Number.isFinite(firstChangedIndex) ? firstChangedIndex : undefined
}

function appendThreadItem(items: ThreadItem[], item: ThreadItem): ThreadItem[] {
  const draft = mutableThreadItemsDrafts.get(items)
  if (draft) {
    const index = items.length
    items.push(item)
    const indexes = writableDraftIndexes(items, draft)
    indexes.byId.set(item.id, index)
    if (item.kind === 'tool') indexes.byToolCallId.set(item.toolCallId, index)
    if ((item.kind === 'user' || item.kind === 'assistant') && item.messageId) {
      indexes.byMessageId.set(item.messageId, index)
    }
    draft.firstChangedIndex = Math.min(draft.firstChangedIndex, index)
    draft.changed = true
    return items
  }
  return markThreadItemsChanged(items, [...items, item], items.length)
}

let counter = 0

/**
 * An id that is unique within the process.
 *
 * `Date.now()` alone is not enough: several events can land in the same
 * millisecond, and two of them would collide.
 */
export function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`
}

/**
 * The position a new item takes in the thread.
 *
 * One counter for every item, so the order of the list is the order in
 * which the items were created — which is what keeps a tool that finished
 * late in the place where it started.
 */
export function nextOrder(): number {
  counter += 1
  return counter
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const typed = block as Partial<ContentBlock> & { text?: string; thinking?: string }
      if (typed.type === 'text') return typed.text ?? ''
      return ''
    })
    .join('')
}

export function imagesOf(content: unknown): { data: string; mimeType: string }[] {
  if (!Array.isArray(content)) return []
  return content
    .filter((block) => block && typeof block === 'object' && (block as ContentBlock).type === 'image')
    .map((block) => {
      const image = block as Extract<ContentBlock, { type: 'image' }>
      return { data: image.data, mimeType: image.mimeType }
    })
}

function blocksFromContent(content: unknown): AssistantBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  const blocks: AssistantBlock[] = []
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as ContentBlock
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text ?? '' })
    } else if (block.type === 'thinking') {
      blocks.push(block.redacted
        ? { type: 'thinking', text: '', redacted: true }
        : { type: 'thinking', text: block.thinking ?? '' })
    } else if (block.type === 'image') {
      // A model that can draw hands the picture back as an image block.
      blocks.push({ type: 'image', data: block.data ?? '', mimeType: block.mimeType ?? 'image/png' })
    } else if (block.type === 'toolCall') {
      blocks.push({
        type: 'toolCall',
        id: block.id,
        name: block.name,
        args: block.arguments ?? {}
      })
    }
  }
  return blocks
}

function lastStreamingAssistant(items: ThreadItem[]): AssistantItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind === 'assistant' && item.streaming) return item
  }
  return undefined
}

/**
 * The assistant bubble an event belongs to.
 *
 * Pi's adapter stamps every message event with its own `messageId`, and a
 * replayed or delayed record can arrive after the next message has already
 * started. "Last streaming assistant" would then write the old message's
 * final content over the new bubble and swallow the new answer. An event that
 * names a message only ever touches that message; an older projection without
 * message identities keeps the previous last-streaming fallback.
 */
function assistantForMessage(
  items: ThreadItem[],
  messageId: string | undefined,
  requireStreaming = true
): AssistantItem | undefined {
  if (!messageId) return lastStreamingAssistant(items)
  const indexed = indexesFor(items).byMessageId.get(messageId)
  if (indexed !== undefined) {
    const item = items[indexed]
    if (item?.kind === 'assistant' && item.messageId === messageId) {
      return !requireStreaming || item.streaming ? item : undefined
    }
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind !== 'assistant' || item.messageId !== messageId) continue
    if (!requireStreaming || item.streaming) return item
    return undefined
  }
  const legacy = lastStreamingAssistant(items)
  return legacy?.messageId === undefined ? legacy : undefined
}

/**
 * The bubble an unmatched assistant completion belongs to.
 *
 * The adapter names the open message with a client-minted id. That identity
 * lives beside the transcript, so a thread that is re-keyed in the middle of
 * an answer (a draft becoming its session file) keeps its items but loses the
 * name: every later delta and the final `message_end` then arrive under an id
 * no bubble carries, and the answer stays "streaming" with no usage forever —
 * the tokens and cache figures under the composer stay at zero while the turn
 * and step counts (which never need the answer) keep climbing.
 *
 * A completion whose id matches nothing is still the end of the one answer Pi
 * was streaming. It may only close a bubble that carries the same message
 * timestamp — `message_start` and `message_end` describe the same message
 * object, so the stamp is the one identity that survives the move — and a
 * completion that carries no timestamp may not close anything. A late
 * duplicate of an older answer therefore can never land on a newer bubble.
 */
function streamingAssistantForCompletion(
  items: ThreadItem[],
  timestamp: number | undefined
): AssistantItem | undefined {
  if (timestamp === undefined) return undefined
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind !== 'assistant' || !item.streaming) continue
    if (item.timestamp === timestamp) return item
  }
  return undefined
}

function replaceItem(items: ThreadItem[], id: string, next: ThreadItem): ThreadItem[] {
  const index = indexOfItem(items, id)
  if (index < 0) return items
  return changeDraftItem(items, index, next)
}

/**
 * Update the node of one tool call, or create it when it is new.
 *
 * The node is keyed by `toolCallId` and keeps the position of its first
 * appearance, so parallel tools that finish out of order do not reorder
 * the conversation. Only the fields a caller passes are written, which is
 * what keeps `tool_execution_start` from downgrading a node that already
 * knows its arguments.
 */
function patchTool(
  items: ThreadItem[],
  toolCallId: string,
  patch: Partial<ToolItem>,
  create?: Partial<ToolItem>
): ThreadItem[] {
  const index = indexOfTool(items, toolCallId)
  if (index === -1) {
    if (!create) return items
    const node: ToolItem = {
      id: nextId('tool'),
      kind: 'tool',
      toolCallId,
      toolName: 'tool',
      args: {},
      status: 'running',
      timestamp: Date.now(),
      order: nextOrder(),
      ...create
    }
    return appendThreadItem(items, node)
  }
  return changeDraftItem(items, index, { ...(items[index] as ToolItem), ...patch })
}

function findTool(items: ThreadItem[], toolCallId: string): ToolItem | undefined {
  const index = indexOfTool(items, toolCallId)
  const item = index < 0 ? undefined : items[index]
  return item?.kind === 'tool' ? item : undefined
}

/**
 * A finished tool node is terminal.
 *
 * Pi can repeat or reorder records around a session boundary. A late
 * `tool_execution_start` must not turn a completed read back into a spinner,
 * and a late proposal must not hide a real result. Terminal states win.
 */
type FinishedToolItem = ToolItem & { status: 'ok' | 'error' | 'aborted' }

function isFinishedTool(item: ToolItem | undefined): item is FinishedToolItem {
  return item !== undefined && (item.status === 'ok' || item.status === 'error' || item.status === 'aborted')
}

function notice(level: NoticeItem['level'], text: string, runId?: string): NoticeItem {
  return {
    id: nextId('notice'),
    kind: 'notice',
    level,
    text,
    timestamp: Date.now(),
    order: nextOrder(),
    runId
  }
}

/** The `message_update` payload lives in the adapter; the reducer never sees it. */

/* ------------------------------------------------------------------ *
 * Hydration
 * ------------------------------------------------------------------ */

/**
 * Build a thread from a full message list (session hydration).
 *
 * The same items come out of this as out of the live reducer — a tool is
 * one node with a final status, never a second card — so a reopened
 * conversation and a running one render identically.
 */
export function itemsFromMessages(messages: AgentMessage[]): ThreadItem[] {
  const items: ThreadItem[] = []

  // The arguments of a tool call live on the assistant message, not on the
  // result. Collect them once while parsing assistant blocks so replay avoids
  // running `blocksFromContent` / `JSON.stringify` twice per message.
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>()
  const assistantBlocks: (AssistantBlock[] | undefined)[] = new Array(messages.length)
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const blocks = blocksFromContent(message.content)
    assistantBlocks[index] = blocks
    for (const block of blocks) {
      if (block.type !== 'toolCall') continue
      calls.set(block.id, { name: block.name, args: block.args ?? {} })
    }
  }

  /** Position of each tool node, so a later result updates it instead of adding one. */
  const toolNodes = new Map<string, number>()

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    switch (message.role) {
      case 'user': {
        items.push({
          id: nextId('user'),
          kind: 'user',
          text: textOf(message.content),
          images: imagesOf(message.content),
          ...(message.entryId ? { entryId: message.entryId } : {}),
          timestamp: message.timestamp ?? Date.now(),
          order: nextOrder()
        })
        break
      }
      case 'assistant': {
        const blocks = assistantBlocks[index] ?? blocksFromContent(message.content)
        const rawDuration = (message as unknown as { durationMs?: unknown }).durationMs
        items.push({
          id: nextId('assistant'),
          kind: 'assistant',
          blocks,
          usage: message.usage,
          model: message.model,
          stopReason: message.stopReason,
          error: message.errorMessage,
          durationMs: typeof rawDuration === 'number' ? rawDuration : undefined,
          streaming: false,
          timestamp: message.timestamp ?? Date.now(),
          order: nextOrder()
        })
        // A call the model named but that never produced a result must still
        // be visible after a replay. The node starts `proposed`; a later
        // toolResult message updates the same node in place.
        for (const block of blocks) {
          if (block.type !== 'toolCall' || toolNodes.has(block.id)) continue
          toolNodes.set(block.id, items.length)
          items.push({
            id: nextId('tool'),
            kind: 'tool',
            toolCallId: block.id,
            toolName: block.name,
            args: block.args ?? {},
            status: 'proposed',
            timestamp: message.timestamp ?? Date.now(),
            order: nextOrder()
          })
        }
        break
      }
      case 'toolResult': {
        // A tool result is the same node the live stream updates; the
        // message is the authoritative final state of it.
        const toolCallId = message.toolCallId ?? ''
        const call = calls.get(toolCallId)
        const result = textOf(message.content)
        const resultTimestamp = message.timestamp ?? Date.now()
        // The duration travels on the message when Pi recorded it, so a
        // replayed card shows the same timing a live one did.
        const raw = message as unknown as { durationMs?: unknown }
        const duration = typeof raw.durationMs === 'number' ? raw.durationMs : undefined
        const existingIndex = toolNodes.get(toolCallId)
        if (existingIndex !== undefined) {
          const existing = items[existingIndex]
          if (existing && existing.kind === 'tool') {
            items[existingIndex] = {
              ...existing,
              toolName: message.toolName ?? call?.name ?? existing.toolName,
              args: call?.args ?? existing.args,
              status: message.isError ? 'error' : 'ok',
              result,
              details: message.details,
              isError: message.isError,
              durationMs: duration ?? existing.durationMs,
              finishedAt: resultTimestamp
            }
            break
          }
        }
        toolNodes.set(toolCallId, items.length)
        items.push({
          id: nextId('tool'),
          kind: 'tool',
          toolCallId,
          toolName: message.toolName ?? call?.name ?? 'tool',
          args: call?.args ?? {},
          status: message.isError ? 'error' : 'ok',
          result,
          details: message.details,
          isError: message.isError,
          durationMs: duration,
          finishedAt: resultTimestamp,
          timestamp: resultTimestamp,
          order: nextOrder()
        })
        break
      }
      case 'bashExecution': {
        // A command the terminal drawer ran is kept in the session but kept
        // out of the model's context; it is the terminal's business, not the
        // conversation's, so it is left out of the transcript as well.
        if (message.excludeFromContext === true) break
        const bash = message as unknown as {
          command?: string
          output?: string
          exitCode?: number
          timestamp?: number
        }
        items.push({
          id: nextId('bash'),
          kind: 'bash',
          command: bash.command ?? '',
          output: bash.output ?? '',
          exitCode: bash.exitCode,
          timestamp: bash.timestamp ?? Date.now(),
          order: nextOrder()
        })
        break
      }
      case 'compactionSummary': {
        const summary = message as unknown as { summary?: string }
        items.push(notice('info', `Context compacted — ${summary?.summary ?? 'summary'}`))
        break
      }
      case 'branchSummary': {
        const summary = message as unknown as { summary?: string }
        items.push(notice('info', `Branch summary — ${summary?.summary ?? ''}`))
        break
      }
      case 'custom': {
        const custom = message as AgentMessage & { customType?: unknown; entryId?: unknown }
        if (custom.customType !== GOAL_CONTINUE_CUSTOM_TYPE) break
        const entryId = typeof custom.entryId === 'string' && custom.entryId ? custom.entryId : undefined
        const resumedAt = goalResumeTime(message)
        items.push({
          id: nextId('round'),
          kind: 'roundBreak',
          ...(entryId ? { entryId } : {}),
          ...(resumedAt !== undefined ? { resumed: true } : {}),
          timestamp: resumedAt ?? message.timestamp ?? Date.now(),
          order: nextOrder()
        })
        break
      }
      default:
        break
    }
  }
  return items
}

function replayKey(item: ThreadItem): string | undefined {
  switch (item.kind) {
    case 'user': return item.pending ? undefined : `user:${item.timestamp}:${item.text}`
    case 'assistant': return `assistant:${item.timestamp}`
    case 'tool': return item.toolCallId ? `tool:${item.toolCallId}` : undefined
    case 'bash': return `bash:${item.timestamp}:${item.command}`
    case 'roundBreak': return `roundBreak:${item.timestamp}`
  }
}

function mergeReplayedItem(saved: ThreadItem, live: ThreadItem): ThreadItem {
  if (saved.kind === 'tool' && live.kind === 'tool') {
    const tool = isFinishedTool(saved) && !isFinishedTool(live)
      ? { ...live, ...saved, id: live.id, progress: undefined }
      : { ...saved, ...live }
    return {
      ...tool,
      toolName: live.toolName === 'tool' ? saved.toolName : live.toolName,
      args: Object.keys(live.args).length ? live.args : saved.args,
      durationMs: live.durationMs ?? saved.durationMs
    }
  }
  if (saved.kind === 'assistant' && live.kind === 'assistant' && live.streaming) {
    return { ...live, ...saved, id: live.id }
  }
  return live
}

/** Fill missing history while keeping the identities and progress of live items. */
export function mergeHydratedItems(saved: ThreadItem[], live: ThreadItem[]): ThreadItem[] {
  if (!live.length) return saved
  if (!saved.length) return live

  const positions = new Map<string, number[]>()
  for (const [index, item] of saved.entries()) {
    const key = replayKey(item)
    if (key === undefined) continue
    const matches = positions.get(key)
    if (matches) matches.push(index)
    else positions.set(key, [index])
  }

  const replay = saved.slice()
  const before = new Map<number, ThreadItem[]>()
  let nextPosition = replay.length
  // Work back from the live tail so repeated timestamps match the most recent
  // persisted occurrence first. Live-only rows stay before their next match.
  for (let i = live.length - 1; i >= 0; i -= 1) {
    const key = replayKey(live[i])
    const position = key === undefined ? undefined : positions.get(key)?.pop()
    if (position !== undefined) {
      replay[position] = mergeReplayedItem(replay[position], live[i])
      nextPosition = Math.min(position, nextPosition)
    } else {
      const items = before.get(nextPosition)
      if (items) items.push(live[i])
      else before.set(nextPosition, [live[i]])
    }
  }

  const merged: ThreadItem[] = []
  for (let i = 0; i <= replay.length; i += 1) {
    for (const item of before.get(i)?.reverse() ?? []) merged.push({ ...item, order: nextOrder() })
    if (i < replay.length) merged.push({ ...replay[i], order: nextOrder() })
  }
  return merged
}

/* ------------------------------------------------------------------ *
 * Live reducer
 * ------------------------------------------------------------------ */

/**
 * Fold one Pi session event into the thread.
 * Returns a new array when something changed.
 *
 * The wire shape is understood by `normalizePiEvent`; this function only
 * hands the resulting semantic event to `applyStreamEvent`, so the live
 * reducer and any other consumer of the adapter share one projection.
 * `context` carries the run and turn the event belongs to. Without it the
 * items are still updated, but they cannot be attributed to a run — which
 * is what a replayed history needs anyway.
 */
export function applyEvent(
  items: ThreadItem[],
  event: PiEvent,
  context?: StreamContext
): ThreadItem[] {
  const streamEvent = normalizePiEvent(event, context)
  if (!streamEvent) return items
  return applyStreamEvent(items, streamEvent)
}

/** The identity a normalized event stamps on the item it creates. */
function identityOf(event: StreamEvent): { threadId?: string; sequence: number } {
  return event.threadId
    ? { threadId: event.threadId, sequence: event.sequence }
    : { sequence: event.sequence }
}

/** A notice created by a normalized event rather than by session hydration. */
function noticeFor(
  event: StreamEvent,
  level: NoticeItem['level'],
  text: string,
  source?: NoticeItem['source']
): NoticeItem {
  return {
    id: nextId('notice'),
    kind: 'notice',
    level,
    text,
    timestamp: Date.now(),
    order: nextOrder(),
    ...identityOf(event),
    ...(event.status ? { status: event.status } : {}),
    ...(source ? { source } : {})
  }
}

/**
 * Project one normalized event onto the thread.
 *
 * This is the only writer of the transcript; `applyEvent` normalizes first.
 * The switch is on semantic event types, not Pi's wire names, and each case
 * preserves the reducer's original rules exactly — the tool node is keyed by
 * `toolCallId`, `text_end`/`message_end` are authoritative, and a partial
 * tool result replaces the previous snapshot instead of extending it.
 */
export function applyStreamEvent(items: ThreadItem[], event: StreamEvent): ThreadItem[] {
  switch (event.type) {
    case 'message.started': {
      const message = event.message
      if (!message) return items
      // Pi replays session records on resume; a repeated `message_start`
      // for the same adapter-minted id must not create a second bubble.
      if (event.messageId && hasMessageId(items, event.messageId)) {
        return items
      }
      if (message.role === 'user') {
        const text = textOf(message.content)
        // Pi has taken a prompt that was still waiting: the optimistic bubble
        // becomes the record instead of a second copy appearing beside it.
        const pending = findPendingUser(items, text)
        if (pending) {
          return replaceItem(items, pending.id, {
            ...pending,
            text,
            images: imagesOf(message.content),
            timestamp: message.timestamp ?? pending.timestamp,
            pending: undefined,
            messageId: event.messageId,
            runId: event.runId,
            turnId: event.turnId,
            ...identityOf(event)
          })
        }
        return appendThreadItem(items, {
          id: nextId('user'),
          kind: 'user',
          text,
          images: imagesOf(message.content),
          timestamp: message.timestamp ?? Date.now(),
          order: nextOrder(),
          messageId: event.messageId,
          runId: event.runId,
          turnId: event.turnId,
          ...identityOf(event)
        })
      }
      if (message.role === 'assistant') {
        return appendThreadItem(items, {
          id: nextId('assistant'),
          kind: 'assistant',
          blocks: [],
          streaming: true,
          timestamp: message.timestamp ?? Date.now(),
          order: nextOrder(),
          messageId: event.messageId,
          runId: event.runId,
          turnId: event.turnId,
          ...identityOf(event)
        })
      }
      return items
    }

    case 'message.block.started': {
      const assistant = assistantForMessage(items, event.messageId)
      if (!assistant) return items
      const blocks = assistant.blocks.slice()
      const index = event.contentIndex ?? blocks.length
      if (event.blockType === 'toolCall') {
        // The adapter emits `tool.proposed` for a tool-call block; this keeps
        // a hand-built event consistent with that node.
        const toolCallId = event.toolCallId ?? nextId('call')
        const toolName = event.toolName ?? 'tool'
        blocks[index] = { type: 'toolCall', id: toolCallId, name: toolName }
        return patchTool(
          replaceItem(items, assistant.id, { ...assistant, blocks }),
          toolCallId,
          { status: 'proposed', toolName },
          {
            toolName,
            args: {},
            status: 'proposed',
            runId: event.runId,
            turnId: event.turnId,
            ...identityOf(event)
          }
        )
      }
      const previous = blocks[index]
      if (previous?.type === 'thinking' && previous.redacted) return items
      blocks[index] = { type: event.blockType, text: '' }
      return replaceItem(items, assistant.id, { ...assistant, blocks })
    }

    case 'message.delta': {
      const assistant = assistantForMessage(items, event.messageId)
      if (!assistant) return items
      const blocks = assistant.blocks.slice()
      const index = event.contentIndex ?? blocks.length
      let block = blocks[index]
      if (!block) {
        block = { type: event.blockType, text: '' }
        blocks[index] = block
      }
      if (event.blockType === 'text' && block.type === 'text') {
        blocks[index] = { ...block, text: block.text + event.delta }
      } else if (event.blockType === 'thinking' && block.type === 'thinking' && !block.redacted) {
        blocks[index] = { ...block, text: block.text + event.delta }
      }
      return replaceItem(items, assistant.id, { ...assistant, blocks })
    }

    case 'message.block.completed': {
      const assistant = assistantForMessage(items, event.messageId, false)
      if (!assistant) return items
      const blocks = assistant.blocks.slice()
      const index = event.contentIndex ?? blocks.length
      if (event.redacted) {
        blocks[index] = { type: 'thinking', text: '', redacted: true }
        return replaceItem(items, assistant.id, { ...assistant, blocks })
      }
      let block = blocks[index]
      if (!block) {
        block = { type: event.blockType, text: '' }
        blocks[index] = block
      }
      // The completed block is the authority, so the deltas are replaced
      // rather than added to.
      if (event.blockType === 'text' && block.type === 'text') {
        blocks[index] = { ...block, text: event.content ?? block.text }
      } else if (event.blockType === 'thinking' && block.type === 'thinking' && !block.redacted) {
        blocks[index] = { ...block, text: event.content ?? block.text }
      }
      return replaceItem(items, assistant.id, { ...assistant, blocks })
    }

    case 'tool.proposed': {
      // The model named a tool. It is not running yet — the node exists from
      // here on so a call that never executes is still visible.
      const assistant = assistantForMessage(items, event.messageId, false)
      if (!assistant) return items
      const toolCallId = event.toolCallId ?? nextId('call')
      const toolName = event.toolName
      const existing = findTool(items, toolCallId)
      if (isFinishedTool(existing)) {
        // A duplicate proposal arriving after the result must not erase the
        // result or downgrade the row to "not run".
        return items
      }
      const status: ToolStatus = existing?.status === 'running' ? 'running' : 'proposed'
      const blocks = assistant.blocks.slice()
      const index = event.contentIndex ?? blocks.length
      blocks[index] = { type: 'toolCall', id: toolCallId, name: toolName }
      return patchTool(
        replaceItem(items, assistant.id, { ...assistant, blocks }),
        toolCallId,
        { status, toolName },
        {
          toolName,
          args: {},
          status,
          runId: event.runId,
          turnId: event.turnId,
          ...identityOf(event)
        }
      )
    }

    case 'tool.args': {
      const assistant = assistantForMessage(items, event.messageId, false)
      if (!assistant) return items
      const toolCallId = event.toolCallId ?? ''
      const existing = findTool(items, toolCallId)
      if (isFinishedTool(existing)) {
        // The result is terminal, but a late `toolcall_end` may still carry
        // the arguments the node was created without. Fill them in without
        // changing the status.
        const args = event.args
        if (args && Object.keys(existing.args ?? {}).length === 0) {
          return patchTool(items, toolCallId, {
            toolName: event.toolName || existing.toolName,
            args
          })
        }
        return items
      }
      if (!event.complete) {
        // Partial JSON argument chunks are not rendered anywhere; wait for
        // `toolcall_end` (`event.complete === true`) with parsed `args`.
        return items
      }

      const blocks = assistant.blocks.slice()
      const index = event.contentIndex ?? blocks.length
      const previous = blocks[index]
      const previousId = previous && previous.type === 'toolCall' ? previous.id : undefined
      const resolvedId = event.toolCallId ?? previousId ?? nextId('call')
      const toolName =
        event.toolName ?? (previous && previous.type === 'toolCall' ? previous.name : 'tool')
      const args = event.args ?? {}
      const status: ToolStatus = existing?.status === 'running' ? 'running' : 'proposed'
      blocks[index] = {
        type: 'toolCall',
        id: resolvedId,
        name: toolName,
        args
      }
      return patchTool(
        replaceItem(items, assistant.id, { ...assistant, blocks }),
        resolvedId,
        { status, toolName, args },
        {
          toolName,
          args,
          status,
          runId: event.runId,
          turnId: event.turnId,
          ...identityOf(event)
        }
      )
    }

    case 'message.completed': {
      const message = event.message
      if (!message) return items
      if (message.role === 'assistant') {
        const assistant =
          assistantForMessage(items, event.messageId, false) ??
          streamingAssistantForCompletion(items, message.timestamp)
        if (!assistant) return items
        const rawDuration = (message as unknown as { durationMs?: unknown }).durationMs
        const next: AssistantItem = {
          ...assistant,
          // The message is the authority for the content of the blocks. The
          // tool nodes are separate items and keep their own status, so
          // finalising the message never turns a running tool into a
          // finished one.
          blocks: blocksFromContent(message.content),
          usage: message.usage,
          model: message.model,
          stopReason: message.stopReason,
          error: message.errorMessage,
          durationMs: typeof rawDuration === 'number' ? rawDuration : assistant.durationMs,
          streaming: false
        }
        return replaceItem(items, assistant.id, next)
      }
      return items
    }

    case 'tool.started': {
      const toolCallId = event.toolCallId ?? ''
      if (!toolCallId) return items
      const existing = findTool(items, toolCallId)
      if (isFinishedTool(existing)) return items
      const startedAt = Date.now()
      return patchTool(
        items,
        toolCallId,
        {
          status: 'running',
          toolName: event.toolName || existing?.toolName || 'tool',
          startedAt
        },
        {
          toolName: event.toolName || 'tool',
          args: event.args,
          status: 'running',
          startedAt,
          runId: event.runId,
          turnId: event.turnId,
          ...identityOf(event)
        }
      )
    }

    case 'tool.output.delta': {
      const toolCallId = event.toolCallId ?? ''
      const target = toolCallId ? findTool(items, toolCallId) : undefined
      if (!target || isFinishedTool(target)) return items
      // `partialResult` is the newest partial result of the tool, so it
      // replaces what was there. Appending it would repeat the whole output
      // on every update.
      const progress = extractToolResult(event.partialResult)
      return patchTool(items, toolCallId, {
        status: 'running',
        progress: progress ?? target.progress,
        details: toolDetails(event.partialResult) ?? target.details
      })
    }

    case 'tool.finished': {
      const toolCallId = event.toolCallId ?? ''
      if (!toolCallId) return items
      const existing = findTool(items, toolCallId)
      // A repeated end (or an end after an abort) must not overwrite the
      // terminal state the client already showed.
      if (isFinishedTool(existing)) return items
      const isError = event.isError
      const result = extractToolResult(event.result)
      const durationMs = event.durationMs ?? (
        event.durationUnavailable
          ? existing?.durationMs
          : existing?.startedAt !== undefined
            ? Math.max(0, Date.now() - existing.startedAt)
            : existing?.durationMs
      )
      return patchTool(
        items,
        toolCallId,
        {
          status: isError ? 'error' : 'ok',
          isError,
          result: result ?? existing?.result,
          details: toolDetails(event.result) ?? existing?.details,
          exitCode: exitCodeOf(event.result) ?? existing?.exitCode,
          durationMs,
          finishedAt: Date.now(),
          progress: undefined
        },
        {
          toolName: event.toolName || 'tool',
          args: event.args ?? {},
          status: isError ? 'error' : 'ok',
          isError,
          result,
          details: toolDetails(event.result),
          durationMs,
          finishedAt: Date.now(),
          runId: event.runId,
          turnId: event.turnId,
          ...identityOf(event)
        }
      )
    }

    case 'command.output.delta': {
      const delta = event.delta
      const targetId = event.commandId
      let existing: BashItem | undefined
      if (targetId) {
        const index = indexOfItem(items, targetId)
        const item = index < 0 ? undefined : items[index]
        if (item?.kind === 'bash') existing = item
      }
      if (!existing) {
        for (let index = items.length - 1; index >= 0; index -= 1) {
          const item = items[index]
          if (item.kind === 'bash' && item.exitCode === undefined) {
            existing = item
            break
          }
        }
      }
      if (existing) {
        return replaceItem(items, existing.id, { ...existing, output: existing.output + delta })
      }
      return appendThreadItem(items, {
        id: targetId ?? nextId('bash'),
        kind: 'bash',
        command: '',
        output: delta,
        timestamp: Date.now(),
        order: nextOrder(),
        ...identityOf(event)
      })
    }

    case 'notice': {
      return appendThreadItem(items, noticeFor(event, event.level, event.text, event.noticeSource))
    }

    case 'error': {
      return appendThreadItem(items, noticeFor(event, 'error', event.text))
    }

    case 'round.continued': {
      if (
        (event.entryId || event.resumed) &&
        items.some((item) => item.kind === 'roundBreak' && (
          (event.entryId && item.entryId === event.entryId) ||
          (event.resumed && item.resumed && item.timestamp === event.timestamp)
        ))
      ) {
        return items
      }
      return appendThreadItem(items, {
        id: nextId('round'),
        kind: 'roundBreak',
        ...(event.entryId ? { entryId: event.entryId } : {}),
        ...(event.resumed ? { resumed: true } : {}),
        timestamp: event.timestamp,
        order: nextOrder(),
        runId: event.runId,
        turnId: event.turnId,
        ...identityOf(event)
      })
    }

    default:
      return items
  }
}

/** Apply a batch of pre-normalized stream events, cloning the item array at most once. */
export function applyStreamEventBatch(
  items: ThreadItem[],
  events: readonly StreamEvent[]
): ThreadItem[] {
  if (events.length === 0) return items
  let next = items.slice()
  const draft: MutableThreadItemsDraft = {
    base: items,
    firstChangedIndex: items.length,
    changed: false
  }
  mutableThreadItemsDrafts.set(next, draft)
  for (const streamEvent of events) {
    const updated = applyStreamEvent(next, streamEvent)
    if (updated === next) continue
    const changedIndex = changedThreadItemsFrom(updated, next)
    draft.firstChangedIndex = Math.min(draft.firstChangedIndex, changedIndex ?? 0)
    draft.changed = true
    mutableThreadItemsDrafts.delete(next)
    next = updated
    threadItemIndexes.delete(next)
    indexesFor(next)
    mutableThreadItemsDrafts.set(next, draft)
  }
  mutableThreadItemsDrafts.delete(next)
  if (!draft.changed) return items
  threadItemIndexes.set(next, draft.indexes ?? indexesFor(items))
  threadItemsChanges.set(next, { base: new WeakRef(items), firstChangedIndex: draft.firstChangedIndex })
  return next
}

/** Apply one normalized batch of Pi events, cloning the item array at most once. */
export function applyEventBatch(
  items: ThreadItem[],
  events: { event: PiEvent; context?: StreamContext }[]
): ThreadItem[] {
  if (events.length === 0) return items
  const normalized: StreamEvent[] = []
  for (const { event, context } of events) {
    const streamEvent = normalizePiEvent(event, context)
    if (streamEvent) normalized.push(streamEvent)
  }
  return applyStreamEventBatch(items, normalized)
}

/** Apply a batch of events in order, in one pass. */
export function applyEvents(
  items: ThreadItem[],
  events: PiEvent[],
  context?: StreamContext
): ThreadItem[] {
  return applyEventBatch(items, events.map((event) => ({ event, context })))
}

/**
 * Mark everything that was still moving as stopped.
 *
 * Called when Pi confirms the run was aborted: a tool that was running did
 * not finish, so it is `aborted` rather than a success, and an assistant
 * message that was still streaming keeps whatever text it had.
 */
export function markAborted(items: ThreadItem[]): ThreadItem[] {
  let firstChangedIndex = items.length
  const next = items.map((item, index) => {
    if (item.kind === 'tool' && item.status === 'running') {
      firstChangedIndex = Math.min(firstChangedIndex, index)
      return { ...item, status: 'aborted' as const, finishedAt: Date.now(), progress: undefined }
    }
    // A proposed call never started. "Not run" is the truth; turning it into
    // "stopped" would imply an execution that did not happen.
    if (item.kind === 'assistant' && item.streaming) {
      firstChangedIndex = Math.min(firstChangedIndex, index)
      return { ...item, streaming: false }
    }
    return item
  })
  if (firstChangedIndex === items.length) return items
  return markThreadItemsChanged(items, next, firstChangedIndex)
}

function toolDetails(value: unknown): unknown {
  return value && typeof value === 'object' ? (value as { details?: unknown }).details : undefined
}

function extractToolResult(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value
      .map((block) => {
        if (!block || typeof block !== 'object') return ''
        const typed = block as { type?: string; text?: string }
        return typed.type === 'text' ? typed.text ?? '' : ''
      })
      .filter(Boolean)
    return parts.length ? parts.join('\n') : undefined
  }
  if (typeof value === 'object') {
    const typed = value as { content?: unknown }
    if (typed.content !== undefined) return extractToolResult(typed.content)
    return JSON.stringify(value, null, 2)
  }
  return String(value)
}

/**
 * The exit code a shell tool reports.
 *
 * Pi carries it in `structuredContent`, not in the text blocks, so a
 * failed command can be told apart from a successful one that printed
 * something alarming.
 */
function exitCodeOf(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined
  const structured = (value as { structuredContent?: { exit_code?: unknown } }).structuredContent
  if (!structured || typeof structured !== 'object') return undefined
  const code = structured.exit_code
  if (typeof code === 'number' && Number.isFinite(code)) return code
  if (typeof code === 'string' && code.trim() !== '' && Number.isFinite(Number(code))) {
    return Number(code)
  }
  return undefined
}

/** The text of the last answer in the thread, if there is one. */
export function lastAssistantText(items: ThreadItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind !== 'assistant') continue
    const text = item.blocks
      .filter((block): block is Extract<AssistantBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n')
      .trim()
    if (text) return text
  }
  return ''
}

/**
 * The whole conversation as plain text.
 *
 * Only the messages are written down — the tool calls are noise for whoever
 * reads the transcript.
 */
export function transcriptOf(items: ThreadItem[]): string {
  const parts: string[] = []
  for (const item of items) {
    if (item.kind === 'user') {
      if (!item.text.trim()) continue
      parts.push(`## You\n\n${item.text.trim()}`)
      continue
    }
    if (item.kind !== 'assistant') continue
    const text = item.blocks
      .filter((block): block is Extract<AssistantBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n')
      .trim()
    if (text) parts.push(`## Pi\n\n${text}`)
  }
  return parts.join('\n\n')
}
