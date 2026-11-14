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
export const COMPACTION_EXTENSION_MANAGED_MESSAGE =
  'Context compaction is managed by an installed extension. Ask Pi to compress the conversation, or use the extension\'s own command (e.g. /acp).'

/**
 * True when a live process has registered the commands of an extension that
 * owns context compaction.
 *
 * Billion-Context (`billion-context-pi`) answers Pi's `session_before_compact`
 * with `{ cancel: true }`, so a native `compact` command can only ever come
 * back as "Compaction cancelled" — by design: the extension is the context
 * manager. It registers `/acp` (and `/acp-*`) commands; their presence on the
 * process is the honest signal that compacting through Pi would be vetoed.
 * The command list is what `get_commands` reported, so the check follows the
 * live process rather than guessing from installed packages: an extension
 * that failed to load does not own anything.
 */
export function compactionOwnedByExtension(
  commands: readonly { name: string; source?: string }[] | undefined
): boolean {
  return Boolean(
    commands?.some(
      (command) =>
        command.source !== 'app' && (command.name === 'acp' || command.name.startsWith('acp-'))
    )
  )
}

const TIMEOUT = /Timed out waiting for ["']compact["'] response/i
const NO_HISTORY = /Nothing to compact \(session too small\)/i
const ALREADY_COMPACTED = /Already compacted/i
const CANCELLED = /^Compaction (?:cancelled|aborted)\b/i
/** Pi prefixes `compaction_end.errorMessage` before the underlying error. */
const FAILURE_PREFIX = /^(?:auto-)?compaction failed:\s*/i
/**
 * Electron's `ipcRenderer.invoke` rejection prefix. A failed `compact` RPC
 * reaches the renderer as
 * `Error invoking remote method 'runtime:request': Error: Compaction cancelled`
 * while the same reason arrives bare from a Pi event. The classifier has to
 * read the reason, not the channel it travelled through.
 */
const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*/i
const ERROR_PREFIX = /^Error:\s*/i

const MAX_DETAIL_LENGTH = 240

/** Peel transport wrappers until the message stops changing. */
function unwrapTransport(raw: string): string {
  let text = raw.trim()
  for (let pass = 0; pass < 4; pass += 1) {
    const next = text.replace(IPC_PREFIX, '').replace(ERROR_PREFIX, '').trim()
    if (next === text) break
    text = next
  }
  return text
}

/** One line, bounded: a provider can answer with a whole JSON payload. */
function detailOf(raw: string): string {
  const detail = raw.replace(FAILURE_PREFIX, '').replace(/\s+/g, ' ').trim()
  return detail.length > MAX_DETAIL_LENGTH ? `${detail.slice(0, MAX_DETAIL_LENGTH - 1)}…` : detail
}

export function describeCompactionFailure(raw: string): CompactionFailure {
  const text = unwrapTransport(raw)
  if (TIMEOUT.test(text)) return { message: COMPACTION_TIMEOUT_MESSAGE, benign: false }
  const detail = detailOf(text)
  if (NO_HISTORY.test(detail)) return { message: COMPACTION_NO_HISTORY_MESSAGE, benign: true }
  if (ALREADY_COMPACTED.test(detail)) return { message: COMPACTION_ALREADY_MESSAGE, benign: true }
  if (CANCELLED.test(detail)) return { message: COMPACTION_CANCELLED_MESSAGE, benign: true }
  if (!detail) return { message: COMPACTION_FAILED_MESSAGE, benign: false }
  return { message: `Context compaction failed: ${detail}`, benign: false }
}
