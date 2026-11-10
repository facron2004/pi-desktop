import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EarlyTerminalExits } from '../src/renderer/src/lib/terminal-startup'

test('early terminal exits are matched to their create response and consumed', () => {
  const pending = new EarlyTerminalExits()
  const siblingExit = { id: 'sibling', exitCode: 1 }
  const earlyExit = { id: 'new-terminal', exitCode: 0 }
  pending.record(siblingExit)
  pending.record(earlyExit)

  assert.deepEqual(pending.takeFor('new-terminal'), earlyExit)
  assert.equal(pending.takeFor('sibling'), undefined)
})
