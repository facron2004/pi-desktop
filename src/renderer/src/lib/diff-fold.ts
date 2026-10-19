import { diffLines } from 'diff'

/** Unchanged lines kept on each side of a change. */
export const CONTEXT_LINES = 3

/** A collapsed run has to hide at least this many lines to be worth a click. */
export const MIN_GAP_LINES = 3

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
}

/** Build a line diff for a single edit pair. */
export function buildDiff(oldText: string, newText: string): DiffBlock {
  const parts = diffLines(oldText, newText)
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
      head = run.slice(0, keep)
      hidden = run.slice(keep, run.length - keep)
      tail = run.slice(run.length - keep)
    }

    out.push(...head)
    if (hidden.length >= MIN_GAP_LINES) {
      out.push(gapRow(hidden, `${scope}:${gap}`))
      gap += 1
    } else {
      out.push(...hidden)
    }
    out.push(...tail)

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
