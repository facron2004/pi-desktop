import { app, Menu, Tray, type BrowserWindow } from 'electron'
import { trayIconImage } from './app-icon'

let tray: Tray | null = null
let quitting = false
let lockHeld = false

function harnessProcess(): boolean {
  // Only the screenshot harness has to start beside a running copy. The
  // keep-alive flag is a window-close aid, not a second-instance licence:
  // treating it as one let any inherited environment variable produce two
  // full app instances.
  return Boolean(process.env.PI_DESKTOP_SCREENSHOT)
}

/**
 * Hold the app-wide single-instance lock.
 *
 * One app, one window. A second launch — a double-click while the first copy
 * is still starting, or a shortcut that was left in the tray — asks this
 * process to reveal its window instead of building a second app beside it.
 * The harness runs are exempt because they start beside a running copy on
 * purpose. Returns false when another instance already holds the lock.
 */
export function claimSingleInstance(): boolean {
  if (harnessProcess()) return true
  if (lockHeld) return true
  const got = app.requestSingleInstanceLock()
  if (!got) return false
  lockHeld = true
  return true
}

export function showWindow(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

export function noteQuitting(): void {
  quitting = true
  destroyTray()
}

/** True from the moment a quit starts; no new window may be built. */
export function isQuitting(): boolean {
  return quitting
}

function destroyTray(): void {
  if (!tray) return
  tray.destroy()
  tray = null
}

function menuLabels(language: string | undefined): { show: string; quit: string } {
  if (language === 'zh-CN') return { show: '显示主窗口', quit: '退出' }
  return { show: 'Show window', quit: 'Quit' }
}

/**
 * Closing the window hides it only while the tray icon is actually there.
 * A quit, the screenshot harness, and a missing icon all close for real —
 * hiding without a tray would leave no way back.
 */
export function shouldHideToTray(): boolean {
  if (quitting || !tray || tray.isDestroyed()) return false
  if (process.env.PI_DESKTOP_SCREENSHOT) return false
  if (Number(process.env.PI_DESKTOP_CLOSE_AFTER_MS ?? 0) > 0) return false
  return true
}

export function syncTray(options: {
  enabled: boolean
  language?: string
  show: () => void
}): void {
  // A settings write or a second launch can arrive while the app is quitting;
  // rebuilding the tray then would leave a ghost icon beside a closing app.
  if (quitting || !options.enabled) {
    destroyTray()
    return
  }
  if (harnessProcess()) return
  const image = trayIconImage()
  if (!image) {
    destroyTray()
    return
  }
  if (!tray || tray.isDestroyed()) {
    tray = new Tray(image)
    tray.setToolTip('Pi Desktop')
    // The hidden window leaves the taskbar, so the icon itself has to open it.
    tray.on('click', options.show)
    tray.on('double-click', options.show)
  } else {
    tray.setImage(image)
  }
  const labels = menuLabels(options.language)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: labels.show, click: options.show },
      { type: 'separator' },
      { label: labels.quit, click: () => app.quit() }
    ])
  )
}
