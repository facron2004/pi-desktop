/**
 * Pure geometry and dismissal helpers for `SidebarTip` / `useHoverTip`.
 *
 * Kept DOM-free so the rules that stop a floating card from getting stranded
 * (detached anchors, clipped scroll items, dropped `mouseleave` events) can be
 * unit-tested directly under Node.
 */

export interface TipRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface TipPoint {
  x: number
  y: number
}

export type TipTriggerSource = 'pointer' | 'focus'
export type TipDismissAction = 'dismiss' | 'leave' | 'keep'

export function isRectVisibleInBounds(rect: TipRect, bounds: TipRect): boolean {
  if (rect.width <= 0 && rect.height <= 0) return false
  if (bounds.width <= 0 || bounds.height <= 0) return false
  return (
    rect.bottom > bounds.top &&
    rect.top < bounds.bottom &&
    rect.right > bounds.left &&
    rect.left < bounds.right
  )
}

export function rectContainsPoint(rect: TipRect, point: TipPoint, tolerance = 1): boolean {
  if (rect.width <= 0 && rect.height <= 0) return false
  return (
    point.x >= rect.left - tolerance &&
    point.x <= rect.right + tolerance &&
    point.y >= rect.top - tolerance &&
    point.y <= rect.bottom + tolerance
  )
}

/**
 * Whether an anchor element is still connected and visibly intersecting both
 * the viewport and every clipping scroll ancestor.
 */
export function isAnchorRectVisible(
  connected: boolean,
  rect: TipRect | null,
  clipRects: readonly TipRect[],
  viewport: { width: number; height: number }
): boolean {
  if (!connected || !rect) return false
  const viewportRect: TipRect = {
    left: 0,
    top: 0,
    right: viewport.width,
    bottom: viewport.height,
    width: viewport.width,
    height: viewport.height
  }
  if (!isRectVisibleInBounds(rect, viewportRect)) return false
  for (const clip of clipRects) {
    if (!isRectVisibleInBounds(rect, clip)) return false
  }
  return true
}

/**
 * Decide how an active pointer-opened hover tip reacts to a global
 * `pointermove`. A dropped `mouseleave` (common when moving rapidly off a
 * portal or closing a popover) falls back to `leave` so row-to-row gliding
 * keeps its grace period, while a detached or invisible anchor dismisses
 * immediately.
 */
export function decidePointerMoveDismiss(
  source: TipTriggerSource,
  anchorVisible: boolean,
  triggerContainsTarget: boolean
): TipDismissAction {
  if (!anchorVisible) return 'dismiss'
  if (source !== 'pointer') return 'keep'
  return triggerContainsTarget ? 'keep' : 'leave'
}

/**
 * Decide how an active hover tip reacts to a scroll event. Any anchor scrolled
 * completely out of view dismisses immediately; a pointer-opened card whose
 * ancestor scrolled the anchor away from under the stationary cursor starts a
 * graceful `leave` so the card never trails an unselected row.
 */
export function decideScrollDismiss(
  source: TipTriggerSource,
  anchorVisible: boolean,
  scrolledAncestor: boolean,
  rect: TipRect | null,
  pointer: TipPoint | null
): TipDismissAction {
  if (!anchorVisible) return 'dismiss'
  if (source !== 'pointer' || !scrolledAncestor || !rect || !pointer) return 'keep'
  return rectContainsPoint(rect, pointer) ? 'keep' : 'leave'
}
