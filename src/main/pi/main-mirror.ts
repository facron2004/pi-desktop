import {
  GOAL_STATUS_KEY,
  TASK_MODE_STATUS_KEY,
  isSideSessionKey,
  type AgentMessage,
  type ContentBlock,
  type PiEvent,
  type RuntimeEvent,
  type RuntimeRekey,
  type SideChatReference,
  type SideChatStagePromptInput
} from '@shared/types'
import { readGoalState } from '@shared/task-mode-state'
import { openSessionFile, readSessionConversation, resolveSessionRoots } from '../sessions'
import { canonicalSessionFile } from './session-file'
import type { SessionSupervisor } from './supervisor'

export const MAX_DIGEST_CHARS = 3200
export const MAX_INSPECT_OUTPUT_CHARS = 24_000
export const TOOL_OUTPUT_LINES_PER_PAGE = 200

export type MirrorToolStatus = 'proposed' | 'running' | 'ok' | 'error' | 'aborted'

export interface MirrorTodoItem {
  text: string
  status: 'pending' | 'in_progress' | 'done'
}

export interface MirrorToolCall {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  status: MirrorToolStatus
  partialOutput: string
  finalOutput: string
  isError: boolean
  durationMs?: number
  turnOrdinal: number
}

export interface MirrorTurn {
  ordinal: number
  userText: string
  assistantText: string
  thinkingSummary?: string
  tools: MirrorToolCall[]
  errorMessage?: string
  streaming: boolean
  timestamp: number
}

export interface InspectMainConversationParams {
  view?: 'turns' | 'tool' | 'plan' | 'search'
  turnStart?: number
  turnCount?: number
  fromEnd?: boolean
  toolCallId?: string
  outputOffsetLines?: number
  query?: string
}

export interface InspectConversationResult {
  text: string
  details: Record<string, unknown>
}

interface LiveMainState {
  ownerId: string
  phase: 'idle' | 'starting' | 'running' | 'settling'
  mode?: string
  goal?: { text: string; status: string; summary?: string }
  todos: MirrorTodoItem[]
  pendingUiTitle?: string
  lastError?: string
  lastNotice?: string
  sessionChangedFiles: Set<string>
  turns: MirrorTurn[]
  activeTurn: MirrorTurn | null
  activeAssistantBlocks: Map<number, { type: string; text: string }>
  toolById: Map<string, MirrorToolCall>
}

interface MergedConversationView {
  running: boolean
  mode: string
  goal?: { text: string; status: string; summary?: string }
  todos: MirrorTodoItem[]
  pendingUiTitle?: string
  lastError?: string
  lastNotice?: string
  sessionChangedFiles: string[]
  turns: MirrorTurn[]
  toolById: Map<string, MirrorToolCall>
}

const TERMINAL_TOOL_STATUSES = new Set<MirrorToolStatus>(['ok', 'error', 'aborted'])
const MAX_CACHED_TOOL_OUTPUT_CHARS = 128_000
const MAX_LIVE_TURNS_KEPT = 60

function mirrorKey(sessionKey: string): string {
  return sessionKey.startsWith('draft:') ? sessionKey : canonicalSessionFile(sessionKey)
}

function escapeXmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 1) return text.slice(0, Math.max(0, maxChars))
  return `${text.slice(0, maxChars - 1)}…`
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const rec = block as Record<string, unknown>
    if (rec.type === 'text' && typeof rec.text === 'string') {
      parts.push(rec.text)
    }
  }
  return parts.join('\n')
}

function extractToolResultText(result: unknown): string {
  if (typeof result === 'string') return result
  if (!result || typeof result !== 'object') return ''
  const rec = result as Record<string, unknown>
  if (Array.isArray(rec.content)) {
    const text = extractTextFromContent(rec.content)
    if (text) return text
  }
  if (typeof rec.output === 'string') return rec.output
  if (typeof rec.text === 'string') return rec.text
  if (typeof rec.error === 'string') return rec.error
  return ''
}

function parseDesktopTodos(input: unknown): MirrorTodoItem[] | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = (input as { items?: unknown; todos?: unknown }).items ?? (input as { todos?: unknown }).todos
  if (!Array.isArray(raw)) return undefined
  const items: MirrorTodoItem[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    const text = typeof rec.text === 'string'
      ? rec.text.trim()
      : typeof rec.content === 'string'
        ? rec.content.trim()
        : typeof rec.title === 'string'
          ? rec.title.trim()
          : ''
    if (!text) continue
    const rawStatus = typeof rec.status === 'string' ? rec.status.toLowerCase() : ''
    const status: MirrorTodoItem['status'] =
      rawStatus === 'done' || rawStatus === 'completed' || rec.completed === true || rec.done === true
        ? 'done'
        : rawStatus === 'in_progress' || rawStatus === 'in-progress' || rawStatus === 'active'
          ? 'in_progress'
          : 'pending'
    items.push({ text, status })
  }
  return items.length > 0 ? items : undefined
}

function extractChecklistFallback(markdown: string): MirrorTodoItem[] {
  const items: MirrorTodoItem[] = []
  const lines = markdown.split(/\r?\n/)
  for (const line of lines) {
    const match = line.match(/^\s*(?:[-*+]|\d+\.)\s+\[([ xX~/-])\]\s+(.+)$/)
    if (!match) continue
    const mark = match[1]!
    const text = match[2]!.trim()
    if (!text) continue
    const status: MirrorTodoItem['status'] =
      mark === 'x' || mark === 'X' ? 'done' : mark === '~' || mark === '/' || mark === '-' ? 'in_progress' : 'pending'
    items.push({ text, status })
    if (items.length >= 24) break
  }
  return items
}

