import type { SessionNotice } from './session-indicator'

/**
 * The unread/failed marks that outlive the in-memory thread.
 *
 * A thread's `notice` only exists while the renderer has that conversation in
 * memory; restarting the app used to forget that a background or scheduled run
 * had finished unseen. The sidebar reads this persisted copy until the reader
 * opens the conversation, which is what clears it.
 */
export const SESSION_NOTICES_STORAGE_KEY = 'pi-desktop.session-notices.v1'

const MAX_NOTICES = 500
const MAX_FILE_CHARS = 4096

type NoticeStorage = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): NoticeStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage
}

export function loadSessionNotices(
  storage = browserStorage()
): Record<string, SessionNotice> {
  if (!storage) return {}
  try {
    const raw = storage.getItem(SESSION_NOTICES_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, SessionNotice] =>
        Boolean(entry[0]) &&
        entry[0].length <= MAX_FILE_CHARS &&
        !entry[0].startsWith('draft:') &&
        (entry[1] === 'unread' || entry[1] === 'error')
      )
    return Object.fromEntries(entries.slice(-MAX_NOTICES))
  } catch {
    return {}
  }
}

export function saveSessionNotices(
  notices: Record<string, SessionNotice>,
  storage = browserStorage()
): void {
  if (!storage) return
  try {
    storage.setItem(SESSION_NOTICES_STORAGE_KEY, JSON.stringify(notices))
  } catch {
    // A full quota loses the reminder, never the conversation itself.
  }
}
