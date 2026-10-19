import { app, BrowserWindow, shell } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { bridgeRuntime, registerIpc } from './ipc'
import { PiRuntime } from './pi/runtime'
import { scheduleCapture, scheduleWindowClose } from './screenshot'
import { SettingsStore } from './settings'

const isMac = process.platform === 'darwin'

let mainWindow: BrowserWindow | null = null
let settings: SettingsStore | null = null
let runtime: PiRuntime | null = null

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0d10',
    title: 'Pi Desktop',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 18, y: 18 } }
      : {
          titleBarOverlay: {
            color: '#0b0d10',
            symbolColor: '#8a93a3',
            height: 44
          }
        }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true
    }
  })

  window.once('ready-to-show', () => window.show())

  // The window can be closed while Pi is still shutting down; drop the
  // reference so nothing tries to push events into a destroyed renderer.
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  // Surface renderer problems in the terminal during development.
  if (!app.isPackaged) {
    window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      if (level >= 2) {
        console.error(`[renderer] ${message} (${sourceId}:${line})`)
      }
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      console.error('[renderer] process gone:', details.reason)
    })
    window.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.error('[renderer] preload error:', preloadPath, error)
    })
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    window.loadURL(devServerUrl)
  } else {
    window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return window
}

app.setAppUserModelId('dev.pi.desktop')

/**
 * A stray exception in the main process must not surface as a native error
 * dialog that blocks the app. Log it to the user data folder instead so the
 * problem is still diagnosable.
 */
process.on('uncaughtException', (error: Error) => {
  console.error('[pi-desktop] uncaught exception:', error)
  try {
    const logDir = app.getPath('logs')
    mkdirSync(logDir, { recursive: true })
    appendFileSync(
      path.join(logDir, 'pi-desktop.log'),
      `${new Date().toISOString()}\n${error?.stack ?? String(error)}\n\n`,
      'utf8'
    )
  } catch {
    /* logging must never throw */
  }
})

app.whenReady().then(() => {
  settings = new SettingsStore()

  // Development helper: open a folder that was passed in on the command line.
  const forcedWorkspace = process.env.PI_DESKTOP_WORKSPACE
  if (forcedWorkspace) {
    const workspaces = settings.get().workspaces
    const existing = workspaces.find((item) => item.path === forcedWorkspace)
    const workspace = existing ?? {
      id: `env-${Buffer.from(forcedWorkspace).toString('hex').slice(0, 12)}`,
      path: forcedWorkspace,
      name: path.basename(forcedWorkspace) || forcedWorkspace,
      lastOpenedAt: Date.now()
    }
    settings.addWorkspace(workspace)
  }

  const forcedTheme = process.env.PI_DESKTOP_THEME
  if (forcedTheme === 'light' || forcedTheme === 'dark' || forcedTheme === 'system') {
    settings.patch({ theme: forcedTheme })
  }

  runtime = new PiRuntime({
    customPiPath: settings.get().piPath,
    trustProject: settings.get().trustProject
  })

  mainWindow = createWindow()

  const context = {
    runtime,
    settings,
    getWindow: () => mainWindow
  }
  registerIpc(context)
  bridgeRuntime(context)

  scheduleCapture({ window: mainWindow, runtime })
  scheduleWindowClose({ window: mainWindow, runtime })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  // The keep-alive flag is a development aid for the window-close test.
  if (!isMac && process.env.PI_DESKTOP_KEEP_ALIVE !== '1') app.quit()
})

app.on('before-quit', async () => {
  await runtime?.stop()
})
