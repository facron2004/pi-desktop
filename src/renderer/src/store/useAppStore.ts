import { create } from 'zustand'
import type {
  AgentMessage,
  AppInfo,
  AppSettings,
  ExtensionUiRequest,
  ExtensionUiResponse,
  ModelInfo,
  PiCommand,
  PiEvent,
  PiState,
  RuntimeStatus,
  SessionMeta,
  SessionStats,
  Workspace
} from '@shared/types'
import { applyEvent, itemsFromMessages, type ThreadItem } from '../lib/thread'
import { basename, resolveAgainst } from '../lib/path'

export type QueueKind = 'steer' | 'followUp'

/** A status line published by an extension through `setStatus`. */
export interface UiStatusEntry {
  key: string
  text: string
}

/** A block of text published by an extension through `setWidget`. */
export interface UiWidgetEntry {
  key: string
  lines: string[]
  placement: 'aboveEditor' | 'belowEditor'
}

export interface AppStore {
  info?: AppInfo
  settings: AppSettings
  workspace?: Workspace
  sessions: SessionMeta[]
  status: RuntimeStatus
  isStreaming: boolean
  piState?: PiState
  models: ModelInfo[]
  thinkingLevels: string[]
  commands: PiCommand[]
  stats?: SessionStats
  items: ThreadItem[]
  queue: { steering: string[]; followUp: string[] }
  activeSessionFile?: string
  error?: string
  toast?: { text: string; level: 'info' | 'warning' | 'error' }
  busy: boolean

  /** A blocking extension dialog waiting for an answer. */
  uiRequest?: ExtensionUiRequest
  uiStatuses: UiStatusEntry[]
  uiWidgets: UiWidgetEntry[]
  /** Title published by an extension through `setTitle`. */
  uiTitle?: string
  /** Text pushed into the composer through `set_editor_text`. */
  composerText?: string

  bootstrap: () => Promise<void>
  openWorkspace: (workspace: Workspace, sessionFile?: string) => Promise<void>
  pickWorkspace: () => Promise<void>
  removeWorkspace: (id: string) => Promise<void>
  refreshSessions: () => Promise<void>
  selectSession: (session: SessionMeta) => Promise<void>
  renameSession: (name: string) => Promise<void>
  exportSession: () => Promise<void>
  deleteSession: (file: string) => Promise<void>
  newChat: () => Promise<void>
  send: (text: string, images: { data: string; mimeType: string }[], kind?: QueueKind) => Promise<void>
  stop: () => Promise<void>
  setModel: (model: ModelInfo) => Promise<void>
  setThinkingLevel: (level: string) => Promise<void>
  compact: () => Promise<void>
  refreshState: () => Promise<void>
  reloadMessages: () => Promise<void>
  refreshCommands: () => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  dismissError: () => void
  showToast: (message: string, level?: 'info' | 'warning' | 'error') => void
  clearToast: () => void
  respondUi: (response: ExtensionUiResponse) => Promise<void>
  dismissUi: () => Promise<void>
  clearComposerText: () => void
}