function extractEditedFilePath(toolName: string, args: Record<string, unknown>): string | undefined {
  if (toolName !== 'edit' && toolName !== 'write') return undefined
  const candidate = args.path ?? args.file_path ?? args.filePath
  if (typeof candidate !== 'string') return undefined
  const trimmed = candidate.trim()
  return trimmed || undefined
}

function summarizeToolArgs(toolName: string, args: Record<string, unknown>): string {
  const filePath = args.path ?? args.file_path ?? args.filePath
  if (typeof filePath === 'string' && filePath.trim()) return filePath.trim()
  if ((toolName === 'bash' || toolName === 'powershell') && typeof args.command === 'string') {
    return clipText(collapseSpaces(args.command), 80)
  }
  if (toolName === 'grep' && typeof args.pattern === 'string') {
    return clipText(args.pattern, 60)
  }
  if (toolName === 'find' && typeof args.pattern === 'string') {
    return clipText(args.pattern, 60)
  }
  const keys = Object.keys(args)
  if (keys.length === 0) return ''
  return clipText(JSON.stringify(args), 80)
}

function parseColdMessages(messages: readonly AgentMessage[]): {
  turns: MirrorTurn[]
  toolById: Map<string, MirrorToolCall>
  todos: MirrorTodoItem[]
  sessionChangedFiles: string[]
} {
  const turns: MirrorTurn[] = []
  const toolById = new Map<string, MirrorToolCall>()
  let todos: MirrorTodoItem[] = []
  const changedFiles = new Set<string>()
  let current: MirrorTurn | null = null

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    if (msg.role === 'user') {
      const ordinal = turns.length + 1
      current = {
        ordinal,
        userText: extractTextFromContent(msg.content).trim(),
        assistantText: '',
        tools: [],
        streaming: false,
        timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now()
      }
      turns.push(current)
      continue
    }
    if (msg.role === 'assistant') {
      if (!current) {
        current = {
          ordinal: turns.length + 1,
          userText: '',
          assistantText: '',
          tools: [],
          streaming: false,
          timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now()
        }
        turns.push(current)
      }
      const text = extractTextFromContent(msg.content)
      if (text) {
        current.assistantText = current.assistantText ? `${current.assistantText}\n${text}` : text
      }
      if (typeof msg.errorMessage === 'string' && msg.errorMessage) {
        current.errorMessage = msg.errorMessage
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content as ContentBlock[]) {
          if (block.type === 'toolCall') {
            const args = block.arguments && typeof block.arguments === 'object' ? block.arguments : {}
            const toolCall: MirrorToolCall = {
              toolCallId: block.id,
              toolName: block.name,
              args,
              status: 'proposed',
              partialOutput: '',
              finalOutput: '',
              isError: false,
              turnOrdinal: current.ordinal
            }
            toolById.set(block.id, toolCall)
            current.tools.push(toolCall)
            if (block.name === 'desktop_todo') {
              const parsedTodos = parseDesktopTodos(args)
              if (parsedTodos) todos = parsedTodos
            }
          }
        }
      }
      continue
    }
    if (msg.role === 'toolResult' && typeof msg.toolCallId === 'string') {
      const existing = toolById.get(msg.toolCallId)
      const output = extractTextFromContent(msg.content).slice(0, MAX_CACHED_TOOL_OUTPUT_CHARS)
      const isError = msg.isError === true
      if (existing) {
        existing.finalOutput = output
        existing.isError = isError
        existing.status = isError ? 'error' : 'ok'
        if (!isError) {
          const edited = extractEditedFilePath(existing.toolName, existing.args)
          if (edited) changedFiles.add(edited)
        }
      } else if (current) {
        const fallback: MirrorToolCall = {
          toolCallId: msg.toolCallId,
          toolName: typeof msg.toolName === 'string' ? msg.toolName : 'tool',
          args: {},
          status: isError ? 'error' : 'ok',
          partialOutput: '',
          finalOutput: output,
          isError,
          turnOrdinal: current.ordinal
        }
        toolById.set(msg.toolCallId, fallback)
        current.tools.push(fallback)
      }
    }
  }

  if (todos.length === 0) {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const checklist = extractChecklistFallback(turns[i]!.assistantText)
      if (checklist.length > 0) {
        todos = checklist
        break
      }
    }
  }

  return {
    turns,
    toolById,
    todos,
    sessionChangedFiles: [...changedFiles]
  }
}

export class MainConversationMirror {
  private supervisor?: SessionSupervisor
  private readonly getSessionRoots: () => readonly string[]
  private readonly liveStates = new Map<string, LiveMainState>()

  constructor(options: { supervisor?: SessionSupervisor; getSessionRoots?: () => readonly string[] } = {}) {
    this.getSessionRoots = options.getSessionRoots ?? (() => resolveSessionRoots())
    if (options.supervisor) {
      this.attach(options.supervisor)
    }
  }

  attach(supervisor: SessionSupervisor): void {
    if (this.supervisor === supervisor) return
    this.dispose()
    this.supervisor = supervisor
    supervisor.on('event', this.handleRuntimeEvent)
    supervisor.on('rekey', this.handleRuntimeRekey)
    supervisor.on('ui-responded', this.handleUiResponded)
  }

