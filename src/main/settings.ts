import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AppSettings, Workspace } from '@shared/types'
import { normalizeFontScale } from '@shared/font-scale'
import { forgetDefaultModel, rememberDefaultModel, rememberDefaultThinkingLevel } from './pi/retry-policy'

/** Same folder, whatever slash style or drive-letter case it was opened with. */
function workspaceKey(value: string): string {
  return path.resolve(value).replace(/[/\\]+$/, '').toLowerCase()
}

/** One entry per folder. A later open of the same path replaces the earlier one. */
function dedupeWorkspaces(workspaces: Workspace[]): Workspace[] {
  const map = new Map<string, Workspace>()
  for (const item of workspaces) {
    if (!item?.path) continue
    const key = workspaceKey(item.path)
    const existing = map.get(key)
    if (!existing || (item.lastOpenedAt || 0) >= (existing.lastOpenedAt || 0)) {
      map.set(key, item)
    }
  }
  return [...map.values()].sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))
}

const DEFAULT_SETTINGS: AppSettings = {
  workspaces: [],
  pinnedSessions: [],
  theme: 'dark',
  language: 'en',
  fontScale: 1,
  diffSplit: false,
  drawerWidth: 520,
  trustProject: true,
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
function readSettingsFile(file: string): Partial<AppSettings> | null {
  try {
    if (!existsSync(file)) return null
    const raw = readFileSync(file, 'utf8')
    return JSON.parse(raw.replace(/^\uFEFF/, '')) as Partial<AppSettings>
  } catch {
    return null
  }
}

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

/**
 * Tiny JSON-file settings store in the Electron userData directory.
 * Writes are atomic (temp file + rename) so a crash cannot corrupt the file.
 */
export class SettingsStore {
  private readonly file: string
  private data: AppSettings

  constructor(fileName = 'settings.json') {
    this.file = path.join(app.getPath('userData'), fileName)
    this.data = this.read()
  }

  private read(): AppSettings {
    const parsed = readSettingsFile(this.file)
    if (!parsed) return { ...DEFAULT_SETTINGS }
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      fontScale: normalizeFontScale(parsed.fontScale),
      fontFamily: normalizeFontFamily(parsed.fontFamily),
      customFg: normalizeThemeForeground(parsed),
      workspaces: dedupeWorkspaces(Array.isArray(parsed.workspaces) ? parsed.workspaces : []),
      pinnedSessions: Array.isArray(parsed.pinnedSessions) ? parsed.pinnedSessions : []
    }
  }

  get(): AppSettings {
    return { ...this.data, workspaces: [...this.data.workspaces] }
  }

  patch(patch: Partial<AppSettings>): AppSettings {
    this.data = {
      ...this.data,
      ...patch,
      workspaces: dedupeWorkspaces(patch.workspaces ?? this.data.workspaces)
    }
    this.write()
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
    const key = workspaceKey(workspace.path)
    const index = this.data.workspaces.findIndex((item) => workspaceKey(item.path) === key)
    // Opening a folder that is already listed must leave it where the user
    // put it. Only a folder that has never been added goes on the end.
    if (index >= 0) {
      const current = this.data.workspaces[index]
      return this.patch({ activeWorkspaceId: current.id })
    }
    return this.patch({
      workspaces: [...this.data.workspaces, workspace],
      activeWorkspaceId: workspace.id
    })
  }

  removeWorkspace(id: string): AppSettings {
    const workspaces = this.data.workspaces.filter((w) => w.id !== id)
    const activeWorkspaceId =
      this.data.activeWorkspaceId === id ? workspaces[0]?.id : this.data.activeWorkspaceId
    return this.patch({ workspaces, activeWorkspaceId })
  }

  private write(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      console.error('[pi-desktop] failed to persist settings:', error)
    }
  }
}
