/**
 * Fold state for the project groups in Settings → Memory.
 *
 * The memory list itself is a projection of `MemoryState`; which project
 * groups are open is a view preference, so it lives in localStorage and is
 * never written back to the memory store.
 */

const COLLAPSED_KEY = 'pi-desktop.memory.collapsed'

/** Sets may be handed in by tests; in the app this is window.localStorage. */
type StringStore = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function storeOrDefault(store?: StringStore): StringStore | null {
  if (store) return store
  if (typeof localStorage === 'undefined') return null
  return localStorage
}

export function readCollapsedMemoryGroups(store?: StringStore): Set<string> {
  const source = storeOrDefault(store)
  if (!source) return new Set()
  try {
    const raw = source.getItem(COLLAPSED_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === 'string'))
  } catch {
    // Unreadable storage is the same as no fold preference at all.
    return new Set()
  }
}

export function writeCollapsedMemoryGroups(collapsed: Iterable<string>, store?: StringStore): void {
  const target = storeOrDefault(store)
  if (!target) return
  try {
    target.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]))
  } catch {
    // A full or disabled storage must not break the settings page.
  }
}

/** Toggle one group without mutating the caller's set. */
export function toggleCollapsedMemoryGroup(current: Set<string>, key: string): Set<string> {
  const next = new Set(current)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}
