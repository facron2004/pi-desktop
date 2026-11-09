import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
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
import { applyTaskbarIcon, windowIconImage } from './app-icon'
import { scheduleCapture, scheduleWindowClose } from './screenshot'
import { secureUserDataDirectory, SettingsStore } from './settings'
import { TerminalManager } from './terminal'
import {
  claimTrayInstance,
  noteQuitting,
  shouldHideToTray,
  showWindow,
  syncTray,
  trayWantedAtStartup
} from './tray'
import { initialBounds, wasMaximized, watchWindowState } from './window-state'
import { isTrustedRendererNavigation, resolveRendererEntry } from './navigation-policy'
import { denyWebviewPopups, hardenWebviewPreferences, isAllowedWebviewUrl } from './webview-policy'

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

// Keep a harness run from reading or writing the user's regular app data.
// The name of the variable is the whole contract: it points the app at a
// throwaway data folder, whatever else the run is doing.
if (process.env.PI_DESKTOP_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.PI_DESKTOP_USER_DATA))
}
if (!secureUserDataDirectory(app.getPath('userData'))) {
  const message = 'Pi Desktop could not restrict access to its private app data directory and will exit to protect saved data.'
  console.error(`[pi-desktop] ${message}`)
  dialog.showErrorBox('Pi Desktop could not start', message)
  process.exit(1)
}

// A second launch while the app is only in the tray would open another window
// the user cannot find. The lock is taken only when that mode is already on,
// and never for the screenshot harness, which has to be able to start beside
// a running copy.
const primaryInstance = !trayWantedAtStartup() || claimTrayInstance()

let mainWindow: BrowserWindow | null = null
let settings: SettingsStore | null = null
let supervisor: SessionSupervisor | null = null
let terminalManager: TerminalManager | null = null
let memoryService: MemoryService | null = null
let autoTitleService: AutoTitleService | null = null
let remoteAccess: RemoteAccessService | null = null
let remoteInitialization: Promise<void> | null = null
let scheduledTaskService: ScheduledTaskService | null = null

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    hardenWebviewPreferences(webPreferences)
    if (!isAllowedWebviewUrl(params.src)) event.preventDefault()
  })

  if (contents.getType() !== 'webview') return
  // A browser page is untrusted. Keep window.open from creating a separate
  // BrowserWindow that would not inherit this guest's navigation guards.
  denyWebviewPopups(contents)
  const guardNavigation = (event: { preventDefault(): void }, navigationUrl: string) => {
    if (!isAllowedWebviewUrl(navigationUrl)) event.preventDefault()
  }
  contents.on('will-navigate', guardNavigation)
  contents.on('will-redirect', guardNavigation)
})

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
  const icon = windowIconImage()
  const rendererEntryFile = path.join(__dirname, '../renderer/index.html')
  const rendererEntry = resolveRendererEntry(
    app.isPackaged,
    process.env.ELECTRON_RENDERER_URL,
    rendererEntryFile
  )
  const trustedRendererUrl = rendererEntry.trustedUrl
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
    // Dev runs are electron.exe, whose own icon is what the taskbar shows
    // until the window carries the pixel mark. Packaged builds set the same
    // image so the button matches the shortcut.
    ...(icon ? { icon } : {}),
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
      sandbox: true,
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

  applyTaskbarIcon(window)

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

  window.on('close', (event) => {
    // Hide only when the tray is up. A real quit sets the quitting flag first,
    // so this does not swallow the shutdown path.
    if (!shouldHideToTray()) return
    event.preventDefault()
    window.hide()
  })

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

  const guardNavigation = (event: { preventDefault(): void }, navigationUrl: string) => {
    if (!isTrustedRendererNavigation(navigationUrl, trustedRendererUrl)) event.preventDefault()
  }
  window.webContents.on('will-navigate', guardNavigation)
  window.webContents.on('will-redirect', guardNavigation)

  if (rendererEntry.developmentUrl) {
    const url = new URL(rendererEntry.developmentUrl)
    url.searchParams.set('piDesktopTheme', theme)
    window.loadURL(url.toString())
  } else {
    window.loadFile(rendererEntryFile, {
      query: { piDesktopTheme: theme }
    })
  }

  return window
}

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
  app.quit()
}

process.on('SIGINT', handleTerminationSignal)
process.on('SIGTERM', handleTerminationSignal)

function revealMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    // Settings exist only after startup. A second launch that arrives before
    // the first window is up has nothing to reveal yet.
    if (!settings) return
    mainWindow = createWindow()
  }
  showWindow(mainWindow)
}

function applyTray(): void {
  const current = settings?.get()
  syncTray({
    enabled: current?.trayPersistent === true,
    language: current?.language,
    show: () => revealMainWindow()
  })
}

async function start(): Promise<void> {
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
  supervisor = new SessionSupervisor(
    () => new PiRuntime(runtimeOptions),
    path.join(app.getPath('userData'), 'cwd-gate')
  )
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
  applyTray()

  const context = {
    supervisor,
    settings,
    getWindow: () => mainWindow,
    terminals: terminalManager,
    memory: memoryService,
    remote: remoteAccess,
    remoteReady,
    scheduledTasks: scheduledTaskService,
    syncTray: () => applyTray()
  }
  registerIpc(context)
  bridgeRuntime(context)

  scheduleCapture({ window: mainWindow, supervisor })
  scheduleWindowClose({ window: mainWindow })

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      showWindow(mainWindow)
      return
    }
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
      applyTray()
    }
  })
}

if (primaryInstance) {
  // Registered for the life of the process, so turning the tray on later still
  // focuses this window when a second launch asks for the lock.
  app.on('second-instance', () => revealMainWindow())
  app.whenReady().then(start)
}

app.on('before-quit', () => {
  // Set before any window closes, so the close handler does not hide a quit.
  noteQuitting()
  // PTY children belong to this process; leaving them behind leaks shells.
  terminalManager?.disposeAll()
  disposeRemoteAccess()
  memoryService?.dispose()
  autoTitleService?.dispose()
  scheduledTaskService?.stopScheduling()
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

  // Leave time for active Pi runs and subagents to process cancellation before
  // the process-tree kill fallback.
  const watchdog = setTimeout(() => {
    console.error('[pi-desktop] shutdown watchdog timed out after 20s; forcing exit')
    shutdownComplete = true
    scheduledTaskService?.dispose()
    app.quit()
    setTimeout(() => process.exit(0), 1000).unref()
  }, 20_000)
  watchdog.unref()

  void supervisor.stop().catch((error: unknown) => {
    console.error('[pi-desktop] shutdown failed:', error)
  }).finally(() => {
    clearTimeout(watchdog)
    shutdownComplete = true
    scheduledTaskService?.dispose()
    app.quit()
  })
})

// Quit only after the shutdown listeners exist. A second launch loses the
// lock before `ready`, and `app.quit()` at that point still emits `before-quit`.
if (!primaryInstance) app.quit()
