/**
 * The four UI text sizes, expressed as a multiplier of the 14px standard body.
 *
 * MCode stores these as UI base sizes 12 / 14 / 15 / 16 (Standard 14). The
 * ratio is what the renderer's `--font-scale` consumes, so every role in
 * `tokens.css` grows by the same step the preset names promise.
 */
export const FONT_SCALE_PRESETS = [12 / 14, 1, 15 / 14, 16 / 14] as const

export const FONT_SCALE_LABELS = ['Small', 'Standard', 'Large', 'Extra large'] as const

/**
 * Values stored by older builds. `0.92 / 1.1 / 1.22` were tuned for a 13–14px
 * base and would otherwise land between, or entirely outside, the presets.
 */
const LEGACY_FONT_SCALE: Record<string, number> = {
  '0.92': FONT_SCALE_PRESETS[0],
  '1': FONT_SCALE_PRESETS[1],
  '1.1': FONT_SCALE_PRESETS[2],
  '1.22': FONT_SCALE_PRESETS[3]
}

/** The exact multiplier to paint, translating a legacy stored value once. */
export function normalizeFontScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return LEGACY_FONT_SCALE[String(value)] ?? value
}

/** The preset a stored scale belongs to; legacy and odd values snap to the
 *  nearest step so the launcher's larger/smaller actions cannot invert. */
export function nearestFontStepIndex(value: unknown): number {
  const scale = normalizeFontScale(value)
  let best = 0
  for (let index = 1; index < FONT_SCALE_PRESETS.length; index += 1) {
    if (
      Math.abs(FONT_SCALE_PRESETS[index] - scale) <
      Math.abs(FONT_SCALE_PRESETS[best] - scale)
    ) {
      best = index
    }
  }
  return best
}
