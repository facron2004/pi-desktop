import type { SessionMeta } from '@shared/types'
import type { SessionThread } from '../store/useAppStore'
import { normalisePathKey } from './path'

/**
 * A conversation the reader can see in the sidebar, whether or not Pi has
 * written its JSONL file yet.
 *
 * `onDisk` is false for a conversation the store holds under a `draft:…` key,
 * or for one whose file Pi has assigned but not flushed. Those are real
 * conversations — a prompt is already in flight — and they must stay reachable
 * while they run, not appear only once the run settles.
 */
export interface ConversationRow extends SessionMeta {
  onDisk: boolean
}

/** The first prompt of a conversation, for the row's preview. */
function previewOf(thread: SessionThread): string {
  for (const item of thread.items) {
    if (item.kind === 'user' && item.text.trim()) return item.text.trim().replace(/\s+/g, ' ').slice(0, 120)
  }
  return ''
}

/** When the conversation last did something, for ordering. */
function activityOf(thread: SessionThread): number {
  let latest = 0
  for (const item of thread.items) {
    if (typeof item.timestamp === 'number' && item.timestamp > latest) latest = item.timestamp
  }
  return latest || thread.run.startedAt || 0
}

/**
 * Does this conversation hold work the reader would be upset to lose?
 *
 * An abandoned empty chat is not a conversation: it is the blank composer the
 * reader is looking at, and the welcome screen already stands for it. A prompt
 * that is still on its way to Pi has no items yet but is definitely work, so
 * the run state counts too.
 */
function hasWork(thread: SessionThread): boolean {
  if (thread.items.length > 0) return true
  if (thread.isStreaming) return true
  if (thread.queue.steering.length > 0 || thread.queue.followUp.length > 0) return true
  return thread.run.phase !== 'idle' && !thread.run.settled
}

/**
 * The sidebar's list: the conversations on disk, plus the ones the store
 * already knows about that disk does not cover yet.
 *
 * The sidebar is built from `sessions`, which is read from the session folder.
 * Pi only writes a JSONL once the first prompt reaches it, and the list is
 * re-read when a run settles — so a conversation that is just starting, or one
 * waiting behind another run in the same folder, is absent from the sidebar
 * for exactly the window in which the reader is looking for it. Two new
 * conversations created seconds apart both landed in that window and both
 * disappeared.
 *
 * A conversation that is on disk is listed once, from the disk row: those are
 * the rows with a name, a real timestamp and a stable file path. A live row
 * only exists for a key the disk list does not already cover, so the handover
 * from `draft:…` (or an unflushed path) to the disk row is a rename of the same
 * row, not a duplicate.
 */
const liveRowCache = new Map<string, ConversationRow>()

/**
 * Live conversations currently in memory that disk does not cover yet.
 * Returns stable object references when attributes are unchanged, preventing
 * spurious re-renders during active streaming.
 */
export function liveConversationRows(
  sessions: readonly SessionMeta[],
  threads: Readonly<Record<string, SessionThread>>,
  workspacePath: string | undefined
): ConversationRow[] {
  const onDisk = new Set(sessions.map((session) => normalisePathKey(session.file)))
  const live: ConversationRow[] = []
  const activeKeys = new Set<string>()

  for (const [key, thread] of Object.entries(threads)) {
    if (onDisk.has(normalisePathKey(key))) continue
    if (!hasWork(thread)) continue
    activeKeys.add(key)
    const draft = key.startsWith('draft:')
    const id = thread.piState?.sessionId ?? key
    const cwd = thread.status.cwd ?? (draft ? workspacePath ?? '' : '')
    const name = thread.piState?.sessionName
    const preview = previewOf(thread)
    const updatedAt = activityOf(thread)
    const messageCount = thread.items.filter((item) => item.kind === 'user' || item.kind === 'assistant').length
    const model = thread.piState?.model ? `${thread.piState.model.provider}/${thread.piState.model.id}` : undefined

    const cached = liveRowCache.get(key)
    if (
      cached &&
      cached.id === id &&
      cached.file === key &&
      cached.cwd === cwd &&
      cached.name === name &&
      cached.preview === preview &&
      cached.updatedAt === updatedAt &&
      cached.messageCount === messageCount &&
      cached.model === model
    ) {
      live.push(cached)
    } else {
      const nextRow: ConversationRow = {
        id,
        file: key,
        cwd,
        name,
        preview,
        updatedAt,
        messageCount,
        model,
        onDisk: false
      }
      liveRowCache.set(key, nextRow)
      live.push(nextRow)
    }
  }

  for (const key of liveRowCache.keys()) {
    if (!activeKeys.has(key)) liveRowCache.delete(key)
  }

  return live.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function conversationRows(
  sessions: readonly SessionMeta[],
  threads: Readonly<Record<string, SessionThread>>,
  workspacePath: string | undefined
): ConversationRow[] {
  const live = liveConversationRows(sessions, threads, workspacePath)
  const disk = sessions.map((session) => ({ ...session, onDisk: true }))
  return [...live, ...disk]
}
