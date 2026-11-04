import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FONT_SCALE_LABELS,
  FONT_SCALE_PRESETS,
  nearestFontStepIndex,
  normalizeFontScale
} from '../src/shared/font-scale'

test('the four presets are MCode UI bases 12/14/15/16 against the 14px body', () => {
  assert.equal(FONT_SCALE_PRESETS.length, 4)
  assert.equal(FONT_SCALE_PRESETS[0], 12 / 14)
  assert.equal(FONT_SCALE_PRESETS[1], 1)
  assert.equal(FONT_SCALE_PRESETS[2], 15 / 14)
  assert.equal(FONT_SCALE_PRESETS[3], 16 / 14)
  assert.deepEqual([...FONT_SCALE_LABELS], ['Small', 'Standard', 'Large', 'Extra large'])
})

test('legacy stored multipliers migrate to the corresponding MCode preset', () => {
  assert.equal(normalizeFontScale(0.92), FONT_SCALE_PRESETS[0])
  assert.equal(normalizeFontScale(1.1), FONT_SCALE_PRESETS[2])
  assert.equal(normalizeFontScale(1.22), FONT_SCALE_PRESETS[3])
})

test('scale values that were already current stay untouched', () => {
  assert.equal(normalizeFontScale(1), 1)
  for (const preset of FONT_SCALE_PRESETS) assert.equal(normalizeFontScale(preset), preset)
  assert.equal(normalizeFontScale(1.05), 1.05)
})

test('missing or invalid scales fall back to Standard', () => {
  assert.equal(normalizeFontScale(undefined), 1)
  assert.equal(normalizeFontScale(null), 1)
  assert.equal(normalizeFontScale('1.1'), 1)
  assert.equal(normalizeFontScale(Number.NaN), 1)
})

test('the launcher steps from the nearest preset, so a legacy value cannot invert', () => {
  assert.equal(nearestFontStepIndex(0.92), 0)
  assert.equal(nearestFontStepIndex(1), 1)
  assert.equal(nearestFontStepIndex(1.1), 2)
  assert.equal(nearestFontStepIndex(1.22), 3)
  // A value between steps snaps to one side rather than returning -1.
  assert.equal(nearestFontStepIndex(0.95), 1)
  assert.equal(nearestFontStepIndex(99), 3)
})
