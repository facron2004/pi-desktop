import type { FileChange } from './changes'
import type { DiffBlock, DiffRow } from './diff-fold'

/** The width of a line-number column. */
const GUTTER = 4

/**
 * One line of a diff as plain text.
 *
 * The two number columns and the marker are the ones the diff on screen
 * shows, so the text lines up with what the reader is looking at.
 */
function lineText(row: DiffRow): string | null {
  if (row.kind === 'gap') return null
  const old = row.oldLine === null ? '' : String(row.oldLine)
  const next = row.newLine === null ? '' : String(row.newLine)
  const marker = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
  return `${old.padStart(GUTTER)} ${next.padStart(GUTTER)} ${marker}${row.text}`
}

/** The rows of one or more diffs as plain text. */
export function formatDiff(diffs: DiffBlock[]): string {
  const lines: string[] = []
  for (const block of diffs) {
    for (const row of block.rows) {
      const text = lineText(row)
      if (text !== null) lines.push(text)
    }
  }
  return lines.join('\n')
}

/**
 * Every changed file as plain text.
 *
 * The edits of a file are pairs of snippets and not whole files, so this is a
 * listing of the changes rather than a patch that can be applied. It is meant
 * for pasting into a message, a review or a commit.
 */
export function formatChanges(changes: FileChange[], paths: string[]): string {
  const out: string[] = []

  changes.forEach((change, index) => {
    const path = paths[index] ?? change.path

    if (change.kind === 'write' && change.content !== undefined) {
      out.push('--- /dev/null')
      out.push(`+++ ${path}`)
      const lines = change.content.split('\n')
      lines.forEach((text, line) => {
        out.push(`${''.padStart(GUTTER)} ${String(line + 1).padStart(GUTTER)} +${text}`)
      })
      return
    }

    const body = formatDiff(change.diffs)
    if (!body) return
    out.push(`--- ${path}`)
    out.push(`+++ ${path}`)
    out.push(body)
  })

  return out.join('\n')
}
