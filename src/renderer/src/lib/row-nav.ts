/**
 * Where a row-list key moves the keyboard.
 *
 * Several columns in the app are "one keyboard stop per row plus the arrows":
 * the scheduled-task list and the two changed-file lists keep every row
 * reachable by Tab and add bounded Up/Down plus Home/End on top, so a reading of
 * twenty files does not mean twenty presses of Down. The rule is the same each
 * time, and it lives here so the column that is added next does not write it a
 * fifth way.
 *
 * Returns `undefined` for a key the list does not own, so a caller can leave it
 * to the row's own button behaviour. The move is bounded, never wrapping: an
 * arrow at the end stops there instead of jumping back to the top, which in a
 * list that also shows a preview would read as a jump.
 */
export function rowIndexAfterKey(key: string, index: number, count: number): number | undefined {
  if (count <= 0 || index < 0 || index >= count) return undefined
  switch (key) {
    case 'ArrowDown':
      return Math.min(count - 1, index + 1)
    case 'ArrowUp':
      return Math.max(0, index - 1)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return undefined
  }
}
