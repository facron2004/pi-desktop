import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTurns } from '../src/renderer/src/lib/turns'
import type { AssistantItem, NoticeItem, ThreadItem, ToolItem, UserItem } from '../src/renderer/src/lib/thread'

function user(id: string): UserItem {
  return { id, kind: 'user', text: id, images: [], timestamp: 1, order: 1 }
}

function assistant(id: string, streaming = false): AssistantItem {
  return {
    id,
    kind: 'assistant',
    blocks: [{ type: 'text', text: id }],
    streaming,
    timestamp: 2,
    order: 2
  }
}

function tool(id: string): ToolItem {
  return {
    id,
    kind: 'tool',
    toolCallId: id,
    toolName: 'read',
    args: { path: 'x' },
    status: 'ok',
    timestamp: 3,
    order: 3
  }
}

function notice(id: string): NoticeItem {
  return { id, kind: 'notice', level: 'info', text: id, timestamp: 4, order: 4 }
}

test('buildTurns attaches everything after a user message to that turn', () => {
  const items: ThreadItem[] = [user('u1'), assistant('a1'), tool('t1'), notice('n1'), user('u2')]
  const turns = buildTurns(items)
  assert.equal(turns.length, 2)
  assert.equal(turns[0].user?.id, 'u1')
  assert.deepEqual(turns[0].assistants.map((item) => item.id), ['a1'])
  assert.deepEqual(turns[0].tools.map((item) => item.id), ['t1'])
  assert.deepEqual(turns[0].notices.map((item) => item.id), ['n1'])
  assert.equal(turns[1].user?.id, 'u2')
})

test('buildTurns gives leading items their own synthetic turn', () => {
  const turns = buildTurns([assistant('a1'), notice('n1')])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].user, undefined)
  assert.equal(turns[0].assistants[0].id, 'a1')
})

test('buildTurns preserves the item objects so memo comparisons stay cheap', () => {
  const items: ThreadItem[] = [user('u1'), assistant('a1'), tool('t1')]
  const turns = buildTurns(items)
  assert.equal(turns[0].user, items[0])
  assert.equal(turns[0].assistants[0], items[1])
  assert.equal(turns[0].tools[0], items[2])
})

test('buildTurns is empty for an empty thread', () => {
  assert.deepEqual(buildTurns([]), [])
})
