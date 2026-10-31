/**
 * Normalized conversation-stream events.
 *
 * Pi's session events are wire records: their names describe the transport
 * (`message_update`, `tool_execution_start`) and the identity of the thing
 * they describe is spread across unrelated fields. Every consumer would have
 * to learn that shape again, so this module is the one place that turns a
 * raw `PiEvent` into a typed `StreamEvent` with the client-side identity
 * attached.
 *
 * The adapter is stateful only for identity: a sequence per thread, the
 * current message id, and the tool-call ids announced inside a message.
 * Sequence numbers are monotonic per thread, which lets a consumer prove
 * ordering without touching the item `order` counter (that one is a visual
 * sort key, not an event clock).
 *
 * `source` is kept on every normalized event, unchanged. Nothing in the
 * protocol is invented here: when Pi has no id, the adapter mints one.
 */
import type {
  AgentMessage,
  ExtensionUiRequest,
  ExtensionUiResponse,
  PiEvent
} from '@shared/types'
import { isRateLimitError } from './provider-error'

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/**
 * The run/turn context an event belongs to.
 *
 * Pi's protocol has no run or turn id, so the client mints them: one run per
 * `agent_start` and one turn per `turn_start`. `sessionKey` is the thread the
 * events belong to (the session file, or a draft id).
 */
export interface StreamContext {
  /** Session file the events belong to; events from another one are dropped. */
  sessionKey: string
  runId?: string
  turnId?: string
}

export type StreamEventStatus =
  | 'pending'
  | 'streaming'
  | 'proposed'
  | 'running'
  | 'working'
  | 'retrying'
  | 'compacting'
  | 'waiting_approval'
  | 'completed'
  | 'ok'
  | 'error'
  | 'aborted'

export type StreamNoticeLevel = 'info' | 'warn' | 'error' | 'success'

export type StreamBlockType = 'text' | 'thinking' | 'toolCall'

export interface StreamEventBase {
  threadId: string
  runId?: string
  turnId?: string
  /** Monotonic per thread; every normalized event consumes exactly one number. */
  sequence: number
  messageId?: string
  toolCallId?: string
  status?: StreamEventStatus
  /** The original Pi record, unmodified. */
  source: PiEvent
}

/* ------------------------------------------------------------------ *
 * Message events
 * ------------------------------------------------------------------ */

export interface MessageStartedStreamEvent extends StreamEventBase {
  type: 'message.started'
  role?: string
  message?: AgentMessage
}

export interface MessageBlockStartedStreamEvent extends StreamEventBase {
  type: 'message.block.started'
  blockType: StreamBlockType
  contentIndex?: number
  toolName?: string
}

export interface MessageDeltaStreamEvent extends StreamEventBase {
  type: 'message.delta'
  blockType: 'text' | 'thinking'
  contentIndex?: number
  delta: string
}

export interface MessageBlockCompletedStreamEvent extends StreamEventBase {
  type: 'message.block.completed'
  blockType: 'text' | 'thinking'
  contentIndex?: number
  content?: string
}

export interface MessageCompletedStreamEvent extends StreamEventBase {
  type: 'message.completed'
  role?: string
  message?: AgentMessage
}

/* ------------------------------------------------------------------ *
 * Tool events
 * ------------------------------------------------------------------ */

export interface ToolProposedStreamEvent extends StreamEventBase {
  type: 'tool.proposed'
  toolName: string
  contentIndex?: number
}

export interface ToolArgsStreamEvent extends StreamEventBase {
  type: 'tool.args'
  toolName?: string
  contentIndex?: number
  /** Streamed argument fragment (`toolcall_delta`). */
  delta?: string
  /** Complete arguments (`toolcall_end`). */
  args?: Record<string, unknown>
  complete: boolean
}

export interface ToolStartedStreamEvent extends StreamEventBase {
  type: 'tool.started'
  toolName?: string
  args: Record<string, unknown>
}

