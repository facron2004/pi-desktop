/**
 * A failed `compact` RPC is not automatically a broken model connection.
 *
 * Pi answers with the same error response when it has nothing to summarise,
 * when the branch was just compacted, when the user cancelled and when the
 * provider really did fail. Replacing all of those with one guess hides the
 * reason, so the message is classified here and the detail survives into the
 * UI. `translate()` localises the English strings this module returns.
 */

export type CompactionFailure = {
  /** English UI text; `translate()` localises it. */
  message: string
  /** A benign outcome is a toast, not a thread-level error banner. */
  benign: boolean
}

export const COMPACTION_TIMEOUT_MESSAGE =
  'Context compaction timed out. Check the model connection and try again.'
export const COMPACTION_FAILED_MESSAGE =
  'Context compaction failed. Check the model connection and try again.'
export const COMPACTION_NO_HISTORY_MESSAGE = 'There is no earlier history to compress yet.'
export const COMPACTION_ALREADY_MESSAGE = 'This conversation has already been compressed.'
export const COMPACTION_CANCELLED_MESSAGE = 'Context compaction was cancelled.'

const TIMEOUT = /Timed out waiting for ["']compact["'] response/i
const NO_HISTORY = /Nothing to compact \(session too small\)/i
const ALREADY_COMPACTED = /Already compacted/i
const CANCELLED = /^Compaction (?:cancelled|aborted)$/i
/** Pi prefixes `compaction_end.errorMessage` before the underlying error. */
const FAILURE_PREFIX = /^(?:auto-)?compaction failed:\s*/i

const MAX_DETAIL_LENGTH = 240

/** One line, bounded: a provider can answer with a whole JSON payload. */
function detailOf(raw: string): string {
  const detail = raw.replace(FAILURE_PREFIX, '').replace(/\s+/g, ' ').trim()
  return detail.length > MAX_DETAIL_LENGTH ? `${detail.slice(0, MAX_DETAIL_LENGTH - 1)}…` : detail
}

export function describeCompactionFailure(raw: string): CompactionFailure {
  const text = raw.trim()
  if (TIMEOUT.test(text)) return { message: COMPACTION_TIMEOUT_MESSAGE, benign: false }
  const detail = detailOf(text)
  if (NO_HISTORY.test(detail)) return { message: COMPACTION_NO_HISTORY_MESSAGE, benign: true }
  if (ALREADY_COMPACTED.test(detail)) return { message: COMPACTION_ALREADY_MESSAGE, benign: true }
  if (CANCELLED.test(detail)) return { message: COMPACTION_CANCELLED_MESSAGE, benign: true }
  if (!detail) return { message: COMPACTION_FAILED_MESSAGE, benign: false }
  return { message: `Context compaction failed: ${detail}`, benign: false }
}
