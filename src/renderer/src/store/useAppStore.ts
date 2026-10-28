import { create } from 'zustand'
import type {
  AgentMessage,
  AppInfo,
  AppSettings,
  ExtensionUiRequest,
  ExtensionUiResponse,
  ForkTarget,
  GitCommitResult,
  GitStatus,
  InspectorRequest,
  ModelInfo,
  PiCommand,
  PiEvent,
  PiState,
  RuntimeStatus,
  SessionMeta,
  SessionSearchHit,
  SessionStats,
  Workspace
} from '@shared/types'
import {
  applyEvent,
  itemsFromMessages,
  lastAssistantText,
  markAborted,
  nextId,
  nextOrder,
  type ThreadItem
} from '../lib/thread'
import { basename, resolveAgainst, samePath } from '../lib/path'
import { collectProjects } from '../lib/projects'
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

/**
 * A conversation-search hit the reader asked to be taken to.
 *
 * The thread owns the DOM, so the request travels through the store: the
 * sidebar sets it, the thread scrolls to the message and clears it again.
 */
export interface PendingJump {
  file: string
  role: SessionSearchHit['role']
  snippet: string
  query: string
  seq: number
}

/**
 * What the run is doing, derived from the events that actually arrived.
 *
 * The statuses are exported from a single rule: a blocking dialog the agent
 * is waiting on wins, then a retry, then any running tool, then text that is
 * actually streaming, then the model itself. Pi allows parallel tool calls,
 * so this is not "the current tool".
 *
 * Every one of these is reachable from real traffic; none is a UI timer.
 * `queued` is the window between the client handing Pi a prompt and Pi
 * opening the run, `generating` means assistant deltas are arriving, and
 * `waiting_approval` means the agent is blocked on an extension dialog.
 */
export type RunPhase =
  | 'idle'
  | 'queued'
  | 'working'
  | 'generating'
  | 'tool_running'
  | 'waiting_approval'
  | 'retrying'
  | 'aborting'

export interface RunState {
  phase: RunPhase
  /** Client-minted id of the run, set on `agent_start`. */
  runId?: string
  /** Client-minted id of the current turn, set on `turn_start`. */
  turnId?: string
  /** Number of turns the current run has gone through. */
  turns: number
  /** When the run started, for the elapsed counter. */
  startedAt?: number
  /** Wall-clock duration of the finished run, once it settled. */
  durationMs?: number
  /** True once the run finished on purpose (completed or aborted). */
  settled: boolean
  /** How the run ended, when it settled. */
  outcome?: 'completed' | 'aborted'
}

