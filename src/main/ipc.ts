import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import path from 'node:path'
import type {
  AppInfo,
  AppSettings,
  ExtensionUiResponse,
  FileContent,
  FileEntry,
  PiEvent,
  RuntimeStartOptions,
  RuntimeStatus,
  TextSearchHit,
  Workspace
} from '@shared/types'
import { checkAuth, piVersion } from './pi/cli'
import { resolvePiLaunch } from './pi/locate'
import { PiRuntime } from './pi/runtime'
import {
  commitWorkingTree,
  readFileDiff,
  readLog,
  readPatch,
  readStatus,
  revertFile,
  stageAll,
  stageFile,
  unstageAll,
  unstageFile
} from './git'
import { SettingsStore } from './settings'
import { listSessions, resolveSessionRoot, searchSessions } from './sessions'

export interface IpcContext {
  runtime: PiRuntime
  settings: SettingsStore
  getWindow: () => BrowserWindow | null
}

const MAX_FILE_BYTES = 512 * 1024
const MAX_SEARCH_RESULTS = 200
const MAX_SEARCH_DEPTH = 12
/** How many matches of one file a text search reports. */
const MAX_TEXT_HITS_PER_FILE = 3
/** Characters of a line shown around a text match. */
const TEXT_PREVIEW_MAX = 160
const TEXT_PREVIEW_LEAD = 40
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
  '.vscode',
  'target'
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

/**
 * Find up to three matches of `needle` in one text file.
 *
 * A session or a lock file can match almost every line, and past a handful of
 * rows per file the list stops being readable — the search moves on instead.
 * A NUL byte means the file is binary, and a preview of its bytes is not
 * something the reader could use, so it is not a result.
 */
