import { create } from 'zustand'
import type {
  AgentMessage,
  AgentMode,
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
import type { ProviderProfile, SaveProviderInput } from '@shared/providers'
import { modelsFromProfiles, resolveSavedModel, selectableModels } from '@shared/provider-models'
import {
  applyEvent,
  itemsFromMessages,
  lastAssistantText,
  markAborted,
  nextId,
  nextOrder,
  type ThreadItem
} from '../lib/thread'
import { basename, normalisePathKey, resolveAgainst, samePath } from '../lib/path'
import { collectProjects, type Project } from '../lib/projects'
import { APP_COMMANDS } from '../lib/app-commands'
import { hydrationStale, scopeEvent, scopeStatus } from '../lib/session-scope'
import { clearScrollMemory, migrateScrollMemory } from '../lib/scroll-memory'
import { beginStream } from '../lib/stream-events'
import { migrateViewState } from '../lib/view-state'

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
  /** How the run ended, when it settled. `failed` means the last answer ended in error. */
  outcome?: 'completed' | 'aborted' | 'failed'
}

const IDLE_RUN: RunState = { phase: 'idle', turns: 0, settled: true }

export interface RetryState {
  attempt: number
  maxAttempts: number
  delayMs: number
  retryAt: number
  errorMessage?: string
}

/** One conversation's transcript and run, kept even when it is not on screen. */
export interface SessionThread {
  items: ThreadItem[]
  run: RunState
  isStreaming: boolean
  transport: 'connected' | 'disconnected'
  uiRequest?: ExtensionUiRequest
  uiStatuses: UiStatusEntry[]
  uiWidgets: UiWidgetEntry[]
  uiTitle?: string
  queue: { steering: string[]; followUp: string[] }
  retry?: RetryState
  piState?: PiState
  stats?: SessionStats
  error?: string
  status: RuntimeStatus
  forkTargets: ForkTarget[]
  agentMode: AgentMode
  models: ModelInfo[]
  thinkingLevels: string[]
  commands: PiCommand[]
  version: number
}

const THREAD_KEYS = [
  'items',
  'run',
  'isStreaming',
  'transport',
  'uiRequest',
  'uiStatuses',
  'uiWidgets',
  'uiTitle',
  'queue',
  'retry',
  'piState',
  'stats',
  'error',
  'status',
  'forkTargets',
  'agentMode',
  'models',
  'thinkingLevels',
  'commands'
] as const

function emptyThread(cwd?: string): SessionThread {
  return {
    items: [],
    run: IDLE_RUN,
    isStreaming: false,
    transport: 'connected',
    uiStatuses: [],
    uiWidgets: [],
    queue: { steering: [], followUp: [] },
    status: { phase: 'ready', cwd },
    forkTargets: [],
    agentMode: 'default',
    models: [],
    thinkingLevels: [],
    commands: APP_COMMANDS,
    version: 0
  }
}

function viewKeyOf(state: { activeSessionFile?: string; draftId?: string }): string {
  return state.activeSessionFile || state.draftId || ''
}

function mintDraft(): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return `draft:${id}`
}

export interface AppStore {
  info?: AppInfo
  settings: AppSettings
  workspace?: Workspace
  sessions: SessionMeta[]
  status: RuntimeStatus
  agentMode: AgentMode
  setAgentMode: (mode: AgentMode) => Promise<void>
  isStreaming: boolean
  piState?: PiState
  models: ModelInfo[]
  /**
   * Models read from the saved provider list. The picker uses these when the
   * live process has not loaded the latest providers, including in cold chats.
   */
  catalogModels: ModelInfo[]
  disabledModelSpecs: string[]
  thinkingLevels: string[]
  commands: PiCommand[]
  stats?: SessionStats
  items: ThreadItem[]
  /** Transcript and run of every conversation, keyed by file path or draft id. */
  threads: Record<string, SessionThread>
  /** Conversation that has not been given a file yet. */
  draftId?: string
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
  retry?: RetryState
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
  pendingProject?: { path: string | null; name: string }

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

  /** Project edit / create dialog state */
  projectDialog: { open: boolean; mode: 'create' | 'edit'; project?: Project } | null
  openProjectDialog: (options?: { mode?: 'create' | 'edit'; project?: Project }) => void
  closeProjectDialog: () => void

  bootstrap: () => Promise<void>
  openWorkspace: (
    workspace: Workspace | undefined,
    sessionFile?: string,
    sourceAction?: string
  ) => Promise<void>
  pickWorkspace: () => Promise<void>
  closeWorkspace: () => Promise<void>
  /**
   * Make the project at `path` the active one and run Pi there.
   *
   * `allowWhileRunning` is for a *deliberate* project change (a picked folder,
   * a worktree, the launcher). A project row in the sidebar only expands and
   * collapses, so it never has to ask, and expanding never ends a run.
   */
  switchProject: (path: string | null, options?: { allowWhileRunning?: boolean }) => Promise<void>
  /**
   * Make the project at `path` the active one without ending a run that is
   * still going: the conversation stays on screen, and the project is opened
   * once the run settles.
   */
  queueProjectSwitch: (path: string | null) => Promise<void>
  /** Drop a project from the sidebar, whether or not it was registered. */
  removeWorkspace: (target: { id?: string; path: string }) => Promise<void>
  refreshSessions: () => Promise<void>
  selectSession: (session: SessionMeta, sourceAction?: string) => Promise<void>
  /** Read a cold conversation from disk into its own thread. Does not start Pi. */
  hydrateSession: (file: string) => Promise<void>
  renameSession: (name: string) => Promise<void>
  /** Name a conversation from the list, active or not. */
  renameSessionFile: (file: string, name: string) => Promise<void>
  /** Copy the current conversation into a new one. */
  duplicateSession: () => Promise<void>
  exportSession: () => Promise<void>
  deleteSession: (file: string) => Promise<void>
  newChat: () => Promise<void>
  ensureRuntime: (sessionKey?: string, sourceAction?: string) => Promise<string>
  send: (text: string, images: { data: string; mimeType: string }[], kind?: QueueKind) => Promise<void>
  /** Execute a shell command inline in the thread via Pi's `bash` RPC. */
  runInlineBash: (command: string, excludeFromContext?: boolean) => Promise<void>
  stop: () => Promise<void>
  /** Abort one conversation by its id. Does not abort any other, and does not change the view. */
  stopSession: (sessionKey: string) => Promise<void>
  /** Clear queued steering / follow-up messages, optionally restoring them to the editor. */
  clearQueue: (restoreToEditor?: boolean) => Promise<void>
  setModel: (model: ModelInfo) => Promise<boolean>
  /** Reload the saved provider list used when Pi has not reported models yet. */
  refreshModelCatalog: () => Promise<void>
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
  refreshState: (sessionKey?: string) => Promise<void>
  refreshInfo: () => Promise<void>
  /** Remember the conversation that is open in the current project. */
  rememberSession: (file: string) => Promise<void>
  reloadMessages: (sessionKey?: string) => Promise<void>
  refreshCommands: (sessionKey?: string) => Promise<void>
  /** Run one of the commands the app itself provides. */
  runAppCommand: (name: string) => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  saveProvider: (input: SaveProviderInput) => Promise<{ provider: ProviderProfile; applied: boolean; applyError?: string }>
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
  refreshForkTargets: (sessionKey?: string) => Promise<void>
  /** Start a new branch that keeps the history before `entryId`. */
  forkFrom: (entryId: string) => Promise<void>
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
  permissionMode: 'ask',
  desktopNotifications: true
}

let toastTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribeRuntime: (() => void) | undefined

if (import.meta.hot) {
  import.meta.hot.dispose(() => unsubscribeRuntime?.())
}

/**
 * The project of a queued switch, kept outside the store: the queue is
 * checked from inside the store's own callbacks, and a state field would make
 * every one of those reads depend on the last render.
 */
let pendingProjectPath: string | null | undefined

/**
 * The openWorkspace call that owns the screen.
 *
 * A slower view read must not paint over a newer one. Runtime traffic has
 * its own owner and continues to update background conversations.
 */
let workspaceEpoch = 0
const threadAliases = new Map<string, string>()
/** One restore attempt per conversation and saved model, so a miss does not loop. */
const modelRestoreAttempts = new Set<string>()
/** Conversations whose live process has already been told to retry rate limits. */
const retryArmed = new Set<string>()

function threadKey(key: string): string {
  return threadAliases.get(key) ?? key
}

/** The name a project is shown with, for a folder the user has not opened yet. */
function projectNameOf(state: AppStore, path: string | null): string {
  if (path === null) return 'Work without a project'
  const known = collectProjects(
    state.settings.workspaces,
    state.sessions,
    state.settings.hiddenProjects
  ).find((project) => samePath(project.path, path))
  return known?.name ?? basename(path) ?? path
}

/**
 * Send a Pi command with the view that asked for it.
 *
 * The hint is not part of the RPC record. `uiSessionId` is the JSONL path the
 * sidebar is showing, which is not Pi's `sessionId`.
 */
function tracedRpc<T>(
  uiSessionId: string | undefined,
  command: string,
  payload?: Record<string, unknown>,
  timeoutMs?: number,
  sourceAction?: string
): Promise<T> {
  return window.pi.runtime.request<T>(
    command,
    payload,
    timeoutMs,
    {
      sourceAction: sourceAction ?? command,
      uiSessionId
    },
    uiSessionId
  )
}

