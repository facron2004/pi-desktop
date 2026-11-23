import path from 'node:path'
import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Tray,
  type BrowserWindowConstructorOptions
} from 'electron'
import type { TrayPopupState } from '@shared/types'
import { trayIconImage } from './app-icon'
import { resolveRendererEntry } from './navigation-policy'
import { popupPlacement, hasUsableBounds } from './tray-placement'

let tray: Tray | null = null
let popup: BrowserWindow | null = null
let quitting = false
let lockHeld = false
/** The popup has painted its first frame and may be shown. */
let ready = false
/** The popup has held the focus at least once; only then may blur close it. */
let everFocused = false
/** A right-click arrived before the page was ready. */
let showPending = false
/** When the popup was last shown, so an early blur cannot close it at once. */
let shownAt = 0
/**
 * How long after `show()` a blur is ignored while the popup has not been
 * focused. Focus is granted within a frame or two; a menu that never receives
 * it must still close when the reader clicks away.
 */
const BLUR_GRACE_MS = 250

/** Cap each section so the popup keeps a predictable, modest height. */
const MAX_RUNNING = 3
const MAX_RECENT = 3
const POPUP_WIDTH = 300
const POPUP_MIN_HEIGHT = 120
const POPUP_MAX_HEIGHT = 520

interface TrayOptions {
  language?: string
  theme?: 'dark' | 'light'
  show: () => void
  openConversation: (key: string) => void
}

/** Kept so the popup and IPC handlers can act without new arguments. */
let lastOptions: TrayOptions | null = null
let conversations: import('@shared/types').TrayConversation[] = []

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
  if (popup && !popup.isDestroyed()) popup.destroy()
  popup = null
  ready = false
  everFocused = false
  showPending = false
  if (!tray) return
  tray.destroy()
  tray = null
  lastOptions = null
}

function popupLabels(language: string | undefined): TrayPopupState['labels'] {
  if (language === 'zh-CN') {
    return {
      show: '显示主窗口',
      running: '进行中的对话',
      recent: '最近对话',
      quit: '退出',
      empty: '暂无对话'
    }
  }
  return {
    show: 'Show window',
    running: 'In progress',
    recent: 'Recent conversations',
    quit: 'Quit',
    empty: 'No conversations yet'
  }
}

function currentState(): TrayPopupState {
  const running = conversations.filter((item) => item.isStreaming).slice(0, MAX_RUNNING)
  const recent = conversations.filter((item) => !item.isStreaming).slice(0, MAX_RECENT)
  return {
    running,
    recent,
    labels: popupLabels(lastOptions?.language)
  }
}

function sendToPopup(channel: string, payload: unknown): void {
  if (!popup || popup.isDestroyed()) return
  const contents = popup.webContents
  if (!contents || contents.isDestroyed()) return
  try {
    contents.send(channel, payload)
  } catch (error) {
    console.error(`[pi-desktop] could not deliver "${channel}" to tray popup:`, error)
  }
}

/** Replace the conversations offered by the popup. */
export function setTrayConversations(list: import('@shared/types').TrayConversation[]): void {
  conversations = Array.isArray(list)
    ? list.slice(0, MAX_RUNNING + MAX_RECENT + 4)
    : []
  sendToPopup('tray-popup:state', currentState())
}

function popupUrl(theme: 'dark' | 'light'): { load: () => Promise<void> } {
  // app-main and this module are bundled into out/main/chunks after the setup
  // entry split, so __dirname is not the app root. Resolve from getAppPath().
  const entryFile = path.join(app.getAppPath(), 'out', 'renderer', 'tray.html')
  const entry = resolveRendererEntry(app.isPackaged, process.env.ELECTRON_RENDERER_URL, entryFile)
  if (entry.developmentUrl) {
    const url = new URL(entry.developmentUrl)
    // The dev server URL points at the app root; the popup is its own HTML
    // entry. Resolve it against the root so dev loads the popup, not index.
    url.pathname = new URL('tray.html', url).pathname
    url.searchParams.set('piDesktopTheme', theme)
    return { load: () => popup!.loadURL(url.toString()) }
  }
  return { load: () => popup!.loadFile(entryFile, { query: { piDesktopTheme: theme } }) }
}

function positionPopup(): void {
  if (!popup || popup.isDestroyed() || !tray || tray.isDestroyed()) return
  const bounds = tray.getBounds()
  // An icon in the overflow flyout reports no rectangle; the pointer is then
  // the anchor, so the popup still opens where the reader clicked.
  const anchor = hasUsableBounds(bounds) ? bounds : null
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayMatching(anchor ?? { x: cursor.x, y: cursor.y, width: 1, height: 1 })
  const area = display.workArea
  const [width, height] = popup.getContentSize()
  const point = popupPlacement(anchor, cursor, { width, height }, area)
  popup.setPosition(point.x, point.y)
}

