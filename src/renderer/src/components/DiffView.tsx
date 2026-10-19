import { useMemo, useState } from 'react'
import {
  CONTEXT_LINES,
  foldDiff,
  type DiffBlock,
  type DiffRow
} from '../lib/diff-fold'

/** One line of a side-by-side diff. Either side may be empty. */
export interface SplitRow {
  left: { line: number | null; text: string; kind: 'del' | 'ctx' } | null
  right: { line: number | null; text: string; kind: 'add' | 'ctx' } | null
  /** Set when the row stands for a collapsed run of unchanged lines. */
  gap?: { count: number; key: string }
}

export type DiffMode = 'unified' | 'split'

/**
 * Pair the removed and added lines of a unified diff into two columns.
 *
 * The two sides are matched by position inside a change hunk, so a line that
 * was replaced shows up on the left and its replacement on the right.
 */
export function buildSplitDiff(rows: DiffRow[]): SplitRow[] {
  const result: SplitRow[] = []
  let index = 0

  while (index < rows.length) {
    const row = rows[index]
    if (row.kind === 'gap') {
      result.push({ left: null, right: null, gap: { count: row.hidden.length, key: row.key } })
      index += 1
      continue
    }
    if (row.kind === 'ctx') {
      result.push({
        left: { line: row.oldLine, text: row.text, kind: 'ctx' },
        right: { line: row.newLine, text: row.text, kind: 'ctx' }
      })
      index += 1
      continue
    }

    const removed: DiffRow[] = []
    const added: DiffRow[] = []
    while (index < rows.length && rows[index].kind === 'del') removed.push(rows[index++])
    while (index < rows.length && rows[index].kind === 'add') added.push(rows[index++])

    const height = Math.max(removed.length, added.length)
    for (let line = 0; line < height; line += 1) {
      result.push({
        left: removed[line]
          ? { line: removed[line].oldLine, text: removed[line].text, kind: 'del' }
          : null,
        right: added[line] ? { line: added[line].newLine, text: added[line].text, kind: 'add' } : null
      })
    }
  }

  return result
}

/**
 * Expand the gaps the reader has opened.
 *
 * The gap stays in place as a toggle, so a long run can be opened and closed
 * again without reloading the diff.
 */
function displayRows(rows: DiffRow[], opened: ReadonlySet<string>): DiffRow[] {
  const out: DiffRow[] = []
  for (const row of rows) {
    out.push(row)
    if (row.kind === 'gap' && opened.has(row.key)) out.push(...row.hidden)
  }
  return out
}

function GapButton({
  count,
  open,
  onToggle
}: {
  count: number
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      className="diff__gap"
      data-open={open}
      onClick={onToggle}
      title={open ? 'Hide these lines' : `Show ${count} unchanged lines`}
    >
      <span className="diff__gap-label">
        {open ? '−' : '⋯'} {count} unchanged {count === 1 ? 'line' : 'lines'}
      </span>
    </button>
  )
}

export function DiffView({ diffs, mode = 'unified' }: { diffs: DiffBlock[]; mode?: DiffMode }) {
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())

  const folded = useMemo(
    () => diffs.map((block, blockIndex) => foldDiff(block.rows, CONTEXT_LINES, String(blockIndex))),
    [diffs]
  )

  const hasContent = useMemo(() => folded.some((rows) => rows.length > 0), [folded])
  if (!hasContent) return null

  const toggle = (key: string) =>
    setOpened((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  if (mode === 'split') {
    return (
      <div className="diff diff--split">
        {folded.map((rows, blockIndex) => (
          <div key={blockIndex}>
            {buildSplitDiff(displayRows(rows, opened)).map((row, rowIndex) =>
              row.gap ? (
                <div className="diff__split" data-gap="true" key={rowIndex}>
                  <GapButton
                    count={row.gap.count}
                    open={opened.has(row.gap.key)}
                    onToggle={() => toggle(row.gap?.key ?? '')}
                  />
                </div>
              ) : (
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
              )
            )}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="diff">
      {folded.map((rows, blockIndex) => (
        <div key={blockIndex}>
          {displayRows(rows, opened).map((row, rowIndex) =>
            row.kind === 'gap' ? (
              <div className="diff__row diff__row--gap" key={rowIndex}>
                <GapButton
                  count={row.hidden.length}
                  open={opened.has(row.key)}
                  onToggle={() => toggle(row.key)}
                />
              </div>
            ) : (
              <div className="diff__row" data-kind={row.kind} key={rowIndex}>
                <span className="diff__gutter">{row.oldLine ?? ''}</span>
                <span className="diff__gutter">{row.newLine ?? ''}</span>
                <span className="diff__code">
                  {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
                  {row.text}
                </span>
              </div>
            )
          )}
        </div>
      ))}
    </div>
  )
}
