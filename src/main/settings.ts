import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  AppSettings,
  SettingsPatchBaseline,
  SidebarArchiveFilter,
  SidebarGroupBy,
  SidebarSortBy,
  Workspace
} from '@shared/types'
import {
  DEFAULT_IMAGE_OUTPUT_DIR,
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_IMAGE_SIZE,
  SIDEBAR_ARCHIVE_FILTERS,
  SIDEBAR_GROUP_MODES,
  SIDEBAR_SORT_MODES
} from '@shared/types'
import { normalizeFontScale } from '@shared/font-scale'
import { migratePresetColors } from '@shared/theme-presets'
import { withNewProjectFirst } from '@shared/project-order'
import { syncAgentDefaults } from './pi/retry-policy'
import { properLockfile } from './proper-lockfile'

/** Same folder, whatever slash style or drive-letter case it was opened with. */
function workspaceKey(value: string): string {
  const resolved = path.resolve(value).replace(/[/\\]+$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * The project row order is stored by path and is independent of whether the
 * folder is registered yet. Keep the user's order and drop duplicate spellings
 * of the same folder.
 */
function normalizeProjectOrder(paths: unknown): string[] {
  if (!Array.isArray(paths)) return []
  const seen = new Set<string>()
  const order: string[] = []
  for (const item of paths) {
    if (typeof item !== 'string' || !item) continue
    const key = workspaceKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    order.push(item)
  }
  return order
}

const MAX_EXTERNAL_CHAT_FOLDERS = 16
const MAX_SETTINGS_PATH_CHARS = 32_768

function normalizePathList(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim() || value.length > MAX_SETTINGS_PATH_CHARS) continue
    const key = workspaceKey(value)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function normalizeShortcutChord(chord: unknown): string[] | undefined {
  if (!Array.isArray(chord)) return undefined
  const keys = chord.filter((key): key is string => typeof key === 'string' && key.length > 0)
  return keys.length > 0 ? keys : undefined
}

function normalizeShortcutBindings(
  bindings: unknown
): Record<string, string[] | string[][]> | undefined {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return undefined
  const result: Record<string, string[] | string[][]> = {}
  for (const [id, raw] of Object.entries(bindings)) {
    if (!id || !Array.isArray(raw)) continue
    if (raw.length === 0) {
      result[id] = []
      continue
    }
    if (raw.every((item) => typeof item === 'string')) {
      const chord = normalizeShortcutChord(raw)
      if (chord) result[id] = chord
      continue
    }
    const chords: string[][] = []
    const seen = new Set<string>()
    for (const item of raw) {
      const chord = normalizeShortcutChord(item)
      if (!chord) continue
      const key = chord.join('+')
      if (seen.has(key)) continue
      seen.add(key)
      chords.push(chord)
    }
    result[id] = chords.length === 1 ? chords[0] : chords
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function normalizeExternalChatFolderHistory(paths: unknown, activeFolder: unknown): string[] {
  if (!Array.isArray(paths)) return []
  const activePath = typeof activeFolder === 'string' ? activeFolder.trim() : ''
  const activeKey = activePath ? workspaceKey(activePath) : undefined
  const seen = new Set<string>()
  const folders: string[] = []
  for (const item of paths) {
    if (typeof item !== 'string' || !item.trim()) continue
    const folder = item.trim()
    const key = workspaceKey(folder)
    if (key === activeKey || seen.has(key)) continue
    seen.add(key)
    folders.push(folder)
  }
  return folders.slice(-MAX_EXTERNAL_CHAT_FOLDERS)
}

/** One entry per folder. A later open of the same path replaces the earlier one.
 *
 * The array order is the sidebar order, and only an explicit drag may change
 * it. `lastOpenedAt` records activity for other readers; it must never sort
 * this list — opening a project used to pull it to the top on every settings
 * write and undo the order the user dragged.
 */
export function dedupeWorkspaces(workspaces: unknown): Workspace[] {
  if (!Array.isArray(workspaces)) return []
  const map = new Map<string, Workspace>()
  for (const candidate of workspaces) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const item = candidate as Partial<Workspace>
    const id = item.id
    const workspacePath = item.path
    const name = item.name
    if (typeof id !== 'string' || !id || typeof workspacePath !== 'string' || !workspacePath || typeof name !== 'string' || !name) continue
    const workspace: Workspace = {
      ...item,
      id,
      path: workspacePath,
      name,
      lastOpenedAt: typeof item.lastOpenedAt === 'number' && Number.isFinite(item.lastOpenedAt)
        ? item.lastOpenedAt
        : 0,
      // A folder registered before this field existed has no start date; leave
      // it absent so the sidebar can fall back to its oldest conversation
      // instead of showing "added just now" for an old project.
      ...(typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)
        ? { createdAt: item.createdAt }
        : {})
    }
    const key = workspaceKey(workspace.path)
    const existing = map.get(key)
    if (!existing || workspace.lastOpenedAt >= existing.lastOpenedAt) {
      // `Map.set` on an existing key keeps its original position, so replacing
      // the newer duplicate does not move the project.
      map.set(key, workspace)
    }
  }
  return [...map.values()]
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function mergeWorkspaces(
  baseline: Workspace[],
  proposed: Workspace[],
  current: Workspace[],
  removedIds: ReadonlySet<string>
): Workspace[] {
  const baselineById = new Map(baseline.map((workspace) => [workspace.id, workspace]))
  const currentById = new Map(current.map((workspace) => [workspace.id, workspace]))
  const proposedById = new Map(proposed.map((workspace) => [workspace.id, workspace]))
  const mergedById = new Map<string, Workspace>()

  for (const workspace of current) {
    if (removedIds.has(workspace.id)) continue
    const proposedWorkspace = proposedById.get(workspace.id)
    const baselineWorkspace = baselineById.get(workspace.id)
    if (!proposedWorkspace || !baselineWorkspace) {
      mergedById.set(workspace.id, proposedWorkspace ?? workspace)
      continue
    }

    const merged = { ...workspace } as Workspace & Record<string, unknown>
    const original = baselineWorkspace as Workspace & Record<string, unknown>
    const requested = proposedWorkspace as Workspace & Record<string, unknown>
    const keys = new Set([...Object.keys(original), ...Object.keys(requested)])
    for (const key of keys) {
      const hadOriginal = Object.prototype.hasOwnProperty.call(original, key)
      const hasRequested = Object.prototype.hasOwnProperty.call(requested, key)
      if (hadOriginal === hasRequested && sameValue(original[key], requested[key])) continue
      if (hasRequested) merged[key] = requested[key]
      else delete merged[key]
    }
    mergedById.set(workspace.id, merged)
  }

  const result: Workspace[] = []
  const added = new Set<string>()
  const append = (workspace: Workspace) => {
    if (!removedIds.has(workspace.id) && !added.has(workspace.id)) {
      result.push(workspace)
      added.add(workspace.id)
    }
  }

  // Preserve the order requested for projects this editor already knew.
  // Projects from other processes stay in their on-disk order, followed by
  // brand-new entries from this patch.
  const retainedIds = baseline.filter(({ id }) => proposedById.has(id)).map(({ id }) => id)
  const proposedIds = proposed.filter(({ id }) => baselineById.has(id)).map(({ id }) => id)
  if (!sameValue(retainedIds, proposedIds)) {
    for (const workspace of proposed) {
      const merged = mergedById.get(workspace.id)
      if (merged) append(merged)
    }
  }
  for (const workspace of current) {
    const merged = mergedById.get(workspace.id)
    if (merged) append(merged)
  }
  for (const workspace of proposed) {
    if (!baselineById.has(workspace.id) && !currentById.has(workspace.id)) append(workspace)
  }
  return dedupeWorkspaces(result)
}

function mergeStringSet(
  baseline: string[],
  proposed: string[],
  current: string[]
): string[] {
  const keyOf = (value: string) => workspaceKey(value)
  const baselineKeys = new Set(baseline.map(keyOf))
  const proposedKeys = new Set(proposed.map(keyOf))
  const removed = new Set([...baselineKeys].filter((key) => !proposedKeys.has(key)))
  const result = current.filter((value) => !removed.has(keyOf(value)))
  const resultKeys = new Set(result.map(keyOf))
  for (const value of proposed) {
    const key = keyOf(value)
    if (!baselineKeys.has(key) && !resultKeys.has(key)) {
      result.push(value)
      resultKeys.add(key)
    }
  }
  return result
}

function mergeProjectOrder(baseline: string[], proposed: string[], current: string[]): string[] {
  const proposedKeys = new Set(proposed.map(workspaceKey))
  const baselineKeys = new Set(baseline.map(workspaceKey))
  const retained = baseline.map(workspaceKey).filter((key) => proposedKeys.has(key))
  const merged = (() => {
    if (sameValue(retained, proposed.slice(0, retained.length).map(workspaceKey))) {
      return mergeStringSet(baseline, proposed, current)
    }
    const currentKeys = new Set(current.map(workspaceKey))
    const reordered = normalizeProjectOrder(proposed.filter((item) => {
      const key = workspaceKey(item)
      return !baselineKeys.has(key) || currentKeys.has(key)
    }))
    const reorderedKeys = new Set(reordered.map(workspaceKey))
    const result: string[] = []
    let next = 0
    // Refill only the slots that take part in this reorder. A project that
    // appeared after the editor took its snapshot keeps its on-disk slot.
    for (const item of current) {
      const key = workspaceKey(item)
      if (reorderedKeys.has(key)) result.push(reordered[next++]!)
      else if (!baselineKeys.has(key)) result.push(item)
    }
    return [...result, ...reordered.slice(next)]
  })()
  // A patch that leads with a path the baseline never had is announcing a
  // folder the reader has just added: it belongs on the first row, which is
  // also true when another process wrote the order in between (the merge above
  // then appends). Everything else keeps the place it already had.
  const lead = proposed[0]
  if (lead && !baselineKeys.has(workspaceKey(lead))) {
    const key = workspaceKey(lead)
    return normalizeProjectOrder([lead, ...merged.filter((item) => workspaceKey(item) !== key)])
  }
  return merged
}

function mergeRecord<T>(
  baseline: Record<string, T>,
  proposed: Record<string, T>,
  current: Record<string, T>
): Record<string, T> {
  const result = { ...current }
  const keys = new Set([...Object.keys(baseline), ...Object.keys(proposed)])
  for (const key of keys) {
    const hadBaseline = Object.prototype.hasOwnProperty.call(baseline, key)
    const hasProposed = Object.prototype.hasOwnProperty.call(proposed, key)
    if (hadBaseline === hasProposed && sameValue(baseline[key], proposed[key])) continue
    if (hasProposed) result[key] = proposed[key]
    else delete result[key]
  }
  return result
}

/** A persisted enum keeps its default when the file holds a value we never shipped. */
function normalizeChoice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? value as T
    : fallback
}

/** Where a link in the conversation opens. */
const URL_OPEN_TARGETS = ['external', 'internal'] as const

const DEFAULT_SETTINGS: AppSettings = {
  workspaces: [],
  projectOrder: [],
  pinnedSessions: [],
  archivedSessions: [],
  sidebarGroupBy: 'workspace',
  sidebarSortBy: 'manual',
  sidebarArchiveFilter: 'hidden',
  theme: 'dark',
  language: 'en',
  fontScale: 1,
  diffSplit: false,
  drawerWidth: 520,
  trustProject: false,
  permissionMode: 'ask',
  desktopNotifications: true,
  defaultFileOpener: 'vscode',
  urlOpenTarget: 'external',
  agentEnvironment: 'windows',
  terminalShell: 'powershell',
  compactChatHistory: true,
  pluginsEnabled: true,
  plainTextEditor: false,
  showContextUsage: true,
  sendShortcut: 'enter',
  followUpMode: 'steer',
  computerUse: false,
  // Folding is what a settled turn already does today (ProcessTrail keeps the
  // trail closed until the reader opens it), so that one ships on and the row
  // only ever gives the behaviour back. Everything else here is new behaviour:
  // off, so adding the page cannot spend tokens or change a run's tools by
  // surprise.
  defaultPlanMode: false,
  pasteMentions: false,
  autoFoldProcess: true,
  toolCallSummary: true,
  autoTitle: false,
  automaticUpdates: false,
  trayPersistent: false,
  memoriesEnabled: true,
  memoryGeneration: true,
  memorySkipExternalContext: true,
  imageModel: '',
  imageSize: DEFAULT_IMAGE_SIZE,
  imageQuality: DEFAULT_IMAGE_QUALITY,
  imageOutputDir: DEFAULT_IMAGE_OUTPUT_DIR
}

/** "Segoe UI" was the old explicit choice; MCode's system recipe is the same
 *  Latin face plus the platform CJK fallback, so it becomes the system preset. */
function normalizeFontFamily(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  return value === 'Segoe UI' ? 'system' : value
}

/** The old GitHub preset wrote #1F2328 as a custom foreground; the contrast
 *  pass makes pure black the intentional ink for that preset. */
function normalizeThemeForeground(parsed: Partial<AppSettings>): string | undefined {
  const customFg = typeof parsed.customFg === 'string' ? parsed.customFg : undefined
  if (parsed.themePreset === 'github' && customFg?.toLowerCase() === '#1f2328') {
    return '#000000'
  }
  return customFg
}

/**
 * Settings as stored on disk. A missing file returns undefined and invalid
 * content returns null. A byte order mark from a Windows editor is accepted.
 */
interface PersistedAppSettings extends Partial<AppSettings> {
  /** Marks a project-trust choice explicitly reviewed by the user. */
  projectTrustReviewed?: boolean
  /** Workspace removals that stale full-list patches must not undo. */
  removedWorkspaceIds?: string[]
}

function readSettingsFile(file: string): PersistedAppSettings | null | undefined {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as PersistedAppSettings
      : null
  } catch {
    return null
  }
}

function settingsFileVersion(file: string): string | undefined {
  try {
    const stats = statSync(file, { bigint: true })
    return `${stats.mtimeNs}:${stats.ctimeNs}:${stats.size}:${stats.ino}`
  } catch {
    return undefined
  }
}

const settingsLockWait = new Int32Array(new SharedArrayBuffer(4))

/** Restrict the app's private data directory before reading persisted user data. */
export function secureUserDataDirectory(directory: string): boolean {
  try {
    if (!directory || !path.isAbsolute(directory)) return false
    const target = path.resolve(directory)
    const volumeRoot = path.parse(target).root
    const isVolumeRoot = process.platform === 'win32'
      ? target.toLowerCase() === volumeRoot.toLowerCase()
      : target === volumeRoot
    if (isVolumeRoot) return false

    mkdirSync(target, { recursive: true, mode: 0o700 })
    const info = lstatSync(target)
    if (!info.isDirectory() || info.isSymbolicLink()) return false
    if (process.platform === 'win32') return secureWindowsUserDataDirectory(target)
    if ((statSync(target).mode & 0o077) !== 0) chmodSync(target, 0o700)
    return (statSync(target).mode & 0o077) === 0
  } catch {
    return false
  }
}

/** Parse the stable SID column from `whoami /user /fo csv /nh`. */
export function parseWindowsUserSid(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const sid = line.match(/(?:^|,)\s*"?(S-1-\d+(?:-\d+)+)"?\s*$/i)?.[1]
    if (sid) return sid
  }
  return undefined
}