  dispose(): void {
    if (this.supervisor) {
      this.supervisor.off('event', this.handleRuntimeEvent)
      this.supervisor.off('rekey', this.handleRuntimeRekey)
      this.supervisor.off('ui-responded', this.handleUiResponded)
      this.supervisor = undefined
    }
  }

  private getOrCreateLive(ownerId: string): LiveMainState {
    const key = mirrorKey(ownerId)
    let state = this.liveStates.get(key)
    if (!state) {
      state = {
        ownerId,
        phase: 'idle',
        todos: [],
        sessionChangedFiles: new Set<string>(),
        turns: [],
        activeTurn: null,
        activeAssistantBlocks: new Map(),
        toolById: new Map()
      }
      this.liveStates.set(key, state)
    }
    return state
  }

  private ensureActiveTurn(state: LiveMainState, timestamp = Date.now()): MirrorTurn {
    if (!state.activeTurn) {
      const ordinal = state.turns.length + 1
      const turn: MirrorTurn = {
        ordinal,
        userText: '',
        assistantText: '',
        tools: [],
        streaming: true,
        timestamp
      }
      state.turns.push(turn)
      if (state.turns.length > MAX_LIVE_TURNS_KEPT) {
        state.turns.shift()
      }
      state.activeTurn = turn
    }
    return state.activeTurn
  }

  private upsertTool(
    state: LiveMainState,
    toolCallId: string,
    patch: Partial<MirrorToolCall> & { toolName?: string; args?: Record<string, unknown> }
  ): MirrorToolCall {
    let tool = state.toolById.get(toolCallId)
    const turn = this.ensureActiveTurn(state)
    if (!tool) {
      tool = {
        toolCallId,
        toolName: patch.toolName ?? 'tool',
        args: patch.args ?? {},
        status: patch.status ?? 'proposed',
        partialOutput: patch.partialOutput ?? '',
        finalOutput: patch.finalOutput ?? '',
        isError: patch.isError ?? false,
        durationMs: patch.durationMs,
        turnOrdinal: turn.ordinal
      }
      state.toolById.set(toolCallId, tool)
      turn.tools.push(tool)
      return tool
    }
    // Keep terminal state immutable (`ok` / `error` / `aborted`)
    if (patch.toolName && (!tool.toolName || tool.toolName === 'tool')) tool.toolName = patch.toolName
    if (patch.args && Object.keys(patch.args).length > 0) {
      tool.args = { ...tool.args, ...patch.args }
    }
    if (!TERMINAL_TOOL_STATUSES.has(tool.status)) {
      if (patch.status) tool.status = patch.status
      if (patch.partialOutput !== undefined) tool.partialOutput = patch.partialOutput
      if (patch.finalOutput !== undefined) tool.finalOutput = patch.finalOutput
      if (patch.isError !== undefined) tool.isError = patch.isError
      if (patch.durationMs !== undefined) tool.durationMs = patch.durationMs
    }
    return tool
  }

