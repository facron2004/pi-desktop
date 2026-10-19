import { useMemo } from 'react'
import { diffLines } from 'diff'

export interface DiffRow {
  kind: 'add' | 'del' | 'ctx'
  oldLine: number | null
  newLine: number | null
  text: string
}

export interface DiffBlock {
  rows: DiffRow[]
}

/** One line of a side-by-side diff. Either side may be empty. */
export interface SplitRow {
  left: { line: number | null; text: string; kind: 'del' | 'ctx' } | null
  right: { line: number | null; text: string; kind: 'add' | 'ctx' } | null
}

export type DiffMode = 'unified' | 'split'

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

/**
 * Pair the removed and added lines of a unified diff into two columns.
 *
 * The two sides are matched by position inside a change hunk, so a line that
 * was replaced shows up on the left and its replacement on the right.
 */
export function buildSplitDiff(block: DiffBlock): SplitRow[] {
  const rows: SplitRow[] = []
  const source = block.rows
  let index = 0

  while (index < source.length) {
    const row = source[index]
    if (row.kind === 'ctx') {
      rows.push({
        left: { line: row.oldLine, text: row.text, kind: 'ctx' },
        right: { line: row.newLine, text: row.text, kind: 'ctx' }
      })
      index += 1
      continue
    }

    const removed: DiffRow[] = []
    const added: DiffRow[] = []
    while (index < source.length && source[index].kind === 'del') removed.push(source[index++])
    while (index < source.length && source[index].kind === 'add') added.push(source[index++])

    const height = Math.max(removed.length, added.length)
    for (let line = 0; line < height; line += 1) {
      rows.push({
        left: removed[line]
          ? { line: removed[line].oldLine, text: removed[line].text, kind: 'del' }
          : null,
        right: added[line] ? { line: added[line].newLine, text: added[line].text, kind: 'add' } : null
      })
    }
  }

  return rows
}

export function DiffView({ diffs, mode = 'unified' }: { diffs: DiffBlock[]; mode?: DiffMode }) {
  const hasContent = useMemo(() => diffs.some((block) => block.rows.length > 0), [diffs])
  if (!hasContent) return null

  if (mode === 'split') {
    return (
      <div className="diff diff--split">
        {diffs.map((block, blockIndex) => (
          <div key={blockIndex}>
            {buildSplitDiff(block).map((row, rowIndex) => (
              <div className="diff__split" key={rowIndex}>
                <div className="diff__side" data-kind={row.left?.kind ?? 'empty'}>
                  <span className="diff__gutter">{row.left?.line ?? ''}</span>
                  <span className="diff__code">
                    {row.left ? (row.left.kind === 'del' ? '- ' : '  ') + row.left.text : ''}
                  </span>
                </div>
                <div className="diff__side" data-kind={row.right?.kind ?? 'empty'}>
                  <span className="diff__gutter">{row.right?.line ?? ''}</span>
                  <span className="diff__code">
                    {row.right ? (row.right.kind === 'add' ? '+ ' : '  ') + row.right.text : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="diff">
      {diffs.map((block, blockIndex) => (
        <div key={blockIndex}>
          {block.rows.map((row, rowIndex) => (
            <div className="diff__row" data-kind={row.kind} key={rowIndex}>
              <span className="diff__gutter">{row.oldLine ?? ''}</span>
              <span className="diff__gutter">{row.newLine ?? ''}</span>
              <span className="diff__code">
                {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
                {row.text}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
