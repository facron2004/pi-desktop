import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clipTipText,
  expandedPopupHidesTip,
  looksLikePath,
  placeHoverTip,
  readTipText,
  restoreNativeTitle,
  suppressNativeTitle,
  tipIsRedundant,
  tipShape,
  type TipAttrHost
} from '../src/renderer/src/lib/hover-tip'

class Attrs implements TipAttrHost {
  private values = new Map<string, string>()

  constructor(entries: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(entries)) this.values.set(key, value)
  }

  getAttribute(name: string): string | null {
    return this.values.has(name) ? this.values.get(name)! : null
  }

  setAttribute(name: string, value: string): void {
    this.values.set(name, value)
  }

  removeAttribute(name: string): void {
    this.values.delete(name)
  }
}

test('suppressing a title disarms the OS tooltip and keeps the text', () => {
  const el = new Attrs({ title: 'Open the folder' })
  suppressNativeTitle(el)
  assert.equal(el.getAttribute('title'), null)
  assert.equal(readTipText(el), 'Open the folder')
  restoreNativeTitle(el)
  assert.equal(el.getAttribute('title'), 'Open the folder')
  assert.equal(el.getAttribute('data-pi-tip'), null)
})

test('a title React wrote while the tip was up is not overwritten on restore', () => {
  const el = new Attrs({ title: 'Copy' })
  suppressNativeTitle(el)
  el.setAttribute('title', 'Copied')
  restoreNativeTitle(el)
  assert.equal(el.getAttribute('title'), 'Copied')
  assert.equal(el.getAttribute('data-pi-tip'), null)
})

test('an icon-only control falls back to its accessible name', () => {
  const iconOnly = new Attrs({ 'aria-label': 'Close' })
  assert.equal(readTipText(iconOnly), 'Close')
  // A real title still wins over the accessible name.
  const both = new Attrs({ title: 'Close the panel', 'aria-label': 'Close' })
  assert.equal(readTipText(both), 'Close the panel')
})

test('a title that repeats a fully visible label is not a bubble', () => {
  assert.equal(tipIsRedundant('Close', 'Close', false), true)
  assert.equal(tipIsRedundant('Close', 'Close', true), false)
  assert.equal(tipIsRedundant('docs/status.md', 'status.md', false), false)
  assert.equal(tipIsRedundant('Close', '', false), false)
})

test('only an expanded popup trigger loses its bubble', () => {
  // An open menu already names the control that opened it.
  assert.equal(expandedPopupHidesTip('true', 'menu'), true)
  assert.equal(expandedPopupHidesTip('true', 'dialog'), true)
  assert.equal(expandedPopupHidesTip('true', ''), true)
  // The tools-panel and sidebar toggles expand a surface elsewhere; their
  // bubble is the only name an icon-only control has. They must keep it.
  assert.equal(expandedPopupHidesTip('true', null), false)
  assert.equal(expandedPopupHidesTip('false', 'menu'), false)
  assert.equal(expandedPopupHidesTip(null, null), false)
})

test('paths wrap in a monospace bubble and short labels stay one line', () => {
  assert.equal(looksLikePath('docs/status.md'), true)
  assert.equal(looksLikePath('C:\\Users\\Facron\\project\\file.ts'), true)
  assert.equal(looksLikePath('src/renderer/src'), true)
  assert.equal(looksLikePath('and/or'), false)
  assert.equal(looksLikePath('Close the panel'), false)
  assert.deepEqual(tipShape('Close'), { wrap: false, mono: false })
  assert.deepEqual(tipShape('docs/status.md'), { wrap: true, mono: true })
  assert.deepEqual(tipShape('https://example.com/file'), { wrap: true, mono: true })
  assert.equal(tipShape('Review the uncommitted changes of the project').wrap, true)
  assert.equal(clipTipText('x'.repeat(20)), 'x'.repeat(20))
  assert.equal(clipTipText('x'.repeat(400)).endsWith('…'), false)
  assert.equal(clipTipText('x'.repeat(401)).length, 400)
})

test('the bubble sits above the control and flips when the top edge is crowded', () => {
  const above = placeHoverTip(
    { left: 40, top: 200, width: 80, height: 28 },
    { width: 40, height: 20 },
    { x: 100, y: 210 },
    { width: 800, height: 600 }
  )
  assert.deepEqual(above, { left: 80, top: 172 })

  const below = placeHoverTip(
    { left: 40, top: 10, width: 80, height: 20 },
    { width: 40, height: 40 },
    { x: 80, y: 16 },
    { width: 800, height: 600 }
  )
  assert.equal(below.top, 38)

  const clamped = placeHoverTip(
    { left: 0, top: 40, width: 20, height: 20 },
    { width: 100, height: 20 },
    { x: 4, y: 48 },
    { width: 200, height: 400 }
  )
  assert.equal(clamped.left, 8)
})

test('a bubble never opens inside the caption-button band', () => {
  const shell = 36
  const inTitleBar = placeHoverTip(
    { left: 700, top: 4, width: 28, height: 28 },
    { width: 120, height: 24 },
    { x: 714, y: 18 },
    { width: 900, height: 600 },
    8,
    8,
    shell
  )
  assert.ok(inTitleBar.top >= shell, `title-bar control placed the bubble in the shell at ${inTitleBar.top}`)
  assert.equal(inTitleBar.top, 40)

  const wouldClip = placeHoverTip(
    { left: 40, top: 50, width: 80, height: 28 },
    { width: 160, height: 30 },
    { x: 80, y: 64 },
    { width: 900, height: 600 },
    8,
    8,
    shell
  )
  assert.ok(wouldClip.top >= shell)
  assert.equal(wouldClip.top, 86)

  const clear = placeHoverTip(
    { left: 40, top: 120, width: 80, height: 28 },
    { width: 40, height: 20 },
    { x: 80, y: 130 },
    { width: 900, height: 600 },
    8,
    8,
    shell
  )
  assert.equal(clear.top, 92)
})

test('a tall control follows the pointer instead of the far edge of the control', () => {
  const placed = placeHoverTip(
    { left: 20, top: 0, width: 40, height: 200 },
    { width: 80, height: 20 },
    { x: 40, y: 80 },
    { width: 800, height: 600 }
  )
  assert.equal(placed.top, 52)
  assert.equal(placed.left, 8)
})
