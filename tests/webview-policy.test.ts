import assert from 'node:assert/strict'
import test from 'node:test'
import {
  browserHistoryCommand,
  browserMouseDirection,
  claimBrowserHistoryNav,
  denyWebviewPopups,
  hardenWebviewPreferences,
  isAllowedWebviewUrl
} from '../src/main/webview-policy'

test('mouse side buttons and browser app commands map to history', () => {
  assert.equal(browserMouseDirection(3), 'back')
  assert.equal(browserMouseDirection(4), 'forward')
  assert.equal(browserMouseDirection(0), null)
  assert.equal(browserMouseDirection(2), null)
  assert.equal(browserHistoryCommand('browser-backward'), 'back')
  assert.equal(browserHistoryCommand('browser-forward'), 'forward')
  assert.equal(browserHistoryCommand('browser-refresh'), null)
  assert.equal(claimBrowserHistoryNav(1000, 800), false)
  assert.equal(claimBrowserHistoryNav(1000, 700), true)
  assert.equal(claimBrowserHistoryNav(1000, Number.NEGATIVE_INFINITY), true)
})

test('webviews only load web URLs', () => {
  assert.equal(isAllowedWebviewUrl('https://example.com/'), true)
  assert.equal(isAllowedWebviewUrl('http://localhost:3000/'), true)
  assert.equal(isAllowedWebviewUrl('file:///C:/Users/Public/secret.html'), false)
  assert.equal(isAllowedWebviewUrl('data:text/html,<script>alert(1)</script>'), false)
  assert.equal(isAllowedWebviewUrl('javascript:alert(1)'), false)
  assert.equal(isAllowedWebviewUrl('not a URL'), false)
})

test('webview pages cannot open windows outside their navigation policy', () => {
  type WindowOpenHandler = Parameters<Electron.WebContents['setWindowOpenHandler']>[0]
  let decide: WindowOpenHandler | undefined
  denyWebviewPopups({
    setWindowOpenHandler: (handler) => {
      decide = handler
    }
  })

  assert.deepEqual(
    decide?.({ url: 'file:///C:/Users/Public/secret.html' } as Parameters<WindowOpenHandler>[0]),
    { action: 'deny' }
  )
})

test('webview attributes cannot install a preload or enable privileged features', () => {
  const preferences: Electron.WebPreferences = {
    preload: 'C:/Users/Public/attacker.js',
    nodeIntegration: true,
    nodeIntegrationInWorker: true,
    nodeIntegrationInSubFrames: true,
    contextIsolation: false,
    sandbox: false,
    webviewTag: true,
    webSecurity: false,
    allowRunningInsecureContent: true
  }
  hardenWebviewPreferences(preferences)
  assert.equal('preload' in preferences, false)
  assert.equal(preferences.nodeIntegration, false)
  assert.equal(preferences.nodeIntegrationInWorker, false)
  assert.equal(preferences.nodeIntegrationInSubFrames, false)
  assert.equal(preferences.contextIsolation, true)
  assert.equal(preferences.sandbox, true)
  assert.equal(preferences.webviewTag, false)
  assert.equal(preferences.webSecurity, true)
  assert.equal(preferences.allowRunningInsecureContent, false)
})
