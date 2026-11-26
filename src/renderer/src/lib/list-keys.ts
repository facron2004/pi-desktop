/**
 * Where a list key moves the highlighted row.
 *
 * The composer's command palette and its `@` file list are long — a project's
 * file list can run to thousands of entries and the command list to dozens —
 * and they only honoured Up/Down: reaching the last row meant holding the arrow
 * key. Home/End jump to the ends and PageUp/PageDown move by the rows the list
 * actually shows. Up/Down keep wrapping, as they always did.
 *
 * An unknown key returns `undefined`, so the textarea keeps its own Home/End
 * (line start and end) and PageUp/PageDown (scroll the draft) whenever no list
 * is open.
 */
export function listSelectionAfter(
  key: string,
  index: number,
  count: number,
  pageSize = 1
): number | undefined {
  if (count <= 0) return undefined
  const current = Math.min(Math.max(0, index), count - 1)
  const page = Math.max(1, Math.floor(pageSize) || 1)
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % count
    case 'ArrowUp':
      return (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    case 'PageDown':
      return Math.min(count - 1, current + page)
    case 'PageUp':
      return Math.max(0, current - page)
    default:
      return undefined
  }
}

/**
 * How many whole rows the scrolling list shows, at least one.
 *
 * Read from the list itself rather than a constant: the palette and the file
 * list have different heights, and a short window shows fewer rows.
 */
export function listPageSize(container: HTMLElement | null): number {
  if (!container) return 1
  const row = container.querySelector<HTMLElement>('[role="option"]')
  const rowHeight = row?.getBoundingClientRect().height ?? 0
  if (rowHeight <= 0) return 1
  return Math.max(1, Math.floor(container.clientHeight / rowHeight))
}
