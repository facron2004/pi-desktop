import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { MAX_COMPOSER_IMAGE_BYTES, MAX_IMAGE_DATA_BYTES, MAX_SEARCH_QUERY_LENGTH } from '@shared/types'
import { randomUUID } from 'node:crypto'
import { constants, mkdirSync, readFileSync, writeFileSync, type Dirent } from 'node:fs'
import { lstat, open, opendir, realpath, stat, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import type {
  AppInfo,
  AppSettings,
  ExtensionUiResponse,
  FileContent,
  FileEntry,
  FileListResult,
  FileSearchResult,
  FileSearchScope,
  GitCommitResult,
  ImageListResult,
  MemoryGenerateOptions,
  MemoryState,
  PickedFile,
  PiEvent,
  PiCliUpgradeProgress,
  RuntimeEnsureOptions,
  RuntimeRekey,
  RuntimeStartOptions,
  RuntimeStatus,
  ScheduledTask,
  ScheduledTaskInput,
  TerminalCreateOptions,
  TextSearchHit,
  TextSearchResult,
  UpgradeResult,
  VersionCheckResult,
  VersionItemStatus,
  Workspace
} from '@shared/types'
import {
  APP_RELEASE_PAGE_URL,
  checkAppVersion,
  isNewerVersion
} from './app-updates'
import { beginBundledPiCliMaintenance, checkAuth, killProcessTree, piVersion } from './pi/cli'
import { resolvePiLaunch } from './pi/locate'
import { spawn } from './pi/spawn'
import { discoverSkillCommands } from './pi/command-catalog'
import { getModelThinkingLevels } from './pi/model-catalog'
import { readTraceHint } from './pi/trace'
import type { SessionSupervisor } from './pi/supervisor'
import { showDesktopNotification } from './desktop-notification'
import { readMcpConfig, removeMcpServer, setMcpServerEnabled } from './mcp'
import {
  createResource,
  installGitRepository,
  installMarketplaceEntry,
  installNpmPackage,
  listInstalledMarketplaceIds,
  listManagedPackages,
  listMarketplace,
  refreshMarketplace,
  removePackage,
  setPackageEnabled
} from './marketplace'
import type { MemoryService } from './memory/service'
import type { RemoteAccessService } from './remote-access'
import { readEmojiFont } from './emoji-font'
import { nativeAppIcons } from './native-icons'
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
import { openWorkspaceFile, resolveWorkspaceLocation, resolveWorkspacePath } from './workspace-files'

export { openWorkspaceFile, resolveWorkspacePath }
import {
  configureSessionSearchIndex,
  forgetSessionSearchIndex,
  getAggregatedUsage,
  getSessionMeta,
  invalidateSessionCache,
  listSessions,
  openSessionFile,
  pathsEqual,
  readSessionMessages,
  resolveSessionRoot,
  resolveSessionRoots,
  resolveSessionFilePath,
  searchSessions
} from './sessions'
import { querySystemFonts } from './fonts'
import { launchEditor } from './editor-launch'
import { registerProviderIpc } from './providers/ipc'
import { TerminalManager } from './terminal'
import type { ScheduledTaskService } from './scheduled-tasks'
import { canonicalSessionFile } from './pi/session-file'

export interface IpcContext {
  supervisor: SessionSupervisor
  settings: SettingsStore
  getWindow: () => BrowserWindow | null
  terminals: TerminalManager
  memory: MemoryService
  remote: RemoteAccessService
  remoteReady: Promise<void>
  scheduledTasks: ScheduledTaskService
  /** Rebuild the tray after a setting that changes it. Optional for tests. */
  syncTray?: () => void
}

/**
 * Instructions and memory share one appended system prompt file. Memory is
 * appended after the user's own instructions so the explicit text stays the
 * first thing the model reads.
 */
function runtimeInstructions(context: IpcContext, cwd: string): string | undefined {
  const user = context.settings.get().customInstructions?.trim()
  const memory = context.memory.promptFor(cwd).trim()
  const combined = [user, memory].filter(Boolean).join('\n\n---\n\n')
  return combined || undefined
}

async function validateRuntimeSessionFile(
  file: unknown,
  cwd: string,
  sessionRoots: readonly string[] = resolveSessionRoots()
): Promise<
  | { ok: true; sessionFile?: string }
  | { ok: false; reason: 'unavailable' | 'metadata' | 'cwd' }
> {
  if (file === undefined) return { ok: true }
  const sessionFile = await resolveSessionFilePath(file, sessionRoots)
  if (!sessionFile) return { ok: false, reason: 'unavailable' }
  const meta = await getSessionMeta(sessionFile, sessionRoots)
  if (!meta?.cwd) return { ok: false, reason: 'metadata' }
  if (!(await runtimeCwdsMatch(meta.cwd, cwd))) {
    return { ok: false, reason: 'cwd' }
  }
  return { ok: true, sessionFile }
}

function runtimeSessionFileError(reason: 'unavailable' | 'metadata' | 'cwd'): string {
  if (reason === 'cwd') return 'Conversation belongs to a different working folder.'
  if (reason === 'metadata') return 'Conversation working folder could not be verified.'
  return "Conversation file is not in Pi's session store."
}

async function runtimeCwdsMatch(a: string, b: string): Promise<boolean> {
  if (pathsEqual(a, b)) return true
  try {
    return pathsEqual(await realpath(a), await realpath(b))
  } catch {
    return false
  }
}

/** Scope a renderer stop request to one registered workspace or projectless root. */
async function resolveRuntimeStopCwd(context: IpcContext, cwd: unknown): Promise<string | null> {
  if (typeof cwd !== 'string') return null
  const requested = cwd.trim() ? cwd : projectlessPath()
  if (requested && !path.isAbsolute(requested)) return null
  const roots = [projectlessPath(), ...(context.settings.get().workspaces ?? []).map(workspace => workspace.path)]
  for (const root of roots) {
    if (root && await runtimeCwdsMatch(requested, root)) return root
  }
  return null
}

export async function removeSessionFile(
  file: unknown,
  supervisor: Pick<SessionSupervisor, 'withSessionFileMutation'>,
  sessionRoots: readonly string[] = resolveSessionRoots()
): Promise<boolean> {
  const original = await openSessionFile(file, sessionRoots)
  if (!original) return false
  try {
    // The pathname is untrusted until the mutation lock is held; compare its
    // current file identity to the handle that passed the first validation.
    return await supervisor.withSessionFileMutation(original.target, async () => {
      const current = await openSessionFile(file, sessionRoots)
      if (!current) return false
      try {
        const [before, after] = await Promise.all([
          original.handle.stat({ bigint: true }),
          current.handle.stat({ bigint: true })
        ])
        if (before.dev !== after.dev || before.ino !== after.ino) return false
        await shell.trashItem(current.target)
        invalidateSessionCache(current.target)
        await forgetSessionSearchIndex(current.target)
        return true
      } finally {
        await current.handle.close().catch(() => {})
      }
    })
  } finally {
    await original.handle.close().catch(() => {})
  }
}

export const MAX_FILE_BYTES = 512 * 1024
const READ_FILE_FLAGS = constants.O_NONBLOCK === undefined
  ? 'r'
  : constants.O_RDONLY | constants.O_NONBLOCK

export async function readBoundedFile(
  target: string,
  maxBytes = MAX_FILE_BYTES
): Promise<{ content: string; truncated: boolean; size: number } | null> {
  let handle: FileHandle | undefined
  try {
    const beforeOpen = await stat(target)
    if (!beforeOpen.isFile()) return null
    handle = await open(target, READ_FILE_FLAGS)
    return await readBoundedHandle(handle, maxBytes)
  } catch {
    return null
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

export async function readBoundedHandle(
  handle: FileHandle,
  maxBytes: number,
  onBytesRead?: (totalRead: number) => void
): Promise<{ content: string; truncated: boolean; size: number } | null> {
  try {
    const stats = await handle.stat({ bigint: true })
    if (!stats.isFile()) return null
    const byteLimit = BigInt(maxBytes)
    const truncated = stats.size > byteLimit
    const bytesToRead = Number(truncated ? byteLimit : stats.size)
    let content = ''
    if (bytesToRead > 0) {
      const buffer = Buffer.alloc(bytesToRead)
      let totalRead = 0
      while (totalRead < bytesToRead) {
        const { bytesRead } = await handle.read(buffer, totalRead, bytesToRead - totalRead, totalRead)
        if (bytesRead === 0) break
        totalRead += bytesRead
        onBytesRead?.(totalRead)
      }
      content = buffer.subarray(0, totalRead).toString('utf8')
    }
    const after = await handle.stat({ bigint: true })
    const changedDuringRead =
      stats.size !== after.size || stats.mtimeNs !== after.mtimeNs || stats.ctimeNs !== after.ctimeNs
    return {
      content,
      truncated: truncated || changedDuringRead,
      size: Number(after.size)
    }
  } catch {
    return null
  }
}
const MAX_SEARCH_RESULTS = 200
const MAX_SEARCH_DEPTH = 12
/** Bound one directory page so a single folder cannot render an unbounded tree. */
const MAX_DIRECTORY_LIST_ENTRIES = 1_000
/** Bound directory iteration even when most names are intentionally hidden. */
const MAX_DIRECTORY_SCAN_ENTRIES = 10_000
/** Bound whole-project name searches when a query has few or no matches. */
const MAX_PROJECT_SEARCH_ENTRIES = 50_000
/** Bound the file count and bytes read by a whole-project text search. */
const MAX_TEXT_SEARCH_SCAN_ENTRIES = 10_000
const MAX_TEXT_SEARCH_SCAN_BYTES = 64 * 1024 * 1024
/** How many matches of one file a text search reports. */
const MAX_TEXT_HITS_PER_FILE = 3
/** Characters of a line shown around a text match. */
const TEXT_PREVIEW_MAX = 64
const TEXT_PREVIEW_LEAD = 12
/** The newest full-text search per window; a later query supersedes it. */
let sessionSearchSequence = 0
const latestSessionSearches = new WeakMap<object, number>()
/** The newest project path search per window and UI surface; a later query supersedes it. */
let fileSearchSequence = 0
const latestFileSearches = new WeakMap<object, Map<FileSearchScope | 'default', number>>()
/** The newest project text search per window; a later query supersedes it. */
let textSearchSequence = 0
const latestTextSearches = new WeakMap<object, number>()
/** The newest image-list walk per window; a workspace change supersedes it. */
let imageListSequence = 0
const latestImageLists = new WeakMap<object, number>()
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

function projectlessPath(): string {
  return path.join(app.getPath('userData'), 'chats')
}

function projectlessRoot(): string {
  const dir = projectlessPath()
  // This folder is also handed to child processes as their cwd (Pi CLI
  // installs, one-shot titles). Windows spawn fails with ENOENT when the cwd
  // does not exist, so it has to be there before anything runs inside it.
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Keep the default working directory out of the user's project list. */
function withoutProjectFolder<T extends { cwd: string }>(session: T): T {
  return session.cwd && path.relative(projectlessPath(), session.cwd) === ''
    ? { ...session, cwd: '' }
    : session
}

/**
 * The workspace the user is looking at.
 * A background conversation keeps its own cwd inside its process; git and
 * files follow the view, not whichever agent happens to be running.
 */
function workspaceRoot(context: IpcContext): string {
  const settings = context.settings.get()
  if (settings.activeWorkspaceId === null) return projectlessRoot()
  const active = settings.workspaces.find((w) => w.id === settings.activeWorkspaceId)
  return active?.path ?? settings.workspaces[0]?.path ?? ''
}

async function gitWrite<T extends GitCommitResult>(
  context: IpcContext,
  action: (root: string) => Promise<T>
): Promise<T | GitCommitResult> {
  const root = workspaceRoot(context)
  try {
    return await context.supervisor.withCwdLock(root, () => action(root))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function isPathWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

type RuntimeCwdRegistration =
  | { kind: 'projectless'; path: string }
  | { kind: 'workspace'; id: string; path: string }

interface ResolvedRuntimeCwd {
  cwd: string
  registration: RuntimeCwdRegistration
}

function runtimeCwdStillRegistered(context: IpcContext, resolved: ResolvedRuntimeCwd): boolean {
  const registration = resolved.registration
  if (registration.kind === 'projectless') {
    return workspacePathKey(projectlessPath()) === workspacePathKey(registration.path)
  }
  return context.settings.get().workspaces.some(workspace =>
    workspace.id === registration.id &&
    workspacePathKey(workspace.path) === workspacePathKey(registration.path)
  )
}

async function resolveRuntimeCwd(context: IpcContext, cwd: unknown): Promise<ResolvedRuntimeCwd | null> {
  if (cwd !== undefined && cwd !== null && typeof cwd !== 'string') return null
  const requested = typeof cwd === 'string' ? cwd : ''
  if (requested && !path.isAbsolute(requested)) return null
  const target = requested || projectlessRoot()
  const projectless = projectlessPath()
  const roots: { path: string; registration: RuntimeCwdRegistration }[] = [
    { path: projectless, registration: { kind: 'projectless', path: projectless } },
    ...(context.settings.get().workspaces ?? []).map(workspace => ({
      path: workspace.path,
      registration: { kind: 'workspace' as const, id: workspace.id, path: workspace.path }
    }))
  ]

  for (const root of roots) {
    if (!root.path) continue
    const location = await resolveWorkspaceLocation(root.path, target)
    if (!location || location.root !== location.target) continue
    try {
      if ((await stat(location.target)).isDirectory()) {
        return { cwd: location.target, registration: root.registration }
      }
    } catch {
      // A workspace can disappear after it was listed in settings.
    }
  }
  return null
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
const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_DATA_BYTES / 3) * 4

/** Decode only a bounded image payload; the string may be a data URL or raw base64. */
function decodeImageData(data: unknown): Buffer | null {
  if (typeof data !== 'string' || data.length > MAX_IMAGE_BASE64_CHARS + 256) return null
  const comma = data.indexOf(',')
  const base64 = comma === -1 ? data : data.slice(comma + 1)
  if (!base64 || base64.length > MAX_IMAGE_BASE64_CHARS) return null
  const bytes = Buffer.from(base64, 'base64')
  return bytes.length > 0 && bytes.length <= MAX_IMAGE_DATA_BYTES ? bytes : null
}

/** Read a bounded image through one file handle so growth after stat cannot exceed the limit. */
async function readImageBytes(target: string, maxBytes: number): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(target, READ_FILE_FLAGS)
    return await readImageBytesFromHandle(handle, maxBytes)
  } catch {
    return null
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

async function readImageBytesFromHandle(handle: FileHandle, maxBytes: number): Promise<Buffer | null> {
  try {
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size > maxBytes) return null
    const buffer = Buffer.alloc(stats.size)
    let totalRead = 0
    while (totalRead < buffer.length) {
      const { bytesRead } = await handle.read(buffer, totalRead, buffer.length - totalRead, totalRead)
      if (bytesRead === 0) return null
      totalRead += bytesRead
    }
    return buffer
  } catch {
    return null
  }
}

/**
 * The picture types a pasted file may be written as, by file extension.
 *
 * Anything else is refused: a file the viewer cannot draw and Pi cannot read
 * back as a picture would only get in the way of the message.
 */
const PASTED_IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

/** The extension for a clipboard mime type, or `null` when it is not one. */
function pastedImageExtension(mimeType: string): string | null {
  const key = (mimeType || '').split(';')[0].trim().toLowerCase()
  return PASTED_IMAGE_EXT[key] ?? null
}

/**
 * A picture of the open project as a data URL.
 *
 * The renderer may not read the disk, so the bytes come across as a data URL
 * the viewer can paint. Anything that is not an image inside the project, or
 * that is too large to hand to a `<img>`, is `null` rather than an error.
 */
export async function readImageDataUrl(
  context: IpcContext,
  file: string,
  maxBytes = MAX_IMAGE_DATA_BYTES
): Promise<string | null> {
  const root = workspaceRoot(context)
  const opened = await openWorkspaceFile(root, file)
  if (!opened) return null
  try {
    const type = IMAGE_MIME[path.extname(opened.target).toLowerCase()]
    if (!type) return null
    const requestedLimit = Number.isFinite(maxBytes)
      ? Math.max(0, Math.floor(maxBytes))
      : MAX_IMAGE_DATA_BYTES
    const byteLimit = Math.min(requestedLimit, MAX_IMAGE_DATA_BYTES)
    const bytes = await readImageBytesFromHandle(opened.handle, byteLimit)
    return bytes ? `data:${type};base64,${bytes.toString('base64')}` : null
  } finally {
    await opened.handle.close().catch(() => {})
  }
}

function workspaceName(dir: string): string {
  const base = path.basename(dir)
  return base || dir
}

function workspacePathKey(value: string): string {
  const resolved = path.resolve(value).replace(/[/\\]+$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Enough pictures for the viewer's paging, without walking a huge media tree. */
const MAX_IMAGE_RESULTS = 1000
/** Bound image listing even when the project contains few or no pictures. */
const MAX_IMAGE_SCAN_ENTRIES = 100_000
/** The picture types the viewer can list, taken from the types it can draw. */
const IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_MIME).map((extension) => extension.slice(1)))

/**
 * Every picture of one project, in a single walk.
 *
 * The image page used to ask `fs:search` once per extension, which walked the
 * whole project nine times for the same answer. The skip list and the depth
 * cap are the ones the file search uses, so both see the same project.
 */
export async function listProjectImages(
  root: string,
  limit = MAX_IMAGE_RESULTS,
  shouldStop: () => boolean = () => false
): Promise<ImageListResult> {
  if (!root) return { entries: [], truncated: false }
  const base = path.resolve(root)
  const results: FileEntry[] = []
  let scannedEntries = 0
  let truncated = false

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (shouldStop()) return
    if (results.length >= limit || scannedEntries >= MAX_IMAGE_SCAN_ENTRIES || depth > MAX_SEARCH_DEPTH) {
      truncated = true
      return
    }
    let directory
    try {
      directory = await opendir(dir)
    } catch {
      truncated = true
      return
    }
    try {
      for await (const entry of directory) {
        if (shouldStop()) return
        if (results.length >= limit || scannedEntries >= MAX_IMAGE_SCAN_ENTRIES) {
          truncated = true
          return
        }
        scannedEntries += 1
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (SEARCH_SKIP_DIRS.has(entry.name)) continue
          if (depth >= MAX_SEARCH_DEPTH) {
            truncated = true
            continue
          }
          await walk(full, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        const extension = path.extname(entry.name).slice(1).toLowerCase()
        if (!IMAGE_EXTENSIONS.has(extension)) continue
        let size: number | undefined
        try {
          const info = await lstat(full)
          if (info.isFile()) size = info.size
        } catch {
          size = undefined
        }
        if (shouldStop()) return
        results.push({ name: entry.name, path: full, kind: 'file', size })
        if (results.length >= limit) truncated = true
      }
    } catch {
      truncated = true
    }
  }

  await walk(base, 0)
  results.sort((a, b) => a.path.localeCompare(b.path))
  return { entries: results, truncated }
}

/**
 * Find up to three matches of `needle` in one text file.
 *
 * A session or a lock file can match almost every line, and past a handful of
 * rows per file the list stops being readable — the search moves on instead.
 * A NUL byte means the file is binary, and a preview of its bytes is not
 * something the reader could use, so it is not a result.
 */
async function searchFileText(
  root: string,
  file: string,
  needle: string,
  remainingHits: number,
  remainingBytes: number
): Promise<{ hits: TextSearchHit[]; bytesRead: number; budgetExceeded: boolean; incomplete: boolean }> {
  const perFile = Math.min(remainingHits, MAX_TEXT_HITS_PER_FILE)
  if (perFile <= 0 || remainingBytes <= 0) {
    return { hits: [], bytesRead: 0, budgetExceeded: remainingBytes <= 0, incomplete: false }
  }

  const opened = await openWorkspaceFile(root, file)
  if (!opened) return { hits: [], bytesRead: 0, budgetExceeded: false, incomplete: true }
  let content: string
  let bytesRead = 0
  try {
    const stats = await opened.handle.stat()
    if (!stats.isFile() || stats.size === 0) {
      return { hits: [], bytesRead: 0, budgetExceeded: false, incomplete: false }
    }
    if (stats.size > MAX_FILE_BYTES) {
      return { hits: [], bytesRead: 0, budgetExceeded: false, incomplete: true }
    }
    if (stats.size > remainingBytes) {
      return { hits: [], bytesRead: 0, budgetExceeded: true, incomplete: false }
    }
    const result = await readBoundedHandle(
      opened.handle,
      Math.min(MAX_FILE_BYTES, remainingBytes),
      (totalRead) => {
        bytesRead = totalRead
      }
    )
    // A file past the read cap is skipped rather than half-read: a hit in the
    // part that was never read would be a result the user cannot find.
    if (result?.size && result.size > remainingBytes) {
      return { hits: [], bytesRead, budgetExceeded: true, incomplete: false }
    }
    if (!result) {
      return { hits: [], bytesRead, budgetExceeded: false, incomplete: true }
    }
    if (result.size === 0) {
      return { hits: [], bytesRead, budgetExceeded: false, incomplete: false }
    }
    if (result.truncated) {
      // The file may have changed during the read. Charge the actual bytes
      // consumed before scanning on or reporting the incomplete result.
      return { hits: [], bytesRead, budgetExceeded: false, incomplete: true }
    }
    content = result.content
  } catch {
    return { hits: [], bytesRead: 0, budgetExceeded: false, incomplete: true }
  } finally {
    await opened.handle.close().catch(() => {})
  }
  if (content.includes('\0')) return { hits: [], bytesRead, budgetExceeded: false, incomplete: false }

  const hits: TextSearchHit[] = []
  let lineStart = 0
  let lineNumber = 1
  while (lineStart <= content.length) {
    if (hits.length >= perFile) break
    const newline = content.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? content.length : newline
    // Windows line endings keep the \r; leaving it in would end the preview
    // with a stray character.
    const line = content.slice(lineStart, lineEnd)
    const raw = line.endsWith('\r') ? line.slice(0, -1) : line
    const at = raw.toLowerCase().indexOf(needle)
    if (at !== -1) {
      // The preview drops the indentation of the line, so the match offset moves
      // with it. The offsets that go back to the renderer point into the preview.
      const trimmed = raw.trim()
      if (trimmed) {
        const offset = at - (raw.length - raw.trimStart().length)
        if (offset >= 0 && offset + needle.length <= trimmed.length) {
          const from = offset > TEXT_PREVIEW_LEAD ? offset - TEXT_PREVIEW_LEAD : 0
          let to = Math.min(trimmed.length, from + TEXT_PREVIEW_MAX)
          // A match longer than the window keeps its length; the row then shortens
          // the rest with an ellipsis of its own.
          if (offset + needle.length > to) to = Math.min(trimmed.length, offset + needle.length)
          const prefix = from > 0 ? '…' : ''
          const suffix = to < trimmed.length ? '…' : ''
          const body = trimmed.slice(from, to)

          hits.push({
            path: file,
            line: lineNumber,
            column: at + 1,
            preview: `${prefix}${body}${suffix}`,
            matchStart: prefix.length + (offset - from),
            matchLength: needle.length
          })
        }
      }
    }
    if (newline === -1) break
    lineStart = newline + 1
    lineNumber += 1
  }
  return { hits, bytesRead, budgetExceeded: false, incomplete: false }
}

const PI_CLI_PACKAGE_NAME = '@earendil-works/pi-coding-agent'

function piCliPackageSpec(cwd: string): string {
  const manifest = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const range = manifest.dependencies?.[PI_CLI_PACKAGE_NAME] ?? manifest.devDependencies?.[PI_CLI_PACKAGE_NAME]
  if (!range) throw new Error(`No ${PI_CLI_PACKAGE_NAME} dependency range in package.json`)
  return `${PI_CLI_PACKAGE_NAME}@${range}`
}

function fetchLatestPiCliVersion(packageSpec: string): Promise<string> {
  return runNpmCommand(
    ['view', packageSpec, 'version', '--json'],
    process.cwd(),
    8_000
  ).then(({ stdout }) => {
    let reported: unknown
    try {
      reported = JSON.parse(stdout.trim())
    } catch {
      throw new Error('npm returned an invalid Pi CLI version')
    }
    const versions = (Array.isArray(reported) ? reported : [reported])
      .filter((value): value is string => typeof value === 'string')
    const version = versions.at(-1)
    if (!version) throw new Error('No version returned by npm')
    return version
  })
}

interface NpmCommandOutput {
  stdout: string
  stderr: string
}

const NPM_ERROR_TAIL_CHARS = 4_000

function appendTail(current: string, chunk: Buffer | string): string {
  const next = current + String(chunk)
  return next.length > NPM_ERROR_TAIL_CHARS ? next.slice(-NPM_ERROR_TAIL_CHARS) : next
}

/** Run npm without a shell and kill its full process tree on timeout. */
function runNpmCommand(
  args: string[],
  cwd: string,
  timeoutMs: number,
  onOutput?: (chunk: string) => void
): Promise<NpmCommandOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, {
      cwd,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let timeout: NodeJS.Timeout | undefined

    const finish = (error?: Error, result?: NpmCommandOutput): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (error) reject(error)
      else resolve(result ?? { stdout, stderr })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendTail(stdout, chunk)
      onOutput?.(String(chunk))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendTail(stderr, chunk)
      onOutput?.(String(chunk))
    })
    child.once('error', (error) => {
      if (!timedOut) finish(error)
    })
    child.once('close', (code, signal) => {
      if (timedOut) return
      if (code === 0) {
        finish(undefined, { stdout, stderr })
        return
      }
      const detail = stderr.trim() || stdout.trim()
      finish(new Error(detail || `npm ${args[0]} exited with ${code ?? signal ?? 'no status'}`))
    })

    timeout = setTimeout(() => {
      if (settled) return
      timedOut = true
      killProcessTree(child, () => {
        const detail = stderr.trim() || stdout.trim()
        const message = `npm ${args[0]} timed out after ${timeoutMs}ms`
        finish(new Error(detail ? `${message}\n${detail}` : message))
      })
    }, timeoutMs)
  })
}

/**
 * Install a Pi CLI package through npm.
 *
 * npm does not print a determinate download bar when it has no TTY, so the
 * progress below follows the work it reports (`npm http` fetches) and fills
 * the remaining time with a bounded timer. It never reports completion before
 * npm exits, so the UI cannot show 100% for a failed install.
 */
async function runNpmInstall(
  cwd: string,
  pkg: string,
  onProgress?: (progress: PiCliUpgradeProgress) => void
): Promise<void> {
  let percent = 3
  let downloads = 0
  const report = (stage: PiCliUpgradeProgress['stage'], next: number): void => {
    percent = Math.max(percent, Math.min(99, Math.round(next)))
    onProgress?.({ stage, percent })
  }
  report('preparing', percent)

  const onOutput = (chunk: string): void => {
    // A single chunk can contain many npm http lines; count them rather
    // than waiting for the buffered exec callback at the end.
    const fetches = chunk.match(/npm http (?:fetch|cache)/g)?.length ?? 0
    if (fetches > 0) {
      downloads += fetches
      report('downloading', 10 + Math.min(70, downloads * 2))
    }
  }

  // npm can spend a long time in reify without another http line. One
  // percent per second keeps the bar alive while staying below completion.
  const timer = setInterval(() => {
    if (percent >= 95) return
    report(percent < 20 ? 'preparing' : 'downloading', percent + 1)
  }, 1_000)

  try {
    await runNpmCommand(
      ['install', '--no-save', '--package-lock=true', '--loglevel=http', pkg],
      cwd,
      180_000,
      onOutput
    )
    onProgress?.({ stage: 'installing', percent: 100 })
  } finally {
    clearInterval(timer)
  }
}

/** The theme a development flag forces for this run, if any. */
function forcedTheme(): 'light' | 'dark' | 'system' | undefined {
  const value = process.env.PI_DESKTOP_THEME
  return value === 'light' || value === 'dark' || value === 'system' ? value : undefined
}

export function registerIpc(context: IpcContext): void {
  const { supervisor, settings, getWindow, terminals } = context
  const workspaceMutations = new Map<string, Promise<unknown>>()
  let piCliUpgradeInFlight: Promise<UpgradeResult> | null = null
  const serializeWorkspaceMutation = <T>(targetPath: string, operation: () => T | Promise<T>): Promise<T> => {
    const key = workspacePathKey(targetPath)
    const previous = workspaceMutations.get(key) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    const settled = result.then(() => undefined, () => undefined)
    workspaceMutations.set(key, settled)
    void settled.then(() => {
      if (workspaceMutations.get(key) === settled) workspaceMutations.delete(key)
    })
    return result
  }
  // Large sessions are searched through an index kept beside the app's data,
  // never inside the user's project folder.
  configureSessionSearchIndex(path.join(app.getPath('userData'), 'session-search-index'))
  registerProviderIpc(context)
  ipcMain.handle('model-catalog:thinking-levels', (_event, provider: unknown, modelId: unknown) =>
    getModelThinkingLevels(typeof provider === 'string' ? provider : '', typeof modelId === 'string' ? modelId : '')
  )

  // A terminal is a real PTY, not a conversation: its output goes straight to
  // the drawer and never into Pi's message stream.
  ipcMain.handle('terminal:create', (_event, options: TerminalCreateOptions) => {
    const root = workspaceRoot(context)
    return terminals.create({
      ...options,
      cwd: options?.cwd?.trim() || root,
      shell: options?.shell || settings.get().terminalShell
    })
  })
  ipcMain.handle('terminal:write', (_event, id: string, data: string) => terminals.write(id, data))
  ipcMain.handle('terminal:resize', (_event, id: string, cols: number, rows: number) =>
    terminals.resize(id, cols, rows)
  )
  ipcMain.handle('terminal:kill', (_event, id: string) => terminals.kill(id))
  ipcMain.on('terminal:ack', (_event, id: unknown, sequence: unknown) => {
    if (typeof id !== 'string' || typeof sequence !== 'number' || !Number.isSafeInteger(sequence)) return
    terminals.acknowledgeOutput(id, sequence)
  })

  ipcMain.handle('app:info', async (_event, options?: { includePiVersion?: boolean }): Promise<AppInfo> => {
    const current = settings.get()
    const launch = resolvePiLaunch(current.piPath)
    const version = options?.includePiVersion === false ? undefined : await piVersion(current.piPath)
    return {
      // `npm_package_version` only exists when npm launched the app; a
      // packaged build reads the version it was built with instead.
      version: process.env.npm_package_version ?? app.getVersion() ?? '0.8.0',
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      isPackaged: app.isPackaged,
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

  ipcMain.handle('app:emojiFont', (): Uint8Array | null => readEmojiFont())

  ipcMain.handle('dialog:pickDirectory', async (_event, defaultPath?: string): Promise<string | null> => {
    try {
      const window = getWindow()
      const result = window && !window.isDestroyed()
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
    } catch {
      return null
    }
  })

  // One dialog for every file the composer can take. Windows cannot select
  // files and folders together, so folders stay on the @ picker. Pictures are
  // read here because the user just chose them, including files outside the
  // workspace; anything else is handed back as a path.
  ipcMain.handle('dialog:pickFiles', async (
    _event,
    defaultPath?: string,
    requestedImageBudgetBytes?: number
  ): Promise<PickedFile[]> => {
    const options = {
      title: 'Add files',
      defaultPath: defaultPath || undefined,
      properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[]
    }
    let result: Electron.OpenDialogReturnValue
    try {
      const window = getWindow()
      result = window && !window.isDestroyed()
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
    } catch {
      return []
    }
    if (result.canceled) return []
    const picked: PickedFile[] = []
    const imageBudgetBytes = Number.isFinite(requestedImageBudgetBytes)
      ? Math.min(Math.max(Math.floor(requestedImageBudgetBytes as number), 0), MAX_COMPOSER_IMAGE_BYTES)
      : MAX_COMPOSER_IMAGE_BYTES
    let inlineImageBytes = 0
    for (const file of result.filePaths) {
      const mimeType = IMAGE_MIME[path.extname(file).toLowerCase()]
      if (!mimeType) {
        picked.push({ kind: 'path', path: file })
        continue
      }
      try {
        const remainingImageBytes = imageBudgetBytes - inlineImageBytes
        const bytes = remainingImageBytes > 0
          ? await readImageBytes(file, Math.min(MAX_IMAGE_DATA_BYTES, remainingImageBytes))
          : null
        if (!bytes) picked.push({ kind: 'path', path: file })
        else {
          inlineImageBytes += bytes.length
          picked.push({ kind: 'image', data: bytes.toString('base64'), mimeType, path: file })
        }
      } catch {
        picked.push({ kind: 'path', path: file })
      }
    }
    return picked
  })

  ipcMain.handle(
    'app:setTheme',
    (_event, theme: 'dark' | 'light', colors?: { color: string; symbolColor: string }) => {
      const window = getWindow()
      if (!window || window.isDestroyed() || process.platform === 'darwin') return
      // Fall back to the theme default when the renderer could not resolve a
      // concrete colour (first paint, or a platform without a title bar overlay).
      const fallback = theme === 'light'
        ? { color: '#f3f3f3', symbolColor: '#686868' }
        : { color: '#111317', symbolColor: '#9da4b2' }
      const hex = (value?: string) => (value && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim()) ? value.trim() : undefined)
      try {
        // Keep the native window controls in step with the app chrome.
        window.setTitleBarOverlay({
          color: hex(colors?.color) ?? fallback.color,
          symbolColor: hex(colors?.symbolColor) ?? fallback.symbolColor,
          height: 44
        })
        if (process.env.PI_DESKTOP_SCREENSHOT) {
          // The overlay is drawn outside the web content, so a screenshot cannot
          // show it — this is the only way to see what the strip was told to use.
          console.log(
            `[pi-desktop] title bar overlay ${theme} ${hex(colors?.color) ?? fallback.color}/${
              hex(colors?.symbolColor) ?? fallback.symbolColor
            }`
          )
        }
      } catch {
        /* the platform may not support a title bar overlay */
      }
    }
  )

  ipcMain.handle('app:getSystemFonts', async (): Promise<string[]> => {
    return querySystemFonts()
  })

  ipcMain.handle('app:checkUpdate', async (): Promise<VersionCheckResult> => {
    const piPath = settings.get().piPath
    const currentPiVersion = (await piVersion(piPath)) || '1.4.0'
    const currentAppVersion = app.getVersion()
    const canUpdateBundledPi = !app.isPackaged && resolvePiLaunch(piPath).source === 'bundled'

    let piCliStatus: VersionItemStatus = {
      current: currentPiVersion,
      hasUpdate: false
    }

    if (canUpdateBundledPi) {
      try {
        const latestPi = await fetchLatestPiCliVersion(piCliPackageSpec(app.getAppPath()))
        piCliStatus = {
          current: currentPiVersion,
          latest: latestPi,
          hasUpdate: isNewerVersion(latestPi, currentPiVersion)
        }
      } catch (err: unknown) {
        piCliStatus.error = err instanceof Error ? err.message : 'Failed to check Pi CLI updates'
      }
    }

    const appStatus = await checkAppVersion(currentAppVersion)

    return {
      app: appStatus,
      piCli: piCliStatus
    }
  })

  ipcMain.handle('app:upgradePiCli', async (event): Promise<UpgradeResult> => {
    if (piCliUpgradeInFlight) return piCliUpgradeInFlight
    const operation = (async (): Promise<UpgradeResult> => {
      try {
        const piPath = settings.get().piPath
        if (resolvePiLaunch(piPath).source !== 'bundled') {
          return { success: false, error: 'The selected Pi CLI is managed outside this app.' }
        }
        if (app.isPackaged) {
          return { success: false, error: 'The bundled Pi CLI is updated with Pi Desktop releases.' }
        }
        const cwd = app.getAppPath()
        const packageSpec = piCliPackageSpec(cwd)
        const latestPiCliVersion = await fetchLatestPiCliVersion(packageSpec)
        const finishCliMaintenance = await beginBundledPiCliMaintenance()
        let supervisorPrepared = false
        try {
          const ready = await supervisor.prepareForCliUpgrade()
          if (!ready) {
            return { success: false, error: 'Finish or stop active Pi work before upgrading the CLI.' }
          }
          supervisorPrepared = true
          const sendProgress = (progress: PiCliUpgradeProgress): void => {
            sendToWindow(BrowserWindow.fromWebContents(event.sender), 'app:piCliUpgradeProgress', progress)
          }
          await runNpmInstall(cwd, `${PI_CLI_PACKAGE_NAME}@${latestPiCliVersion}`, sendProgress)
          const updatedVersion = await piVersion(piPath, { allowDuringMaintenance: true })
          return { success: true, version: updatedVersion || undefined }
        } finally {
          if (supervisorPrepared) supervisor.finishCliUpgrade()
          finishCliMaintenance()
        }
      } catch (err: unknown) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    })()
    piCliUpgradeInFlight = operation
    try {
      return await operation
    } finally {
      if (piCliUpgradeInFlight === operation) piCliUpgradeInFlight = null
    }
  })

  ipcMain.handle('app:openReleasePage', async (): Promise<UpgradeResult> => {
    try {
      await shell.openExternal(APP_RELEASE_PAGE_URL)
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('settings:get', (): AppSettings => settings.get())

  ipcMain.handle('settings:patch', (_event, patch: Partial<AppSettings>): AppSettings => {
    const next = settings.patch(patch)
    if (patch.memoryGeneration === false) context.memory.cancelAutomaticGeneration()
    // The extension reads the switch when its process starts. A conversation
    // that is already running has to be told, or the toggle would wait for
    // the next launch.
    if ('computerUse' in patch) {
      const message = `/desktop-computer ${patch.computerUse ? 'on' : 'off'}`
      for (const key of supervisor.runningKeys()) {
        void supervisor.request(key, 'prompt', { message }, 15_000, { sourceAction: 'computer-use' }).catch(() => {
          /* a process that is exiting can miss the command; the next start reads settings */
        })
      }
    }
    if ('trayPersistent' in patch || 'language' in patch) context.syncTray?.()
    return next
  })

  ipcMain.handle('remote:status', async () => {
    await context.remoteReady
    return context.remote.status()
  })
  ipcMain.handle('remote:setEnabled', async (_event, enabled: boolean) => {
    await context.remoteReady
    return context.remote.setEnabled(enabled === true)
  })
  ipcMain.handle('remote:newPairing', async () => {
    await context.remoteReady
    return context.remote.newPairing()
  })
  ipcMain.handle('remote:revokeDevice', async (_event, id: string) => {
    await context.remoteReady
    return context.remote.revokeDevice(typeof id === 'string' ? id : '')
  })

  ipcMain.handle('memory:get', (): Promise<MemoryState> => context.memory.state())
  ipcMain.handle('memory:remove', (_event, id: string): Promise<MemoryState> => context.memory.remove(id))
  ipcMain.handle('memory:clear', (): Promise<MemoryState> => context.memory.clear())
  ipcMain.handle(
    'memory:generate',
    (_event, options?: MemoryGenerateOptions) => context.memory.generate(options ?? {})
  )
  ipcMain.handle('memory:openFolder', async (): Promise<void> => {
    const error = await shell.openPath(context.memory.root)
    if (error) throw new Error(error)
  })

  ipcMain.handle('scheduled-tasks:list', (): ScheduledTask[] => context.scheduledTasks.list())
  ipcMain.handle('scheduled-tasks:create', (_event, input: ScheduledTaskInput) =>
    context.scheduledTasks.create(input)
  )
  ipcMain.handle('scheduled-tasks:update', (_event, id: string, input: ScheduledTaskInput) =>
    context.scheduledTasks.update(id, input)
  )
  ipcMain.handle('scheduled-tasks:setEnabled', (_event, id: string, enabled: boolean) =>
    context.scheduledTasks.setEnabled(id, enabled === true)
  )
  ipcMain.handle('scheduled-tasks:remove', (_event, id: string) => context.scheduledTasks.remove(id))
  ipcMain.handle('scheduled-tasks:runNow', (_event, id: string) => context.scheduledTasks.runNow(id))

  ipcMain.handle('workspaces:pick', async (): Promise<Workspace | null> => {
    try {
      const window = getWindow()
      const result = window && !window.isDestroyed()
        ? await dialog.showOpenDialog(window, {
            title: 'Choose a project folder',
            properties: ['openDirectory', 'createDirectory']
          })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] })
      if (result.canceled || !result.filePaths.length) return null
      const dir = path.resolve(result.filePaths[0])
      return await serializeWorkspaceMutation(dir, () => {
        const existing = settings.get().workspaces.find(
          (item) => workspacePathKey(item.path) === workspacePathKey(dir)
        )
        if (existing) return existing
        const workspace: Workspace = {
          id: randomUUID(),
          path: dir,
          name: workspaceName(dir),
          lastOpenedAt: Date.now()
        }
        const next = settings.addWorkspace(workspace)
        return next.workspaces.find((item) => workspacePathKey(item.path) === workspacePathKey(dir)) ?? workspace
      })
    } catch {
      return null
    }
  })

  ipcMain.handle('workspaces:remove', async (_event, id: unknown, hiddenPath?: unknown): Promise<AppSettings> => {
    const workspaceId = typeof id === 'string' ? id : undefined
    const hidden = typeof hiddenPath === 'string' ? hiddenPath : undefined
    const initialWorkspace = settings.get().workspaces.find(entry => entry.id === workspaceId)
    const targetPath = initialWorkspace?.path ?? hidden
    if (!targetPath) return settings.removeWorkspace(workspaceId)
    return serializeWorkspaceMutation(targetPath, async () => {
      const workspace = settings.get().workspaces.find(entry => entry.id === workspaceId)
      const remove = () => settings.removeWorkspace(workspaceId, hidden)
      if (workspace) await supervisor.stopCwd(workspace.path, remove)
      else remove()
      return settings.get()
    })
  })

  // Register a project that the user picked from a conversation. The path is
  // the only thing the renderer knows, so the id and the display name are
  // decided here where the file system is reachable.
  ipcMain.handle(
    'workspaces:add',
    (_event, rawPath: string): Promise<{ workspace: Workspace; settings: AppSettings }> => {
      const dir = path.resolve(rawPath)
      return serializeWorkspaceMutation(dir, () => {
        const current = settings.get()
        const key = workspacePathKey(dir)
        const existing = current.workspaces.find(
          (item) => workspacePathKey(item.path) === key
        )
        if (existing) return { workspace: existing, settings: current }
        const workspace: Workspace = {
          id: randomUUID(),
          path: dir,
          name: workspaceName(dir),
          lastOpenedAt: Date.now()
        }
        const next = settings.addWorkspace(workspace)
        const saved = next.workspaces.find((item) => workspacePathKey(item.path) === key) ?? workspace
        return { workspace: saved, settings: next }
      })
    }
  )

  ipcMain.handle('sessions:list', async (_event, cwd?: string) =>
    (await listSessions(cwd, settings.get().externalChatFolder)).map(withoutProjectFolder)
  )

  ipcMain.handle('sessions:hydrate', async (_event, file: string) => {
    const opened = await openSessionFile(file, resolveSessionRoots(settings.get().externalChatFolder))
    if (!opened) return []
    try {
      return await readSessionMessages(opened.target, opened.handle)
    } finally {
      await opened.handle.close().catch(() => {})
    }
  })

  ipcMain.handle('sessions:rename', async (_event, file: string, name: string) => {
    if (typeof name !== 'string') return false
    const opened = await openSessionFile(file, resolveSessionRoots(settings.get().externalChatFolder), true)
    if (!opened) return false
    try {
      return await supervisor.rename(opened.target, name, opened.handle)
    } finally {
      await opened.handle.close().catch(() => {})
    }
  })

  // The sidebar debounces its own input, but a search that already entered
  // the main process keeps reading until it finishes. A newer request marks
  // the earlier one as superseded so the old scan stops at its next file.
  ipcMain.handle('sessions:search', async (event, query: string, limit?: number) => {
    const token = (sessionSearchSequence += 1)
    latestSessionSearches.set(event.sender, token)
    if (typeof query !== 'string' || query.length > MAX_SEARCH_QUERY_LENGTH) return []
    const hits = await searchSessions(query, limit, {
      sessionRoots: resolveSessionRoots(settings.get().externalChatFolder),
      shouldStop: () => event.sender.isDestroyed?.() === true || latestSessionSearches.get(event.sender) !== token
    })
    return hits.map(withoutProjectFolder)
  })

  ipcMain.handle('sessions:usageStats', async () => {
    const userDir = settings.get().externalChatFolder?.trim()
    return await getAggregatedUsage(userDir || undefined)
  })

  // Git is read from the folder Pi runs in: the review panel and the branch
  // chip describe the work tree the agent is actually editing.
  ipcMain.handle('git:status', () => readStatus(workspaceRoot(context)))

  ipcMain.handle('git:log', (_event, limit?: number) => readLog(workspaceRoot(context), limit))

  ipcMain.handle('git:commit', (_event, message: string, includeUnstaged?: boolean) =>
    gitWrite(context, root => commitWorkingTree(root, message, includeUnstaged === true))
  )

  ipcMain.handle('git:stageFile', (_event, file: string) =>
    gitWrite(context, root => stageFile(root, file))
  )

  ipcMain.handle('git:unstageFile', (_event, file: string) =>
    gitWrite(context, root => unstageFile(root, file))
  )

  ipcMain.handle('git:stageAll', () => gitWrite(context, root => stageAll(root)))

  ipcMain.handle('git:unstageAll', () => gitWrite(context, root => unstageAll(root)))

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
    gitWrite(context, root => applyPatch(root, patch, reverse === true))
  )

  ipcMain.handle('git:branches', () => readBranches(workspaceRoot(context)))

  ipcMain.handle('git:switchBranch', (_event, name: string) =>
    gitWrite(context, root => switchBranch(root, name))
  )

  ipcMain.handle('git:createBranch', (_event, name: string, checkout?: boolean) =>
    gitWrite(context, root => createBranch(root, name, checkout !== false))
  )

  ipcMain.handle(
    'git:addWorktree',
    (_event, worktreePath: string, branch: string, create?: boolean) =>
      gitWrite(context, root => addWorktree(root, worktreePath, branch, create !== false))
  )

  ipcMain.handle('git:removeWorktree', async (_event, worktreePath: string) => {
    const root = workspaceRoot(context)
    try {
      return await removeWorktree(
        root,
        worktreePath,
        async (resolved, remove) => {
          // A parent lock covers a nested worktree. Stop its current process
          // first so it cannot block that parent lock from being acquired.
          if (isPathWithin(root, resolved)) {
            await supervisor.stopCwd(resolved)
            return supervisor.withCwdLock(root, remove)
          }
          return supervisor.withCwdLock(root, async () => {
            await supervisor.stopCwd(resolved)
            return supervisor.withCwdLock(resolved, remove)
          })
        }
      )
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('git:revertFile', (_event, file: string) =>
    gitWrite(context, root => revertFile(root, file))
  )

  ipcMain.handle('git:push', () => gitWrite(context, root => pushBranch(root)))

  ipcMain.handle('git:pull', () => gitWrite(context, root => pullBranch(root)))

  ipcMain.handle('fs:list', async (_event, dir: string): Promise<FileListResult> => {
    const root = workspaceRoot(context)
    // A relative path is taken from the project root, not from wherever the
    // app happens to be started.
    const location = await resolveWorkspaceLocation(root, dir)
    if (!location) return { entries: [], truncated: false }
    const { target } = location
    const candidates: Dirent[] = []
    let scannedEntries = 0
    let truncated = false
    try {
      const directory = await opendir(target)
      for await (const entry of directory) {
        if (scannedEntries >= MAX_DIRECTORY_SCAN_ENTRIES) {
          truncated = true
          break
        }
        scannedEntries += 1
        if (entry.isDirectory() && TREE_SKIP_DIRS.has(entry.name)) continue
        candidates.push(entry)
      }
    } catch {
      truncated = true
    }

    const current = await resolveWorkspaceLocation(root, dir)
    if (!current || current.root !== location.root || current.target !== target) {
      return { entries: [], truncated: true }
    }
    candidates.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    if (candidates.length > MAX_DIRECTORY_LIST_ENTRIES) truncated = true
    const listed: FileEntry[] = []
    for (const entry of candidates.slice(0, MAX_DIRECTORY_LIST_ENTRIES)) {
      const full = path.join(target, entry.name)
      let size: number | undefined
      if (entry.isFile()) {
        try {
          const info = await lstat(full)
          if (info.isFile()) size = info.size
        } catch {
          size = undefined
        }
      }
      listed.push({
        name: entry.name,
        path: full,
        kind: entry.isDirectory() ? 'directory' : 'file',
        size
      })
    }
    return { entries: listed, truncated }
  })

  ipcMain.handle('fs:read', async (_event, file: string): Promise<FileContent | null> => {
    const root = workspaceRoot(context)
    const opened = await openWorkspaceFile(root, file)
    if (!opened) return null
    try {
      const result = await readBoundedHandle(opened.handle, MAX_FILE_BYTES)
      if (!result) return null
      const ext = path.extname(opened.target).slice(1).toLowerCase()
      return {
        path: opened.target,
        content: result.content,
        truncated: result.truncated,
        size: result.size,
        language: LANGUAGE_BY_EXT[ext] ?? 'text'
      }
    } finally {
      await opened.handle.close().catch(() => {})
    }
  })

  ipcMain.handle('fs:search', async (
    event,
    query: string,
    limit?: number,
    scope?: FileSearchScope
  ): Promise<FileSearchResult> => {
    // A component only supersedes its own walks; the composer and file tree can
    // search at the same time in the same renderer window.
    const searchScope = scope === 'composer-mention' || scope === 'file-tree' ? scope : 'default'
    const token = (fileSearchSequence += 1)
    let senderSearches = latestFileSearches.get(event.sender)
    if (!senderSearches) {
      senderSearches = new Map()
      latestFileSearches.set(event.sender, senderSearches)
    }
    senderSearches.set(searchScope, token)
    const superseded = () =>
      event.sender.isDestroyed?.() === true || senderSearches.get(searchScope) !== token
    if (typeof query === 'string' && query.length > MAX_SEARCH_QUERY_LENGTH) {
      return { entries: [], truncated: false }
    }
    const root = workspaceRoot(context)
    // The separators are normalised, so "src/renderer" finds the folder on
    // Windows as well.
    const needle = typeof query === 'string' ? query.trim().toLowerCase().replace(/\\/g, '/') : ''
    // An empty query lists the files of the project, which is what the
    // composer shows when the user types "@" and has not narrowed it down.
    // A zero limit is a cheap cancellation record used when a search field is
    // cleared or unmounted; setting the token above still supersedes its walk.
    if (!root || limit === 0) return { entries: [], truncated: false }
    const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit as number) : MAX_SEARCH_RESULTS
    const ceiling = Math.min(Math.max(requestedLimit, 1), MAX_SEARCH_RESULTS)
    const results: FileEntry[] = []
    const base = path.resolve(root)
    let scannedEntries = 0
    let truncated = false
    let stopWalk = false
    // The composer debounces its own input, but a walk that already started
    // keeps reading. A newer query stops the older one at its next entry.

    // The walk awaits the disk, so the event loop keeps serving Pi events and
    // other IPC while a large project is being walked.
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (results.length >= ceiling) {
        truncated = true
        stopWalk = true
        return
      }
      if (depth > MAX_SEARCH_DEPTH) {
        truncated = true
        return
      }
      if (superseded()) return
      let directory
      try {
        directory = await opendir(dir)
      } catch {
        truncated = true
        return
      }
      try {
        for await (const entry of directory) {
          if (superseded()) return
          if (scannedEntries >= MAX_PROJECT_SEARCH_ENTRIES) {
            truncated = true
            stopWalk = true
            return
          }
          scannedEntries += 1
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            if (SEARCH_SKIP_DIRS.has(entry.name)) continue
            await walk(full, depth + 1)
            if (stopWalk || superseded()) return
            continue
          }
          if (!entry.isFile()) continue
          // The path is searched, not only the name, so "renderer" finds the
          // files of the renderer and "readme" finds the README in a folder.
          const relative = path.relative(base, full)
          if (!relative.replace(/\\/g, '/').toLowerCase().includes(needle)) continue
          let size: number | undefined
          try {
            size = (await stat(full)).size
          } catch {
            size = undefined
          }
          results.push({ name: entry.name, path: full, kind: 'file', size })
          if (results.length >= ceiling) {
            truncated = true
            stopWalk = true
            return
          }
        }
      } catch {
        truncated = true
      }
    }

    await walk(base, 0)
    // The walk follows the disk, which has no order of its own.
    results.sort((a, b) => a.path.localeCompare(b.path))
    return { entries: results, truncated }
  })

  // Search what is inside the files, not only their names. The walk is the
  // same one the file search uses, so both see the same project.
  ipcMain.handle('fs:searchText', async (event, query: string, limit?: number): Promise<TextSearchResult> => {
    // Clearing the query or leaving the workspace must invalidate any walk
    // that was already reading files.
    const token = (textSearchSequence += 1)
    latestTextSearches.set(event.sender, token)
    if (typeof query !== 'string' || query.length > MAX_SEARCH_QUERY_LENGTH) {
      return { hits: [], truncated: false }
    }
    const superseded = () =>
      event.sender.isDestroyed?.() === true || latestTextSearches.get(event.sender) !== token
    const root = workspaceRoot(context)
    const needle = query.trim().toLowerCase()
    if (!root || !needle) return { hits: [], truncated: false }
    const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit as number) : MAX_SEARCH_RESULTS
    const ceiling = Math.min(Math.max(requestedLimit, 1), MAX_SEARCH_RESULTS)
    const base = path.resolve(root)
    const hits: TextSearchHit[] = []
    let scannedEntries = 0
    let scannedBytes = 0
    let truncated = false
    let stopWalk = false
    // Typing another character should not leave the previous query reading the
    // project; the sidebar's versioning only ignores the answer, not the work.

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (hits.length >= ceiling) {
        truncated = true
        stopWalk = true
        return
      }
      if (depth > MAX_SEARCH_DEPTH) {
        truncated = true
        return
      }
      if (superseded()) return
      let directory
      try {
        directory = await opendir(dir)
      } catch {
        truncated = true
        return
      }
      try {
        for await (const entry of directory) {
          if (superseded()) return
          if (scannedEntries >= MAX_TEXT_SEARCH_SCAN_ENTRIES) {
            truncated = true
            stopWalk = true
            return
          }
          scannedEntries += 1
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            if (SEARCH_SKIP_DIRS.has(entry.name)) continue
            await walk(full, depth + 1)
            if (stopWalk || superseded()) return
            continue
          }
          if (!entry.isFile()) continue
          const result = await searchFileText(
            root,
            full,
            needle,
            ceiling - hits.length,
            MAX_TEXT_SEARCH_SCAN_BYTES - scannedBytes
          )
          if (result.budgetExceeded) {
            truncated = true
            stopWalk = true
            return
          }
          if (result.incomplete) truncated = true
          scannedBytes += result.bytesRead
          if (result.hits.length) hits.push(...result.hits)
          if (hits.length >= ceiling) {
            truncated = true
            stopWalk = true
            return
          }
        }
      } catch {
        truncated = true
      }
    }

    await walk(base, 0)
    hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    return { hits: hits.slice(0, ceiling), truncated }
  })

  ipcMain.handle('fs:listImages', async (event): Promise<ImageListResult> => {
    const token = (imageListSequence += 1)
    latestImageLists.set(event.sender, token)
    const shouldStop = () =>
      event.sender.isDestroyed() || latestImageLists.get(event.sender) !== token
    const root = workspaceRoot(context)
    return await listProjectImages(root, MAX_IMAGE_RESULTS, shouldStop)
  })

  ipcMain.handle('sessions:remove', async (_event, file: string): Promise<boolean> => {
    try {
      return await removeSessionFile(file, supervisor, resolveSessionRoots(settings.get().externalChatFolder))
    } catch (error) {
      console.error('[pi-desktop] could not trash the session file:', error)
      return false
    }
  })

  ipcMain.handle('fs:reveal', async (_event, file: string) => {
    const target = await resolveWorkspacePath(workspaceRoot(context), file)
    if (target) shell.showItemInFolder(target)
  })

  /**
   * A picture pasted into the composer, written next to the conversation.
   *
   * It lands in the folder Pi runs in — the project, or the chats folder for a
   * projectless conversation — because that is the only place the `@` list
   * searches and a path relative to the working directory can be read back
   * from. Unlike `fs:saveImage`, which asks the user where an exported picture
   * should go, this one never opens a dialog: a failure is `null`, and the
   * composer falls back to attaching the picture only.
   */
  ipcMain.handle(
    'fs:savePastedImage',
    (_event, data: string, mimeType: string): { path: string; root: string } | null => {
      const root = workspaceRoot(context)
      const extension = typeof mimeType === 'string' ? pastedImageExtension(mimeType) : null
      const buffer = decodeImageData(data)
      if (!root || !extension || !buffer) return null
      // `workspaceRoot` creates projectless chats; a missing workspace must not be recreated.
      const stamp = Date.now()
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const name = attempt
          ? `pi-picture-${stamp}-${attempt}.${extension}`
          : `pi-picture-${stamp}.${extension}`
        const target = path.join(root, name)
        try {
          // `wx` fails on a name that already exists rather than overwriting a
          // file of the project, and a read-only folder answers EROFS or EACCES.
          writeFileSync(target, buffer, { flag: 'wx' })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'ENOENT' && code !== 'ENOTDIR') {
            console.error('[pi-desktop] could not save the pasted picture:', error)
          }
          return null
        }
        return { path: target, root }
      }
      return null
    }
  )

  // A picture the model produced. It arrives as base64, so it is written
  // from here rather than fetched from somewhere.
  ipcMain.handle(
    'fs:saveImage',
    async (_event, data: string, mimeType: string): Promise<string | null> => {
      if (typeof mimeType !== 'string' || !mimeType.toLowerCase().startsWith('image/')) return null
      const buffer = decodeImageData(data)
      if (!buffer) return null
      const extension = mimeType.includes('png')
        ? 'png'
        : mimeType.includes('webp')
          ? 'webp'
          : mimeType.includes('gif')
            ? 'gif'
            : 'jpg'
      let result: Electron.SaveDialogReturnValue
      try {
        const window = getWindow()
        result = window && !window.isDestroyed()
          ? await dialog.showSaveDialog(window, {
              title: 'Save the picture',
              defaultPath: `pi-picture-${Date.now()}.${extension}`,
              filters: [{ name: 'Image', extensions: [extension] }]
            })
          : await dialog.showSaveDialog({
              defaultPath: `pi-picture-${Date.now()}.${extension}`
            })
      } catch {
        return null
      }
      if (result.canceled || !result.filePath) return null
      try {
        writeFileSync(result.filePath, buffer)
        return result.filePath
      } catch (error) {
        console.error('[pi-desktop] could not save the picture:', error)
        return null
      }
    }
  )

  ipcMain.handle('runtime:start', async (_event, options: RuntimeStartOptions) => {
    if (!options || typeof options !== 'object') return { ok: false, error: 'Invalid runtime options.' }
    const resolvedCwd = await resolveRuntimeCwd(context, options.cwd)
    if (!resolvedCwd) return { ok: false, error: 'Working folder is not an available workspace.' }
    const cwd = resolvedCwd.cwd
    const sessionRoots = resolveSessionRoots(context.settings.get().externalChatFolder)
    const validated = await validateRuntimeSessionFile(options.sessionFile, cwd, sessionRoots)
    if (!validated.ok) {
      return { ok: false, error: runtimeSessionFileError(validated.reason) }
    }
    if (!runtimeCwdStillRegistered(context, resolvedCwd)) {
      return { ok: false, error: 'Working folder is no longer an available workspace.' }
    }
    const sessionKey = validated.sessionFile || `draft:${randomUUID()}`
    return supervisor.ensure({
      ...options,
      sessionFile: validated.sessionFile,
      sessionKey,
      cwd,
      customInstructions: runtimeInstructions(context, cwd)
    })
  })

  ipcMain.handle('runtime:ensure', async (_event, options: RuntimeEnsureOptions) => {
    if (!options || typeof options !== 'object') return { ok: false, error: 'Invalid runtime options.' }
    const resolvedCwd = await resolveRuntimeCwd(context, options.cwd)
    if (!resolvedCwd) return { ok: false, error: 'Working folder is not an available workspace.' }
    const cwd = resolvedCwd.cwd
    if (typeof options.sessionKey !== 'string' || !options.sessionKey) {
      return { ok: false, error: 'Missing conversation id' }
    }
    const sessionRoots = resolveSessionRoots(context.settings.get().externalChatFolder)
    const validated = await validateRuntimeSessionFile(options.sessionFile, cwd, sessionRoots)
    // Pi can report a newly assigned session path before it has flushed the
    // JSONL. A hot runtime already owns that key, so reuse it without treating
    // the not-yet-written path as a request to open a session file.
    const runtimeIsLive =
      typeof options.sessionKey === 'string' &&
      typeof supervisor.has === 'function' &&
      supervisor.has(options.sessionKey)
    const liveInfo = runtimeIsLive ? supervisor.sessionInfo?.(options.sessionKey) : undefined
    if (runtimeIsLive) {
      if (!liveInfo?.cwd) return { ok: false, error: runtimeSessionFileError('metadata') }
      if (!(await runtimeCwdsMatch(liveInfo.cwd, cwd))) {
        return { ok: false, error: runtimeSessionFileError('cwd') }
      }
    }
    const isPendingLiveFile =
      !validated.ok &&
      validated.reason === 'unavailable' &&
      runtimeIsLive &&
      typeof options.sessionFile === 'string' &&
      canonicalSessionFile(options.sessionFile) === canonicalSessionFile(options.sessionKey) &&
      liveInfo !== undefined
    if (!validated.ok && !isPendingLiveFile) {
      return { ok: false, error: runtimeSessionFileError(validated.reason) }
    }
    if (!runtimeCwdStillRegistered(context, resolvedCwd)) {
      return { ok: false, error: 'Working folder is no longer an available workspace.' }
    }
    return supervisor.ensure({
      ...options,
      sessionFile: validated.ok ? validated.sessionFile : undefined,
      cwd,
      customInstructions: runtimeInstructions(context, cwd)
    })
  })

  ipcMain.handle('runtime:has', (_event, sessionKey: string) => {
    return typeof sessionKey === 'string' && supervisor.has(sessionKey)
  })

  ipcMain.handle('runtime:skill-commands', () => {
    const current = settings.get()
    return discoverSkillCommands(
      workspaceRoot(context) || projectlessRoot(),
      current.piPath,
      current.trustProject
    )
  })

  ipcMain.handle('runtime:stop', async (_event, sessionKey: unknown) => {
    if (typeof sessionKey !== 'string' || !sessionKey.trim()) return
    await supervisor.stop(sessionKey)
  })

  ipcMain.handle('runtime:stopCwd', async (_event, cwd: unknown) => {
    const target = await resolveRuntimeStopCwd(context, cwd)
    if (target) await supervisor.stopCwd(target)
  })

  ipcMain.handle(
    'runtime:request',
    async (
      _event,
      command: string,
      payload: Record<string, unknown> = {},
      timeoutMs?: number,
      trace?: unknown,
      sessionKey?: string
    ) => {
      const hint = readTraceHint(trace)
      const key = typeof sessionKey === 'string' && sessionKey ? sessionKey : hint?.uiSessionId
      if (!key) throw new Error('Missing conversation id')
      return supervisor.request(key, command, payload, timeoutMs, hint)
    }
  )

  ipcMain.handle(
    'runtime:respondUi',
    async (_event, id: string, response: ExtensionUiResponse, sessionKey?: string) => {
      const key = typeof sessionKey === 'string' && sessionKey ? sessionKey : ''
      supervisor.respondUi(key, id, response)
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
  ipcMain.handle('mcp:setEnabled', (_event, name: string, enabled: boolean) =>
    setMcpServerEnabled(name, enabled, workspaceRoot(context))
  )
  ipcMain.handle('mcp:remove', (_event, name: string) =>
    removeMcpServer(name, workspaceRoot(context))
  )

  // The marketplace snapshot is bundled; refresh and install are the only
  // paths that touch the network or the Pi CLI.
  ipcMain.handle('marketplace:list', () => listMarketplace())
  ipcMain.handle('marketplace:refresh', () => refreshMarketplace())
  ipcMain.handle('marketplace:installed', () =>
    listInstalledMarketplaceIds({ cwd: workspaceRoot(context) })
  )
  ipcMain.handle('marketplace:managed', () =>
    listManagedPackages({ cwd: workspaceRoot(context) })
  )
  ipcMain.handle('marketplace:install', (_event, id: unknown) => {
    if (typeof id !== 'string' || !id.trim()) {
      return { ok: false, output: 'Invalid marketplace entry id.' }
    }
    return installMarketplaceEntry(id, {
      cwd: workspaceRoot(context),
      customPiPath: settings.get().piPath
    })
  })
  ipcMain.handle('marketplace:installNpm', (_event, packageName: unknown) => {
    if (typeof packageName !== 'string' || !packageName.trim()) {
      return { ok: false, output: 'Invalid npm package name.' }
    }
    return installNpmPackage(packageName, {
      cwd: workspaceRoot(context),
      customPiPath: settings.get().piPath
    })
  })
  ipcMain.handle('marketplace:installGitRepository', (_event, repository: unknown) => {
    if (typeof repository !== 'string' || !repository.trim()) {
      return { ok: false, output: 'Invalid GitHub repository.' }
    }
    return installGitRepository(repository, {
      cwd: workspaceRoot(context),
      customPiPath: settings.get().piPath
    })
  })
  ipcMain.handle('marketplace:createResource', (_event, input: unknown) => {
    if (!input || typeof input !== 'object') {
      return { ok: false, output: 'Invalid resource input.' }
    }
    return createResource(input as Parameters<typeof createResource>[0])
  })
  ipcMain.handle('marketplace:setPackageEnabled', (_event, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || !id.trim() || typeof enabled !== 'boolean') {
      return { ok: false, output: 'Invalid package action.' }
    }
    return setPackageEnabled(id, enabled, workspaceRoot(context))
  })
  ipcMain.handle('marketplace:removePackage', (_event, id: unknown) => {
    if (typeof id !== 'string' || !id.trim()) {
      return { ok: false, output: 'Invalid package id.' }
    }
    return removePackage(id, workspaceRoot(context))
  })

  ipcMain.handle('shell:nativeIcons', () => nativeAppIcons())

  ipcMain.handle('shell:openPath', async (_event, target: string) => {
    const opener = settings.get().defaultFileOpener
    if (typeof target !== 'string' || !target) return 'Invalid path.'
    const resolved = await resolveWorkspacePath(workspaceRoot(context), target)
    if (!resolved) return 'Path is not available inside the open project.'
    if (
      (opener === 'vscode' || opener === 'cursor' || opener === 'windsurf') &&
      (await launchEditor(opener, resolved))
    ) return ''
    return await shell.openPath(resolved)
  })

  ipcMain.handle('shell:openInExplorer', async (_event, target: unknown) => {
    if (typeof target !== 'string' || !target) return 'Invalid path.'
    for (const workspace of settings.get().workspaces) {
      const location = await resolveWorkspaceLocation(workspace.path, target)
      if (location && location.target === location.root) return await shell.openPath(location.target)
    }
    return 'Path is not a registered project folder.'
  })

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    if (!/^https?:\/\//i.test(url)) return
    await shell.openExternal(url)
  })

  // A picture from the project, read as a data URL. The inspector's viewer
  // draws the project's images, and it may not touch the disk itself.
  ipcMain.handle(
    'fs:readImageDataUrl',
    (_event, file: string, maxBytes?: number) => readImageDataUrl(context, file, maxBytes)
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
export function sendToWindow(window: BrowserWindow | null, channel: string, payload: unknown): void {
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
  const { supervisor, settings, getWindow } = context
  supervisor.on('event', (payload: { ownerId: string; event: PiEvent }) => {
    const window = getWindow()
    sendToWindow(window, 'runtime:event', payload)
    const event = payload.event

    if (
      window &&
      !window.isDestroyed() &&
      !window.isFocused() &&
      settings.getCached().desktopNotifications !== false
    ) {
      let body: string | null = null
      if (event.type === 'agent_settled') {
        body = 'Pi finished a conversation.'
      } else if (
        event.type === 'extension_ui_request' &&
        ['select', 'confirm', 'input', 'editor'].includes(String(event.method ?? ''))
      ) {
        body = String(event.title ?? event.message ?? 'Pi needs your input.')
      }
      if (body) {
        showDesktopNotification(window, 'Pi Desktop', body)
      }
    }
  })
  supervisor.on('status', (payload: { ownerId: string; status: RuntimeStatus }) => {
    sendToWindow(getWindow(), 'runtime:status', payload)
  })
  supervisor.on('rekey', (payload: RuntimeRekey) => {
    sendToWindow(getWindow(), 'runtime:rekey', payload)
  })
  supervisor.on('rename', (payload: { file: string; name: string }) => {
    // Renames happen in the main process (auto-title, cold sessions) and never
    // reach the session index by themselves; the renderer has to re-read it.
    sendToWindow(getWindow(), 'sessions:changed', payload)
  })
  supervisor.on('stderr', (payload: { ownerId: string; line: string }) => {
    sendToWindow(getWindow(), 'runtime:stderr', payload.line)
  })
  context.memory.on('changed', (state: MemoryState) => {
    sendToWindow(getWindow(), 'memory:changed', state)
  })
  context.scheduledTasks.on('changed', (tasks: ScheduledTask[]) => {
    sendToWindow(getWindow(), 'scheduled-tasks:changed', tasks)
  })
}
