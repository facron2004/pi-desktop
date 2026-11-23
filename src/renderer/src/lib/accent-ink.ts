/**
 * The ink that sits on an accent fill.
 *
 * `--accent-contrast` used to be a static theme token while `applyAppearance`
 * repainted `--accent` from the reader's choice, so the two could disagree: a
 * pale accent (Nord's cyan, Amber, Cyan) kept the light theme's white ink, and
 * the download ring drawn inside the update button — `currentColor` on
 * `--accent` — disappeared into its own fill.
 *
 * The rule is a threshold on white, not "whichever scores higher": white is
 * the design's ink on a filled accent, so it stays unless it fails the 3:1
 * graphical floor. That keeps white on every normal accent — the light theme's
 * own `#292929`, GitHub's blue, Claude's terracotta, Pi's orange, OpenAI's
 * green — and flips only a genuinely pale fill, where the ring would otherwise
 * disappear into it.
 */

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** The ink the themes use on an accent: white, or the dark theme's own ink. */
export const INK_LIGHT = '#ffffff'
export const INK_DARK = '#080b11'

/** WCAG's floor for a graphical object or large text. */
const MIN_GRAPHICAL_CONTRAST = 3

function channel(value: number): number {
  const scaled = Math.min(255, Math.max(0, value)) / 255
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance. */
export function relativeLuminance(color: Pick<Rgba, 'r' | 'g' | 'b'>): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

/** WCAG contrast ratio, 1..21. */
export function contrastRatio(
  left: Pick<Rgba, 'r' | 'g' | 'b'>,
  right: Pick<Rgba, 'r' | 'g' | 'b'>
): number {
  const [lighter, darker] = [relativeLuminance(left), relativeLuminance(right)].sort((a, b) => b - a)
  return (lighter + 0.05) / (darker + 0.05)
}

const WHITE = { r: 255, g: 255, b: 255 }

/**
 * The ink to write on `accent`: white while it clears the graphical floor,
 * otherwise the dark ink the themes already use.
 */
export function accentInk(color: Pick<Rgba, 'r' | 'g' | 'b'>): string {
  return contrastRatio(color, WHITE) >= MIN_GRAPHICAL_CONTRAST ? INK_LIGHT : INK_DARK
}
