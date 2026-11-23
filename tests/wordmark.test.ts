import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/**
 * The pixel wordmark exists twice: the component draws it in the sidebar, and
 * `scripts/make-wordmark.mjs` writes the standalone vector
 * (`build/wordmark-pixel.svg`) that a README or a slide deck can drop in.
 *
 * AGENTS.md states the two are the same drawing and must stay byte-identical.
 * Until this test nothing checked that, so editing one glyph table and forgetting
 * the other would have shipped two different logos with no signal at all.
 */
test('the component and the generated SVG draw the same pixel wordmark', () => {
  const root = path.resolve(process.cwd())
  const component = readFileSync(
    path.join(root, 'src/renderer/src/components/PiWordmark.tsx'),
    'utf8'
  )
  const asset = readFileSync(path.join(root, 'build/wordmark-pixel.svg'), 'utf8')

  // The component holds the path as a concatenation of single-quoted literals.
  const literal = /const WORDMARK_PATH =([\s\S]*?)\n\n/.exec(component)
  assert.ok(literal, 'PiWordmark.tsx no longer declares WORDMARK_PATH')
  const componentPath = [...literal[1].matchAll(/'([^']*)'/g)].map((match) => match[1]).join('')
  assert.ok(componentPath.length > 0, 'WORDMARK_PATH is empty')

  const assetPath = /<path d="([^"]*)"/.exec(asset)?.[1]
  assert.ok(assetPath, 'the SVG asset has no path')
  assert.equal(componentPath, assetPath, 'the two wordmark copies drifted apart')

  // The dot of the `i` is the one accent, and it has to sit on the same cell.
  const dotInComponent = /const DOT = \{ x: (\d+), y: (\d+) \}/.exec(component)
  const dotInAsset = /<rect x="(\d+)" y="(\d+)" width="1" height="1"/.exec(asset)
  assert.ok(dotInComponent && dotInAsset, 'a wordmark copy lost its accent dot')
  assert.equal(dotInComponent[1], dotInAsset[1], 'the accent dot moved horizontally')
  assert.equal(dotInComponent[2], dotInAsset[2], 'the accent dot moved vertically')

  // The grid is 56x8, and both copies must agree on it.
  const viewBox = /viewBox=\{`0 0 \$\{WORDMARK_WIDTH\} \$\{WORDMARK_HEIGHT\}`\}/.test(component)
    ? 'from constants'
    : /viewBox="([^"]+)"/.exec(asset)?.[1] ?? ''
  assert.equal(viewBox, 'from constants', 'the component stopped sizing its own viewBox')
  assert.match(asset, /viewBox="0 0 56 8"/, 'the SVG asset changed its grid')
})

/**
 * The startup screen paints before React, so it cannot use PiWordmark. It
 * inlines the same drawing instead: an <img> would arrive a frame late and
 * would lose `currentColor`. This is the third copy of the wordmark, so it
 * needs the same drift check as the component.
 */
test('the startup screen inlines the same pixel wordmark as the asset', () => {
  const root = path.resolve(process.cwd())
  const html = readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
  const asset = readFileSync(path.join(root, 'build/wordmark-pixel.svg'), 'utf8')

  const inline = /class="startup-screen__name"[\s\S]*?<path d="([^"]*)"/.exec(html)?.[1]
  assert.ok(inline, 'the startup screen no longer inlines the wordmark')
  const assetPath = /<path d="([^"]*)"/.exec(asset)?.[1]
  assert.ok(assetPath, 'the SVG asset has no path')
  assert.equal(inline, assetPath, 'the startup wordmark drifted from the asset')

  const inlineDot = /class="startup-screen__name"[\s\S]*?<rect x="(\d+)" y="(\d+)" width="1" height="1"/.exec(html)
  const assetDot = /<rect x="(\d+)" y="(\d+)" width="1" height="1"/.exec(asset)
  assert.ok(inlineDot && assetDot, 'the startup wordmark lost its accent dot')
  assert.equal(inlineDot[1], assetDot[1], 'the accent dot moved horizontally')
  assert.equal(inlineDot[2], assetDot[2], 'the accent dot moved vertically')
  assert.match(html, /viewBox="0 0 56 8"/, 'the startup wordmark changed its grid')

  // The hairline stroke is a presentation choice, but all copies must carry
  // the same one or the wordmark reads with a different weight per surface.
  const strokeOf = (text: string): string | undefined =>
    /stroke-width="([\d.]+)"/.exec(text)?.[1] ??
    /strokeWidth=\{([\d.]+)\}/.exec(text)?.[1] ??
    /const WORDMARK_STROKE = ([\d.]+)/.exec(text)?.[1]
  const component = readFileSync(
    path.join(root, 'src/renderer/src/components/PiWordmark.tsx'),
    'utf8'
  )
  assert.ok(strokeOf(asset), 'the stroke width disappeared from the asset')
  assert.equal(strokeOf(asset), strokeOf(component), 'the component stroke drifted')
  assert.equal(strokeOf(asset), strokeOf(html), 'the startup stroke drifted')
  assert.match(asset, /<rect x="8" y="0" width="1" height="1"[^>]*stroke="none"/, 'the accent dot picked up a stroke')
  assert.match(html, /<rect x="8" y="0" width="1" height="1"[^>]*stroke="none"/, 'the startup dot picked up a stroke')
})
