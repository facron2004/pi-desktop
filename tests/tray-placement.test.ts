import test from 'node:test'
import assert from 'node:assert/strict'
import {
  hasUsableBounds,
  popupPlacement,
  POPUP_GAP,
  type Rect
} from '../src/main/tray-placement'

/** A 1920x1080 display with a 40px taskbar along the bottom. */
const AREA: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
const SIZE = { width: 300, height: 210 }

/** A tray icon sitting in the bottom taskbar. */
const ICON: Rect = { x: 1800, y: 1040, width: 32, height: 40 }

test('an icon with a real rectangle is a usable anchor', () => {
  assert.equal(hasUsableBounds(ICON), true)
  assert.equal(hasUsableBounds({ x: 10, y: 10, width: 0, height: 0 }), false)
  assert.equal(hasUsableBounds(null), false)
  assert.equal(hasUsableBounds(undefined), false)
})

test('the popup is centred on the icon and opens above it', () => {
  // An icon in the middle of the taskbar, so no edge clamp interferes.
  const middle: Rect = { x: 900, y: 1040, width: 32, height: 40 }
  const point = popupPlacement(middle, { x: 0, y: 0 }, SIZE, AREA)
  // Centred: icon centre 916, popup half-width 150 -> 766.
  assert.equal(point.x, 916 - 150)
  // Above the icon: the icon top is the bottom of the work area.
  assert.equal(point.y, 1040 - SIZE.height - POPUP_GAP)
})

test('the popup opens below the icon when there is more room there', () => {
  // A taskbar along the top of the screen: no room above the icon.
  const topIcon: Rect = { x: 1800, y: 0, width: 32, height: 40 }
  const point = popupPlacement(topIcon, { x: 0, y: 0 }, SIZE, AREA)
  assert.equal(point.y, 40 + POPUP_GAP)
})

test('the popup stays inside the work area at both horizontal edges', () => {
  const leftIcon: Rect = { x: 0, y: 1040, width: 32, height: 40 }
  const rightIcon: Rect = { x: 1888, y: 1040, width: 32, height: 40 }
  const left = popupPlacement(leftIcon, { x: 0, y: 0 }, SIZE, AREA)
  const right = popupPlacement(rightIcon, { x: 0, y: 0 }, SIZE, AREA)
  assert.equal(left.x, AREA.x)
  assert.equal(right.x, AREA.x + AREA.width - SIZE.width)
  assert.ok(left.x >= AREA.x && left.x + SIZE.width <= AREA.x + AREA.width)
  assert.ok(right.x >= AREA.x && right.x + SIZE.width <= AREA.x + AREA.width)
})

test('the popup never lands under the taskbar', () => {
  const point = popupPlacement(ICON, { x: 0, y: 0 }, SIZE, AREA)
  assert.ok(point.y >= AREA.y)
  assert.ok(point.y + SIZE.height <= AREA.y + AREA.height)
})

test('an icon in the overflow flyout falls back to the pointer', () => {
  // Windows reports no rectangle for an icon it has hidden behind the chevron.
  // The pointer sits inside the work area, as a click on the icon does.
  const cursor = { x: 900, y: 1030 }
  const point = popupPlacement({ x: 0, y: 0, width: 0, height: 0 }, cursor, SIZE, AREA)
  // Anchored on the pointer instead of the screen's top-left corner.
  assert.equal(point.x, 900 - 150)
  assert.equal(point.y, 1030 - SIZE.height - POPUP_GAP)
})

test('a missing rectangle is the same fallback as an empty one', () => {
  const cursor = { x: 900, y: 1050 }
  const fromNull = popupPlacement(null, cursor, SIZE, AREA)
  const fromZero = popupPlacement({ x: 0, y: 0, width: 0, height: 0 }, cursor, SIZE, AREA)
  assert.deepEqual(fromNull, fromZero)
})

test('a popup taller than the work area still opens at the top edge', () => {
  const huge = { width: 300, height: 2000 }
  const point = popupPlacement(ICON, { x: 0, y: 0 }, huge, AREA)
  assert.equal(point.y, AREA.y)
})

test('the popup is placed relative to the display it opens on', () => {
  // A second monitor to the right of the first, with its own origin.
  const second: Rect = { x: 1920, y: 0, width: 1920, height: 1040 }
  const icon: Rect = { x: 3700, y: 1040, width: 32, height: 40 }
  const point = popupPlacement(icon, { x: 0, y: 0 }, SIZE, second)
  assert.ok(point.x >= second.x)
  assert.ok(point.x + SIZE.width <= second.x + second.width)
})
