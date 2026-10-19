import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppInfo,
  AppSettings,
  AuthStatus,
  ExtensionUiResponse,
  FileContent,
  FileEntry,
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
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
    setTheme: (theme: 'dark' | 'light'): Promise<void> => ipcRenderer.invoke('app:setTheme', theme)
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
    reveal: (file: string): Promise<void> => ipcRenderer.invoke('sessions:reveal', file),
    remove: (file: string): Promise<boolean> => ipcRenderer.invoke('sessions:remove', file)
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
      subscribe<RuntimeStatus>('runtime:status', handler),
    respondUi: (id: string, response: ExtensionUiResponse): Promise<void> =>
      ipcRenderer.invoke('runtime:respondUi', id, response)
  },
  auth: {
    check: (provider?: string): Promise<AuthStatus> => ipcRenderer.invoke('auth:check', provider)
  },
  shell: {
    openPath: (target: string): Promise<string> => ipcRenderer.invoke('shell:openPath', target),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url)
  },
  fs: {
    list: (dir: string): Promise<FileEntry[]> => ipcRenderer.invoke('fs:list', dir),
    read: (file: string): Promise<FileContent | null> => ipcRenderer.invoke('fs:read', file)
  }
}

contextBridge.exposeInMainWorld('pi', bridge)

// Development aid: the main process can prefill the composer or open a panel
// so screenshots can capture transient UI. The flags only exist when the
// corresponding environment variables are set.
const prefillArg = process.argv.find((argument) =>
  argument.startsWith('--pi-desktop-prefill=')
)
const openChanges = process.argv.includes('--pi-desktop-open-changes')
const openFiles = process.argv.includes('--pi-desktop-open-files')
const exportFlag = process.argv.includes('--pi-desktop-export')
if (prefillArg || openChanges || openFiles || exportFlag) {
  contextBridge.exposeInMainWorld('__piDesktopDev', {
    prefill: prefillArg ? prefillArg.slice('--pi-desktop-prefill='.length) : undefined,
    openChanges,
    openFiles,
    export: exportFlag
  })
}
