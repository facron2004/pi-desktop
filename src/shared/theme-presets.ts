/**
 * The appearance themes.
 *
 * A preset is not a stylesheet: it fills the three colours the appearance page
 * owns — the accent, the canvas and the ink — and `applyAppearance` derives the
 * rest of the token set (sidebar, chrome, hover, the text tiers) from them. Two
 * presets that shared a triple were therefore pixel-identical. That is exactly
 * what had happened: ChatGPT and Claude both wrote Claude's terracotta
 * (`#D97757`) over canvas colours one unit apart (`#FAF9F5` / `#FBF9F5`), and
 * Pi and GitHub both wrote a pure-white canvas, so four of the six themes named
 * two looks. Every accent and every canvas below is distinct, and each one is
 * the product's own colour rather than an approximation of it;
 * `tests/theme-presets.test.ts` guards the rule.
 *
 * Names are English keys so the UI can translate them.
 */

export interface ThemePalette {
  /** The canvas painted behind everything. */
  bg: string
  /** The ink body text is written in. */
  fg: string
}

export interface ThemePreset {
  id: string
  name: string
  accent: string
  light: ThemePalette
  dark: ThemePalette
}

export const THEME_PRESETS: readonly ThemePreset[] = [
  // OpenAI's sign-in green over its own chat grey (light) and charcoal (dark).
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    accent: '#10A37F',
    light: { bg: '#F7F7F8', fg: '#0D0D0D' },
    dark: { bg: '#212121', fg: '#ECECEC' }
  },
  // Anthropic's terracotta over the warm paper of claude.ai.
  {
    id: 'claude',
    name: 'Claude',
    accent: '#D97757',
    light: { bg: '#FAF9F5', fg: '#1F1E1D' },
    dark: { bg: '#262624', fg: '#F4F4F5' }
  },
  // The app's own canvas and its coral: the only preset that may be pure white.
  {
    id: 'pi',
    name: 'Pi Classic',
    accent: '#D95B26',
    light: { bg: '#FFFFFF', fg: '#242424' },
    dark: { bg: '#16181D', fg: '#F2F4F8' }
  },
  // GitHub's canvas-subtle rather than its white, which Pi Classic already owns.
  {
    id: 'github',
    name: 'GitHub',
    accent: '#0969DA',
    light: { bg: '#F6F8FA', fg: '#000000' },
    dark: { bg: '#0D1117', fg: '#E6EDF3' }
  },
  // Vitesse's sage green and its soft grey paper.
  {
    id: 'vitesse',
    name: 'Vitesse',
    accent: '#4D9375',
    light: { bg: '#FAFAFA', fg: '#393A34' },
    dark: { bg: '#121212', fg: '#DBDBDB' }
  },
  // Nord's Polar Night / Snow Storm pair, already distinct by design.
  {
    id: 'nord',
    name: 'Nord',
    accent: '#88C0D0',
    light: { bg: '#ECEFF4', fg: '#2E3440' },
    dark: { bg: '#2E3440', fg: '#ECEFF4' }
  }
]

/** The theme id that keeps the app's built-in tokens. */
export const DEFAULT_THEME_ID = 'default'
/** The theme id that means "the colours below were chosen by hand". */
export const CUSTOM_THEME_ID = 'custom'

/**
 * The hand-pickable accents. `custom` keeps whatever the colour picker holds,
 * so it has no value of its own; every other entry is a hex the presets above
 * also use, named the way the product that owns it names it.
 */
export const ACCENT_PRESETS: readonly { label: string; value: string }[] = [
  { label: 'Custom', value: CUSTOM_THEME_ID },
  { label: 'Terracotta (Claude)', value: '#D97757' },
  { label: 'Classic Orange (Pi)', value: '#D95B26' },
  { label: 'Emerald (OpenAI)', value: '#10A37F' },
  { label: 'Ocean Blue', value: '#3B82F6' },
  { label: 'Violet', value: '#8B5CF6' },
  { label: 'Rose', value: '#EC4899' },
  { label: 'Amber', value: '#F59E0B' },
  { label: 'Cyan', value: '#06B6D4' }
]

export const TONE_PRESETS: readonly { id: string; label: string }[] = [
  { id: 'neutral', label: 'Normal contrast' },
  { id: 'contrast', label: 'High contrast' }
]

export function findThemePreset(id?: string | null): ThemePreset | undefined {
  if (!id) return undefined
  return THEME_PRESETS.find((preset) => preset.id === id)
}

/** The palette a preset paints in one mode. */
export function presetPalette(preset: ThemePreset, dark: boolean): ThemePalette {
  return dark ? preset.dark : preset.light
}

/**
 * What each preset wrote before the palettes were de-duplicated. `pi` and
 * `nord` never moved and are absent.
 */
const LEGACY_PRESETS: Record<string, ThemePreset> = {
  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT',
    accent: '#D97757',
    light: { bg: '#FAF9F5', fg: '#141413' },
    dark: { bg: '#212121', fg: '#ECECEC' }
  },
  claude: {
    id: 'claude',
    name: 'Claude',
    accent: '#D97757',
    light: { bg: '#FBF9F5', fg: '#1F1E1D' },
    dark: { bg: '#18181B', fg: '#F4F4F5' }
  },
  github: {
    id: 'github',
    name: 'GitHub',
    accent: '#0969DA',
    light: { bg: '#FFFFFF', fg: '#000000' },
    dark: { bg: '#0D1117', fg: '#E6EDF3' }
  },
  vitesse: {
    id: 'vitesse',
    name: 'Vitesse',
    accent: '#4D9375',
    light: { bg: '#FAFAFA', fg: '#374151' },
    dark: { bg: '#121212', fg: '#DBDBDB' }
  }
}

const sameColor = (a: string | undefined, b: string | undefined): boolean =>
  typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * A saved preset stores the colours it was written with, so a palette that
 * moved would leave the old colours behind forever: picking "ChatGPT" still
 * painted Claude's terracotta over cream. Move a stored colour to the current
 * palette, but only while it is still exactly what the old preset wrote — a
 * colour the user picked themselves is never touched.
 *
 * Returns the resolved trio so the caller cannot apply half a migration.
 */
export function migratePresetColors(input: {
  themePreset?: string
  accentColor?: string
  customBg?: string
  customFg?: string
}): { accentColor?: string; customBg?: string; customFg?: string } {
  const { themePreset, accentColor, customBg, customFg } = input
  const current = findThemePreset(themePreset)
  const legacy = themePreset ? LEGACY_PRESETS[themePreset] : undefined
  if (!current || !legacy) return { accentColor, customBg, customFg }

  const nextAccent = sameColor(accentColor, legacy.accent) ? current.accent : accentColor
  let nextBg = customBg
  let nextFg = customFg
  if (sameColor(customBg, legacy.light.bg) && sameColor(customFg, legacy.light.fg)) {
    nextBg = current.light.bg
    nextFg = current.light.fg
  } else if (sameColor(customBg, legacy.dark.bg) && sameColor(customFg, legacy.dark.fg)) {
    nextBg = current.dark.bg
    nextFg = current.dark.fg
  }
  return { accentColor: nextAccent, customBg: nextBg, customFg: nextFg }
}
