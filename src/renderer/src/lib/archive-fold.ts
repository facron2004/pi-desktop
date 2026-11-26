/**
 * Fold state for the project groups in Settings → Archived conversations.
 *
 * The rows themselves are a projection of the session index; which project
 * groups are open is a view preference, so it lives in localStorage and is
 * never written back to the session or the workspace settings.
 */

const COLLAPSED_KEY = 'pi-desktop.archive.collapsed'

/** Tests hand in their own store; in the app this is window.localStorage. */
type StringStore = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function storeOrDefault(store?: StringStore): StringStore | null {
  if (store) return store
  if (typeof localStorage === 'undefined') return null
  return localStorage
}

export function readCollapsedArchiveGroups(store?: StringStore): Set<string> {
  const source = storeOrDefault(store)
  if (!source) return new Set()
  try {
    const raw = source.getItem(COLLAPSED_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((key): key is string => typeof key === 'string'))
  } catch {
    // Unreadable storage is the same as no fold preference at all.
    return new Set()
  }
}

export function writeCollapsedArchiveGroups(collapsed: Iterable<string>, store?: StringStore): void {
  const target = storeOrDefault(store)
  if (!target) return
  try {
    target.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]))
  } catch {
    // A full or disabled storage must not break the settings page.
  }
}

/** Toggle one group without mutating the caller's set. */
export function toggleCollapsedArchiveGroup(current: Set<string>, key: string): Set<string> {
  const next = new Set(current)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}
