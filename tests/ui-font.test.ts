import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CJK_FACE,
  EMOJI_FACE,
  FONT_STACK_PROPERTIES,
  uiFontStack
} from '../src/renderer/src/lib/ui-font'

/**
 * The regression these tests pin: the UI stack used to lead with the CJK-only
 * face, which claims every Chinese code point ahead of whatever followed it.
 * Picking a font in Appearance then changed Latin only — the Chinese in the
 * settings dialog and the sidebar stayed in Microsoft YaHei. Measured through
 * CDP `CSS.getPlatformFontsForNode` on the built app.
 */

/** The families of a stack, in order, with quotes and whitespace removed. */
function families(stack: string): string[] {
  return stack
    .split(',')
    .map((part) => part.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

test('the system preset means "no override"', () => {
  assert.equal(uiFontStack(undefined), null)
  assert.equal(uiFontStack(''), null)
  assert.equal(uiFontStack('   '), null)
  assert.equal(uiFontStack('system'), null)
})

test('a chosen font comes before every fallback face', () => {
  for (const chosen of ['Noto Serif SC', 'Inter', 'Segoe UI', 'Roboto', 'DengXian']) {
    const stack = uiFontStack(chosen)
    assert.ok(stack, `${chosen} should produce a stack`)
    assert.equal(families(stack)[0], chosen, `${chosen} must lead its own stack`)
    assert.equal(
      stack.includes(CJK_FACE),
      false,
      `${chosen}: the CJK face must not compete with the choice`
    )
  }
})

test('a chosen font still has a sans CJK fallback behind it', () => {
  // Windows links a western face to SimSun for missing CJK glyphs unless a
  // sans CJK family is named after it.
  const stack = uiFontStack('Inter')
  assert.ok(stack)
  const order = families(stack)
  assert.ok(order.includes('Noto Sans SC'))
  assert.ok(order.includes('Microsoft YaHei UI'))
  assert.ok(order.indexOf('Noto Sans SC') > 0)
  assert.ok(order.includes('sans-serif'))
})

test('the mono preset keeps the CJK face, because generic monospace is serif-linked', () => {
  const stack = uiFontStack('mono')
  assert.ok(stack)
  const order = families(stack)
  assert.equal(order[0], 'JetBrains Mono')
  // The face has to sit before the generic family it is protecting against.
  assert.ok(order.indexOf(CJK_FACE) > order.indexOf('JetBrains Mono'))
  assert.ok(order.indexOf(CJK_FACE) < order.indexOf('monospace'))
})

test('the sans preset is the documented system recipe, without a CJK face', () => {
  const stack = uiFontStack('sans')
  assert.ok(stack)
  assert.equal(stack.includes(CJK_FACE), false)
  assert.ok(stack.startsWith('-apple-system'))
  assert.ok(stack.endsWith('sans-serif'))
})

test('weight-named PingFang faces keep the family fallback chain', () => {
  const stack = uiFontStack('PingFang SC Medium')
  assert.ok(stack)
  const order = families(stack)
  assert.equal(order[0], 'PingFang SC Medium')
  // A bare weight name often misses on Windows; the family must follow.
  assert.ok(order.includes('PingFang SC'))
  assert.ok(order.includes('Microsoft YaHei UI'))
  assert.equal(stack.includes(CJK_FACE), false)
})

test('an arbitrary installed family is quoted and given the CJK net', () => {
  const stack = uiFontStack('方正舒体')
  assert.ok(stack)
  assert.ok(stack.startsWith('"方正舒体"'))
  assert.ok(families(stack).includes('Noto Sans SC'))
})

test('a family list from settings is passed through unchanged', () => {
  const pasted = `"Fira Code", "Cascadia Code", monospace`
  const stack = uiFontStack(pasted)
  assert.ok(stack)
  assert.ok(stack.startsWith(pasted))
  assert.ok(stack.endsWith('sans-serif'))
})

test('every stack ends in a generic family, so text never falls to the initial face', () => {
  for (const chosen of ['sans', 'chinese', 'mono', 'serif', 'Inter', 'PingFang SC Bold', 'Arial']) {
    const stack = uiFontStack(chosen)
    assert.ok(stack, `${chosen} should produce a stack`)
    assert.match(
      stack,
      /(sans-serif|serif|monospace)$/,
      `${chosen}: a stack with no generic family is at the mercy of the next system font`
    )
  }
})

test('the emoji face rides along so a broken registry cannot bring back tofu', () => {
  for (const chosen of ['sans', 'mono', 'Inter', 'PingFang SC']) {
    const stack = uiFontStack(chosen)
    assert.ok(stack?.includes(EMOJI_FACE), `${chosen} is missing the emoji face`)
  }
})

test('the replaced tokens are the three the picker has always written', () => {
  assert.deepEqual([...FONT_STACK_PROPERTIES], ['--font-ui', '--font-sidebar', '--font-reading'])
})