/**
 * Build the ordered ACL operations for the user-data root.
 *
 * The root is the part that has to be right before anything is read: inheritance
 * is cut and replaced with `(OI)(CI)` entries, so every file the app creates from
 * now on is already restricted. Rewriting the ACL of every existing child is a
 * migration, not a launch step — see `windowsUserDataChildAclCommands`.
 */
export function windowsUserDataAclCommands(directory: string, userSid: string): string[][] {
  const allowed = [
    `*${userSid}:(OI)(CI)F`,
    '*S-1-5-18:(OI)(CI)F',
    '*S-1-5-32-544:(OI)(CI)F'
  ]
  return [
    [directory, '/reset', '/Q', '/L'],
    [directory, '/inheritance:r', '/Q', '/L'],
    [directory, '/grant:r', ...allowed, '/Q', '/L']
  ]
}

/**
 * The one-time pass that brings existing children under the root's ACL.
 *
 * `icacls /T` reads and rewrites the security descriptor of every entry, and the
 * Chromium caches alone are tens of thousands of files: measured here at ~90 s
 * just to enumerate them. Doing it on every launch held the window off screen for
 * minutes, so it runs once per directory (marked by `ACL_CHILDREN_MARKER`) and in
 * the background.
 */
export function windowsUserDataChildAclCommands(directory: string): string[][] {
  return [[path.win32.join(directory, '*'), '/reset', '/T', '/C', '/L', '/Q']]
}

