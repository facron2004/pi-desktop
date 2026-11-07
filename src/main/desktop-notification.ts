import { BrowserWindow, nativeTheme, screen, type Display } from 'electron'
import type { ThemePreference } from '@shared/types'

const WIDTH = 384
const HEIGHT = 116
const GAP = 10
const MARGIN = 20
const MAX_VISIBLE = 3
const LIFETIME_MS = 7000
const ACTIVATE_URL = 'pi-desktop-notification://activate'
const DISMISS_URL = 'pi-desktop-notification://dismiss'

interface DesktopNotification {
  window: BrowserWindow
  displayId: number
  workArea: Display['workArea']
  timer: NodeJS.Timeout
}

const notifications: DesktopNotification[] = []

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

function notificationHtml(title: string, body: string, theme: 'dark' | 'light'): string {
  return `<!doctype html>
<html data-theme="${theme}">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
    body { font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--fg); }
    .card {
      position: relative; height: 100%; padding: 17px 18px 18px;
      border: 1px solid var(--border); border-radius: 14px;
      background: var(--bg); box-shadow: 0 8px 30px rgba(0,0,0,.18);
      -webkit-app-region: no-drag;
    }
    .top { display: flex; align-items: center; gap: 10px; margin-bottom: 9px; }
    .mark { width: 25px; height: 25px; position: relative; flex: none; }
    .pixel { position: absolute; width: 10px; height: 10px; border-radius: 2px; }
    .p1 { left: 1px; top: 1px; background: #ef8b7d; }
    .p2 { left: 12px; top: 1px; background: #ef8b7d; }
    .p3 { left: 1px; top: 12px; background: #4d9fc2; }
    .p4 { left: 12px; top: 12px; background: #4d9fc2; }
    .p5 { left: 18px; top: 12px; width: 6px; height: 13px; background: #efbb53; }
    .title { flex: 1; min-width: 0; color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: .01em; }
    .close { width: 24px; height: 24px; display: grid; place-items: center; border-radius: 6px; color: var(--muted); text-decoration: none; font-size: 18px; line-height: 1; }
    .close:hover { background: var(--hover); color: var(--fg); }
    .body { display: block; color: var(--fg); text-decoration: none; font-size: 14px; font-weight: 500; line-height: 1.4; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .progress { position: absolute; height: 2px; bottom: 0; left: 14px; right: 14px; overflow: hidden; border-radius: 2px; background: var(--track); }
    .progress::after { content: ""; display: block; width: 100%; height: 100%; background: var(--accent); transform-origin: left; animation: expire 7s linear forwards; }
    @keyframes expire { to { transform: scaleX(0); } }
    html[data-theme="light"] { --bg: rgba(255,255,255,.98); --fg: #202124; --muted: #777d86; --border: rgba(25,30,40,.1); --hover: rgba(0,0,0,.06); --track: rgba(80,130,220,.14); --accent: #4d8dff; }
    html[data-theme="dark"] { --bg: rgba(35,37,42,.98); --fg: #f2f3f5; --muted: #a2a6ae; --border: rgba(255,255,255,.11); --hover: rgba(255,255,255,.09); --track: rgba(110,155,255,.2); --accent: #79a7ff; }
  </style>
</head>
<body>
  <div class="card">
    <div class="top">
      <div class="mark" aria-hidden="true"><i class="pixel p1"></i><i class="pixel p2"></i><i class="pixel p3"></i><i class="pixel p4"></i><i class="pixel p5"></i></div>
      <span class="title">${escapeHtml(title)}</span>
      <a class="close" href="${DISMISS_URL}" target="_blank" aria-label="Dismiss">×</a>
    </div>
    <a class="body" href="${ACTIVATE_URL}" target="_blank" title="${escapeHtml(body)}">${escapeHtml(body)}</a>
    <div class="progress" aria-hidden="true"></div>
  </div>
</body>
</html>`
}

function placeNotifications(displayId: number): void {
  const visible = notifications.filter(
    (entry) => entry.displayId === displayId && !entry.window.isDestroyed()
  )
  visible.forEach((entry, index) => {
    const bottomOffset = (visible.length - index) * (HEIGHT + GAP) - GAP
    entry.window.setBounds({
      x: entry.workArea.x + entry.workArea.width - WIDTH - MARGIN,
      y: entry.workArea.y + entry.workArea.height - bottomOffset - MARGIN,
      width: WIDTH,
      height: HEIGHT
    })
  })
}

export function showDesktopNotification(
  mainWindow: BrowserWindow,
  title: string,
  body: string,
  themePreference: ThemePreference
): void {
  if (mainWindow.isDestroyed()) return

  const display = screen.getDisplayMatching(mainWindow.getBounds())
  const sameDisplay = notifications.filter((entry) => entry.displayId === display.id)
  if (sameDisplay.length >= MAX_VISIBLE) sameDisplay[0].window.close()

  const theme = themePreference === 'system'
    ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    : themePreference
  const notification = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  const timer = setTimeout(() => {
    if (!notification.isDestroyed()) notification.close()
  }, LIFETIME_MS)
  notifications.push({ window: notification, displayId: display.id, workArea: display.workArea, timer })

  notification.webContents.setWindowOpenHandler(({ url }) => {
    if (url === ACTIVATE_URL) {
      if (!mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        if (!mainWindow.isVisible()) mainWindow.show()
        mainWindow.focus()
      }
      if (!notification.isDestroyed()) notification.close()
    } else if (url === DISMISS_URL && !notification.isDestroyed()) {
      notification.close()
    }
    return { action: 'deny' }
  })

  notification.on('closed', () => {
    clearTimeout(timer)
    const index = notifications.findIndex((entry) => entry.window === notification)
    if (index >= 0) notifications.splice(index, 1)
    placeNotifications(display.id)
  })

  void notification.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(notificationHtml(title, body, theme))}`
  ).then(() => {
    if (notification.isDestroyed()) return
    placeNotifications(display.id)
    notification.showInactive()
  }).catch((error: unknown) => {
    console.error('[pi-desktop] could not show desktop notification:', error)
    if (!notification.isDestroyed()) notification.close()
  })
}
