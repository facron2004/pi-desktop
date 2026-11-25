import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { app, screen, type BrowserWindow } from 'electron'
import { initialBounds, wasMaximized, watchWindowState, type WindowState } from '../src/main/window-state'

/**
 * The window's size and place survive a restart, and a place that is no longer
 * on a display is dropped instead of opening the app out of sight. Both are
 * decisions a user cannot recover from with a click, so they are pinned here.
 */

/** Point the store at a fresh userData folder, so the module's read cache cannot leak between tests. */
function userData(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-window-state-'))
  ;(app as unknown as { getPath: (name: string) => string }).getPath = () => dir
  return dir
}

function save(dir: string, state: WindowState): void {
  writeFileSync(path.join(dir, 'window-state.json'), JSON.stringify(state), 'utf8')
}

interface FakeWindow {
  on: (event: string, handler: () => void) => void
  emit: (event: string) => void
  isDestroyed: () => boolean
  isMinimized: () => boolean
  isMaximized: () => boolean
  isFullScreen: () => boolean
  getBounds: () => { x: number; y: number; width: number; height: number }
  getContentBounds: () => { x: number; y: number; width: number; height: number }
  getNormalBounds: () => { x: number; y: number; width: number; height: number }
}

function fakeWindow(options: {
  content: { width: number; height: number }
  outer: { width: number; height: number }
  normal: { x: number; y: number; width: number; height: number }
  maximized?: boolean
  minimized?: boolean
  fullScreen?: boolean
}): FakeWindow {
  const handlers = new Map<string, () => void>()
  return {
    on: (event, handler) => {
      handlers.set(event, handler)
    },
    emit: (event) => handlers.get(event)?.(),
    isDestroyed: () => false,
    isMinimized: () => options.minimized === true,
    isMaximized: () => options.maximized === true,
    isFullScreen: () => options.fullScreen === true,
    getBounds: () => ({ x: 0, y: 0, ...options.outer }),
    getContentBounds: () => ({ x: 0, y: 0, ...options.content }),
    getNormalBounds: () => options.normal
  }
}

test('a first launch opens at the default size', () => {
  const dir = userData()
  try {
    assert.deepEqual(initialBounds(), { width: 1480, height: 940 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a saved size and an on-screen position are restored', () => {
  const dir = userData()
  try {
    save(dir, { width: 1000, height: 700, x: 100, y: 80 })
    assert.deepEqual(initialBounds(), { width: 1000, height: 700, x: 100, y: 80 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a position that is not on any display is dropped, not clamped', () => {
  const dir = userData()
  try {
    // The display the mock reports is 1280x720 at the origin; this window was
    // left on a monitor that is gone.
    save(dir, { width: 1000, height: 700, x: 4000, y: 3000 })
    assert.deepEqual(initialBounds(), { width: 1000, height: 700 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const position of [{ x: 1279, y: 80 }, { x: 100, y: 719 }, { x: 100, y: -39 }]) {
  test(`a restored position leaves enough of the title bar visible at ${position.x}, ${position.y}`, (t) => {
    const dir = userData()
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    save(dir, { width: 1000, height: 700, ...position })
    assert.deepEqual(initialBounds(), { width: 1000, height: 700 })
  })
}

test('malformed saved coordinates do not prevent the window size from being restored', (t) => {
  const dir = userData()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(path.join(dir, 'window-state.json'), '{"width":1000,"height":700,"x":"100","y":80}', 'utf8')
  assert.deepEqual(initialBounds(), { width: 1000, height: 700 })
})

test('a saved position with a visible title bar on a secondary display is restored', (t) => {
  const dir = userData()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const [primary] = screen.getAllDisplays()
  t.mock.method(screen, 'getAllDisplays', () => [
    primary,
    { ...primary, id: 2, workArea: { x: -1280, y: 0, width: 1280, height: 720 } }
  ])
  const state = { width: 1000, height: 700, x: -1250, y: 20 }
  save(dir, state)
  assert.deepEqual(initialBounds(), state)
})

test('a state that a killed process left half-written is ignored', () => {
  const dir = userData()
  try {
    // Below the minimum the app cannot be shown at all; a zero-sized record is
    // what a process killed before its first frame leaves behind.
    save(dir, { width: 0, height: 0 })
    assert.deepEqual(initialBounds(), { width: 1480, height: 940 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a maximised window is remembered as maximised and keeps its normal size', () => {
  const dir = userData()
  try {
    save(dir, { width: 1200, height: 800, maximized: true })
    assert.equal(wasMaximized(), true)
    assert.deepEqual(initialBounds(), { width: 1200, height: 800 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('closing saves the content size, not the frame the OS adds around it', () => {
  const dir = userData()
  try {
    const window = fakeWindow({
      content: { width: 1000, height: 700 },
      outer: { width: 1016, height: 732 },
      normal: { x: 120, y: 90, width: 1016, height: 732 }
    })
    watchWindowState(window as unknown as BrowserWindow)
    window.emit('close')

    const saved = JSON.parse(readFileSync(path.join(dir, 'window-state.json'), 'utf8')) as WindowState
    assert.deepEqual(saved, { width: 1000, height: 700, x: 120, y: 90, maximized: false })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('closing while maximised does not record the maximised screen as the size', () => {
  const dir = userData()
  try {
    const window = fakeWindow({
      content: { width: 1920, height: 1040 },
      outer: { width: 1920, height: 1080 },
      normal: { x: 40, y: 40, width: 1200, height: 800 },
      maximized: true
    })
    watchWindowState(window as unknown as BrowserWindow)
    window.emit('close')

    const saved = JSON.parse(readFileSync(path.join(dir, 'window-state.json'), 'utf8')) as WindowState
    // The frame's height (1080 - 1040) is subtracted from the normal bounds;
    // the next launch returns to the size the window would un-maximise to.
    assert.deepEqual(saved, { width: 1200, height: 760, x: 40, y: 40, maximized: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a minimised window saves the bounds it will return to', () => {
  const dir = userData()
  try {
    const window = fakeWindow({
      content: { width: 0, height: 0 },
      outer: { width: 0, height: 0 },
      normal: { x: 0, y: 0, width: 1000, height: 700 },
      minimized: true
    })
    watchWindowState(window as unknown as BrowserWindow)
    window.emit('close')

    const saved = JSON.parse(readFileSync(path.join(dir, 'window-state.json'), 'utf8')) as WindowState
    assert.deepEqual(saved, { width: 1000, height: 700, x: 0, y: 0, maximized: false })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
