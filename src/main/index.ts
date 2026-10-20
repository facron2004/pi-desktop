import { app, BrowserWindow, shell } from 'electron'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { bridgeRuntime, registerIpc } from './ipc'
import { PiRuntime } from './pi/runtime'
import { scheduleCapture, scheduleWindowClose } from './screenshot'
import { SettingsStore } from './settings'
import { initialBounds, wasMaximized, watchWindowState } from './window-state'

const isMac = process.platform === 'darwin'

// Keep screenshot runs from reading or writing the user's regular app data.
if (process.env.PI_DESKTOP_SCREENSHOT && process.env.PI_DESKTOP_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.PI_DESKTOP_USER_DATA))
}

let mainWindow: BrowserWindow | null = null
let settings: SettingsStore | null = null
let runtime: PiRuntime | null = null

function createWindow(): BrowserWindow {
  const bounds = initialBounds()
  const window = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#181818',
    title: 'Pi Desktop',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 18, y: 18 } }
      : {
          titleBarOverlay: {
            color: '#181818',
            symbolColor: '#a7a7a7',
            height: 44
          }
        }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
      additionalArguments: [
        ...(process.env.PI_DESKTOP_PREFILL
          ? [`--pi-desktop-prefill=${process.env.PI_DESKTOP_PREFILL}`]
          : []),
        ...(process.env.PI_DESKTOP_OPEN_CHANGES ? ['--pi-desktop-open-changes'] : []),
        ...(process.env.PI_DESKTOP_OPEN_FILES ? ['--pi-desktop-open-files'] : []),
        ...(process.env.PI_DESKTOP_FILE_SEARCH
          ? [`--pi-desktop-file-search=${process.env.PI_DESKTOP_FILE_SEARCH}`]
          : []),
        ...(process.env.PI_DESKTOP_OPEN_FILE
          ? [`--pi-desktop-open-file=${process.env.PI_DESKTOP_OPEN_FILE}`]
          : []),
        ...(process.env.PI_DESKTOP_SEARCH
          ? [`--pi-desktop-search=${process.env.PI_DESKTOP_SEARCH}`]
          : []),
        ...(process.env.PI_DESKTOP_SESSION
          ? [`--pi-desktop-session=${process.env.PI_DESKTOP_SESSION}`]
          : []),
        ...(process.env.PI_DESKTOP_SETTINGS ? ['--pi-desktop-settings'] : []),
        ...(process.env.PI_DESKTOP_EXPORT ? ['--pi-desktop-export'] : []),
        ...(process.env.PI_DESKTOP_OPEN_TERMINAL ? ['--pi-desktop-open-terminal'] : []),
        ...(process.env.PI_DESKTOP_COMMIT ? ['--pi-desktop-commit'] : []),
        // The screenshot harness wants the renderer to expose its store, so
        // that a state that is hard to produce can be reached.
        ...(process.env.PI_DESKTOP_SCREENSHOT ? ['--pi-desktop-dev'] : [])
      ]
    }
  })

  window.once('ready-to-show', () => window.show())

  // The size and place the user left the window in are kept for the next run.
  if (wasMaximized()) window.maximize()
  watchWindowState(window)

  // The window can be closed while Pi is still shutting down; drop the
  // reference so nothing tries to push events into a destroyed renderer.
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  // Surface renderer problems in the terminal during development.
  if (!app.isPackaged) {
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 'warning') {
        console.error(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`)
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
      // The whole path has to go into the hash: sibling folders share a long
      // prefix and a truncated one would give them the same id.
      id: `env-${createHash('sha256').update(forcedWorkspace).digest('hex').slice(0, 12)}`,
      path: forcedWorkspace,
      name: path.basename(forcedWorkspace) || forcedWorkspace,
      lastOpenedAt: Date.now()
    }
    settings.addWorkspace(workspace)
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
