import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type {
  AppInfo,
  AppSettings,
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

function workspaceName(dir: string): string {
  const base = path.basename(dir)
  return base || dir
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
      sessionRoot: resolveSessionRoot()
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

/** Forward runtime traffic to the renderer window. */
export function bridgeRuntime(context: IpcContext): void {
  const { runtime, getWindow } = context
  runtime.on('event', (event: PiEvent) => {
    getWindow()?.webContents.send('runtime:event', event)
  })
  runtime.on('status', (status: RuntimeStatus) => {
    getWindow()?.webContents.send('runtime:status', status)
  })
  runtime.on('stderr', (line: string) => {
    getWindow()?.webContents.send('runtime:stderr', line)
  })
}
