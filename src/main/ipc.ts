import { app, BrowserWindow, Notification, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { exec } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, type Dirent } from 'node:fs'
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
  UpgradeResult,
  VersionCheckResult,
  VersionItemStatus,
  Workspace
} from '@shared/types'
import { checkAuth, piVersion } from './pi/cli'
import { resolvePiLaunch } from './pi/locate'
import { PiRuntime } from './pi/runtime'
import { readMcpConfig } from './mcp'
import {
  addWorktree,
  applyPatch,
  commitWorkingTree,
  createBranch,
  readBranches,
  readCommitDetail,
  readCommitFileDiff,
  readCommitWorktreeDiff,
  readFileDiff,
  readLog,
  readPatch,
  readStatus,
  removeWorktree,
  revertFile,
  stageAll,
  stageFile,
  switchBranch,
  unstageAll,
  unstageFile,
  pushBranch,
  pullBranch
} from './git'
import { SettingsStore } from './settings'
import { getAggregatedUsage, listSessions, resolveSessionRoot, searchSessions } from './sessions'
import { querySystemFonts } from './fonts'
import { registerProviderIpc } from './providers/ipc'

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
const TEXT_PREVIEW_MAX = 64
const TEXT_PREVIEW_LEAD = 12
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

function projectlessRoot(): string {
  return path.join(app.getPath('userData'), 'chats')
}

/** Keep the default working directory out of the user's project list. */
function withoutProjectFolder<T extends { cwd: string }>(session: T): T {
  return session.cwd && path.relative(projectlessRoot(), session.cwd) === ''
    ? { ...session, cwd: '' }
    : session
}

/** The working directory Pi is currently running in. */
function workspaceRoot(context: IpcContext): string {
  const cwd = context.runtime.currentStatus.cwd
  if (cwd) return cwd
  const settings = context.settings.get()
  if (settings.activeWorkspaceId === null) return projectlessRoot()
  const active = settings.workspaces.find((w) => w.id === settings.activeWorkspaceId)
  return active?.path ?? settings.workspaces[0]?.path ?? ''
}

/** Keep file access inside the open workspace. */
function isInside(root: string, target: string): boolean {
  if (!root) return false
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** The picture types the inspector's viewer can draw, by file extension. */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif'
}

/**
 * A picture of the open project as a data URL.
 *
 * The renderer may not read the disk, so the bytes come across as a data URL
 * the viewer can paint. Anything that is not an image inside the project, or
 * that is too large to hand to a `<img>`, is `null` rather than an error.
 */
function readImageDataUrl(context: IpcContext, file: string): string | null {
  const root = workspaceRoot(context)
  const target = path.resolve(root, file)
  if (!isInside(root, target)) return null
  const type = IMAGE_MIME[path.extname(target).toLowerCase()]
  if (!type) return null
  try {
    const stats = statSync(target)
    if (!stats.isFile() || stats.size > 24 * 1024 * 1024) return null
    return `data:${type};base64,${readFileSync(target).toString('base64')}`
  } catch {
    return null
  }
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

function isNewerVersion(latest: string, current: string): boolean {
  const l = latest.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const c = current.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const li = l[i] ?? 0
    const ci = c[i] ?? 0
    if (li > ci) return true
    if (li < ci) return false
  }
  return false
}

function fetchLatestPiCliVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    exec(`${npmCmd} view @earendil-works/pi-coding-agent version`, { timeout: 8_000 }, (err, stdout) => {
      if (err) return reject(err)
      const v = stdout.trim()
      if (v) resolve(v)
      else reject(new Error('No version returned by npm'))
    })
  })
}

function runNpmInstall(cwd: string, pkg: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    exec(`${npmCmd} install ${pkg}`, { cwd, timeout: 180_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message))
      } else {
        resolve()
      }
    })
  })
}

/** The theme a development flag forces for this run, if any. */
function forcedTheme(): 'light' | 'dark' | 'system' | undefined {
  const value = process.env.PI_DESKTOP_THEME
  return value === 'light' || value === 'dark' || value === 'system' ? value : undefined
}

