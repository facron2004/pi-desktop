import assert from 'node:assert/strict'
import { test } from 'node:test'
import { advanceReveal, revealSpeed } from '../src/renderer/src/lib/streaming-reveal'

test('a large incoming chunk is revealed over many frames, not in one', () => {
  let shown = 0
  const target = 10_000
  let frames = 0
  while (shown < target && frames < 10_000) {
    shown = advanceReveal(shown, target, 16)
    frames += 1
  }
  assert.equal(shown, target)
  assert.ok(frames > 20, `a 10k chunk needs many frames, got ${frames}`)
})

test('the reveal never overshoots and stops at the full text', () => {
  const target = 42
  let shown = 0
  while (shown < target) shown = advanceReveal(shown, target, 16)
  assert.equal(shown, target, 'lands exactly on the target')
  assert.equal(advanceReveal(shown, target, 16), target, 'stays there once caught up')
})

test('a lagging tab cannot dump the whole answer in one frame', () => {
  const next = advanceReveal(0, 5_000, 10_000)
  assert.ok(next < 200, `elapsed time is clamped per frame, got ${next}`)
})

test('a slow provider is not slowed further by the reveal cursor', () => {
  // One or two characters per frame closes immediately: the cursor never
  // becomes a queue that delays text the provider already paced out.
  assert.equal(advanceReveal(0, 1, 16), 1)
  assert.equal(advanceReveal(0, 2, 16), 2)
})

test('a very long answer accelerates so the reader is not kept waiting', () => {
  assert.ok(revealSpeed(2_000) > revealSpeed(50))
  assert.ok(revealSpeed(600) > revealSpeed(50))
})
