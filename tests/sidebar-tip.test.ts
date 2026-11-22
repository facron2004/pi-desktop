import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  decidePointerMoveDismiss,
  decideScrollDismiss,
  isAnchorRectVisible,
  rectContainsPoint,
  type TipRect
} from '../src/renderer/src/lib/sidebar-tip'

const rect = (left: number, top: number, width: number, height: number): TipRect => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height
})

test('detached, hidden or scroll-clipped anchors are treated as invisible', () => {
  const viewport = { width: 1280, height: 800 }
  const listClip = rect(500, 200, 340, 280)
  const visibleRow = rect(508, 260, 320, 32)

  assert.equal(isAnchorRectVisible(true, visibleRow, [listClip], viewport), true)
  assert.equal(isAnchorRectVisible(false, visibleRow, [listClip], viewport), false)
  assert.equal(isAnchorRectVisible(true, null, [listClip], viewport), false)
  assert.equal(isAnchorRectVisible(true, rect(508, 260, 0, 0), [listClip], viewport), false)

  // Scrolled completely above or below the model list's clip box
  assert.equal(isAnchorRectVisible(true, rect(508, 160, 320, 32), [listClip], viewport), false)
  assert.equal(isAnchorRectVisible(true, rect(508, 482, 320, 32), [listClip], viewport), false)

  // Partially visible inside the clip box still counts as visible
  assert.equal(isAnchorRectVisible(true, rect(508, 185, 320, 32), [listClip], viewport), true)

  // Outside the window viewport
  assert.equal(isAnchorRectVisible(true, rect(508, 820, 320, 32), [], viewport), false)
})

test('pointermove dismisses detached anchors and recovers from dropped mouseleave', () => {
  assert.equal(decidePointerMoveDismiss('pointer', false, false), 'dismiss')
  assert.equal(decidePointerMoveDismiss('focus', false, false), 'dismiss')
  assert.equal(decidePointerMoveDismiss('pointer', true, true), 'keep')
  assert.equal(decidePointerMoveDismiss('pointer', true, false), 'leave')
  // A keyboard-focused card is not dismissed merely because the mouse moved elsewhere
  assert.equal(decidePointerMoveDismiss('focus', true, false), 'keep')
})

test('scroll dismisses clipped anchors and leaves when a row scrolls away from the cursor', () => {
  const row = rect(500, 300, 300, 32)
  assert.equal(rectContainsPoint(row, { x: 600, y: 315 }), true)
  assert.equal(rectContainsPoint(row, { x: 600, y: 360 }), false)

  // Completely clipped out of view dismisses immediately for both pointer and focus
  assert.equal(decideScrollDismiss('pointer', false, true, row, { x: 600, y: 315 }), 'dismiss')
  assert.equal(decideScrollDismiss('focus', false, true, row, { x: 600, y: 315 }), 'dismiss')

  // Scrolled away from the stationary cursor closes a pointer-triggered card
  assert.equal(decideScrollDismiss('pointer', true, true, row, { x: 600, y: 360 }), 'leave')
  assert.equal(decideScrollDismiss('pointer', true, true, row, { x: 600, y: 315 }), 'keep')

  // Keyboard-focused card keeps following the row while it remains visible
  assert.equal(decideScrollDismiss('focus', true, true, row, { x: 600, y: 360 }), 'keep')
})

test('ModelPicker and SidebarTip tear down the hover card whenever the picker or anchor closes', () => {
  const topBar = readFileSync(
    path.resolve(process.cwd(), 'src/renderer/src/components/TopBar.tsx'),
    'utf8'
  )
  const sidebarTip = readFileSync(
    path.resolve(process.cwd(), 'src/renderer/src/components/SidebarTip.tsx'),
    'utf8'
  )

  // ModelPicker must keep SidebarTip inside the Popover and dismiss on list unmount / pick
  const popoverCloseIndex = topBar.indexOf('</Popover>')
  const sidebarTipIndex = topBar.indexOf('<SidebarTip')
  assert.ok(sidebarTipIndex > 0 && sidebarTipIndex < popoverCloseIndex, 'SidebarTip must render inside Popover')
  assert.match(topBar, /if \(!list\) modelTip\.dismiss\(\)/)
  assert.match(topBar, /pickModel[\s\S]*?modelTip\.dismiss\(\)/)

  // SidebarTip guards against detached anchors, clicks, blur, Escape and dropped mouseleave
  // Mutation checks are coalesced onto one animation frame, so a streaming
  // transcript cannot force a layout read per DOM mutation batch.
  assert.match(sidebarTip, /new MutationObserver\(scheduleAnchorCheck\)/)
  assert.match(
    sidebarTip,
    /requestAnimationFrame\(\(\) => \{\s*anchorCheckFrame = 0\s*checkAnchor\(\)/
  )
  assert.match(sidebarTip, /cancelAnimationFrame\(anchorCheckFrame\)/)
  assert.match(sidebarTip, /addEventListener\('pointerdown', onPointerDown, true\)/)
  assert.match(sidebarTip, /addEventListener\('pointermove', onPointerMove, true\)/)
  assert.match(sidebarTip, /addEventListener\('blur', onWindowBlur\)/)
  assert.match(sidebarTip, /addEventListener\('mouseleave', onDocumentMouseLeave\)/)
  assert.match(sidebarTip, /if \(!anchor\.isConnected\) return null/)
})