export interface ToolOutputDeltaStreamEvent extends StreamEventBase {
  type: 'tool.output.delta'
  toolName?: string
  args?: Record<string, unknown>
  partialResult?: unknown
}

export interface ToolFinishedStreamEvent extends StreamEventBase {
  type: 'tool.finished'
  toolName?: string
  args?: Record<string, unknown>
  result?: unknown
  isError: boolean
  durationMs?: number
}

/* ------------------------------------------------------------------ *
 * Run events
 * ------------------------------------------------------------------ */

export interface RunStartedStreamEvent extends StreamEventBase {
  type: 'run.started'
}

export interface RunTurnStartedStreamEvent extends StreamEventBase {
  type: 'run.turn.started'
}

export interface RunStatusStreamEvent extends StreamEventBase {
  type: 'run.status'
  phase?: 'working' | 'retrying' | 'compacting'
  willRetry?: boolean
}

export interface RunFinishedStreamEvent extends StreamEventBase {
  type: 'run.finished'
  aborted: boolean
}

/* ------------------------------------------------------------------ *
 * Extension UI events
 * ------------------------------------------------------------------ */

export interface ApprovalRequestedStreamEvent extends StreamEventBase {
  type: 'approval.requested'
  request: ExtensionUiRequest
  /** True for the four blocking dialog methods; false for fire-and-forget. */
  dialog: boolean
}

export interface ApprovalResolvedStreamEvent extends StreamEventBase {
  type: 'approval.resolved'
  requestId: string
  response?: ExtensionUiResponse
}

/* ------------------------------------------------------------------ *
 * Command output, notices and errors
 * ------------------------------------------------------------------ */

export interface CommandOutputDeltaStreamEvent extends StreamEventBase {
  type: 'command.output.delta'
  commandId?: string
  delta: string
}

export interface NoticeStreamEvent extends StreamEventBase {
  type: 'notice'
  level: StreamNoticeLevel
  text: string
  /** Retry results are tagged so the transcript can style them. */
  noticeSource?: 'retry'
}

export interface ErrorStreamEvent extends StreamEventBase {
  type: 'error'
  text: string
  detail?: string
}

export interface UnknownStreamEvent extends StreamEventBase {
  type: 'unknown'
  sourceType: string
}

export type StreamEvent =
  | MessageStartedStreamEvent
  | MessageBlockStartedStreamEvent
  | MessageDeltaStreamEvent
  | MessageBlockCompletedStreamEvent
  | MessageCompletedStreamEvent
  | ToolProposedStreamEvent
  | ToolArgsStreamEvent
  | ToolStartedStreamEvent
  | ToolOutputDeltaStreamEvent
  | ToolFinishedStreamEvent
  | RunStartedStreamEvent
  | RunTurnStartedStreamEvent
  | RunStatusStreamEvent
  | RunFinishedStreamEvent
  | ApprovalRequestedStreamEvent
  | ApprovalResolvedStreamEvent
  | CommandOutputDeltaStreamEvent
  | NoticeStreamEvent
  | ErrorStreamEvent
  | UnknownStreamEvent

/* ------------------------------------------------------------------ *
 * Per-thread identity state
 * ------------------------------------------------------------------ */

interface ThreadStreamState {
  sequence: number
  /** The message currently streaming, so its updates share one id. */
  messageId?: string
  /** Role and open state of that message, so a repeated start reuses its id. */
  messageRole?: string
  messageOpen?: boolean
  /** `toolcall_start` announced a call at a content index; deltas follow it. */
  toolCallByIndex: Map<number, string>
  toolNameByIndex: Map<number, string>
  /** Which message proposed a tool call, for the execution events that follow. */
  messageByToolCall: Map<string, string>
}

const threadStates = new Map<string, ThreadStreamState>()

