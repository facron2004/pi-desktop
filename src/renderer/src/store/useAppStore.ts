import { create } from 'zustand'
import type {
  AgentMessage,
  AppInfo,
  AppSettings,
  ModelInfo,
  PiEvent,
  PiState,
  RuntimeStatus,
  SessionMeta,
  SessionStats,
  Workspace
} from '@shared/types'
import { applyEvent, itemsFromMessages, type ThreadItem } from '../lib/thread'

export type QueueKind = 'steer' | 'followUp'

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
  stats?: SessionStats
  items: ThreadItem[]
  queue: { steering: string[]; followUp: string[] }
  activeSessionFile?: string
  error?: string
  toast?: string
  busy: boolean

  bootstrap: () => Promise<void>
  openWorkspace: (workspace: Workspace, sessionFile?: string) => Promise<void>
  pickWorkspace: () => Promise<void>
  removeWorkspace: (id: string) => Promise<void>
  refreshSessions: () => Promise<void>
  selectSession: (session: SessionMeta) => Promise<void>
  newChat: () => Promise<void>
  send: (text: string, images: { data: string; mimeType: string }[], kind?: QueueKind) => Promise<void>
  stop: () => Promise<void>
  setModel: (model: ModelInfo) => Promise<void>
  setThinkingLevel: (level: string) => Promise<void>
  compact: () => Promise<void>
  refreshState: () => Promise<void>
  reloadMessages: () => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  dismissError: () => void
  showToast: (message: string) => void
  clearToast: () => void
}

const DEFAULT_SETTINGS: AppSettings = {
  workspaces: [],
  theme: 'dark',
  fontScale: 1,
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
  items: [],
  queue: { steering: [], followUp: [] },
  busy: false,

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
      stats: undefined
    })

    const settings = get().settings
    const result = await window.pi.runtime.start({
      cwd: workspace.path,
      sessionFile,
      model: settings.model,
      thinkingLevel: settings.thinkingLevel
    })

    if (!result.ok) {
      set({ error: result.error, status: { phase: 'error', cwd: workspace.path, error: result.error } })
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
      await window.pi.runtime.request('prompt', payload)
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

  async updateSettings(patch) {
    const settings = await window.pi.settings.patch(patch)
    set({ settings })
    applyAppearance(settings)
  },

  dismissError() {
    set({ error: undefined })
  },

  showToast(message) {
    set({ toast: message })
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => set({ toast: undefined }), 3200)
  },

  clearToast() {
    set({ toast: undefined })
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
    default:
      break
  }
}

/** Rebuild the thread from the session history (after switching sessions). */
export function hydrateFromMessages(messages: AgentMessage[]): ThreadItem[] {
  return itemsFromMessages(messages)
}