export function registerIpc(context: IpcContext): void {
  const { runtime, settings, getWindow } = context
  registerProviderIpc(context)

  ipcMain.handle('app:info', async (): Promise<AppInfo> => {
    const current = settings.get()
    const launch = resolvePiLaunch(current.piPath)
    const version = await piVersion(current.piPath)
    return {
      // `npm_package_version` only exists when npm launched the app; a
      // packaged build reads the version it was built with instead.
      version: process.env.npm_package_version ?? app.getVersion() ?? '0.5.0',
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
      sessionRoot: resolveSessionRoot(settings.get().externalChatFolder),
      forcedTheme: forcedTheme()
    }
  })

  ipcMain.handle('dialog:pickDirectory', async (_event, defaultPath?: string): Promise<string | null> => {
    const window = getWindow()
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: 'Select folder',
          defaultPath: defaultPath || undefined,
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          title: 'Select folder',
          defaultPath: defaultPath || undefined,
          properties: ['openDirectory', 'createDirectory']
        })
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })

  ipcMain.handle('dialog:pickPaths', async (_event, kind: 'files' | 'folders', defaultPath?: string): Promise<string[]> => {
    if (kind !== 'files' && kind !== 'folders') throw new Error('Unknown attachment kind')
    const options: OpenDialogOptions = {
      title: kind === 'files' ? 'Add files' : 'Add folders',
      defaultPath: defaultPath || undefined,
      properties: kind === 'files' ? ['openFile', 'multiSelections'] : ['openDirectory', 'multiSelections']
    }
    const window = getWindow()
    const result = window && !window.isDestroyed()
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('app:setTheme', (_event, theme: 'dark' | 'light') => {
    const window = getWindow()
    if (!window || window.isDestroyed() || process.platform === 'darwin') return
    try {
      // Keep the native window controls in step with the app chrome.
      window.setTitleBarOverlay(
        theme === 'light'
          ? { color: '#f3f3f3', symbolColor: '#686868', height: 44 }
          : { color: '#111317', symbolColor: '#9da4b2', height: 44 }
      )
    } catch {
      /* the platform may not support a title bar overlay */
    }
  })

  ipcMain.handle('app:getSystemFonts', async (): Promise<string[]> => {
    return querySystemFonts()
  })

  ipcMain.handle('app:checkUpdate', async (): Promise<VersionCheckResult> => {
    const currentPiVersion = (await piVersion(settings.get().piPath)) || '1.4.0'
    const currentAppVersion = process.env.npm_package_version ?? app.getVersion() ?? '0.5.0'

    let piCliStatus: VersionItemStatus = {
      current: currentPiVersion,
      hasUpdate: false
    }

    try {
      const latestPi = await fetchLatestPiCliVersion()
      piCliStatus = {
        current: currentPiVersion,
        latest: latestPi,
        hasUpdate: isNewerVersion(latestPi, currentPiVersion)
      }
    } catch (err: unknown) {
      piCliStatus.error = err instanceof Error ? err.message : 'Failed to check Pi CLI updates'
    }

    const appStatus: VersionItemStatus = {
      current: currentAppVersion,
      latest: currentAppVersion,
      hasUpdate: false
    }

    return {
      app: appStatus,
      piCli: piCliStatus
    }
  })

  ipcMain.handle('app:upgradePiCli', async (): Promise<UpgradeResult> => {
    try {
      const cwd = app.getAppPath()
      await runNpmInstall(cwd, '@earendil-works/pi-coding-agent@latest')
      const updatedVersion = await piVersion(settings.get().piPath)
      return { success: true, version: updatedVersion || undefined }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('app:upgradeApp', async (): Promise<UpgradeResult> => {
    try {
      const root = app.getAppPath()
      const res = await pullBranch(root)
      if (!res.ok) {
        return { success: false, error: res.error || 'Failed to pull update' }
      }
      const current = process.env.npm_package_version ?? app.getVersion() ?? '0.5.0'
      return { success: true, version: current }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
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

  ipcMain.handle('sessions:list', (_event, cwd?: string) =>
    listSessions(cwd).map(withoutProjectFolder)
  )

  ipcMain.handle('sessions:search', (_event, query: string, limit?: number) =>
    searchSessions(query, limit).map(withoutProjectFolder)
  )

  ipcMain.handle('sessions:usageStats', (_event, customDir?: string) => {
    const userDir = customDir?.trim() || settings.get().externalChatFolder?.trim()
    return getAggregatedUsage(userDir || undefined)
  })

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

  ipcMain.handle('git:commitDetail', (_event, hash: string) =>
    readCommitDetail(workspaceRoot(context), hash)
  )

  ipcMain.handle('git:commitFileDiff', (_event, hash: string, file: string) =>
    readCommitFileDiff(workspaceRoot(context), hash, file)
  )

  ipcMain.handle('git:commitWorktreeDiff', (_event, hash: string, file: string) =>
    readCommitWorktreeDiff(workspaceRoot(context), hash, file)
  )

  ipcMain.handle('git:applyPatch', (_event, patch: string, reverse?: boolean) =>
    applyPatch(workspaceRoot(context), patch, reverse === true)
  )

  ipcMain.handle('git:branches', () => readBranches(workspaceRoot(context)))

  ipcMain.handle('git:switchBranch', (_event, name: string) =>
    switchBranch(workspaceRoot(context), name)
  )

  ipcMain.handle('git:createBranch', (_event, name: string, checkout?: boolean) =>
    createBranch(workspaceRoot(context), name, checkout !== false)
  )

  ipcMain.handle(
    'git:addWorktree',
    (_event, worktreePath: string, branch: string, create?: boolean) =>
      addWorktree(workspaceRoot(context), worktreePath, branch, create !== false)
  )

  ipcMain.handle('git:removeWorktree', (_event, worktreePath: string) =>
    removeWorktree(workspaceRoot(context), worktreePath)
  )

  ipcMain.handle('git:revertFile', (_event, file: string) =>
    revertFile(workspaceRoot(context), file)
  )

  ipcMain.handle('git:push', () => pushBranch(workspaceRoot(context)))

  ipcMain.handle('git:pull', () => pullBranch(workspaceRoot(context)))

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
    const cwd = options.cwd || projectlessRoot()
    if (!options.cwd) mkdirSync(cwd, { recursive: true })
    return runtime.start({
      ...options,
      cwd,
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

  // Configuration only: this never connects to a server, it reads the two
  // mcp.json files the Pi process would load.
  ipcMain.handle('mcp:read', () =>
    readMcpConfig(workspaceRoot(context), settings.get().trustProject)
  )

  ipcMain.handle('shell:openPath', async (_event, target: string) => {
    const opener = settings.get().defaultFileOpener
    if (opener === 'vscode') {
      try {
        const { spawn } = await import('node:child_process')
        spawn('code', [target], { shell: true, detached: true })
        return ''
      } catch {
        /* fallback to system default */
      }
    } else if (opener === 'cursor') {
      try {
        const { spawn } = await import('node:child_process')
        spawn('cursor', [target], { shell: true, detached: true })
        return ''
      } catch {
        /* fallback to system default */
      }
    } else if (opener === 'windsurf') {
      try {
        const { spawn } = await import('node:child_process')
        spawn('windsurf', [target], { shell: true, detached: true })
        return ''
      } catch {
        /* fallback to system default */
      }
    }
    const error = await shell.openPath(target)
    return error
  })

  ipcMain.handle('shell:openInExplorer', async (_event, target: string) => {
    const error = await shell.openPath(target)
    return error
  })

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    if (!/^https?:\/\//i.test(url)) return
    await shell.openExternal(url)
  })

  // A picture from the project, read as a data URL. The inspector's viewer
  // draws the project's images, and it may not touch the disk itself.
  ipcMain.handle(
    'fs:readImageDataUrl',
    (_event, file: string) => readImageDataUrl(context, file)
  )
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
  const { runtime, settings, getWindow } = context
  runtime.on('event', (event: PiEvent) => {
    const window = getWindow()
    sendToWindow(window, 'runtime:event', event)

    if (
      window &&
      !window.isDestroyed() &&
      !window.isFocused() &&
      settings.get().desktopNotifications !== false &&
      Notification.isSupported()
    ) {
      const cwd = runtime.currentStatus.cwd
      const project = cwd ? workspaceName(cwd) : 'Pi Desktop'
      let body: string | null = null
      if (event.type === 'agent_settled') {
        body = `Pi finished working in ${project}.`
      } else if (
        event.type === 'extension_ui_request' &&
        ['select', 'confirm', 'input', 'editor'].includes(String(event.method ?? ''))
      ) {
        body = String(event.title ?? event.message ?? `Pi needs your input in ${project}.`)
      }
      if (body) {
        try {
          const notification = new Notification({
            title: 'Pi Desktop',
            body,
            silent: false
          })
          notification.on('click', () => {
            if (window.isDestroyed()) return
            if (window.isMinimized()) window.restore()
            window.focus()
          })
          notification.show()
        } catch {
          /* notification subsystem may be unavailable on some setups */
        }
      }
    }
  })
  runtime.on('status', (status: RuntimeStatus) => {
    sendToWindow(getWindow(), 'runtime:status', status)
  })
  runtime.on('stderr', (line: string) => {
    sendToWindow(getWindow(), 'runtime:stderr', line)
  })
}
