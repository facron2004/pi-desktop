/**
 * The UI type stack the Appearance picker writes onto the document.
 *
 * The rule this module exists for: **the chosen face comes first.**
 *
 * `--font-cjk` is a local face whose `unicode-range` covers every CJK block, so
 * wherever it appears it claims all Chinese glyphs ahead of anything after it.
 * Leading the stack with it — which the app used to do — made the Appearance
 * font affect Latin only: picking a serif font drew the English in that serif
 * while every Chinese character stayed in Microsoft YaHei. The face protects a
 * *generic* family; it never competes with the user's choice.
 *
 * It is still needed for one stack: Windows links the generic `monospace`
 * family to NSimSun (a serif), so the code stack has to name a sans CJK face
 * after JetBrains Mono and before `monospace`. Measured through CDP
 * `CSS.getPlatformFontsForNode`:
 *
 *   'JetBrains Mono', … , monospace                      -> NSimSun
 *   'JetBrains Mono', … , 'Pi Desktop CJK', monospace     -> JetBrains Mono + YaHei
 *   'Noto Serif SC', 'Noto Sans SC', sans-serif           -> Noto Serif SC (all)
 *   'Pi Desktop CJK', 'Noto Serif SC', sans-serif         -> YaHei (the old bug)
 *   -apple-system, …, sans-serif                          -> Noto Sans SC + Segoe UI
 *   -apple-system, …, 'Pi Desktop CJK', sans-serif        -> YaHei + Segoe UI
 *
 * The last two are why the UI stack does not carry the face: `sans-serif`
 * already links Chinese to a sans face (Noto Sans SC here), and naming the
 * CJK face in front of it would silently override the documented default.
 */

/** The registered local face that only covers CJK code points. */
export const CJK_FACE = 'var(--font-cjk)'

/** The registered colour-emoji face (see `Pi Desktop Emoji` in tokens.css). */
export const EMOJI_FACE = 'var(--font-emoji)'

/**
 * Names that give Chinese a sans face on the platforms the app ships to,
 * placed after the chosen family so they only serve the glyphs it lacks.
 */
const CJK_SANS_NET = '"Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei"'

/** The installed PingFang copies register under both names; keep both. */
const PINGFANG_NET = '"PingFang SC", "苹方", "苹方-简", "Microsoft YaHei UI", "Microsoft YaHei"'

/**
 * The picker's named presets. Each already carries whatever CJK fallback it
 * needs, so the caller appends nothing.
 */
const PRESETS: Record<string, string> = {
  // The system recipe: Latin from the platform UI face, Chinese from the
  // generic sans-serif link (Noto Sans SC on this machine). No CJK face here.
  sans: `-apple-system, BlinkMacSystemFont, 'Segoe UI', ${EMOJI_FACE}, sans-serif`,
  chinese: `${PINGFANG_NET}, sans-serif`,
  // The one stack that must name a CJK face: generic monospace is serif-linked.
  mono: `'JetBrains Mono', 'SF Mono', 'Cascadia Code', Consolas, ${CJK_FACE}, ${EMOJI_FACE}, monospace`,
  serif: `'Newsreader', 'Georgia', serif`
}

/**
 * Weight-named PingFang faces are registered individually (see global.css), so
 * the picker can offer `PingFang SC Medium` as a family of its own.
 */
const PINGFANG_WEIGHTS: Record<string, string> = {
  'PingFang SC': PINGFANG_NET,
  'PingFang SC Regular': `"PingFang SC Regular", ${PINGFANG_NET}`,
  'PingFang SC Medium': `"PingFang SC Medium", ${PINGFANG_NET}`,
  'PingFang SC Bold': `"PingFang SC Bold", ${PINGFANG_NET}`
}

/** A value the picker writes that is already a full CSS family list. */
function isFamilyList(value: string): boolean {
  return value.includes(',') || value.includes('"') || value.includes("'")
}

/**
 * The `font-family` value for a stored `fontFamily` setting, or `null` when the
 * setting means "no override" and the tokens in `tokens.css` should apply.
 */
export function uiFontStack(fontFamily: string | undefined): string | null {
  const chosen = fontFamily?.trim()
  if (!chosen || chosen === 'system') return null
  if (PRESETS[chosen]) return PRESETS[chosen]
  if (PINGFANG_WEIGHTS[chosen]) return `${PINGFANG_WEIGHTS[chosen]}, ${EMOJI_FACE}, sans-serif`
  // An arbitrary installed family, or a list the user pasted into settings.
  const family = isFamilyList(chosen) ? chosen : `"${chosen}"`
  return `${family}, ${CJK_SANS_NET}, ${EMOJI_FACE}, sans-serif`
}

/** The tokens a chosen font replaces. Kept together so they cannot drift. */
export const FONT_STACK_PROPERTIES = ['--font-ui', '--font-sidebar', '--font-reading'] as const
