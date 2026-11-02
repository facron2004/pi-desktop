import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveThinkingLevel } from '../src/renderer/src/lib/thinking'

test('no levels means no effort position', () => {
  assert.equal(resolveThinkingLevel([], 'high', 'max'), undefined)
})

test('a supported live level wins', () => {
  assert.equal(resolveThinkingLevel(['low', 'medium', 'high'], 'medium', 'max'), 'medium')
})

test('a saved level is used when the live level is unsupported', () => {
  assert.equal(resolveThinkingLevel(['low', 'medium', 'high'], 'max', 'high'), 'high')
})

test('an unsupported level resolves to the nearest supported one', () => {
  assert.equal(resolveThinkingLevel(['low', 'medium', 'high', 'xhigh'], 'max', 'max'), 'xhigh')
  assert.equal(resolveThinkingLevel(['low', 'medium', 'high'], 'off', 'off'), 'low')
})

test('case-insensitive matching returns the level Pi reported', () => {
  assert.equal(resolveThinkingLevel(['Low', 'High'], 'high', 'max'), 'High')
})

test('an unknown preferred level falls back to the first supported level', () => {
  assert.equal(resolveThinkingLevel(['low', 'medium'], 'turbo', undefined), 'low')
})
