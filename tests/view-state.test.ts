import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearViewState,
  migrateViewState,
  readFileOpen,
  readHistoryFirstVisibleTurn,
  readProcessOpen,
  readToolFull,
  readToolOpen,
  writeFileOpen,
  writeHistoryFirstVisibleTurn,
  writeProcessOpen,
  writeToolFull,
  writeToolOpen
} from '../src/renderer/src/lib/view-state'

test('tool expansion is keyed by conversation and tool id', () => {
  writeToolOpen('thread-a', 'tool-1', true)
  assert.equal(readToolOpen('thread-a', 'tool-1'), true)
  assert.equal(readToolOpen('thread-a', 'tool-2'), undefined)
  assert.equal(readToolOpen('thread-b', 'tool-1'), undefined)
  writeToolOpen('thread-a', 'tool-1', false)
  assert.equal(readToolOpen('thread-a', 'tool-1'), false)
  writeToolOpen('thread-a', 'tool-1', undefined)
  assert.equal(readToolOpen('thread-a', 'tool-1'), undefined)
})

test('full and file expansion are independent per conversation', () => {
  writeToolFull('thread-a', 'tool-1', true)
  assert.equal(readToolFull('thread-a', 'tool-1'), true)
  assert.equal(readToolFull('thread-b', 'tool-1'), false)
  writeFileOpen('thread-a', 'src/a.ts', true)
  assert.equal(readFileOpen('thread-a', 'src/a.ts'), true)
  assert.equal(readFileOpen('thread-b', 'src/a.ts'), false)
})

test('process and history position survive a component remount', () => {
  writeProcessOpen('thread-a', 'process-1', true)
  assert.equal(readProcessOpen('thread-a', 'process-1'), true)
  writeHistoryFirstVisibleTurn('thread-a', 3)
  assert.equal(readHistoryFirstVisibleTurn('thread-a'), 3)
  writeHistoryFirstVisibleTurn('thread-a', undefined)
  assert.equal(readHistoryFirstVisibleTurn('thread-a'), undefined)
})

test('a draft migration carries every expansion map to the session file', () => {
  const draft = 'draft:view-state'
  const file = 'view-state.jsonl'
  writeToolOpen(draft, 'tool-1', true)
  writeToolFull(draft, 'tool-1', true)
  writeFileOpen(draft, 'src/a.ts', true)
  writeProcessOpen(draft, 'process-1', true)
  writeHistoryFirstVisibleTurn(draft, 3)

  migrateViewState(draft, file)

  assert.equal(readToolOpen(draft, 'tool-1'), undefined)
  assert.equal(readToolOpen(file, 'tool-1'), true)
  assert.equal(readToolFull(file, 'tool-1'), true)
  assert.equal(readFileOpen(file, 'src/a.ts'), true)
  assert.equal(readProcessOpen(file, 'process-1'), true)
  assert.equal(readHistoryFirstVisibleTurn(file), 3)
})

test('deleting a conversation clears only its saved view preferences', () => {
  const deleted = 'thread-deleted'
  const retained = 'thread-retained'
  for (const thread of [deleted, retained]) {
    writeToolOpen(thread, 'tool-1', true)
    writeToolFull(thread, 'tool-1', true)
    writeFileOpen(thread, 'src/a.ts', true)
    writeProcessOpen(thread, 'process-1', true)
    writeHistoryFirstVisibleTurn(thread, 2)
  }

  clearViewState(deleted)

  assert.equal(readToolOpen(deleted, 'tool-1'), undefined)
  assert.equal(readToolFull(deleted, 'tool-1'), false)
  assert.equal(readFileOpen(deleted, 'src/a.ts'), false)
  assert.equal(readProcessOpen(deleted, 'process-1'), undefined)
  assert.equal(readHistoryFirstVisibleTurn(deleted), undefined)
  assert.equal(readToolOpen(retained, 'tool-1'), true)
  assert.equal(readToolFull(retained, 'tool-1'), true)
  assert.equal(readFileOpen(retained, 'src/a.ts'), true)
  assert.equal(readProcessOpen(retained, 'process-1'), true)
  assert.equal(readHistoryFirstVisibleTurn(retained), 2)
})
