import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { bridgeRuntime, registerIpc, sendToWindow } from './ipc'
import { MemoryService } from './memory/service'
import { AutoTitleService } from './auto-title'
import { MemoryStore } from './memory/store'
import { ScheduledTaskService } from './scheduled-tasks'
import { PiRuntime } from './pi/runtime'
import { SessionSupervisor } from './pi/supervisor'
import { RemoteAccessService } from './remote-access'
import { scheduleCapture, scheduleWindowClose } from './screenshot'
import { SettingsStore } from './settings'
import { TerminalManager } from './terminal'
import { initialBounds, wasMaximized, watchWindowState } from './window-state'

const isMac = process.platform === 'darwin'

/**
 * stdout/stderr are pipes when a parent is reading them. If that parent goes
 * away — or ConPTY detaches the console when a pty exits — the next
 * `console.log` throws `EPIPE`. Electron turns that uncaught write into a
 * native "JavaScript error occurred in the main process" dialog. An error
 * listener keeps the write from becoming an exception.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream?.on('error', (error: NodeJS.ErrnoException) => {
    if (error?.code === 'EPIPE') return
    setImmediate(() => {
      throw error
    })
  })
}

// Keep screenshot runs from reading or writing the user's regular app data.
if (process.env.PI_DESKTOP_SCREENSHOT && process.env.PI_DESKTOP_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.PI_DESKTOP_USER_DATA))
}

let mainWindow: BrowserWindow | null = null
let settings: SettingsStore | null = null
let supervisor: SessionSupervisor | null = null
let terminalManager: TerminalManager | null = null
let memoryService: MemoryService | null = null
let autoTitleService: AutoTitleService | null = null
let remoteAccess: RemoteAccessService | null = null
let remoteInitialization: Promise<void> | null = null
let scheduledTaskService: ScheduledTaskService | null = null

function startupTheme(): 'light' | 'dark' {
  const forcedTheme = process.env.PI_DESKTOP_THEME
  const preference =
    forcedTheme === 'light' || forcedTheme === 'dark' || forcedTheme === 'system'
      ? forcedTheme
      : settings?.get().theme ?? 'dark'
  return preference === 'system'
    ? nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    : preference
}

function disposeRemoteAccess(): void {
  const dispose = () => {
    const pending = remoteAccess?.dispose()
    if (pending) void pending.catch(() => {})
  }
  if (remoteInitialization) void remoteInitialization.then(dispose).catch(() => {})
  else dispose()
}

function createWindow(): BrowserWindow {
  const bounds = initialBounds()
  const theme = startupTheme()
  const dark = theme === 'dark'
  const window = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 880,
    minHeight: 572,
    // window-state stores the content area, so width/height have to mean the
    // same thing when the window is created again. Without this the frame is
    // counted twice and the window creeps larger on every launch.
    useContentSize: true,
    show: false,
    backgroundColor: dark ? '#16181d' : '#ffffff',
    title: 'Pi Desktop',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 18, y: 18 } }
      : {
          titleBarOverlay: {
            color: dark ? '#111317' : '#f3f3f3',
            symbolColor: dark ? '#9da4b2' : '#686868',
            height: 44
          }
        }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The inspector's browser tab is a <webview>: an isolated, sandboxed view
      // of the page the reader typed, with no preload and no node access.
      webviewTag: true,
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

  // Windows rounds the frame to physical pixels at fractional display scaling,
  // so a requested content size can come back a pixel or two larger. Re-assert
  // the stored size before the window is shown; otherwise the rounding becomes
  // the next run's input and the window creeps bigger on every launch.
  window.setContentSize(bounds.width, bounds.height)

  let readyToShow = false
  let rendererStartupReady = false
  const showWhenReady = () => {
    if (readyToShow && rendererStartupReady && !window.isDestroyed()) window.show()
  }
  const onStartupReady = (event: Electron.IpcMainEvent) => {
    if (event.sender !== window.webContents) return
    rendererStartupReady = true
    showWhenReady()
  }
  ipcMain.on('app:startup-ready', onStartupReady)
  window.once('ready-to-show', () => {
    readyToShow = true
    showWhenReady()
  })

  // The size and place the user left the window in are kept for the next run.
  if (wasMaximized()) window.maximize()
  watchWindowState(window)

  // The window can be closed while Pi is still shutting down; drop the
  // reference so nothing tries to push events into a destroyed renderer.
  window.on('closed', () => {
    ipcMain.removeListener('app:startup-ready', onStartupReady)
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

    // Allow toggling DevTools via F12 or Ctrl+Shift+I (Cmd+Option+I on macOS)
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const isF12 = input.key === 'F12'
      const isDevToolsCombo =
        (input.control || input.meta) &&
        (input.shift || input.alt) &&
        input.key.toLowerCase() === 'i'
      if (isF12 || isDevToolsCombo) {
        window.webContents.toggleDevTools()
        event.preventDefault()
      }
    })

    if (!process.env.PI_DESKTOP_SCREENSHOT) {
      window.webContents.openDevTools({ mode: 'detach' })
    }
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    const url = new URL(devServerUrl)
    url.searchParams.set('piDesktopTheme', theme)
    window.loadURL(url.toString())
  } else {
    window.loadFile(path.join(__dirname, '../renderer/index.html'), {
      query: { piDesktopTheme: theme }
    })
  }

  return window
}

app.setAppUserModelId('dev.pi.desktop')

/**
 * A stray exception in the main process must not surface as a native error
 * dialog that blocks the app. Log it to the user data folder instead so the
 * problem is still diagnosable.
 */
