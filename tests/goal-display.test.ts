import test from 'node:test'
import assert from 'node:assert/strict'
import { goalBadge, goalBarVisible, goalCanToggleRun } from '../src/shared/goal-display'

test('a live goal has exactly two words: running and paused', () => {
  assert.deepEqual(goalBadge('active', true), { status: 'active', label: 'Running' })
  // The old bar said "Inactive" for an objective whose run was gone; the
  // reader now gets the same word a paused goal gets.
  assert.deepEqual(goalBadge('active', false), { status: 'paused', label: 'Paused' })
  assert.deepEqual(goalBadge('paused', false), { status: 'paused', label: 'Paused' })
  assert.deepEqual(goalBadge('paused', true), { status: 'active', label: 'Running' })
})

test('an outcome keeps its own word instead of claiming to be paused', () => {
  assert.deepEqual(goalBadge('blocked', false), { status: 'blocked', label: 'Blocked' })
  assert.deepEqual(goalBadge('complete', false), { status: 'complete', label: 'Complete' })
})

test('only a live goal can be toggled by the run control', () => {
  assert.equal(goalCanToggleRun(goalBadge('active', true)), true)
  assert.equal(goalCanToggleRun(goalBadge('paused', false)), true)
  assert.equal(goalCanToggleRun(goalBadge('blocked', false)), false)
  assert.equal(goalCanToggleRun(goalBadge('complete', false)), false)
})

test('a finished goal has no bar: the transcript carries its closing row instead', () => {
  assert.equal(goalBarVisible('active'), true)
  assert.equal(goalBarVisible('paused'), true)
  // A blocker still has to be readable above the composer, because it is a
  // question (resume it, clear it) rather than an outcome.
  assert.equal(goalBarVisible('blocked'), true)
  assert.equal(goalBarVisible('complete'), false)
  assert.equal(goalBarVisible(undefined), false)
})