/** Names the completed child pass, so later launches skip it. */
const ACL_CHILDREN_MARKER = '.acl-children-secured-v1'

function aclChildrenSecured(directory: string, userSid: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(directory, ACL_CHILDREN_MARKER), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return false
    const record = parsed as { sid?: unknown; at?: unknown }
    // A different account owning the folder means the pass has to run again.
    return record.sid === userSid && typeof record.at === 'number'
  } catch {
    return false
  }
}

function markAclChildrenSecured(directory: string, userSid: string): void {
  try {
    writeFileSync(
      path.join(directory, ACL_CHILDREN_MARKER),
      JSON.stringify({ sid: userSid, at: Date.now() }),
      'utf8'
    )
  } catch {
    /* The pass still ran; the next launch simply repeats it. */
  }
}

interface WindowsUserIdentity {
  account: string
  userSid: string
}

let cachedWindowsIdentity: WindowsUserIdentity | undefined

function windowsUserIdentity(systemDirectory: string): WindowsUserIdentity | undefined {
  if (cachedWindowsIdentity) return cachedWindowsIdentity
  try {
    const userOutput = execFileSync(
      path.join(systemDirectory, 'whoami.exe'),
      ['/user', '/fo', 'csv', '/nh'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
    )
    const account = parseWindowsUserName(userOutput)
    const userSid = parseWindowsUserSid(userOutput)
    if (!account || !userSid) return undefined
    cachedWindowsIdentity = { account, userSid }
    return cachedWindowsIdentity
  } catch {
    return undefined
  }
}

function windowsUserSid(systemDirectory: string): string | undefined {
  return windowsUserIdentity(systemDirectory)?.userSid
}

/** Parse the account name from `whoami /user /fo csv /nh`. */
export function parseWindowsUserName(output: string): string | undefined {
  const match = /^\s*"([^"]+)"/.exec(output)
  return match?.[1]?.trim() || undefined
}

