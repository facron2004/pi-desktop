import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AppSettings, Workspace } from '@shared/types'

const DEFAULT_SETTINGS: AppSettings = {
  workspaces: [],
  theme: 'dark',
  fontScale: 1,
  trustProject: true
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
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : []
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
      workspaces: patch.workspaces ?? this.data.workspaces
    }
    this.write()
    return this.get()
  }

  addWorkspace(workspace: Workspace): AppSettings {
    const workspaces = this.data.workspaces.filter((w) => w.path !== workspace.path)
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
