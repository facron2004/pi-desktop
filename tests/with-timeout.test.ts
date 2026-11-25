import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withTimeout } from '../src/renderer/src/lib/with-timeout'

/**
 * Model and reasoning switches await a Pi process that can be busy, wedged or
 * gone. The deadline is what keeps a stuck request from leaving the control
 * "updating" (and every later attempt refused) for the rest of the session.
 */

test('a hung action rejects at the deadline', async () => {
  const started = Date.now()
  await assert.rejects(
    withTimeout(new Promise<never>(() => {}), 40, 'The switch timed out.'),
    /The switch timed out\./
  )
  assert.ok(Date.now() - started >= 30, 'the deadline fired far too early')
})

test('a finished action keeps its value and drops its timer', async () => {
  assert.equal(await withTimeout(Promise.resolve('changed'), 1_000, 'timed out'), 'changed')
})

test('a rejection passes through unchanged before the deadline', async () => {
  await assert.rejects(
    withTimeout(Promise.reject(new Error('Pi is gone')), 1_000, 'timed out'),
    /Pi is gone/
  )
})
