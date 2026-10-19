import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import path from 'node:path'
import type {
  AppInfo,
  AppSettings,
  ExtensionUiResponse,
  PiEvent,
  RuntimeStartOptions,
  RuntimeStatus,
  Workspace
} from '@shared/types'
import { checkAuth, piVersion } from './pi/cli'
import { resolvePiLaunch } from './pi/locate'
import { PiRuntime } from './pi/runtime'
import { SettingsStore } from './settings'
import { listSessions, resolveSessionRoot } from './sessions'

export interface IpcContext {
  runtime: PiRuntime
  settings: SettingsStore
  getWindow: () => BrowserWindow | null
}

export interface FileEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  size?: number
}

export interface FileContent {
  path: string
  content: string
  truncated: boolean
  language: string
}

const MAX_FILE_BYTES = 512 * 1024
const MAX_SEARCH_RESULTS = 200
const MAX_SEARCH_DEPTH = 12
/** Directories that are never worth walking when searching a project. */
const SEARCH_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode'
])
/**
 * Directories the file tree does not walk into.
 *
 * They are either huge or of no use to read, and the tree is the one
 * place where a mistake costs a lot: everything else in a project is
 * worth seeing, dot folders included.
 */
const TREE_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.next',
  '.nuxt',
  'target'
])
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'html',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  php: 'php',
  cs: 'csharp',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  sql: 'sql',
  lua: 'lua',
  vue: 'vue',
  svelte: 'svelte',
  xml: 'xml',
  dockerfile: 'dockerfile'
}

/** The working directory Pi is currently running in. */
function workspaceRoot(context: IpcContext): string {
  const cwd = context.runtime.currentStatus.cwd
  if (cwd) return cwd
  const settings = context.settings.get()
  const active = settings.workspaces.find((w) => w.id === settings.activeWorkspaceId)
  return active?.path ?? settings.workspaces[0]?.path ?? ''
}

