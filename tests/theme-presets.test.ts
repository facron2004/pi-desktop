import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACCENT_PRESETS,
  CUSTOM_THEME_ID,
  DEFAULT_THEME_ID,
  THEME_PRESETS,
  TONE_PRESETS,
  findThemePreset,
  migratePresetColors,
  presetPalette
} from '../src/shared/theme-presets'

const HEX = /^#[0-9a-f]{6}$/i

/** WCAG relative luminance, for the "this preset is readable" check. */
function luminance(hex: string): number {
  const channel = (part: string): number => {
    const value = Number.parseInt(part, 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const [r, g, b] = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map(channel)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

test('every preset is a well-formed palette', () => {
  assert.ok(THEME_PRESETS.length >= 6, 'the six themes the appearance page offers')
  for (const preset of THEME_PRESETS) {
    assert.match(preset.id, /^[a-z0-9-]+$/, `${preset.id} is a settings value`)
    assert.ok(preset.name.length > 0, `${preset.id} has a label`)
    assert.match(preset.accent, HEX, `${preset.id} accent`)
    assert.match(preset.light.bg, HEX, `${preset.id} light canvas`)
    assert.match(preset.light.fg, HEX, `${preset.id} light ink`)
    assert.match(preset.dark.bg, HEX, `${preset.id} dark canvas`)
    assert.match(preset.dark.fg, HEX, `${preset.id} dark ink`)
  }
})

test('no two presets share a name or an id', () => {
  assert.equal(new Set(THEME_PRESETS.map((p) => p.id)).size, THEME_PRESETS.length)
  assert.equal(new Set(THEME_PRESETS.map((p) => p.name)).size, THEME_PRESETS.length)
})

// The regression: ChatGPT and Claude both wrote Claude's terracotta #D97757,
// so the two presets painted the same accent and could not be told apart.
test('no two presets share an accent', () => {
  const accents = THEME_PRESETS.map((p) => p.accent.toLowerCase())
  assert.equal(new Set(accents).size, accents.length, accents.join(', '))
})

// The other half of the regression: Pi and GitHub both painted #FFFFFF, and
// ChatGPT/Claude differed by one unit in each channel.
test('every preset paints a canvas of its own, in both modes', () => {
  for (const mode of ['light', 'dark'] as const) {
    const canvases = THEME_PRESETS.map((p) => p[mode].bg.toLowerCase())
    assert.equal(
      new Set(canvases).size,
      canvases.length,
      `${mode} canvases: ${canvases.join(', ')}`
    )
    const inks = THEME_PRESETS.map((p) => p[mode].fg.toLowerCase())
    assert.equal(new Set(inks).size, inks.length, `${mode} inks: ${inks.join(', ')}`)
  }
})

// Names are not enough: two palettes one RGB unit apart read as the same
// theme. Every pair must differ in a way a reader can see.
test('any two presets differ visibly, not just by a name', () => {
  const distance = (a: string, b: string): number =>
    Math.abs(Number.parseInt(a.slice(1, 3), 16) - Number.parseInt(b.slice(1, 3), 16)) +
    Math.abs(Number.parseInt(a.slice(3, 5), 16) - Number.parseInt(b.slice(3, 5), 16)) +
    Math.abs(Number.parseInt(a.slice(5, 7), 16) - Number.parseInt(b.slice(5, 7), 16))
  for (let i = 0; i < THEME_PRESETS.length; i++) {
    for (let j = i + 1; j < THEME_PRESETS.length; j++) {
      const a = THEME_PRESETS[i]
      const b = THEME_PRESETS[j]
      // Either the accent separates them, or the canvas does, or both.
      const accentApart = distance(a.accent, b.accent) >= 24
      const canvasApart =
        distance(a.light.bg, b.light.bg) >= 6 || distance(a.dark.bg, b.dark.bg) >= 6
      assert.ok(
        accentApart || canvasApart,
        `${a.id} and ${b.id} are too close to tell apart (${a.accent} vs ${b.accent})`
      )
    }
  }
})

test('a preset stays readable: its ink clears body text on its canvas', () => {
  for (const preset of THEME_PRESETS) {
    for (const mode of ['light', 'dark'] as const) {
      const palette = presetPalette(preset, mode === 'dark')
      const ratio = contrast(palette.fg, palette.bg)
      assert.ok(ratio >= 7, `${preset.id} ${mode} contrast ${ratio.toFixed(1)}:1`)
    }
  }
})

test('presetPalette answers the mode it was asked for', () => {
  for (const preset of THEME_PRESETS) {
    assert.deepEqual(presetPalette(preset, false), preset.light)
    assert.deepEqual(presetPalette(preset, true), preset.dark)
  }
})

test('findThemePreset resolves ids and refuses the two non-presets', () => {
  assert.equal(findThemePreset('pi')?.name, 'Pi Classic')
  assert.equal(findThemePreset(undefined), undefined)
  assert.equal(findThemePreset(''), undefined)
  assert.equal(findThemePreset(DEFAULT_THEME_ID), undefined)
  assert.equal(findThemePreset(CUSTOM_THEME_ID), undefined)
  assert.equal(findThemePreset('nope'), undefined)
})

test('the accent menu is well formed and keeps one custom row', () => {
  const custom = ACCENT_PRESETS.filter((p) => p.value === CUSTOM_THEME_ID)
  assert.equal(custom.length, 1)
  const colors = ACCENT_PRESETS.filter((p) => p.value !== CUSTOM_THEME_ID).map((p) =>
    p.value.toLowerCase()
  )
  assert.equal(new Set(colors).size, colors.length, 'no duplicated swatch')
  for (const color of colors) assert.match(color, HEX)
})

test('the tone menu offers exactly the two contrast levels', () => {
  assert.deepEqual(
    TONE_PRESETS.map((tone) => tone.id),
    ['neutral', 'contrast']
  )
})

// A saved preset stores the colours it was written with. Without the
// migration, picking ChatGPT kept painting Claude's terracotta forever.
test('a stored preset colour moves onto the de-duplicated palette', () => {
  const legacyChatGptLight = migratePresetColors({
    themePreset: 'chatgpt',
    accentColor: '#D97757',
    customBg: '#FAF9F5',
    customFg: '#141413'
  })
  assert.equal(legacyChatGptLight.accentColor, '#10A37F')
  assert.equal(legacyChatGptLight.customBg, '#F7F7F8')
  assert.equal(legacyChatGptLight.customFg, '#0D0D0D')

  const legacyChatGptDark = migratePresetColors({
    themePreset: 'chatgpt',
    accentColor: '#D97757',
    customBg: '#212121',
    customFg: '#ECECEC'
  })
  assert.equal(legacyChatGptDark.customBg, '#212121', 'that half never moved')

  // Pi already owned the pure white, so GitHub's canvas is what moved.
  const legacyGitHub = migratePresetColors({
    themePreset: 'github',
    accentColor: '#0969DA',
    customBg: '#FFFFFF',
    customFg: '#000000'
  })
  assert.equal(legacyGitHub.customBg, '#F6F8FA')
  assert.equal(legacyGitHub.accentColor, '#0969DA')
})

test('a colour the reader chose is never overwritten', () => {
  const kept = migratePresetColors({
    themePreset: 'chatgpt',
    accentColor: '#3B82F6',
    customBg: '#101010',
    customFg: '#F0F0F0'
  })
  assert.equal(kept.accentColor, '#3B82F6')
  assert.equal(kept.customBg, '#101010')
  assert.equal(kept.customFg, '#F0F0F0')

  // A canvas that matches but an ink that does not is still the reader's pair.
  const halfCustom = migratePresetColors({
    themePreset: 'claude',
    customBg: '#FBF9F5',
    customFg: '#123456'
  })
  assert.equal(halfCustom.customBg, '#FBF9F5')
  assert.equal(halfCustom.customFg, '#123456')
})

test('presets that never moved and non-presets are left alone', () => {
  const pi = migratePresetColors({
    themePreset: 'pi',
    accentColor: '#D95B26',
    customBg: '#FFFFFF',
    customFg: '#242424'
  })
  assert.deepEqual(pi, { accentColor: '#D95B26', customBg: '#FFFFFF', customFg: '#242424' })

  const custom = migratePresetColors({
    themePreset: CUSTOM_THEME_ID,
    accentColor: '#D97757',
    customBg: '#FAF9F5',
    customFg: '#141413'
  })
  assert.deepEqual(custom, {
    accentColor: '#D97757',
    customBg: '#FAF9F5',
    customFg: '#141413'
  })

  const none = migratePresetColors({})
  assert.deepEqual(none, { accentColor: undefined, customBg: undefined, customFg: undefined })
})