  /** Feed a single Pi event directly (also callable in unit tests). */
  applyEvent(ownerId: string, event: PiEvent): void {
    if (!ownerId || isSideSessionKey(ownerId)) return
    const state = this.getOrCreateLive(ownerId)

    switch (event.type) {
      case 'agent_start': {
        state.phase = 'running'
        state.lastError = undefined
        state.activeAssistantBlocks.clear()
        break
      }
      case 'agent_end': {
        state.phase = 'settling'
        break
      }
      case 'agent_settled': {
        const aborted = event.aborted === true
        state.phase = 'idle'
        state.pendingUiTitle = undefined
        if (state.activeTurn) {
          state.activeTurn.streaming = false
          for (const tool of state.activeTurn.tools) {
            if (!TERMINAL_TOOL_STATUSES.has(tool.status)) {
              tool.status = aborted ? 'aborted' : tool.status
            }
          }
          if (state.todos.length === 0 && state.activeTurn.assistantText) {
            const fallback = extractChecklistFallback(state.activeTurn.assistantText)
            if (fallback.length > 0) state.todos = fallback
          }
          state.activeTurn = null
        }
        if (event.crashed === true) {
          state.lastError = 'Main conversation runtime stopped unexpectedly.'
        }
        break
      }
      case 'message_start':
      case 'message_end': {
        const msg = event.message as AgentMessage | undefined
        if (!msg || typeof msg !== 'object') break
        if (msg.role === 'user') {
          const text = extractTextFromContent(msg.content).trim()
          const ts = typeof msg.timestamp === 'number' ? msg.timestamp : Date.now()
          if (event.type === 'message_start' || !state.activeTurn || (state.activeTurn.userText && state.activeTurn.userText !== text)) {
            if (state.activeTurn) state.activeTurn.streaming = false
            const turn: MirrorTurn = {
              ordinal: state.turns.length + 1,
              userText: text,
              assistantText: '',
              tools: [],
              streaming: true,
              timestamp: ts
            }
            state.turns.push(turn)
            if (state.turns.length > MAX_LIVE_TURNS_KEPT) state.turns.shift()
            state.activeTurn = turn
          } else {
            state.activeTurn.userText = text
          }
        } else if (msg.role === 'assistant') {
          const turn = this.ensureActiveTurn(state)
          if (event.type === 'message_end') {
            const authoritative = extractTextFromContent(msg.content)
            if (authoritative) {
              turn.assistantText = authoritative
            }
            if (typeof msg.errorMessage === 'string' && msg.errorMessage) {
              turn.errorMessage = msg.errorMessage
              state.lastError = msg.errorMessage
            }
            if (Array.isArray(msg.content)) {
              for (const block of msg.content as ContentBlock[]) {
                if (block.type === 'toolCall') {
                  const args = block.arguments && typeof block.arguments === 'object' ? block.arguments : {}
                  this.upsertTool(state, block.id, { toolName: block.name, args, status: 'proposed' })
                  if (block.name === 'desktop_todo') {
                    const parsed = parseDesktopTodos(args)
                    if (parsed) state.todos = parsed
                  }
                }
              }
            }
            state.activeAssistantBlocks.clear()
          }
        } else if (msg.role === 'toolResult' && typeof msg.toolCallId === 'string' && event.type === 'message_end') {
          const output = extractTextFromContent(msg.content).slice(0, MAX_CACHED_TOOL_OUTPUT_CHARS)
          const isError = msg.isError === true
          const tool = this.upsertTool(state, msg.toolCallId, {
            toolName: typeof msg.toolName === 'string' ? msg.toolName : undefined,
            status: isError ? 'error' : 'ok',
            finalOutput: output,
            isError
          })
          if (!isError) {
            const edited = extractEditedFilePath(tool.toolName, tool.args)
            if (edited) state.sessionChangedFiles.add(edited)
          }
        }
        break
      }
      case 'message_update': {
        const sub = event.assistantMessageEvent as Record<string, unknown> | undefined
        if (!sub || typeof sub !== 'object') break
        const subType = sub.type
        const contentIndex = typeof sub.contentIndex === 'number' ? sub.contentIndex : 0
        const turn = this.ensureActiveTurn(state)

        if (subType === 'text_delta' && typeof sub.delta === 'string') {
          const entry = state.activeAssistantBlocks.get(contentIndex) ?? { type: 'text', text: '' }
          entry.text += sub.delta
          state.activeAssistantBlocks.set(contentIndex, entry)
          turn.assistantText = this.joinAssistantBlocks(state)
        } else if (subType === 'text_end' && typeof sub.content === 'string') {
          state.activeAssistantBlocks.set(contentIndex, { type: 'text', text: sub.content })
          turn.assistantText = this.joinAssistantBlocks(state)
        } else if (subType === 'toolcall_start') {
          const id = typeof sub.id === 'string' ? sub.id : ''
          const name = typeof sub.toolName === 'string' ? sub.toolName : 'tool'
          if (id) this.upsertTool(state, id, { toolName: name, status: 'proposed' })
        } else if (subType === 'toolcall_end') {
          const call = sub.toolCall as { id?: unknown; name?: unknown; arguments?: unknown } | undefined
          if (call && typeof call.id === 'string') {
            const args = call.arguments && typeof call.arguments === 'object' ? (call.arguments as Record<string, unknown>) : {}
            const toolName = typeof call.name === 'string' ? call.name : 'tool'
            this.upsertTool(state, call.id, { toolName, args, status: 'proposed' })
            if (toolName === 'desktop_todo') {
              const parsed = parseDesktopTodos(args)
              if (parsed) state.todos = parsed
            }
          }
        } else if (subType === 'error') {
          const err = typeof sub.error === 'string' ? sub.error : 'Provider stream error'
          turn.errorMessage = err
          state.lastError = err
        }
        break
      }
      case 'tool_execution_start': {
        const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : ''
        if (!toolCallId) break
        const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool'
        const args = event.args && typeof event.args === 'object' ? (event.args as Record<string, unknown>) : {}
        this.upsertTool(state, toolCallId, { toolName, args, status: 'running' })
        if (toolName === 'desktop_todo') {
          const parsed = parseDesktopTodos(args)
          if (parsed) state.todos = parsed
        }
        break
      }
      case 'tool_execution_update': {
        const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : ''
        if (!toolCallId) break
        // `partialResult` replaces the previous partial output (AGENTS.md)
        const partial = extractToolResultText(event.partialResult).slice(0, MAX_CACHED_TOOL_OUTPUT_CHARS)
        this.upsertTool(state, toolCallId, {
          toolName: typeof event.toolName === 'string' ? event.toolName : undefined,
          status: 'running',
          partialOutput: partial
        })
        break
      }
      case 'tool_execution_end': {
        const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : ''
        if (!toolCallId) break
        const isError = event.isError === true
        const output = extractToolResultText(event.result).slice(0, MAX_CACHED_TOOL_OUTPUT_CHARS)
        const durationMs = typeof event.durationMs === 'number' ? event.durationMs : undefined
        const tool = this.upsertTool(state, toolCallId, {
          toolName: typeof event.toolName === 'string' ? event.toolName : undefined,
          status: isError ? 'error' : 'ok',
          finalOutput: output,
          isError,
          durationMs
        })
        if (!isError) {
          const edited = extractEditedFilePath(tool.toolName, tool.args)
          if (edited) state.sessionChangedFiles.add(edited)
        }
        break
      }
      case 'extension_ui_request': {
        const method = typeof event.method === 'string' ? event.method : ''
        if (method === 'setStatus') {
          const key = typeof event.statusKey === 'string' ? event.statusKey : ''
          const text = typeof event.statusText === 'string' ? event.statusText : undefined
          if (key === TASK_MODE_STATUS_KEY) {
            state.mode = text || undefined
          } else if (key === GOAL_STATUS_KEY) {
            if (!text) {
              state.goal = undefined
            } else {
              try {
                const parsed = readGoalState(JSON.parse(text))
                state.goal = parsed
              } catch {
                /* ignore malformed goal status */
              }
            }
          }
        } else if (method === 'select' || method === 'confirm' || method === 'input' || method === 'editor') {
          const title = typeof event.title === 'string' && event.title.trim()
            ? event.title.trim()
            : typeof event.message === 'string' && event.message.trim()
              ? event.message.trim()
              : 'Waiting for user input'
          state.pendingUiTitle = clipText(title, 120)
        }
        break
      }
      case 'auto_retry_start': {
        state.lastNotice = typeof event.errorMessage === 'string' ? `Retrying: ${clipText(event.errorMessage, 120)}` : 'Retrying request'
        break
      }
      case 'compaction_start': {
        state.lastNotice = 'Compacting conversation context'
        break
      }
      case 'compaction_end': {
        state.lastNotice = 'Conversation context compacted'
        break
      }
      default:
        break
    }
  }

