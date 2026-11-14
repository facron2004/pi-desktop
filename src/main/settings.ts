import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AppSettings, Workspace } from '@shared/types'
import {
  DEFAULT_IMAGE_OUTPUT_DIR,
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_IMAGE_SIZE
} from '@shared/types'
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
 * The settings file as it sits on disk, or null when it is missing or
 * unreadable. Windows editors happily add a byte order mark and JSON.parse
 * rejects it, so the mark is stripped here: without this the whole file
 * would be discarded and the user would lose every workspace they opened.
 */
interface PersistedAppSettings extends Partial<AppSettings> {
  /** Marks a project-trust choice explicitly reviewed by the user. */
  projectTrustReviewed?: boolean
  /** Workspace removals that stale full-list patches must not undo. */
  removedWorkspaceIds?: string[]
}

function readSettingsFile(file: string): PersistedAppSettings | null {
  try {
    if (!existsSync(file)) return null
    const raw = readFileSync(file, 'utf8')
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
  const target = path.resolve(directory)
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) return false

  try {
    const systemDirectory = path.join(systemRoot, 'System32')
    const icacls = path.join(systemDirectory, 'icacls.exe')
    const marker = path.join(target, '.acl-secured-v1')
    const userOutput = execFileSync(path.join(systemDirectory, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    const userSid = parseWindowsUserSid(userOutput)
    if (!userSid) return false

    const hasChildren = readdirSync(target).length > 0
    const commands = windowsUserDataAclCommands(target, userSid, hasChildren)
    for (const args of commands) {
      execFileSync(icacls, args, { stdio: 'ignore', windowsHide: true })
    }
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
 * Tiny JSON-file settings store in the Electron userData directory.
 * Writes are atomic (temp file + rename) so a crash cannot corrupt the file.
 */
export class SettingsStore {
  private readonly file: string
  private data: AppSettings
  private projectTrustReviewed = false
  private fileVersion: string | undefined
  // Persisted with settings so other app processes share the same removals.
  private readonly removedWorkspaceIds = new Set<string>()

  constructor(fileName = 'settings.json') {
    this.file = path.join(app.getPath('userData'), fileName)
    this.data = { ...DEFAULT_SETTINGS }
    this.refreshFromDisk(true)
  }

  private read(parsed: PersistedAppSettings | null): AppSettings {
    if (!parsed) return { ...DEFAULT_SETTINGS }
    const saved = { ...parsed }
    delete saved.projectTrustReviewed
    delete saved.removedWorkspaceIds
    const optionalString = (value: unknown): string | undefined =>
      typeof value === 'string' ? value : undefined
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
      customFg: normalizeThemeForeground(saved),
      workspaces: dedupeWorkspaces(saved.workspaces),
      projectOrder: normalizeProjectOrder(saved.projectOrder),
      externalChatFolderHistory: normalizeExternalChatFolderHistory(
        saved.externalChatFolderHistory,
        saved.externalChatFolder
      ),
      pinnedSessions: normalizePathList(saved.pinnedSessions),
      archivedSessions: normalizePathList(saved.archivedSessions),
      hiddenProjects: normalizePathList(saved.hiddenProjects),
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

  patch(patch: Partial<AppSettings>): AppSettings {
    this.update((current) => {
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
    })
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
        workspaces: [...current.workspaces, {
          ...workspace,
          createdAt: workspace.createdAt ?? workspace.lastOpenedAt ?? Date.now()
        }],
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
    this.removedWorkspaceIds.clear()
    for (const id of Array.isArray(parsed?.removedWorkspaceIds) ? parsed.removedWorkspaceIds : []) {
      if (typeof id === 'string') this.removedWorkspaceIds.add(id)
    }
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
      const shortcutPatch = normalizeShortcutBindings(patch.shortcutBindings)
      const resetShortcuts = patch.shortcutBindings !== null &&
        typeof patch.shortcutBindings === 'object' && !Array.isArray(patch.shortcutBindings) &&
        Object.keys(patch.shortcutBindings).length === 0
      const blockedWorkspaceIds = new Set([...this.removedWorkspaceIds, ...removedWorkspaceIds])
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
      this.write(next, projectTrustReviewed, blockedWorkspaceIds)
      this.data = next
      this.projectTrustReviewed = projectTrustReviewed
      this.removedWorkspaceIds.clear()
      for (const id of blockedWorkspaceIds) this.removedWorkspaceIds.add(id)
      this.fileVersion = settingsFileVersion(this.file)
    })
    return this.get()
  }

  private write(
    data: AppSettings,
    projectTrustReviewed: boolean,
    removedWorkspaceIds: ReadonlySet<string>
  ): void {
    const tmp = `${this.file}.${randomUUID()}.tmp`
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      if (existsSync(this.file) && readSettingsFile(this.file) === null) {
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
