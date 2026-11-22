/**
 * Where the tray popup opens.
 *
 * Kept apart from `tray.ts` so the arithmetic can be tested without an Electron
 * process. The popup hangs off the tray icon, and the icon does not always have
 * a rectangle: an icon Windows has pushed into the overflow flyout ("hidden
 * icons") reports a zero-sized one. The pointer is then the only thing that says
 * where the reader clicked, so it becomes the anchor.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** The gap between the icon and the popup, in the shell's pixels. */
export const POPUP_GAP = 8

function clamp(value: number, low: number, high: number): number {
  // `low` wins when the window is larger than the work area, so a popup bigger
  // than the screen still opens at the top-left corner instead of off-screen.
  return Math.max(low, Math.min(value, Math.max(low, high)))
}

/** True when the shell reported a usable rectangle for the icon. */
export function hasUsableBounds(rect: Rect | null | undefined): rect is Rect {
  return Boolean(rect && rect.width > 0 && rect.height > 0)
}

/**
 * The top-left corner for the popup.
 *
 * It is centred on the icon and opens above it, because the taskbar — and so the
 * icon — is usually at the bottom of the screen; it falls back to below the icon
 * only when there is more room there. Both axes are clamped into the display's
 * work area so the popup never lands under the taskbar or past a screen edge.
 *
 * When the shell reports no usable icon rectangle, the pointer is the anchor.
 * Without that fallback the popup was positioned from a zero-sized rectangle and
 * opened in the screen's top-left corner, far from the icon the reader clicked.
 */
export function popupPlacement(
  icon: Rect | null | undefined,
  cursor: Point,
  size: Size,
  area: Rect,
  gap = POPUP_GAP
): Point {
  // A pointer anchor has no width, so its centre is exactly the pointer — not
  // half a pixel past it.
  const anchor: Rect = hasUsableBounds(icon)
    ? icon
    : { x: cursor.x, y: cursor.y, width: 0, height: 0 }

  const x = clamp(
    Math.round(anchor.x + anchor.width / 2 - size.width / 2),
    area.x,
    area.x + area.width - size.width
  )

  const spaceAbove = anchor.y - area.y
  const spaceBelow = area.y + area.height - (anchor.y + anchor.height)
  const y =
    spaceBelow >= size.height + gap || spaceBelow >= spaceAbove
      ? anchor.y + anchor.height + gap
      : anchor.y - size.height - gap

  return {
    x,
    y: clamp(Math.round(y), area.y, area.y + area.height - size.height)
  }
}
