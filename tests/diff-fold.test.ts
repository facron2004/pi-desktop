import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildWorkingTreeDiff, diffStats, foldDiff, type DiffRow } from '../src/renderer/src/lib/diff-fold'

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
