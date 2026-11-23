import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ProviderConnection, SaveProviderInput } from '@shared/providers'
import type {
  CreateResourceInput,
  ManagedPackage,
  MarketplaceActionResult,
  MarketplaceInstallProgress,
  MarketplaceInstallResult,
  MarketplaceSnapshot,
  PiCatalogPage,
  PiCatalogQuery
} from '@shared/marketplace'
import type {
  AggregatedUsageStats,
  SessionHydrationResult,
  SettingsPatchBaseline,
  AppInfo,
  AppUpdateProgress,
  AppSettings,
  AuthStatus,
  DownloadedAppUpdate,
  ExtensionUiResponse,
  FileContent,
  FileListResult,
  FileSearchResult,
  FileSearchScope,
  GitBranches,
  GitCommit,
  GitCommitDetail,
  GitCommitFileDiff,
  GitCommitResult,
  GitFileDiff,
  GitPatch,
  GitStatus,
  GitWorktreeResult,
  GeneratedImage,
  ImageGenerationRequest,
  ImageListResult,
  McpConfig,
  MemoryGenerateOptions,
  MemoryState,
  PickedFile,
  PiCommand,
  PiCliUpgradeProgress,
  PiDesktopBridge,
  RpcTraceHint,
  RuntimeEnsureOptions,
  RuntimeStartOptions,
  RuntimeEvent,
  RuntimeQueueEvent,
  RuntimeRekey,
  RuntimeStderrPayload,
  RuntimeStatusEvent,
  RemoteAccessStatus,
  ScheduledTask,
  ScheduledTaskInput,
  SessionMeta,
  SessionNameChange,
  TerminalCreateOptions,
  TerminalDataPayload,
  TerminalExitPayload,
  TrayConversation,
  TrayPopupState,
  SessionSearchHit,
  TextSearchResult,
  UpdateState,
  UpgradeResult,
  VersionCheckResult,
  VersionItemStatus,
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
  modelCatalog: {
    thinkingLevels: (provider: string, modelId: string): Promise<string[]> =>
      ipcRenderer.invoke('model-catalog:thinking-levels', provider, modelId)
  },
  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
    savedKey: (id: string) => ipcRenderer.invoke('providers:savedKey', id),
    models: (connection: ProviderConnection) => ipcRenderer.invoke('providers:models', connection),
    probe: (connection: ProviderConnection, modelId?: string) => ipcRenderer.invoke('providers:probe', connection, modelId),
    save: (input: SaveProviderInput, sessionKey?: string) => ipcRenderer.invoke('providers:save', input, sessionKey),
    remove: (id: string) => ipcRenderer.invoke('providers:remove', id)
  },
  app: {
    info: (options?: { includePiVersion?: boolean }): Promise<AppInfo> =>
      ipcRenderer.invoke('app:info', options),
    startupReady: (): void => ipcRenderer.send('app:startup-ready'),
    setTheme: (
      theme: 'dark' | 'light',
      colors?: { color: string; symbolColor: string }
    ): Promise<void> => ipcRenderer.invoke('app:setTheme', theme, colors),
    setWindowClosable: (closable: boolean): Promise<void> =>
      ipcRenderer.invoke('app:setWindowClosable', closable),
    getSystemFonts: (): Promise<string[]> => ipcRenderer.invoke('app:getSystemFonts'),
    emojiFont: (): Promise<Uint8Array | null> => ipcRenderer.invoke('app:emojiFont'),
    checkUpdate: (): Promise<VersionCheckResult> => ipcRenderer.invoke('app:checkUpdate'),
    checkPiCliUpdate: (): Promise<VersionItemStatus> => ipcRenderer.invoke('app:checkPiCliUpdate'),
    updateState: (): Promise<UpdateState | null> => ipcRenderer.invoke('app:updateState'),
    downloadUpdate: (version: string): Promise<UpgradeResult> => ipcRenderer.invoke('app:downloadUpdate', version),
    downloadedUpdate: (): Promise<DownloadedAppUpdate | null> => ipcRenderer.invoke('app:downloadedUpdate'),
    installAppUpdate: (version: string): Promise<UpgradeResult> => ipcRenderer.invoke('app:installUpdate', version),
    onAppUpdateProgress: (handler: (progress: AppUpdateProgress) => void) =>
      subscribe<AppUpdateProgress>('app:updateProgress', handler),
    upgradePiCli: (): Promise<UpgradeResult> => ipcRenderer.invoke('app:upgradePiCli'),
    onPiCliUpgradeProgress: (handler: (progress: PiCliUpgradeProgress) => void) =>
      subscribe<PiCliUpgradeProgress>('app:piCliUpgradeProgress', handler),
    openReleasePage: (): Promise<UpgradeResult> => ipcRenderer.invoke('app:openReleasePage'),
    onNotificationOpen: (handler) => subscribe('notification:open', handler)
  },
  tray: {
    setConversations: (conversations: TrayConversation[]): void =>
      ipcRenderer.send('tray:conversations', conversations),
    onOpenConversation: (handler: (payload: { key: string }) => void) =>
      subscribe<{ key: string }>('tray:open-conversation', handler)
  },
  trayPopup: {
    getState: (): Promise<TrayPopupState> => ipcRenderer.invoke('tray-popup:get-state'),
    onState: (handler: (state: TrayPopupState) => void) =>
      subscribe<TrayPopupState>('tray-popup:state', handler),
    setHeight: (height: number): void => ipcRenderer.send('tray-popup:set-height', height),
    openConversation: (key: string): void => ipcRenderer.send('tray-popup:open-conversation', key),
    showWindow: (): void => ipcRenderer.send('tray-popup:show-window'),
    quit: (): void => ipcRenderer.send('tray-popup:quit'),
    close: (): void => ipcRenderer.send('tray-popup:close')
  },
  dialog: {
    pickDirectory: (defaultPath?: string): Promise<string | null> =>
      ipcRenderer.invoke('dialog:pickDirectory', defaultPath),
    pickFiles: (defaultPath?: string, imageBudgetBytes?: number): Promise<PickedFile[]> =>
      ipcRenderer.invoke('dialog:pickFiles', defaultPath, imageBudgetBytes)
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    patch: (patch: Partial<AppSettings>, baseline?: SettingsPatchBaseline): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:patch', patch, baseline)
  },
  remote: {
    status: (): Promise<RemoteAccessStatus> => ipcRenderer.invoke('remote:status'),
    setEnabled: (enabled: boolean): Promise<RemoteAccessStatus> =>
      ipcRenderer.invoke('remote:setEnabled', enabled),
    newPairing: (): Promise<RemoteAccessStatus> => ipcRenderer.invoke('remote:newPairing'),
    revokeDevice: (id: string): Promise<RemoteAccessStatus> =>
      ipcRenderer.invoke('remote:revokeDevice', id)
  },
  scheduledTasks: {
    list: (): Promise<ScheduledTask[]> => ipcRenderer.invoke('scheduled-tasks:list'),
    create: (input: ScheduledTaskInput): Promise<ScheduledTask[]> =>
      ipcRenderer.invoke('scheduled-tasks:create', input),
    update: (id: string, input: ScheduledTaskInput): Promise<ScheduledTask[]> =>
      ipcRenderer.invoke('scheduled-tasks:update', id, input),
    setEnabled: (id: string, enabled: boolean): Promise<ScheduledTask[]> =>
      ipcRenderer.invoke('scheduled-tasks:setEnabled', id, enabled),
    remove: (id: string): Promise<ScheduledTask[]> => ipcRenderer.invoke('scheduled-tasks:remove', id),
    runNow: (id: string): Promise<ScheduledTask[]> => ipcRenderer.invoke('scheduled-tasks:runNow', id),
    stopRun: (id: string): Promise<boolean> => ipcRenderer.invoke('scheduled-tasks:stopRun', id),
    onChanged: (handler: (tasks: ScheduledTask[]) => void) =>
      subscribe<ScheduledTask[]>('scheduled-tasks:changed', handler)
  },
  memory: {
    get: (): Promise<MemoryState> => ipcRenderer.invoke('memory:get'),
    remove: (id: string): Promise<MemoryState> => ipcRenderer.invoke('memory:remove', id),
    clear: (): Promise<MemoryState> => ipcRenderer.invoke('memory:clear'),
    generate: (options?: MemoryGenerateOptions) => ipcRenderer.invoke('memory:generate', options),
    openFolder: (): Promise<void> => ipcRenderer.invoke('memory:openFolder'),
    onChanged: (handler: (state: MemoryState) => void) => subscribe<MemoryState>('memory:changed', handler)
  },
  workspaces: {
    pick: (): Promise<Workspace | null> => ipcRenderer.invoke('workspaces:pick'),
    remove: (id?: string, hiddenPath?: string): Promise<AppSettings> =>
      ipcRenderer.invoke('workspaces:remove', id, hiddenPath),
    add: (path: string): Promise<{ workspace: Workspace; settings: AppSettings }> =>
      ipcRenderer.invoke('workspaces:add', path)
  },
  sessions: {
    list: (cwd?: string): Promise<SessionMeta[]> => ipcRenderer.invoke('sessions:list', cwd),
    remove: (file: string): Promise<boolean> => ipcRenderer.invoke('sessions:remove', file),
    hydrate: (file: string, scope?: 'branch'): Promise<SessionHydrationResult> =>
      ipcRenderer.invoke('sessions:hydrate', file, scope),
    rename: (file: string, name: string): Promise<boolean> =>
      ipcRenderer.invoke('sessions:rename', file, name),
    search: (query: string, limit?: number): Promise<SessionSearchHit[]> =>
      ipcRenderer.invoke('sessions:search', query, limit),
    usageStats: (): Promise<AggregatedUsageStats> => ipcRenderer.invoke('sessions:usageStats'),
    onChanged: (handler: (change: SessionNameChange) => void) =>
      subscribe<SessionNameChange>('sessions:changed', handler)
  },
  terminal: {
    create: (options: TerminalCreateOptions) => ipcRenderer.invoke('terminal:create', options),
    write: (id: string, data: string): Promise<void> => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('terminal:resize', id, cols, rows),
    kill: (id: string): Promise<void> => ipcRenderer.invoke('terminal:kill', id),
    acknowledgeOutput: (id: string, sequence: number): void =>
      ipcRenderer.send('terminal:ack', id, sequence),
    onData: (handler: (payload: TerminalDataPayload) => void) =>
      subscribe<TerminalDataPayload>('terminal:data', handler),
    onExit: (handler: (payload: TerminalExitPayload) => void) =>
      subscribe<TerminalExitPayload>('terminal:exit', handler)
  },
  runtime: {
    start: (options: RuntimeStartOptions) => ipcRenderer.invoke('runtime:start', options),
    ensure: (options: RuntimeEnsureOptions) => ipcRenderer.invoke('runtime:ensure', options),
    listSkillCommands: (): Promise<PiCommand[]> => ipcRenderer.invoke('runtime:skill-commands'),
    has: (sessionKey: string): Promise<boolean> => ipcRenderer.invoke('runtime:has', sessionKey),
    stop: (sessionKey: string): Promise<void> => ipcRenderer.invoke('runtime:stop', sessionKey),
    stopCwd: (cwd: string): Promise<void> => ipcRenderer.invoke('runtime:stopCwd', cwd),
    request: <T = unknown>(
      command: string,
      payload?: Record<string, unknown>,
      timeoutMs?: number,
      trace?: RpcTraceHint,
      sessionKey?: string
    ): Promise<T> =>
      ipcRenderer.invoke('runtime:request', command, payload ?? {}, timeoutMs, trace, sessionKey),
    onEvent: (handler: (event: RuntimeEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: RuntimeEvent | RuntimeEvent[]) => {
        if (Array.isArray(payload)) {
          for (const item of payload) handler(item)
        } else {
          handler(payload)
        }
      }
      ipcRenderer.on('runtime:event', listener)
      return () => {
        ipcRenderer.removeListener('runtime:event', listener)
      }
    },
    onStatus: (handler: (status: RuntimeStatusEvent) => void) =>
      subscribe<RuntimeStatusEvent>('runtime:status', handler),
    onRekey: (handler: (change: RuntimeRekey) => void) =>
      subscribe<RuntimeRekey>('runtime:rekey', handler),
    onStderr: (handler: (payload: RuntimeStderrPayload | string) => void) =>
      subscribe<RuntimeStderrPayload | string>('runtime:stderr', handler),
    onQueue: (handler: (event: RuntimeQueueEvent) => void) =>
      subscribe<RuntimeQueueEvent>('runtime:queue', handler),
    respondUi: (id: string, response: ExtensionUiResponse, sessionKey?: string): Promise<void> =>
      ipcRenderer.invoke('runtime:respondUi', id, response, sessionKey)
  },
  auth: {
    check: (provider?: string): Promise<AuthStatus> => ipcRenderer.invoke('auth:check', provider)
  },
  mcp: {
    read: (): Promise<McpConfig> => ipcRenderer.invoke('mcp:read'),
    setEnabled: (name: string, enabled: boolean): Promise<MarketplaceActionResult> =>
      ipcRenderer.invoke('mcp:setEnabled', name, enabled),
    remove: (name: string): Promise<MarketplaceActionResult> =>
      ipcRenderer.invoke('mcp:remove', name)
  },
  marketplace: {
    list: (): Promise<MarketplaceSnapshot> => ipcRenderer.invoke('marketplace:list'),
    piCatalog: (query?: PiCatalogQuery): Promise<PiCatalogPage> =>
      ipcRenderer.invoke('marketplace:piCatalog', query),
    refresh: (): Promise<MarketplaceSnapshot> => ipcRenderer.invoke('marketplace:refresh'),
    installed: (): Promise<string[]> => ipcRenderer.invoke('marketplace:installed'),
    install: (id: string, runId?: string): Promise<MarketplaceInstallResult> =>
      ipcRenderer.invoke('marketplace:install', id, runId),
    installNpm: (packageName: string, runId?: string): Promise<MarketplaceInstallResult> =>
      ipcRenderer.invoke('marketplace:installNpm', packageName, runId),
    onInstallProgress: (handler: (progress: MarketplaceInstallProgress) => void) =>
      subscribe<MarketplaceInstallProgress>('marketplace:installProgress', handler),
    managed: (): Promise<ManagedPackage[]> => ipcRenderer.invoke('marketplace:managed'),
    setPackageEnabled: (id: string, enabled: boolean): Promise<MarketplaceActionResult> =>
      ipcRenderer.invoke('marketplace:setPackageEnabled', id, enabled),
    removePackage: (id: string): Promise<MarketplaceActionResult> =>
      ipcRenderer.invoke('marketplace:removePackage', id),
    createResource: (input: CreateResourceInput): Promise<MarketplaceActionResult> =>
      ipcRenderer.invoke('marketplace:createResource', input),
    installGitRepository: (repository: string, runId?: string): Promise<MarketplaceInstallResult> =>
      ipcRenderer.invoke('marketplace:installGitRepository', repository, runId)
  },
  git: {
    status: (expectedRoot?: string): Promise<GitStatus> => ipcRenderer.invoke('git:status', expectedRoot),
    log: (limit?: number, expectedRoot?: string): Promise<GitCommit[]> => ipcRenderer.invoke('git:log', limit, expectedRoot),
    commit: (message: string, includeUnstaged: boolean, expectedRoot: string): Promise<GitCommitResult> =>
      ipcRenderer.invoke('git:commit', message, includeUnstaged, expectedRoot),
    fileDiff: (file: string, expectedRoot?: string): Promise<GitFileDiff> => ipcRenderer.invoke('git:fileDiff', file, expectedRoot),
    patch: (file?: string): Promise<GitPatch> => ipcRenderer.invoke('git:patch', file),
    commitDetail: (hash: string): Promise<GitCommitDetail | null> =>
      ipcRenderer.invoke('git:commitDetail', hash),
    commitFileDiff: (hash: string, file: string): Promise<GitCommitFileDiff | null> =>
      ipcRenderer.invoke('git:commitFileDiff', hash, file),
    commitWorktreeDiff: (hash: string, file: string): Promise<GitCommitFileDiff | null> =>
      ipcRenderer.invoke('git:commitWorktreeDiff', hash, file),
    applyPatch: (patch: string, reverse: boolean, expectedRoot: string): Promise<GitCommitResult> =>
      ipcRenderer.invoke('git:applyPatch', patch, reverse, expectedRoot),
    branches: (expectedRoot?: string): Promise<GitBranches> => ipcRenderer.invoke('git:branches', expectedRoot),
    switchBranch: (name: string, expectedRoot: string): Promise<GitCommitResult> =>
      ipcRenderer.invoke('git:switchBranch', name, expectedRoot),
    createBranch: (name: string, checkout: boolean, expectedRoot: string): Promise<GitCommitResult> =>
      ipcRenderer.invoke('git:createBranch', name, checkout, expectedRoot),
    addWorktree: (
      path: string,
      branch: string,
      createBranch: boolean,
      expectedRoot: string
    ): Promise<GitWorktreeResult> =>
      ipcRenderer.invoke('git:addWorktree', path, branch, createBranch !== false, expectedRoot),
    removeWorktree: (path: string, expectedRoot: string): Promise<GitCommitResult> =>
      ipcRenderer.invoke('git:removeWorktree', path, expectedRoot),
    revertFile: (file: string, expectedRoot: string): Promise<GitCommitResult> =>
      ipcRenderer.invoke('git:revertFile', file, expectedRoot),
    stageFile: (file: string, expectedRoot: string): Promise<GitCommitResult> =>
      ipcRenderer.invoke('git:stageFile', file, expectedRoot),
    unstageFile: (file: string, expectedRoot: string): Promise<GitCommitResult> =>
      ipcRenderer.invoke('git:unstageFile', file, expectedRoot),
    stageAll: (expectedRoot: string): Promise<GitCommitResult> => ipcRenderer.invoke('git:stageAll', expectedRoot),
    unstageAll: (expectedRoot: string): Promise<GitCommitResult> => ipcRenderer.invoke('git:unstageAll', expectedRoot),
    push: (expectedRoot: string): Promise<GitCommitResult> => ipcRenderer.invoke('git:push', expectedRoot),
    pull: (expectedRoot: string): Promise<GitCommitResult> => ipcRenderer.invoke('git:pull', expectedRoot)
  },
  shell: {
    nativeIcons: (): Promise<Record<string, string>> => ipcRenderer.invoke('shell:nativeIcons'),
    openPath: (target: string): Promise<string> => ipcRenderer.invoke('shell:openPath', target),
    openInExplorer: (target: string): Promise<string> => ipcRenderer.invoke('shell:openInExplorer', target),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url)
  },
  fs: {
    list: (dir: string): Promise<FileListResult> => ipcRenderer.invoke('fs:list', dir),
    read: (file: string): Promise<FileContent | null> => ipcRenderer.invoke('fs:read', file),
    search: (query: string, limit?: number, scope?: FileSearchScope): Promise<FileSearchResult> =>
      ipcRenderer.invoke('fs:search', query, limit, scope),
    searchText: (query: string, limit?: number): Promise<TextSearchResult> =>
      ipcRenderer.invoke('fs:searchText', query, limit),
    listImages: (): Promise<ImageListResult> => ipcRenderer.invoke('fs:listImages'),
    reveal: (file: string): Promise<void> => ipcRenderer.invoke('fs:reveal', file),
    savePastedImage: (
      data: string,
      mimeType: string
    ): Promise<{ path: string; root: string } | null> =>
      ipcRenderer.invoke('fs:savePastedImage', data, mimeType),
    saveImage: (data: string, mimeType: string): Promise<string | null> =>
      ipcRenderer.invoke('fs:saveImage', data, mimeType),
    pathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    },
    readImageDataUrl: (file: string, maxBytes?: number): Promise<string | null> =>
      ipcRenderer.invoke('fs:readImageDataUrl', file, maxBytes)
  },
  images: {
    generate: (request: ImageGenerationRequest): Promise<GeneratedImage[]> =>
      ipcRenderer.invoke('image:generate', request)
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
