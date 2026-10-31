/**
 * Line paging for long tool output.
 *
 * A command can return a hundred thousand lines, and rendering all of them in
 * one text node freezes the transcript. The stream shows one page at a time
 * instead. Paging is by line — not by character — so the page boundary never
 * cuts a line in half and the reader can still select and copy what is shown.
 */

export interface LogPage {
  /** The prefix of the source text that belongs to the visible page(s). */
  visibleText: string
  /** How many lines are still behind the "show more" control. */
  hiddenLines: number
  /** Total number of lines in the source text. */
  totalLines: number
}

/** The default page size: one screenful of a long log. */
export const LOG_PAGE_LINES = 200

/**
 * Count the lines in a text.
 *
 * A trailing newline terminates the last line; it does not open an extra
 * empty line. An empty string has no lines at all.
 */
export function countLines(text: string): number {
  if (text.length === 0) return 0
  let lines = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1
  }
  return text.endsWith('\n') ? lines - 1 : lines
}

/**
 * Split a text into a visible prefix and the number of lines it hides.
 *
 * `visibleLines` is clamped to at least one line. When the text fits, the
 * whole text is returned unchanged — including its trailing newline — so a
 * short result is never reflowed. When it does not fit, the prefix ends right
 * after the terminating newline of the last visible line, which keeps page
 * boundaries exact and the hidden remainder independent of the visible one.
 */
export function splitLog(text: string, visibleLines: number = LOG_PAGE_LINES): LogPage {
  const totalLines = countLines(text)
  const limit = Number.isFinite(visibleLines)
    ? Math.max(1, Math.floor(visibleLines))
    : LOG_PAGE_LINES

  if (totalLines === 0 || limit >= totalLines) {
    return { visibleText: text, hiddenLines: 0, totalLines }
  }

  let line = 1
  let boundary = -1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue
    line += 1
    if (line > limit) {
      boundary = index
      break
    }
  }

  return {
    visibleText: boundary === -1 ? text : text.slice(0, boundary + 1),
    hiddenLines: totalLines - limit,
    totalLines
  }
}
