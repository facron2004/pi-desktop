import type { AgentMessage, ContentBlock, ForkTarget, PiEvent, Usage } from '@shared/types'
import { isRateLimitError } from './provider-error'

/* ------------------------------------------------------------------ *
 * Run / turn identity
 *
 * Pi's protocol has no run or turn id of its own, so the client mints
 * them: one run per `agent_start` (a prompt plus the automatic work that
 * follows it) and one turn per `turn_start`. They are what makes a live
 * stream and a replayed history comparable, and they are the key the
 * session-isolation guard uses.
 * ------------------------------------------------------------------ */

export interface StreamContext {
  /** Session file the events belong to; events from another one are dropped. */
  sessionKey: string
  runId?: string
  turnId?: string
}

/* ------------------------------------------------------------------ *
 * Thread items
 * ------------------------------------------------------------------ */

export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'toolCall'; id: string; name: string; argsText: string; args?: Record<string, unknown> }

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
  timestamp: number
  order: number
  runId?: string
  turnId?: string
}

export interface AssistantItem {
  id: string
  kind: 'assistant'
  blocks: AssistantBlock[]
  usage?: Usage
  model?: string
  stopReason?: string
  error?: string
  streaming: boolean
  timestamp: number
  order: number
  runId?: string
  turnId?: string
}

export interface ToolItem {
  id: string
  kind: 'tool'
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  status: ToolStatus
  result?: string
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
}

export interface NoticeItem {
  id: string
  kind: 'notice'
  level: 'info' | 'warn' | 'error' | 'success'
  text: string
  timestamp: number
  order: number
  runId?: string
}

