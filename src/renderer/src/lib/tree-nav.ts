export type TreeNavKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'

export type TreeNavAction =
  | { kind: 'focus'; index: number }
  | { kind: 'toggle'; id: string }
  | { kind: 'filter' }

/** The parts of a row this decision needs; both trees carry more than this. */
export interface TreeNavRow {
  id: string
  depth: number
  hasChildren: boolean
  childrenOpen: boolean
}

/**
 * What an arrow key means while one of a tree's rows has focus.
 *
 * Rows are a flat, already-filtered list, so a tree is drawn by depth alone:
 * Up/Down walk the visible order, Right opens a closed branch or steps into an
 * open one, Left closes an open branch or goes to the parent (the nearest
 * earlier row with a smaller depth). Up at the first row returns to the filter,
 * which is the row the reader typed into.
 *
 * Pure on purpose: the DOM handlers only move focus or call their own toggle,
 * and this decision is tested without a renderer.
 */
export function treeNavAction(rows: TreeNavRow[], index: number, key: TreeNavKey): TreeNavAction | null {
  if (index < 0 || index >= rows.length) return null
  const row = rows[index]
  if (key === 'Home') return { kind: 'focus', index: 0 }
  if (key === 'End') return { kind: 'focus', index: rows.length - 1 }
  if (key === 'ArrowDown') {
    return index === rows.length - 1 ? null : { kind: 'focus', index: index + 1 }
  }
  if (key === 'ArrowUp') {
    return index === 0 ? { kind: 'filter' } : { kind: 'focus', index: index - 1 }
  }
  if (key === 'ArrowRight') {
    if (row.hasChildren && !row.childrenOpen) return { kind: 'toggle', id: row.id }
    if (row.hasChildren && rows[index + 1] && rows[index + 1].depth > row.depth) {
      return { kind: 'focus', index: index + 1 }
    }
    return null
  }
  if (row.hasChildren && row.childrenOpen) return { kind: 'toggle', id: row.id }
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (rows[cursor].depth < row.depth) return { kind: 'focus', index: cursor }
  }
  return null
}
