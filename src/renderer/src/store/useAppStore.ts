import { create } from 'zustand'
import type {
  AgentMessage,
  AppInfo,
  AppSettings,
  ExtensionUiRequest,
  ExtensionUiResponse,
  ForkTarget,
  InspectorRequest,
  ModelInfo,
  PiCommand,
  PiEvent,
  PiState,
  RuntimeStatus,
  SessionMeta,
  SessionStats,
  Workspace
} from '@shared/types'
import { applyEvent, itemsFromMessages, lastAssistantText, type ThreadItem } from '../lib/thread'
import { basename, resolveAgainst, samePath } from '../lib/path'
import { APP_COMMANDS } from '../lib/app-commands'

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
  /** User messages the active branch can be forked from. */
  forkTargets: ForkTarget[]
  /** True while a fork is in flight, so the button cannot be pressed twice. */
  forking: boolean
  /** Set while Pi is retrying a failed request on its own. */
  retry?: {
    attempt: number
    maxAttempts: number
    delayMs: number
    errorMessage?: string
  }
  error?: string
  toast?: { text: string; level: 'info' | 'warning' | 'error' }

  /** A blocking extension dialog waiting for an answer. */
  uiRequest?: ExtensionUiRequest
  uiStatuses: UiStatusEntry[]
  uiWidgets: UiWidgetEntry[]
  /** Title published by an extension through `setTitle`. */
  uiTitle?: string
  /** Text pushed into the composer through `set_editor_text`. */
  composerText?: string
  /** Text to append to the composer, e.g. a command the user wants to reuse. */
  composerInsert?: { text: string; seq: number; mode?: 'append' | 'replace' }

  bootstrap: () => Promise<void>
  openWorkspace: (workspace: Workspace, sessionFile?: string) => Promise<void>
  pickWorkspace: () => Promise<void>
  /** Make the project at `path` the active one and run Pi there. */
  switchProject: (path: string) => Promise<void>
  removeWorkspace: (id: string) => Promise<void>
  refreshSessions: () => Promise<void>
  selectSession: (session: SessionMeta) => Promise<void>
  renameSession: (name: string) => Promise<void>
  /** Name a conversation from the list, active or not. */
  renameSessionFile: (file: string, name: string) => Promise<void>
  /** Copy the current conversation into a new one. */
  duplicateSession: () => Promise<void>
  exportSession: () => Promise<void>
  deleteSession: (file: string) => Promise<void>
  newChat: () => Promise<void>
  send: (text: string, images: { data: string; mimeType: string }[], kind?: QueueKind) => Promise<void>
  stop: () => Promise<void>
  setModel: (model: ModelInfo) => Promise<void>
  setThinkingLevel: (level: string) => Promise<void>
  /** Switch to the next model of Pi's list, or to the previous one. */
  cycleModel: (direction?: 1 | -1) => Promise<void>
  /** Move to the next reasoning effort, or to the previous one. */
  cycleThinkingLevel: (direction?: 1 | -1) => Promise<void>
  /** Compact the context, optionally with instructions for the summary. */
  compact: (instructions?: string) => Promise<void>
  setAutoCompaction: (enabled: boolean) => Promise<void>
  /** How steering messages are delivered: one at a time or all at once. */
  setSteeringMode: (mode: 'all' | 'one-at-a-time') => Promise<void>
  /** How follow-up messages are delivered: one at a time or all at once. */
  setFollowUpMode: (mode: 'all' | 'one-at-a-time') => Promise<void>
  refreshState: () => Promise<void>
  /** Remember the conversation that is open in the current project. */
  rememberSession: (file: string) => Promise<void>
  reloadMessages: () => Promise<void>
  refreshCommands: () => Promise<void>
  /** Run one of the commands the app itself provides. */
  runAppCommand: (name: string) => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  /** Pin a conversation to the top of the sidebar, or unpin it. */
  togglePin: (file: string) => Promise<void>
  dismissError: () => void
  showToast: (message: string, level?: 'info' | 'warning' | 'error') => void
  clearToast: () => void
  respondUi: (response: ExtensionUiResponse) => Promise<void>
  dismissUi: () => Promise<void>
  clearComposerText: () => void
  /** Append text to the composer and focus it. */
  insertIntoComposer: (text: string, mode?: 'append' | 'replace') => void
  refreshForkTargets: () => Promise<void>
  /** Start a new branch that keeps the history before `entryId`. */
  forkFrom: (entryId: string) => Promise<void>
  /** Stop Pi from retrying a failed request. */
  abortRetry: () => Promise<void>
}

