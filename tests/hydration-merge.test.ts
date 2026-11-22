import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyStreamEvent,
  itemsFromMessages,
  mergeHydratedItems,
  type ThreadItem,
  type ToolItem,
  type UserItem
} from '../src/renderer/src/lib/thread'
import { normalizePiEvent, resetStreamState } from '../src/renderer/src/lib/stream-events'
import type { PiEvent } from '@shared/types'

/**
 * `mergeHydratedItems` is the door a reopened conversation walks through when
 * live events arrived before the disk history did. It has to fill in the older
 * history without disturbing the identities, progress or terminal states the
 * live stream already produced.
 */

let order = 1000
const nextOrder = () => (order += 1)

const userItem = (text: string, timestamp: number): UserItem => ({
  id: `user-${timestamp}`,
  kind: 'user',
  text,
  images: [],
  timestamp,
  order: nextOrder()
})

const toolItem = (
  toolCallId: string,
  status: ToolItem['status'],
  extra: Partial<ToolItem> = {}
): ToolItem => ({
  id: `tool-${toolCallId}`,
  kind: 'tool',
  toolCallId,
  toolName: 'read',
  args: { path: 'a.ts' },
  status,
  timestamp: 50,
  order: nextOrder(),
  ...extra
})

test('a saved terminal tool node is not resurrected by a late live update', () => {
  const saved = [toolItem('call-1', 'ok', { result: 'file body' })]
  const live = [toolItem('call-1', 'running', { progress: 'partial' })]

  const [merged] = mergeHydratedItems(saved, live)
  assert.equal(merged.kind, 'tool')
  if (merged.kind !== 'tool') throw new Error('expected a tool node')
  // The live identity survives, the finished state does not regress.
  assert.equal(merged.id, 'tool-call-1')
  assert.equal(merged.status, 'ok')
  assert.equal(merged.result, 'file body')
  // A finished node has no progress; it would repaint a spinner.
  assert.equal(merged.progress, undefined)
})

test('a live proposal is upgraded by the saved result instead of staying proposed', () => {
  const saved = [toolItem('call-2', 'ok', { result: 'done' })]
  const live = [toolItem('call-2', 'proposed')]

  const [merged] = mergeHydratedItems(saved, live)
  if (merged.kind !== 'tool') throw new Error('expected a tool node')
  assert.equal(merged.status, 'ok')
  assert.equal(merged.result, 'done')
  assert.equal(merged.id, 'tool-call-2')
})

test('live-only rows land after the history they followed, not at the top', () => {
  const saved = [userItem('first prompt', 100), toolItem('call-3', 'ok')]
  const live = [userItem('typed while the read ran', 200)]

  const merged = mergeHydratedItems(saved, live)
  assert.deepEqual(merged.map((item) => item.kind), ['user', 'tool', 'user'])
  assert.equal((merged[2] as UserItem).text, 'typed while the read ran')
  // A merged list is re-ordered densely, so consumers can trust `order`.
  const orders = merged.map((item) => item.order)
  assert.deepEqual(orders, [...orders].sort((left, right) => left - right))
  assert.equal(new Set(orders).size, orders.length)
})

test('repeated timestamps pair with the newest saved occurrence first', () => {
  const saved = [userItem('same', 300), userItem('same', 300)]
  const live = [userItem('same', 300)]

  const merged = mergeHydratedItems(saved, live)
  // One live row pairs with one saved row; the other stays as saved history.
  assert.equal(merged.length, 2)
  assert.deepEqual(merged.map((item) => item.id), ['user-300', 'user-300'])
})

test('an identical history and live tail does not duplicate rows', () => {
  const saved: ThreadItem[] = [userItem('prompt', 400), toolItem('call-4', 'ok')]
  const live: ThreadItem[] = [userItem('prompt', 400), toolItem('call-4', 'ok')]

  const merged = mergeHydratedItems(saved, live)
  assert.equal(merged.length, 2)
})

test('an empty side is returned as-is so hydration of a cold cache stays cheap', () => {
  const saved = [userItem('prompt', 500)]
  assert.equal(mergeHydratedItems([], saved), saved)
  const live = [userItem('prompt', 500)]
  assert.equal(mergeHydratedItems(live, []), live)
})

test('a live streaming answer keeps its block text while taking the saved metadata', () => {
  resetStreamState()
  const context = { sessionKey: 'merge-answer', runId: 'run-1', turnId: 'turn-1' }
  const normalize = (event: PiEvent) => {
    const normalized = normalizePiEvent(event, context)
    assert.ok(normalized, `expected ${event.type} to normalize`)
    return normalized
  }
  const streaming = applyStreamEvent([], normalize({
    type: 'message_start',
    message: { role: 'assistant', content: [], timestamp: 600 }
  }))
  const withDelta = applyStreamEvent(streaming, normalize({
    type: 'message_update',
    message: { role: 'assistant', content: [], timestamp: 600 },
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'half a sentence' }
  } as PiEvent))
  const liveAssistant = withDelta[0]
  if (liveAssistant.kind !== 'assistant') throw new Error('expected an assistant item')
  assert.equal(liveAssistant.streaming, true)

  const saved = itemsFromMessages([{
    role: 'assistant',
    content: [{ type: 'text', text: 'half a sentence and the rest' }],
    timestamp: 600
  }] as never)

  const [merged] = mergeHydratedItems(saved, [liveAssistant])
  if (merged.kind !== 'assistant') throw new Error('expected an assistant item')
  // The saved (complete) text wins; the live identity is kept so the next
  // delta still finds the same node.
  assert.equal(merged.id, liveAssistant.id)
  assert.deepEqual(merged.blocks, [{ type: 'text', text: 'half a sentence and the rest' }])
})
