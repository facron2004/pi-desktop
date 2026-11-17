import { diffLines } from 'diff'

/** Unchanged lines kept on each side of a change. */
export const CONTEXT_LINES = 3

/** A collapsed run has to hide at least this many lines to be worth a click. */
const MIN_GAP_LINES = 3

/**
 * How much line diffing one file may cost before the pane gives up.
 *
 * jsdiff aligns lines with a Myers diff: its cost grows with the number of
 * edits, so two halves of a wholly rewritten file are the worst case —
 * measured at about 8 s for 8 000 lines each, and it grows quadratically from
 * there. `git:fileDiff` caps each side at 512 KB, which is still tens of
 * thousands of short lines, and this runs in the renderer: a file a formatter
 * or a script rewrote would lock the window (the conversation included) until
 * the diff finished. A time budget is the right shape for that — a large file
 * with a few changes still aligns in milliseconds because the common prefix
 * and suffix are trimmed, so only the genuinely expensive pairs give up.
 */
export const DIFF_TIME_BUDGET_MS = 1_000

export type DiffRow =
  | {
      kind: 'add' | 'del' | 'ctx'
      oldLine: number | null
      newLine: number | null
      text: string
    }
  | {
      kind: 'gap'
      oldLine: number | null
      newLine: number | null
      text: string
      /** The unchanged rows this gap stands for. */
      hidden: DiffRow[]
      /** Identifies the gap inside its diff, so it can be opened and closed. */
      key: string
    }

export interface DiffBlock {
  rows: DiffRow[]
  /**
   * The two sides were too expensive to align, so `rows` is empty and the pane
   * says so. Only ever set with `rows: []` — never claim a change that was not
   * computed, and never build a hunk patch out of a placeholder.
   */
  degraded?: boolean
}

/**
 * Build a line diff for a single edit pair.
 *
 * `budgetMs` is the wall-clock limit for the alignment; a test can shrink it to
 * exercise the degraded path without building a file large enough to time out
 * on a fast machine.
 */
export function buildDiff(
  oldText: string,
  newText: string,
  budgetMs = DIFF_TIME_BUDGET_MS
): DiffBlock {
  const parts = diffLines(oldText, newText, { timeout: budgetMs })
  if (!parts) return { rows: [], degraded: true }
  const rows: DiffRow[] = []
  let oldLine = 1
  let newLine = 1

  for (const part of parts) {
    const lines = part.value.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    for (const line of lines) {
      if (part.added) {
        rows.push({ kind: 'add', oldLine: null, newLine, text: line })
        newLine += 1
      } else if (part.removed) {
        rows.push({ kind: 'del', oldLine, newLine: null, text: line })
        oldLine += 1
      } else {
        rows.push({ kind: 'ctx', oldLine, newLine, text: line })
        oldLine += 1
        newLine += 1
      }
    }
  }

  return { rows }
}

/** Match Git's normalized working-tree counts without hiding real line-ending changes. */
export function buildWorkingTreeDiff(
  oldText: string,
  newText: string,
  added: number | undefined,
  removed: number | undefined,
  budgetMs = DIFF_TIME_BUDGET_MS
): DiffBlock {
  const direct = buildDiff(oldText, newText, budgetMs)
  if (direct.degraded || added === undefined || removed === undefined) return direct
  const matches = (block: DiffBlock) => {
    const counts = diffStats(block)
    return counts.added === added && counts.removed === removed
  }
  if (matches(direct)) return direct
  // The first attempt already spent most of the budget the reader tolerates;
  // a second one is only worth it while the text still has a chance to align.
  const normalized = buildDiff(oldText.replace(/\r\n/g, '\n'), newText.replace(/\r\n/g, '\n'), budgetMs)
  return !normalized.degraded && matches(normalized) ? normalized : direct
}

function gapRow(hidden: DiffRow[], key: string): DiffRow {
  const first = hidden[0]
  return {
    kind: 'gap',
    oldLine: first?.oldLine ?? null,
    newLine: first?.newLine ?? null,
    text: '',
    hidden,
    key
  }
}

/**
 * Append one array onto another without `push(...items)`.
 *
 * A file can carry a hundred thousand rows under the preview cap, and spreading
 * that many arguments throws `RangeError: Maximum call stack size exceeded`
 * (measured at ~125 000) instead of appending them.
 */
function append<T>(target: T[], items: T[]): void {
  for (const item of items) target.push(item)
}

/**
 * Collapse the long runs of unchanged lines around a change.
 *
 * A diff of a whole file is mostly noise: the reader cares about the lines
 * that moved. Everything but a few lines of context becomes a single row that
 * can be opened on demand.
 */
export function foldDiff(rows: DiffRow[], context = CONTEXT_LINES, scope = '0'): DiffRow[] {
  const out: DiffRow[] = []
  let index = 0
  let gap = 0

  while (index < rows.length) {
    if (rows[index].kind !== 'ctx') {
      out.push(rows[index])
      index += 1
      continue
    }

    let end = index
    while (end < rows.length && rows[end].kind === 'ctx') end += 1

    const run = rows.slice(index, end)
    const keep = Math.min(context, run.length)
    const leading = out.length === 0
    const trailing = end === rows.length

    let head: DiffRow[] = []
    let tail: DiffRow[] = []
    let hidden: DiffRow[] = []

    if (leading) {
      hidden = run.slice(0, run.length - keep)
      tail = run.slice(run.length - keep)
    } else if (trailing) {
      head = run.slice(0, keep)
      hidden = run.slice(keep)
    } else {
      const tailKeep = Math.min(keep, run.length - keep)
      head = run.slice(0, keep)
      hidden = run.slice(keep, run.length - tailKeep)
      tail = run.slice(run.length - tailKeep)
    }

    append(out, head)
    if (hidden.length >= MIN_GAP_LINES) {
      out.push(gapRow(hidden, `${scope}:${gap}`))
      gap += 1
    } else {
      append(out, hidden)
    }
    append(out, tail)

    index = end
  }

  return out
}

/** Count the lines that were added and removed. */
export function diffStats(block: DiffBlock): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const row of block.rows) {
    if (row.kind === 'add') added += 1
    else if (row.kind === 'del') removed += 1
  }
  return { added, removed }
}
