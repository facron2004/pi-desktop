import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app, Tray } from 'electron'
import {
  claimSingleInstance,
  isQuitting,
  noteQuitting,
  shouldHideToTray,
  syncTray
} from '../src/main/tray'

/**
 * The tray is the one thing that keeps a closed window reachable, so these are
 * the rules that keep the app from disappearing: the single-instance lock, and
 * "hide only while the icon is really there". They live in module state, so the
 * tests in this file run in the order they are written — refusal first, then the
 * claim, the tray lifecycle, and a quit last (which is final for the process).
 */

const options = (overrides: Partial<{ show: () => void; openConversation: (key: string) => void }> = {}) => ({
  enabled: true,
  language: 'en' as const,
  theme: 'dark' as const,
  show: () => {},
  openConversation: () => {},
  ...overrides
})

const lastTray = (): InstanceType<typeof Tray> | undefined =>
  (Tray as unknown as { instances: InstanceType<typeof Tray>[] }).instances.at(-1)

test('a launch that cannot take the single-instance lock is refused', () => {
  // Another copy already owns the lock: this process must exit, not build a
  // second window (and a second tray icon) beside it.
  ;(app as unknown as { requestSingleInstanceLock: () => boolean }).requestSingleInstanceLock = () => false
  assert.equal(claimSingleInstance(), false)
})

test('the lock is claimed once and remembered for the process lifetime', () => {
  let requests = 0
  ;(app as unknown as { requestSingleInstanceLock: () => boolean }).requestSingleInstanceLock = () => {
    requests += 1
    return true
  }
  assert.equal(claimSingleInstance(), true)
  assert.equal(claimSingleInstance(), true)
  assert.equal(requests, 1, 'a held lock must not be requested again')
})

test('the screenshot harness neither takes the app lock nor builds a tray', () => {
  // Harness runs start beside a live copy on purpose; the tray icon would be a
  // second copy of the same mark in the notification area.
  process.env.PI_DESKTOP_SCREENSHOT = 'out/shot.png'
  try {
    assert.equal(claimSingleInstance(), true)
    syncTray(options())
    assert.equal(lastTray(), undefined, 'the harness must not build a tray icon')
    assert.equal(shouldHideToTray(), false)
  } finally {
    delete process.env.PI_DESKTOP_SCREENSHOT
  }
})

test('the window hides only once a real tray icon exists', () => {
  assert.equal(shouldHideToTray(), false, 'no icon yet: closing must quit')

  syncTray(options())
  assert.ok(lastTray(), 'enabling the tray must build it')
  assert.equal(shouldHideToTray(), true)

  syncTray({ ...options(), enabled: false })
  assert.equal(lastTray()?.isDestroyed(), true, 'turning the tray off destroys the icon')
  assert.equal(shouldHideToTray(), false, 'without an icon, closing must not hide')
})

test('the screenshot and close-after flags always close the window for real', () => {
  syncTray(options())
  assert.equal(shouldHideToTray(), true)

  process.env.PI_DESKTOP_SCREENSHOT = 'out/shot.png'
  try {
    assert.equal(shouldHideToTray(), false)
  } finally {
    delete process.env.PI_DESKTOP_SCREENSHOT
  }

  process.env.PI_DESKTOP_CLOSE_AFTER_MS = '2000'
  try {
    assert.equal(shouldHideToTray(), false)
  } finally {
    delete process.env.PI_DESKTOP_CLOSE_AFTER_MS
  }
  assert.equal(shouldHideToTray(), true)
})

test('the icon click follows the options of the latest settings write', () => {
  const shown: string[] = []
  syncTray(options({ show: () => shown.push('first') }))
  syncTray(options({ show: () => shown.push('second') }))

  lastTray()?.emit('click')
  lastTray()?.emit('double-click')
  assert.deepEqual(shown, ['second', 'second'], 'the click must not keep a stale window target')
})

test('a quit destroys the icon and stops anything from rebuilding it', () => {
  syncTray(options())
  noteQuitting()

  assert.equal(isQuitting(), true)
  assert.equal(lastTray()?.isDestroyed(), true, 'a quitting app must not leave a ghost icon')
  assert.equal(shouldHideToTray(), false, 'a quit closes for real')

  // A settings write can arrive while the app is closing; it must not put the
  // icon back beside a window that is going away.
  syncTray(options())
  assert.equal(shouldHideToTray(), false)
})