const IDLE_RUN: RunState = { phase: 'idle', turns: 0, settled: true }

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
  /**
   * The execution Pi is running, as far as the client can tell.
   *
   * `working` covers "the model is answering"; `tool_running` is only set
   * while at least one tool call is actually executing. Nothing here
   * pretends to know what Pi does internally.
   */
  run: RunState
  /**
   * Whether the event channel to the Pi process is alive.
   *
   * A lost transport is not a failed run: Pi may still be working. Only
   * `agent_settled` (or an abort the user asked for) settles the run.
   */
  transport: 'connected' | 'disconnected'
  /** Set while Pi is retrying a failed request on its own. */
  retry?: {
    attempt: number
    maxAttempts: number
    delayMs: number
    errorMessage?: string
  }
  error?: string
  toast?: { text: string; level: 'info' | 'warning' | 'error' }
  /** Branch and working tree of the open project, when it is a git repo. */
  git?: GitStatus
  /** Bumped when the app asks the review panel to open its commit dialog. */
  commitRequest: number
  /** A message the thread has been asked to scroll to and flash. */
  pendingJump?: PendingJump
  /**
   * A project the user asked for while a run was going. The run is never
   * ended for it: the switch happens once `agent_settled` arrives.
   */
  pendingProject?: { path: string; name: string }

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
  closeWorkspace: () => Promise<void>
  /**
   * Make the project at `path` the active one and run Pi there.
   *
   * `allowWhileRunning` is for a *deliberate* project change (a picked folder,
   * a worktree, the launcher). A project row in the sidebar only expands and
   * collapses, so it never has to ask, and expanding never ends a run.
   */
  switchProject: (path: string, options?: { allowWhileRunning?: boolean }) => Promise<void>
  /**
   * Make the project at `path` the active one without ending a run that is
   * still going: the conversation stays on screen, and the project is opened
   * once the run settles.
   */
  queueProjectSwitch: (path: string) => Promise<void>
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
  /** Execute a shell command inline in the thread via Pi's `bash` RPC. */
  runInlineBash: (command: string, excludeFromContext?: boolean) => Promise<void>
  stop: () => Promise<void>
  /** Clear queued steering / follow-up messages, optionally restoring them to the editor. */
  clearQueue: (restoreToEditor?: boolean) => Promise<void>
  setModel: (model: ModelInfo) => Promise<void>
  setThinkingLevel: (level: string) => Promise<void>
  /** Switch to the next model of Pi's list, or to the previous one. */
  cycleModel: (direction?: 1 | -1) => Promise<void>
  /** Move to the next reasoning effort, or to the previous one. */
  cycleThinkingLevel: (direction?: 1 | -1) => Promise<void>
  /** Compact the context, optionally with instructions for the summary. */
  compact: (instructions?: string) => Promise<void>
  setAutoCompaction: (enabled: boolean) => Promise<void>
  setAutoRetry: (enabled: boolean) => Promise<void>
  /** How steering messages are delivered: one at a time or all at once. */
  setSteeringMode: (mode: 'all' | 'one-at-a-time') => Promise<void>
  /** How follow-up messages are delivered: one at a time or all at once. */
  setFollowUpMode: (mode: 'all' | 'one-at-a-time') => Promise<void>
  refreshState: () => Promise<void>
  refreshInfo: () => Promise<void>
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
  /** Read the branch and the working tree of the open project. */
  refreshGit: () => Promise<void>
  /**
   * Commit the staged files, or — with `includeUnstaged` — stage everything
   * first and commit the whole working tree. Also refreshes the git state.
   */
  commitChanges: (message: string, includeUnstaged?: boolean) => Promise<GitCommitResult>
  /** Move one file into (or out of) the index and refresh the git state. */
  stageFile: (file: string) => Promise<GitCommitResult>
  unstageFile: (file: string) => Promise<GitCommitResult>
  stageAll: () => Promise<GitCommitResult>
  unstageAll: () => Promise<GitCommitResult>
  pushGit: () => Promise<GitCommitResult>
  pullGit: () => Promise<GitCommitResult>
  /** Ask the review panel to open its commit dialog. */
  requestCommit: () => void
  /** Open the conversation of a search hit and take the reader to the message. */
  openSearchHit: (hit: SessionSearchHit, query: string) => Promise<void>
  /** The thread found the message (or gave up); forget the request. */
  consumeJump: () => void
}