const DEFAULT_SETTINGS: AppSettings = {
  workspaces: [],
  theme: 'dark',
  fontScale: 1,
  diffSplit: false,
  trustProject: true
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

export const useAppStore = create<AppStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  sessions: [],
  status: { phase: 'stopped' },
  isStreaming: false,
  models: [],
  thinkingLevels: [],
  commands: [],
  items: [],
  queue: { steering: [], followUp: [] },
  busy: false,
  uiStatuses: [],
  uiWidgets: [],

  async bootstrap() {
    const [info, settings] = await Promise.all([
      window.pi.app.info(),
      window.pi.settings.get()
    ])
    set({ info, settings })
    applyAppearance(settings)

    window.pi.runtime.onEvent((event) => handleEvent(set, get, event))
    window.pi.runtime.onStatus((status) => {
      set({ status })
      if (status.phase === 'error' && status.error) set({ error: status.error })
      if (status.phase === 'ready') void get().refreshCommands()
    })

    await get().refreshSessions()

    const active = settings.workspaces.find((w) => w.id === settings.activeWorkspaceId)
    const target = active ?? settings.workspaces[0]
    if (target) {
      await get().openWorkspace(target)
    }
  },

  async pickWorkspace() {
    const workspace = await window.pi.workspaces.pick()
    if (!workspace) return
    const settings = await window.pi.settings.patch({
      workspaces: [workspace, ...get().settings.workspaces.filter((w) => w.path !== workspace.path)],
      activeWorkspaceId: workspace.id
    })
    set({ settings })
    applyAppearance(settings)
    await get().openWorkspace(workspace)
  },

  async openWorkspace(workspace, sessionFile) {
    set({
      workspace,
      items: [],
      activeSessionFile: sessionFile,
      error: undefined,
      isStreaming: false,
      stats: undefined,
      // A pending dialog belongs to the previous Pi process, which is about
      // to be replaced; its answer would never reach anybody.
      uiRequest: undefined,
      uiStatuses: [],
      uiWidgets: [],
      uiTitle: undefined,
      composerText: undefined
    })

    const settings = get().settings
    const result = await window.pi.runtime.start({
      cwd: workspace.path,
      sessionFile,
      model: settings.model,
      thinkingLevel: settings.thinkingLevel
    })

    if (!result.ok) {
      // A start that was superseded by a newer one reports no error, and the
      // newer runtime owns the status.
      if (result.error) {
        set({ error: result.error, status: { phase: 'error', cwd: workspace.path, error: result.error } })
      }
      return
    }
    await get().refreshState()
    await get().reloadMessages()
    await get().refreshSessions()
  },

  async removeWorkspace(id) {
    const settings = await window.pi.workspaces.remove(id)
    set({ settings })
    applyAppearance(settings)
    const next = settings.workspaces[0]
    if (next) {
      await get().openWorkspace(next)
    } else {
      await window.pi.runtime.stop()
      set({ workspace: undefined, items: [], status: { phase: 'stopped' } })
    }
  },

  async refreshSessions() {
    const sessions = await window.pi.sessions.list()
    set({ sessions })
  },

  async selectSession(session) {
    const workspace = get().workspace
    if (!workspace) return
    set({ items: [], activeSessionFile: session.file, error: undefined })
    try {
      if (session.cwd && session.cwd !== workspace.path) {
        // The session belongs to another project: make sure that project is
        // registered, then run Pi there instead of here.
        const known = get().settings.workspaces.find((item) => item.path === session.cwd)
        const target: Workspace = known ?? {
          id: `session-${session.id.slice(0, 8)}`,
          path: session.cwd,
          name: session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? session.cwd,
          lastOpenedAt: Date.now()
        }
        if (!known) {
          const settings = await window.pi.settings.patch({
            workspaces: [target, ...get().settings.workspaces],
            activeWorkspaceId: target.id
          })
          set({ settings })
        }
        await get().openWorkspace(target, session.file)
        return
      }
      await window.pi.runtime.request('switch_session', { sessionPath: session.file })
      await get().refreshState()
      await get().reloadMessages()
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async renameSession(name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      await window.pi.runtime.request('set_session_name', { name: trimmed })
      const activeFile = get().activeSessionFile
      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.file === activeFile ? { ...session, name: trimmed } : session
        ),
        piState: state.piState ? { ...state.piState, sessionName: trimmed } : state.piState
      }))
      await get().refreshSessions()
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async exportSession() {
    try {
      const result = await window.pi.runtime.request<{ path?: string }>('export_html')
      const raw = result?.path
      if (!raw) {
        get().showToast('Pi did not report an export file')
        return
      }
      // Pi reports a bare file name relative to the session's working directory.
      const target = resolveAgainst(get().workspace?.path, raw)
      await window.pi.shell.openPath(target)
      get().showToast(`Exported ${basename(target)}`)
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async deleteSession(file: string) {
    const session = get().sessions.find((entry) => entry.file === file)
    const active = get().activeSessionFile === file
    try {
      if (active) {
        // Start a fresh session first so Pi does not keep writing to the file.
        await window.pi.runtime.request('new_session')
        set({ items: [], activeSessionFile: undefined })
      }
      const removed = await window.pi.sessions.remove(file)
      if (!removed) {
        set({ error: `Could not delete ${session?.name ?? 'the conversation'}` })
        return
      }
      await get().refreshSessions()
      get().showToast('Conversation deleted')
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async newChat() {
    if (get().status.phase !== 'ready') return
    try {
      await window.pi.runtime.request('new_session')
      set({ items: [], activeSessionFile: undefined, stats: undefined })
      await get().refreshState()
      await get().reloadMessages()
      await get().refreshSessions()
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async send(text, images, kind = 'steer') {
    const trimmed = text.trim()
    if (!trimmed && !images.length) return
    try {
      const payload: Record<string, unknown> = { message: trimmed }
      if (images.length) payload.images = images
      if (get().isStreaming) payload.streamingBehavior = kind
      // An extension command can block on a dialog, and Pi only answers the
      // prompt once the command is done. The deadline has to outlast that.
      const result = await window.pi.runtime.request<{ disposition?: string }>(
        'prompt',
        payload,
        900_000
      )
      if (result?.disposition === 'handled') {
        // The command was consumed by Pi itself, so no model turn follows.
        set((state) => ({
          items: applyEvent(state.items, {
            type: 'client_notice',
            level: 'info',
            text: `Pi handled ${trimmed} directly — no model turn was needed`
          })
        }))
      }
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async stop() {
    try {
      const queue = await window.pi.runtime.request<{ steering: string[]; followUp: string[] }>(
        'clear_queue'
      )
      set({ queue: { steering: queue?.steering ?? [], followUp: queue?.followUp ?? [] } })
      await window.pi.runtime.request('abort')
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async setModel(model) {
    try {
      await window.pi.runtime.request('set_model', {
        provider: model.provider,
        modelId: model.id
      })
      await get().refreshState()
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async setThinkingLevel(level) {
    try {
      await window.pi.runtime.request('set_thinking_level', { level })
      await get().refreshState()
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async compact() {
    try {
      await window.pi.runtime.request('compact', {}, 180_000)
      await get().refreshState()
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async refreshState() {
    try {
      const [state, models, levels, stats] = await Promise.all([
        window.pi.runtime.request<PiState>('get_state'),
        window.pi.runtime
          .request<{ models: ModelInfo[] }>('get_available_models')
          .then((data) => data?.models ?? [])
          .catch(() => [] as ModelInfo[]),
        window.pi.runtime
          .request<{ levels: string[] }>('get_available_thinking_levels')
          .then((data) => data?.levels ?? [])
          .catch(() => [] as string[]),
        window.pi.runtime
          .request<SessionStats>('get_session_stats')
          .catch(() => undefined as SessionStats | undefined)
      ])
      set({ piState: state, models, thinkingLevels: levels, stats })
      if (state?.sessionFile) set({ activeSessionFile: state.sessionFile })
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async reloadMessages() {
    if (get().isStreaming) return
    try {
      const data = await window.pi.runtime.request<{ messages: AgentMessage[] }>('get_messages')
      set({ items: itemsFromMessages(data?.messages ?? []) })
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async refreshCommands() {
    try {
      const data = await window.pi.runtime.request<{ commands: PiCommand[] }>('get_commands')
      set({ commands: data?.commands ?? [] })
    } catch {
      set({ commands: [] })
    }
  },

  async updateSettings(patch) {
    const settings = await window.pi.settings.patch(patch)
    set({ settings })
    applyAppearance(settings)
  },

  dismissError() {
    set({ error: undefined })
  },

  showToast(message, level = 'info') {
    set({ toast: { text: message, level } })
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => set({ toast: undefined }), 3200)
  },

  clearToast() {
    set({ toast: undefined })
  },

  async respondUi(response) {
    const request = get().uiRequest
    if (!request) return
    set({ uiRequest: undefined })
    try {
      await window.pi.runtime.respondUi(request.id, response)
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async dismissUi() {
    await get().respondUi({ cancelled: true })
  },

  clearComposerText() {
    set({ composerText: undefined })
  }
}))

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function applyAppearance(settings: AppSettings): void {
  const root = document.documentElement
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && prefersDark)
  root.dataset.theme = dark ? 'dark' : 'light'
  root.style.setProperty('--font-scale', String(settings.fontScale ?? 1))
  void window.pi.app.setTheme(dark ? 'dark' : 'light')
}

type SetState = (partial: Partial<AppStore> | ((state: AppStore) => Partial<AppStore>)) => void
type GetState = () => AppStore

function handleEvent(set: SetState, get: GetState, event: PiEvent): void {
  switch (event.type) {
    case 'agent_start':
      set({ isStreaming: true })
      break
    case 'agent_settled':
      set({ isStreaming: false })
      // Pi resolves a dialog on its own when its timeout expires. The client
      // is not told, so the dialog is closed when the agent moves on.
      if (get().uiRequest) set({ uiRequest: undefined })
      void get().refreshState()
      void get().refreshSessions()
      break
    case 'session_info_changed': {
      const name = typeof event.name === 'string' ? event.name : undefined
      set((state) => ({
        piState: state.piState ? { ...state.piState, sessionName: name } : state.piState
      }))
      break
    }
    case 'thinking_level_changed': {
      const level = typeof event.level === 'string' ? event.level : undefined
      set((state) => ({
        piState: state.piState ? { ...state.piState, thinkingLevel: level } : state.piState
      }))
      break
    }
    case 'queue_update': {
      set({
        queue: {
          steering: Array.isArray(event.steering) ? (event.steering as string[]) : [],
          followUp: Array.isArray(event.followUp) ? (event.followUp as string[]) : []
        }
      })
      break
    }
    case 'message_end':
    case 'message_update':
    case 'message_start':
    case 'tool_execution_start':
    case 'tool_execution_update':
    case 'tool_execution_end':
    case 'bash_execution_update':
    case 'compaction_start':
    case 'compaction_end':
    case 'auto_retry_start':
    case 'auto_retry_end':
    case 'extension_error':
    case 'client_notice': {
      set((state) => ({ items: applyEvent(state.items, event) }))
      break
    }
    case 'extension_ui_request': {
      handleExtensionUi(set, get, event as unknown as ExtensionUiRequest)
      break
    }
    default:
      break
  }
}

/**
 * Apply one `extension_ui_request`.
 *
 * Dialog methods block the agent until an answer arrives, so they become a
 * modal in the renderer. The rest are fire-and-forget decorations.
 */
function handleExtensionUi(
  set: SetState,
  get: GetState,
  request: ExtensionUiRequest
): void {
  switch (request.method) {
    case 'select':
    case 'confirm':
    case 'input':
    case 'editor': {
      // A new request supersedes any dialog that is still open.
      set({ uiRequest: request })
      break
    }
    case 'notify': {
      get().showToast(request.message ?? '', request.notifyType ?? 'info')
      break
    }
    case 'setStatus': {
      const key = request.statusKey
      if (!key) break
      set((state) => ({
        uiStatuses: request.statusText
          ? [...state.uiStatuses.filter((entry) => entry.key !== key), { key, text: request.statusText! }]
          : state.uiStatuses.filter((entry) => entry.key !== key)
      }))
      break
    }
    case 'setWidget': {
      const key = request.widgetKey
      if (!key) break
      set((state) => ({
        uiWidgets: request.widgetLines
          ? [
              ...state.uiWidgets.filter((entry) => entry.key !== key),
              {
                key,
                lines: request.widgetLines!,
                placement: request.widgetPlacement ?? 'aboveEditor'
              }
            ]
          : state.uiWidgets.filter((entry) => entry.key !== key)
      }))
      break
    }
    case 'setTitle': {
      set({ uiTitle: request.title })
      break
    }
    case 'set_editor_text': {
      set({ composerText: request.text ?? '' })
      break
    }
    default:
      break
  }
}

/** Rebuild the thread from the session history (after switching sessions). */
export function hydrateFromMessages(messages: AgentMessage[]): ThreadItem[] {
  return itemsFromMessages(messages)
}
