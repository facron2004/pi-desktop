import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, webContents } from 'electron'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { readdir, rm, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import type * as pty from 'node-pty'
import { bridgeRuntime, registerIpc, sendToWindow } from './ipc'
import { MemoryService } from './memory/service'
import { AutoTitleService } from './auto-title'
import { MemoryStore } from './memory/store'
import { ScheduledTaskService } from './scheduled-tasks'
import { cleanupStaticExtensionCache, isActiveRuntimeScratchEntry, PiRuntime } from './pi/runtime'
import { readAgentPresets } from './pi/agents'
import { fetchPiCatalog } from './pi-catalog'
import { canonicalPath } from './pi/session-file'
import { SessionSupervisor } from './pi/supervisor'
import { RemoteAccessService } from './remote-access'
import { ImChannelService } from './channels/im-channel-service'
import { createChannelAdapter } from './channels/adapters'
import { applyTaskbarIcon, windowIconImage } from './app-icon'
import { scheduleCapture, scheduleWindowClose } from './screenshot'
import { didUserDataAclChange, secureUserDataDirectory, scheduleUserDataAclSweep, SettingsStore } from './settings'
import { configureExternalSessionRoots, resolveSessionRoots } from './sessions'
import { TerminalManager } from './terminal'
import {
  claimSingleInstance,
  isQuitting,
  noteQuitting,
  shouldHideToTray,
  showWindow,
  syncTray
} from './tray'
import { initialBounds, wasMaximized, watchWindowState } from './window-state'
import { isTrustedRendererNavigation, resolveRendererEntry } from './navigation-policy'
import {
  browserHistoryCommand,
  browserMouseDirection,
  claimBrowserHistoryNav,
  denyWebviewPopups,
  hardenWebviewPreferences,
  isAllowedWebviewUrl,
  type BrowserHistoryDirection
} from './webview-policy'
import { isolateUserDataEnvironment } from './user-data'

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
// throwaway data folder, whatever else the run is doing. It comes before the
// single-instance lock because Electron keys that lock on the data folder.
if (process.env.PI_DESKTOP_USER_DATA) {
  const userData = path.resolve(process.env.PI_DESKTOP_USER_DATA)
  app.setPath('userData', userData)
  isolateUserDataEnvironment(userData)
}

// One app, one window. The lock is taken before any startup work, so a second
// launch — a double-click while the first copy is still starting — exits at
// once and asks the running instance to reveal its window. The screenshot
// harness is the one exception: it has to start beside a running copy.
const primaryInstance = claimSingleInstance()

// A process that lost the lock is about to quit: securing the data folder is
// the first copy's job and the expensive checks would only delay that exit.
if (primaryInstance && !secureUserDataDirectory(app.getPath('userData'))) {
  const message = 'Pi Desktop could not restrict access to its private app data directory and will exit to protect saved data.'
  console.error(`[pi-desktop] ${message}`)
  dialog.showErrorBox('Pi Desktop could not start', message)
  process.exit(1)
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
let imChannelService: ImChannelService | null = null
let startupFinished = false
/** A second launch that arrived before the first window existed. */
let revealPending = false

/** Last time a webview walked history, so a side button's two events count once. */
const browserHistoryNavAt = new Map<number, number>()

function browserMousePreload(): string | undefined {
  const file = path.join(app.getAppPath(), 'out', 'preload', 'browserMouse.js')
  return existsSync(file) ? file : undefined
}

function navigateBrowserGuest(contents: Electron.WebContents, direction: BrowserHistoryDirection): boolean {
  if (contents.isDestroyed() || contents.getType() !== 'webview') return false
  const canMove = direction === 'back' ? contents.canGoBack() : contents.canGoForward()
  if (!canMove) return false
  const now = Date.now()
  const last = browserHistoryNavAt.get(contents.id) ?? Number.NEGATIVE_INFINITY
  if (!claimBrowserHistoryNav(now, last)) return false
  browserHistoryNavAt.set(contents.id, now)
  if (direction === 'back') contents.goBack()
  else contents.goForward()
  return true
}

function attachBrowserHistoryKeys(window: BrowserWindow): void {
  // The side buttons on a mouse are an app command, not a click the page
  // handles. When that command lands on this window and the browser guest is
  // the focused page, walk that guest's history.
  window.on('app-command', (event, command) => {
    const direction = browserHistoryCommand(command)
    if (!direction) return
    const focused = webContents.getFocusedWebContents()
    if (!focused || focused.isDestroyed() || focused.getType() !== 'webview') return
    if (focused.hostWebContents?.id !== window.webContents.id) return
    if (navigateBrowserGuest(focused, direction)) event.preventDefault()
  })
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    hardenWebviewPreferences(webPreferences)
    // Drop anything the tag asked to preload, then install the one script
    // that reports mouse back/forward. The page cannot see it. A build that
    // has not emitted the script yet still opens the page; only the side
    // buttons wait for it.
    const mousePreload = browserMousePreload()
    if (mousePreload) webPreferences.preload = mousePreload
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

ipcMain.on('browser:mouse-history', (event, button: unknown) => {
  const direction = browserMouseDirection(button)
  if (!direction) return
  const guest = event.sender
  if (guest.getType() !== 'webview') return
  navigateBrowserGuest(guest, direction)
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
  // The setup entry split bundles app-main into out/main/chunks, so __dirname
  // is no longer the app root. Resolve from getAppPath() like setup/main does,
  // or the window looks for out/main/renderer/index.html and its preload never
  // loads — which leaves window.pi undefined in the renderer.
  const rendererEntryFile = path.join(app.getAppPath(), 'out', 'renderer', 'index.html')
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
    // until the window carries the app mark. Packaged builds set the same
    // image so the button matches the shortcut.
    ...(icon ? { icon } : {}),
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 18, y: 12 } }
      : {
          titleBarOverlay: {
            color: dark ? '#111317' : '#f3f3f3',
            symbolColor: dark ? '#9da4b2' : '#686868',
            // Same as --titlebar-h in tokens.css: the large control step, so
            // the native controls share the app menu strip's height.
            height: 36
          }
        }),
    webPreferences: {
      preload: path.join(app.getAppPath(), 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The inspector's browser tab is a <webview>: an isolated, sandboxed view
      // of the page the reader typed. Its only preload reports mouse back and
      // forward; the page gets no bridge and no node access.
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

  applyTaskbarIcon(window, icon)

  // Windows rounds the frame to physical pixels at fractional display scaling,
  // so a requested content size can come back a pixel or two larger. Re-assert
  // the stored size before the window is shown; otherwise the rounding becomes
  // the next run's input and the window creeps bigger on every launch.
  window.setContentSize(bounds.width, bounds.height)

  let rendererStartupReady = false
  // The HTML loading screen can show the window before the app module loads.
  // Keep a fallback if that early readiness signal never arrives.
  const STARTUP_SHOW_FALLBACK_MS = 1500
  let showFallback: ReturnType<typeof setTimeout> | undefined
  const clearShowFallback = () => {
    if (showFallback === undefined) return
    clearTimeout(showFallback)
    showFallback = undefined
  }
  const startupContents = window.webContents
  const onStartupReady = (event: Electron.IpcMainEvent) => {
    if (event.sender !== startupContents || rendererStartupReady) return
    rendererStartupReady = true
    clearShowFallback()
    if (!window.isDestroyed()) window.show()
    // The native window can defer its first show during initial navigation.
    setImmediate(() => {
      if (!window.isDestroyed() && !window.isVisible()) window.show()
    })
  }
  ipcMain.on('app:startup-ready', onStartupReady)
  window.once('ready-to-show', () => {
    if (rendererStartupReady || window.isDestroyed()) return
    showFallback = setTimeout(() => {
      showFallback = undefined
      if (!window.isDestroyed()) window.show()
    }, STARTUP_SHOW_FALLBACK_MS)
    showFallback.unref?.()
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
    clearShowFallback()
    if (mainWindow === window) {
      mainWindow = null
      void terminalManager?.disposeAll().catch((error: unknown) => {
        console.error('[pi-desktop] terminal cleanup failed:', error)
      })
    }
  })

  // A crashed renderer has lost every terminal session id, so those PTYs no
  // longer have a controllable owner.
  window.webContents.on('render-process-gone', (_event, details) => {
    if (mainWindow === window) {
      void terminalManager?.disposeAll().catch((error: unknown) => {
        console.error('[pi-desktop] terminal cleanup failed:', error)
      })
    }
    if (!app.isPackaged) {
      console.error('[renderer] process gone:', details.reason)
    }
  })

  // Surface renderer problems in the terminal during development.
  if (!app.isPackaged) {
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 'warning') {
        console.error(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`)
      }
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

  const handleWindowLoadError = (error: unknown) => {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : ''
    if (code === 'ERR_ABORTED' || window.isDestroyed()) return
    console.error('[pi-desktop] window load failed:', error)
  }

  if (rendererEntry.developmentUrl) {
    const url = new URL(rendererEntry.developmentUrl)
    url.searchParams.set('piDesktopTheme', theme)
    void window.loadURL(url.toString()).catch(handleWindowLoadError)
  } else {
    void window.loadFile(rendererEntryFile, {
      query: { piDesktopTheme: theme }
    }).catch(handleWindowLoadError)
  }

  attachBrowserHistoryKeys(window)
  return window
}

/**
 * A stray exception can leave the main process in an inconsistent state. Log
 * it to the user data folder and quit through the normal shutdown path rather
 * than continuing with possibly corrupted state or showing a native dialog.
 */
process.on('uncaughtException', (error: NodeJS.ErrnoException) => {
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
  process.exitCode = 1
  app.quit()
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
  process.exitCode = 1
  app.quit()
})

function handleTerminationSignal(): void {
  app.quit()
}

process.on('SIGINT', handleTerminationSignal)
process.on('SIGTERM', handleTerminationSignal)

function revealMainWindow(): void {
  // A second launch that arrives while `start` is still building the window
  // must not create another one: the window already on its way will appear.
  // The same is true while the app is quitting — a new window there would be
  // built only to be closed again. A launch that arrives in that window of time
  // is remembered instead of dropped: a slow first start (Windows scanning a
  // freshly installed build) is exactly when the reader clicks the icon again,
  // and doing nothing there looks like the app refusing to open.
  if (isQuitting()) return
  if (!startupFinished) {
    revealPending = true
    return
  }
  revealNow()
}

function revealNow(): void {
  revealPending = false
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!settings) return
    mainWindow = createWindow()
    applyTray()
  }
  showWindow(mainWindow)
}

function applyTray(): void {
  const current = settings?.get()
  syncTray({
    enabled: current?.trayPersistent === true,
    language: current?.language,
    theme: startupTheme() === 'light' ? 'light' : 'dark',
    show: () => revealMainWindow(),
    openConversation: (key) => {
      // The tray click must open the app on the conversation the reader picked,
      // not on whatever was last on screen. Bring the window up first, then
      // hand the key to the renderer to select (it owns the session list).
      revealMainWindow()
      sendToWindow(mainWindow, 'tray:open-conversation', { key })
    }
  })
}

let ptySpawn: typeof pty.spawn | undefined
const lazyPtySpawn: typeof pty.spawn = (file, args, options) => {
  if (!ptySpawn) {
    const req = createRequire(path.join(app.getAppPath(), 'package.json'))
    ptySpawn = (req('node-pty') as typeof pty).spawn
  }
  return ptySpawn(file, args, options)
}

async function cleanupOrphanedScratchFiles(): Promise<void> {
  try {
    const userData = app.getPath('userData')
    const entries = await readdir(userData, { withFileTypes: true })
    for (const entry of entries) {
      const name = entry.name
      if (isActiveRuntimeScratchEntry(name)) continue
      if (entry.isDirectory() && name.startsWith('pi-desktop-ext-')) {
        await rm(path.join(userData, name), { recursive: true, force: true }).catch(() => {})
        continue
      }
      if (!entry.isFile()) continue
      const isMjsScratch = name.startsWith('pi-desktop-') && name.endsWith('.mjs')
      const isMdScratch = name.startsWith('pi-desktop-instructions-') && name.endsWith('.md')
      if (isMjsScratch || isMdScratch) {
        await unlink(path.join(userData, name)).catch(() => {})
      }
    }
  } catch (error) {
    console.error('[pi-desktop] scratch file cleanup warning:', error)
  }
}

async function start(): Promise<void> {
  void cleanupOrphanedScratchFiles()
  const settingsStore = new SettingsStore()
  settings = settingsStore
  configureExternalSessionRoots(() => {
    const current = settingsStore.get()
    return [current.externalChatFolder ?? '', ...(current.externalChatFolderHistory ?? [])]
  })

  // Development helper: open a folder that was passed in on the command line.
  const forcedWorkspace = process.env.PI_DESKTOP_WORKSPACE
  const initialSettings = settingsStore.get()
  if (forcedWorkspace) {
    const workspaces = initialSettings.workspaces
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
    getCustomPiPath: () => settingsStore.get().piPath,
    getTrustProject: () => settingsStore.get().trustProject === true,
    getSessionRoots: () => resolveSessionRoots(settingsStore.get().externalChatFolder),
    getSessionDir: (cwd: string) => {
      const projectless = path.join(app.getPath('userData'), 'chats')
      if (canonicalPath(cwd) !== canonicalPath(projectless)) return undefined
      return settingsStore.get().externalChatFolder?.trim() || undefined
    },
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
    },
    // Named agent presets: the project directory is only read while the user's
    // project-trust choice is on, the same gate `.pi/mcp.json` passes through.
    getAgentPresets: (cwd: string) =>
      readAgentPresets(cwd, settingsStore.get().trustProject === true)
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
  terminalManager = new TerminalManager(
    (channel, payload) => sendToWindow(mainWindow, channel, payload),
    lazyPtySpawn
  )

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

  imChannelService = new ImChannelService({
    userData: app.getPath('userData'),
    settings: settingsStore,
    supervisor,
    customInstructions: (cwd) => {
      const user = settingsStore.get().customInstructions?.trim()
      const memory = memoryService?.promptFor(cwd).trim() ?? ''
      return [user, memory].filter(Boolean).join('\n\n---\n\n') || undefined
    },
    createAdapter: createChannelAdapter
  })
  // Feishu's long connection and the WeChat listener reach the network; do
  // not let a slow connect gate the window's own startup work.
  void imChannelService.initialize().catch((error: unknown) => {
    console.error('[pi-desktop] im channel initialization failed:', error)
  })

  mainWindow = createWindow()
  applyTray()
  // The child ACL pass is a migration, not a launch step: it touches tens of
  // thousands of cached files, so it waits until the window is up and only runs
  // when this launch actually rewrote the root ACL.
  if (didUserDataAclChange()) scheduleUserDataAclSweep(app.getPath('userData'))

  const context = {
    supervisor,
    settings,
    getWindow: () => mainWindow,
    terminals: terminalManager,
    memory: memoryService,
    remote: remoteAccess,
    remoteReady,
    scheduledTasks: scheduledTaskService,
    imChannels: imChannelService,
    syncTray: () => applyTray()
  }
  registerIpc(context)
  bridgeRuntime(context)

  scheduleCapture({ window: mainWindow, supervisor })
  scheduleWindowClose({ window: mainWindow })

  // Warm the catalog while the window settles: a cold pi.dev page costs
  // seconds on the server, and the desk page asks for exactly this page when
  // it opens. Harness runs stay offline so their captures are deterministic.
  if (!process.env.PI_DESKTOP_SCREENSHOT) {
    const warmup = setTimeout(() => void fetchPiCatalog().catch(() => {}), 5000)
    warmup.unref?.()
  }

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
  startupFinished = true
  // A launch that arrived while this one was still starting asked for the
  // window; it is up now, so honour it instead of leaving it behind other
  // windows.
  if (revealPending) revealNow()
}

if (primaryInstance) {
  // Registered for the life of the process, so turning the tray on later still
  // focuses this window when a second launch asks for the lock.
  app.on('second-instance', () => revealMainWindow())
  void app.whenReady().then(start).catch((error: unknown) => {
    console.error('[pi-desktop] startup failed:', error)
    process.exitCode = 1
    app.quit()
  })
}

app.on('before-quit', () => {
  // Set before any window closes, so the close handler does not hide a quit.
  noteQuitting()
  disposeRemoteAccess()
  memoryService?.dispose()
  autoTitleService?.dispose()
  scheduledTaskService?.stopScheduling()
  void imChannelService?.dispose().catch(() => {})
})

app.on('window-all-closed', () => {
  // The keep-alive flag is a development aid for the window-close test.
  if (!isMac && process.env.PI_DESKTOP_KEEP_ALIVE !== '1') app.quit()
})

let shutdownComplete = false
let shuttingDown = false
app.on('before-quit', (event) => {
  if (shutdownComplete || (!supervisor && !terminalManager)) return
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
    setTimeout(() => process.exit(process.exitCode ?? 0), 1000).unref()
  }, 20_000)
  watchdog.unref()

  void Promise.allSettled([supervisor?.stop(), terminalManager?.disposeAll()]).then(results => {
    for (const result of results) {
      if (result.status === 'rejected') console.error('[pi-desktop] shutdown failed:', result.reason)
    }
  }).finally(() => {
    void cleanupStaticExtensionCache().finally(() => {
      clearTimeout(watchdog)
      shutdownComplete = true
      scheduledTaskService?.dispose()
      app.quit()
    })
  })
})

// Quit only after the shutdown listeners exist. A second launch loses the
// lock before `ready`, and `app.quit()` at that point still emits `before-quit`.
if (!primaryInstance) app.quit()
