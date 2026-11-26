/**
 * Where the keyboard goes when the tab it was on is removed.
 *
 * A tab's close button is its own Tab stop, so pressing Enter on it removes the
 * node that held focus and the browser drops the keyboard on `<body>`: the next
 * Tab starts at the top of the app, not in the strip the reader was working in.
 * The tabs pattern keeps the keyboard in the strip — the tab that moved into
 * the closed one's place takes it, and the new last tab is the landing spot
 * when the closed one was last.
 *
 * Returns -1 when there is nothing left to focus.
 */
export function tabIndexAfterClose(closedIndex: number, remaining: number): number {
  if (remaining <= 0) return -1
  if (closedIndex < 0) return -1
  return Math.min(closedIndex, remaining - 1)
}