/**
 * Read the root directory's ACL without touching it.
 *
 * This is the fast path that keeps a normal launch in the milliseconds: the
 * previous implementation applied `icacls /reset` and `/grant:r` on every start,
 * and on a data folder with tens of thousands of Chromium cache files the
 * inheritable-ACE propagation blocked the main process for a minute before the
 * window could appear. Reading one directory's ACL is cheap; only a directory
 * that is not already restricted pays for the write.
 */
export function windowsUserDataAclSecure(acl: string, account: string, userSid: string, directory?: string): boolean {
  const userPrincipals = new Set([account, userSid, `*${userSid}`].map((value) => value.toLowerCase()))
  const allowedPrincipals = new Set([
    ...userPrincipals,
    'nt authority\\system',
    'system',
    's-1-5-18',
    '*s-1-5-18',
    'builtin\\administrators',
    'administrators',
    's-1-5-32-544',
    '*s-1-5-32-544'
  ])
  const output = directory && acl.slice(0, directory.length).toLowerCase() === directory.toLowerCase()
    ? acl.slice(directory.length)
    : acl
  const entries = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes(':(OI)') || line.includes(':(CI)'))
  if (entries.length === 0) return false

  let hasUser = false
  for (const entry of entries) {
    const separator = entry.indexOf(':')
    if (separator <= 0) return false
    const principal = entry.slice(0, separator).trim().toLowerCase()
    const permissions = entry.slice(separator + 1)
    // An allowlist is the security boundary: Full control for an additional
    // account is not a secured directory, even when the current user is present.
    if (!allowedPrincipals.has(principal)) return false
    if (permissions.includes('(I)') || !permissions.includes('(OI)(CI)(F)')) return false
    if (/\((?:DENY|N)\)/i.test(permissions)) return false
    if (userPrincipals.has(principal)) hasUser = true
  }
  return hasUser
}

