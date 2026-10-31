import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectChanges, countChangedFiles } from '../src/renderer/src/lib/changes'
import type { ToolItem } from '../src/renderer/src/lib/thread'

function tool(overrides: Partial<ToolItem>): ToolItem {
  return {
    id: 'tool-1',
    kind: 'tool',
    toolCallId: 'call-1',
    toolName: 'edit',
    args: { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] },
    status: 'ok',
    timestamp: 1,
    order: 1,
    ...overrides
  }
}

test('a proposed edit is not a file change', () => {
  const items = [tool({ status: 'proposed' })]
  assert.equal(countChangedFiles(items), 0)
  assert.deepEqual(collectChanges(items), [])
})

test('a failed or aborted edit is not a file change', () => {
  for (const status of ['error', 'aborted'] as const) {
    const items = [tool({ status })]
    assert.equal(countChangedFiles(items), 0, status)
    assert.deepEqual(collectChanges(items), [], status)
  }
})

test('a successful edit and write produce a real change with a diff', () => {
  const items = [
    tool({ id: 'edit', toolCallId: 'edit-call', status: 'ok' }),
    tool({
      id: 'write',
      toolCallId: 'write-call',
      toolName: 'write',
      args: { path: 'src/b.ts', content: 'one\ntwo' },
      status: 'ok'
    })
  ]
  assert.equal(countChangedFiles(items), 2)
  const changes = collectChanges(items)
  assert.equal(changes.length, 2)
  const edit = changes.find((change) => change.path === 'src/a.ts')
  assert.ok(edit)
  assert.equal(edit.kind, 'edit')
  assert.ok(edit.diffs.length > 0)
  const write = changes.find((change) => change.path === 'src/b.ts')
  assert.ok(write)
  assert.equal(write.kind, 'write')
  assert.equal(write.content, 'one\ntwo')
})