/** Keep file access inside the open workspace. */
function isInside(root: string, target: string): boolean {
  if (!root) return false
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function workspaceName(dir: string): string {
  const base = path.basename(dir)
  return base || dir
}

/** The theme a development flag forces for this run, if any. */
function forcedTheme(): 'light' | 'dark' | 'system' | undefined {
  const value = process.env.PI_DESKTOP_THEME
  return value === 'light' || value === 'dark' || value === 'system' ? value : undefined
}

export function registerIpc(context: IpcContext): void {
  const { runtime, settings, getWindow } = context

  ipcMain.handle('app:info', async (): Promise<AppInfo> => {
    const current = settings.get()
    const launch = resolvePiLaunch(current.piPath)
    const version = await piVersion(current.piPath)
    return {
      version: process.env.npm_package_version ?? '0.1.0',
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      pi: {
        source: launch.source,
        command: launch.command || undefined,
        args: launch.prefixArgs.length ? launch.prefixArgs : undefined,
        display: launch.display,
        version
      },
      sessionRoot: resolveSessionRoot(),
      forcedTheme: forcedTheme()
    }
  })

  ipcMain.handle('app:setTheme', (_event, theme: 'dark' | 'light') => {
    const window = getWindow()
    if (!window || window.isDestroyed() || process.platform === 'darwin') return
    try {
      // Keep the native window controls in step with the app chrome.
      window.setTitleBarOverlay(
        theme === 'light'
          ? { color: '#f6f7f9', symbolColor: '#5c6573', height: 44 }
          : { color: '#0b0d10', symbolColor: '#8a93a3', height: 44 }
      )
    } catch {
      /* the platform may not support a title bar overlay */
    }
  })

  ipcMain.handle('settings:get', (): AppSettings => settings.get())

  ipcMain.handle('settings:patch', (_event, patch: Partial<AppSettings>): AppSettings => {
    return settings.patch(patch)
  })

  ipcMain.handle('workspaces:pick', async (): Promise<Workspace | null> => {
    const window = getWindow()
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: 'Choose a project folder',
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths.length) return null
    const dir = path.resolve(result.filePaths[0])
    const workspace: Workspace = {
      id: randomUUID(),
      path: dir,
      name: workspaceName(dir),
      lastOpenedAt: Date.now()
    }
    settings.addWorkspace(workspace)
    return workspace
  })

  ipcMain.handle('workspaces:remove', (_event, id: string): AppSettings => {
    return settings.removeWorkspace(id)
  })

  ipcMain.handle('sessions:list', (_event, cwd?: string) => listSessions(cwd))

  ipcMain.handle('sessions:reveal', async (_event, file: string) => {
    shell.showItemInFolder(file)
  })

  ipcMain.handle('fs:list', (_event, dir: string): FileEntry[] => {
    const root = workspaceRoot(context)
    // A relative path is taken from the project root, not from wherever the
    // app happens to be started.
    const target = path.resolve(root, dir)
    if (!isInside(root, target)) return []
    try {
      return readdirSync(target, { withFileTypes: true })
        .filter((entry) => !(entry.isDirectory() && TREE_SKIP_DIRS.has(entry.name)))
        .map((entry) => {
          const full = path.join(target, entry.name)
          let size: number | undefined
          if (entry.isFile()) {
            try {
              size = statSync(full).size
            } catch {
              size = undefined
            }
          }
          return {
            name: entry.name,
            path: full,
            kind: entry.isDirectory() ? ('directory' as const) : ('file' as const),
            size
          }
        })
        .sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
          return a.name.localeCompare(b.name)
        })
    } catch {
      return []
    }
  })

  ipcMain.handle('fs:read', (_event, file: string): FileContent | null => {
    const root = workspaceRoot(context)
    const target = path.resolve(root, file)
    if (!isInside(root, target)) return null
    try {
      const stats = statSync(target)
      if (!stats.isFile()) return null
      const truncated = stats.size > MAX_FILE_BYTES
      const content = truncated
        ? readFileSync(target, { encoding: 'utf8' }).slice(0, MAX_FILE_BYTES)
        : readFileSync(target, 'utf8')
      const ext = path.extname(target).slice(1).toLowerCase()
      return {
        path: target,
        content,
        truncated,
        language: LANGUAGE_BY_EXT[ext] ?? 'text'
      }
    } catch {
      return null
    }
  })

  ipcMain.handle('fs:search', (_event, query: string, limit?: number): FileEntry[] => {
    const root = workspaceRoot(context)
    const needle = query.trim().toLowerCase()
    if (!root || !needle) return []
    const ceiling = Math.min(Math.max(limit ?? MAX_SEARCH_RESULTS, 1), MAX_SEARCH_RESULTS)
    const results: FileEntry[] = []

    const walk = (dir: string, depth: number): void => {
      if (results.length >= ceiling || depth > MAX_SEARCH_DEPTH) return
      let entries: Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (results.length >= ceiling) return
        if (entry.name.startsWith('.')) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (SEARCH_SKIP_DIRS.has(entry.name)) continue
          walk(full, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        if (!entry.name.toLowerCase().includes(needle)) continue
        let size: number | undefined
        try {
          size = statSync(full).size
        } catch {
          size = undefined
        }
        results.push({ name: entry.name, path: full, kind: 'file', size })
      }
    }

    walk(path.resolve(root), 0)
    return results
  })

  ipcMain.handle('sessions:remove', async (_event, file: string): Promise<boolean> => {
    try {
      // Recoverable: hand the file to the OS trash instead of unlinking it.
      await shell.trashItem(file)
      return true
    } catch (error) {
      console.error('[pi-desktop] could not trash the session file:', error)
      return false
    }
  })

  ipcMain.handle('runtime:start', async (_event, options: RuntimeStartOptions) => {
    return runtime.start(options)
  })

  ipcMain.handle('runtime:stop', async () => {
    await runtime.stop()
  })

  ipcMain.handle(
    'runtime:request',
    async (
      _event,
      command: string,
      payload: Record<string, unknown> = {},
      timeoutMs?: number
    ) => {
      return runtime.request(command, payload, timeoutMs)
    }
  )

  ipcMain.handle(
    'runtime:respondUi',
    async (_event, id: string, response: ExtensionUiResponse) => {
      runtime.respondUi(id, response)
    }
  )

  ipcMain.handle('auth:check', async (_event, provider?: string) => {
    return checkAuth(provider, settings.get().piPath)
  })

  ipcMain.handle('shell:openPath', async (_event, target: string) => {
    const error = await shell.openPath(target)
    return error
  })

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    if (!/^https?:\/\//i.test(url)) return
    await shell.openExternal(url)
  })
}

/**
 * Send to the renderer, tolerating a window that is already gone.
 *
 * Pi keeps producing output for a moment after it is asked to stop, and that
 * can land after the window was closed. Calling `webContents.send` on a
 * destroyed window throws "Object has been destroyed" and takes the whole
 * main process down with an error dialog.
 */
function sendToWindow(window: BrowserWindow | null, channel: string, payload: unknown): void {
  if (!window || window.isDestroyed()) return
  const contents = window.webContents
  if (!contents || contents.isDestroyed()) return
  try {
    contents.send(channel, payload)
  } catch (error) {
    console.error(`[pi-desktop] could not deliver "${channel}":`, error)
  }
}

/** Forward runtime traffic to the renderer window. */
export function bridgeRuntime(context: IpcContext): void {
  const { runtime, getWindow } = context
  runtime.on('event', (event: PiEvent) => {
    sendToWindow(getWindow(), 'runtime:event', event)
  })
  runtime.on('status', (status: RuntimeStatus) => {
    sendToWindow(getWindow(), 'runtime:status', status)
  })
  runtime.on('stderr', (line: string) => {
    sendToWindow(getWindow(), 'runtime:stderr', line)
  })
}
