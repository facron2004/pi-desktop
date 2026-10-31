import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AppSettings, Workspace } from '@shared/types'
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
  drawerWidth: 420,
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
  followUpMode: 'steer'
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
    try {
      if (!existsSync(this.file)) return { ...DEFAULT_SETTINGS }
      const raw = readFileSync(this.file, 'utf8')
      // Windows editors happily add a byte order mark, and JSON.parse
      // rejects it. Without this the whole file would be discarded and the
      // user would lose every workspace they had opened.
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as Partial<AppSettings>
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        workspaces: dedupeWorkspaces(Array.isArray(parsed.workspaces) ? parsed.workspaces : []),
        pinnedSessions: Array.isArray(parsed.pinnedSessions) ? parsed.pinnedSessions : []
      }
    } catch {
      return { ...DEFAULT_SETTINGS }
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
    const workspaces = this.data.workspaces.filter((item) => workspaceKey(item.path) !== key)
    workspaces.push(workspace)
    workspaces.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    return this.patch({ workspaces, activeWorkspaceId: workspace.id })
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
