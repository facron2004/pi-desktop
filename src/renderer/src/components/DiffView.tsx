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

export function DiffView({ diffs }: { diffs: DiffBlock[] }) {
  const hasContent = useMemo(() => diffs.some((block) => block.rows.length > 0), [diffs])
  if (!hasContent) return null

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
