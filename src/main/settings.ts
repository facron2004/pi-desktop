import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AppSettings, Workspace } from '@shared/types'
import { normalizeFontScale } from '@shared/font-scale'
import { forgetDefaultModel, rememberDefaultModel, rememberDefaultThinkingLevel } from './pi/retry-policy'
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

/** One entry per folder. A later open of the same path replaces the earlier one.
 *
 * The array order is the sidebar order, and only an explicit drag may change
 * it. `lastOpenedAt` records activity for other readers; it must never sort
 * this list — opening a project used to pull it to the top on every settings
 * write and undo the order the user dragged.
 */
export function dedupeWorkspaces(workspaces: Workspace[]): Workspace[] {
  const map = new Map<string, Workspace>()
  for (const item of workspaces) {
    if (!item?.path) continue
    const key = workspaceKey(item.path)
    const existing = map.get(key)
    if (!existing || (item.lastOpenedAt || 0) >= (existing.lastOpenedAt || 0)) {
      // `Map.set` on an existing key keeps its original position, so replacing
      // the newer duplicate does not move the project.
      map.set(key, item)
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
  for (const workspace of proposed) {
    if (baselineById.has(workspace.id) || currentById.has(workspace.id)) {
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
  const addedSinceRead = current.filter((item) =>
    !baselineKeys.has(workspaceKey(item)) && !proposedKeys.has(workspaceKey(item))
  )
  return normalizeProjectOrder([...proposed, ...addedSinceRead])
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

const DEFAULT_SETTINGS: AppSettings = {
  workspaces: [],
  projectOrder: [],
  pinnedSessions: [],
  archivedSessions: [],
  theme: 'dark',
  language: 'en',
  fontScale: 1,
  diffSplit: false,
  drawerWidth: 520,
  trustProject: false,
  permissionMode: 'ask',
  desktopNotifications: true,
  defaultFileOpener: 'vscode',
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
  toolCallSummary: false,
  autoTitle: false,
  automaticUpdates: false,
  trayPersistent: false,
  memoriesEnabled: true,
  memoryGeneration: true,
  memorySkipExternalContext: true
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
 * The settings file as it sits on disk, or null when it is missing or
 * unreadable. Windows editors happily add a byte order mark and JSON.parse
 * rejects it, so the mark is stripped here: without this the whole file
 * would be discarded and the user would lose every workspace they opened.
 */
interface PersistedAppSettings extends Partial<AppSettings> {
  /** Marks a project-trust choice explicitly reviewed by the user. */
  projectTrustReviewed?: boolean
}

function readSettingsFile(file: string): PersistedAppSettings | null {
  try {
    if (!existsSync(file)) return null
    const raw = readFileSync(file, 'utf8')
    return JSON.parse(raw.replace(/^\uFEFF/, '')) as PersistedAppSettings
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

/**
 * One persisted flag, read before the store exists.
 *
 * The tray takes the single-instance lock before the app is ready, and the
 * store is built in `start`, so this is the one early reader of the file.
 */
export function readPersistedFlag(key: 'trayPersistent'): boolean {
  const file = path.join(app.getPath('userData'), 'settings.json')
  return readSettingsFile(file)?.[key] === true
}

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

/** Build the ordered ACL operations for the user-data root and its contents. */
export function windowsUserDataAclCommands(
  directory: string,
  userSid: string,
  hasChildren: boolean
): string[][] {
  const allowed = [
    `*${userSid}:(OI)(CI)F`,
    '*S-1-5-18:(OI)(CI)F',
    '*S-1-5-32-544:(OI)(CI)F'
  ]
  return [
    [directory, '/reset', '/Q', '/L'],
    [directory, '/inheritance:r', '/Q', '/L'],
    [directory, '/grant:r', ...allowed, '/Q', '/L'],
    ...(hasChildren ? [[path.win32.join(directory, '*'), '/reset', '/T', '/C', '/L', '/Q']] : [])
  ]
}

function secureWindowsUserDataDirectory(directory: string): boolean {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) return false
  const target = path.resolve(directory)

  try {
    const systemDirectory = path.join(systemRoot, 'System32')
    const userOutput = execFileSync(path.join(systemDirectory, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    const userSid = parseWindowsUserSid(userOutput)
    if (!userSid) return false

    const hasChildren = readdirSync(target).length > 0
    const commands = windowsUserDataAclCommands(target, userSid, hasChildren)
    const icacls = path.join(systemDirectory, 'icacls.exe')
    for (const args of commands) {
      execFileSync(icacls, args, { stdio: 'ignore', windowsHide: true })
    }
    return true
  } catch {
    return false
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

  constructor(fileName = 'settings.json') {
    this.file = path.join(app.getPath('userData'), fileName)
    this.data = { ...DEFAULT_SETTINGS }
    this.refreshFromDisk(true)
  }

  private read(parsed: PersistedAppSettings | null): AppSettings {
    if (!parsed) return { ...DEFAULT_SETTINGS }
    const saved = { ...parsed }
    delete saved.projectTrustReviewed
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      trustProject: this.projectTrustReviewed && saved.trustProject === true,
      fontScale: normalizeFontScale(saved.fontScale),
      fontFamily: normalizeFontFamily(saved.fontFamily),
      customFg: normalizeThemeForeground(saved),
      workspaces: dedupeWorkspaces(Array.isArray(saved.workspaces) ? saved.workspaces : []),
      projectOrder: normalizeProjectOrder(saved.projectOrder),
      pinnedSessions: Array.isArray(saved.pinnedSessions) ? saved.pinnedSessions : [],
      archivedSessions: Array.isArray(saved.archivedSessions) ? saved.archivedSessions : []
    }
  }

  get(): AppSettings {
    this.refreshFromDisk()
    return this.getCached()
  }

  /** Read the in-process snapshot from hot paths that may run for every stream event. */
  getCached(): AppSettings {
    return { ...this.data, workspaces: [...this.data.workspaces] }
  }

  /** Read the persisted registry so remote authorization sees other app processes' edits. */
  getRegisteredWorkspaces(): Workspace[] {
    const workspaces = readSettingsFile(this.file)?.workspaces
    if (!Array.isArray(workspaces)) return []
    return dedupeWorkspaces(workspaces.filter((workspace): workspace is Workspace =>
      typeof workspace?.id === 'string' &&
      typeof workspace.path === 'string' &&
      typeof workspace.name === 'string'
    ))
  }

  patch(patch: Partial<AppSettings>): AppSettings {
    this.update(() => patch)
    // Pi reads its own startup model from the agent directory, not from this
    // file. A selection that never lands there is gone on the next launch.
    if ('model' in patch) {
      if (this.data.model) rememberDefaultModel(this.data.model)
      else forgetDefaultModel()
    }
    if ('thinkingLevel' in patch && this.data.thinkingLevel) {
      rememberDefaultThinkingLevel(this.data.thinkingLevel)
    }
    return this.get()
  }

  addWorkspace(workspace: Workspace): AppSettings {
    return this.update((current) => {
      const key = workspaceKey(workspace.path)
      const existing = current.workspaces.find((item) => workspaceKey(item.path) === key)
      // Opening a folder that is already listed must leave it where the user
      // put it. Only a folder that has never been added goes on the end.
      if (existing) return { activeWorkspaceId: existing.id }
      return {
        workspaces: [...current.workspaces, workspace],
        activeWorkspaceId: workspace.id
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
      if (hidePath && !hiddenProjects.some((item) => workspaceKey(item) === workspaceKey(hidePath))) {
        hiddenProjects.push(hidePath)
      }
      return {
        workspaces,
        activeWorkspaceId,
        ...(hidePath ? { hiddenProjects } : {})
      }
    }, id ? new Set([id]) : new Set())
  }

  private refreshFromDisk(force = false): void {
    const version = settingsFileVersion(this.file)
    if (!force && version === this.fileVersion) return
    const parsed = readSettingsFile(this.file)
    this.projectTrustReviewed = parsed?.projectTrustReviewed === true
    this.data = this.read(parsed)
    this.fileVersion = version
  }

  private withSettingsLock<T>(action: () => T): T {
    mkdirSync(path.dirname(this.file), { recursive: true })
    let release: () => void
    for (let attempt = 0; ; attempt += 1) {
      try {
        release = properLockfile.lockSync(this.file, { realpath: false, retries: 0 })
        break
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code)
          : undefined
        if (code !== 'ELOCKED' || attempt >= 49) throw error
        Atomics.wait(settingsLockWait, 0, 0, 10)
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
    removedWorkspaceIds: ReadonlySet<string> = new Set()
  ): AppSettings {
    this.withSettingsLock(() => {
      // Another app process can update settings while this instance is open.
      // Merge under the lock so independent changes do not overwrite each other.
      const baseline = this.data
      this.refreshFromDisk(true)
      const current = this.data
      const patch = patchFor(current)
      const projectTrustReviewed = this.projectTrustReviewed || 'trustProject' in patch
      const next: AppSettings = {
        ...current,
        ...patch,
        trustProject: 'trustProject' in patch ? patch.trustProject === true : current.trustProject,
        workspaces: patch.workspaces === undefined
          ? current.workspaces
          : mergeWorkspaces(baseline.workspaces, patch.workspaces, current.workspaces, removedWorkspaceIds),
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
              patch.pinnedSessions,
              current.pinnedSessions ?? []
            ),
        archivedSessions: patch.archivedSessions === undefined
          ? current.archivedSessions
          : mergeStringSet(
              baseline.archivedSessions ?? [],
              patch.archivedSessions,
              current.archivedSessions ?? []
            ),
        hiddenProjects: patch.hiddenProjects === undefined
          ? current.hiddenProjects
          : mergeStringSet(
              baseline.hiddenProjects ?? [],
              patch.hiddenProjects,
              current.hiddenProjects ?? []
            ),
        lastSessions: patch.lastSessions === undefined
          ? current.lastSessions
          : mergeRecord(baseline.lastSessions ?? {}, patch.lastSessions, current.lastSessions ?? {}),
        shortcutBindings: patch.shortcutBindings === undefined
          ? current.shortcutBindings
          : mergeRecord(
              baseline.shortcutBindings ?? {},
              patch.shortcutBindings,
              current.shortcutBindings ?? {}
            )
      }
      this.write(next, projectTrustReviewed)
      this.data = next
      this.projectTrustReviewed = projectTrustReviewed
      this.fileVersion = settingsFileVersion(this.file)
    })
    return this.get()
  }

  private write(data: AppSettings, projectTrustReviewed: boolean): void {
    const tmp = `${this.file}.${randomUUID()}.tmp`
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileSync(tmp, JSON.stringify({ ...data, projectTrustReviewed }, null, 2), 'utf8')
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