function stateFor(threadId: string): ThreadStreamState {
  let state = threadStates.get(threadId)
  if (!state) {
    state = {
      sequence: 0,
      toolCallByIndex: new Map(),
      toolNameByIndex: new Map(),
      messageByToolCall: new Map()
    }
    threadStates.set(threadId, state)
  }
  return state
}

let idCounter = 0

/** An id that is unique within the process (Date.now alone can collide). */
function mintId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

/**
 * Forget the identity state of one thread, or of every thread.
 *
 * A test starts from a clean clock; a real session does not, because the
 * sequence has to stay monotonic when a conversation comes back on screen.
 */
export function resetStreamState(threadId?: string): void {
  if (threadId === undefined) threadStates.clear()
  else threadStates.delete(threadId)
}

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */

/** The `message_update` payload Pi wraps around a stream event. */
interface AssistantMessageEventPayload {
  type: string
  contentIndex?: number
  delta?: string
  content?: string
  id?: string
  toolName?: string
  reason?: string
  error?: { message?: string } | string
  message?: AgentMessage
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> }
}

const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor'])

function messageOf(event: PiEvent): AgentMessage | undefined {
  const message = event.message
  if (!message || typeof message !== 'object') return undefined
  return message as AgentMessage
}

function argsOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function statusOfMessage(message: AgentMessage | undefined): StreamEventStatus {
  if (!message) return 'completed'
  if (message.errorMessage) return 'error'
  if (message.stopReason === 'aborted') return 'aborted'
  return 'completed'
}

function noticeTextForRetryStart(event: PiEvent): string {
  const raw = String(event.errorMessage ?? 'transient error')
  const wait = Math.max(1, Math.round(Number(event.delayMs ?? 0) / 1000))
  // A rate-limit payload is a page of JSON. The transcript only needs to
  // say that the turn is waiting, not paste the provider body in.
  const detail = isRateLimitError(raw)
    ? `rate limit, next try in ${wait}s`
    : raw.replace(/\s+/g, ' ').trim().slice(0, 180)
  return `Retrying (attempt ${String(event.attempt ?? 1)}/${String(event.maxAttempts ?? '?')}) — ${detail}`
}

function noticeTextForCompactionEnd(event: PiEvent): { level: StreamNoticeLevel; text: string } {
  if (Boolean(event.aborted)) return { level: 'warn', text: 'Compaction aborted' }
  if (event.errorMessage) {
    return { level: 'error', text: `Compaction failed: ${String(event.errorMessage)}` }
  }
  const result = event.result as { tokensBefore?: number; estimatedTokensAfter?: number } | undefined
  const before = result?.tokensBefore
  const after = result?.estimatedTokensAfter
  const detail = before && after ? ` (${before} → ~${after} tokens)` : ''
  return { level: 'success', text: `Context compacted${detail}` }
}

/** A new run or turn starts a fresh message sequence. */
function resetMessageState(state: ThreadStreamState): void {
  state.messageId = undefined
  state.messageRole = undefined
  state.messageOpen = false
  state.toolCallByIndex.clear()
  state.toolNameByIndex.clear()
}

/**
 * Tell the adapter that a new run/turn started.
 *
 * The store handles `agent_start` / `turn_start` itself (run state), so those
 * records do not pass through `normalizePiEvent`. Without this reset a stale
 * open message from the previous run would make the first `message_start`
 * of the new run look like a duplicate.
 */
export function beginStream(threadId?: string): void {
  resetMessageState(stateFor(threadId ?? ''))
}

/**
 * Turn one Pi wire event into a normalized `StreamEvent`.
 *
 * Returns `null` when the record carries no usable event — a `message_update`
 * without an assistant message event, or a tool-execution record without a
 * call id. Those are the cases the reducer dropped without changing the
 * thread, so dropping them here keeps the projection identical.
 */
