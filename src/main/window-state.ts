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

const MIN_WIDTH = 1080
const MIN_HEIGHT = 680
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
    if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') return null
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
 * Remember the size and place of the window.
 *
 * The write is debounced, because a drag sends a stream of move events and
 * every one of them would otherwise touch the disk.
 */
export function watchWindowState(window: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null
  const save = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const bounds = window.getNormalBounds()
      write({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        maximized: window.isMaximized()
      })
    }, 400)
  }

  window.on('resize', save)
  window.on('move', save)
  window.on('maximize', save)
  window.on('unmaximize', save)
  window.on('close', () => {
    if (timer) clearTimeout(timer)
    const bounds = window.getNormalBounds()
    write({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: window.isMaximized()
    })
  })
}
