import test from 'node:test'
import assert from 'node:assert/strict'
import {
  INK_DARK,
  INK_LIGHT,
  accentInk,
  contrastRatio,
  relativeLuminance
} from '../src/renderer/src/lib/accent-ink'

const rgb = (hex: string) => ({
  r: Number.parseInt(hex.slice(1, 3), 16),
  g: Number.parseInt(hex.slice(3, 5), 16),
  b: Number.parseInt(hex.slice(5, 7), 16),
  a: 1
})

test('relative luminance runs black to white', () => {
  assert.equal(relativeLuminance(rgb('#000000')), 0)
  assert.equal(Number(relativeLuminance(rgb('#ffffff')).toFixed(3)), 1)
  assert.ok(relativeLuminance(rgb('#808080')) > 0.2)
})

test('contrast ratio is 21:1 at the extremes and 1:1 with itself', () => {
  assert.equal(Math.round(contrastRatio(rgb('#000000'), rgb('#ffffff'))), 21)
  assert.equal(contrastRatio(rgb('#123456'), rgb('#123456')), 1)
})

// The light theme's own accent, and every fill the design expects white on.
test('a normal accent keeps the white ink', () => {
  assert.equal(accentInk(rgb('#292929')), INK_LIGHT)
  assert.equal(accentInk(rgb('#0969da')), INK_LIGHT)
  assert.equal(accentInk(rgb('#d95b26')), INK_LIGHT)
  assert.equal(accentInk(rgb('#d97757')), INK_LIGHT)
  assert.equal(accentInk(rgb('#10a37f')), INK_LIGHT)
  assert.equal(accentInk(rgb('#3b82f6')), INK_LIGHT)
  assert.equal(accentInk(rgb('#8b5cf6')), INK_LIGHT)
  assert.equal(accentInk(rgb('#ec4899')), INK_LIGHT)
})

// The regression: a pale accent left the light theme's white ink in place, so
// the ring drawn in currentColor vanished into its own fill.
test('a pale accent flips the ink instead of hiding it', () => {
  for (const pale of ['#88c0d0', '#06b6d4', '#f59e0b']) {
    assert.equal(accentInk(rgb(pale)), INK_DARK, pale)
    assert.ok(
      contrastRatio(rgb(pale), rgb(INK_DARK)) > contrastRatio(rgb(pale), rgb(INK_LIGHT)),
      `${pale} must read better with the dark ink`
    )
  }
})

test('the chosen ink always clears the graphical floor', () => {
  const presets = ['#10a37f', '#d97757', '#d95b26', '#0969da', '#4d9375', '#88c0d0', '#292929', '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#06b6d4']
  for (const accent of presets) {
    const ink = accentInk(rgb(accent))
    const ratio = contrastRatio(rgb(accent), rgb(ink))
    assert.ok(ratio >= 3, `${accent} with ${ink} reads ${ratio.toFixed(2)}:1`)
    // White is kept exactly while it clears the floor; below it the ink flips.
    assert.equal(
      ink,
      contrastRatio(rgb(accent), rgb(INK_LIGHT)) >= 3 ? INK_LIGHT : INK_DARK,
      accent
    )
  }
})