function windowsUserDataAclAlreadySecured(
  directory: string,
  systemDirectory: string
): boolean {
  try {
    const identity = windowsUserIdentity(systemDirectory)
    if (!identity) return false
    const acl = execFileSync(path.join(systemDirectory, 'icacls.exe'), [directory, '/L'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    return windowsUserDataAclSecure(acl, identity.account, identity.userSid, directory)
  } catch {
    return false
  }
}

/** True when this launch actually rewrote the root ACL. */
let userDataAclChanged = false

export function didUserDataAclChange(): boolean {
  return userDataAclChanged
}

function secureWindowsUserDataDirectory(directory: string): boolean {
  const target = path.resolve(directory)
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) return false

  try {
    const systemDirectory = path.join(systemRoot, 'System32')
    if (windowsUserDataAclAlreadySecured(target, systemDirectory)) return true
    const icacls = path.join(systemDirectory, 'icacls.exe')
    const marker = path.join(target, '.acl-secured-v1')
    const userSid = windowsUserSid(systemDirectory)
    if (!userSid) return false

    // Only the root here: it is one directory, so this stays in the milliseconds
    // on an empty or already-secured folder. The one-time child sweep handles
    // pre-existing content after the window is up.
    for (const args of windowsUserDataAclCommands(target, userSid)) {
      execFileSync(icacls, args, { stdio: 'ignore', windowsHide: true })
    }
    userDataAclChanged = true
    try {
      if (/^[a-f\d]{64}$/i.test(readFileSync(marker, 'utf8').trim())) unlinkSync(marker)
    } catch {
      /* No legacy marker to remove. */
    }
    return true
  } catch {
    return false
  }
}

/**
 * Run the one-time child ACL pass without holding up the window.
 *
 * Two things make this safe for the UI. It is scheduled after start, so the
 * first paint, the session list and the first Pi process are already up; and it
 * runs `execFile` rather than `execFileSync`, because that pass takes a minute on
 * a folder holding tens of thousands of cache files and a synchronous child
 * would block the main process — which is exactly how the window ended up
 * invisible for a minute with the app apparently not starting.
 *
 * Everything it does is idempotent, so an interrupted pass simply runs again on
 * the next launch.
 */
export function scheduleUserDataAclSweep(directory: string, delayMs = 6_000): void {
  if (process.platform !== 'win32') return
  const target = path.resolve(directory)
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) return
  const timer = setTimeout(() => {
    void runUserDataAclSweep(target, path.join(systemRoot, 'System32')).catch(() => {
      /* A failed sweep is retried on the next launch. */
    })
  }, delayMs)
  timer.unref?.()
}

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 10 * 60_000 }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function runUserDataAclSweep(target: string, systemDirectory: string): Promise<void> {
  const userSid = windowsUserSid(systemDirectory)
  if (!userSid) return
  if (readdirSync(target).length === 0) return
  if (aclChildrenSecured(target, userSid)) return
  const icacls = path.join(systemDirectory, 'icacls.exe')
  for (const args of windowsUserDataChildAclCommands(target)) {
    await execFileAsync(icacls, args)
  }
  markAclChildrenSecured(target, userSid)
}

/**
 * Guard the two settings that are not just preferences but capabilities.
 *
 * `externalChatFolder` roots session discovery: it is the containment root the
 * session handlers resolve renderer-supplied paths against. A filesystem root
 * there would make every `.jsonl` on the drive a valid conversation, which is
 * exactly what that check exists to prevent. `piPath` decides which executable
 * is spawned as the agent. The renderer is the app and may legitimately choose
 * either, but the main process is the last place that can refuse a value that is
 * not even a path — or a root — instead of trusting it.
 */
function assertSafeSettingsPatch(patch: Partial<AppSettings>): void {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new TypeError('settings:patch expects an object')
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'externalChatFolder')) {
    const folder = typeof patch.externalChatFolder === 'string' ? patch.externalChatFolder.trim() : ''
    if (folder) {
      if (!path.isAbsolute(folder)) {
        throw new Error(`The chat folder must be an absolute path: ${folder}`)
      }
      const resolved = path.resolve(folder)
      if (path.dirname(resolved) === resolved) {
        throw new Error('The chat folder cannot be a filesystem root.')
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'piPath')) {
    const cli = typeof patch.piPath === 'string' ? patch.piPath.trim() : ''
    if (cli && !path.isAbsolute(cli)) {
      throw new Error(`The Pi CLI path must be an absolute path: ${cli}`)
    }
  }
}

/**
 * Tiny JSON-file settings store in the Electron userData directory.
 * Writes are atomic (temp file + rename) so a crash cannot corrupt the file.
 */
export class SettingsStore {
  private readonly file: string
  private data: AppSettings
  private projectTrustReviewed = false
  private fileVersion: string | undefined
  private dirEnsured = false
  private piDefaultSync: Promise<void> = Promise.resolve()
  // Persisted with settings so other app processes share the same removals.
  private readonly removedWorkspaceIds = new Set<string>()

  constructor(fileName = 'settings.json') {
    this.file = path.join(app.getPath('userData'), fileName)
    this.data = { ...DEFAULT_SETTINGS }
    this.refreshFromDisk()
  }

