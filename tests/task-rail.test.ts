import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { toggleTaskRail } from '../src/renderer/src/lib/task-rail'

/**
 * The regression: pressing the task-rail toggle in a narrow window was a loan
 * for the panel episode. It only wrote `narrowOverride`, and closing the docked
 * panel widened the stage again — the override was dropped and the rail fell
 * back to the old base value. A reader who pressed "show task status" watched
 * the same control undo itself one click later.
 */

test('a wide press flips the preference and leaves the narrow word alone', () => {
  assert.deepEqual(toggleTaskRail({ narrow: false, narrowOverride: null, base: true }), {
    narrowOverride: null,
    base: false
  })
  assert.deepEqual(toggleTaskRail({ narrow: false, narrowOverride: null, base: false }), {
    narrowOverride: null,
    base: true
  })
  // A stale episode word is not turned into a preference and not cleared here;
  // `App` clears it when the stage widens again.
  assert.deepEqual(toggleTaskRail({ narrow: false, narrowOverride: true, base: true }), {
    narrowOverride: true,
    base: false
  })
})

test('a narrow press moves the preference with the rail, so the panel close cannot undo it', () => {
  // The stage is narrow and the reader has not spoken: the rail is folded.
  // Pressing shows it, and both values say so — the close that widens the stage
  // then keeps it visible.
  assert.deepEqual(toggleTaskRail({ narrow: true, narrowOverride: null, base: true }), {
    narrowOverride: true,
    base: true
  })
  assert.deepEqual(toggleTaskRail({ narrow: true, narrowOverride: null, base: false }), {
    narrowOverride: true,
    base: true
  })
  // Pressing again hides it just as completely, so widening the stage does not
  // bring back a rail the reader just folded.
  assert.deepEqual(toggleTaskRail({ narrow: true, narrowOverride: true, base: true }), {
    narrowOverride: false,
    base: false
  })
  assert.deepEqual(toggleTaskRail({ narrow: true, narrowOverride: true, base: false }), {
    narrowOverride: false,
    base: false
  })
})

test('every narrow press leaves the two values in agreement', () => {
  for (const base of [true, false]) {
    for (const narrowOverride of [null, true, false]) {
      const press = toggleTaskRail({ narrow: true, narrowOverride, base })
      assert.equal(
        press.narrowOverride,
        press.base,
        `a narrow press disagreed with itself (base ${base}, override ${narrowOverride})`
      )
    }
  }
})

test('App keeps the auto-fold default and applies the press to both values', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  assert.match(source, /import \{ toggleTaskRail \} from '\.\/lib\/task-rail'/, 'App no longer uses the rule')
  assert.match(source, /setNarrowTaskOverride\(next\.narrowOverride\)/, 'the narrow word is not written')
  assert.match(source, /setTaskRailOpen\(next\.base\)/, 'the preference is not written with it')
  assert.match(
    source,
    /if \(!narrowMainStage\) setNarrowTaskOverride\(null\)/,
    'the next narrow episode no longer starts folded'
  )
})
