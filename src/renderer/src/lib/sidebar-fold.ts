/**
 * Fold state for the sidebar's own section head — the「对话 / Chats」column in
 * the single list and「项目 / Projects」in the grouped views.
 *
 * The section head is a view control: what it folds is the list under it, not
 * anything the session index or the settings own. So the state lives in
 * localStorage, like the archived-group folds (`lib/archive-fold.ts`) and the
 * memory groups (`lib/memory-fold.ts`), and never in `settings.json`.
 *
 * The key is the view the fold belongs to, not the label: folding the single
 * list must not leave the project list folded when the reader switches back.
 */

const COLLAPSED_KEY = 'pi-desktop.sidebar.collapsed-sections'

/** Tests hand in a fake; in the app this is `window.localStorage`. */
export type StringStore = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function storeOrDefault(store?: StringStore): StringStore | null {
  if (store) return store
  if (typeof localStorage === 'undefined') return null
  return localStorage
}

export function readCollapsedSidebarSections(store?: StringStore): Set<string> {
  const source = storeOrDefault(store)
  if (!source) return new Set()
  try {
    const raw = source.getItem(COLLAPSED_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((key): key is string => typeof key === 'string'))
  } catch {
    // Unreadable storage means no fold preference at all.
    return new Set()
  }
}

export function writeCollapsedSidebarSections(collapsed: Iterable<string>, store?: StringStore): void {
  const target = storeOrDefault(store)
  if (!target) return
  try {
    target.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]))
  } catch {
    // A full or disabled storage must not break the sidebar.
  }
}

/** Toggle one section without mutating the caller's set. */
export function toggleCollapsedSidebarSection(current: Set<string>, key: string): Set<string> {
  const next = new Set(current)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

/**
 * Whether one section's list is on screen.
 *
 * A filter in the sidebar's field opens the section: a match inside a folded
 * list would be invisible, which is the one thing a search must not do.
 * Otherwise the reader's fold stands.
 */
export function sidebarSectionExpanded(
  collapsed: ReadonlySet<string>,
  key: string,
  filtering: boolean
): boolean {
  return filtering || !collapsed.has(key)
}