  private joinAssistantBlocks(state: LiveMainState): string {
    return [...state.activeAssistantBlocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, block]) => block.text)
      .join('\n')
  }

  private readonly handleRuntimeEvent = (payload: RuntimeEvent): void => {
    this.applyEvent(payload.ownerId, payload.event)
  }

  private readonly handleUiResponded = (payload: { ownerId: string; id: string }): void => {
    if (!payload?.ownerId || isSideSessionKey(payload.ownerId)) return
    const live = this.liveStates.get(mirrorKey(payload.ownerId))
    if (live) live.pendingUiTitle = undefined
  }

  readonly handleRuntimeRekey = (change: RuntimeRekey): void => {
    const { from, to, replace } = change
    if (!from || !to || from === to) return
    if (isSideSessionKey(from) || isSideSessionKey(to)) return
    const fromKey = mirrorKey(from)
    const toKey = mirrorKey(to)
    if (fromKey === toKey) return
    const migrate = replace === true || from.startsWith('draft:')
    if (!migrate) return
    const existing = this.liveStates.get(fromKey)
    if (!existing) return
    this.liveStates.delete(fromKey)
    existing.ownerId = to
    this.liveStates.set(toKey, existing)
  }

  private async loadMergedView(
    parentKey: string,
    sessionRoots: readonly string[] = this.getSessionRoots()
  ): Promise<MergedConversationView> {
    const live = this.liveStates.get(mirrorKey(parentKey))
    let coldTurns: MirrorTurn[] = []
    let coldTools = new Map<string, MirrorToolCall>()
    let coldTodos: MirrorTodoItem[] = []
    let coldChangedFiles: string[] = []
    let coldMode: string | undefined
    let coldGoal: { text: string; status: string; summary?: string } | undefined

    if (parentKey && !parentKey.startsWith('draft:')) {
      const opened = await openSessionFile(parentKey, sessionRoots)
      if (opened) {
        try {
          const read = await readSessionConversation(opened.target, opened.handle)
          const parsed = parseColdMessages(read.messages)
          coldTurns = parsed.turns
          coldTools = parsed.toolById
          coldTodos = parsed.todos
          coldChangedFiles = parsed.sessionChangedFiles
          coldMode = read.taskMode?.mode
          coldGoal = read.taskMode?.goal
        } finally {
          await opened.handle.close().catch(() => {})
        }
      }
    }

    const turns: MirrorTurn[] = coldTurns.map((t) => ({ ...t, tools: [...t.tools] }))
    const toolById = new Map<string, MirrorToolCall>(coldTools)
    const changedSet = new Set<string>(coldChangedFiles)

    if (live) {
      for (const file of live.sessionChangedFiles) changedSet.add(file)
      for (const [id, tool] of live.toolById) {
        toolById.set(id, tool)
      }
      // Merge live turns without duplicating turns already flushed to disk
      for (const liveTurn of live.turns) {
        const matchingCold = turns.find(
          (cold) =>
            cold.userText &&
            liveTurn.userText &&
            cold.userText === liveTurn.userText &&
            Math.abs(cold.timestamp - liveTurn.timestamp) < 120_000
        )
        if (matchingCold) {
          // If live turn is still streaming or richer than flushed copy, upgrade it in place
          if (liveTurn.streaming || liveTurn.assistantText.length > matchingCold.assistantText.length) {
            matchingCold.assistantText = liveTurn.assistantText || matchingCold.assistantText
            matchingCold.streaming = liveTurn.streaming
            matchingCold.errorMessage = liveTurn.errorMessage ?? matchingCold.errorMessage
            const existingIds = new Set(matchingCold.tools.map((t) => t.toolCallId))
            for (const lt of liveTurn.tools) {
              if (!existingIds.has(lt.toolCallId)) {
                matchingCold.tools.push(lt)
              } else {
                const idx = matchingCold.tools.findIndex((t) => t.toolCallId === lt.toolCallId)
                if (idx >= 0) matchingCold.tools[idx] = lt
              }
            }
          }
        } else {
          turns.push({
            ...liveTurn,
            ordinal: turns.length + 1,
            tools: [...liveTurn.tools]
          })
        }
      }
    }

    // Re-number ordinals cleanly 1..N
    for (let i = 0; i < turns.length; i += 1) {
      turns[i]!.ordinal = i + 1
    }

    const supInfo = this.supervisor?.sessionInfo(parentKey)
    const running = Boolean(
      supInfo?.running || (live && (live.phase === 'running' || live.phase === 'starting' || live.phase === 'settling'))
    )

    return {
      running,
      mode: live?.mode ?? coldMode ?? 'default',
      goal: live?.goal ?? coldGoal,
      todos: live && live.todos.length > 0 ? live.todos : coldTodos,
      pendingUiTitle: live?.pendingUiTitle,
      lastError: live?.lastError,
      lastNotice: live?.lastNotice,
      sessionChangedFiles: [...changedSet],
      turns,
      toolById
    }
  }

  async getSnapshotMeta(
    parentKey: string,
    sessionRoots: readonly string[] = this.getSessionRoots()
  ): Promise<{ parentRunning: boolean; parentTurnCount: number; sessionChangedFiles: string[] }> {
    const view = await this.loadMergedView(parentKey, sessionRoots)
    return {
      parentRunning: view.running,
      parentTurnCount: view.turns.length,
      sessionChangedFiles: view.sessionChangedFiles
    }
  }

  async buildDigest(
    parentKey: string,
    staged?: SideChatStagePromptInput,
    sessionRoots: readonly string[] = this.getSessionRoots()
  ): Promise<{ digestXml: string }> {
    const view = await this.loadMergedView(parentKey, sessionRoots)
    const status = view.running ? 'running' : 'idle'
    const header = `<main_conversation_digest synced_at="${new Date().toISOString()}" status="${status}" turns="${view.turns.length}" mode="${escapeXmlAttr(view.mode)}">`
    const footer = `  <hint>Call \`inspect_main_conversation\` for full turn text, search, or tool outputs; call \`inspect_main_changes\` for session or git diffs.</hint>\n</main_conversation_digest>`

    const sections: string[] = []

    if (view.goal) {
      sections.push(
        `  <goal status="${escapeXmlAttr(view.goal.status)}">${clipText(collapseSpaces(view.goal.text), 240)}</goal>`
      )
    }

    if (view.todos.length > 0) {
      const done = view.todos.filter((t) => t.status === 'done').length
      const todoLines = view.todos.slice(0, 8).map((item) => {
        const mark = item.status === 'done' ? '[x]' : item.status === 'in_progress' ? '[in_progress]' : '[ ]'
        return `    - ${mark} ${clipText(collapseSpaces(item.text), 110)}`
      })
      if (view.todos.length > 8) {
        todoLines.push(`    - (+${view.todos.length - 8} more items)`)
      }
      sections.push(`  <todo done="${done}" total="${view.todos.length}">\n${todoLines.join('\n')}\n  </todo>`)
    }

    if (view.pendingUiTitle) {
      sections.push(`  <waiting_for_user>${clipText(collapseSpaces(view.pendingUiTitle), 140)}</waiting_for_user>`)
    }

    if (view.lastError) {
      sections.push(`  <last_error>${clipText(collapseSpaces(view.lastError), 220)}</last_error>`)
    } else if (view.lastNotice) {
      sections.push(`  <notice>${clipText(collapseSpaces(view.lastNotice), 140)}</notice>`)
    }

    // Active / live streaming turn
    const lastTurn = view.turns[view.turns.length - 1]
    const hasLiveTurn = Boolean(lastTurn && (lastTurn.streaming || view.running))
    if (hasLiveTurn && lastTurn) {
      const lines: string[] = []
      if (lastTurn.userText) {
        lines.push(`    User: "${clipText(collapseSpaces(lastTurn.userText), 200)}"`)
      }
      if (lastTurn.assistantText) {
        lines.push(
          `    Assistant (streaming, ${lastTurn.assistantText.length} chars): "${clipText(collapseSpaces(lastTurn.assistantText), 280)}"`
        )
      }
      if (lastTurn.tools.length > 0) {
        const toolSummary = lastTurn.tools
          .slice(-6)
          .map((t) => `[${t.status}] ${t.toolName}${summarizeToolArgs(t.toolName, t.args) ? ` ${summarizeToolArgs(t.toolName, t.args)}` : ''}`)
          .join('; ')
        lines.push(`    Active tools: ${clipText(toolSummary, 280)}`)
      }
      if (lines.length > 0) {
        sections.push(`  <live_activity turn="${lastTurn.ordinal}">\n${lines.join('\n')}\n  </live_activity>`)
      }
    }

    if (view.sessionChangedFiles.length > 0) {
      const files = view.sessionChangedFiles.slice(0, 12).join(', ')
      const more = view.sessionChangedFiles.length > 12 ? ` (+${view.sessionChangedFiles.length - 12} more)` : ''
      sections.push(
        `  <session_changes count="${view.sessionChangedFiles.length}">${clipText(`${files}${more}`, 360)}</session_changes>`
      )
    }

    if (staged?.preset || staged?.stepText) {
      const metaParts: string[] = []
      if (staged.preset) metaParts.push(`preset="${escapeXmlAttr(staged.preset)}"`)
      const inner = staged.stepText ? clipText(collapseSpaces(staged.stepText), 240) : ''
      sections.push(`  <workflow ${metaParts.join(' ')}>${inner}</workflow>`)
    }

    if (staged?.references && staged.references.length > 0) {
      const refLines = staged.references.slice(0, 6).map((ref) => `    ${formatReferenceLine(ref)}`)
      sections.push(
        `  <attached_references count="${staged.references.length}">\n${refLines.join('\n')}\n  </attached_references>`
      )
    }

    // Reserve budget for header, fixed sections, and footer, then pack newest settled turns (dropping oldest first)
    const settledTurns = hasLiveTurn ? view.turns.slice(0, -1) : view.turns
    const baseText = [header, ...sections, footer].join('\n')
    const remainingBudget = MAX_DIGEST_CHARS - baseText.length - 64

    if (settledTurns.length > 0 && remainingBudget > 80) {
      const candidateTurns = settledTurns.slice(-5)
      const turnLines: string[] = []
      let used = 0
      const selectedOrdinals: number[] = []
      for (let i = candidateTurns.length - 1; i >= 0; i -= 1) {
        const turn = candidateTurns[i]!
        const u = clipText(collapseSpaces(turn.userText || '(no prompt)'), 120)
        const a = clipText(collapseSpaces(turn.assistantText || turn.errorMessage || '(no text)'), 160)
        const line = `    [Turn ${turn.ordinal}] User: "${u}" -> Assistant: ${a}`
        if (used + line.length + 1 > remainingBudget) break
        turnLines.unshift(line)
        selectedOrdinals.unshift(turn.ordinal)
        used += line.length + 1
      }
      if (turnLines.length > 0) {
        const windowLabel =
          selectedOrdinals.length === 1
            ? `${selectedOrdinals[0]}`
            : `${selectedOrdinals[0]}..${selectedOrdinals[selectedOrdinals.length - 1]}`
        sections.push(
          `  <recent_turns window="${windowLabel}" total="${view.turns.length}">\n${turnLines.join('\n')}\n  </recent_turns>`
        )
      }
    }

    let xml = [header, ...sections, footer].join('\n')
    if (xml.length > MAX_DIGEST_CHARS) {
      // Final hard-bound truncation preserving closing tag
      const closeTag = '\n</main_conversation_digest>'
      xml = `${xml.slice(0, MAX_DIGEST_CHARS - closeTag.length - 1)}…${closeTag}`
    }
    return { digestXml: xml }
  }

  async inspectConversation(
    parentKey: string,
    params: InspectMainConversationParams,
    sessionRoots: readonly string[] = this.getSessionRoots()
  ): Promise<InspectConversationResult> {
    const view = await this.loadMergedView(parentKey, sessionRoots)
    const mode = params.view ?? 'turns'

    if (mode === 'plan') {
      const lines: string[] = [
        `Main conversation status: ${view.running ? 'running' : 'idle'} | mode: ${view.mode} | turns: ${view.turns.length}`
      ]
      if (view.goal) {
        lines.push(`Goal (${view.goal.status}): ${view.goal.text}`)
        if (view.goal.summary) lines.push(`Goal summary: ${view.goal.summary}`)
      }
      if (view.todos.length > 0) {
        const done = view.todos.filter((t) => t.status === 'done').length
        lines.push(`Todo list (${done}/${view.todos.length} done):`)
        for (const item of view.todos) {
          const mark = item.status === 'done' ? '[x]' : item.status === 'in_progress' ? '[in_progress]' : '[ ]'
          lines.push(`  - ${mark} ${item.text}`)
        }
      } else {
        lines.push('Todo list: (none recorded)')
      }
      if (view.pendingUiTitle) lines.push(`Pending user dialog: ${view.pendingUiTitle}`)
      if (view.lastError) lines.push(`Latest error: ${view.lastError}`)
      if (view.sessionChangedFiles.length > 0) {
        lines.push(`Files modified in this session (${view.sessionChangedFiles.length}): ${view.sessionChangedFiles.join(', ')}`)
      }
      return {
        text: clipText(lines.join('\n'), MAX_INSPECT_OUTPUT_CHARS),
        details: { view: 'plan', turnCount: view.turns.length, todoCount: view.todos.length }
      }
    }

    if (mode === 'tool') {
      const toolCallId = typeof params.toolCallId === 'string' ? params.toolCallId.trim() : ''
      if (!toolCallId) {
        return { text: 'Missing required parameter: toolCallId.', details: { view: 'tool', found: false } }
      }
      const tool = view.toolById.get(toolCallId)
      if (!tool) {
        return {
          text: `Tool call "${toolCallId}" was not found in the main conversation.`,
          details: { view: 'tool', found: false, toolCallId }
        }
      }
      const rawOutput = tool.finalOutput || tool.partialOutput || ''
      const allLines = rawOutput ? rawOutput.split(/\r?\n/) : []
      const offset = Math.max(0, Math.trunc(params.outputOffsetLines ?? 0))
      const pageLines = allLines.slice(offset, offset + TOOL_OUTPUT_LINES_PER_PAGE)
      const nextOffset = offset + pageLines.length < allLines.length ? offset + pageLines.length : undefined
      const header = [
        `Tool call: ${tool.toolCallId}`,
        `Name: ${tool.toolName} | Status: ${tool.status}${tool.durationMs !== undefined ? ` | Duration: ${tool.durationMs}ms` : ''} | Turn: ${tool.turnOrdinal}`,
        `Arguments: ${clipText(JSON.stringify(tool.args, null, 2), 4000)}`,
        `Output lines: ${allLines.length === 0 ? '0' : `${offset + 1}..${offset + pageLines.length} of ${allLines.length}`}`
      ].join('\n')
      const body = pageLines.join('\n')
      const continuation = nextOffset !== undefined
        ? `\n[More output available: pass outputOffsetLines=${nextOffset}]`
        : ''
      return {
        text: clipText(`${header}\n\n${body}${continuation}`, MAX_INSPECT_OUTPUT_CHARS),
        details: {
          view: 'tool',
          found: true,
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          status: tool.status,
          totalOutputLines: allLines.length,
          ...(nextOffset !== undefined ? { nextOutputOffsetLines: nextOffset } : {})
        }
      }
    }

    if (mode === 'search') {
      const query = typeof params.query === 'string' ? params.query.trim() : ''
      if (!query) {
        return { text: 'Missing required parameter: query.', details: { view: 'search', hits: 0 } }
      }
      const needle = query.toLowerCase()
      const hits: string[] = []
      for (const turn of view.turns) {
        if (turn.userText.toLowerCase().includes(needle)) {
          hits.push(`[Turn ${turn.ordinal} · user] ${snippetAround(turn.userText, needle)}`)
        }
        if (turn.assistantText.toLowerCase().includes(needle)) {
          hits.push(`[Turn ${turn.ordinal} · assistant] ${snippetAround(turn.assistantText, needle)}`)
        }
        for (const tool of turn.tools) {
          const hay = `${tool.toolName} ${JSON.stringify(tool.args)} ${tool.finalOutput || tool.partialOutput}`
          if (hay.toLowerCase().includes(needle)) {
            hits.push(`[Turn ${turn.ordinal} · tool ${tool.toolCallId} (${tool.toolName})] ${snippetAround(hay, needle)}`)
          }
        }
        if (hits.length >= 40) break
      }
      const text = hits.length > 0
        ? `Found ${hits.length} match(es) for "${query}" across ${view.turns.length} turn(s):\n\n${hits.join('\n')}`
        : `No matches found for "${query}" across ${view.turns.length} turn(s).`
      return {
        text: clipText(text, MAX_INSPECT_OUTPUT_CHARS),
        details: { view: 'search', query, hitCount: hits.length, totalTurns: view.turns.length }
      }
    }

    // Default: 'turns'
    const total = view.turns.length
    if (total === 0) {
      return {
        text: 'The main conversation has no turns yet.',
        details: { view: 'turns', totalTurns: 0, returnedTurns: 0 }
      }
    }
    const count = Math.min(15, Math.max(1, Math.trunc(params.turnCount ?? 5)))
    const fromEnd = params.fromEnd ?? (params.turnStart === undefined)
    let startIdx: number
    if (fromEnd) {
      startIdx = Math.max(0, total - count)
    } else {
      startIdx = Math.min(total - 1, Math.max(0, Math.trunc((params.turnStart ?? 1) - 1)))
    }
    const slice = view.turns.slice(startIdx, startIdx + count)
    const blocks: string[] = [
      `Main conversation turns ${slice[0]!.ordinal}..${slice[slice.length - 1]!.ordinal} of ${total} (${view.running ? 'LIVE RUNNING' : 'idle'}):`
    ]
    for (const turn of slice) {
      const statusTag = turn.streaming ? ' [LIVE STREAMING]' : ''
      const part: string[] = [`--- Turn ${turn.ordinal}${statusTag} ---`]
      if (turn.userText) part.push(`User:\n${clipText(turn.userText, 3000)}`)
      if (turn.assistantText) part.push(`Assistant:\n${clipText(turn.assistantText, 6000)}`)
      if (turn.errorMessage) part.push(`Error: ${turn.errorMessage}`)
      if (turn.tools.length > 0) {
        part.push('Tools:')
        for (const tool of turn.tools) {
          const argSummary = summarizeToolArgs(tool.toolName, tool.args)
          const preview = clipText(collapseSpaces(tool.finalOutput || tool.partialOutput), 160)
          part.push(
            `  - [${tool.status}] ${tool.toolName} (${tool.toolCallId})${argSummary ? ` ${argSummary}` : ''}${preview ? ` => ${preview}` : ''}`
          )
        }
      }
      blocks.push(part.join('\n'))
    }
    return {
      text: clipText(blocks.join('\n\n'), MAX_INSPECT_OUTPUT_CHARS),
      details: {
        view: 'turns',
        totalTurns: total,
        turnStart: slice[0]!.ordinal,
        turnEnd: slice[slice.length - 1]!.ordinal,
        running: view.running
      }
    }
  }
}