const DEFAULT_SETTINGS: AppSettings = {
  workspaces: [],
  pinnedSessions: [],
  theme: 'dark',
  language: 'en',
  fontScale: 1,
  diffSplit: false,
  drawerWidth: 420,
  trustProject: true,
  desktopNotifications: true
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

/**
 * The project of a queued switch, kept outside the store: the queue is
 * checked from inside the store's own callbacks, and a state field would make
 * every one of those reads depend on the last render.
 */
let pendingProjectPath: string | undefined

/** The name a project is shown with, for a folder the user has not opened yet. */
function projectNameOf(state: AppStore, path: string): string {
  const known = collectProjects(state.settings.workspaces, state.sessions).find((project) =>
    samePath(project.path, path)
  )
  return known?.name ?? basename(path) ?? path
}

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
  commitRequest: 0,
  uiStatuses: [],
  uiWidgets: [],
  run: IDLE_RUN,
  transport: 'connected',

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
      if (status.phase === 'ready') {
        // A fresh process means a fresh event channel, whatever happened to
        // the previous one.
        set({ transport: 'connected' })
        void get().refreshCommands()
      }
      if (status.phase === 'stopped' || status.phase === 'error') {
        // The Pi process is gone. That is a lost transport, not proof that
        // the run failed, so the run state is left for the events to settle.
        set({ transport: 'disconnected' })
      }
    })

    await get().refreshSessions()

    const active = settings.workspaces.find((w) => w.id === settings.activeWorkspaceId)
    const target = active ?? settings.workspaces[0]
    if (target) {
      // The project is reopened so Pi is ready where the user works, but the
      // conversation is not: a start stays a new chat. The last conversation is
      // still remembered for the next one and offered by name on the welcome
      // screen, and a click there is the reader asking for it.
      await get().openWorkspace(target)
    }
  },

  async pickWorkspace() {
    const workspace = await window.pi.workspaces.pick()
    if (!workspace) return
    // Picking a folder is an explicit request for a new project: it may
    // replace the running one, unlike a click that only wanted to look.
    await get().switchProject(workspace.path, { allowWhileRunning: true })
  },

  async closeWorkspace() {
    drainPending()
    pendingProjectPath = undefined
    set({ pendingProject: undefined })
    await window.pi.runtime.stop()
    const settings = await window.pi.settings.patch({ activeWorkspaceId: undefined })
    set({ workspace: undefined, items: [], status: { phase: 'stopped' }, settings })
  },

  async switchProject(path, options) {
    const current = get().workspace
    const same = Boolean(current && samePath(current.path, path))
    // Opening a project replaces the Pi process, and with it the session that
    // is open — a run in it would be killed. Only a switch the user asked for
    // explicitly may do that; anything else waits for the run to settle.
    if (get().isStreaming && !options?.allowWhileRunning) {
      await get().queueProjectSwitch(path)
      return
    }
    if (same) {
      if (pendingProjectPath) {
        // A queued switch is moot if the same project is opened right now.
        pendingProjectPath = undefined
        set({ pendingProject: undefined })
      }
      return
    }
    pendingProjectPath = undefined
    set({ pendingProject: undefined })
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

  async queueProjectSwitch(path) {
    pendingProjectPath = path
    set({ pendingProject: { path, name: projectNameOf(get(), path) } })
    get().showToast(
      'The project opens when this run is done — stop it first to switch right away',
      'warning'
    )
  },

  async openWorkspace(workspace, sessionFile) {
    // The previous project's process is about to be replaced; events that
    // were still queued for a frame belong to it. A queued switch is what
    // brought the app here, so it is dropped rather than waiting for a run
    // this project has not started.
    drainPending()
    pendingProjectPath = undefined
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
      composerText: undefined,
      git: undefined,
      pendingJump: undefined,
      pendingProject: undefined,
      run: IDLE_RUN,
      transport: 'connected',
      retry: undefined
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
    await get().refreshGit()
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
    // Events that were still waiting for a frame belong to the conversation
    // that is being left behind; painting them into the new one would mix
    // two sessions in one thread.
    drainPending()
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
      if (get().status.phase !== 'ready') {
        await get().openWorkspace(workspace, session.file)
        return
      }
      try {
        await window.pi.runtime.request('switch_session', { sessionPath: session.file })
        await get().refreshState()
        await get().reloadMessages()
      } catch {
        // If switch_session failed (e.g. transport died), reboot Pi with this session.
        await get().openWorkspace(workspace, session.file)
      }
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
      drainPending()
      set({ items: [], activeSessionFile: undefined, stats: undefined, run: IDLE_RUN })
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
    // `!cmd` and `!!cmd` run a shell command inline via Pi's `bash` RPC.
    // `!cmd` enters the model's context; `!!cmd` stays out of context.
    if (!images.length && trimmed.startsWith('!')) {
      const excludeFromContext = trimmed.startsWith('!!')
      const command = (excludeFromContext ? trimmed.slice(2) : trimmed.slice(1)).trim()
      if (!command) {
        get().showToast(
          excludeFromContext ? 'Type a shell command after !!' : 'Type a shell command after !',
          'warning'
        )
        return
      }
      await get().runInlineBash(command, excludeFromContext)
      return
    }
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
      else {
        // A prompt handed to a settled runtime is queued: Pi has the message
        // and has not opened the run yet. This is the only honest source for
        // the `queued` phase — there is no timer and no guess. The response
        // below says which of the three things actually happened.
        set((state) => ({
          run: state.run.settled
            ? { ...state.run, phase: 'queued', settled: false }
            : state.run
        }))
      }
      // An extension command can block on a dialog, and Pi only answers the
      // prompt once the command is done. The deadline has to outlast that.
      const result = await window.pi.runtime.request<{ disposition?: string }>(
        'prompt',
        payload,
        900_000
      )
      // Pi reports what it did with the prompt: `handled` means an extension
      // or input handler consumed it and no model turn follows, `started`
      // means it accepted the prompt to start a run, and `queued` means it is
      // holding the message for a run that is already going. The phase has to
      // follow that answer rather than stay on the optimistic `queued`.
      if (result?.disposition === 'handled') {
        set((state) => ({
          run: state.run.phase === 'queued' ? { ...state.run, phase: 'idle', settled: true } : state.run,
          items: applyEvent(state.items, {
            type: 'client_notice',
            level: 'info',
            text: `Pi handled ${trimmed} directly — no model turn was needed`
          })
        }))
      } else if (result?.disposition === 'started') {
        // A run is opening. `agent_start` confirms it; until then this is the
        // truth, and it keeps the row from reading "Queued" for a run that is
        // already on its way.
        set((state) => ({
          run:
            state.run.phase === 'queued'
              ? { ...state.run, phase: 'working', startedAt: state.run.startedAt ?? Date.now() }
              : state.run
        }))
      } else if (result?.disposition !== 'queued') {
        // No run was opened and Pi did not say it queued the message, so the
        // optimistic phase must not be left standing.
        set((state) => ({
          run: state.run.phase === 'queued' ? { ...state.run, phase: 'idle', settled: true } : state.run
        }))
      }
    } catch (error) {
      // The prompt never reached Pi, so a run it was shown as queued for
      // must not stay open.
      set((state) => ({
        error: messageOf(error),
        run: state.run.phase === 'queued' ? { ...state.run, phase: 'idle', settled: true } : state.run
      }))
    }
  },

  async runInlineBash(command, excludeFromContext = false) {
    const trimmed = command.trim()
    if (!trimmed) return
    const id = `inline-bash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    // Events that were still waiting for a frame belong to the conversation
    // before this command; they must not land after it.
    drainPending()
    const entry: ThreadItem = {
      id,
      kind: 'bash',
      command: trimmed,
      output: '',
      excludeFromContext,
      timestamp: Date.now(),
      order: nextOrder()
    }
    set((state) => ({ items: [...state.items, entry] }))
    try {
      const result = await window.pi.runtime.request<{
        output?: string
        exitCode?: number
        cancelled?: boolean
      }>('bash', { command: trimmed, id, excludeFromContext }, 600_000)
      set((state) => ({
        items: state.items.map((item) =>
          item.kind === 'bash' && item.id === id
            ? {
                ...item,
                output: typeof result?.output === 'string' ? result.output : item.output,
                exitCode: typeof result?.exitCode === 'number' ? result.exitCode : 0
              }
            : item
        )
      }))
      void get().refreshState()
      void get().refreshGit()
    } catch (error) {
      const message = messageOf(error)
      set((state) => ({
        items: state.items.map((item) =>
          item.kind === 'bash' && item.id === id
            ? {
                ...item,
                output: item.output ? `${item.output}\n${message}` : message,
                exitCode: 1
              }
            : item
        )
      }))
    }
  },

  async stop() {
    // The abort is real: `abort` ends the run in Pi. What is *not* assumed
    // here is that it already happened — the run state only settles when
    // `agent_settled` says so, and anything still moving is marked aborted
    // then rather than now.
    try {
      const removed = await window.pi.runtime.request<{ steering: string[]; followUp: string[] }>(
        'clear_queue'
      )
      set({ queue: { steering: [], followUp: [] } })
      const restored = [...(removed?.steering ?? []), ...(removed?.followUp ?? [])]
        .map((entry) => entry.trim())
        .filter(Boolean)
        .join('\n')
      if (restored) {
        get().insertIntoComposer(restored)
      }
      await window.pi.runtime.request('abort')
      // The abort was accepted. The run is shown as stopping until Pi
      // confirms it, so the button cannot be pressed into a state the
      // runtime does not know about yet.
      set((state) => ({
        run: { ...state.run, phase: 'aborting' }
      }))
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async clearQueue(restoreToEditor = false) {
    try {
      const removed = await window.pi.runtime.request<{ steering: string[]; followUp: string[] }>(
        'clear_queue'
      )
      set({ queue: { steering: [], followUp: [] } })
      if (restoreToEditor) {
        const restored = [...(removed?.steering ?? []), ...(removed?.followUp ?? [])]
          .map((entry) => entry.trim())
          .filter(Boolean)
          .join('\n')
        if (restored) {
          get().insertIntoComposer(restored)
        }
      }
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

  async setAutoRetry(enabled) {
    try {
      await window.pi.runtime.request('set_auto_retry', { enabled })
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

  async refreshInfo() {
    try {
      const info = await window.pi.app.info()
      set({ info })
    } catch {
      /* ignore */
    }
  },

  /**
   * Remember which conversation was open in a project.
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
      case 'commit':
        // Both the panel and the dialog belong to the shell: open the panel,
        // then bump the request the panel watches.
        window.dispatchEvent(
          new CustomEvent<InspectorRequest>('pi:open-inspector', {
            detail: { tab: 'changes' }
          })
        )
        get().requestCommit()
        break
      case 'terminal':
        window.dispatchEvent(new CustomEvent('pi:toggle-terminal'))
        break
      case 'tree':
        window.dispatchEvent(new CustomEvent('pi:open-session-tree'))
        break
      case 'mcp':
        window.dispatchEvent(new CustomEvent('pi:open-mcp'))
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
    // Answering unblocks the agent, so the "waiting for you" phase is given
    // back to whatever the run was doing before the dialog opened.
    set((state) => ({
      uiRequest: undefined,
      run:
        state.run.phase === 'waiting_approval'
          ? { ...state.run, phase: 'working' }
          : state.run
    }))
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
  },

  async refreshGit() {
    try {
      set({ git: await window.pi.git.status() })
    } catch {
      // A folder that is not a repository is a normal state, not an error.
      set({ git: undefined })
    }
  },

  async commitChanges(message, includeUnstaged = false) {
    const result = await window.pi.git.commit(message, includeUnstaged)
    if (result.ok) {
      get().showToast(result.hash ? `Committed ${result.hash}` : 'Changes committed')
      // The dialog closes on the commit itself; the branch chip and the
      // review panel catch up in the background rather than holding it open.
      void get().refreshGit()
    }
    // A failed commit is reported by the dialog inline, which keeps the
    // message and the file list in front of the reader.
    return result
  },

  async stageFile(file) {
    const result = await window.pi.git.stageFile(file)
    if (!result.ok) {
      get().showToast(result.error ?? 'The file could not be staged', 'error')
      return result
    }
    await get().refreshGit()
    return result
  },

  async unstageFile(file) {
    const result = await window.pi.git.unstageFile(file)
    if (!result.ok) {
      get().showToast(result.error ?? 'The file could not be unstaged', 'error')
      return result
    }
    await get().refreshGit()
    return result
  },

  async stageAll() {
    const result = await window.pi.git.stageAll()
    if (!result.ok) {
      get().showToast(result.error ?? 'The files could not be staged', 'error')
      return result
    }
    await get().refreshGit()
    return result
  },

  async unstageAll() {
    const result = await window.pi.git.unstageAll()
    if (!result.ok) {
      get().showToast(result.error ?? 'The files could not be unstaged', 'error')
      return result
    }
    await get().refreshGit()
    return result
  },

  async pushGit() {
    const result = await window.pi.git.push()
    if (!result.ok) {
      get().showToast(result.error ?? 'Could not push branch', 'error')
      return result
    }
    await get().refreshGit()
    get().showToast('Pushed to remote')
    return result
  },

  async pullGit() {
    const result = await window.pi.git.pull()
    if (!result.ok) {
      get().showToast(result.error ?? 'Could not pull branch', 'error')
      return result
    }
    await get().refreshGit()
    get().showToast('Pulled latest changes')
    return result
  },

  requestCommit() {
    set((state) => ({ commitRequest: state.commitRequest + 1 }))
  },

  async openSearchHit(hit, query) {
    const known = get().sessions.find((entry) => entry.file === hit.file)
    const session: SessionMeta = known ?? {
      id: hit.sessionId,
      file: hit.file,
      cwd: hit.cwd,
      name: hit.name,
      preview: hit.preview,
      updatedAt: hit.updatedAt,
      messageCount: 0
    }
    try {
      // Another project's conversation is opened first; the thread of that
      // project is the one the jump belongs to. A run in the current one is
      // never ended for a search hit — the reader asked to look, not to stop.
      if (get().activeSessionFile !== hit.file) {
        if (get().isStreaming) {
          get().showToast('Stop the current run to open another conversation', 'warning')
          return
        }
        await get().selectSession(session)
      }
      set((state) => ({
        pendingJump: {
          file: hit.file,
          role: hit.role,
          snippet: hit.snippet,
          query,
          seq: (state.pendingJump?.seq ?? 0) + 1
        }
      }))
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  consumeJump() {
    set({ pendingJump: undefined })
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

export function applyAppearance(
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

  const remove = (prop: string) => {
    if (typeof root.style?.removeProperty === 'function') {
      root.style.removeProperty(prop)
    } else if (typeof root.style?.setProperty === 'function') {
      root.style.setProperty(prop, '')
    }
  }

  // Tone
  if (settings.themeTone && settings.themeTone !== 'neutral') {
    root.dataset.tone = settings.themeTone
  } else {
    delete root.dataset.tone
  }

  // Accent color
  if (settings.accentColor) {
    root.style.setProperty('--accent', settings.accentColor)
    root.style.setProperty('--focus-ring', settings.accentColor)
    root.style.setProperty('--accent-hover', `color-mix(in srgb, var(--accent) 88%, ${dark ? '#ffffff' : '#000000'})`)
    root.style.setProperty('--accent-soft', `color-mix(in srgb, var(--accent) 15%, transparent)`)
    root.style.setProperty('--accent-line', `color-mix(in srgb, var(--accent) 35%, transparent)`)
    root.style.setProperty('--accent-glow', `0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent)`)
  } else {
    remove('--accent')
    remove('--focus-ring')
    remove('--accent-hover')
    remove('--accent-soft')
    remove('--accent-line')
    remove('--accent-glow')
  }

  // Custom Background
  if (settings.customBg) {
    root.style.setProperty('--surface-canvas', settings.customBg)
    root.style.setProperty('--surface-raised', settings.customBg)
    root.style.setProperty('--surface-overlay', settings.customBg)
    root.style.setProperty('--bg', settings.customBg)
    root.style.setProperty('--surface-chrome', `color-mix(in srgb, var(--surface-canvas) 92%, ${dark ? '#000000' : '#e8e8e8'})`)
    root.style.setProperty('--chrome-bg', `color-mix(in srgb, var(--surface-canvas) 90%, ${dark ? '#000000' : '#e0e0e0'})`)
    root.style.setProperty('--sidebar-bg', `color-mix(in srgb, var(--surface-canvas) 94%, ${dark ? '#000000' : '#f0f0f0'})`)
    root.style.setProperty('--surface-sunken', `color-mix(in srgb, var(--surface-canvas) 85%, ${dark ? '#000000' : '#dedede'})`)
    root.style.setProperty('--bg-hover', `color-mix(in srgb, var(--surface-canvas) 88%, ${dark ? '#ffffff' : '#000000'})`)
    root.style.setProperty('--bg-active', `color-mix(in srgb, var(--surface-canvas) 80%, ${dark ? '#ffffff' : '#000000'})`)
  } else {
    remove('--surface-canvas')
    remove('--surface-raised')
    remove('--surface-overlay')
    remove('--bg')
    remove('--surface-chrome')
    remove('--chrome-bg')
    remove('--sidebar-bg')
    remove('--surface-sunken')
    remove('--bg-hover')
    remove('--bg-active')
  }

  // Custom Foreground
  if (settings.customFg) {
    root.style.setProperty('--text-primary', settings.customFg)
    root.style.setProperty('--text', settings.customFg)
    root.style.setProperty('--text-secondary', `color-mix(in srgb, var(--text-primary) 68%, transparent)`)
    root.style.setProperty('--text-tertiary', `color-mix(in srgb, var(--text-primary) 48%, transparent)`)
    root.style.setProperty('--text-muted', `color-mix(in srgb, var(--text-primary) 58%, transparent)`)
    root.style.setProperty('--text-faint', `color-mix(in srgb, var(--text-primary) 36%, transparent)`)
  } else {
    remove('--text-primary')
    remove('--text')
    remove('--text-secondary')
    remove('--text-tertiary')
    remove('--text-muted')
    remove('--text-faint')
  }

  // Custom Font
  if (settings.fontFamily && settings.fontFamily !== 'system') {
    const fontMap: Record<string, string> = {
      sans: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      chinese: "'PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif",
      mono: "'JetBrains Mono', 'SF Mono', 'Cascadia Code', Consolas, monospace",
      serif: "'Newsreader', 'Georgia', 'Songti SC', 'SimSun', serif"
    }
    const mapped = fontMap[settings.fontFamily]
    const fontVal =
      mapped ??
      (settings.fontFamily.includes(',') || settings.fontFamily.includes('"') || settings.fontFamily.includes("'")
        ? settings.fontFamily
        : `"${settings.fontFamily}", sans-serif`)
    root.style.setProperty('--font-ui', fontVal)
    root.style.setProperty('--font-sidebar', fontVal)
  } else {
    remove('--font-ui')
    remove('--font-sidebar')
  }

  void window.pi.app.setTheme(dark ? 'dark' : 'light')
}

type SetState = (partial: Partial<AppStore> | ((state: AppStore) => Partial<AppStore>)) => void
type GetState = () => AppStore

/* ------------------------------------------------------------------ *
 * Event ingestion
 *
 * Pi emits events as fast as the model streams. Redrawing the whole
 * transcript on every delta is what makes a long answer stutter, so the
 * events are folded into the store immediately — the store is the truth —
 * while the paint is held back to one batch per animation frame. The batch
 * window is a frame, not a timer: a slow machine paints less often, but it
 * never paints more often than it can.
 * ------------------------------------------------------------------ */

/**
 * The run/turn context an event belongs to.
 *
 * `agent_start` opens a run and `turn_start` a turn inside it. Both are
 * client-minted ids: Pi's protocol has neither, and a run is not a turn —
 * a run survives a retry, a turn does not.
 */
function runContextOf(get: GetState): { sessionKey: string; runId?: string; turnId?: string } {
  const state = get()
  return {
    sessionKey: state.activeSessionFile ?? state.piState?.sessionFile ?? state.piState?.sessionId ?? '',
    runId: state.run.runId,
    turnId: state.run.turnId
  }
}

/**
 * Write the transcript once per frame.
 *
 * The reducer runs on every event, so the store always holds the current
 * thread; only the *paint* is deferred. Everything else (run phase, queue,
 * retry banner) is written straight through, because those are one-line
 * updates that do not walk the transcript.
 */
function scheduleItems(
  set: SetState,
  get: GetState,
  event: PiEvent,
  flushImmediately = false
): void {
  const context = runContextOf(get)
  const apply = () => set((state) => ({ items: applyEvent(state.items, event, context) }))
  if (flushImmediately || typeof requestAnimationFrame !== 'function') {
    apply()
    return
  }
  pending.push(apply)
  if (pending.length === 1) scheduleFlush()
}

/** Reducers waiting for the next frame. */
const pending: (() => void)[] = []
let flushHandle: number | null = null

/** Apply every queued reducer now, in the order the events arrived. */
function drainPending(): void {
  if (flushHandle !== null) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(flushHandle)
    flushHandle = null
  }
  const batch = pending.splice(0, pending.length)
  for (const apply of batch) apply()
}

function scheduleFlush(): void {
  if (flushHandle !== null) return
  flushHandle = requestAnimationFrame(() => {
    flushHandle = null
    const batch = pending.splice(0, pending.length)
    for (const apply of batch) apply()
  })
}

/**
 * The phase to show once a lower-priority event stops being the reason.
 *
 * A tool ending, a retry finishing or a prompt being handed over must not
 * stomp on a state that outranks it — an agent blocked on a dialog is still
 * blocked while a sibling tool reports its result.
 */
function phaseFor(state: AppStore, next: RunPhase): RunPhase {
  if (state.run.phase === 'aborting') return 'aborting'
  if (state.uiRequest) return 'waiting_approval'
  return next
}

function handleEvent(set: SetState, get: GetState, event: PiEvent): void {
  switch (event.type) {
    case 'agent_start': {
      // One run per prompt. A follow-up prompt that arrives while a run is
      // active does not open a second one: Pi folds it into the current run.
      const startedAt = Date.now()
      set((state) => ({
        isStreaming: true,
        run: state.run.phase === 'idle' || state.run.settled
          ? {
              phase: 'working',
              runId: nextId('run'),
              turns: 0,
              startedAt,
              settled: false
            }
          : { ...state.run, phase: phaseFor(state, 'working'), settled: false }
      }))
      break
    }
    case 'turn_start':
      set((state) => ({
        isStreaming: true,
        run: state.run.runId
          ? {
              ...state.run,
              turnId: nextId('turn'),
              turns: state.run.turns + 1,
              phase: phaseFor(state, 'working'),
              settled: false
            }
          : { ...state.run, phase: 'working', settled: false }
      }))
      break
    case 'agent_end':
      // `agent_end` is not the end of the work: Pi may retry, compact or
      // continue on its own. The run stays open until it settles.
      set((state) => ({ isStreaming: true, run: { ...state.run, settled: false } }))
      break
    case 'agent_settled': {
      // The one authoritative "the runtime is done" signal.
      const aborted = Boolean(event.aborted)
      // Anything still waiting for a frame is applied first: the final
      // state has to be the state the events actually produced.
      drainPending()
      const state = get()
      const startedAt = state.run.startedAt
      set({
        isStreaming: false,
        items: aborted ? markAborted(state.items) : state.items,
        run: {
          ...state.run,
          phase: 'idle',
          settled: true,
          outcome: aborted ? 'aborted' : 'completed',
          durationMs: startedAt ? Date.now() - startedAt : undefined
        },
        retry: undefined,
        // Pi resolves a dialog on its own when its timeout expires. The
        // client is not told, so the dialog is closed when the agent moves on.
        uiRequest: state.uiRequest ? undefined : state.uiRequest
      })
      void get().refreshState()
      void get().refreshSessions()
      // The agent just edited files, so the branch chip and the review panel
      // should hear about the new working tree.
      void get().refreshGit()
      // The prompt of this turn is a new branch point. Refreshing here as
      // well as on `message_start` covers the case where Pi had not recorded
      // the message yet when the event arrived.
      void get().refreshForkTargets()
      // A project the user asked for while the agent was working is opened
      // now that nothing is running in the current one.
      if (pendingProjectPath) {
        const target = pendingProjectPath
        pendingProjectPath = undefined
        set({ pendingProject: undefined })
        void get().switchProject(target)
      }
      break
    }
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
        run: { ...state.run, phase: 'retrying', settled: false },
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
      scheduleItems(set, get, event)
      set((state) => ({
        retry: undefined,
        run: { ...state.run, phase: 'working', settled: false }
      }))
      break
    case 'message_start': {
      const role = (event as { message?: { role?: string } }).message?.role
      scheduleItems(set, get, event)
      if (role === 'user') {
        set((state) => ({
          run:
            state.run.phase === 'idle' || state.run.settled
              ? // A prompt that started a run before the client saw `agent_start`
                // still needs one, or the items would belong to no run.
                {
                  phase: 'working',
                  runId: nextId('run'),
                  turns: 0,
                  startedAt: Date.now(),
                  settled: false
                }
              : state.run
        }))
        // A new prompt is a new place the branch can be forked from.
        void get().refreshForkTargets()
      }
      break
    }
    case 'bash_execution_update': {
      // A command typed into the terminal drawer runs through the same RPC
      // command, but it belongs to the terminal rather than to the thread.
      if (typeof event.id === 'string' && event.id.startsWith('terminal-')) break
      scheduleItems(set, get, event)
      break
    }
    case 'message_end':
    case 'message_update':
    case 'tool_execution_start':
    case 'tool_execution_update':
    case 'tool_execution_end':
    case 'compaction_start':
    case 'compaction_end':
    case 'extension_error':
    case 'client_notice': {
      scheduleItems(set, get, event)
      // The run phase is exported from what the transcript actually holds:
      // a tool that started means one is running, and the run only goes back
      // to "the model is answering" when none is left.
      if (event.type === 'tool_execution_start') {
        set((state) => ({ run: { ...state.run, phase: 'tool_running', settled: false } }))
      }
      if (event.type === 'tool_execution_end') {
        // The batch has not been painted yet, so the check looks at what the
        // reducer produced rather than at the items on screen.
        const probe: ThreadItem[] = applyEvent(get().items, event, runContextOf(get))
        const still = probe.some((item) => item.kind === 'tool' && item.status === 'running')
        set((state) => ({
          run: {
            ...state.run,
            phase: phaseFor(state, still ? 'tool_running' : 'working'),
            settled: false
          }
        }))
      }
      // Assistant text arriving is the only evidence that the model is
      // actually producing words right now, as opposed to still being
      // waited on. A tool call or a thinking delta does not count.
      if (event.type === 'message_update') {
        const payload = event.assistantMessageEvent as { type?: string } | undefined
        const delta = payload?.type === 'text_delta' || payload?.type === 'text_start'
        if (delta) {
          set((state) => ({
            run: { ...state.run, phase: phaseFor(state, 'generating'), settled: false }
          }))
        }
      }
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
      // A new request supersedes any dialog that is still open. The agent is
      // blocked on the answer until it is given, so the run says so: this is
      // the one real "waiting for the user" state the runtime exposes.
      set((state) => ({
        uiRequest: request,
        run: { ...state.run, phase: phaseFor(state, 'waiting_approval') }
      }))
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
