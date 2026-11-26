import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The turn rail is one keyboard column and one Tab stop.
 *
 * A tick per turn used to be a Tab stop per turn, so a 40-turn conversation put
 * 40 stops on the way from the sidebar to the transcript (measured with
 * `output/audit/check-rail-tabs.mjs`). Only the reader's current tick is in the
 * Tab order; the arrows and Home/End move focus and the stop together.
 */
test('the session rail is one Tab stop and the arrows carry it', () => {
  const rail = readFileSync(
    path.resolve(process.cwd(), 'src/renderer/src/components/SessionRail.tsx'),
    'utf8'
  )
  assert.match(rail, /tabIndex=\{tabStop \? 0 : -1\}/, 'rail ticks are not roving')
  assert.match(
    rail,
    /const stopIndex = Math\.max\(0, turns\.findIndex\(\(turn\) => turn\.id === activeTurnId\)\)/,
    'the rail stop is not derived from the current turn'
  )
  assert.match(rail, /tabStop=\{index === stopIndex\}/, 'history ticks ignore the stop index')
  assert.match(rail, /tabStop=\{stopIndex === turns\.length - 1\}/, 'the live tick ignores the stop index')
  // The walk has to move the stop with the keyboard, not only the focus.
  assert.match(rail, /target\.tabIndex = -1/, 'the old stop stays tabbable')
  assert.match(rail, /next\.tabIndex = 0/, 'the focused tick does not take the stop')
  // Each tick stays a button, so Enter still jumps to its turn.
  assert.match(rail, /onClick=\{\(\) => onSelect\(turn\.id\)\}/)
})
