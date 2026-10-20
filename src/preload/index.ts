import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppInfo,
  AppSettings,
  AuthStatus,
  ExtensionUiResponse,
  FileContent,
  FileEntry,
  GitCommit,
  GitCommitResult,
  GitFileDiff,
  GitPatch,
  GitStatus,
  PiDesktopBridge,
  PiEvent,
  RuntimeStartOptions,
  RuntimeStatus,
  SessionMeta,
  SessionSearchHit,
  TextSearchHit,
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
    remove: (id: string): Promise<AppSettings> => ipcRenderer.invoke('workspaces:remove', id),
    add: (path: string): Promise<{ workspace: Workspace; settings: AppSettings }> =>
      ipcRenderer.invoke('workspaces:add', path)
  },
  sessions: {
    list: (cwd?: string): Promise<SessionMeta[]> => ipcRenderer.invoke('sessions:list', cwd),
    remove: (file: string): Promise<boolean> => ipcRenderer.invoke('sessions:remove', file),
    search: (query: string, limit?: number): Promise<SessionSearchHit[]> =>
      ipcRenderer.invoke('sessions:search', query, limit)
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
  git: {
    status: (): Promise<GitStatus> => ipcRenderer.invoke('git:status'),
    log: (limit?: number): Promise<GitCommit[]> => ipcRenderer.invoke('git:log', limit),
    commit: (message: string, includeUnstaged?: boolean): Promise<GitCommitResult> =>
      ipcRenderer.invoke('git:commit', message, includeUnstaged === true),
    fileDiff: (file: string): Promise<GitFileDiff> => ipcRenderer.invoke('git:fileDiff', file),
    patch: (file?: string): Promise<GitPatch> => ipcRenderer.invoke('git:patch', file),
    revertFile: (file: string): Promise<GitCommitResult> =>
      ipcRenderer.invoke('git:revertFile', file),
    stageFile: (file: string): Promise<GitCommitResult> =>
      ipcRenderer.invoke('git:stageFile', file),
    unstageFile: (file: string): Promise<GitCommitResult> =>
      ipcRenderer.invoke('git:unstageFile', file),
    stageAll: (): Promise<GitCommitResult> => ipcRenderer.invoke('git:stageAll'),
    unstageAll: (): Promise<GitCommitResult> => ipcRenderer.invoke('git:unstageAll')
  },
  shell: {
    openPath: (target: string): Promise<string> => ipcRenderer.invoke('shell:openPath', target),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url)
  },
  fs: {
    list: (dir: string): Promise<FileEntry[]> => ipcRenderer.invoke('fs:list', dir),
    read: (file: string): Promise<FileContent | null> => ipcRenderer.invoke('fs:read', file),
    search: (query: string, limit?: number): Promise<FileEntry[]> =>
      ipcRenderer.invoke('fs:search', query, limit),
    searchText: (query: string, limit?: number): Promise<TextSearchHit[]> =>
      ipcRenderer.invoke('fs:searchText', query, limit),
    reveal: (file: string): Promise<void> => ipcRenderer.invoke('fs:reveal', file),
    saveImage: (data: string, mimeType: string): Promise<string | null> =>
      ipcRenderer.invoke('fs:saveImage', data, mimeType)
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
const fileSearchArg = process.argv.find((argument) =>
  argument.startsWith('--pi-desktop-file-search=')
)
const openFileArg = process.argv.find((argument) =>
  argument.startsWith('--pi-desktop-open-file=')
)
const searchArg = process.argv.find((argument) => argument.startsWith('--pi-desktop-search='))
const sessionArg = process.argv.find((argument) => argument.startsWith('--pi-desktop-session='))
const settingsArg = process.argv.includes('--pi-desktop-settings')
const openTerminal = process.argv.includes('--pi-desktop-open-terminal')
const openCommit = process.argv.includes('--pi-desktop-commit')
// The screenshot harness sets this, so the renderer exposes its store even
// when no other flag was used.
const devArg = process.argv.includes('--pi-desktop-dev')
if (
  devArg ||
  prefillArg ||
  openChanges ||
  openFiles ||
  exportFlag ||
  fileSearchArg ||
  openFileArg ||
  searchArg ||
  sessionArg ||
  settingsArg ||
  openTerminal ||
  openCommit
) {
  contextBridge.exposeInMainWorld('__piDesktopDev', {
    prefill: prefillArg ? prefillArg.slice('--pi-desktop-prefill='.length) : undefined,
    openChanges,
    openFiles,
    export: exportFlag,
    fileSearch: fileSearchArg ? fileSearchArg.slice('--pi-desktop-file-search='.length) : undefined,
    openFile: openFileArg ? openFileArg.slice('--pi-desktop-open-file='.length) : undefined,
    search: searchArg ? searchArg.slice('--pi-desktop-search='.length) : undefined,
    session: sessionArg ? sessionArg.slice('--pi-desktop-session='.length) : undefined,
    settings: settingsArg,
    openTerminal,
    commit: openCommit
  })
}