function createPopup(): boolean {
  if (popup && !popup.isDestroyed()) return true
  if (!lastOptions) return false
  const theme = lastOptions.theme ?? 'dark'
  const options: BrowserWindowConstructorOptions = {
    width: POPUP_WIDTH,
    height: POPUP_MIN_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  }
  const created = new BrowserWindow(options)
  popup = created
  ready = false
  everFocused = false
  // A transparent frameless window with no drag region: it lives briefly by
  // the tray icon and closes on blur/Escape, so the OS drag strip is moot.
  created.on('closed', () => {
    if (popup === created) popup = null
    ready = false
    everFocused = false
  })
  created.on('focus', () => {
    everFocused = true
  })
  created.on('blur', () => {
    // Clicking the icon again or elsewhere dismisses the transient popup — but
    // only once it has actually had a chance to hold the focus. A window shown
    // from a process that is not in the foreground can report `blur` before it
    // ever receives `focus`, and hiding on that would close the menu in the
    // same frame it appeared: the icon looks dead. Focus arrives within a few
    // milliseconds when it arrives at all, so a short grace period keeps a
    // popup that never got focus from staying on screen forever.
    if (!everFocused && Date.now() - shownAt < BLUR_GRACE_MS) return
    if (popup === created && !created.isDestroyed() && created.isVisible()) created.hide()
  })
  created.once('ready-to-show', () => {
    ready = true
    // A right-click that arrived while the page was still loading asked for the
    // popup; it is ready now, so honour it instead of swallowing the click.
    if (showPending) {
      showPending = false
      showPopup()
    }
  })
  const loader = popupUrl(theme)
  void loader.load().catch((error: unknown) => {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : ''
    if (code === 'ERR_ABORTED' || created.isDestroyed()) return
    console.error('[pi-desktop] tray popup load failed:', error)
  })
  return true
}

function showPopup(): void {
  if (quitting) return
  if (!createPopup()) return
  if (!popup || popup.isDestroyed()) return
  if (popup.isVisible()) {
    popup.hide()
    return
  }
  if (!ready) {
    // Showing a transparent window before its first paint composites an empty
    // rectangle: the menu is "open" but nothing is drawn. Wait for the page.
    showPending = true
    return
  }
  sendToPopup('tray-popup:state', currentState())
  positionPopup()
  shownAt = Date.now()
  popup.show()
  popup.focus()
}

function hidePopup(): void {
  if (!popup || popup.isDestroyed()) return
  if (popup.isVisible()) popup.hide()
}

/**
 * Keep an already-open popup in sync with a settings change. Called after the
 * options are updated in `syncTray`.
 */
function refreshPopup(): void {
  if (!popup || popup.isDestroyed() || !popup.isVisible()) return
  sendToPopup('tray-popup:state', currentState())
}

// --- Popup-originated IPC ---------------------------------------------------

ipcMain.handle('tray-popup:get-state', () => currentState())
ipcMain.on('tray-popup:set-height', (_event, height: unknown) => {
  if (!popup || popup.isDestroyed() || typeof height !== 'number' || !Number.isFinite(height)) return
  const next = Math.max(POPUP_MIN_HEIGHT, Math.min(Math.round(height), POPUP_MAX_HEIGHT))
  const [width] = popup.getContentSize()
  if (popup.getContentSize()[1] === next) return
  popup.setContentSize(width, next)
  positionPopup()
})
ipcMain.on('tray-popup:open-conversation', (_event, key: unknown) => {
  hidePopup()
  if (typeof key !== 'string' || !lastOptions) return
  lastOptions.openConversation(key)
})
ipcMain.on('tray-popup:show-window', () => {
  hidePopup()
  lastOptions?.show()
})
ipcMain.on('tray-popup:quit', () => {
  hidePopup()
  app.quit()
})
ipcMain.on('tray-popup:close', () => hidePopup())

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

export function syncTray(options: TrayOptions & { enabled: boolean }): void {
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
  lastOptions = {
    language: options.language,
    theme: options.theme,
    show: options.show,
    openConversation: options.openConversation
  }
  if (!tray || tray.isDestroyed()) {
    tray = new Tray(image)
    tray.setToolTip('Pi Desktop')
    // The hidden window leaves the taskbar, so the icon itself has to open it.
    // Delegate through `lastOptions` so later `syncTray()` calls update the target.
    const show = () => lastOptions?.show()
    tray.on('click', show)
    tray.on('double-click', show)
    // Right-click draws the custom popup instead of a native context menu.
    tray.on('right-click', showPopup)
  } else {
    tray.setImage(image)
  }
  refreshPopup()
}