export const useAppStore = create<AppStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  sessions: [],
  status: { phase: 'stopped' },
  agentMode: 'default',
  isStreaming: false,
  models: [],
  catalogModels: [],
  disabledModelSpecs: [],
  thinkingLevels: [],
  commands: APP_COMMANDS,
  items: [],
  threads: {},
  queue: { steering: [], followUp: [] },
  forkTargets: [],
  forking: false,
  commitRequest: 0,
  uiStatuses: [],
  uiWidgets: [],
  run: IDLE_RUN,
  transport: 'connected',
  projectDialog: null,

  openProjectDialog(options) {
    set({
      projectDialog: {
        open: true,
        mode: options?.mode ?? (options?.project ? 'edit' : 'create'),
        project: options?.project
      }
    })
  },

  closeProjectDialog() {
    set({ projectDialog: null })
  },

  async setAgentMode(mode) {
    if (get().status.phase !== 'ready') return
    if (get().isStreaming) {
      get().showToast('Stop the current run before changing modes', 'warning')
      return
    }
    const key = viewKeyOf(get())
    try {
      await get().ensureRuntime(key, 'mode-change')
      await tracedRpc(threadKey(key), 'prompt', { message: `/desktop-mode ${mode}` }, undefined, 'mode-change')
      await get().refreshState(threadKey(key))
    } catch (error) {
      bindSet(set, get, key)({ error: messageOf(error) })
    }
  },

  async bootstrap() {
    const [info, settings] = await Promise.all([
      window.pi.app.info(),
      window.pi.settings.get()
    ])
    set({ info, settings })
    applyAppearance(settings, info.forcedTheme)
    void get().refreshModelCatalog()

    // StrictMode can repeat bootstrap while preload's IPC listeners stay alive.
    unsubscribeRuntime?.()
    const offEvent = window.pi.runtime.onEvent((payload) => {
      const scoped = scopeEvent(payload, viewKeyOf(get()))
      if (!scoped) return
      handleEvent(bindSet(set, get, scoped.ownerId), bindGet(get, scoped.ownerId), scoped.event, get, scoped.ownerId)
    })
    const offRekey = window.pi.runtime.onRekey?.((change) => {
      rekeyThread(set, get, change.from, change.to, change.replace)
    })
    const offStatus = window.pi.runtime.onStatus((incoming) => {
      const scoped = scopeStatus(incoming, viewKeyOf(get()))
      if (!scoped) return
      const { ownerId: owner, status } = scoped
      const ownGet = bindGet(get, owner)
      // An intentionally retired idle worker leaves a cold, usable conversation.
      const cold = status.phase === 'stopped' && !status.error && ownGet().run.settled
      const nextStatus = { ...status, cwd: status.cwd ?? ownGet().status.cwd }
      applyRuntimeStatus(bindSet(set, get, owner), cold ? { ...nextStatus, phase: 'ready' } : nextStatus)
      if (status.phase === 'ready') {
        void get().refreshState(owner)
        void get().refreshCommands(owner)
        // Pi skips the wait when retry is off, so a 429 settles the turn at
        // once. Arm it on the live process; the settings file is raised at launch.
        if (!retryArmed.has(owner)) {
          retryArmed.add(owner)
          void tracedRpc(owner, 'set_auto_retry', { enabled: true }, undefined, 'arm-retry').catch(() => {
            retryArmed.delete(owner)
          })
        }
      }
    })

    unsubscribeRuntime = () => {
      offEvent()
      offRekey?.()
      offStatus()
    }

    await get().refreshSessions()

    const active = settings.workspaces.find((w) => w.id === settings.activeWorkspaceId)
    const target = active ?? settings.workspaces[0]
    if (settings.activeWorkspaceId === null) {
      await get().openWorkspace(undefined, undefined, 'restore-projectless')
    } else if (target) {
      // The project is reopened so Pi is ready where the user works, but the
      // conversation is not: a start stays a new chat. The last conversation is
      // still remembered for the next one and offered by name on the welcome
      // screen, and a click there is the reader asking for it.
      await get().openWorkspace(target, undefined, 'restore-project')
    }
  },

  async pickWorkspace() {
    get().openProjectDialog({ mode: 'create' })
  },

  async closeWorkspace() {
    drainPending()
    pendingProjectPath = undefined
    set({ pendingProject: undefined })
    const cwd = get().workspace?.path ?? get().status.cwd ?? ''
    if (typeof window.pi.runtime.stopCwd === 'function') await window.pi.runtime.stopCwd(cwd)
    else if (viewKeyOf(get())) await window.pi.runtime.stop(viewKeyOf(get()))
    const settings = await window.pi.settings.patch({ activeWorkspaceId: null })
    set({ settings })
    await get().openWorkspace(undefined)
  },

  async switchProject(path, options) {
    const epoch = ++workspaceEpoch
    const current = get().workspace
    const same = path === null
      ? !current && get().settings.activeWorkspaceId === null
      : Boolean(current && samePath(current.path, path))
    // Changing the project on screen does not stop a conversation that is
    // still running in this one, or in any other.
    void options
    if (same) {
      if (pendingProjectPath !== undefined) {
        // A queued switch is moot if the same project is opened right now.
        pendingProjectPath = undefined
        set({ pendingProject: undefined })
      }
      return
    }
    pendingProjectPath = undefined
    set({ pendingProject: undefined })
    if (path === null) {
      const settings = await window.pi.settings.patch({ activeWorkspaceId: null })
      if (epoch !== workspaceEpoch) return
      set({ settings })
      await get().openWorkspace(undefined, undefined, 'project-switch')
      return
    }
    const { workspace, settings } = await window.pi.workspaces.add(path)
    if (epoch !== workspaceEpoch) return
    const now = Date.now()
    const workspaces = settings.workspaces.map((item) =>
      samePath(item.path, path) ? { ...item, lastOpenedAt: now } : item
    )
    const next = await window.pi.settings.patch({
      workspaces,
      activeWorkspaceId: workspace.id
    })
    if (epoch !== workspaceEpoch) return
    set({ settings: next })
    applyAppearance(next, get().info?.forcedTheme)
    await get().openWorkspace({ ...workspace, lastOpenedAt: now }, undefined, 'project-switch')
  },

  async queueProjectSwitch(path) {
    pendingProjectPath = path
    set({ pendingProject: { path, name: projectNameOf(get(), path) } })
    get().showToast(
      'The project opens when this run is done — stop it first to switch right away',
      'warning'
    )
  },

  async openWorkspace(workspace, sessionFile, sourceAction = 'project-open') {
    void sourceAction
    const epoch = ++workspaceEpoch
    drainPending()
    pendingProjectPath = undefined
    const cached = sessionFile ? get().threads[sessionFile] : undefined
    const draftId = sessionFile ? undefined : mintDraft()
    const thread = cached ?? emptyThread(workspace?.path)
    const threads = { ...get().threads, [sessionFile ?? draftId!]: thread }
    set({
      workspace,
      threads,
      draftId,
      activeSessionFile: sessionFile,
      error: undefined,
      composerText: undefined,
      git: undefined,
      pendingJump: undefined,
      pendingProject: undefined,
      ...projectThread(thread),
      // Cold is ready to type. The process starts when a message is sent.
      status: thread.version > 0 ? thread.status : { phase: 'ready', cwd: workspace?.path },
      transport: 'connected'
    })
    if (epoch !== workspaceEpoch) return
    await get().refreshSessions()
    if (epoch !== workspaceEpoch) return
    await get().refreshGit()
    if (sessionFile && !cached) void get().hydrateSession(sessionFile)
  },

  async removeWorkspace(target) {
    const current = get().workspace
    const settings = get().settings
    const path = target.path
    if (!path) return
    // Removing a project that is not the active one must not move the user
    // somewhere else; only the project that goes away needs a replacement.
    const wasActive = Boolean(current && samePath(current.path, path))
    const workspaces = settings.workspaces.filter((item) => !samePath(item.path, path))
    const hidden = new Set((settings.hiddenProjects ?? []).map((item) => normalisePathKey(item)))
    hidden.add(normalisePathKey(path))
    const next = await window.pi.settings.patch({
      workspaces,
      hiddenProjects: [...hidden],
      ...(wasActive ? { activeWorkspaceId: workspaces[0]?.id ?? null } : {})
    })
    set({ settings: next })
    applyAppearance(next, get().info?.forcedTheme)
    if (typeof window.pi.runtime.stopCwd === 'function') await window.pi.runtime.stopCwd(path)
    if (!wasActive) return
    const replacement = workspaces[0]
    if (replacement) {
      await get().openWorkspace(replacement, undefined, 'project-remove')
    } else {
      await get().openWorkspace(undefined)
    }
  },

  async refreshSessions() {
    const epoch = workspaceEpoch
    const sessions = await window.pi.sessions.list()
    // A switch that started while this list was being read owns the screen.
    if (epoch !== workspaceEpoch) return
    set({ sessions })
  },

  async selectSession(session, sourceAction = 'sidebar-select') {
    void sourceAction
    const epoch = ++workspaceEpoch
    const workspace = get().workspace
    // Paint anything still queued for the conversation being left. Those
    // reducers name their own owner, so they cannot land in the new view.
    drainPending()
    const cached = get().threads[session.file]
    const thread = cached ?? emptyThread(session.cwd)
    set({
      threads: cached ? get().threads : { ...get().threads, [session.file]: thread },
      draftId: undefined,
      activeSessionFile: session.file,
      error: undefined,
      ...projectThread(thread)
    })
    try {
      if (!session.cwd && (workspace || get().settings.activeWorkspaceId !== null)) {
        const settings = await window.pi.settings.patch({ activeWorkspaceId: null })
        if (epoch !== workspaceEpoch) return
        set({ settings, workspace: undefined })
      } else if (session.cwd && (!workspace || !samePath(session.cwd, workspace.path))) {
        const known = get().settings.workspaces.find((item) => samePath(item.path, session.cwd))
        const target: Workspace = known ?? {
          id: `session-${session.id.slice(0, 8)}`,
          path: session.cwd,
          name: session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? session.cwd,
          lastOpenedAt: Date.now()
        }
        const settings = await window.pi.settings.patch({
          ...(known ? {} : { workspaces: [target, ...get().settings.workspaces] }),
          activeWorkspaceId: target.id
        })
        if (epoch !== workspaceEpoch) return
        set({ settings, workspace: target })
        void get().refreshGit()
      }
      if (!cached || cached.version === 0) await get().hydrateSession(session.file)
    } catch (error) {
      if (get().activeSessionFile === session.file) set({ error: messageOf(error) })
    }
  },

  async hydrateSession(file) {
    const hydrate = window.pi.sessions.hydrate
    if (typeof hydrate !== 'function') return
    const versionAtStart = get().threads[file]?.version ?? 0
    const streaming = get().threads[file]?.isStreaming ?? false
    if (streaming) return
    const messages = await hydrate(file)
    const current = get().threads[file]
    if (!current) return
    if (hydrationStale(versionAtStart, current.version, current.isStreaming)) return
    const next: SessionThread = {
      ...current,
      items: itemsFromMessages(messages ?? []),
      version: current.version + 1
    }
    const threads = { ...get().threads, [file]: next }
    if (get().activeSessionFile === file) set({ threads, ...projectThread(next) })
    else set({ threads })
  },

  async renameSession(name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    const file = get().activeSessionFile
    // A file on disk is renamed on its own worker, or appended cold.
    // That must not start or switch whichever process is on screen.
    if (file) {
      await get().renameSessionFile(file, trimmed)
      return
    }
    try {
      await tracedRpc(get().draftId, 'set_session_name', { name: trimmed }, undefined, 'session-rename')
      set((state) => ({
        piState: state.piState ? { ...state.piState, sessionName: trimmed } : state.piState
      }))
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  /**
   * Name a conversation from the list without opening it.
   * A hot conversation is renamed by its own process. A cold one gets a
   * single `session_info` line, and only when nothing else is writing the file.
   * The project on screen does not matter: renaming never switches a runtime.
   */
  async renameSessionFile(file: string, name: string) {
    const trimmed = name.trim()
    if (!trimmed || !file) return
    try {
      if (typeof window.pi.sessions.rename !== 'function') {
        set({ error: 'Could not rename that conversation' })
        return
      }
      const renamed = await window.pi.sessions.rename(file, trimmed)
      if (!renamed) {
        set({ error: 'Could not rename that conversation' })
        return
      }
      set((state) => ({
        sessions: state.sessions.map((entry) => (entry.file === file ? { ...entry, name: trimmed } : entry)),
        piState:
          state.activeSessionFile === file && state.piState
            ? { ...state.piState, sessionName: trimmed }
            : state.piState
      }))
      await get().refreshSessions()
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async exportSession() {
    const owner = viewKeyOf(get())
    const cwd = get().workspace?.path ?? get().status.cwd
    try {
      const key = await get().ensureRuntime(owner, 'session-export')
      const result = await tracedRpc<{ path?: string }>(key, 'export_html', undefined, undefined, 'session-export')
      const raw = result?.path
      if (!raw) {
        get().showToast('Pi did not report an export file')
        return
      }
      // Pi reports a bare file name relative to the session's working directory.
      const target = resolveAgainst(cwd, raw)
      await window.pi.shell.openPath(target)
      get().showToast(`Exported ${basename(target)}`)
    } catch (error) {
      bindSet(set, get, owner)({ error: messageOf(error) })
    }
  },

  async deleteSession(file: string) {
    const session = get().sessions.find((entry) => entry.file === file)
    try {
      if (typeof window.pi.runtime.stop === 'function') {
        try {
          await window.pi.runtime.stop(file)
        } catch {
          /* a cold conversation has no process */
        }
      }
      const threads = { ...get().threads }
      delete threads[file]
      clearScrollMemory(file)
      if (get().activeSessionFile === file) {
        const draftId = mintDraft()
        const thread = emptyThread(get().workspace?.path)
        threads[draftId] = thread
        set({ threads, draftId, activeSessionFile: undefined, ...projectThread(thread) })
      } else {
        set({ threads })
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
    ++workspaceEpoch
    drainPending()
    const draftId = mintDraft()
    const thread = emptyThread(get().workspace?.path)
    set({
      draftId,
      activeSessionFile: undefined,
      threads: { ...get().threads, [draftId]: thread },
      stats: undefined,
      ...projectThread(thread),
      status: { phase: 'ready', cwd: get().workspace?.path }
    })
  },

  async ensureRuntime(sessionKey = viewKeyOf(get()), sourceAction = 'ensure') {
    const key = threadKey(sessionKey)
    if (!key) throw new Error('Missing conversation id')
    if (typeof window.pi.runtime.ensure !== 'function') return key
    const state = get()
    const thread = state.threads[key]
    const session = state.sessions.find(entry => entry.file === key)
    const fresh = key.startsWith('draft:')
    const ensured = await window.pi.runtime.ensure({
      sessionKey: key,
      cwd: thread?.status.cwd ?? session?.cwd ?? (viewKeyOf(state) === key ? state.workspace?.path : '') ?? '',
      sessionFile: fresh ? undefined : key,
      // A resumed conversation restores its own model and reasoning from Pi.
      model: fresh ? state.settings.model : undefined,
      thinkingLevel: fresh ? state.settings.thinkingLevel : undefined,
      trace: { sourceAction, uiSessionId: key }
    })
    if (!ensured.ok) throw new Error(ensured.error ?? 'Pi did not start')
    return threadKey(key)
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
    let key = viewKeyOf(get())
    if (!key) {
      const draftId = mintDraft()
      const thread = emptyThread(get().workspace?.path)
      set({
        draftId,
        threads: { ...get().threads, [draftId]: thread },
        activeSessionFile: undefined
      })
      key = draftId
    }
    const update = bindSet(set, get, key)
    const ownGet = bindGet(get, key)
    const payload: Record<string, unknown> = { message: trimmed, streamingBehavior: kind }
    if (images.length) payload.images = images
    update((state) => ({
      isStreaming: true,
      run: state.run.settled ? { phase: 'queued', turns: 0, settled: false } : state.run
    }))
    try {
      await get().ensureRuntime(key, 'prompt-send')
      if (ownGet().run.phase === 'aborting' || ownGet().run.outcome === 'aborted') return
      // An extension command can block on a dialog, and Pi only answers the
      // prompt once the command is done. The deadline has to outlast that.
      const result = await tracedRpc<{ disposition?: string; cancelled?: boolean }>(
        threadKey(key),
        'prompt',
        payload,
        900_000,
        'prompt-send'
      )
      // Pi reports what it did with the prompt: `handled` means an extension
      // or input handler consumed it and no model turn follows, `started`
      // means it accepted the prompt to start a run, and `queued` means it is
      // holding the message for a run that is already going. The phase has to
      // follow that answer rather than stay on the optimistic `queued`.
      if (result?.disposition === 'handled') {
        update((state) => ({
          isStreaming: state.run.phase === 'queued' || state.run.phase === 'aborting' ? false : state.isStreaming,
          run: state.run.phase === 'queued' || (result.cancelled && state.run.phase === 'aborting') ? { ...state.run, phase: 'idle', settled: true } : state.run,
          items: result.cancelled ? state.items : applyEvent(state.items, {
            type: 'client_notice',
            level: 'info',
            text: `Pi handled ${trimmed} directly — no model turn was needed`
          })
        }))
      } else if (result?.disposition === 'started') {
        // A run is opening. `agent_start` confirms it; until then this is the
        // truth, and it keeps the row from reading "Queued" for a run that is
        // already on its way.
        update((state) => ({
          run:
            state.run.phase === 'queued'
              ? { ...state.run, phase: 'working', startedAt: state.run.startedAt ?? Date.now() }
              : state.run
        }))
      } else if (result?.disposition !== 'queued') {
        // No run was opened and Pi did not say it queued the message, so the
        // optimistic phase must not be left standing.
        update((state) => ({
          isStreaming: state.run.phase === 'queued' ? false : state.isStreaming,
          run: state.run.phase === 'queued' ? { ...state.run, phase: 'idle', settled: true } : state.run
        }))
      }
    } catch (error) {
      // The prompt never reached Pi, so a run it was shown as queued for
      // must not stay open.
      update((state) => ({
        error: state.run.phase === 'aborting' || state.run.outcome === 'aborted' ? state.error : messageOf(error),
        isStreaming: state.run.phase === 'queued' ? false : state.isStreaming,
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
    const owner = viewKeyOf(get())
    const update = bindSet(set, get, owner)
    const entry: ThreadItem = {
      id,
      kind: 'bash',
      command: trimmed,
      output: '',
      excludeFromContext,
      timestamp: Date.now(),
      order: nextOrder()
    }
    update((state) => ({ items: [...state.items, entry] }))
    try {
      const key = await get().ensureRuntime(owner, 'inline-bash')
      const result = await tracedRpc<{
        output?: string
        exitCode?: number
        cancelled?: boolean
      }>(key, 'bash', { command: trimmed, id, excludeFromContext }, 600_000, 'inline-bash')
      update((state) => ({
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
      void get().refreshState(threadKey(owner))
      if (viewKeyOf(get()) === threadKey(owner)) void get().refreshGit()
    } catch (error) {
      const message = messageOf(error)
      update((state) => ({
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
    await get().stopSession(viewKeyOf(get()))
  },

  async stopSession(sessionKey) {
    // The abort is real: `abort` ends the run in Pi. What is *not* assumed
    // here is that it already happened — the run state only settles when
    // `agent_settled` says so, and anything still moving is marked aborted
    // then rather than now.
    const key = threadKey(sessionKey.trim())
    if (!key) return
    const ownGet = bindGet(get, key)
    const launching = ownGet().status.phase === 'starting'
    const update = bindSet(set, get, key)
    update((state) => ({ run: { ...state.run, phase: 'aborting' } }))
    try {
      if (launching) {
        await window.pi.runtime.stop(key)
        update((state) => ({
          isStreaming: false,
          run: { ...state.run, phase: 'idle', settled: true, outcome: 'aborted' },
          status: { ...state.status, phase: 'ready' },
          transport: 'connected'
        }))
        return
      }
      const removed = await tracedRpc<{ steering: string[]; followUp: string[] }>(
        threadKey(key),
        'clear_queue',
        undefined,
        undefined,
        'user-stop'
      )
      update({ queue: { steering: [], followUp: [] } })
      const restored = [...(removed?.steering ?? []), ...(removed?.followUp ?? [])]
        .map((entry) => entry.trim())
        .filter(Boolean)
        .join('\n')
      if (restored && threadKey(key) === viewKeyOf(get())) {
        get().insertIntoComposer(restored)
      }
      await tracedRpc(threadKey(key), 'abort', undefined, undefined, 'user-stop')
    } catch (error) {
      update({ error: messageOf(error) })
    }
  },

  async clearQueue(restoreToEditor = false) {
    const key = viewKeyOf(get())
    const update = bindSet(set, get, key)
    try {
      const removed = await tracedRpc<{ steering: string[]; followUp: string[] }>(
        key,
        'clear_queue',
        undefined,
        undefined,
        'clear-queue'
      )
      update({ queue: { steering: [], followUp: [] } })
      if (restoreToEditor && viewKeyOf(get()) === threadKey(key)) {
        const restored = [...(removed?.steering ?? []), ...(removed?.followUp ?? [])]
          .map((entry) => entry.trim())
          .filter(Boolean)
          .join('\n')
        if (restored) {
          get().insertIntoComposer(restored)
        }
      }
    } catch (error) {
      update({ error: messageOf(error) })
    }
  },

  async setModel(model) {
    const owner = viewKeyOf(get())
    try {
      const key = await get().ensureRuntime(owner, 'set-model')
      const state = bindGet(get, key)()
      if (!state.models.some(item => item.provider === model.provider && item.id === model.id)) {
        if (!state.run.settled) {
          get().showToast('New models can be selected when the current run finishes', 'warning')
          return false
        }
        await tracedRpc(key, 'prompt', { message: '/desktop-refresh-models' }, undefined, 'refresh-models')
      }
      await tracedRpc(
        key,
        'set_model',
        { provider: model.provider, modelId: model.id },
        undefined,
        'set-model'
      )
      await get().refreshState(threadKey(owner))
      const spec = `${model.provider}/${model.id}`
      if (get().settings.model !== spec || get().settings.provider !== model.provider) {
        const settings = await window.pi.settings.patch({ provider: model.provider, model: spec })
        set({ settings })
      }
      return true
    } catch (error) {
      bindSet(set, get, owner)({ error: messageOf(error) })
      return false
    }
  },

  async refreshModelCatalog() {
    const list = window.pi.providers?.list
    if (typeof list !== 'function') return
    try {
      const profiles = await list()
      if (Array.isArray(profiles)) set({
        catalogModels: modelsFromProfiles(profiles),
        disabledModelSpecs: profiles.filter(profile => !profile.external).flatMap(profile =>
          profile.models.filter(model => model.enabled === false).map(model => `${profile.id}/${model.id}`)
        )
      })
    } catch {
      /* A failed read keeps the last catalog. An empty one is what hides the picker. */
    }
  },

  async setThinkingLevel(level) {
    const owner = viewKeyOf(get())
    try {
      const key = await get().ensureRuntime(owner, 'set-thinking')
      await tracedRpc(key, 'set_thinking_level', { level }, undefined, 'set-thinking')
      await get().refreshState(threadKey(owner))
      if (get().settings.thinkingLevel !== level) {
        const settings = await window.pi.settings.patch({ thinkingLevel: level })
        set({ settings })
      }
    } catch (error) {
      bindSet(set, get, owner)({ error: messageOf(error) })
    }
  },

  /**
   * Walk through the models Pi offers.
   *
   * The same merged list feeds the picker and the shortcut, preserving Pi's
   * order while making providers saved since this process started available.
   */
  async cycleModel(direction = 1) {
    const state = get()
    const models = selectableModels(state.models, state.catalogModels, state.disabledModelSpecs)
    if (models.length === 0) {
      get().showToast('Pi did not report any models', 'warning')
      return
    }
    if (models.length === 1) {
      get().showToast(`Only ${models[0].name || models[0].id} is available`, 'warning')
      return
    }
    const live = state.piState?.model
    const selected = live?.id && live.provider ? live : resolveSavedModel(state.settings.model, state.settings.provider, models)
    const current = models.findIndex((model) => model.id === selected?.id && model.provider === selected?.provider)
    // A model that is not in the list — a scoped one, say — has no place in
    // the cycle, so the walk starts at the first or the last entry.
    const start = current === -1 ? (direction === 1 ? -1 : 0) : current
    const next = models[(start + direction + models.length) % models.length]
    if (await get().setModel(next)) get().showToast(`Model: ${next.name || next.id}`)
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
    const current = thinkingLevels.indexOf(piState?.thinkingLevel ?? get().settings.thinkingLevel ?? '')
    const start = current === -1 ? (direction === 1 ? -1 : 0) : current
    const next = thinkingLevels[(start + direction + thinkingLevels.length) % thinkingLevels.length]
    await get().setThinkingLevel(next)
    get().showToast(`Reasoning effort: ${next}`)
  },

  async compact(instructions) {
    const owner = viewKeyOf(get())
    try {
      const key = await get().ensureRuntime(owner, 'compact')
      const payload: Record<string, unknown> = {}
      if (instructions?.trim()) payload.customInstructions = instructions.trim()
      await tracedRpc(key, 'compact', payload, 180_000, 'compact')
      await get().refreshState(threadKey(owner))
      // The summary Pi wrote is an entry of the session, so the thread has
      // to read it again — otherwise the conversation on screen still shows
      // the messages that were just folded away.
      await get().reloadMessages(threadKey(owner))
      get().showToast('The conversation was summarised')
    } catch (error) {
      bindSet(set, get, owner)({ error: messageOf(error) })
    }
  },

  async setAutoCompaction(enabled) {
    const owner = viewKeyOf(get())
    try {
      const key = await get().ensureRuntime(owner, 'set-auto-compaction')
      await tracedRpc(key, 'set_auto_compaction', { enabled }, undefined, 'set-auto-compaction')
      await get().refreshState(threadKey(owner))
    } catch (error) {
      bindSet(set, get, owner)({ error: messageOf(error) })
    }
  },

  async setAutoRetry(enabled) {
    const owner = viewKeyOf(get())
    try {
      const key = await get().ensureRuntime(owner, 'set-auto-retry')
      await tracedRpc(key, 'set_auto_retry', { enabled }, undefined, 'set-auto-retry')
      await get().refreshState(threadKey(owner))
    } catch (error) {
      bindSet(set, get, owner)({ error: messageOf(error) })
    }
  },

  async setSteeringMode(mode) {
    const owner = viewKeyOf(get())
    try {
      const key = await get().ensureRuntime(owner, 'set-steering')
      await tracedRpc(key, 'set_steering_mode', { mode }, undefined, 'set-steering')
      await get().refreshState(threadKey(owner))
    } catch (error) {
      bindSet(set, get, owner)({ error: messageOf(error) })
    }
  },

  async setFollowUpMode(mode) {
    const owner = viewKeyOf(get())
    try {
      const key = await get().ensureRuntime(owner, 'set-follow-up')
      await tracedRpc(key, 'set_follow_up_mode', { mode }, undefined, 'set-follow-up')
      await get().refreshState(threadKey(owner))
    } catch (error) {
      bindSet(set, get, owner)({ error: messageOf(error) })
    }
  },

  async refreshState(sessionKey = viewKeyOf(get())) {
    if (!sessionKey) return
    const key = threadKey(sessionKey)
    const update = bindSet(set, get, key)
    try {
      const [state, models, levels, stats] = await Promise.all([
        tracedRpc<PiState>(key, 'get_state', undefined, undefined, 'refresh-state'),
        tracedRpc<{ models: ModelInfo[] }>(
          key,
          'get_available_models',
          undefined,
          undefined,
          'refresh-state'
        )
          .then((data) => data?.models ?? [])
          .catch(() => undefined as ModelInfo[] | undefined),
        tracedRpc<{ levels: string[] }>(
          key,
          'get_available_thinking_levels',
          undefined,
          undefined,
          'refresh-state'
        )
          .then((data) => data?.levels ?? [])
          .catch(() => undefined as string[] | undefined),
        tracedRpc<SessionStats>(key, 'get_session_stats', undefined, undefined, 'refresh-state')
          .catch(() => undefined as SessionStats | undefined)
      ])
      if (state?.sessionFile) {
        if (threadKey(key) !== state.sessionFile) rekeyThread(set, get, key, state.sessionFile)
        if (viewKeyOf(get()) === state.sessionFile) void get().rememberSession(state.sessionFile)
      }
      // An empty or failed model list is not a reason to forget the provider.
      // Pi reports nothing while its registry is still loading, and replacing
      // the list with [] is what clears the picker.
      const owner = state?.sessionFile ?? key
      const previousThread = bindGet(get, owner)()
      const nextModels = models && models.length > 0 ? models : previousThread.models
      // A failed read is not "this model has no levels". An empty list is.
      const nextLevels = levels ?? previousThread.thinkingLevels
      bindSet(set, get, owner)({ piState: state, models: nextModels, thinkingLevels: nextLevels, stats })
      // Pi reports no model when its settings have no default and this launch
      // did not pass one. Put the saved model back once the list can name it.
      const saved = resolveSavedModel(
        get().settings.model,
        get().settings.provider,
        nextModels.length > 0 ? nextModels : get().catalogModels
      )
      if (saved && !state?.model?.id && nextModels.some((model) => model.id === saved.id && model.provider === saved.provider)) {
        const attempt = `${owner}:${saved.provider}/${saved.id}`
        if (!modelRestoreAttempts.has(attempt)) {
          modelRestoreAttempts.add(attempt)
          void tracedRpc(
            owner,
            'set_model',
            { provider: saved.provider, modelId: saved.id },
            undefined,
            'restore-model'
          ).then(() => get().refreshState(owner)).catch(() => { /* the chip still shows the saved model */ })
        }
      }
      const savedLevel = get().settings.thinkingLevel
      if (savedLevel && !state?.thinkingLevel && nextLevels.includes(savedLevel)) {
        const attempt = `${owner}:thinking:${savedLevel}`
        if (!modelRestoreAttempts.has(attempt)) {
          modelRestoreAttempts.add(attempt)
          void tracedRpc(owner, 'set_thinking_level', { level: savedLevel }, undefined, 'restore-thinking')
            .then(() => get().refreshState(owner))
            .catch(() => { /* the control still shows the saved level */ })
        }
      }
    } catch (error) {
      update({ error: messageOf(error) })
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
    const epoch = workspaceEpoch
    const workspace = get().workspace
    if (!workspace || !file) return
    const last = get().settings.lastSessions ?? {}
    if (last[workspace.path] === file) return
    const settings = await window.pi.settings.patch({
      lastSessions: { ...last, [workspace.path]: file }
    })
    if (epoch !== workspaceEpoch) return
    set({ settings })
  },

  async reloadMessages(sessionKey = viewKeyOf(get())) {
    const ownGet = bindGet(get, sessionKey)
    if (ownGet().isStreaming) return
    try {
      const data = await tracedRpc<{ messages: AgentMessage[] }>(
        threadKey(sessionKey),
        'get_messages',
        undefined,
        undefined,
        'reload-messages'
      )
      if (ownGet().isStreaming) return
      bindSet(set, get, sessionKey)({ items: itemsFromMessages(data?.messages ?? []) })
      await get().refreshForkTargets(threadKey(sessionKey))
    } catch (error) {
      bindSet(set, get, sessionKey)({ error: messageOf(error) })
    }
  },

  async refreshCommands(sessionKey = viewKeyOf(get())) {
    const update = bindSet(set, get, sessionKey)
    try {
      const data = await tracedRpc<{ commands?: PiCommand[] }>(
        threadKey(sessionKey),
        'get_commands',
        undefined,
        undefined,
        'refresh-commands'
      )
      // The app's own commands come first — they are few, and they are the
      // ones the desktop app is for.
      update({ commands: [...APP_COMMANDS, ...(data?.commands ?? []).filter((command) => command.name !== 'desktop-mode')] })
    } catch {
      update({ commands: APP_COMMANDS })
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

  async saveProvider(input) {
    const key = viewKeyOf(get())
    const result = await window.pi.providers.save(input, key)
    set({ settings: result.settings })
    await get().refreshModelCatalog()
    if (result.applied) await get().refreshState(threadKey(key))
    return result
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
    // Explicit session routing: route to originating sessionKey, preventing misrouting across views.
    const key = request.sessionKey || viewKeyOf(get())
    const currentView = viewKeyOf(get())
    set((state) => {
      const run =
        state.run.phase === 'waiting_approval' ? { ...state.run, phase: 'working' as const } : state.run
      const thread = key ? state.threads[key] : undefined
      const isCurrentView = !key || key === currentView
      return {
        ...(isCurrentView ? { uiRequest: undefined, run } : { uiRequest: undefined }),
        ...(thread
          ? {
              threads: {
                ...state.threads,
                [key]: {
                  ...thread,
                  uiRequest: undefined,
                  run: thread.run.phase === 'waiting_approval' ? { ...thread.run, phase: 'working' as const } : thread.run,
                  version: thread.version + 1
                }
              }
            }
          : {})
      }
    })
    try {
      // Captured before the await. A view change while the reply is in
      // flight must not deliver this approval to the other conversation.
      await window.pi.runtime.respondUi(request.id, response, key)
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
    if (get().isStreaming) {
      get().showToast('Wait for the current turn to finish before duplicating', 'warning')
      return
    }
    const owner = viewKeyOf(get())
    const origin =
      get().piState?.sessionName ||
      get().sessions.find((session) => session.file === get().activeSessionFile)?.preview ||
      'Conversation'
    try {
      const source = await get().ensureRuntime(owner, 'session-clone')
      const result = await tracedRpc<{ cancelled?: boolean; sessionFile?: string }>(
        source,
        'clone',
        undefined,
        undefined,
        'session-clone'
      )
      if (result?.cancelled) {
        get().showToast('The duplicate was cancelled', 'warning')
        return
      }
      const key = result?.sessionFile ?? threadKey(owner)
      await get().refreshState(key)
      await get().reloadMessages(key)
      await get().refreshForkTargets(key)
      // The copy would carry the same name, which makes the two hard to tell
      // apart in the list.
      const short = origin.length > 44 ? `${origin.slice(0, 43)}…` : origin
      await tracedRpc(
        key,
        'set_session_name',
        { name: `${short} · copy` },
        undefined,
        'session-clone'
      )
      await get().refreshSessions()
      get().showToast('Conversation duplicated')
    } catch (error) {
      bindSet(set, get, owner)({ error: messageOf(error) })
    }
  },

  async refreshForkTargets(sessionKey = viewKeyOf(get())) {
    const update = bindSet(set, get, sessionKey)
    try {
      const data = await tracedRpc<{ messages?: ForkTarget[] }>(
        threadKey(sessionKey),
        'get_fork_messages',
        undefined,
        undefined,
        'refresh-fork-targets'
      )
      update({ forkTargets: data?.messages ?? [] })
    } catch {
      update({ forkTargets: [] })
    }
  },

  async forkFrom(entryId) {
    if (get().forking) return
    if (get().isStreaming) {
      get().showToast('Wait for the current turn to finish before branching', 'warning')
      return
    }
    const owner = viewKeyOf(get())
    const originSession = get().sessions.find((session) => session.file === owner)
    const origin = originSession?.name || originSession?.preview || ''
    set({ forking: true })
    try {
      const source = await get().ensureRuntime(owner, 'session-fork')
      const result = await tracedRpc<{ text?: string; cancelled?: boolean; sessionFile?: string }>(
        source,
        'fork',
        { entryId },
        undefined,
        'session-fork'
      )
      if (result?.cancelled) {
        get().showToast('The branch was cancelled', 'warning')
        return
      }
      // The fork opens a new session file, so everything that points at the
      // old one has to be refreshed.
      const key = result?.sessionFile ?? threadKey(owner)
      await get().refreshState(key)
      await get().reloadMessages(key)
      await get().refreshForkTargets(key)
      await get().refreshSessions()
      // Two conversations that start with the same prompt are hard to tell
      // apart in the sidebar, so the branch gets a name of its own.
      const label = (origin || result?.text || 'Conversation').trim()
      const short = label.length > 44 ? `${label.slice(0, 43)}…` : label
      await tracedRpc(
        key,
        'set_session_name',
        { name: `${short} · branch` },
        undefined,
        'session-fork'
      )
      await get().refreshSessions()
      // Pi forks *before* the message, so the prompt comes back as text for
      // the user to tweak and send again.
      const prompt = result?.text?.trim()
      if (prompt && viewKeyOf(get()) === key) get().insertIntoComposer(prompt, 'replace')
      get().showToast('Branched into a new conversation')
    } catch (error) {
      bindSet(set, get, owner)({ error: messageOf(error) })
    } finally {
      set({ forking: false })
    }
  },

  async refreshGit() {
    const epoch = workspaceEpoch
    try {
      const git = await window.pi.git.status()
      if (epoch !== workspaceEpoch) return
      set({ git })
    } catch {
      if (epoch !== workspaceEpoch) return
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
        await get().selectSession(session, 'search-open')
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
      chinese: "'PingFang SC', '苹方', '苹方-简', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif",
      mono: "'JetBrains Mono', 'SF Mono', 'Cascadia Code', Consolas, monospace",
      serif: "'Newsreader', 'Georgia', 'Songti SC', 'SimSun', serif"
    }
    const mapped = fontMap[settings.fontFamily]
    // The installed copy is registered as 苹方; keep both names so either one resolves.
    const pingfang = `"PingFang SC", "苹方", "苹方-简", sans-serif`
    const fontVal =
      mapped ??
      (settings.fontFamily === 'PingFang SC'
        ? pingfang
        : settings.fontFamily.includes(',') || settings.fontFamily.includes('"') || settings.fontFamily.includes("'")
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

function projectThread(thread: SessionThread): Pick<AppStore, (typeof THREAD_KEYS)[number]> {
  return {
    items: thread.items,
    run: thread.run,
    isStreaming: thread.isStreaming,
    transport: thread.transport,
    uiRequest: thread.uiRequest,
    uiStatuses: thread.uiStatuses,
    uiWidgets: thread.uiWidgets,
    uiTitle: thread.uiTitle,
    queue: thread.queue,
    retry: thread.retry,
    piState: thread.piState,
    stats: thread.stats,
    error: thread.error,
    status: thread.status,
    forkTargets: thread.forkTargets,
    agentMode: thread.agentMode ?? 'default',
    models: thread.models ?? [],
    thinkingLevels: thread.thinkingLevels ?? [],
    commands: thread.commands ?? APP_COMMANDS
  }
}

function threadFromPatch(base: SessionThread, patch: Partial<AppStore>): SessionThread {
  const next = { ...base, version: base.version + 1 } as SessionThread
  const record = next as unknown as Record<string, unknown>
  for (const key of THREAD_KEYS) {
    if (key in patch) record[key] = patch[key]
  }
  return next
}

function bindGet(get: GetState, owner: string): GetState {
  return () => {
    const state = get()
    const key = threadKey(owner)
    const thread = state.threads[key]
    if (!thread) return state
    return { ...state, ...projectThread(thread), activeSessionFile: key.startsWith('draft:') ? undefined : key, draftId: key.startsWith('draft:') ? key : undefined }
  }
}

function bindSet(set: SetState, get: GetState, owner: string): SetState {
  return (partial) => {
    const state = get()
    const key = threadKey(owner)
    const base = state.threads[key] ?? emptyThread(state.workspace?.path)
    const patch = typeof partial === 'function' ? partial({ ...state, ...projectThread(base) }) : partial
    const next = threadFromPatch(base, patch)
    const threads = { ...state.threads, ...(key ? { [key]: next } : {}) }
    if (!key || key === viewKeyOf(state)) set({ ...patch, threads })
    else set({ threads })
  }
}

function rekeyThread(
  set: SetState,
  get: GetState,
  from: string,
  to: string,
  replace = false
): void {
  drainPending()
  from = threadKey(from)
  if (from === to) return
  // The reader's place belongs to the conversation, not to whether Pi has
  // written it to disk yet; carry it across the draft→file rename.
  migrateScrollMemory(from, to)
  migrateViewState(from, to)
  for (const [alias, key] of threadAliases) {
    if (key === from) {
      migrateScrollMemory(alias, to)
      migrateViewState(alias, to)
    }
  }
  const state = get()
  const thread = state.threads[from]
  const threads = { ...state.threads }
  if (thread) {
    if (replace || from.startsWith('draft:')) {
      delete threads[from]
      for (const [alias, key] of threadAliases) {
        if (key === from) threadAliases.set(alias, to)
      }
      threadAliases.set(from, to)
    }
    threads[to] = thread
  }
  const viewing = state.draftId === from || state.activeSessionFile === from
  set({
    threads,
    ...(viewing ? { draftId: undefined, activeSessionFile: to } : {})
  })
}

type SetState = (partial: Partial<AppStore> | ((state: AppStore) => Partial<AppStore>)) => void
type GetState = () => AppStore

function applyRuntimeStatus(set: SetState, status: RuntimeStatus): void {
  set({ status })
  if (status.phase === 'error' && status.error) set({ error: status.error })
  if (status.phase === 'ready' || status.phase === 'starting') {
    // A fresh process means a fresh event channel, whatever happened to
    // the previous one. "starting" is that handoff, not a dropped connection.
    set({ transport: 'connected' })
  } else if (status.phase === 'stopped' || status.phase === 'error') {
    // The Pi process is gone. That is a lost transport, not proof that
    // the run failed, so the run state is left for the events to settle.
    set({ transport: 'disconnected' })
  }
}

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
    // The store's own conversation key is the stable thread id: the session
    // file once Pi has written one, or the draft id until then. Pi's session
    // id is not used here because it is not the key the sidebar and the
    // per-thread transcript are stored under.
    sessionKey: viewKeyOf(state),
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
  if (flushImmediately || typeof requestAnimationFrame !== 'function') {
    set((state) => ({ items: applyEvent(state.items, event, context) }))
    return
  }
  const key = viewKeyOf(get())
  const batch = pending.get(key) ?? { set, events: [] }
  batch.events.push({ event, context })
  pending.set(key, batch)
  scheduleFlush()
}

/** Reducers waiting for the next frame. */
const pending = new Map<string, {
  set: SetState
  events: { event: PiEvent; context: ReturnType<typeof runContextOf> }[]
}>()
let flushHandle: number | null = null

/** Apply every queued reducer now, in the order the events arrived. */
function drainPending(): void {
  if (flushHandle !== null) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(flushHandle)
    flushHandle = null
  }
  const batches = [...pending.values()]
  pending.clear()
  for (const batch of batches) {
    batch.set((state) => ({
      items: batch.events.reduce((items, { event, context }) => applyEvent(items, event, context), state.items)
    }))
  }
}

function scheduleFlush(): void {
  if (flushHandle !== null) return
  flushHandle = requestAnimationFrame(() => {
    flushHandle = null
    drainPending()
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

function handleEvent(
  set: SetState,
  get: GetState,
  event: PiEvent,
  realGet?: GetState,
  owner?: string
): void {
  switch (event.type) {
    case 'agent_start': {
      beginStream(runContextOf(get).sessionKey)
      // One run per prompt. A follow-up prompt that arrives while a run is
      // active does not open a second one: Pi folds it into the current run.
      const startedAt = Date.now()
      set((state) => ({
        isStreaming: true,
        retry: undefined,
        run: !state.run.runId || state.run.phase === 'idle' || state.run.settled
          ? {
              phase: phaseFor(state, 'working'),
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
      beginStream(runContextOf(get).sessionKey)
      set((state) => ({
        isStreaming: true,
        retry: undefined,
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
      // `agent_settled` carries only `aborted`; a failure is visible on the
      // last assistant message instead. Do not print a success summary over
      // an error notice.
      const lastAssistant = [...state.items]
        .reverse()
        .find((item) => item.kind === 'assistant')
      const failed = !aborted && lastAssistant?.kind === 'assistant' && lastAssistant.stopReason === 'error'
      set({
        isStreaming: false,
        items: aborted ? markAborted(state.items) : state.items,
        run: {
          ...state.run,
          phase: 'idle',
          settled: true,
          outcome: aborted ? 'aborted' : failed ? 'failed' : 'completed',
          durationMs: startedAt ? Date.now() - startedAt : undefined
        },
        retry: undefined,
        ...(event.runtimeStopped ? { status: { ...state.status, phase: 'ready' as const }, transport: 'connected' as const } : {}),
        // Pi resolves a dialog on its own when its timeout expires. The
        // client is not told, so the dialog is closed when the agent moves on.
        uiRequest: state.uiRequest ? undefined : state.uiRequest
      })
      const key = viewKeyOf(get())
      if (!event.runtimeStopped) void get().refreshState(key)
      void get().refreshSessions()
      // The agent just edited files, so the branch chip and the review panel
      // should hear about the new working tree.
      if (!realGet || viewKeyOf(realGet()) === key) void get().refreshGit()
      // The prompt of this turn is a new branch point. Refreshing here as
      // well as on `message_start` covers the case where Pi had not recorded
      // the message yet when the event arrived.
      if (!event.runtimeStopped) void get().refreshForkTargets(key)
      // A project the user asked for while the agent was working is opened
      // now that nothing is running in the current one.
      const view = realGet ? viewKeyOf(realGet()) : owner
      if (pendingProjectPath !== undefined && (!owner || owner === view)) {
        const target = pendingProjectPath
        pendingProjectPath = undefined
        set({ pendingProject: undefined })
        void (realGet ?? get)().switchProject(target)
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
      // Only Pi's next run/turn event ends the wait; the countdown cannot
      // tell us whether a request has actually started.
      const delayMs = Math.max(0, Number(event.delayMs ?? 0))
      set((state) => ({
        isStreaming: true,
        run: { ...state.run, phase: phaseFor(state, 'retrying'), settled: false },
        retry: {
          attempt: Number(event.attempt ?? 1),
          maxAttempts: Number(event.maxAttempts ?? 0),
          delayMs,
          retryAt: Date.now() + delayMs,
          errorMessage: typeof event.errorMessage === 'string' ? event.errorMessage : undefined
        }
      }))
      break
    }
    case 'auto_retry_end':
      scheduleItems(set, get, event)
      set((state) => ({
        retry: undefined,
        run: { ...state.run, phase: phaseFor(state, 'working'), settled: false }
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
        void get().refreshForkTargets(viewKeyOf(get()))
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
        drainPending()
        const still = get().items.some((item) => item.kind === 'tool' && item.status === 'running')
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
        if (delta && get().run.phase !== phaseFor(get(), 'generating')) {
          set((state) => ({
            run: { ...state.run, phase: phaseFor(state, 'generating'), settled: false }
          }))
        }
      }
      break
    }
    case 'extension_ui_request': {
      handleExtensionUi(set, get, event as unknown as ExtensionUiRequest, owner)
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
  request: ExtensionUiRequest,
  owner?: string
): void {
  const taggedRequest: ExtensionUiRequest = {
    ...request,
    sessionKey: request.sessionKey || (owner ? threadKey(owner) : undefined),
    ownerId: request.ownerId || owner
  }
  switch (taggedRequest.method) {
    case 'select':
    case 'confirm':
    case 'input':
    case 'editor': {
      // A new request supersedes any dialog that is still open. The agent is
      // blocked on the answer until it is given, so the run says so: this is
      // the one real "waiting for the user" state the runtime exposes.
      set((state) => ({
        uiRequest: taggedRequest,
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
      if (key === 'pi-desktop-mode') {
        const mode = request.statusText
        if (mode === 'default' || mode === 'goal' || mode === 'plan') set({ agentMode: mode })
        break
      }
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