function formatReferenceLine(ref: SideChatReference): string {
  switch (ref.kind) {
    case 'selection':
      return `[selection (${ref.source}${ref.turnId ? ` · turn ${ref.turnId}` : ''})] ${clipText(collapseSpaces(ref.snippet), 240)}`
    case 'turn':
      return `[turn #${ref.turnOrdinal} (${ref.turnId})] ${clipText(collapseSpaces(ref.preview), 240)}`
    case 'tool':
      return `[tool ${ref.toolCallId}: ${ref.toolName} (${ref.status})] ${clipText(collapseSpaces(ref.summary), 200)}`
    case 'error':
      return `[error${ref.title ? `: ${ref.title}` : ''}] ${clipText(collapseSpaces(ref.message), 240)}`
    case 'file-diff': {
      const range = ref.lineRange ? `:${ref.lineRange.start}-${ref.lineRange.end}` : ''
      const snip = ref.snippet ? ` — ${clipText(collapseSpaces(ref.snippet), 180)}` : ''
      return `[file-diff ${ref.filePath}${range}]${snip}`
    }
  }
}

function snippetAround(text: string, needleLower: string): string {
  const idx = text.toLowerCase().indexOf(needleLower)
  if (idx < 0) return clipText(collapseSpaces(text), 180)
  const start = Math.max(0, idx - 60)
  const end = Math.min(text.length, idx + needleLower.length + 100)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${collapseSpaces(text.slice(start, end))}${suffix}`
}
