import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import {
  buildDiff,
  buildWorkingTreeDiff,
  diffStats,
  foldDiff,
  type DiffRow
} from '../src/renderer/src/lib/diff-fold'

test('working-tree diff ignores CRLF conversion when it matches Git counts', () => {
  const oldText = 'one\ntwo\nthree\n'
  const newText = 'one\r\nchanged\r\nthree\r\n'
  const block = buildWorkingTreeDiff(oldText, newText, 1, 1)
  assert.deepEqual(diffStats(block), { added: 1, removed: 1 })
  assert.deepEqual(block.rows.filter((row) => row.kind === 'ctx').map((row) => row.text), ['one', 'three'])
})

test('working-tree diff retains line-ending changes when Git counts them', () => {
  const block = buildWorkingTreeDiff('one\ntwo\n', 'one\r\ntwo\r\n', 2, 2)
  assert.deepEqual(diffStats(block), { added: 2, removed: 2 })
})

test('folding a hunk does not duplicate short context between gaps and changes', () => {
  const context = (line: number): DiffRow => ({ kind: 'ctx', oldLine: line, newLine: line, text: `line ${line}` })
  const rows: DiffRow[] = [
    { kind: 'gap', oldLine: 1, newLine: 1, text: '', hidden: [context(1)], key: 'before' },
    context(2), context(3), context(4),
    { kind: 'del', oldLine: 5, newLine: null, text: 'old' },
    { kind: 'add', oldLine: null, newLine: 5, text: 'new' },
    context(6), context(7), context(8),
    { kind: 'gap', oldLine: 9, newLine: 9, text: '', hidden: [context(9)], key: 'after' }
  ]
  assert.deepEqual(
    foldDiff(rows).filter((row) => row.kind === 'ctx').map((row) => row.text),
    ['line 2', 'line 3', 'line 4', 'line 6', 'line 7', 'line 8']
  )
})

test('a diff that would take too long degrades instead of blocking the renderer', () => {
  // Two halves with nothing in common: the Myers diff has no common prefix or
  // suffix to trim, so this is the shape that costs seconds at realistic sizes.
  const oldText = Array.from({ length: 4_000 }, (_, index) => `before ${index}`).join('\n')
  const newText = Array.from({ length: 4_000 }, (_, index) => `after ${3_999 - index}`).join('\n')
  const block = buildDiff(oldText, newText, 5)
  assert.equal(block.degraded, true)
  assert.deepEqual(block.rows, [])
})

test('a degrading diff is not retried with CRLF normalization', () => {
  const oldText = Array.from({ length: 4_000 }, (_, index) => `before ${index}`).join('\n')
  const newText = Array.from({ length: 4_000 }, (_, index) => `after ${3_999 - index}`).join('\n')
  // Git's counts can never be matched here; a second attempt would only spend
  // another budget for the same answer.
  const block = buildWorkingTreeDiff(oldText, newText, 0, 0, 5)
  assert.equal(block.degraded, true)
  assert.deepEqual(block.rows, [])
})

test('a large file with one change still aligns quickly', () => {
  const lines = Array.from({ length: 20_000 }, (_, index) => `line ${index}`)
  const changed = [...lines]
  changed[10_000] = 'changed'
  const block = buildDiff(lines.join('\n'), changed.join('\n'))
  // The observable contract is that the diff did not degrade: the module has its
  // own 1 s budget and reports `degraded` when it spends it. A wall-clock
  // assertion here would be stricter than that budget and would fail on a loaded
  // runner for reasons that have nothing to do with the diff.
  assert.equal(block.degraded, undefined)
  assert.deepEqual(diffStats(block), { added: 1, removed: 1 })
})

test('a normal-sized file still aligns line by line', () => {
  const block = buildDiff('one\ntwo\nthree\n', 'one\nchanged\nthree\n')
  assert.equal(block.degraded, undefined)
  assert.deepEqual(diffStats(block), { added: 1, removed: 1 })
})

test('a fold standing for a huge unchanged run does not overflow the stack', () => {
  const context = (line: number): DiffRow => ({ kind: 'ctx', oldLine: line, newLine: line, text: `line ${line}` })
  const rows: DiffRow[] = Array.from({ length: 200_000 }, (_, index) => context(index + 1))
  rows.push({ kind: 'add', oldLine: null, newLine: 200_001, text: 'new' })
  const folded = foldDiff(rows, 3)
  assert.equal(folded[0]?.kind, 'gap')
  assert.equal(folded[0]?.kind === 'gap' ? folded[0].hidden.length : 0, 199_997)
  assert.deepEqual(folded.slice(1).map((row) => row.kind), ['ctx', 'ctx', 'ctx', 'add'])
})

test('DiffView/ReviewView gap toggling, BrowserView listener re-attach, ToolPanel concealed Escape, useIsDark singleton, and MermaidDiagram memo guards', () => {
  const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8')

  const diffView = read('src/renderer/src/components/DiffView.tsx')
  assert.match(diffView, /const next = new Set<string>\(expandAll \? gapKeys : \[\]\)/)
  assert.match(diffView, /if \(expandAll\) \{[\s\S]*?next\.delete\(key\)[\s\S]*?\} else \{[\s\S]*?next\.add\(key\)/)
  // A diff's line links are one keyboard column: the first line of a block takes
  // the Tab stop, the arrows walk the rest, and the roving stop follows. A stop
  // per line made an 80-line edit cost 160 presses of Tab (measured), and a
  // split row with two stops made Down move twice per row.
  assert.match(diffView, /data-diff-line=\{keyboard \? '' : undefined\}/)
  assert.match(diffView, /tabIndex=\{keyboard && first \? 0 : -1\}/)
  assert.match(diffView, /rowIndexAfterKey\(event\.key, index, handles\.length\)/)
  assert.match(diffView, /current\.tabIndex = -1/)
  assert.match(diffView, /target\.tabIndex = 0/)

  const reviewView = read('src/renderer/src/components/ReviewView.tsx')
  assert.match(reviewView, /onExpandAllChange=\{setExpandAll\}/)
  assert.match(reviewView, /onExpandAllChange=\{onExpandAllChange\}/)

  const browserView = read('src/renderer/src/components/BrowserView.tsx')
  assert.match(browserView, /\[syncNavigation,\s*requestSeq\]/)

  const toolPanel = read('src/renderer/src/components/ToolPanel.tsx')
  assert.match(toolPanel, /if \(!maximized \|\| concealed\) return/)
  assert.match(toolPanel, /if \(!overlay \|\| maximized \|\| concealed\) return/)

  const theme = read('src/renderer/src/lib/theme.ts')
  assert.match(theme, /useSyncExternalStore/)

  const mermaid = read('src/renderer/src/components/MermaidDiagram.tsx')
  assert.match(mermaid, /export const MermaidDiagram = memo\(/)
  assert.equal(mermaid.includes('Math.abs(scale - computeFit())'), false)
})
