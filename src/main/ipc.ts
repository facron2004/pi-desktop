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

  ipcMain.handle('app:setTheme', (_event, theme: 'dark' | 'light') => {
    const window = getWindow()
    if (!window || window.isDestroyed() || process.platform === 'darwin') return
    try {
      // Keep the native window controls in step with the app chrome.
      window.setTitleBarOverlay(
        theme === 'light'
          ? { color: '#f6f7f9', symbolColor: '#5c6573', height: 44 }
          : { color: '#0b0d10', symbolColor: '#8a93a3', height: 44 }
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

  ipcMain.handle('sessions:list', (_event, cwd?: string) => listSessions(cwd))

  ipcMain.handle('sessions:reveal', async (_event, file: string) => {
    shell.showItemInFolder(file)
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
