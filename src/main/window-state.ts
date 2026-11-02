import { app, screen, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** The size and place of the window, as the user left them. */
export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

const MIN_WIDTH = 880
const MIN_HEIGHT = 572
const DEFAULT_WIDTH = 1480
const DEFAULT_HEIGHT = 940

function stateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function read(): WindowState | null {
  try {
    const file = stateFile()
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as WindowState
    // A process killed before its first frame can leave a zero-sized state
    // behind; clamping that to the minimum would open the next run as a tiny
    // window. Treat impossible sizes as no state so the default wins.
    if (
      typeof parsed.width !== 'number' ||
      typeof parsed.height !== 'number' ||
      !Number.isFinite(parsed.width) ||
      !Number.isFinite(parsed.height) ||
      parsed.width < MIN_WIDTH ||
      parsed.height < MIN_HEIGHT
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function write(state: WindowState): void {
  try {
    const file = stateFile()
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    console.error('[pi-desktop] could not save the window state:', error)
  }
}

/**
 * The size and place for the next run.
 *
 * A window that was left on a screen that is not connected any more would
 * open out of sight, so a position that does not land on a display is
 * dropped and the window is opened where the system would put it anyway.
 */
export function initialBounds(): { width: number; height: number; x?: number; y?: number } {
  const state = read()
  if (!state) return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }

  const width = Math.max(MIN_WIDTH, Math.round(state.width))
  const height = Math.max(MIN_HEIGHT, Math.round(state.height))
  if (state.x === undefined || state.y === undefined) return { width, height }

  const area = screen.getDisplayMatching({ x: state.x, y: state.y, width, height }).workArea
  const onScreen =
    state.x + 80 > area.x &&
    state.y + 40 > area.y &&
    state.x < area.x + area.width &&
    state.y < area.y + area.height
  return onScreen ? { width, height, x: state.x, y: state.y } : { width, height }
}

/** True when the window was left maximised. */
export function wasMaximized(): boolean {
  return read()?.maximized === true
}

/**
 * The size of the content area, in the same unit the window is created with.
 *
 * `getNormalBounds()` reports the outer frame, which on Windows includes the
 * title bar and a rounded border. Saving that number and passing it back as
 * the next window's `width`/`height` mixes the two units, and at fractional
 * display scaling the rounding makes the difference stack up on every launch.
 * The content bounds are the stable unit: `index.ts` re-asserts them with
 * `setContentSize()` after the frame has been resolved.
 */
function contentSize(window: BrowserWindow): { width: number; height: number } {
  // A minimised window reports 0x0 content; saving that would drop the size
  // the user left behind, and the next launch would fall back to the default.
  // The normal bounds are the size the window returns to, so they stand in.
  if (window.isMinimized()) {
    const normal = window.getNormalBounds()
    return { width: Math.max(MIN_WIDTH, normal.width), height: Math.max(MIN_HEIGHT, normal.height) }
  }
  if (!window.isMaximized() && !window.isFullScreen()) {
    const content = window.getContentBounds()
    return { width: content.width, height: content.height }
  }
  // While maximised `getContentBounds()` is the maximised screen, not the
  // state the window returns to. Subtract the frame from the normal bounds
  // instead (the frame delta is measured from the current window).
  const outer = window.getBounds()
  const content = window.getContentBounds()
  const normal = window.getNormalBounds()
  return {
    width: Math.max(MIN_WIDTH, normal.width - (outer.width - content.width)),
    height: Math.max(MIN_HEIGHT, normal.height - (outer.height - content.height))
  }
}

/**
 * Remember the size and place of the window.
 *
 * The write is debounced, because a drag sends a stream of move events and
 * every one of them would otherwise touch the disk.
 */
export function watchWindowState(window: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null
  // A maximised window reports the maximised content bounds. Keep the last
  // normal content size so closing while maximised does not overwrite the
  // size the window would return to.
  const previous = read()
  let lastContent = previous ? { width: previous.width, height: previous.height } : null
  if (!window.isMaximized() && !window.isFullScreen() && !window.isMinimized()) {
    lastContent = contentSize(window)
  }

  const snapshot = (): WindowState => {
    if (!window.isMaximized() && !window.isFullScreen() && !window.isMinimized()) {
      lastContent = contentSize(window)
    }
    const normal = window.getNormalBounds()
    const content = lastContent ?? contentSize(window)
    return {
      width: content.width,
      height: content.height,
      x: normal.x,
      y: normal.y,
      maximized: window.isMaximized()
    }
  }

  const save = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (window.isDestroyed()) return
      write(snapshot())
    }, 400)
  }

  window.on('resize', save)
  window.on('move', save)
  window.on('maximize', save)
  window.on('unmaximize', save)
  window.on('closed', () => {
    if (timer) clearTimeout(timer)
  })
  window.on('close', () => {
    if (timer) clearTimeout(timer)
    write(snapshot())
  })
}
