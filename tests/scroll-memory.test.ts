import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyScroll,
  captureScroll,
  clearScrollMemory,
  clampScrollTop,
  distanceFromBottom,
  isNearBottom,
  migrateScrollMemory,
  readScrollMemory,
  rememberScrollMemory,
  rememberScrollPosition,
  SCROLL_FOLLOW_RANGE,
  type ScrollMetrics
} from '../src/renderer/src/lib/scroll-memory'

function metrics(scrollHeight: number, scrollTop: number, clientHeight: number): ScrollMetrics {
  return { scrollHeight, scrollTop, clientHeight }
}

test('distanceFromBottom never reports a negative distance', () => {
  assert.equal(distanceFromBottom(metrics(1000, 200, 300)), 500)
  assert.equal(distanceFromBottom(metrics(1000, 900, 300)), 0)
})

test('isNearBottom follows only within the range', () => {
  assert.equal(isNearBottom(metrics(1000, 200, 300)), false)
  assert.equal(isNearBottom(metrics(1000, 621, 300)), true)
  assert.equal(isNearBottom(metrics(1000, 200, 300), 1000), true)
  assert.equal(SCROLL_FOLLOW_RANGE, 80)
})

test('captureScroll stores the offset and the follow state', () => {
  assert.deepEqual(captureScroll(metrics(1000, 150, 300)), { top: 150, atBottom: false })
  assert.deepEqual(captureScroll(metrics(1000, 690, 300)), { top: 690, atBottom: true })
})

test('clampScrollTop keeps the offset inside the scrollable range', () => {
  assert.equal(clampScrollTop(metrics(1000, 5000, 300)), 700)
  assert.equal(clampScrollTop(metrics(1000, -20, 300)), 0)
})

test('applyScroll returns to the bottom for a following conversation', () => {
  const result = applyScroll(metrics(1200, 0, 300), { top: 30, atBottom: true })
  assert.deepEqual(result, { stick: true, atBottom: true, top: 900 })
})

test('applyScroll restores a frozen reading position', () => {
  const result = applyScroll(metrics(1200, 0, 300), { top: 240, atBottom: false })
  assert.equal(result.top, 240)
  assert.equal(result.atBottom, false)
  assert.equal(result.stick, false)
})

test('applyScroll clamps a position that the new transcript cannot reach', () => {
  const result = applyScroll(metrics(500, 0, 300), { top: 900, atBottom: false })
  assert.equal(result.top, 200)
  assert.equal(result.atBottom, false)
})

test('applyScroll treats a missing entry as the start of a new conversation', () => {
  const result = applyScroll(metrics(800, 0, 300), undefined)
  assert.deepEqual(result, { stick: true, atBottom: true, top: 500 })
})

test('conversation memories survive the Thread component being unmounted', () => {
  clearScrollMemory()
  rememberScrollMemory('file-a.jsonl', metrics(1000, 250, 300))
  assert.deepEqual(readScrollMemory('file-a.jsonl'), { top: 250, atBottom: false })
  assert.equal(readScrollMemory('file-b.jsonl'), undefined)
})

test('a draft memory migrates to the session file without overwriting a newer entry', () => {
  clearScrollMemory()
  rememberScrollPosition('draft:one', { top: 120, atBottom: false })
  migrateScrollMemory('draft:one', 'session.jsonl')
  assert.equal(readScrollMemory('draft:one'), undefined)
  assert.deepEqual(readScrollMemory('session.jsonl'), { top: 120, atBottom: false })

  rememberScrollPosition('session.jsonl', { top: 700, atBottom: true })
  migrateScrollMemory('draft:two', 'session.jsonl')
  assert.deepEqual(readScrollMemory('session.jsonl'), { top: 700, atBottom: true })
})

test('clearScrollMemory can drop one conversation or all of them', () => {
  clearScrollMemory()
  rememberScrollPosition('a', { top: 1, atBottom: false })
  rememberScrollPosition('b', { top: 2, atBottom: true })
  clearScrollMemory('a')
  assert.equal(readScrollMemory('a'), undefined)
  assert.ok(readScrollMemory('b'))
  clearScrollMemory()
  assert.equal(readScrollMemory('b'), undefined)
})
