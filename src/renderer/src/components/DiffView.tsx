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

export function DiffView({
  diffs,
  mode = 'unified',
  onOpenLine,
  expandAll,
  onExpandAllChange
}: {
  diffs: DiffBlock[]
  mode?: DiffMode
  /** Open the file this diff belongs to at a given line. */
  onOpenLine?: (line: number) => void
  /** Force every folded run open (`true`) or closed (`false`). */
  expandAll?: boolean
  /** Called when the reader takes over from the forced state. */
  onExpandAllChange?: (value: boolean | undefined) => void
}) {
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())

  const folded = useMemo(
    () => diffs.map((block, blockIndex) => foldDiff(block.rows, CONTEXT_LINES, String(blockIndex))),
    [diffs]
  )

  // Every folded run of this diff, so the panel can open or close all of
  // them at once.
  const gapKeys = useMemo(
    () =>
      folded.flatMap((rows) =>
        rows
          .filter((row): row is Extract<DiffRow, { kind: 'gap' }> => row.kind === 'gap')
          .map((row) => row.key)
      ),
    [folded]
  )

  // The forced state wins over the runs the reader opened by hand.
  const effective = useMemo(() => {
    if (expandAll === undefined) return opened
    const next = new Set(opened)
    for (const key of gapKeys) {
      if (expandAll) next.add(key)
      else next.delete(key)
    }
    return next
  }, [expandAll, opened, gapKeys])

  const hasContent = useMemo(() => folded.some((rows) => rows.length > 0), [folded])
  if (!hasContent) return null

  const toggle = (key: string) => {
    if (expandAll !== undefined) {
      // The panel is forcing a state; a click on one run takes over from it.
      const next = new Set(gapKeys)
      if (expandAll) {
        // Everything was open, so this one is closed and the rest stay open.
        for (const other of gapKeys) next.delete(other)
        next.add(key)
      } else {
        for (const other of gapKeys) next.add(other)
        next.delete(key)
      }
      setOpened(next)
      onExpandAllChange?.(undefined)
      return
    }
    setOpened((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // A line number becomes a link to the file itself, so a diff can be
  // followed into the code around it.
  const gutter = (line: number | null | undefined) => {
    if (!onOpenLine || line === null || line === undefined) {
      return <span className="diff__gutter">{line ?? ''}</span>
    }
    return (
      <button
        className="diff__gutter diff__gutter--link"
        onClick={() => onOpenLine(line)}
        title={`Open the file at line ${line}`}
      >
        {line}
      </button>
    )
  }

  if (mode === 'split') {
    return (
      <div className="diff diff--split">
        {folded.map((rows, blockIndex) => (
          <div className="diff__block" key={blockIndex}>
            {buildSplitDiff(displayRows(rows, effective)).map((row, rowIndex) =>
              row.gap ? (
                <div className="diff__split" data-gap="true" key={rowIndex}>
                  <GapButton
                    count={row.gap.count}
                    open={effective.has(row.gap.key)}
                    onToggle={() => toggle(row.gap?.key ?? '')}
                  />
                </div>
              ) : (
                <div className="diff__split" key={rowIndex}>
                  <div className="diff__side" data-kind={row.left?.kind ?? 'empty'}>
                    {gutter(row.left?.line)}
                    <span className="diff__code">
                      {row.left ? (row.left.kind === 'del' ? '- ' : '  ') + row.left.text : ''}
                    </span>
                  </div>
                  <div className="diff__side" data-kind={row.right?.kind ?? 'empty'}>
                    {gutter(row.right?.line)}
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
        <div className="diff__block" key={blockIndex}>
          {displayRows(rows, effective).map((row, rowIndex) =>
            row.kind === 'gap' ? (
              <div className="diff__row diff__row--gap" key={rowIndex}>
                <GapButton
                  count={row.hidden.length}
                  open={effective.has(row.key)}
                  onToggle={() => toggle(row.key)}
                />
              </div>
            ) : (
              <div className="diff__row" data-kind={row.kind} key={rowIndex}>
                {gutter(row.oldLine)}
                {gutter(row.newLine)}
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