  private read(parsed: PersistedAppSettings | null): AppSettings {
    if (!parsed) return { ...DEFAULT_SETTINGS }
    const saved = { ...parsed }
    delete saved.projectTrustReviewed
    delete saved.removedWorkspaceIds
    const optionalString = (value: unknown): string | undefined =>
      typeof value === 'string' ? value : undefined
    // A theme preset stores the colours it wrote. The palettes were
    // de-duplicated (ChatGPT and Claude shared an accent; Pi and GitHub shared
    // the pure-white canvas), so a saved preset's colours are moved onto the
    // current palette — unless the user had changed one of them.
    const themed = migratePresetColors({
      themePreset: optionalString(saved.themePreset),
      accentColor: optionalString(saved.accentColor),
      customBg: optionalString(saved.customBg),
      customFg: normalizeThemeForeground(saved)
    })
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      piPath: optionalString(saved.piPath),
      model: optionalString(saved.model),
      provider: optionalString(saved.provider),
      thinkingLevel: optionalString(saved.thinkingLevel),
      customInstructions: optionalString(saved.customInstructions),
      memoryModel: optionalString(saved.memoryModel),
      externalChatFolder: optionalString(saved.externalChatFolder),
      subagentModel: optionalString(saved.subagentModel),
      subagentProvider: optionalString(saved.subagentProvider),
      subagentThinking: optionalString(saved.subagentThinking),
      trustProject: this.projectTrustReviewed && saved.trustProject === true,
      fontScale: normalizeFontScale(saved.fontScale),
      fontFamily: normalizeFontFamily(saved.fontFamily),
      accentColor: themed.accentColor,
      customBg: themed.customBg,
      customFg: themed.customFg,
      // A dismissed release is a plain version string, or nothing.
      dismissedUpdateVersion: optionalString(saved.dismissedUpdateVersion),
      workspaces: dedupeWorkspaces(saved.workspaces),
      projectOrder: normalizeProjectOrder(saved.projectOrder),
      externalChatFolderHistory: normalizeExternalChatFolderHistory(
        saved.externalChatFolderHistory,
        saved.externalChatFolder
      ),
      pinnedSessions: normalizePathList(saved.pinnedSessions),
      archivedSessions: normalizePathList(saved.archivedSessions),
      hiddenProjects: normalizePathList(saved.hiddenProjects),
      sidebarGroupBy: normalizeChoice<SidebarGroupBy>(saved.sidebarGroupBy, SIDEBAR_GROUP_MODES, 'workspace'),
      sidebarSortBy: normalizeChoice<SidebarSortBy>(saved.sidebarSortBy, SIDEBAR_SORT_MODES, 'manual'),
      sidebarArchiveFilter: normalizeChoice<SidebarArchiveFilter>(saved.sidebarArchiveFilter, SIDEBAR_ARCHIVE_FILTERS, 'hidden'),
      urlOpenTarget: normalizeChoice(saved.urlOpenTarget, URL_OPEN_TARGETS, 'external'),
      shortcutBindings: normalizeShortcutBindings(saved.shortcutBindings)
    }
  }

  get(): AppSettings {
    this.refreshFromDisk()
    return this.getCached()
  }

  /** Read the in-process snapshot from hot paths that may run for every stream event. */
  getCached(): AppSettings {
    return {
      ...this.data,
      workspaces: [...this.data.workspaces],
      externalChatFolderHistory: [...(this.data.externalChatFolderHistory ?? [])]
    }
  }

  /** Refresh the registry when another app process changes settings, then reuse its cached snapshot. */
  getRegisteredWorkspaces(): Workspace[] {
    return this.get().workspaces
  }

  patch(patch: Partial<AppSettings>, baseline?: SettingsPatchBaseline): AppSettings {
    assertSafeSettingsPatch(patch)
    const patchBaseline = { ...this.data, ...baseline }
    const updated = this.update((current) => {
      const { externalChatFolderHistory: _ignoredHistory, ...requested } = patch
      if (!Object.prototype.hasOwnProperty.call(patch, 'externalChatFolder')) return requested

      const nextFolder = requested.externalChatFolder?.trim()
      const currentFolder = current.externalChatFolder?.trim()
      const history = [...(current.externalChatFolderHistory ?? [])]
      if (
        currentFolder &&
        (!nextFolder || workspaceKey(currentFolder) !== workspaceKey(nextFolder))
      ) history.push(currentFolder)

      return {
        ...requested,
        externalChatFolderHistory: normalizeExternalChatFolderHistory(history, nextFolder)
      }
    }, { baseline: patchBaseline })
    // Pi reads its startup defaults from the agent directory. Read the latest
    // saved choices under the Pi settings lock so a delayed sync cannot undo
    // a newer write from another desktop process.
    const hasModel = 'model' in patch
    const hasThinking = 'thinkingLevel' in patch
    if (hasModel || hasThinking) {
      const sync = () => syncAgentDefaults(() => {
        const saved = readSettingsFile(this.file)
        if (!saved) return undefined
        return {
          ...(hasModel ? { model: saved.model } : {}),
          ...(hasThinking ? { thinkingLevel: saved.thinkingLevel } : {})
        }
      })
      this.piDefaultSync = this.piDefaultSync
        .then(sync, sync)
        .catch((error: unknown) => {
          console.error('[pi-desktop] could not sync Pi default settings:', error)
        })
    }
    return updated
  }

  waitForPiDefaults(): Promise<void> {
    return this.piDefaultSync
  }

  addWorkspace(workspace: Workspace, activate = true): AppSettings {
    return this.update((current) => {
      const key = workspaceKey(workspace.path)
      const existing = current.workspaces.find((item) => workspaceKey(item.path) === key)
      // Opening a folder that is already listed must leave it where the user
      // put it. Only a folder that has never been added moves.
      if (existing) return activate ? { activeWorkspaceId: existing.id } : {}
      return {
        workspaces: [...current.workspaces, {
          ...workspace,
          createdAt: workspace.createdAt ?? workspace.lastOpenedAt ?? Date.now()
        }],
        // …and it moves to the first row: the newest folder is what the reader
        // just asked for, and appending it put it below every existing project
        // as if the add had been ignored. Everything else keeps its order.
        projectOrder: withNewProjectFirst(current.projectOrder ?? [], workspace.path, workspaceKey),
        ...(activate ? { activeWorkspaceId: workspace.id } : {})
      }
    })
  }

  removeWorkspace(id: string | undefined, hidePath?: string): AppSettings {
    return this.update((current) => {
      const workspaces = id
        ? current.workspaces.filter((workspace) => workspace.id !== id)
        : current.workspaces
      const activeWorkspaceId = id && current.activeWorkspaceId === id
        ? workspaces[0]?.id
        : current.activeWorkspaceId
      const hiddenProjects = [...(current.hiddenProjects ?? [])]
      if (hidePath) {
        const key = workspaceKey(hidePath)
        // Another instance may have registered this path with a new id.
        if (!workspaces.some((item) => workspaceKey(item.path) === key) &&
            !hiddenProjects.some((item) => workspaceKey(item) === key)) {
          hiddenProjects.push(hidePath)
        }
      }
      return {
        workspaces,
        activeWorkspaceId,
        ...(hidePath ? { hiddenProjects } : {})
      }
    }, { removedWorkspaceId: id })
  }

  private refreshFromDisk(forWrite = false): boolean {
    let version = settingsFileVersion(this.file)
    if (!forWrite && version === this.fileVersion) return false
    let parsed: ReturnType<typeof readSettingsFile>
    try {
      parsed = readSettingsFile(this.file)
    } catch (error) {
      // Keep reads available with defaults, but recheck the file next time.
      // A save must have a verified base before it can replace the file.
      if (forWrite) throw error
      version = undefined
    }
    this.projectTrustReviewed = parsed?.projectTrustReviewed === true
    this.removedWorkspaceIds.clear()
    for (const id of Array.isArray(parsed?.removedWorkspaceIds) ? parsed.removedWorkspaceIds : []) {
      if (typeof id === 'string') this.removedWorkspaceIds.add(id)
    }
    this.data = this.read(parsed ?? null)
    this.fileVersion = version
    return parsed === null
  }

  /**
   * Wait for another process to release the settings lock, without blocking.
   *
   * `lockSync` cannot retry — proper-lockfile refuses retries on its sync API —
   * so `withSettingsLock` spins on `Atomics.wait` between attempts. That spin is
   * right for the microseconds a writer normally holds the lock, but a second
   * instance (a harness run, or a crashed one whose lock file has not gone stale
   * yet) can hold it for seconds, and blocking the main thread that long freezes
   * the window. Callers that can be async wait here first; the sync spin is then
   * left to cover only the race between this poll and the write itself.
   */
  async waitForLock(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    for (;;) {
      let locked = false
      try {
        locked = await properLockfile.check(this.file, { realpath: false })
      } catch {
        // No settings file yet, or its folder is gone: nothing holds the lock.
        return
      }
      if (!locked) return
      if (Date.now() >= deadline) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  private withSettingsLock<T>(action: () => T): T {
    if (!this.dirEnsured) {
      mkdirSync(path.dirname(this.file), { recursive: true })
      this.dirEnsured = true
    }
    let release: () => void
    for (let attempt = 0; ; attempt += 1) {
      try {
        release = properLockfile.lockSync(this.file, { realpath: false, retries: 0 })
        break
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code)
          : undefined
        if (code === 'ENOENT') {
          this.dirEnsured = false
          mkdirSync(path.dirname(this.file), { recursive: true })
          this.dirEnsured = true
          continue
        }
        // The attempts are bounded because this path blocks the main thread: a
        // long-lived holder is waited out asynchronously in `waitForLock`, and
        // an in-process write holds the lock for well under a millisecond.
        if (code !== 'ELOCKED' || attempt >= 10) throw error
        // Progressive short backoff avoids a full 10ms stall on brief lock contention.
        const waitMs = attempt < 3 ? 2 : attempt < 8 ? 5 : 10
        Atomics.wait(settingsLockWait, 0, 0, waitMs)
      }
    }
    try {
      return action()
    } finally {
      release()
    }
  }

  private update(
    patchFor: (current: AppSettings) => Partial<AppSettings>,
    options: { baseline?: AppSettings; removedWorkspaceId?: string } = {}
  ): AppSettings {
    this.withSettingsLock(() => {
      // Another app process can update settings while this instance is open.
      // Merge under the lock so independent changes do not overwrite each other.
      const preserveInvalidFile = this.refreshFromDisk(true)
      const current = this.data
      // Workspace commands derive their patch from the settings read under the lock.
      const baseline = options.baseline ?? current
      const patch = patchFor(current)
      const shortcutPatch = normalizeShortcutBindings(patch.shortcutBindings)
      const resetShortcuts = patch.shortcutBindings !== null &&
        typeof patch.shortcutBindings === 'object' && !Array.isArray(patch.shortcutBindings) &&
        Object.keys(patch.shortcutBindings).length === 0
      const blockedWorkspaceIds = new Set(this.removedWorkspaceIds)
      if (options.removedWorkspaceId) blockedWorkspaceIds.add(options.removedWorkspaceId)
      const workspaces = patch.workspaces === undefined
        ? current.workspaces
        : mergeWorkspaces(
            baseline.workspaces,
            patch.workspaces,
            current.workspaces,
            blockedWorkspaceIds
          )
      const currentActiveWorkspaceId = current.activeWorkspaceId ?? null
      const requestedActiveWorkspaceId = patch.activeWorkspaceId === undefined
        ? currentActiveWorkspaceId
        : patch.activeWorkspaceId
      const isActiveWorkspaceId = (id: string | null) =>
        id === null || workspaces.some((workspace) => workspace.id === id)
      const activeWorkspaceId = isActiveWorkspaceId(requestedActiveWorkspaceId)
        ? requestedActiveWorkspaceId
        : isActiveWorkspaceId(currentActiveWorkspaceId)
          ? currentActiveWorkspaceId
          : workspaces[0]?.id ?? null
      const projectTrustReviewed = this.projectTrustReviewed || 'trustProject' in patch
      const next: AppSettings = {
        ...current,
        ...patch,
        activeWorkspaceId,
        externalChatFolderHistory: patch.externalChatFolderHistory === undefined
          ? current.externalChatFolderHistory
          : normalizeExternalChatFolderHistory(
              patch.externalChatFolderHistory,
              patch.externalChatFolder ?? current.externalChatFolder
            ),
        trustProject: 'trustProject' in patch ? patch.trustProject === true : current.trustProject,
        workspaces,
        projectOrder: patch.projectOrder === undefined
          ? current.projectOrder
          : mergeProjectOrder(
              baseline.projectOrder ?? [],
              patch.projectOrder,
              current.projectOrder ?? []
            ),
        pinnedSessions: patch.pinnedSessions === undefined
          ? current.pinnedSessions
          : mergeStringSet(
              baseline.pinnedSessions ?? [],
              normalizePathList(patch.pinnedSessions),
              current.pinnedSessions ?? []
            ),
        archivedSessions: patch.archivedSessions === undefined
          ? current.archivedSessions
          : mergeStringSet(
              baseline.archivedSessions ?? [],
              normalizePathList(patch.archivedSessions),
              current.archivedSessions ?? []
            ),
        hiddenProjects: patch.hiddenProjects === undefined
          ? current.hiddenProjects
          : mergeStringSet(
              baseline.hiddenProjects ?? [],
              normalizePathList(patch.hiddenProjects),
              current.hiddenProjects ?? []
            ),
        lastSessions: patch.lastSessions === undefined
          ? current.lastSessions
          : mergeRecord(baseline.lastSessions ?? {}, patch.lastSessions, current.lastSessions ?? {}),
        shortcutBindings: shortcutPatch === undefined && !resetShortcuts
          ? current.shortcutBindings
          : normalizeShortcutBindings(
              mergeRecord(
                baseline.shortcutBindings ?? {},
                shortcutPatch ?? {},
                current.shortcutBindings ?? {}
              )
            )
      }
      this.write(next, projectTrustReviewed, blockedWorkspaceIds, preserveInvalidFile)
      this.data = next
      this.projectTrustReviewed = projectTrustReviewed
      this.removedWorkspaceIds.clear()
      for (const id of blockedWorkspaceIds) this.removedWorkspaceIds.add(id)
      this.fileVersion = settingsFileVersion(this.file)
    })
    return this.getCached()
  }

  private write(
    data: AppSettings,
    projectTrustReviewed: boolean,
    removedWorkspaceIds: ReadonlySet<string>,
    preserveInvalidFile: boolean
  ): void {
    const tmp = `${this.file}.${randomUUID()}.tmp`
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      if (preserveInvalidFile) {
        const recoveryFile = `${this.file}.corrupt-${Date.now()}-${randomUUID()}`
        copyFileSync(this.file, recoveryFile)
        console.error(`[pi-desktop] invalid settings were preserved at ${recoveryFile}`)
      }
      writeFileSync(tmp, JSON.stringify({
        ...data,
        projectTrustReviewed,
        ...(removedWorkspaceIds.size ? { removedWorkspaceIds: [...removedWorkspaceIds] } : {})
      }, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      console.error('[pi-desktop] failed to persist settings:', error)
      try {
        // The temporary file may not have been created.
        unlinkSync(tmp)
      } catch {
        /* best-effort cleanup */
      }
      throw error
    }
  }
}
