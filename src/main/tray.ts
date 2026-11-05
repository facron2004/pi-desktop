import { app, Menu, Tray, type BrowserWindow } from 'electron'
import { trayIconImage } from './app-icon'
import { readPersistedFlag } from './settings'

let tray: Tray | null = null
let quitting = false
let lockHeld = false

function harnessProcess(): boolean {
  return Boolean(process.env.PI_DESKTOP_SCREENSHOT) || process.env.PI_DESKTOP_KEEP_ALIVE === '1'
}

/**
 * True when this launch should refuse to open a second window.
 *
 * The flag comes from the settings file the store writes, read before the
 * store exists: the single-instance lock has to be taken before the app is
 * ready.
 */
export function trayWantedAtStartup(): boolean {
  if (harnessProcess()) return false
  return readPersistedFlag('trayPersistent')
}

/**
 * Hold the lock so a later launch focuses this window instead of starting
 * another process that the user cannot see (the first one is only in the tray).
 * Returns false when another instance already holds it.
 */
export function claimTrayInstance(): boolean {
  if (lockHeld || harnessProcess()) return lockHeld || harnessProcess()
  const got = app.requestSingleInstanceLock()
  if (!got) return false
  lockHeld = true
  return true
}

export function releaseTrayInstance(): void {
  if (!lockHeld) return
  app.releaseSingleInstanceLock()
  lockHeld = false
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
  if (!options.enabled) {
    destroyTray()
    releaseTrayInstance()
    return
  }
  if (harnessProcess()) return
  if (!claimTrayInstance()) {
    // Another copy owns the lock, so a later launch focuses that one and not
    // this window. The tray is still worth having, but the split is worth a
    // line in the log.
    console.error('[pi-desktop] another instance holds the single-instance lock')
  }
  const image = trayIconImage()
  if (!image) {
    destroyTray()
    releaseTrayInstance()
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