export function normalizePiEvent(
  event: PiEvent,
  context?: StreamContext
): StreamEvent | null {
  const threadId = context?.sessionKey ?? ''
  const state = stateFor(threadId)
  const next = (): number => {
    state.sequence += 1
    return state.sequence
  }
  const base = (sequence: number): Omit<StreamEventBase, 'type'> => ({
    threadId,
    runId: context?.runId,
    turnId: context?.turnId,
    sequence,
    source: event
  })

  switch (event.type) {
    /* -------------------------- agent / turn -------------------------- */
    case 'agent_start': {
      resetMessageState(state)
      return { ...base(next()), type: 'run.started', status: 'working' }
    }
    case 'turn_start': {
      resetMessageState(state)
      return { ...base(next()), type: 'run.turn.started', status: 'working' }
    }
    case 'turn_end': {
      return { ...base(next()), type: 'run.status', phase: 'working', status: 'working' }
    }
    case 'agent_end': {
      return {
        ...base(next()),
        type: 'run.status',
        phase: 'working',
        status: 'working',
        willRetry: Boolean(event.willRetry)
      }
    }
    case 'agent_settled': {
      const aborted = Boolean(event.aborted)
      return {
        ...base(next()),
        type: 'run.finished',
        aborted,
        status: aborted ? 'aborted' : 'completed'
      }
    }

    /* ---------------------------- messages ---------------------------- */
    case 'message_start': {
      const message = messageOf(event)
      const role = typeof message?.role === 'string' ? message.role : undefined
      // A repeated start for the message that is already open is a replay,
      // not a second message: reuse the id so the projection can dedupe it.
      const continuing = Boolean(state.messageOpen && state.messageId && state.messageRole === role)
      const messageId = continuing ? (state.messageId as string) : mintId('message')
      if (!continuing) {
        state.messageId = messageId
        state.messageRole = role
        state.messageOpen = true
        state.toolCallByIndex.clear()
        state.toolNameByIndex.clear()
      }
      return {
        ...base(next()),
        type: 'message.started',
        messageId,
        role,
        message,
        status: role === 'assistant' ? 'streaming' : 'completed'
      }
    }

    case 'message_update': {
      const payload = event.assistantMessageEvent as AssistantMessageEventPayload | undefined
      if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') return null
      const messageId = state.messageId ?? mintId('message')
      state.messageId = messageId
      const contentIndex =
        typeof payload.contentIndex === 'number' ? payload.contentIndex : undefined

      switch (payload.type) {
        case 'text_start':
        case 'thinking_start': {
          const blockType = payload.type === 'text_start' ? 'text' : 'thinking'
          return {
            ...base(next()),
            type: 'message.block.started',
            messageId,
            blockType,
            contentIndex,
            status: 'streaming'
          }
        }
        case 'text_delta':
        case 'thinking_delta': {
          const blockType = payload.type === 'text_delta' ? 'text' : 'thinking'
          return {
            ...base(next()),
            type: 'message.delta',
            messageId,
            blockType,
            contentIndex,
            delta: payload.delta ?? '',
            status: 'streaming'
          }
        }
        case 'text_end':
        case 'thinking_end': {
          const blockType = payload.type === 'text_end' ? 'text' : 'thinking'
          return {
            ...base(next()),
            type: 'message.block.completed',
            messageId,
            blockType,
            contentIndex,
            content: payload.content,
            status: 'completed'
          }
        }
        case 'toolcall_start': {
          const toolCallId =
            typeof payload.id === 'string' && payload.id ? payload.id : mintId('call')
          const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'tool'
          if (contentIndex !== undefined) {
            state.toolCallByIndex.set(contentIndex, toolCallId)
            state.toolNameByIndex.set(contentIndex, toolName)
          }
          state.messageByToolCall.set(toolCallId, messageId)
          return {
            ...base(next()),
            type: 'tool.proposed',
            messageId,
            toolCallId,
            toolName,
            contentIndex,
            status: 'proposed'
          }
        }
        case 'toolcall_delta': {
          let toolCallId =
            contentIndex !== undefined ? state.toolCallByIndex.get(contentIndex) : undefined
          if (!toolCallId) {
            toolCallId = mintId('call')
            if (contentIndex !== undefined) state.toolCallByIndex.set(contentIndex, toolCallId)
          }
          state.messageByToolCall.set(toolCallId, messageId)
          return {
            ...base(next()),
            type: 'tool.args',
            messageId,
            toolCallId,
            toolName: contentIndex !== undefined ? state.toolNameByIndex.get(contentIndex) : undefined,
            contentIndex,
            delta: payload.delta ?? '',
            complete: false,
            status: 'proposed'
          }
        }
        case 'toolcall_end': {
          const call = payload.toolCall
          const toolCallId =
            call?.id ??
            (contentIndex !== undefined ? state.toolCallByIndex.get(contentIndex) : undefined) ??
            mintId('call')
          const toolName =
            call?.name ??
            (contentIndex !== undefined ? state.toolNameByIndex.get(contentIndex) : undefined) ??
            'tool'
          if (contentIndex !== undefined) {
            state.toolCallByIndex.set(contentIndex, toolCallId)
            state.toolNameByIndex.set(contentIndex, toolName)
          }
          state.messageByToolCall.set(toolCallId, messageId)
          return {
            ...base(next()),
            type: 'tool.args',
            messageId,
            toolCallId,
            toolName,
            contentIndex,
            args: call?.arguments ?? {},
            complete: true,
            status: 'proposed'
          }
        }
        case 'start': {
          // The normal agent loop turns this provider-level event into
          // `message_start`; it is admitted only for raw SDK consumers.
          return {
            ...base(next()),
            type: 'message.started',
            messageId,
            role: 'assistant',
            status: 'streaming'
          }
        }
        case 'done': {
          return {
            ...base(next()),
            type: 'message.completed',
            messageId,
            role: 'assistant',
            message: payload.message,
            status: 'completed'
          }
        }
        default: {
          // Provider-level `error` and any future sub-type: the normal loop
          // reports the failure as `message_end` / `extension_error`, and the
          // old reducer changed nothing for these, so neither do we.
          return {
            ...base(next()),
            type: 'unknown',
            messageId,
            sourceType: `message_update:${payload.type}`
          }
        }
      }
    }

    case 'message_end': {
      const message = messageOf(event)
      const role = typeof message?.role === 'string' ? message.role : undefined
      const messageId = state.messageId ?? mintId('message')
      if (role === 'assistant' || state.messageId === messageId) {
        state.messageId = undefined
        state.messageRole = undefined
        state.messageOpen = false
        state.toolCallByIndex.clear()
        state.toolNameByIndex.clear()
      }
      return {
        ...base(next()),
        type: 'message.completed',
        messageId,
        role,
        message,
        status: statusOfMessage(message)
      }
    }

    /* ---------------------------- tools ------------------------------ */
    case 'tool_execution_start': {
      const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : ''
      if (!toolCallId) return null
      return {
        ...base(next()),
        type: 'tool.started',
        toolCallId,
        toolName: typeof event.toolName === 'string' ? event.toolName : undefined,
        args: argsOf(event.args),
        messageId: state.messageByToolCall.get(toolCallId),
        status: 'running'
      }
    }
    case 'tool_execution_update': {
      const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : ''
      if (!toolCallId) return null
      return {
        ...base(next()),
        type: 'tool.output.delta',
        toolCallId,
        toolName: typeof event.toolName === 'string' ? event.toolName : undefined,
        args: event.args === undefined ? undefined : argsOf(event.args),
        partialResult: event.partialResult,
        messageId: state.messageByToolCall.get(toolCallId),
        status: 'running'
      }
    }
    case 'tool_execution_end': {
      const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : ''
      if (!toolCallId) return null
      const isError = Boolean(event.isError)
      return {
        ...base(next()),
        type: 'tool.finished',
        toolCallId,
        toolName: typeof event.toolName === 'string' ? event.toolName : undefined,
        args: event.args === undefined ? undefined : argsOf(event.args),
        result: event.result,
        isError,
        durationMs: typeof event.durationMs === 'number' ? event.durationMs : undefined,
        messageId: state.messageByToolCall.get(toolCallId),
        status: isError ? 'error' : 'ok'
      }
    }

    /* --------------------------- commands ---------------------------- */
    case 'bash_execution_update': {
      return {
        ...base(next()),
        type: 'command.output.delta',
        commandId: typeof event.id === 'string' ? event.id : undefined,
        delta: String(event.delta ?? ''),
        status: 'running'
      }
    }

    /* ------------------------ notices / errors ------------------------ */
    case 'compaction_start': {
      const reason = String(event.reason ?? 'manual')
      return {
        ...base(next()),
        type: 'notice',
        level: 'info',
        text: `Compacting context (${reason})…`,
        status: 'compacting'
      }
    }
    case 'compaction_end': {
      const { level, text } = noticeTextForCompactionEnd(event)
      return {
        ...base(next()),
        type: 'notice',
        level,
        text,
        status: Boolean(event.aborted) ? 'aborted' : 'working'
      }
    }
    case 'auto_retry_start': {
      return {
        ...base(next()),
        type: 'notice',
        level: 'warn',
        text: noticeTextForRetryStart(event),
        status: 'retrying'
      }
    }
    case 'auto_retry_end': {
      if (event.success) {
        return {
          ...base(next()),
          type: 'notice',
          level: 'success',
          text: 'Retry succeeded',
          noticeSource: 'retry',
          status: 'working'
        }
      }
      const raw = String(event.finalError ?? 'unknown error')
      const text =
        raw === 'Retry cancelled'
          ? 'Retry cancelled'
          : `Retry failed: ${
              isRateLimitError(raw)
                ? 'still rate limited'
                : raw.replace(/\s+/g, ' ').trim().slice(0, 180)
            }`
      return {
        ...base(next()),
        type: 'notice',
        level: raw === 'Retry cancelled' ? 'warn' : 'error',
        text,
        noticeSource: 'retry',
        status: raw === 'Retry cancelled' ? 'aborted' : 'error'
      }
    }
    case 'extension_error': {
      return {
        ...base(next()),
        type: 'error',
        text: `Extension error: ${String(event.error ?? '')}`,
        detail: typeof event.error === 'string' ? event.error : undefined,
        status: 'error'
      }
    }
    case 'client_notice': {
      const level =
        typeof event.level === 'string' ? (event.level as StreamNoticeLevel) : 'warn'
      return {
        ...base(next()),
        type: 'notice',
        level,
        text: String(event.text ?? '')
      }
    }

    /* ------------------------- extension UI -------------------------- */
    case 'extension_ui_request': {
      const request = event as unknown as ExtensionUiRequest
      const dialog = DIALOG_METHODS.has(String(request.method ?? ''))
      return {
        ...base(next()),
        type: 'approval.requested',
        request,
        dialog,
        status: dialog ? 'waiting_approval' : undefined
      }
    }
    case 'extension_ui_response': {
      // The answer the client sends back. It is not a Pi session event, but
      // normalizing both directions lets a consumer follow one approval from
      // request to resolution without keeping a second event shape.
      const response: ExtensionUiResponse = {}
      if (typeof event.value === 'string') response.value = event.value
      if (typeof event.confirmed === 'boolean') response.confirmed = event.confirmed
      if (typeof event.cancelled === 'boolean') response.cancelled = event.cancelled
      return {
        ...base(next()),
        type: 'approval.resolved',
        requestId: String(event.id ?? ''),
        response,
        status: 'working'
      }
    }

    default: {
      return {
        ...base(next()),
        type: 'unknown',
        sourceType: String(event.type ?? '')
      }
    }
  }
}