const DEFAULT_SETTINGS: AppSettings = {
  workspaces: [],
  pinnedSessions: [],
  theme: 'dark',
  language: 'en',
  fontScale: 1,
  diffSplit: false,
  drawerWidth: 420,
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
  commands: APP_COMMANDS,
  items: [],
  queue: { steering: [], followUp: [] },
  forkTargets: [],
  forking: false,
  uiStatuses: [],
  uiWidgets: [],

  async bootstrap() {
    const [info, settings] = await Promise.all([
      window.pi.app.info(),
      window.pi.settings.get()
    ])
    set({ info, settings })
    applyAppearance(settings, info.forcedTheme)

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
      // The conversation that was open in this project is opened again, so
      // the user comes back to the work rather than to an empty screen.
      const remembered = settings.lastSessions?.[target.path]
      await get().openWorkspace(target, remembered)
    }
  },

  async pickWorkspace() {
    const workspace = await window.pi.workspaces.pick()
    if (!workspace) return
    await get().switchProject(workspace.path)
  },

  async switchProject(path) {
    const current = get().workspace
    if (current && samePath(current.path, path)) return
    const { workspace, settings } = await window.pi.workspaces.add(path)
    const now = Date.now()
    const workspaces = settings.workspaces.map((item) =>
      samePath(item.path, path) ? { ...item, lastOpenedAt: now } : item
    )
    const next = await window.pi.settings.patch({
      workspaces,
      activeWorkspaceId: workspace.id
    })
    set({ settings: next })
    applyAppearance(next, get().info?.forcedTheme)
    await get().openWorkspace({ ...workspace, lastOpenedAt: now })
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
    const current = get().workspace
    const target = get().settings.workspaces.find((item) => item.id === id)
    // Removing a project that is not the active one must not move the user
    // somewhere else; only the project that goes away needs a replacement.
    const wasActive = Boolean(current && target && samePath(current.path, target.path))
    const settings = await window.pi.workspaces.remove(id)
    set({ settings })
    applyAppearance(settings, get().info?.forcedTheme)
    if (!wasActive) return
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

  /**
   * Name a conversation from the list.
   *
   * Pi can only name the session that is open, so a conversation that is not
   * active is opened, named and closed again.
   */
  async renameSessionFile(file: string, name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    if (file === get().activeSessionFile) {
      await get().renameSession(trimmed)
      return
    }

    const session = get().sessions.find((entry) => entry.file === file)
    const workspacePath = get().workspace?.path ?? ''
    if (session && session.cwd && !samePath(session.cwd, workspacePath)) {
      get().showToast('Open that project to rename the conversation', 'warning')
      return
    }

    const previous = get().activeSessionFile
    try {
      await window.pi.runtime.request('switch_session', { sessionPath: file })
      await window.pi.runtime.request('set_session_name', { name: trimmed })
    } catch (error) {
      set({ error: messageOf(error) })
    } finally {
      if (previous) {
        try {
          await window.pi.runtime.request('switch_session', { sessionPath: previous })
        } catch {
          /* the previous session may have been removed in the meantime */
        }
      }
      await get().refreshState()
      await get().refreshSessions()
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
    // `/name <text>` renames the conversation instead of reaching the agent.
    if (trimmed === '/name' && !images.length) {
      get().showToast('Type the new name after /name', 'warning')
      return
    }
    const rename = /^\/name\s+([\s\S]+)$/.exec(trimmed)
    if (rename && !images.length) {
      await get().renameSession(rename[1].trim())
      return
    }
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

  /**
   * Walk through the models Pi offers.
   *
   * The list is Pi's own, so the order is the one the model picker shows —
   * a shortcut and a click lead to the same place.
   */
  async cycleModel(direction = 1) {
    const { models, piState } = get()
    if (models.length === 0) {
      get().showToast('Pi did not report any models', 'warning')
      return
    }
    if (models.length === 1) {
      get().showToast(`Only ${models[0].name || models[0].id} is available`, 'warning')
      return
    }
    const current = models.findIndex((model) => model.id === piState?.model?.id)
    // A model that is not in the list — a scoped one, say — has no place in
    // the cycle, so the walk starts at the first or the last entry.
    const start = current === -1 ? (direction === 1 ? -1 : 0) : current
    const next = models[(start + direction + models.length) % models.length]
    await get().setModel(next)
    get().showToast(`Model: ${next.name || next.id}`)
  },

  async cycleThinkingLevel(direction = 1) {
    const { thinkingLevels, piState } = get()
    if (thinkingLevels.length === 0) {
      get().showToast('This model has no reasoning levels', 'warning')
      return
    }
    if (thinkingLevels.length === 1) {
      get().showToast(`Reasoning effort: ${thinkingLevels[0]}`, 'warning')
      return
    }
    const current = thinkingLevels.indexOf(piState?.thinkingLevel ?? '')
    const start = current === -1 ? (direction === 1 ? -1 : 0) : current
    const next = thinkingLevels[(start + direction + thinkingLevels.length) % thinkingLevels.length]
    await get().setThinkingLevel(next)
    get().showToast(`Reasoning effort: ${next}`)
  },

  async compact(instructions) {
    try {
      const payload: Record<string, unknown> = {}
      if (instructions?.trim()) payload.customInstructions = instructions.trim()
      await window.pi.runtime.request('compact', payload, 180_000)
      await get().refreshState()
      // The summary Pi wrote is an entry of the session, so the thread has
      // to read it again — otherwise the conversation on screen still shows
      // the messages that were just folded away.
      await get().reloadMessages()
      get().showToast('The conversation was summarised')
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async setAutoCompaction(enabled) {
    try {
      await window.pi.runtime.request('set_auto_compaction', { enabled })
      await get().refreshState()
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async setSteeringMode(mode) {
    try {
      await window.pi.runtime.request('set_steering_mode', { mode })
      await get().refreshState()
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async setFollowUpMode(mode) {
    try {
      await window.pi.runtime.request('set_follow_up_mode', { mode })
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
      if (state?.sessionFile) {
        set({ activeSessionFile: state.sessionFile })
        void get().rememberSession(state.sessionFile)
      }
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  /**
   * Remember which conversation was open in a project.
   *
   * The next start of the app opens it again, so the user does not lose the
   * thread of the work they were in the middle of.
   */
  async rememberSession(file) {
    const workspace = get().workspace
    if (!workspace || !file) return
    const last = get().settings.lastSessions ?? {}
    if (last[workspace.path] === file) return
    const settings = await window.pi.settings.patch({
      lastSessions: { ...last, [workspace.path]: file }
    })
    set({ settings })
  },

  async reloadMessages() {
    if (get().isStreaming) return
    try {
      const data = await window.pi.runtime.request<{ messages: AgentMessage[] }>('get_messages')
      set({ items: itemsFromMessages(data?.messages ?? []) })
      await get().refreshForkTargets()
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async refreshCommands() {
    try {
      const data = await window.pi.runtime.request<{ commands?: PiCommand[] }>('get_commands')
      // The app's own commands come first — they are few, and they are the
      // ones the desktop app is for.
      set({ commands: [...APP_COMMANDS, ...(data?.commands ?? [])] })
    } catch {
      set({ commands: APP_COMMANDS })
    }
  },

  /** Run one of the commands the app itself provides. */
  async runAppCommand(name: string) {
    switch (name) {
      case 'export':
        await get().exportSession()
        break
      case 'duplicate':
        await get().duplicateSession()
        break
      case 'branch': {
        const targets = get().forkTargets
        const last = targets[targets.length - 1]
        if (!last) {
          get().showToast('There is no prompt to branch from yet', 'warning')
          break
        }
        await get().forkFrom(last.entryId)
        break
      }
      case 'compact':
        await get().compact()
        break
      case 'copy': {
        const text = lastAssistantText(get().items)
        if (!text) {
          get().showToast('There is no answer to copy yet', 'warning')
          break
        }
        try {
          await navigator.clipboard.writeText(text)
          get().showToast('The last answer was copied')
        } catch {
          get().showToast('The clipboard is not available', 'error')
        }
        break
      }
      case 'changes':
      case 'files':
        // The inspector lives in the app shell, so it is asked for directly.
        window.dispatchEvent(
          new CustomEvent<InspectorRequest>('pi:open-inspector', { detail: { tab: name } })
        )
        break
      case 'new':
        await get().newChat()
        break
      default:
        break
    }
  },

  async updateSettings(patch) {
    const settings = await window.pi.settings.patch(patch)
    set({ settings })
    applyAppearance(settings, get().info?.forcedTheme)
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

  async togglePin(file) {
    const pinned = get().settings.pinnedSessions ?? []
    const wasPinned = pinned.includes(file)
    const next = wasPinned
      ? pinned.filter((entry) => entry !== file)
      : [...pinned, file]
    const settings = await window.pi.settings.patch({ pinnedSessions: next })
    set({ settings })
    const name = get().sessions.find((session) => session.file === file)?.name
    get().showToast(
      wasPinned ? `${name ?? 'Conversation'} unpinned` : `${name ?? 'Conversation'} pinned to the top`
    )
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
  },

  insertIntoComposer(text, mode = 'append') {
    const trimmed = text.trim()
    if (!trimmed) return
    // A trailing space is kept when there is one, so the user can go on
    // typing right after the text that was put in.
    const addition = text.endsWith(' ') ? `${trimmed} ` : trimmed
    set((state) => ({
      composerInsert: {
        text: addition,
        seq: (state.composerInsert?.seq ?? 0) + 1,
        mode
      }
    }))
  },

  async duplicateSession() {
    if (get().status.phase !== 'ready') return
    const origin =
      get().piState?.sessionName ||
      get().sessions.find((session) => session.file === get().activeSessionFile)?.preview ||
      'Conversation'
    try {
      const result = await window.pi.runtime.request<{ cancelled?: boolean }>('clone')
      if (result?.cancelled) {
        get().showToast('The duplicate was cancelled', 'warning')
        return
      }
      await get().refreshState()
      await get().reloadMessages()
      await get().refreshForkTargets()
      // The copy would carry the same name, which makes the two hard to tell
      // apart in the list.
      const short = origin.length > 44 ? `${origin.slice(0, 43)}…` : origin
      await window.pi.runtime.request('set_session_name', { name: `${short} · copy` })
      await get().refreshSessions()
      get().showToast('Conversation duplicated')
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async refreshForkTargets() {
    try {
      const data = await window.pi.runtime.request<{ messages?: ForkTarget[] }>('get_fork_messages')
      set({ forkTargets: data?.messages ?? [] })
    } catch {
      set({ forkTargets: [] })
    }
  },

  async forkFrom(entryId) {
    if (get().forking) return
    if (get().isStreaming) {
      get().showToast('Wait for the current turn to finish before branching', 'warning')
      return
    }
    const originSession = get().sessions.find((session) => session.file === get().activeSessionFile)
    const origin = originSession?.name || originSession?.preview || ''
    set({ forking: true })
    try {
      const result = await window.pi.runtime.request<{ text?: string; cancelled?: boolean }>('fork', {
        entryId
      })
      if (result?.cancelled) {
        get().showToast('The branch was cancelled', 'warning')
        return
      }
      // The fork opens a new session file, so everything that points at the
      // old one has to be refreshed.
      await get().refreshState()
      await get().reloadMessages()
      await get().refreshForkTargets()
      await get().refreshSessions()
      // Two conversations that start with the same prompt are hard to tell
      // apart in the sidebar, so the branch gets a name of its own.
      const label = (origin || result?.text || 'Conversation').trim()
      const short = label.length > 44 ? `${label.slice(0, 43)}…` : label
      await window.pi.runtime.request('set_session_name', { name: `${short} · branch` })
      await get().refreshSessions()
      // Pi forks *before* the message, so the prompt comes back as text for
      // the user to tweak and send again.
      const prompt = result?.text?.trim()
      if (prompt) get().insertIntoComposer(prompt, 'replace')
      get().showToast('Branched into a new conversation')
    } catch (error) {
      set({ error: messageOf(error) })
    } finally {
      set({ forking: false })
    }
  },

  async abortRetry() {
    try {
      await window.pi.runtime.request('abort_retry')
      set({ retry: undefined })
      get().showToast('Pi stopped retrying')
    } catch (error) {
      set({ error: messageOf(error) })
    }
  }
}))

// Development aid: the screenshot harness drives the store to reach states
// that are hard to produce on purpose, such as a retry in progress.
if (typeof window !== 'undefined' && (window as { __piDesktopDev?: unknown }).__piDesktopDev) {
  ;(window as unknown as { __piDesktopStore?: typeof useAppStore }).__piDesktopStore = useAppStore
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function applyAppearance(
  settings: AppSettings,
  forcedTheme?: 'light' | 'dark' | 'system'
): void {
  const root = document.documentElement
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  // A development flag can force the theme for one run. The stored setting
  // stays untouched, so the app goes back to the user's theme afterwards.
  const theme = forcedTheme ?? settings.theme
  const dark = theme === 'dark' || (theme === 'system' && prefersDark)
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
      // The prompt of this turn is a new branch point. Refreshing here as
      // well as on `message_start` covers the case where Pi had not recorded
      // the message yet when the event arrived.
      void get().refreshForkTargets()
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
    case 'auto_retry_start': {
      // Pi retries a transient failure on its own. The notice keeps the
      // history; the state behind it is what the banner and its button use.
      set((state) => ({
        items: applyEvent(state.items, event),
        retry: {
          attempt: Number(event.attempt ?? 1),
          maxAttempts: Number(event.maxAttempts ?? 0),
          delayMs: Number(event.delayMs ?? 0),
          errorMessage: typeof event.errorMessage === 'string' ? event.errorMessage : undefined
        }
      }))
      break
    }
    case 'auto_retry_end':
      set((state) => ({ items: applyEvent(state.items, event), retry: undefined }))
      break
    case 'message_start': {
      set((state) => ({ items: applyEvent(state.items, event) }))
      // A new prompt is a new place the branch can be forked from.
      const role = (event as { message?: { role?: string } }).message?.role
      if (role === 'user') void get().refreshForkTargets()
      break
    }
    case 'message_end':
    case 'message_update':
    case 'tool_execution_start':
    case 'tool_execution_update':
    case 'tool_execution_end':
    case 'bash_execution_update':
    case 'compaction_start':
    case 'compaction_end':
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
