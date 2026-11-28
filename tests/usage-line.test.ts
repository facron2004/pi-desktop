import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { usageReadingsVisible } from '../src/renderer/src/lib/usage-line'

/**
 * The usage line is a report on a turn, not a live readout.
 *
 * Two things are load-bearing and are checked here without a DOM:
 *
 * - the readings appear only once the run has settled, so a prompt the reader
 *   interjected never turns the line into a figure for a half-finished turn;
 * - the context ring is not one of those readings, so it keeps drawing while
 *   the run goes.
 *
 * The composer half of the rule — an interjection always steers the running
 * turn — is pinned from the sources it lives in.
 */

const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), 'utf8')

test('a settled turn prints its readings', () => {
  assert.equal(usageReadingsVisible({ phase: 'idle', settled: true }, false), true)
  assert.equal(
    usageReadingsVisible({ phase: 'idle', settled: true, outcome: 'completed' } as never, false),
    true
  )
})

test('a live run prints no readings', () => {
  // Streaming is the plain case, and it outranks a stale settled flag: the
  // transcript is already moving again.
  assert.equal(usageReadingsVisible({ phase: 'generating', settled: false }, true), false)
  assert.equal(usageReadingsVisible({ phase: 'idle', settled: true }, true), false)
})

test('the window between handing Pi a prompt and its first event prints nothing', () => {
  // `queued` has no events yet and `aborting` has a stop on its way: both are
  // runs in flight, and both would print a figure for a turn nobody can read
  // yet.
  assert.equal(usageReadingsVisible({ phase: 'queued', settled: false }, false), false)
  assert.equal(usageReadingsVisible({ phase: 'aborting', settled: false }, false), false)
  assert.equal(usageReadingsVisible({ phase: 'waiting_approval', settled: false }, false), false)
})

test('an interjection keeps the line empty until the turn it joined finishes', () => {
  // The reader typed into a live run: the run is still the same run, so the
  // line stays a ring until Pi settles it.
  const live = { phase: 'working', settled: false }
  assert.equal(usageReadingsVisible(live, true), false)
  assert.equal(usageReadingsVisible({ ...live, settled: true }, false), true)
})

test('the composer keeps the ring and hides the readings while a run is open', () => {
  const bar = read('src/renderer/src/components/UsageBar.tsx')
  assert.match(
    bar,
    /if \(!usageReadingsVisible\(run, slice\.isStreaming\)\) \{[\s\S]{0,200}?<ContextRing sessionKey=\{sessionKey\} \/>/,
    'a live run no longer draws the context ring on its own'
  )
  const guard = bar.slice(bar.indexOf('usageReadingsVisible(run'), bar.indexOf('const countLabel'))
  assert.doesNotMatch(guard, /usage-bar__control/, 'the readings survived the live-run guard')
  // The live model clock went with the readings: a hidden number cannot tick.
  assert.doesNotMatch(bar, /setInterval/, 'the line still runs a clock for numbers it does not print')
})

test('an interjection always steers the running turn', () => {
  const composer = read('src/renderer/src/components/Composer.tsx')
  assert.match(composer, /const kind: QueueKind = 'steer'/, 'the composer no longer steers every prompt')
  assert.doesNotMatch(composer, /followUpMode/, 'the composer still reads the queue-or-steer preference')
  const settings = read('src/renderer/src/components/settings/GeneralSettings.tsx')
  assert.doesNotMatch(
    settings,
    /Follow-up handling method/,
    'Settings still offers a delivery choice the composer ignores'
  )
  const search = read('src/renderer/src/lib/settings-search.ts')
  assert.doesNotMatch(search, /Follow-up handling method/, 'settings search still lists the retired row')
})