export type ThreadItem = UserItem | AssistantItem | ToolItem | BashItem | NoticeItem

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
      blocks.push({ type: 'thinking', text: block.thinking ?? '' })
    } else if (block.type === 'image') {
      // A model that can draw hands the picture back as an image block.
      blocks.push({ type: 'image', data: block.data ?? '', mimeType: block.mimeType ?? 'image/png' })
    } else if (block.type === 'toolCall') {
      blocks.push({
        type: 'toolCall',
        id: block.id,
        name: block.name,
        argsText: JSON.stringify(block.arguments ?? {}, null, 2),
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

function replaceItem(items: ThreadItem[], id: string, next: ThreadItem): ThreadItem[] {
  return items.map((item) => (item.id === id ? next : item))
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
  const index = items.findIndex((item) => item.kind === 'tool' && item.toolCallId === toolCallId)
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
    return [...items, node]
  }
  const copy = [...items]
  copy[index] = { ...(copy[index] as ToolItem), ...patch }
  return copy
}

function findTool(items: ThreadItem[], toolCallId: string): ToolItem | undefined {
  return items.find(
    (item): item is ToolItem => item.kind === 'tool' && item.toolCallId === toolCallId
  )
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

/** The `message_update` payload Pi wraps around a stream event. */
interface AssistantMessageEventPayload {
  type: string
  contentIndex?: number
  delta?: string
  content?: string
  id?: string
  toolName?: string
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> }
}

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
  // result. Collect them first so a resumed session still knows which file
  // was edited and which command was run.
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of blocksFromContent(message.content)) {
      if (block.type !== 'toolCall') continue
      calls.set(block.id, { name: block.name, args: block.args ?? {} })
    }
  }

  for (const message of messages) {
    switch (message.role) {
      case 'user': {
        items.push({
          id: nextId('user'),
          kind: 'user',
          text: textOf(message.content),
          images: imagesOf(message.content),
          timestamp: message.timestamp ?? Date.now(),
          order: nextOrder()
        })
        break
      }
      case 'assistant': {
        items.push({
          id: nextId('assistant'),
          kind: 'assistant',
          blocks: blocksFromContent(message.content),
          usage: message.usage,
          model: message.model,
          stopReason: message.stopReason,
          error: message.errorMessage,
          streaming: false,
          timestamp: message.timestamp ?? Date.now(),
          order: nextOrder()
        })
        break
      }
      case 'toolResult': {
        // A tool result is the same node the live stream updates; the
        // message is the authoritative final state of it.
        const call = calls.get(message.toolCallId ?? '')
        const result = textOf(message.content)
        // The duration travels on the message when Pi recorded it, so a
        // replayed card shows the same timing a live one did.
        const raw = message as unknown as { durationMs?: unknown }
        const duration = typeof raw.durationMs === 'number' ? raw.durationMs : undefined
        items.push({
          id: nextId('tool'),
          kind: 'tool',
          toolCallId: message.toolCallId ?? '',
          toolName: message.toolName ?? call?.name ?? 'tool',
          args: call?.args ?? {},
          status: message.isError ? 'error' : 'ok',
          result,
          isError: message.isError,
          durationMs: duration,
          timestamp: message.timestamp ?? Date.now(),
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
      default:
        break
    }
  }
  return items
}

/* ------------------------------------------------------------------ *
 * Live reducer
 * ------------------------------------------------------------------ */

/**
 * Fold one Pi session event into the thread.
 * Returns a new array when something changed.
 *
 * `context` carries the run and turn the event belongs to. Without it the
 * items are still updated, but they cannot be attributed to a run — which
 * is what a replayed history needs anyway.
 */
export function applyEvent(
  items: ThreadItem[],
  event: PiEvent,
  context?: StreamContext
): ThreadItem[] {
  switch (event.type) {
    case 'message_start': {
      const message = event.message as AgentMessage | undefined
      if (!message) return items
      if (message.role === 'user') {
        return [
          ...items,
          {
            id: nextId('user'),
            kind: 'user',
            text: textOf(message.content),
            images: imagesOf(message.content),
            timestamp: message.timestamp ?? Date.now(),
            order: nextOrder(),
            runId: context?.runId,
            turnId: context?.turnId
          }
        ]
      }
      if (message.role === 'assistant') {
        return [
          ...items,
          {
            id: nextId('assistant'),
            kind: 'assistant',
            blocks: [],
            streaming: true,
            timestamp: message.timestamp ?? Date.now(),
            order: nextOrder(),
            runId: context?.runId,
            turnId: context?.turnId
          }
        ]
      }
      return items
    }

    case 'message_update': {
      const payload = event.assistantMessageEvent as AssistantMessageEventPayload | undefined
      if (!payload) return items
      const assistant = lastStreamingAssistant(items)
      if (!assistant) return items

      const blocks = assistant.blocks.slice()
      const index = payload.contentIndex ?? blocks.length

      const ensure = (): AssistantBlock => {
        if (!blocks[index]) {
          blocks[index] = { type: 'text', text: '' }
        }
        return blocks[index]
      }

      switch (payload.type) {
        case 'text_start': {
          blocks[index] = { type: 'text', text: '' }
          break
        }
        case 'text_delta': {
          const block = ensure()
          if (block.type === 'text') block.text += payload.delta ?? ''
          break
        }
        case 'text_end': {
          // `text_end` is the authoritative content of the block, so the
          // deltas are replaced rather than added to.
          const block = ensure()
          if (block.type === 'text') block.text = payload.content ?? block.text
          break
        }
        case 'thinking_start': {
          blocks[index] = { type: 'thinking', text: '' }
          break
        }
        case 'thinking_delta': {
          const block = ensure()
          if (block.type === 'thinking') block.text += payload.delta ?? ''
          break
        }
        case 'thinking_end': {
          const block = ensure()
          if (block.type === 'thinking') block.text = payload.content ?? block.text
          break
        }
        case 'toolcall_start': {
          // The model named a tool. It is not running yet — the node exists
          // from here on so a call that never executes is still visible.
          const toolCallId = payload.id ?? nextId('call')
          blocks[index] = {
            type: 'toolCall',
            id: toolCallId,
            name: payload.toolName ?? 'tool',
            argsText: ''
          }
          return patchTool(
            replaceItem(items, assistant.id, { ...assistant, blocks }),
            toolCallId,
            { status: 'proposed', toolName: payload.toolName ?? 'tool' },
            {
              toolName: payload.toolName ?? 'tool',
              args: {},
              status: 'proposed',
              runId: context?.runId,
              turnId: context?.turnId
            }
          )
        }
        case 'toolcall_delta': {
          // Arguments arrive as a JSON string. They are buffered, never
          // parsed mid-flight: a half-written object is not an argument.
          const block = ensure()
          if (block.type === 'toolCall') block.argsText += payload.delta ?? ''
          break
        }
        case 'toolcall_end': {
          const call = payload.toolCall
          const previous = blocks[index]
          const previousId = previous && previous.type === 'toolCall' ? previous.id : undefined
          const toolCallId = call?.id ?? previousId ?? nextId('call')
          const toolName =
            call?.name ?? (previous && previous.type === 'toolCall' ? previous.name : 'tool')
          blocks[index] = {
            type: 'toolCall',
            id: toolCallId,
            name: toolName,
            argsText: JSON.stringify(call?.arguments ?? {}, null, 2),
            args: call?.arguments ?? {}
          }
          return patchTool(
            replaceItem(items, assistant.id, { ...assistant, blocks }),
            toolCallId,
            {
              status: 'proposed',
              toolName,
              args: call?.arguments ?? {}
            },
            {
              toolName,
              args: call?.arguments ?? {},
              status: 'proposed',
              runId: context?.runId,
              turnId: context?.turnId
            }
          )
        }
        default:
          break
      }

      return replaceItem(items, assistant.id, { ...assistant, blocks })
    }

    case 'message_end': {
      const message = event.message as AgentMessage | undefined
      if (!message) return items
      if (message.role === 'assistant') {
        const assistant = lastStreamingAssistant(items)
        if (!assistant) return items
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
          streaming: false
        }
        return replaceItem(items, assistant.id, next)
      }
      return items
    }

    case 'tool_execution_start': {
      const toolCallId = String(event.toolCallId ?? '')
      if (!toolCallId) return items
      const existing = findTool(items, toolCallId)
      return patchTool(
        items,
        toolCallId,
        {
          status: 'running',
          toolName: String(event.toolName ?? existing?.toolName ?? 'tool'),
          startedAt: Date.now()
        },
        {
          toolName: String(event.toolName ?? 'tool'),
          args: (event.args as Record<string, unknown>) ?? {},
          status: 'running',
          startedAt: Date.now(),
          runId: context?.runId,
          turnId: context?.turnId
        }
      )
    }

    case 'tool_execution_update': {
      const toolCallId = String(event.toolCallId ?? '')
      const target = toolCallId ? findTool(items, toolCallId) : undefined
      if (!target) return items
      // `partialResult` is the newest partial result of the tool, so it
      // replaces what was there. Appending it would repeat the whole
      // output on every update.
      const progress = extractToolResult(event.partialResult)
      return patchTool(items, toolCallId, {
        status: 'running',
        progress: progress ?? target.progress
      })
    }

    case 'tool_execution_end': {
      const toolCallId = String(event.toolCallId ?? '')
      if (!toolCallId) return items
      const existing = findTool(items, toolCallId)
      const isError = Boolean(event.isError)
      return patchTool(
        items,
        toolCallId,
        {
          status: isError ? 'error' : 'ok',
          isError,
          result: extractToolResult(event.result) ?? existing?.result,
          exitCode: exitCodeOf(event.result) ?? existing?.exitCode,
          durationMs:
            typeof event.durationMs === 'number' ? event.durationMs : existing?.durationMs,
          finishedAt: Date.now(),
          progress: undefined
        },
        {
          toolName: String(event.toolName ?? 'tool'),
          args: (event.args as Record<string, unknown>) ?? {},
          status: isError ? 'error' : 'ok',
          isError,
          durationMs:
            typeof event.durationMs === 'number' ? (event.durationMs as number) : undefined,
          finishedAt: Date.now(),
          runId: context?.runId,
          turnId: context?.turnId
        }
      )
    }

    case 'bash_execution_update': {
      const delta = String(event.delta ?? '')
      const targetId = typeof event.id === 'string' ? event.id : undefined
      let existing: BashItem | undefined
      if (targetId) {
        existing = items.find((item) => item.kind === 'bash' && item.id === targetId) as
          | BashItem
          | undefined
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
      return [
        ...items,
        {
          id: targetId ?? nextId('bash'),
          kind: 'bash',
          command: '',
          output: delta,
          timestamp: Date.now(),
          order: nextOrder()
        }
      ]
    }

    case 'compaction_start': {
      const reason = String(event.reason ?? 'manual')
      return [...items, notice('info', `Compacting context (${reason})…`)]
    }

    case 'compaction_end': {
      const aborted = Boolean(event.aborted)
      if (aborted) return [...items, notice('warn', 'Compaction aborted')]
      if (event.errorMessage) {
        return [...items, notice('error', `Compaction failed: ${String(event.errorMessage)}`)]
      }
      const result = event.result as { tokensBefore?: number; estimatedTokensAfter?: number } | undefined
      const before = result?.tokensBefore
      const after = result?.estimatedTokensAfter
      const detail = before && after ? ` (${before} → ~${after} tokens)` : ''
      return [...items, notice('success', `Context compacted${detail}`)]
    }

    case 'auto_retry_start': {
      const raw = String(event.errorMessage ?? 'transient error')
      const wait = Math.max(1, Math.round(Number(event.delayMs ?? 0) / 1000))
      // A rate-limit payload is a page of JSON. The transcript only needs to
      // say that the turn is waiting, not paste the provider body in.
      const detail = isRateLimitError(raw)
        ? `rate limit, next try in ${wait}s`
        : raw.replace(/\s+/g, ' ').trim().slice(0, 180)
      return [
        ...items,
        notice(
          'warn',
          `Retrying (attempt ${String(event.attempt ?? 1)}/${String(event.maxAttempts ?? '?')}) — ${detail}`
        )
      ]
    }

    case 'auto_retry_end': {
      if (event.success) return [...items, notice('success', 'Retry succeeded')]
      const raw = String(event.finalError ?? 'unknown error')
      const detail = isRateLimitError(raw)
        ? 'still rate limited'
        : raw.replace(/\s+/g, ' ').trim().slice(0, 180)
      return [...items, notice('error', `Retry failed: ${detail}`)]
    }

    case 'extension_error': {
      return [...items, notice('error', `Extension error: ${String(event.error ?? '')}`)]
    }

    case 'client_notice': {
      const level = (event.level as NoticeItem['level']) ?? 'warn'
      return [...items, notice(level, String(event.text ?? ''))]
    }

    default:
      return items
  }
}

/** Apply a batch of events in order, in one pass. */
export function applyEvents(
  items: ThreadItem[],
  events: PiEvent[],
  context?: StreamContext
): ThreadItem[] {
  let next = items
  for (const event of events) next = applyEvent(next, event, context)
  return next
}

/**
 * Mark everything that was still moving as stopped.
 *
 * Called when Pi confirms the run was aborted: a tool that was running did
 * not finish, so it is `aborted` rather than a success, and an assistant
 * message that was still streaming keeps whatever text it had.
 */
export function markAborted(items: ThreadItem[]): ThreadItem[] {
  return items.map((item) => {
    if (item.kind === 'tool' && (item.status === 'running' || item.status === 'proposed')) {
      return { ...item, status: 'aborted' as const, finishedAt: Date.now(), progress: undefined }
    }
    if (item.kind === 'assistant' && item.streaming) {
      return { ...item, streaming: false }
    }
    return item
  })
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

/** Collapse a prompt to a comparable shape. */
function normalizePrompt(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
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

/**
 * Map the user messages in the thread to the entry ids Pi can fork from.
 *
 * Pi reports the forkable prompts of the active branch in order, so the
 * pairing is positional. The text is used first, because a resumed session
 * and a live stream can disagree about whitespace.
 */
export function pairForkTargets(
  items: ThreadItem[],
  targets: ForkTarget[]
): Map<string, string> {
  const paired = new Map<string, string>()
  if (!targets.length) return paired

  const byText = new Map<string, string[]>()
  for (const target of targets) {
    const key = normalizePrompt(target.text)
    const bucket = byText.get(key)
    if (bucket) bucket.push(target.entryId)
    else byText.set(key, [target.entryId])
  }

  const users = items.filter((item): item is UserItem => item.kind === 'user')
  const used = new Set<string>()

  for (const user of users) {
    const bucket = byText.get(normalizePrompt(user.text))
    const entryId = bucket?.shift()
    if (!entryId) continue
    paired.set(user.id, entryId)
    used.add(entryId)
  }

  // A prompt with no text — an image-only message — still lines up by
  // position within the branch.
  const leftover = targets.filter((target) => !used.has(target.entryId))
  let index = 0
  for (const user of users) {
    if (paired.has(user.id)) continue
    const target = leftover[index]
    index += 1
    if (!target) break
    paired.set(user.id, target.entryId)
  }

  return paired
}
