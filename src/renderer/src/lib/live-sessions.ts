import type { SessionMeta } from '@shared/types'
import type { SessionThread } from '../store/useAppStore'
import { normalisePathKey } from './path'
import { changedThreadItemsFrom, type ThreadItem } from './thread'

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
export function conversationPreview(thread: SessionThread): string {
  for (const item of thread.items) {
    if (item.kind === 'user' && item.text.trim()) return item.text.trim().replace(/\s+/g, ' ').slice(0, 120)
  }
  return ''
}

interface LiveThreadSummary {
  items: ThreadItem[]
  preview: string
  latestTimestamp: number
  messageCount: number
}

interface LiveRowCacheEntry {
  row: ConversationRow
  summary: LiveThreadSummary
}

/** Summaries belong to a transcript snapshot; append-only changes update them from the tail. */
function summarizeThread(items: ThreadItem[], previous?: LiveThreadSummary): LiveThreadSummary {
  if (previous?.items === items) return previous

  if (
    previous &&
    items.length >= previous.items.length &&
    changedThreadItemsFrom(items, previous.items) !== undefined
  ) {
    // Reducer replacements preserve kind and timestamp; only the appended tail changes these totals.
    let { preview, latestTimestamp, messageCount } = previous
    for (let index = previous.items.length; index < items.length; index += 1) {
      const item = items[index]
      if (!item) continue
      if (typeof item.timestamp === 'number' && item.timestamp > latestTimestamp) {
        latestTimestamp = item.timestamp
      }
      if (item.kind === 'user' || item.kind === 'assistant') messageCount += 1
      if (!preview && item.kind === 'user' && item.text.trim()) {
        preview = item.text.trim().replace(/\s+/g, ' ').slice(0, 120)
      }
    }
    return { items, preview, latestTimestamp, messageCount }
  }

  let preview = ''
  let latestTimestamp = 0
  let messageCount = 0
  for (const item of items) {
    if (typeof item.timestamp === 'number' && item.timestamp > latestTimestamp) {
      latestTimestamp = item.timestamp
    }
    if (item.kind === 'user' || item.kind === 'assistant') {
      messageCount += 1
      if (!preview && item.kind === 'user' && item.text.trim()) {
        preview = item.text.trim().replace(/\s+/g, ' ').slice(0, 120)
      }
    }
  }
  return { items, preview, latestTimestamp, messageCount }
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
const liveRowCache = new Map<string, LiveRowCacheEntry>()
const sessionPathCache = new WeakMap<readonly SessionMeta[], Map<string, SessionMeta>>()

function sessionsByPath(sessions: readonly SessionMeta[]): Map<string, SessionMeta> {
  const cached = sessionPathCache.get(sessions)
  if (cached) return cached
  const byPath = new Map<string, SessionMeta>()
  for (const session of sessions) {
    const key = normalisePathKey(session.file)
    if (!byPath.has(key)) byPath.set(key, session)
  }
  sessionPathCache.set(sessions, byPath)
  return byPath
}

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
  const onDisk = sessionsByPath(sessions)
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
    const cached = liveRowCache.get(key)
    const summary = summarizeThread(thread.items, cached?.summary)
    const preview = summary.preview
    const updatedAt = summary.latestTimestamp || thread.run.startedAt || 0
    const messageCount = summary.messageCount
    const model = thread.piState?.model ? `${thread.piState.model.provider}/${thread.piState.model.id}` : undefined

    if (
      cached?.row.id === id &&
      cached.row.file === key &&
      cached.row.cwd === cwd &&
      cached.row.name === name &&
      cached.row.preview === preview &&
      cached.row.updatedAt === updatedAt &&
      cached.row.messageCount === messageCount &&
      cached.row.model === model
    ) {
      liveRowCache.set(key, { row: cached.row, summary })
      live.push(cached.row)
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
      liveRowCache.set(key, { row: nextRow, summary })
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

/** Project paths with active conversations, using the cached session path index. */
export function streamingProjectPaths(
  sessions: readonly SessionMeta[],
  threads: Readonly<Record<string, SessionThread>>,
  draftId: string | undefined,
  workspacePath: string | undefined
): string[] {
  const byPath = sessionsByPath(sessions)
  const paths: string[] = []
  for (const [file, thread] of Object.entries(threads)) {
    if (!thread.isStreaming) continue
    const cwd =
      thread.status.cwd ||
      byPath.get(normalisePathKey(file))?.cwd ||
      (file === draftId ? workspacePath : undefined)
    if (cwd) paths.push(normalisePathKey(cwd))
  }
  return paths
}

/**
 * The name the title bar shows for the conversation on screen.
 *
 * The sidebar draws a row from disk sessions plus live threads, so a chat Pi
 * has not flushed to the session folder yet still has a name there. The title
 * bar used to read only `sessions`, which made it fall back to the project name
 * for exactly that window — the two places then disagreed. Resolve the active
 * row the same way the sidebar does, including Pi's own name on a live thread
 * (a hot `set_session_name` can precede the disk list).
 */
export function activeConversationTitle(
  sessions: readonly SessionMeta[],
  threads: Readonly<Record<string, SessionThread>>,
  activeKey: string | undefined
): string {
  if (!activeKey) return ''
  const key = normalisePathKey(activeKey)
  const disk = sessionsByPath(sessions).get(key)
  if (disk) return disk.name || disk.preview || ''
  const activeThread = threads[activeKey]
  if (activeThread) {
    if (!hasWork(activeThread)) return ''
    return activeThread.piState?.sessionName || conversationPreview(activeThread) || ''
  }
  for (const [threadKey, thread] of Object.entries(threads)) {
    if (normalisePathKey(threadKey) !== key) continue
    if (!hasWork(thread)) return ''
    return thread.piState?.sessionName || conversationPreview(thread) || ''
  }
  return ''
}

/** Update a cached conversation's Pi name even when that conversation is in the background. */
export function updateThreadSessionName(
  threads: Record<string, SessionThread>,
  file: string,
  name: string
): Record<string, SessionThread> {
  const key = normalisePathKey(file)
  let next: Record<string, SessionThread> | undefined
  for (const [threadKey, thread] of Object.entries(threads)) {
    if (normalisePathKey(threadKey) !== key || !thread.piState || thread.piState.sessionName === name) continue
    next ??= { ...threads }
    next[threadKey] = {
      ...thread,
      piState: { ...thread.piState, sessionName: name },
      version: thread.version + 1
    }
  }
  return next ?? threads
}
