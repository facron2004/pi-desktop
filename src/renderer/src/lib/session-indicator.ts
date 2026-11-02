/**
 * What a conversation row says about itself.
 *
 * MCode puts this in one place — `data-session-indicator` — and the row draws
 * a dot, a pill or nothing from it. Pi Desktop keeps the same vocabulary:
 *
 * - `needs-input` — a blocking dialog is waiting for the user
 * - `error`      — the last run failed
 * - `unread`     — the conversation finished while the reader was elsewhere
 * - `running`    — Pi is working on it
 * - `idle`       — nothing to say
 */
export type SessionNotice = 'error' | 'unread'

export type SessionIndicator =
  | 'error'
  | 'unread'
  | 'needs-input'
  | 'running'
  | 'idle'

export interface SessionIndicatorInput {
  /** True while Pi is producing events for this conversation. */
  isStreaming: boolean
  /** What the last background run left behind, until the user looks at it. */
  notice?: SessionNotice
  /** True while an extension dialog is blocking the agent. */
  needsInput?: boolean
}

/**
 * The one mark a conversation row carries.
 *
 * A waiting dialog outranks everything: the run cannot move on until the user
 * answers. A failure outranks an unread mark, because a conversation that
 * broke needs the user more than one that merely finished.
 */
export function sessionIndicator(input: SessionIndicatorInput): SessionIndicator {
  if (input.needsInput) return 'needs-input'
  if (input.notice === 'error') return 'error'
  if (input.notice === 'unread') return 'unread'
  if (input.isStreaming) return 'running'
  return 'idle'
}

/** True when the mark is a dot the reader has to notice. */
export function isDotIndicator(indicator: SessionIndicator): boolean {
  return indicator === 'error' || indicator === 'unread'
}
