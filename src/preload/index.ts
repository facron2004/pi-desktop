import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppInfo,
  AppSettings,
  AuthStatus,
  PiDesktopBridge,
  PiEvent,
  RuntimeStartOptions,
  RuntimeStatus,
  SessionMeta,
  Workspace
} from '@shared/types'

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const bridge: PiDesktopBridge = {
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info')
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    patch: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:patch', patch)
  },
  workspaces: {
    pick: (): Promise<Workspace | null> => ipcRenderer.invoke('workspaces:pick'),
    remove: (id: string): Promise<AppSettings> => ipcRenderer.invoke('workspaces:remove', id)
  },
  sessions: {
    list: (cwd?: string): Promise<SessionMeta[]> => ipcRenderer.invoke('sessions:list', cwd),
    reveal: (file: string): Promise<void> => ipcRenderer.invoke('sessions:reveal', file)
  },
  runtime: {
    start: (options: RuntimeStartOptions) => ipcRenderer.invoke('runtime:start', options),
    stop: (): Promise<void> => ipcRenderer.invoke('runtime:stop'),
    request: <T = unknown>(
      command: string,
      payload?: Record<string, unknown>,
      timeoutMs?: number
    ): Promise<T> => ipcRenderer.invoke('runtime:request', command, payload ?? {}, timeoutMs),
    onEvent: (handler: (event: PiEvent) => void) => subscribe<PiEvent>('runtime:event', handler),
    onStatus: (handler: (status: RuntimeStatus) => void) =>
      subscribe<RuntimeStatus>('runtime:status', handler)
  },
  auth: {
    check: (provider?: string): Promise<AuthStatus> => ipcRenderer.invoke('auth:check', provider)
  },
  shell: {
    openPath: (target: string): Promise<string> => ipcRenderer.invoke('shell:openPath', target),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url)
  }
}

contextBridge.exposeInMainWorld('pi', bridge)

// Development aid: the main process can prefill the composer so screenshots
// can capture transient UI such as the command palette. The flag only exists
// when PI_DESKTOP_PREFILL is set.
const prefillArg = process.argv.find((argument) =>
  argument.startsWith('--pi-desktop-prefill=')
)
if (prefillArg) {
  contextBridge.exposeInMainWorld('__piDesktopDev', {
    prefill: prefillArg.slice('--pi-desktop-prefill='.length)
  })
}
