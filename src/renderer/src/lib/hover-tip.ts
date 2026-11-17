/**
 * Geometry and text rules for the app's hover tip.
 *
 * The native `title` tooltip is an OS bubble: it ignores the theme, waits on
 * the system timer, and cannot wrap a path. These helpers decide where the
 * app's own bubble sits and which titles are worth drawing.
 */

export const HOVER_TIP_ID = 'hover-tip'

/** The title text while the OS bubble is disarmed. React's `title` prop is put back on leave. */
export const NATIVE_TITLE_STASH = 'data-pi-tip'

const WRAP_AT = 32
const CLIP_AT = 400

export interface TipAttrHost {
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

export interface TipRect {
  left: number
  top: number
  width: number
  height: number
}

/** Move `title` aside so the OS tooltip cannot appear, keeping the text for our bubble. */
export function suppressNativeTitle(el: TipAttrHost): void {
  const title = el.getAttribute('title')
  if (title == null) return
  el.setAttribute(NATIVE_TITLE_STASH, title)
  el.removeAttribute('title')
}

/** Put the stashed title back. A title React wrote in the meantime wins. */
export function restoreNativeTitle(el: TipAttrHost): void {
  const stashed = el.getAttribute(NATIVE_TITLE_STASH)
  if (stashed == null) return
  if (el.getAttribute('title') == null) el.setAttribute('title', stashed)
  el.removeAttribute(NATIVE_TITLE_STASH)
}

/** The tip's text: the live title if React just updated it, otherwise the stash. */
export function readTipText(el: TipAttrHost): string {
  return (el.getAttribute('title') ?? el.getAttribute(NATIVE_TITLE_STASH) ?? '').trim()
}

export function clipTipText(text: string, max = CLIP_AT): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1)}…`
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * A title that repeats the words already on the control is not a tip, unless
 * those words are clipped. Icon buttons have no visible words, so they still tip.
 */
export function tipIsRedundant(title: string, visible: string, truncated: boolean): boolean {
  if (truncated) return false
  const shown = collapse(visible)
  if (!shown) return false
  return collapse(title) === shown
}

/** A filesystem path, as opposed to a sentence that happens to contain a slash. */
export function looksLikePath(text: string): boolean {
  const value = text.trim()
  if (!value || /\s/.test(value) || value.includes('://')) return false
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true
  if (value.startsWith('\\\\')) return true
  if (value.startsWith('/') && value.includes('/', 1)) return true
  if (/[\\/]/.test(value) && /\.[A-Za-z0-9]{1,8}$/.test(value)) return true
  return value.split(/[\\/]/).filter(Boolean).length >= 3
}

export function tipShape(text: string): { wrap: boolean; mono: boolean } {
  const trimmed = text.trim()
  const mono = looksLikePath(trimmed) || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  const wrap = mono || trimmed.includes('\n') || trimmed.length > WRAP_AT
  return { wrap, mono }
}

/**
 * The OS paints the caption buttons over the top of the page. `.app-menu` is
 * that band; a bubble whose top is above its bottom edge is hidden by the shell.
 * 36 matches `--titlebar-h` when the menu has not been laid out yet.
 */
export function windowShellBottom(): number {
  if (typeof document === 'undefined') return 0
  const menu = document.querySelector('.app-menu')
  if (menu instanceof HTMLElement) {
    const bottom = menu.getBoundingClientRect().bottom
    if (bottom > 0) return Math.ceil(bottom)
  }
  return 36
}

/**
 * Sit the bubble beside the pointer without covering the control, leaving the
 * window, or sliding under the caption buttons. Above is preferred only when
 * the whole bubble stays clear of that shell; otherwise it goes below.
 */
export function placeHoverTip(
  anchor: TipRect,
  tip: { width: number; height: number },
  cursor: { x: number; y: number } | null,
  viewport: { width: number; height: number },
  edge = 8,
  gap = 8,
  shell = 0
): { left: number; top: number } {
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
  const topLimit = Math.max(edge, shell)
  const maxLeft = Math.max(edge, viewport.width - edge - tip.width)
  const maxTop = Math.max(topLimit, viewport.height - edge - tip.height)
  const originX = cursor?.x ?? anchor.left + anchor.width / 2
  const left = clamp(originX - tip.width / 2, edge, maxLeft)
  const fits = (top: number) => top >= topLimit && top + tip.height <= viewport.height - edge

  const above = anchor.top - gap - tip.height
  const below = anchor.top + anchor.height + gap
  let top: number
  if (anchor.height > 72 && cursor) {
    const over = cursor.y - gap - tip.height
    const under = cursor.y + gap
    top = fits(over) ? over : fits(under) ? under : clamp(under, topLimit, maxTop)
  } else if (fits(above)) {
    top = above
  } else if (fits(below)) {
    top = below
  } else {
    top = clamp(below, topLimit, maxTop)
  }
  return { left: Math.round(left), top: Math.round(top) }
}
