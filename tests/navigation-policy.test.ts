import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isTrustedRendererNavigation, resolveRendererEntry } from '../src/main/navigation-policy'

test('packaged app ignores an environment override for its renderer', () => {
  const entryFile = path.resolve('out/renderer/index.html')
  const entry = resolveRendererEntry(true, 'https://attacker.example/', entryFile)
  assert.equal(entry.developmentUrl, undefined)
  assert.equal(entry.trustedUrl, pathToFileURL(entryFile).toString())
  assert.equal(isTrustedRendererNavigation('https://attacker.example/', entry.trustedUrl), false)
})

test('development app uses the configured renderer server', () => {
  const developmentUrl = 'http://localhost:5173'
  const entry = resolveRendererEntry(false, developmentUrl, 'out/renderer/index.html')
  assert.equal(entry.developmentUrl, developmentUrl)
  assert.equal(entry.trustedUrl, developmentUrl)
})

test('renderer navigation stays on the development server origin', () => {
  const appUrl = 'http://localhost:5173/?piDesktopTheme=dark'
  assert.equal(isTrustedRendererNavigation('http://localhost:5173/settings', appUrl), true)
  assert.equal(isTrustedRendererNavigation('http://localhost.attacker:5173/', appUrl), false)
  assert.equal(isTrustedRendererNavigation('https://localhost:5173/', appUrl), false)
  assert.equal(isTrustedRendererNavigation('file:///C:/Users/Public/evil.html', appUrl), false)
})

test('packaged renderer navigation stays on the exact application entry file', () => {
  const entry = path.resolve('out/renderer/index.html')
  const appUrl = pathToFileURL(entry).toString()
  assert.equal(isTrustedRendererNavigation(`${appUrl}?piDesktopTheme=dark`, appUrl), true)
  assert.equal(isTrustedRendererNavigation(pathToFileURL(path.join(path.dirname(entry), 'evil.html')).toString(), appUrl), false)
  assert.equal(isTrustedRendererNavigation('https://example.com/', appUrl), false)
})