process.on('uncaughtException', (error: NodeJS.ErrnoException) => {
  // The stream listener above usually swallows this. If one still escapes,
  // logging it would write to the same broken pipe and the dialog would win.
  if (error?.code === 'EPIPE') return
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
  try {
    console.error('[pi-desktop] uncaught exception:', error)
  } catch {
    /* stderr may already be closed */
  }
})

process.on('unhandledRejection', (reason: unknown) => {
  try {
    const logDir = app.getPath('logs')
    mkdirSync(logDir, { recursive: true })
    const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason)
    appendFileSync(
      path.join(logDir, 'pi-desktop.log'),
      `${new Date().toISOString()} [unhandledRejection]\n${message}\n\n`,
      'utf8'
    )
  } catch {
    /* logging must never throw */
  }
  try {
    console.error('[pi-desktop] unhandled rejection:', reason)
  } catch {
    /* stderr may already be closed */
  }
})

function handleTerminationSignal(): void {
  try {
    terminalManager?.disposeAll()
  } catch {
    /* ignore */
  }
  disposeRemoteAccess()
  if (supervisor) {
    void supervisor
      .stop()
      .catch(() => {})
      .finally(() => {
        process.exit(0)
      })
    setTimeout(() => {
      process.exit(0)
    }, 2000).unref()
  } else {
    process.exit(0)
  }
}

process.on('SIGINT', handleTerminationSignal)
process.on('SIGTERM', handleTerminationSignal)