function searchFileText(file: string, needle: string, remaining: number): TextSearchHit[] {
  const perFile = Math.min(remaining, MAX_TEXT_HITS_PER_FILE)
  if (perFile <= 0) return []

  let buffer: Buffer
  try {
    const stats = statSync(file)
    // A file past the read cap is skipped rather than half-read: a hit in the
    // part that was never read would be a result the user cannot find.
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_FILE_BYTES) return []
    buffer = readFileSync(file)
  } catch {
    return []
  }
  if (buffer.includes(0)) return []

  const hits: TextSearchHit[] = []
  const lines = buffer.toString('utf8').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (hits.length >= perFile) break
    // Windows line endings keep the \r; leaving it in would end the preview
    // with a stray character.
    const raw = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index]
    const at = raw.toLowerCase().indexOf(needle)
    if (at === -1) continue

    // The preview drops the indentation of the line, so the match offset moves
    // with it. The offsets that go back to the renderer point into the preview.
    const content = raw.trim()
    if (!content) continue
    const offset = at - (raw.length - raw.trimStart().length)
    if (offset < 0 || offset + needle.length > content.length) continue

    const from = offset > TEXT_PREVIEW_LEAD ? offset - TEXT_PREVIEW_LEAD : 0
    let to = Math.min(content.length, from + TEXT_PREVIEW_MAX)
    // A match longer than the window keeps its length; the row then shortens
    // the rest with an ellipsis of its own.
    if (offset + needle.length > to) to = Math.min(content.length, offset + needle.length)
    const prefix = from > 0 ? '…' : ''
    const suffix = to < content.length ? '…' : ''
    const body = content.slice(from, to)

    hits.push({
      path: file,
      line: index + 1,
      column: at + 1,
      preview: `${prefix}${body}${suffix}`,
      matchStart: prefix.length + (offset - from),
      matchLength: needle.length
    })
  }
  return hits
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
          ? { color: '#ffffff', symbolColor: '#5e5e5e', height: 44 }
          : { color: '#181818', symbolColor: '#a7a7a7', height: 44 }
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

  // Register a project that the user picked from a conversation. The path is
  // the only thing the renderer knows, so the id and the display name are
  // decided here where the file system is reachable.
  ipcMain.handle(
    'workspaces:add',
    (_event, rawPath: string): { workspace: Workspace; settings: AppSettings } => {
      const dir = path.resolve(rawPath)
      const current = settings.get()
      const existing = current.workspaces.find(
        (item) => path.resolve(item.path).toLowerCase() === dir.toLowerCase()
      )
      if (existing) return { workspace: existing, settings: current }
      const workspace: Workspace = {
        id: randomUUID(),
        path: dir,
        name: workspaceName(dir),
        lastOpenedAt: Date.now()
      }
      return { workspace, settings: settings.addWorkspace(workspace) }
    }
  )

  ipcMain.handle('sessions:list', (_event, cwd?: string) => listSessions(cwd))

  ipcMain.handle('sessions:search', (_event, query: string, limit?: number) =>
    searchSessions(query, limit)
  )

  // Git is read from the folder Pi runs in: the review panel and the branch
  // chip describe the work tree the agent is actually editing.
  ipcMain.handle('git:status', () => readStatus(workspaceRoot(context)))

  ipcMain.handle('git:log', (_event, limit?: number) => readLog(workspaceRoot(context), limit))

  ipcMain.handle('git:commit', (_event, message: string, includeUnstaged?: boolean) =>
    commitWorkingTree(workspaceRoot(context), message, includeUnstaged === true)
  )

  ipcMain.handle('git:stageFile', (_event, file: string) =>
    stageFile(workspaceRoot(context), file)
  )

  ipcMain.handle('git:unstageFile', (_event, file: string) =>
    unstageFile(workspaceRoot(context), file)
  )

  ipcMain.handle('git:stageAll', () => stageAll(workspaceRoot(context)))

  ipcMain.handle('git:unstageAll', () => unstageAll(workspaceRoot(context)))

  ipcMain.handle('git:fileDiff', (_event, file: string) =>
    readFileDiff(workspaceRoot(context), file)
  )

  ipcMain.handle('git:patch', (_event, file?: string) =>
    readPatch(workspaceRoot(context), file)
  )

  ipcMain.handle('git:revertFile', (_event, file: string) =>
    revertFile(workspaceRoot(context), file)
  )

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
        size: stats.size,
        language: LANGUAGE_BY_EXT[ext] ?? 'text'
      }
    } catch {
      return null
    }
  })

  ipcMain.handle('fs:search', (_event, query: string, limit?: number): FileEntry[] => {
    const root = workspaceRoot(context)
    // The separators are normalised, so "src/renderer" finds the folder on
    // Windows as well.
    const needle = query.trim().toLowerCase().replace(/\\/g, '/')
    // An empty query lists the files of the project, which is what the
    // composer shows when the user types "@" and has not narrowed it down.
    if (!root) return []
    const ceiling = Math.min(Math.max(limit ?? MAX_SEARCH_RESULTS, 1), MAX_SEARCH_RESULTS)
    const results: FileEntry[] = []
    const base = path.resolve(root)

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
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (SEARCH_SKIP_DIRS.has(entry.name)) continue
          walk(full, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        // The path is searched, not only the name, so "renderer" finds the
        // files of the renderer and "readme" finds the README in a folder.
        const relative = path.relative(base, full)
        if (!relative.replace(/\\/g, '/').toLowerCase().includes(needle)) continue
        let size: number | undefined
        try {
          size = statSync(full).size
        } catch {
          size = undefined
        }
        results.push({ name: entry.name, path: full, kind: 'file', size })
      }
    }

    walk(base, 0)
    // The walk follows the disk, which has no order of its own.
    results.sort((a, b) => a.path.localeCompare(b.path))
    return results
  })

  // Search what is inside the files, not only their names. The walk is the
  // same one the file search uses, so both see the same project.
  ipcMain.handle('fs:searchText', (_event, query: string, limit?: number): TextSearchHit[] => {
    const root = workspaceRoot(context)
    const needle = query.trim().toLowerCase()
    if (!root || !needle) return []
    const ceiling = Math.min(Math.max(limit ?? MAX_SEARCH_RESULTS, 1), MAX_SEARCH_RESULTS)
    const base = path.resolve(root)
    const hits: TextSearchHit[] = []

    const walk = (dir: string, depth: number): void => {
      if (hits.length >= ceiling || depth > MAX_SEARCH_DEPTH) return
      let entries: Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (hits.length >= ceiling) return
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (SEARCH_SKIP_DIRS.has(entry.name)) continue
          walk(full, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        const found = searchFileText(full, needle, ceiling - hits.length)
        if (found.length) hits.push(...found)
      }
    }

    walk(base, 0)
    hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    return hits.slice(0, ceiling)
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

  ipcMain.handle('fs:reveal', async (_event, file: string) => {
    shell.showItemInFolder(file)
  })

  // A picture the model produced. It arrives as base64, so it is written
  // from here rather than fetched from somewhere.
  ipcMain.handle(
    'fs:saveImage',
    async (_event, data: string, mimeType: string): Promise<string | null> => {
      const extension = mimeType.includes('png')
        ? 'png'
        : mimeType.includes('webp')
          ? 'webp'
          : mimeType.includes('gif')
            ? 'gif'
            : 'jpg'
      const window = getWindow()
      const result = window
        ? await dialog.showSaveDialog(window, {
            title: 'Save the picture',
            defaultPath: `pi-picture-${Date.now()}.${extension}`,
            filters: [{ name: 'Image', extensions: [extension] }]
          })
        : await dialog.showSaveDialog({
            defaultPath: `pi-picture-${Date.now()}.${extension}`
          })
      if (result.canceled || !result.filePath) return null
      try {
        writeFileSync(result.filePath, Buffer.from(data, 'base64'))
        return result.filePath
      } catch (error) {
        console.error('[pi-desktop] could not save the picture:', error)
        return null
      }
    }
  )

  ipcMain.handle('runtime:start', async (_event, options: RuntimeStartOptions) => {
    return runtime.start({
      ...options,
      customInstructions: settings.get().customInstructions
    })
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
