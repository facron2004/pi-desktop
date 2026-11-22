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