app.whenReady().then(async () => {
  const settingsStore = new SettingsStore()
  settings = settingsStore

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

  const runtimeOptions = {
    customPiPath: settingsStore.get().piPath,
    trustProject: settingsStore.get().trustProject,
    getPermissionMode: () => settingsStore.get().permissionMode ?? 'ask',
    getComputerUse: () => settingsStore.get().computerUse === true,
    // Read when a process is built, and only applied to a session Pi has never
    // written — a conversation already under way keeps the mode it stored.
    getDefaultPlanMode: () => settingsStore.get().defaultPlanMode === true,
    // An empty field follows the conversation, so it is passed as undefined
    // rather than as a model id; the generator still rejects a bad shape.
    getSubagentModel: () => {
      const current = settingsStore.get()
      const model = current.subagentModel?.trim() ?? ''
      const provider = current.subagentProvider?.trim() ?? ''
      // `model` and `provider` are kept the same way here as for the conversation's
      // own model: a stored id may be bare, with its provider beside it.
      const spec = model.includes('/') || !provider ? model : `${provider}/${model}`
      const thinking = current.subagentThinking?.trim()
      return { model: spec || undefined, thinking: thinking || undefined }
    }
  }
  supervisor = new SessionSupervisor(() => new PiRuntime(runtimeOptions))
  const memoryStore = new MemoryStore(path.join(app.getPath('userData'), 'memories'))
  memoryService = new MemoryService(memoryStore, () => settingsStore.get())
  memoryService.attach(supervisor)
  memoryService.startupScan()
  // A second listener on the same stream, deliberately not part of MemoryService:
  // a title is wanted for every new conversation, while memory skips the ones that
  // used MCP or a subagent. One service's rules must not edit the other's.
  autoTitleService = new AutoTitleService(() => settingsStore.get())
  autoTitleService.attach(supervisor)
  terminalManager = new TerminalManager((channel, payload) => {
    sendToWindow(mainWindow, channel, payload)
  })

  remoteAccess = new RemoteAccessService({
    userData: app.getPath('userData'),
    uiDirectory: path.join(app.getAppPath(), 'out', 'remote'),
    settings: settingsStore,
    supervisor,
    customInstructions: (cwd) => {
      const user = settingsStore.get().customInstructions?.trim()
      const memory = memoryService?.promptFor(cwd).trim() ?? ''
      return [user, memory].filter(Boolean).join('\n\n---\n\n') || undefined
    }
  })
  // Network binding can wait on OS setup; let the window paint while the
  // service initializes, and gate remote IPC on this promise below.
  const remoteReady = remoteAccess.initialize().then(() => undefined).catch((error: unknown) => {
    console.error('[pi-desktop] remote access initialization failed:', error)
  })
  remoteInitialization = remoteReady

  scheduledTaskService = new ScheduledTaskService({
    userData: app.getPath('userData'),
    settings: settingsStore,
    supervisor,
    customInstructions: (cwd) => {
      const user = settingsStore.get().customInstructions?.trim()
      const memory = memoryService?.promptFor(cwd).trim() ?? ''
      return [user, memory].filter(Boolean).join('\n\n---\n\n') || undefined
    }
  })

  mainWindow = createWindow()

  const context = {
    supervisor,
    settings,
    getWindow: () => mainWindow,
    terminals: terminalManager,
    memory: memoryService,
    remote: remoteAccess,
    remoteReady,
    scheduledTasks: scheduledTaskService
  }
  registerIpc(context)
  bridgeRuntime(context)

  scheduleCapture({ window: mainWindow, supervisor })
  scheduleWindowClose({ window: mainWindow })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('before-quit', () => {
  // PTY children belong to this process; leaving them behind leaks shells.
  terminalManager?.disposeAll()
  disposeRemoteAccess()
  memoryService?.dispose()
  autoTitleService?.dispose()
  scheduledTaskService?.dispose()
})

app.on('window-all-closed', () => {
  // The keep-alive flag is a development aid for the window-close test.
  if (!isMac && process.env.PI_DESKTOP_KEEP_ALIVE !== '1') app.quit()
})

let shutdownComplete = false
let shuttingDown = false
app.on('before-quit', (event) => {
  if (shutdownComplete || !supervisor) return
  event.preventDefault()
  if (shuttingDown) return
  shuttingDown = true

  // Force shutdown completion after 5 seconds if supervisor.stop() hangs
  const watchdog = setTimeout(() => {
    console.error('[pi-desktop] shutdown watchdog timed out after 5s; forcing exit')
    shutdownComplete = true
    app.quit()
    setTimeout(() => process.exit(0), 1000).unref()
  }, 5000)
  watchdog.unref()

  void supervisor.stop().catch((error: unknown) => {
    console.error('[pi-desktop] shutdown failed:', error)
  }).finally(() => {
    clearTimeout(watchdog)
    shutdownComplete = true
    app.quit()
  })
})
