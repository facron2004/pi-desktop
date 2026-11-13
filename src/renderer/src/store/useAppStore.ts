import { create } from 'zustand'
import {
  CONTEXT_BREAKDOWN_STATUS_KEY,
  GENERATION_TIMING_STATUS_KEY,
  SUBAGENT_EDITOR_CANCEL_STATUS_KEY
} from '@shared/types'
import type {
  AgentMessage,
  AgentMode,
  AppInfo,
  AppSettings,
  ContextBreakdown,
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
import type { SessionNotice } from '../lib/session-indicator'
import {
  applyEventBatch,
  applyEvent,
  itemsFromMessages,
  lastAssistantText,
  markAborted,
  nextId,
  nextOrder,
  type ThreadItem
} from '../lib/thread'
import { basename, resolveAgainst, samePath } from '../lib/path'
import { updateThreadSessionName } from '../lib/live-sessions'
import { stripAnsi } from '../lib/ansi'
import { collectProjects, type Project } from '../lib/projects'
import { APP_COMMANDS, normalizeAppCommandInput } from '../lib/app-commands'
import { describeCompactionFailure } from '../lib/compaction-error'
import { hydrationStale, needsSessionHydration, scopeEvent, scopeStatus } from '../lib/session-scope'
import { clearScrollMemory, migrateScrollMemory } from '../lib/scroll-memory'
import { beginStream, finishStream, rekeyStreamState, resetStreamState } from '../lib/stream-events'
import { estimateContextBreakdown, parseRequestContextBreakdown } from '../lib/context-reading'
import { recordModelUse } from '../lib/model-recency'
import { clearViewState, migrateViewState } from '../lib/view-state'
import {
  forgetSessionTiming,
  migrateSessionTiming,
  monotonicNow,
  recordGenerationWindow,
  recordModelDuration,
  recordRunDuration,
  recordToolDuration,
  recordTtftDuration
} from '../lib/session-timing'

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
  /** Active context compaction, which can run outside an assistant turn. */
  compaction?: { reason: string; startedAt: number; startedMonotonicAt: number }
  /** Client-minted id of the run, set on `agent_start`. */
  runId?: string
  /** Client-minted id of the current turn, set on `turn_start`. */
  turnId?: string
  /** Number of turns the current run has gone through. */
  turns: number
  /** When the run started, for the elapsed counter. */
  startedAt?: number
  /** Monotonic start time for duration calculations. */
  startedMonotonicAt?: number
  /** Run-start to first-text TTFT measured in Pi's process. */
  ttftMs?: number
  /** First content token of the current model request, observed by the client. */
  firstTokenAt?: number
  lastTokenAt?: number
  /** Monotonic start of the answer's current generation window. */
  messageGenerationStartedAt?: number
  /**
   * Summed completed generation blocks in this run.
   *
   * A tool-heavy run streams in several answers separated by tool execution;
   * one window across the whole run would count the tool time as model time
   * and make TPS look far slower than the model actually was.
   */
  generationMs?: number
  /** Generation time before the current assistant message began. */
  messageGenerationBaseMs?: number
  /** Monotonic client clock for the current provider response. */
  modelTurnStartedAt?: number
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
  contextBreakdown?: ContextBreakdown
  error?: string
  status: RuntimeStatus
  forkTargets: ForkTarget[]
  agentMode: AgentMode
  models: ModelInfo[]
  thinkingLevels: string[]
  commands: PiCommand[]
  version: number
  /**
   * What the last background run left behind: a failure, or an answer the
   * reader has not seen yet. It is cleared when the conversation is opened,
   * so it only ever marks the rows that are not on screen.
   */
  notice?: SessionNotice
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
  'contextBreakdown',
  'error',
  'status',
  'forkTargets',
  'agentMode',
  'models',
  'thinkingLevels',
  'commands',
  'notice'
] as const

function emptyThread(cwd?: string, agentMode: AgentMode = 'default'): SessionThread {
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
    agentMode,
    models: [],
    thinkingLevels: [],
    commands: APP_COMMANDS,
    version: 0
  }
}

/**
 * The mode a draft shows before Pi boots: the same Plan Mode the runtime seeds for a
 * session it has never written. Pi's `pi-desktop-mode` status stays the authority —
 * this only stops a brand-new chat from claiming Default while the process starts.
 */
function draftMode(settings: AppSettings): AgentMode {
  return settings.defaultPlanMode === true ? 'plan' : 'default'
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
  /** Run a task-mode extension command through the live Pi process. */
  runTaskCommand: (command: string) => Promise<void>
  /**
   * Stop one running or queued subagent task. The id is the `toolCallId:index`
   * the subagent tree shows; a session that is not on screen is targeted by key.
   */
  cancelSubagentTask: (taskId: string, sessionKey?: string) => Promise<void>
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
  contextBreakdown?: ContextBreakdown
  items: ThreadItem[]
  /** Transcript and run of every conversation, keyed by file path or draft id. */
  threads: Record<string, SessionThread>
  /** Conversation that has not been given a file yet. */
  draftId?: string
  queue: { steering: string[]; followUp: string[] }
  activeSessionFile?: string
  /** The conversation column is showing the plugin/skill marketplace or scheduled tasks instead of the thread. */
  deskPage: 'marketplace' | 'scheduled' | null
  setDeskPage: (page: 'marketplace' | 'scheduled' | null) => void
  /** Session file whose historical messages are being hydrated into the view. */
  hydratingSessionFile?: string
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
  /** The mark of the conversation on screen; the sidebar reads the threads. */
  notice?: SessionNotice
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
  /** Hide a conversation from the sidebar. Its file stays on disk, and Settings lists it. */
  archiveSession: (file: string) => Promise<void>
  /** Bring an archived conversation back to the sidebar. */
  restoreSession: (file: string) => Promise<void>
  newChat: () => Promise<void>
  ensureRuntime: (sessionKey?: string, sourceAction?: string) => Promise<string>
  prewarmRuntime: (sessionKey?: string) => void
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
  compact: (instructions?: string) => Promise<boolean>
  setAutoCompaction: (enabled: boolean) => Promise<void>
  setAutoRetry: (enabled: boolean) => Promise<void>
  /** How steering messages are delivered: one at a time or all at once. */
  setSteeringMode: (mode: 'all' | 'one-at-a-time') => Promise<void>
  /** How follow-up messages are delivered: one at a time or all at once. */
  setFollowUpMode: (mode: 'all' | 'one-at-a-time') => Promise<void>
  refreshState: (sessionKey?: string) => Promise<void>
  /**
   * Ask Pi for `get_session_stats` right now.
   *
   * Returns `undefined` when no process is running for that conversation —
   * this never starts one — so the caller can fall back to the transcript.
   */
  readSessionStats: (sessionKey?: string) => Promise<SessionStats | undefined>
  refreshInfo: () => Promise<void>
  /** Remember the conversation that is open in the current project. */
  rememberSession: (file: string) => Promise<void>
  reloadMessages: (sessionKey?: string) => Promise<void>
  refreshCommands: (sessionKey?: string) => Promise<void>
  refreshSkillCommands: (sessionKey?: string) => Promise<void>
  /** Run one of the commands the app itself provides. */
  runAppCommand: (name: string) => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  saveProvider: (input: SaveProviderInput) => Promise<{ provider: ProviderProfile; applied: boolean; applyError?: string }>
  removeProvider: (id: string) => Promise<void>
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
   * Ask for a git read at most once per `delayMs`.
   *
   * The working tree changes while Pi edits, so the review list has to follow
   * a run rather than wait for it to settle. A burst of edits collapses into
   * one trailing read.
   */
  scheduleGitRefresh: (delayMs?: number) => void
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
  projectOrder: [],
  activeWorkspaceId: null,
  pinnedSessions: [],
  theme: 'dark',
  language: 'en',
  fontScale: 1,
  diffSplit: false,
  drawerWidth: 520,
  trustProject: true,
  permissionMode: 'ask',
  desktopNotifications: true,
  memoriesEnabled: true,
  memoryGeneration: true,
  memorySkipExternalContext: true
}

let toastTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribeRuntime: (() => void) | undefined
let bootstrapPromise: Promise<void> | undefined

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
let projectTransitionTarget: string | null | undefined
/**
 * The project that owns the screen, as opposed to the conversation on it.
 *
 * `workspaceEpoch` also moves for view-only changes — a new chat, a sidebar
 * click — so it cannot guard a read that describes the project rather than
 * the view. The conversation list is one of those reads: a new chat while it
 * is in flight must not throw the fresh list away.
 */
let projectEpoch = 0
let sessionListRequest = 0
/** Prevent older Pi state reads from overwriting a newer snapshot per thread. */
let refreshStateRequestSequence = 0
const refreshStateRequests = new Map<string, number>()
let modelCatalogRequestSequence = 0
let agentSettingSelectionInFlight = false
let modelPreferenceSequence = 0
let modelPreferenceValue: string | null | undefined
let thinkingPreferenceSequence = 0
let thinkingPreferenceValue: string | null | undefined
let sessionSettingsQueue: Promise<void> = Promise.resolve()

function queueSessionSettings<T>(operation: () => Promise<T>): Promise<T> {
  const result = sessionSettingsQueue.then(operation, operation)
  sessionSettingsQueue = result.then(() => undefined, () => undefined)
  return result
}

/** How long a burst of file edits waits before one git read of the tree. */
const GIT_REFRESH_DEBOUNCE_MS = 700
let gitRefreshTimer: number | null = null
const HIDDEN_EVENT_FLUSH_MS = 100
let gitStatusRequest = 0

/** A project switch: the view and the project both move. */
function beginProjectChange(target: string | null): number {
  projectTransitionTarget = target
  ++projectEpoch
  return ++workspaceEpoch
}

/** A view-only change: the conversation on screen moves, the project does not. */
function beginViewChange(): number {
  projectTransitionTarget = undefined
  return ++workspaceEpoch
}
const threadAliases = new Map<string, string>()
const threadAliasesByTarget = new Map<string, Set<string>>()
/** One restore attempt per conversation and saved model, so a miss does not loop. */
const modelRestoreAttempts = new Set<string>()
/** Conversations whose live process has already been told to retry rate limits. */
const retryArmed = new Set<string>()
/** Composer-focused sessions whose startup is only speculative until Send. */
const prewarmOnlyRuntimes = new Set<string>()
/** How long a conversation has to stay on screen before Pi is started for it. */
const PREWARM_DELAY_MS = 1000
let scheduledPrewarmTimer: ReturnType<typeof setTimeout> | null = null
let scheduledPrewarmKey: string | null = null
/**
 * A model chosen while the conversation was cold.
 *
 * There is no process to hear `set_model` yet. Starting one just to store the
 * choice is a multi-second cold boot; the next launch reads the saved default
 * and this map applies it to a resumed session before its first prompt.
 */
const pendingModelSelections = new Map<string, { provider: string; id: string }>()

export const MAX_CACHED_INACTIVE_THREADS = 10

const sessionAccessLru: string[] = []

export function touchSessionLru(file: string): void {
  if (!file || file.startsWith('draft:')) return
  const index = sessionAccessLru.indexOf(file)
  if (index !== -1) {
    sessionAccessLru.splice(index, 1)
  }
  sessionAccessLru.push(file)
}

export function forgetSessionLru(file: string): void {
  const index = sessionAccessLru.indexOf(file)
  if (index !== -1) {
    sessionAccessLru.splice(index, 1)
  }
}

export function getSessionAccessLru(): readonly string[] {
  return sessionAccessLru
}

export function enforceSessionLru(
  threads: Record<string, SessionThread>,
  activeKey?: string,
  maxInactive = MAX_CACHED_INACTIVE_THREADS
): Record<string, SessionThread> {
  const activeNormalized = activeKey ? threadKey(activeKey) : undefined

  // Identify loaded inactive threads safe for memory eviction
  const inactiveLoadedKeys: string[] = []
  for (const [key, thread] of Object.entries(threads)) {
    if (key.startsWith('draft:')) continue
    if (key === activeNormalized) continue
    if (thread.version === 0 || thread.items.length === 0) continue
    if (thread.isStreaming) continue
    if (thread.run.phase !== 'idle' && !thread.run.settled) continue
    if (thread.queue.steering.length > 0 || thread.queue.followUp.length > 0) continue
    if (thread.uiRequest) continue
    inactiveLoadedKeys.push(key)
  }

  if (inactiveLoadedKeys.length <= maxInactive) return threads

  const accessOrder = new Map<string, number>()
  sessionAccessLru.forEach((key, index) => accessOrder.set(key, index))
  // Sort candidate inactive keys by LRU (oldest first).
  inactiveLoadedKeys.sort((a, b) => {
    const orderA = accessOrder.get(a) ?? -1
    const orderB = accessOrder.get(b) ?? -1
    return orderA - orderB
  })

  const toEvictCount = inactiveLoadedKeys.length - maxInactive
  const toEvict = new Set(inactiveLoadedKeys.slice(0, toEvictCount))

  let changed = false
  const nextThreads: Record<string, SessionThread> = { ...threads }
  for (const key of toEvict) {
    const thread = threads[key]
    if (thread) {
      nextThreads[key] = {
        ...thread,
        items: [],
        version: 0
      }
      changed = true
    }
    clearViewState(key)
    forgetSessionLru(key)
  }

  return changed ? nextThreads : threads
}

function threadKey(key: string): string {
  return threadAliases.get(key) ?? key
}

function setThreadAlias(alias: string, target: string): void {
  const previous = threadAliases.get(alias)
  if (previous === target) return
  if (previous) {
    const previousAliases = threadAliasesByTarget.get(previous)
    previousAliases?.delete(alias)
    if (previousAliases?.size === 0) threadAliasesByTarget.delete(previous)
  }
  threadAliases.set(alias, target)
  const targetAliases = threadAliasesByTarget.get(target) ?? new Set<string>()
  targetAliases.add(alias)
  threadAliasesByTarget.set(target, targetAliases)
}

function clearThreadAliasesForTarget(target: string): string[] {
  const pending = [target]
  const cleared = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()!
    if (cleared.has(current)) continue
    cleared.add(current)
    const aliases = threadAliasesByTarget.get(current)
    threadAliasesByTarget.delete(current)
    if (!aliases) continue
    for (const alias of aliases) {
      if (threadAliases.get(alias) !== current) continue
      threadAliases.delete(alias)
      pending.push(alias)
    }
  }
  cleared.delete(target)
  return [...cleared]
}

function isCurrentStateRefresh(key: string, request: number): boolean {
  return refreshStateRequests.get(threadKey(key)) === request
}

function stopPrewarmOnlyRuntime(sessionKey: string | undefined): void {
  if (!sessionKey) return
  const key = threadKey(sessionKey)
  const wasPrewarmOnly = prewarmOnlyRuntimes.delete(sessionKey)
  const wasResolvedPrewarmOnly = prewarmOnlyRuntimes.delete(key)
  if (!wasPrewarmOnly && !wasResolvedPrewarmOnly) return
  void window.pi.runtime.stop(key).catch(() => {})
}

function cancelScheduledPrewarm(): void {
  if (scheduledPrewarmTimer !== null) globalThis.clearTimeout(scheduledPrewarmTimer)
  scheduledPrewarmTimer = null
  scheduledPrewarmKey = null
}

/**
 * Start Pi for the conversation that is already on screen, once it has stayed
 * there long enough to be the one the reader is about to type into.
 *
 * Opening a conversation used to wait for the first prompt, so a cold session
 * paid Pi's whole start-up before the model could be asked anything. The
 * process is speculative: it carries the prewarm mark, so moving the view on
 * stops it again unless a run has taken it over.
 *
 * Drafts are left out on purpose. Pi writes a session file as soon as it
 * starts, so prewarming a chat that was never written would leave an empty
 * conversation on disk.
 */
function schedulePrewarm(sessionKey: string | undefined, messageCount: number): void {
  cancelScheduledPrewarm()
  if (!sessionKey || sessionKey.startsWith('draft:')) return
  // An empty session file is nothing to warm: Pi would reopen it only to sit
  // on a blank conversation, and a pending one would show up in the list.
  if (messageCount <= 0) return
  scheduledPrewarmKey = sessionKey
  scheduledPrewarmTimer = globalThis.setTimeout(() => {
    scheduledPrewarmTimer = null
    const key = scheduledPrewarmKey
    scheduledPrewarmKey = null
    if (!key) return
    const state = useAppStore.getState()
    if (viewKeyOf(state) !== key) return
    if (state.threads[key]?.isStreaming) return
    state.prewarmRuntime(key)
  }, PREWARM_DELAY_MS)
  // Node's timer object has unref; a browser's numeric handle does not. Tests
  // run the store in Node, and a pending speculative start must not hold that
  // process open after the last assertion.
  ;(scheduledPrewarmTimer as unknown as { unref?: () => void }).unref?.()
}

/** The name a project is shown with, for a folder the user has not opened yet. */
function projectNameOf(state: AppStore, path: string | null): string {
  if (path === null) return 'Work without a project'
  const known = collectProjects(
    state.settings.workspaces,
    state.sessions,
    state.settings.hiddenProjects,
    state.settings.projectOrder
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

const skillCommandRequests = new Map<string, Promise<void>>()

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
  deskPage: null,
  setDeskPage: (deskPage) => set({ deskPage }),
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
    if (get().isStreaming) {
      get().showToast('Stop the current run before changing modes', 'warning')
      return
    }
    const key = viewKeyOf(get())
    if (!key) {
      get().showToast('Start a conversation first', 'warning')
      return
    }
    const update = bindSet(set, get, key)
    const previous = get().agentMode
    // The runtime boot can take a few seconds on a cold chat. Show the chosen
    // mode immediately so a click never looks like it did nothing; Pi's own
    // status event confirms it when the extension is ready.
    update({ agentMode: mode })
    const sendMode = () => tracedRpc(
      threadKey(key),
      'prompt',
      { message: `/desktop-mode ${mode}` },
      undefined,
      'mode-change'
    )
    const finish = async () => {
      await get().refreshState(threadKey(key))
      await get().refreshCommands(threadKey(key))
    }
    try {
      // Selecting a mode on the welcome screen starts Pi just like sending a
      // message does. The old guard on `status.phase === 'ready'` made the
      // click a silent no-op while the first runtime was still booting.
      await get().ensureRuntime(key, 'mode-change')
      await sendMode()
      await finish()
    } catch (error) {
      let message = messageOf(error)
      // An idle Pi can retain an older extension. If a fresh Pi still rejects
      // the mode, the desktop main process itself needs to be restarted.
      const unknownMode = /\bunknown (?:task )?mode\b/i
      if (unknownMode.test(message)) {
        try {
          await window.pi.runtime.stop(threadKey(key))
          await get().ensureRuntime(key, 'mode-change-reload')
          await sendMode()
          await finish()
          return
        } catch (retry) {
          message = messageOf(retry)
          if (unknownMode.test(message)) {
            message = 'Restart Pi Desktop to load the updated task modes'
          }
        }
      }
      update({ agentMode: previous, error: message })
      get().showToast(message, 'error')
    }
  },

  async runTaskCommand(command) {
    const key = viewKeyOf(get())
    if (!key) return
    try {
      // These go to Pi's extension command path, not the transcript: no
      // optimistic user message and no streaming state. The extension owns
      // the mode or goal mutation and publishes its new state back.
      await get().ensureRuntime(key, 'task-command')
      await tracedRpc(threadKey(key), 'prompt', { message: command }, 900_000, 'task-command')
      await get().refreshState(threadKey(key))
    } catch (error) {
      bindSet(set, get, key)({ error: messageOf(error) })
    }
  },

  async cancelSubagentTask(taskId, sessionKey) {
    const key = sessionKey || viewKeyOf(get())
    if (!key) {
      get().showToast('Start a conversation first', 'warning')
      return
    }
    try {
      // The parent turn is blocked inside the tool call, so the stop travels as
      // the extension command the subagent extension registered. Pi runs an
      // extension command immediately even while the session is streaming.
      await get().ensureRuntime(key, 'subagent-cancel')
      await tracedRpc(threadKey(key), 'prompt', { message: `/desktop-subagent-cancel ${taskId}` }, 30_000, 'subagent-cancel')
    } catch (error) {
      get().showToast(messageOf(error), 'warning')
    }
  },

  bootstrap() {
    if (bootstrapPromise) return bootstrapPromise
    const work = (async () => {
      const settings = await window.pi.settings.get()
      set({ settings })
      const startupTheme = new URLSearchParams(window.location.search).get('piDesktopTheme')
      applyAppearance(
        settings,
        startupTheme === 'light' || startupTheme === 'dark' ? startupTheme : undefined
      )

      // The About page needs a Pi process for its version only; keep that load
      // out of the first conversation's cold start.
      void window.pi.app.info({ includePiVersion: false }).then((info) => {
        set({ info })
        applyAppearance(get().settings, info.forcedTheme)
      }).catch((error: unknown) => {
        console.warn('[pi-desktop] could not load app info:', error)
      })
      void get().refreshModelCatalog()

      // StrictMode replays effects in development. bootstrapPromise above makes
      // this single startup transaction idempotent across that replay.
      unsubscribeRuntime?.()
      const offEvent = window.pi.runtime.onEvent((payload) => {
        const scoped = scopeEvent(payload, viewKeyOf(get()))
        if (!scoped) return
        handleEvent(bindSet(set, get, scoped.ownerId), bindGet(get, scoped.ownerId), scoped.event, get, scoped.ownerId, set)
      })
      const offRekey = window.pi.runtime.onRekey?.((change) => {
        if (prewarmOnlyRuntimes.delete(change.from)) prewarmOnlyRuntimes.add(change.to)
        if (retryArmed.delete(change.from)) retryArmed.add(change.to)
        rekeyThread(set, get, change.from, change.to, change.replace)
      })
      const offStatus = window.pi.runtime.onStatus((incoming) => {
        const scoped = scopeStatus(incoming, viewKeyOf(get()))
        if (!scoped) return
        const { ownerId: owner, status } = scoped
        // Auto-retry is process-local. A newly starting process must be armed
        // again, and a stopped process must not leave a stale session marker.
        if (status.phase === 'starting' || status.phase === 'stopped') retryArmed.delete(owner)
        const ownGet = bindGet(get, owner)
        // An intentionally retired idle worker leaves a cold, usable conversation.
        const cold = status.phase === 'stopped' && !status.error && ownGet().run.settled
        const nextStatus = { ...status, cwd: status.cwd ?? ownGet().status.cwd }
        // A process started only because the conversation stayed on screen has
        // nothing to announce. Its "starting" phase would flash a spinner over
        // a transcript nobody has asked Pi to work on; "ready" lands silently
        // below, and a failure already falls back to ready.
        if (status.phase === 'starting' && prewarmOnlyRuntimes.has(owner)) return
        if (
          (status.phase === 'error' || status.phase === 'stopped') &&
          prewarmOnlyRuntimes.has(owner) &&
          ownGet().run.settled
        ) {
          // A speculative start must not strand the composer in an error state.
          // The real send retries startup and reports its own failure.
          applyRuntimeStatus(bindSet(set, get, owner), { phase: 'ready', cwd: nextStatus.cwd })
          return
        }
        applyRuntimeStatus(bindSet(set, get, owner), cold ? { ...nextStatus, phase: 'ready' } : nextStatus)
        if (status.phase === 'ready') {
          void get().refreshState(owner)
          void get().refreshCommands(owner)
          // Pi skips the wait when retry is off, so a 429 settles the turn at
          // once. Arm it on the live process; the settings file is raised at launch.
          if (!retryArmed.has(owner)) {
            retryArmed.add(owner)
            void tracedRpc(owner, 'set_auto_retry', { enabled: true }, undefined, 'arm-retry').catch(() => {
              retryArmed.delete(threadKey(owner))
            })
          }
        }
      })

      const offSessionsChanged = window.pi.sessions.onChanged?.(({ file, name }) => {
        // A rename happens in the main process (auto-title, a hot or a cold
        // session) and never re-reads the session index by itself. Paint the
        // new name on the row at once, then re-read so a cold `session_info`
        // append reaches every row and the sidebar and title bar agree.
        set((state) => ({
          sessions: state.sessions.map((entry) => (entry.file === file ? { ...entry, name } : entry)),
          threads: updateThreadSessionName(state.threads, file, name),
          piState:
            state.activeSessionFile === file && state.piState
              ? { ...state.piState, sessionName: name }
              : state.piState
        }))
        void get().refreshSessions()
      })

      unsubscribeRuntime = () => {
        offEvent()
        offRekey?.()
        offStatus()
        offSessionsChanged?.()
      }

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
      } else {
        // No saved project can be restored (a fresh profile, or the active
        // project was deleted). A projectless chat is a valid start; leaving
        // the screen without a workspace used to strand the welcome view on a
        // non-functional "open project folder" button.
        await get().openWorkspace(undefined, undefined, 'restore-projectless')
        const nextSettings = await window.pi.settings.patch({ activeWorkspaceId: null })
        if (nextSettings) set({ settings: nextSettings })
      }
    })()
    const guarded = work.catch((error: unknown) => {
      if (bootstrapPromise === guarded) bootstrapPromise = undefined
      set({ error: messageOf(error) })
    })
    bootstrapPromise = guarded
    // The promise only has to deduplicate the StrictMode replay while it is
    // in flight. Once it settles, a later call is a real request to restore
    // the startup state again (for example after reading changed settings).
    void guarded.finally(() => {
      if (bootstrapPromise === guarded) bootstrapPromise = undefined
    })
    return guarded
  },

  async pickWorkspace() {
    get().openProjectDialog({ mode: 'create' })
  },

  async closeWorkspace() {
    const epoch = beginProjectChange(null)
    drainPending()
    pendingProjectPath = undefined
    set({ pendingProject: undefined })
    const cwd = get().workspace?.path ?? get().status.cwd ?? ''
    if (typeof window.pi.runtime.stopCwd === 'function') await window.pi.runtime.stopCwd(cwd)
    else if (viewKeyOf(get())) await window.pi.runtime.stop(viewKeyOf(get()))
    if (epoch !== workspaceEpoch) return
    const settings = await window.pi.settings.patch({ activeWorkspaceId: null })
    if (epoch !== workspaceEpoch) return
    set({ settings })
    await get().openWorkspace(undefined)
  },

  async switchProject(path, options) {
    const current = get().workspace
    const same = path === null
      ? !current && get().settings.activeWorkspaceId === null
      : Boolean(current && samePath(current.path, path))
    const epoch = same ? beginViewChange() : beginProjectChange(path)
    // Changing the project on screen does not stop a conversation that is
    // still running in this one, or in any other.
    void options
    if (same) {
      if (pendingProjectPath !== undefined) {
        // A queued switch is moot if the same project is opened right now.
        pendingProjectPath = undefined
        set({ pendingProject: undefined })
      }
      if (path !== null && current) {
        const { workspace, settings } = await window.pi.workspaces.add(path)
        if (epoch !== workspaceEpoch) return
        const next = settings.activeWorkspaceId === workspace.id
          ? settings
          : await window.pi.settings.patch({ activeWorkspaceId: workspace.id })
        if (epoch !== workspaceEpoch) return
        set({ workspace, settings: next })
        applyAppearance(next, get().info?.forcedTheme)
        await get().refreshSessions()
        if (epoch !== workspaceEpoch) return
        await get().refreshGit()
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
    const currentKey = viewKeyOf(get())
    if (currentKey) touchSessionLru(currentKey)
    stopPrewarmOnlyRuntime(currentKey)
    cancelScheduledPrewarm()
    const epoch = beginProjectChange(workspace?.path ?? null)
    drainPending()
    pendingProjectPath = undefined
    const cached = sessionFile ? get().threads[sessionFile] : undefined
    const shouldHydrate = Boolean(sessionFile && (!cached || cached.version === 0) && !cached?.isStreaming)
    const hydratingSessionFile = shouldHydrate ? sessionFile : undefined
    const draftId = sessionFile ? undefined : mintDraft()
    // Opening a conversation is what clears its mark: the reader has seen it.
    const thread = cached
      ? { ...cached, notice: undefined }
      : emptyThread(workspace?.path)
    if (sessionFile) touchSessionLru(sessionFile)
    const activeKey = sessionFile ?? draftId!
    const threads = enforceSessionLru(
      { ...get().threads, [activeKey]: thread },
      activeKey
    )
    set({
      workspace,
      threads,
      draftId,
      activeSessionFile: sessionFile,
      hydratingSessionFile,
      error: undefined,
      composerText: undefined,
      git: undefined,
      pendingJump: undefined,
      pendingProject: undefined,
      ...projectThread(thread),
      // Cold is ready to type. Focusing the composer starts Pi in the background.
      status: thread.version > 0 ? thread.status : { phase: 'ready', cwd: workspace?.path },
      transport: 'connected'
    })
    if (shouldHydrate && sessionFile) void get().hydrateSession(sessionFile)
    if (epoch !== workspaceEpoch) return
    await get().refreshSessions()
    if (epoch !== workspaceEpoch) return
    // The branch and the change counts are a reading of the folder, not part
    // of restoring the conversation. Reading Git here would put a git process
    // in front of the first frame, so it lands just after the window is up.
    void get().refreshGit()
  },

  async removeWorkspace(target) {
    const path = target.path
    if (!path) return
    const queuedSwitchRemoved = typeof pendingProjectPath === 'string' && samePath(pendingProjectPath, path)
    if (queuedSwitchRemoved) {
      pendingProjectPath = undefined
      set({ pendingProject: undefined })
    }
    const active = get().workspace
    const removesActive = Boolean(active && samePath(active.path, path))
    const removesTransitionTarget =
      typeof projectTransitionTarget === 'string' && samePath(projectTransitionTarget, path)
    // `beginProjectChange` returns the workspace epoch, which also moves for
    // view-only changes. This guard is about the project, so it has to compare
    // the project epoch itself: using the returned value made the replacement
    // branch dead code after any new-chat/sidebar click.
    if (removesActive || queuedSwitchRemoved || removesTransitionTarget) beginProjectChange(path)
    const epoch = projectEpoch
    // Removing a project that is not the active one must not move the user
    // somewhere else; only the project that goes away needs a replacement.
    await window.pi.workspaces.remove(target.id, path)
    const settings = await window.pi.settings.get()
    set({ settings })
    applyAppearance(settings, get().info?.forcedTheme)
    if (epoch !== projectEpoch) return
    const currentWorkspace = get().workspace
    if (!currentWorkspace || !samePath(currentWorkspace.path, path)) return
    if (settings.workspaces.some((workspace) => samePath(workspace.path, path))) return
    const replacement =
      settings.workspaces.find((workspace) => workspace.id === settings.activeWorkspaceId) ?? settings.workspaces[0]
    if (replacement) {
      await get().openWorkspace(replacement, undefined, 'project-remove')
    } else {
      await get().openWorkspace(undefined)
    }
  },

  async refreshSessions() {
    const epoch = projectEpoch
    const request = ++sessionListRequest
    const sessions = await window.pi.sessions.list()
    // The list belongs to the project, not the conversation on screen, so a
    // view change must not invalidate it. The project epoch rejects reads
    // across project switches; the request sequence rejects older same-project
    // scans. A view epoch here made new conversations vanish from the sidebar.
    if (epoch !== projectEpoch || request !== sessionListRequest) return
    set({ sessions })
  },

  async selectSession(session, sourceAction = 'sidebar-select') {
    void sourceAction
    const currentKey = viewKeyOf(get())
    if (currentKey && currentKey !== session.file) touchSessionLru(currentKey)
    cancelScheduledPrewarm()
    if (currentKey !== session.file) stopPrewarmOnlyRuntime(currentKey)
    const workspace = get().workspace
    const changesProject = session.cwd
      ? !workspace || !samePath(session.cwd, workspace.path)
      : Boolean(workspace || get().settings.activeWorkspaceId !== null)
    const epoch = changesProject ? beginProjectChange(session.cwd ?? null) : beginViewChange()
    // Paint anything still queued for the conversation being left. Those
    // reducers name their own owner, so they cannot land in the new view.
    drainPending()
    const cached = get().threads[session.file]
    // Opening a conversation is what clears its mark: the reader has seen it.
    const thread = cached ? { ...cached, notice: undefined } : emptyThread(session.cwd)
    // A conversation Pi has not written to disk yet is still keyed by its
    // draft id (or by the path Pi assigned before flushing). It is a
    // conversation, not a file, so the view follows its own key and nothing
    // here may read that key as a session file.
    const live = session.file.startsWith('draft:')
    const shouldHydrate = !live && needsSessionHydration(
      session.messageCount,
      cached?.version,
      thread.items.length,
      thread.isStreaming
    )
    touchSessionLru(session.file)
    const threads = enforceSessionLru(
      { ...get().threads, [session.file]: thread },
      session.file
    )
    set({
      threads,
      draftId: live ? session.file : undefined,
      activeSessionFile: live ? undefined : session.file,
      hydratingSessionFile: shouldHydrate ? session.file : undefined,
      deskPage: null,
      error: undefined,
      ...projectThread(thread)
    })
    schedulePrewarm(session.file, session.messageCount)
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
          ...(known ? {} : { workspaces: [...get().settings.workspaces, target] }),
          activeWorkspaceId: target.id
        })
        if (epoch !== workspaceEpoch) return
        set({ settings, workspace: target })
        void get().refreshGit()
      }
      // There is no file to replay for a conversation that has none yet; its
      // transcript is the live one the store already holds.
      if (shouldHydrate) await get().hydrateSession(session.file)
    } catch (error) {
      if ((get().activeSessionFile ?? get().draftId) === session.file) {
        set({
          error: messageOf(error),
          ...(get().hydratingSessionFile === session.file ? { hydratingSessionFile: undefined } : {})
        })
      }
    }
  },

  async hydrateSession(file) {
    const hydrate = window.pi.sessions.hydrate
    if (typeof hydrate !== 'function') {
      if (get().hydratingSessionFile === file) set({ hydratingSessionFile: undefined })
      return
    }
    const versionAtStart = get().threads[file]?.version ?? 0
    const streaming = get().threads[file]?.isStreaming ?? false
    if (streaming) {
      if (get().hydratingSessionFile === file) set({ hydratingSessionFile: undefined })
      return
    }
    try {
      const messages = await hydrate(file)
      const current = get().threads[file]
      if (!current) return
      if (hydrationStale(versionAtStart, current.version, current.isStreaming)) {
        // A version bump can come from a status/stats patch that says nothing
        // about the transcript. Only a live transcript that already holds
        // items outranks the disk read; with none, applying it is still right.
        if (current.isStreaming || current.items.length > 0) return
      }
      const next: SessionThread = {
        ...current,
        items: itemsFromMessages(messages ?? []),
        contextBreakdown: current.contextBreakdown?.source === 'request'
          ? current.contextBreakdown
          : estimateContextBreakdown(messages ?? [], current.stats?.contextUsage?.tokens),
        version: current.version + 1
      }
      const rawThreads = { ...get().threads, [file]: next }
      const threads = enforceSessionLru(rawThreads, viewKeyOf(get()))
      if (get().activeSessionFile === file) set({ threads, ...projectThread(next) })
      else set({ threads })
    } catch (error) {
      // `openWorkspace` fires this read without awaiting it; a rejected read
      // must surface on the conversation instead of becoming an unhandled
      // rejection in the renderer.
      if (get().activeSessionFile === file) set({ error: messageOf(error) })
    } finally {
      if (get().hydratingSessionFile === file) set({ hydratingSessionFile: undefined })
    }
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
      const draftId = get().draftId
      await tracedRpc(draftId, 'set_session_name', { name: trimmed }, undefined, 'session-rename')
      set((state) => ({
        threads: draftId ? updateThreadSessionName(state.threads, draftId, trimmed) : state.threads,
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
        threads: updateThreadSessionName(state.threads, file, trimmed),
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
      const removed = await window.pi.sessions.remove(file)
      if (!removed) {
        await get().refreshSessions().catch(() => {})
        set({ error: `Could not delete ${session?.name ?? 'the conversation'}` })
        return
      }
      const threads = { ...get().threads }
      delete threads[file]
      forgetDeletedThread(file)
      const sessions = get().sessions.filter((entry) => entry.file !== file)
      if (get().activeSessionFile === file) {
        const draftId = mintDraft()
        const thread = emptyThread(get().workspace?.path)
        threads[draftId] = thread
        set({ sessions, threads, draftId, activeSessionFile: undefined, hydratingSessionFile: undefined, ...projectThread(thread) })
      } else {
        set({ sessions, threads })
      }
      let preferenceCleanupError: string | undefined
      try {
        await queueSessionSettings(async () => {
          const pinned = get().settings.pinnedSessions ?? []
          const archived = get().settings.archivedSessions ?? []
          if (!pinned.includes(file) && !archived.includes(file)) return
          const settings = await window.pi.settings.patch({
            ...(pinned.includes(file) ? { pinnedSessions: pinned.filter((entry) => entry !== file) } : {}),
            ...(archived.includes(file) ? { archivedSessions: archived.filter((entry) => entry !== file) } : {})
          })
          set({ settings })
        })
      } catch (error) {
        preferenceCleanupError = messageOf(error)
      }
      await get().refreshSessions()
      if (preferenceCleanupError) {
        set({ error: `Conversation deleted, but saved preferences could not be updated: ${preferenceCleanupError}` })
      }
      get().showToast('Conversation deleted')
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async archiveSession(file) {
    if (!file || file.startsWith('draft:')) return
    try {
      const archivedNow = await queueSessionSettings(async () => {
        if (!get().sessions.some((session) => session.file === file)) return false
        const archived = get().settings.archivedSessions ?? []
        if (archived.includes(file)) return false
        // Keep restore/pin operations behind this transition while the runtime
        // stops; otherwise a fast restore can observe the old settings and be
        // overwritten by this delayed archive.
        if (typeof window.pi.runtime.stop === 'function') await window.pi.runtime.stop(file)
        const pinned = get().settings.pinnedSessions ?? []
        const settings = await window.pi.settings.patch({
          archivedSessions: [...archived, file],
          ...(pinned.includes(file)
            ? { pinnedSessions: pinned.filter((entry) => entry !== file) }
            : {})
        })
        set({ settings })
        return true
      })
      if (!archivedNow) return
      if (get().activeSessionFile === file) await get().newChat()
      get().showToast('Conversation archived')
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async restoreSession(file) {
    if (!file) return
    try {
      const restored = await queueSessionSettings(async () => {
        const archived = get().settings.archivedSessions ?? []
        if (!archived.includes(file)) return false
        const settings = await window.pi.settings.patch({
          archivedSessions: archived.filter((entry) => entry !== file)
        })
        set({ settings })
        return true
      })
      if (restored) get().showToast('Conversation restored to the sidebar')
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async newChat() {
    const currentKey = viewKeyOf(get())
    if (currentKey) touchSessionLru(currentKey)
    stopPrewarmOnlyRuntime(currentKey)
    cancelScheduledPrewarm()
    beginViewChange()
    drainPending()
    const draftId = mintDraft()
    const thread = emptyThread(get().workspace?.path, draftMode(get().settings))
    const threads = enforceSessionLru(
      { ...get().threads, [draftId]: thread },
      draftId
    )
    set({
      draftId,
      activeSessionFile: undefined,
      hydratingSessionFile: undefined,
      deskPage: null,
      threads,
      stats: undefined,
      ...projectThread(thread),
      status: { phase: 'ready', cwd: get().workspace?.path }
    })
  },

  async ensureRuntime(sessionKey = viewKeyOf(get()), sourceAction = 'ensure') {
    const key = threadKey(sessionKey)
    if (!key) throw new Error('Missing conversation id')
    if (sourceAction !== 'composer-focus') {
      prewarmOnlyRuntimes.delete(key)
      if (scheduledPrewarmKey === key) cancelScheduledPrewarm()
    }
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
    // A model picked while this conversation was cold had no process to hear
    // `set_model`. Apply it before the first prompt runs on the old model.
    const pending = pendingModelSelections.get(key)
    if (pending) {
      pendingModelSelections.delete(key)
      await tracedRpc(
        key,
        'set_model',
        { provider: pending.provider, modelId: pending.id },
        undefined,
        'restore-model'
      )
    }
    return threadKey(key)
  },

  prewarmRuntime(sessionKey = viewKeyOf(get())) {
    const key = threadKey(sessionKey)
    if (!key || typeof window.pi.runtime.ensure !== 'function') return
    // A run already owns the process; marking it speculative would let a view
    // change stop work that is still going.
    if (get().threads[key]?.isStreaming) return
    prewarmOnlyRuntimes.add(key)
    void get().ensureRuntime(key, 'composer-focus').catch(() => {
      // Keep the cold composer usable; an actual send retries and reports errors.
    })
  },

  async send(text, images, kind = 'steer') {
    const trimmed = normalizeAppCommandInput(text.trim())
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
    // App commands are client features, not Pi slash commands. Typing one is
    // the same request as picking it from the palette.
    if (!images.length) {
      const appCommand = APP_COMMANDS.find(
        (command) => command.source === 'app' && !command.takesArgument && trimmed === `/${command.name}`
      )
      if (appCommand) {
        await get().runAppCommand(appCommand.name)
        return
      }
    }
    let key = viewKeyOf(get())
    if (!key) {
      const draftId = mintDraft()
      const thread = emptyThread(get().workspace?.path, draftMode(get().settings))
      set({
        draftId,
        threads: { ...get().threads, [draftId]: thread },
        activeSessionFile: undefined,
        hydratingSessionFile: undefined
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
        const startedAt = Date.now()
        const startedMonotonicAt = monotonicNow()
        update((state) => ({
          run:
            state.run.phase === 'queued'
              ? {
                  ...state.run,
                  phase: 'working',
                  startedAt: state.run.startedAt ?? startedAt,
                  startedMonotonicAt: state.run.startedMonotonicAt ?? startedMonotonicAt
                }
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
    // Nothing is open, so no settle will follow. Pi answers `abort` while idle
    // but never publishes `agent_settled` for it, and the row would stay on
    // "Stopping…" with every later prompt blocked. A stop on a finished run is
    // already the state the user asked for.
    if (ownGet().run.phase === 'idle' && ownGet().run.settled) return
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
      // The stop never reached Pi. Leaving the phase on `aborting` would keep
      // rejecting every later prompt and keep the stop button disabled for
      // the rest of the process's life.
      update((state) =>
        state.run.phase === 'aborting'
          ? {
              error: messageOf(error),
              run: {
                ...state.run,
                phase: state.isStreaming ? 'working' : 'idle',
                ...(state.isStreaming ? {} : { settled: true })
              }
            }
          : { error: messageOf(error) }
      )
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
    if (agentSettingSelectionInFlight) {
      get().showToast('A model or reasoning change is already in progress', 'warning')
      return false
    }
    agentSettingSelectionInFlight = true
    const owner = viewKeyOf(get())
    const key = threadKey(owner)
    const selection = ++modelPreferenceSequence
    modelPreferenceValue = `${model.provider}/${model.id}`
    try {
      // Pi starts when a message is sent, not when a picker changes. A cold
      // conversation has no process to hear `set_model`, so store the choice
      // and let the next launch read it (draft) or `ensureRuntime` apply it
      // (a resumed session). Booting Pi here made every first switch after a
      // start feel like a cold start, because it was one.
      const running =
        owner && typeof window.pi.runtime.has === 'function' ? await window.pi.runtime.has(owner) : true
      // A process that is already booting will not read a settings change it
      // missed. Treat it as live so `ensureRuntime` waits for it and sends
      // `set_model` instead of leaving the first prompt on the old model.
      const starting = get().threads[key]?.status.phase === 'starting'
      if (!running && !starting) {
        const spec = `${model.provider}/${model.id}`
        if (selection === modelPreferenceSequence) {
          const shouldWrite = get().settings.model !== spec ||
            get().settings.provider !== model.provider ||
            (modelPreferenceValue !== undefined && modelPreferenceValue !== spec)
          modelPreferenceValue = spec
          if (shouldWrite) {
            const settings = await window.pi.settings.patch({ provider: model.provider, model: spec })
            if (modelPreferenceSequence === selection) {
              set({ settings: { ...get().settings, provider: settings.provider, model: settings.model } })
            }
          }
        }
        // A draft's next launch already receives the saved default through
        // `ensureRuntime`; only a resumed session needs the extra command.
        if (key && !key.startsWith('draft:')) {
          pendingModelSelections.set(key, { provider: model.provider, id: model.id })
        }
        recordModelUse(model)
        return true
      }
      pendingModelSelections.delete(key)
      const ensuredKey = await get().ensureRuntime(owner, 'set-model')
      const liveKey = threadKey(ensuredKey)
      const state = bindGet(get, liveKey)()
      if (!state.models.some(item => item.provider === model.provider && item.id === model.id)) {
        if (!state.run.settled) {
          get().showToast('New models can be selected when the current run finishes', 'warning')
          return false
        }
        await tracedRpc(liveKey, 'prompt', { message: '/desktop-refresh-models' }, undefined, 'refresh-models')
      }
      await tracedRpc(
        liveKey,
        'set_model',
        { provider: model.provider, modelId: model.id },
        undefined,
        'set-model'
      )
      await get().refreshState(threadKey(owner))
      const spec = `${model.provider}/${model.id}`
      if (selection === modelPreferenceSequence) {
        const shouldWrite = get().settings.model !== spec ||
          get().settings.provider !== model.provider ||
          (modelPreferenceValue !== undefined && modelPreferenceValue !== spec)
        modelPreferenceValue = spec
        if (shouldWrite) {
          const settings = await window.pi.settings.patch({ provider: model.provider, model: spec })
          if (modelPreferenceSequence === selection) {
            set({ settings: { ...get().settings, provider: settings.provider, model: settings.model } })
          }
        }
      }
      recordModelUse(model)
      return true
    } catch (error) {
      bindSet(set, get, owner)({ error: messageOf(error) })
      return false
    } finally {
      agentSettingSelectionInFlight = false
    }
  },

  async refreshModelCatalog() {
    const list = window.pi.providers?.list
    if (typeof list !== 'function') return
    const request = ++modelCatalogRequestSequence
    try {
      const profiles = await list()
      if (request !== modelCatalogRequestSequence) return
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
    if (agentSettingSelectionInFlight) {
      get().showToast('A model or reasoning change is already in progress', 'warning')
      return
    }
    agentSettingSelectionInFlight = true
    const owner = viewKeyOf(get())
    const selection = ++thinkingPreferenceSequence
    thinkingPreferenceValue = level
    try {
      // A cold chat has no process yet. Starting one just to store the effort
      // is what the empty card was avoiding; the next launch already reads
      // the saved level. An existing process still hears the change now.
      const running = owner ? await window.pi.runtime.has(owner) : false
      if (running) {
        const key = await get().ensureRuntime(owner, 'set-thinking')
        await tracedRpc(key, 'set_thinking_level', { level }, undefined, 'set-thinking')
        await get().refreshState(threadKey(owner))
      }
      if (selection === thinkingPreferenceSequence) {
        const shouldWrite = get().settings.thinkingLevel !== level ||
          (thinkingPreferenceValue !== undefined && thinkingPreferenceValue !== level)
        thinkingPreferenceValue = level
        if (shouldWrite) {
          const settings = await window.pi.settings.patch({ thinkingLevel: level })
          if (thinkingPreferenceSequence === selection) {
            set({ settings: { ...get().settings, thinkingLevel: settings.thinkingLevel } })
          }
        }
      }
    } catch (error) {
      bindSet(set, get, owner)({ error: messageOf(error) })
    } finally {
      agentSettingSelectionInFlight = false
    }
  },

  /**
   * Walk through the models Pi offers.
   *
   * The same merged list feeds the picker and the shortcut, preserving Pi's
   * order while making providers saved since this process started available.
   */
  async cycleModel(direction = 1) {
    if (agentSettingSelectionInFlight) {
      get().showToast('A model or reasoning change is already in progress', 'warning')
      return
    }
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
    if (agentSettingSelectionInFlight) {
      get().showToast('A model or reasoning change is already in progress', 'warning')
      return
    }
    const { thinkingLevels, piState } = get()
    const levels = thinkingLevels
    if (levels.length === 0) {
      get().showToast(
        piState
          ? 'This model has no reasoning levels'
          : 'Reasoning effort can be changed once the conversation starts.',
        'warning'
      )
      return
    }
    if (levels.length === 1) {
      get().showToast(`Reasoning effort: ${levels[0]}`, 'warning')
      return
    }
    const current = levels.indexOf(piState?.thinkingLevel ?? get().settings.thinkingLevel ?? '')
    const start = current === -1 ? (direction === 1 ? -1 : 0) : current
    const next = levels[(start + direction + levels.length) % levels.length]
    await get().setThinkingLevel(next)
    get().showToast(`Reasoning effort: ${next}`)
  },

  async compact(instructions) {
    const owner = viewKeyOf(get())
    try {
      const key = await get().ensureRuntime(owner, 'compact')
      const payload: Record<string, unknown> = {}
      if (instructions?.trim()) payload.customInstructions = instructions.trim()
      // Pi may make multiple model calls while summarising a long session.
      // Its RPC client documents compaction as a command without a deadline.
      await tracedRpc(key, 'compact', payload, 0, 'compact')
      await get().refreshState(threadKey(owner))
      // The summary Pi wrote is an entry of the session, so the thread has
      // to read it again — otherwise the conversation on screen still shows
      // the messages that were just folded away.
      await get().reloadMessages(threadKey(owner))
      // A retry that worked must not leave the previous failure on screen,
      // but it must not clear an unrelated error either.
      bindSet(set, get, owner)((state) =>
        /^Context compaction (?:failed|timed out)/.test(state.error ?? '')
          ? { error: undefined }
          : {}
      )
      get().showToast('The conversation was summarised')
      return true
    } catch (error) {
      // Pi rejects a compact it cannot act on ("Nothing to compact",
      // "Already compacted") with the same error response as a provider
      // failure. Keep the real reason; only a genuine failure gets the
      // thread-level banner, a benign answer is a toast.
      const failure = describeCompactionFailure(messageOf(error))
      if (failure.benign) get().showToast(failure.message, 'warning')
      bindSet(set, get, owner)((state) => ({
        ...(failure.benign ? {} : { error: failure.message }),
        run: { ...state.run, compaction: undefined }
      }))
      return false
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

  /**
   * Read Pi's `get_session_stats` for one conversation, on demand.
   *
   * The context panel used to read only the `stats` that `refreshState` left
   * behind, so a conversation that had never been through a refresh — a
   * reopened one, or one whose first read raced the process boot — showed an
   * empty panel with no way to ask again. This asks, and never starts a
   * process just to answer: a cold conversation keeps its transcript reading.
   */
  async readSessionStats(sessionKey = viewKeyOf(get())): Promise<SessionStats | undefined> {
    const key = threadKey(sessionKey)
    if (!key) return undefined
    if (typeof window.pi.runtime.has === 'function' && !(await window.pi.runtime.has(key))) {
      return undefined
    }
    try {
      // A live request breakdown is the newest reading there is; fetching the
      // whole transcript only to recompute an estimate would copy a large
      // payload over the wire for a row it would not replace.
      const existing = bindGet(get, key)().contextBreakdown
      const needsMessages = existing?.source !== 'request'
      const [stats, context] = await Promise.all([
        tracedRpc<SessionStats>(key, 'get_session_stats', undefined, 20_000, 'read-stats')
          .catch(() => undefined),
        needsMessages
          ? tracedRpc<{ messages?: AgentMessage[] }>(
              key,
              'get_messages',
              undefined,
              20_000,
              'read-context-breakdown'
            ).catch(() => undefined)
          : Promise.resolve(undefined)
      ])
      const patch: Partial<AppStore> = {}
      if (stats) patch.stats = stats
      if (context?.messages) {
        // A request can publish its breakdown while `get_messages` is in flight.
        const latest = bindGet(get, key)().contextBreakdown
        if (latest?.source !== 'request') {
          patch.contextBreakdown = estimateContextBreakdown(
            context.messages,
            stats?.contextUsage?.tokens
          )
        }
      }
      if (Object.keys(patch).length) bindSet(set, get, key)(patch)
      return stats
    } catch {
      // A process that stopped between the check and the read is not an error
      // the reader has to see; the panel falls back to the transcript.
      return undefined
    }
  },

  async refreshState(sessionKey = viewKeyOf(get())) {
    if (!sessionKey) return
    const key = threadKey(sessionKey)
    const request = ++refreshStateRequestSequence
    refreshStateRequests.set(key, request)
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
      if (!isCurrentStateRefresh(key, request)) return
      if (state?.sessionFile) {
        if (threadKey(key) !== state.sessionFile) rekeyThread(set, get, key, state.sessionFile)
        if (viewKeyOf(get()) === state.sessionFile) void get().rememberSession(state.sessionFile)
      }
      if (!isCurrentStateRefresh(key, request)) return
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
          ).then(async () => {
            await get().refreshState(owner)
            const model = bindGet(get, owner)().piState?.model
            if (model?.provider === saved.provider && model.id === saved.id) {
              modelRestoreAttempts.delete(attempt)
            }
          }).catch(() => {
            modelRestoreAttempts.delete(attempt)
          })
        }
      }
      const savedLevel = get().settings.thinkingLevel
      if (savedLevel && !state?.thinkingLevel && nextLevels.includes(savedLevel)) {
        const attempt = `${owner}:thinking:${savedLevel}`
        if (!modelRestoreAttempts.has(attempt)) {
          modelRestoreAttempts.add(attempt)
          void tracedRpc(owner, 'set_thinking_level', { level: savedLevel }, undefined, 'restore-thinking')
            .then(async () => {
              await get().refreshState(owner)
              if (bindGet(get, owner)().piState?.thinkingLevel === savedLevel) {
                modelRestoreAttempts.delete(attempt)
              }
            })
            .catch(() => {
              modelRestoreAttempts.delete(attempt)
            })
        }
      }
    } catch (error) {
      if (isCurrentStateRefresh(key, request)) update({ error: messageOf(error) })
    } finally {
      const currentKey = threadKey(key)
      if (refreshStateRequests.get(currentKey) === request) refreshStateRequests.delete(currentKey)
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
      bindSet(set, get, sessionKey)({
        items: itemsFromMessages(data?.messages ?? []),
        contextBreakdown: ownGet().contextBreakdown?.source === 'request'
          ? ownGet().contextBreakdown
          : estimateContextBreakdown(data?.messages ?? [], ownGet().stats?.contextUsage?.tokens)
      })
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
      const appNames = new Set(APP_COMMANDS.map((command) => command.name))
      update({
        commands: [
          ...APP_COMMANDS,
          ...(data?.commands ?? []).filter(
            (command) =>
              !appNames.has(command.name) &&
              command.name !== 'desktop-mode' &&
              command.name !== 'desktop-goal' &&
              command.name !== 'desktop-computer'
          )
        ]
      })
    } catch {
      update({ commands: APP_COMMANDS })
    }
  },

  async refreshSkillCommands(sessionKey = viewKeyOf(get())) {
    if (!sessionKey) return
    const key = threadKey(sessionKey)
    const current = bindGet(get, key)().commands
    if (current.some((command) => command.source === 'skill')) return
    const pending = skillCommandRequests.get(key)
    if (pending) {
      await pending.catch(() => undefined)
      return
    }

    const request = (async () => {
      const skills = await window.pi.runtime.listSkillCommands()
      const latest = bindGet(get, key)().commands
      const names = new Set(latest.map((command) => command.name))
      bindSet(set, get, key)({
        commands: [...latest, ...skills.filter((command) => !names.has(command.name))]
      })
    })()
    skillCommandRequests.set(key, request)
    try {
      await request
    } catch {
      // Skill discovery is optional until the first Pi conversation starts.
    } finally {
      if (skillCommandRequests.get(key) === request) skillCommandRequests.delete(key)
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
      case 'subagent':
        await get().setAgentMode(get().agentMode === 'subagent' ? 'default' : 'subagent')
        break
      case 'plugin':
        await get().setAgentMode(get().agentMode === 'plugin' ? 'default' : 'plugin')
        break
      default:
        break
    }
  },

  async updateSettings(patch) {
    if ('model' in patch || 'provider' in patch) {
      modelPreferenceSequence += 1
      const model = 'model' in patch ? patch.model : get().settings.model
      modelPreferenceValue = typeof model === 'string' ? model : null
    }
    if ('thinkingLevel' in patch) {
      thinkingPreferenceSequence += 1
      thinkingPreferenceValue = typeof patch.thinkingLevel === 'string' ? patch.thinkingLevel : null
    }
    const settings = await window.pi.settings.patch(patch)
    set({ settings })
    applyAppearance(settings, get().info?.forcedTheme)
  },

  async saveProvider(input) {
    const selection = ++modelPreferenceSequence
    modelPreferenceValue = input.id && input.selectedModel
      ? `${input.id}/${input.selectedModel}`
      : null
    const key = viewKeyOf(get())
    const result = await window.pi.providers.save(input, key)
    if (modelPreferenceSequence === selection) {
      modelPreferenceValue = `${result.provider.id}/${input.selectedModel}`
      set({
        settings: {
          ...get().settings,
          provider: result.settings.provider,
          model: result.settings.model
        }
      })
    }
    await get().refreshModelCatalog()
    if (result.applied) await get().refreshState(threadKey(key))
    return result
  },

  async removeProvider(id) {
    const prefix = `${id}/`
    const selected = get().settings.provider === id ||
      get().settings.model?.startsWith(prefix) === true ||
      modelPreferenceValue?.startsWith(prefix) === true
    const selection = selected ? ++modelPreferenceSequence : modelPreferenceSequence
    if (selected) modelPreferenceValue = null
    const result = await window.pi.providers.remove(id)
    if (modelPreferenceSequence === selection) {
      modelPreferenceValue = typeof result.settings.model === 'string' ? result.settings.model : null
      set({
        settings: {
          ...get().settings,
          provider: result.settings.provider,
          model: result.settings.model
        }
      })
    }
    await get().refreshModelCatalog()
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
    const wasPinned = await queueSessionSettings(async () => {
      const pinned = get().settings.pinnedSessions ?? []
      const wasPinned = pinned.includes(file)
      const next = wasPinned
        ? pinned.filter((entry) => entry !== file)
        : [...pinned, file]
      const settings = await window.pi.settings.patch({ pinnedSessions: next })
      set({ settings })
      return wasPinned
    })
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
    // Git describes the open folder, not the conversation on screen.
    const epoch = projectEpoch
    const request = ++gitStatusRequest
    try {
      const git = await window.pi.git.status()
      if (epoch !== projectEpoch || request !== gitStatusRequest) return
      set({ git })
    } catch {
      if (epoch !== projectEpoch || request !== gitStatusRequest) return
      // A folder that is not a repository is a normal state, not an error.
      set({ git: undefined })
    }
  },

  scheduleGitRefresh(delayMs = GIT_REFRESH_DEBOUNCE_MS) {
    // A run that touches a dozen files would otherwise ask git for the whole
    // working tree a dozen times. One trailing read is enough: the list on
    // screen has to catch up *during* the run, not once per edit.
    if (gitRefreshTimer !== null) return
    gitRefreshTimer = window.setTimeout(() => {
      gitRefreshTimer = null
      void get().refreshGit()
    }, delayMs)
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
    const session: SessionMeta = known
      ? { ...known, messageCount: Math.max(1, known.messageCount) }
      : {
          id: hit.sessionId,
          file: hit.file,
          cwd: hit.cwd,
          name: hit.name,
          preview: hit.preview,
          updatedAt: hit.updatedAt,
          // A search hit proves this on-disk session has at least one message.
          // Keep that fact so selectSession hydrates the transcript and can land
          // the pending jump in the message that matched.
          messageCount: 1
        }
    try {
      // Another project's conversation is opened first; the thread of that
      // project is the one the jump belongs to. A run in the current one is
      // never ended for a search hit — the reader asked to look, not to stop.
      if (get().activeSessionFile !== hit.file) {
        await get().selectSession(session, 'search-open')
      }
      if (get().activeSessionFile !== hit.file) return
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

function rgbToHex(r: number, g: number, b: number): string {
  const part = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

let colorProbeCanvas: HTMLCanvasElement | null = null

/**
 * Turn any CSS colour string — including the `color(srgb …)` form Chromium
 * resolves `color-mix(...)` to — into opaque-capable rgba channels. A canvas is
 * the only reliable normaliser: hand-parsing every CSS colour grammar, or even
 * `rgba()`, misses the serialisation `getComputedStyle` actually produces.
 */
function parseCssColor(color: string): { r: number; g: number; b: number; a: number } | null {
  const value = color.trim()
  if (!value || typeof document === 'undefined') return null
  if (!colorProbeCanvas) colorProbeCanvas = document.createElement('canvas')
  const ctx = colorProbeCanvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  // The setter ignores an unparseable colour and keeps the sentinel, which is
  // how we detect a value the browser will not accept.
  ctx.fillStyle = '#123456'
  ctx.fillStyle = value
  if (ctx.fillStyle === '#123456') return null
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  return { r, g, b, a: a / 255 }
}

/**
 * Resolve a CSS colour expression — often a token whose value is itself a
 * `color-mix(...)` — to concrete channels. A throwaway element lets the browser
 * do the mixing, which the renderer could not replicate for arbitrary palettes.
 */
function resolveCssColor(expression: string): { r: number; g: number; b: number; a: number } | null {
  const trimmed = expression.trim()
  if (!trimmed || typeof document === 'undefined' || !document.body) return null
  const probe = document.createElement('span')
  probe.style.color = trimmed
  probe.style.position = 'absolute'
  probe.style.opacity = '0'
  probe.style.pointerEvents = 'none'
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  return parseCssColor(computed)
}

type Rgba = { r: number; g: number; b: number; a: number }

/** The colour a translucent layer leaves on an opaque backdrop. */
function compositeOver(layer: Rgba, base: Rgba): Rgba {
  const keep = 1 - layer.a
  return {
    r: layer.r * layer.a + base.r * keep,
    g: layer.g * layer.a + base.g * keep,
    b: layer.b * layer.a + base.b * keep,
    a: 1
  }
}

let chromeWatcher: MutationObserver | null = null
let chromeOverlayCount = -1
// The watcher outlives the appearance pass that installed it, so it reads the
// theme from here rather than from a captured argument.
let chromeDark = false

/** Full-window layers: whatever paints here also paints under the native controls. */
const CHROME_OVERLAYS = '.modal-layer, .lightbox-layer, .mermaid-layer'

/**
 * The native window controls are drawn by the OS over the top-right corner of
 * the web content, so their colour has to be what the page actually paints
 * there. The strip is the chrome token — and while a dialog is open it is the
 * scrim over that chrome, because the modal layer covers the whole window.
 */
function syncWindowChrome(dark: boolean): void {
  // The store also runs in the unit tests, where there is no layout engine
  // to read a computed style from. The native controls then keep the theme
  // default instead of a colour that was never measured.
  if (typeof getComputedStyle !== 'function' || typeof document.querySelectorAll !== 'function') {
    void window.pi.app.setTheme(dark ? 'dark' : 'light')
    return
  }
  const rootStyles = getComputedStyle(document.documentElement)
  const chrome = resolveCssColor(rootStyles.getPropertyValue('--chrome-bg'))
  if (!chrome) {
    void window.pi.app.setTheme(dark ? 'dark' : 'light')
    return
  }
  const muted = resolveCssColor(rootStyles.getPropertyValue('--text-muted'))
  let base = chrome
  for (const layer of Array.from(document.querySelectorAll(CHROME_OVERLAYS))) {
    const scrim = parseCssColor(getComputedStyle(layer).backgroundColor)
    if (scrim && scrim.a > 0) base = compositeOver(scrim, base)
  }
  void window.pi.app.setTheme(dark ? 'dark' : 'light', {
    color: rgbToHex(base.r, base.g, base.b),
    // The menu glyphs sit on this strip, so a translucent --text-muted is
    // composited down to the opaque colour the native buttons should use.
    symbolColor: muted
      ? rgbToHex(
          muted.r * muted.a + base.r * (1 - muted.a),
          muted.g * muted.a + base.g * (1 - muted.a),
          muted.b * muted.a + base.b * (1 - muted.a)
        )
      : dark
        ? '#9da4b2'
        : '#686868'
  })
}

/**
 * A dialog being opened or closed is the one appearance change the store is not
 * told about, so watch the DOM for it. The layer fades in, hence the second pass
 * — measuring while it is still transparent would keep the bare chrome.
 */
function watchChromeOverlays(): void {
  if (chromeWatcher || typeof MutationObserver === 'undefined') return
  // Streaming text mutates the DOM on every frame, so the check runs on the
  // records first: only a node that is, or carries, a modal layer can move the
  // strip. Querying the document on every batch would sit in the delta budget.
  const touchesLayer = (records: MutationRecord[]): boolean =>
    records.some((record) => {
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (!(node instanceof Element)) continue
        if (node.matches(CHROME_OVERLAYS) || node.querySelector(CHROME_OVERLAYS)) return true
      }
      return false
    })
  const repaint = (records: MutationRecord[]) => {
    if (!touchesLayer(records)) return
    const count = document.querySelectorAll(CHROME_OVERLAYS).length
    if (count === chromeOverlayCount) return
    chromeOverlayCount = count
    syncWindowChrome(chromeDark)
    window.setTimeout(() => {
      if (document.querySelectorAll(CHROME_OVERLAYS).length === chromeOverlayCount) {
        syncWindowChrome(chromeDark)
      }
    }, 240)
  }
  chromeWatcher = new MutationObserver(repaint)
  chromeWatcher.observe(document.documentElement, { childList: true, subtree: true })
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

  // Tone: the appearance picker has only two levels — normal (no override)
  // and high contrast (raised ink/border contrast).
  if (settings.themeTone === 'contrast') {
    root.dataset.tone = 'contrast'
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
      sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      chinese: "'PingFang SC', '苹方', '苹方-简', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif",
      mono: "'JetBrains Mono', 'SF Mono', 'Cascadia Code', Consolas, monospace",
      serif: "'Newsreader', 'Georgia', serif"
    }
    const mapped = fontMap[settings.fontFamily]
    // The installed copy is registered as 苹方; keep both names so either one resolves.
    // YaHei has to follow: a bare "PingFang SC Regular" often misses on Windows,
    // and the next generic sans-serif is then drawn as SimSun.
    const pingfang = `"PingFang SC", "苹方", "苹方-简", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`
    const pingfangWeights: Record<string, string> = {
      'PingFang SC': pingfang,
      'PingFang SC Regular': `"PingFang SC Regular", ${pingfang}`,
      'PingFang SC Medium': `"PingFang SC Medium", ${pingfang}`,
      'PingFang SC Bold': `"PingFang SC Bold", ${pingfang}`
    }
    const fontVal =
      mapped ??
      pingfangWeights[settings.fontFamily] ??
      (settings.fontFamily.includes(',') || settings.fontFamily.includes('"') || settings.fontFamily.includes("'")
        ? settings.fontFamily
        : `"${settings.fontFamily}", "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`)
    const fontWithCjkFallback = `var(--font-cjk), ${fontVal}`
    root.style.setProperty('--font-ui', fontWithCjkFallback)
    root.style.setProperty('--font-sidebar', fontWithCjkFallback)
    root.style.setProperty('--font-reading', fontWithCjkFallback)
  } else {
    remove('--font-ui')
    remove('--font-sidebar')
    remove('--font-reading')
  }

  // Hand the browser's resolved colours to the main process: a custom
  // background, a tone change or an open dialog all move the strip the native
  // buttons share with the menu bar.
  chromeDark = dark
  chromeOverlayCount =
    typeof document.querySelectorAll === 'function' ? document.querySelectorAll(CHROME_OVERLAYS).length : 0
  watchChromeOverlays()
  syncWindowChrome(dark)
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
    contextBreakdown: thread.contextBreakdown,
    error: thread.error,
    status: thread.status,
    forkTargets: thread.forkTargets,
    agentMode: thread.agentMode ?? 'default',
    models: thread.models ?? [],
    thinkingLevels: thread.thinkingLevels ?? [],
    commands: thread.commands ?? APP_COMMANDS,
    notice: thread.notice
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
    const base = state.threads[key]
    if (key && !base) return
    const thread = base ?? emptyThread(state.workspace?.path)
    const patch = typeof partial === 'function' ? partial({ ...state, ...projectThread(thread) }) : partial
    const next = threadFromPatch(thread, patch)
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
  const stateRefreshRequest = refreshStateRequests.get(from)
  if (stateRefreshRequest !== undefined) {
    const targetRequest = refreshStateRequests.get(to)
    if (targetRequest === undefined || stateRefreshRequest > targetRequest) {
      refreshStateRequests.set(to, stateRefreshRequest)
    }
    refreshStateRequests.delete(from)
  }
  rekeyStreamState(from, to)
  migrateToolStarts(from, to)
  // The reader's place belongs to the conversation, not to whether Pi has
  // written it to disk yet; carry it across the draft→file rename.
  migrateScrollMemory(from, to)
  migrateViewState(from, to)
  migrateSessionTiming(from, to)
  const aliases = [...(threadAliasesByTarget.get(from) ?? [])]
  for (const alias of aliases) {
    migrateScrollMemory(alias, to)
    migrateViewState(alias, to)
  }
  const state = get()
  const thread = state.threads[from]
  const threads = { ...state.threads }
  if (thread) {
    if (replace || from.startsWith('draft:')) {
      delete threads[from]
      for (const alias of aliases) setThreadAlias(alias, to)
      setThreadAlias(from, to)
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
    drainPending()
    set((state) => ({ items: applyEvent(state.items, event, context) }))
    return
  }
  const key = viewKeyOf(get())
  const batch = pending.get(key) ?? { set, events: [] }
  const last = batch.events[batch.events.length - 1]
  const merged = last ? mergeTextDelta(last.event, last.context, event, context) : null
  if (merged) last.event = merged
  else batch.events.push({ event, context })
  pending.set(key, batch)
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    if (hiddenFlushTimer === null) {
      hiddenFlushTimer = globalThis.setTimeout(() => {
        hiddenFlushTimer = null
        drainPending()
      }, HIDDEN_EVENT_FLUSH_MS)
    }
    return
  }
  scheduleFlush()
}

/**
 * Fold a run of adjacent text deltas into one record before reducing.
 *
 * A provider can emit dozens of tiny deltas in a single frame. They all land
 * in the same thread and block, so reducing each one separately copies the
 * whole `items` array dozens of times for a transcript that is painted once.
 * Keeping the last record and extending its delta gives the reducer the same
 * text with one pass. `text_end` remains authoritative, as before.
 */
function mergeTextDelta(
  previousEvent: PiEvent,
  previousContext: ReturnType<typeof runContextOf>,
  nextEvent: PiEvent,
  nextContext: ReturnType<typeof runContextOf>
): PiEvent | null {
  if (previousEvent.type !== 'message_update' || nextEvent.type !== 'message_update') return null
  if (
    previousContext.sessionKey !== nextContext.sessionKey ||
    previousContext.runId !== nextContext.runId ||
    previousContext.turnId !== nextContext.turnId
  ) {
    return null
  }
  const previous = previousEvent.assistantMessageEvent as
    | { type?: string; contentIndex?: number; delta?: string }
    | undefined
  const next = nextEvent.assistantMessageEvent as
    | { type?: string; contentIndex?: number; delta?: string }
    | undefined
  if (!previous || !next || previous.type !== next.type) return null
  if (previous.type !== 'text_delta' && previous.type !== 'thinking_delta') return null
  // Without a content index there is no proof the two deltas belong to the
  // same block, so leave them separate rather than risk merging two blocks.
  if (previous.contentIndex === undefined || next.contentIndex === undefined) return null
  if (previous.contentIndex !== next.contentIndex) return null
  return {
    ...previousEvent,
    assistantMessageEvent: {
      ...previous,
      delta: (previous.delta ?? '') + (next.delta ?? '')
    }
  }
}

/** Reducers waiting for the next frame. */
const pending = new Map<string, {
  set: SetState
  events: { event: PiEvent; context: ReturnType<typeof runContextOf> }[]
}>()
/** Monotonic tool starts live at the event boundary, keeping the thread reducer deterministic. */
const toolStarts = new Map<string, Map<string, number>>()
let flushHandle: number | null = null
let hiddenFlushTimer: ReturnType<typeof setTimeout> | null = null

function rememberToolStart(sessionKey: string, toolCallId: string): void {
  const starts = toolStarts.get(sessionKey) ?? new Map<string, number>()
  if (!starts.has(toolCallId)) starts.set(toolCallId, monotonicNow())
  toolStarts.set(sessionKey, starts)
}

function migrateToolStarts(from: string, to: string): void {
  const source = toolStarts.get(from)
  if (!source) return
  const target = toolStarts.get(to) ?? new Map<string, number>()
  for (const [toolCallId, startedAt] of source) {
    if (!target.has(toolCallId)) target.set(toolCallId, startedAt)
  }
  toolStarts.set(to, target)
  toolStarts.delete(from)
}

function takeToolStart(sessionKey: string, toolCallId: string): number | undefined {
  const starts = toolStarts.get(sessionKey)
  if (!starts) return undefined
  const startedAt = starts.get(toolCallId)
  starts.delete(toolCallId)
  if (starts.size === 0) toolStarts.delete(sessionKey)
  return startedAt
}

/** Apply every queued reducer now, in the order the events arrived. */
function drainPending(): void {
  if (hiddenFlushTimer !== null) {
    clearTimeout(hiddenFlushTimer)
    hiddenFlushTimer = null
  }
  if (flushHandle !== null) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(flushHandle)
    flushHandle = null
  }
  const batches = [...pending.values()]
  pending.clear()
  for (const batch of batches) {
    batch.set((state) => ({
      items: applyEventBatch(state.items, batch.events)
    }))
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' && pending.size > 0) drainPending()
  })
}

function forgetDeletedThread(file: string): void {
  const keys = new Set([file, ...clearThreadAliasesForTarget(file)])
  if (scheduledPrewarmKey && keys.has(scheduledPrewarmKey)) cancelScheduledPrewarm()
  for (const key of keys) {
    refreshStateRequests.delete(key)
    retryArmed.delete(key)
    prewarmOnlyRuntimes.delete(key)
    pendingModelSelections.delete(key)
    toolStarts.delete(key)
    pending.delete(key)
    forgetSessionLru(key)
    clearScrollMemory(key)
    clearViewState(key)
    forgetSessionTiming(key)
    resetStreamState(key)
    for (const attempt of modelRestoreAttempts) {
      if (attempt.startsWith(`${key}:`)) modelRestoreAttempts.delete(attempt)
    }
  }
  if (pending.size === 0) {
    if (hiddenFlushTimer !== null) {
      clearTimeout(hiddenFlushTimer)
      hiddenFlushTimer = null
    }
    if (flushHandle !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(flushHandle)
      flushHandle = null
    }
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
 * The tools whose completion can change the working tree.
 *
 * `edit` and `write` are Pi's own file writers; `bash` can move anything, so
 * it counts too — a `git checkout` or a generator run through the shell shows
 * up in the review list exactly like an edit does. A read or a search cannot,
 * and asking git after each of those would be a process per keystroke.
 */
function touchesWorkingTree(toolName: unknown): boolean {
  if (typeof toolName !== 'string') return false
  return toolName === 'edit' || toolName === 'write' || toolName === 'bash'
}

/**
 * Whether a git read is worth doing for the event that just arrived.
 *
 * `refreshGit` always reads the *active* project, so a run in a background
 * conversation must not trigger it when that conversation lives in another
 * folder — the list would be read for the wrong tree and look like it changed.
 * A run in another conversation of the same folder is fine: the tree is the
 * same tree.
 */
function gitBelongsToView(
  get: GetState,
  realGet: GetState | undefined,
  owner: string | undefined
): boolean {
  if (!realGet || !owner) return true
  const view = viewKeyOf(realGet())
  if (view === owner) return true
  const runningCwd = get().status?.cwd
  const activeCwd = realGet().workspace?.path
  if (!runningCwd || !activeCwd) return false
  return samePath(runningCwd, activeCwd)
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

function finishModelTiming(
  set: SetState,
  get: GetState,
  owner?: string,
  messageTimestamp?: number
): void {
  const run = get().run
  if (run.modelTurnStartedAt === undefined) return
  const timingKey = owner ? threadKey(owner) : viewKeyOf(get())
  const turnId = run.turnId ?? run.runId
  recordModelDuration(
    timingKey,
    turnId,
    Math.max(0, monotonicNow() - run.modelTurnStartedAt),
    messageTimestamp
  )
  set((state) => ({ run: { ...state.run, modelTurnStartedAt: undefined } }))
}

/**
 * End the generation window of the answer that just finished.
 *
 * `text_end`, `done` and `message_end` can all close one answer; only the
 * first of them has a start to charge, so the later ones add nothing.
 */
function closeGenerationWindow(set: SetState): void {
  const at = monotonicNow()
  set((state) => {
    const started = state.run.messageGenerationStartedAt
    return {
      run: {
        ...state.run,
        lastTokenAt: Date.now(),
        messageGenerationStartedAt: undefined,
        ...(started === undefined
          ? {}
          : { generationMs: (state.run.generationMs ?? 0) + Math.max(0, at - started) })
      }
    }
  })
}

function handleEvent(
  set: SetState,
  get: GetState,
  event: PiEvent,
  realGet?: GetState,
  owner?: string,
  realSet?: SetState
): void {
  switch (event.type) {
    case 'agent_start': {
      // Queued records still belong to the message that just ended. Applying
      // them before the identity reset below is what keeps a `message_end`
      // from being re-stamped with the next turn's message id.
      drainPending()
      beginStream(runContextOf(get).sessionKey)
      // One run per prompt. A follow-up prompt that arrives while a run is
      // active does not open a second one: Pi folds it into the current run.
      const startedAt = Date.now()
      const startedMonotonicAt = monotonicNow()
      set((state) => ({
        isStreaming: true,
        // `stats` is only a snapshot from the last Pi read. Let the live
        // transcript drive the usage line until the settled refresh gets a
        // new snapshot; otherwise the old totals mask newer session events.
        stats: undefined,
        retry: undefined,
        // A new run supersedes whatever the last one left behind: the row is
        // working again, so there is nothing left to notice.
        notice: undefined,
        run: !state.run.runId || state.run.phase === 'idle' || state.run.settled
          ? {
              phase: phaseFor(state, 'working'),
              runId: nextId('run'),
              turns: 0,
              startedAt,
              startedMonotonicAt,
              generationMs: 0,
              settled: false
            }
          : {
              ...state.run,
              startedAt: state.run.startedAt ?? startedAt,
              startedMonotonicAt: state.run.startedMonotonicAt ?? startedMonotonicAt,
              phase: phaseFor(state, 'working'),
              settled: false
            }
      }))
      break
    }
    case 'turn_start': {
      drainPending()
      beginStream(runContextOf(get).sessionKey)
      const modelTurnStartedAt = monotonicNow()
      set((state) => ({
        isStreaming: true,
        retry: undefined,
        run: state.run.runId
          ? {
              ...state.run,
              turnId: nextId('turn'),
              turns: state.run.turns + 1,
              modelTurnStartedAt,
              firstTokenAt: undefined,
              phase: phaseFor(state, 'working'),
              settled: false
            }
          : { ...state.run, phase: 'working', settled: false }
      }))
      break
    }
    case 'agent_end':
      // `agent_end` is not the end of the work: Pi may retry, compact or
      // continue on its own. The run stays open until it settles.
      set((state) => ({ isStreaming: true, run: { ...state.run, settled: false } }))
      break
    case 'agent_settled': {
      // The one authoritative "the runtime is done" signal.
      const aborted = Boolean(event.aborted)
      // The supervisor mints this when the process died before it could write
      // its own settle. The user did not stop that run, so it failed.
      const crashed = Boolean(event.crashed)
      // Anything still waiting for a frame is applied first: the final
      // state has to be the state the events actually produced.
      drainPending()
      finishStream(runContextOf(get).sessionKey)
      const state = get()
      const durationMs =
        state.run.startedMonotonicAt === undefined
          ? undefined
          : Math.max(0, monotonicNow() - state.run.startedMonotonicAt)
      const timingKey = owner ? threadKey(owner) : viewKeyOf(state)
      toolStarts.delete(timingKey)
      // Model durations are recorded only when the assistant message ends.
      // Settling without that event means the response was interrupted or
      // incomplete, so its wait time must not become a model-time sample.
      // Pi's own `agent_settled` carries only `aborted`; a failure is visible on
      // the last assistant message instead. Do not print a success summary over
      // an error notice.
      const lastAssistant = [...state.items]
        .reverse()
        .find((item) => item.kind === 'assistant')
      const failed =
        crashed ||
        (!aborted && lastAssistant?.kind === 'assistant' && lastAssistant.stopReason === 'error')
      const recentUsers = [...state.items].reverse().filter((item) => item.kind === 'user')
      const runUser = recentUsers.find(
        (item) => item.kind === 'user' && item.runId === state.run.runId
      ) ?? recentUsers[0]
      const runUserIndex = runUser?.kind === 'user' ? state.items.indexOf(runUser) : -1
      const runUserOrdinal = runUserIndex < 0
        ? undefined
        : state.items.slice(0, runUserIndex).reduce(
          (count, item) => count + Number(item.kind === 'user'),
          0
        )
      if (!aborted && !failed && runUser?.kind === 'user') {
        if (durationMs !== undefined) {
          recordRunDuration(timingKey, runUser.timestamp, durationMs, runUserOrdinal)
        }
        // The summed windows of the answers in this turn. A tool gap between
        // them is not generation time and must not slow the restored TPS.
        const generatedMs = state.run.generationMs ?? 0
        if (generatedMs > 0) {
          recordGenerationWindow(timingKey, runUser.timestamp, generatedMs, runUserOrdinal)
        }
      }
      // A mark means "there is something in this conversation the reader has
      // not looked at": a failure outranks an answer, and an answer that
      // finished while the reader was elsewhere is unread. A conversation the
      // reader is watching speaks for itself.
      const settledKey = owner ? threadKey(owner) : ''
      const viewed = settledKey ? settledKey === viewKeyOf(realGet ? realGet() : get()) : true
      const notice: SessionNotice | undefined = viewed
        ? undefined
        : failed
          ? 'error'
          : aborted
            ? undefined
            : 'unread'
      set({
        isStreaming: false,
        items: aborted || crashed ? markAborted(state.items) : state.items,
        run: {
          ...state.run,
          phase: 'idle',
          compaction: undefined,
          messageGenerationStartedAt: undefined,
          modelTurnStartedAt: undefined,
          settled: true,
          outcome: aborted ? 'aborted' : failed ? 'failed' : 'completed',
          durationMs
        },
        retry: undefined,
        notice,
        ...(event.runtimeStopped ? { status: { ...state.status, phase: 'ready' as const }, transport: 'connected' as const } : {}),
        // Pi resolves a dialog on its own when its timeout expires. The
        // client is not told, so the dialog is closed when the agent moves on.
        uiRequest: state.uiRequest ? undefined : state.uiRequest
      })
      // A crashed run has no live process to read state from, and the reason
      // it stopped is the only thing the reader can still act on.
      if (crashed) {
        set((current) => ({
          items: applyEvent(current.items, {
            type: 'client_notice',
            level: 'error',
            text: 'Pi stopped before the run finished'
          })
        }))
      }
      if (realGet && realSet) {
        const current = realGet()
        const threads = enforceSessionLru(current.threads, viewKeyOf(current))
        if (threads !== current.threads) realSet({ threads })
      }
      const key = viewKeyOf(get())
      if (!event.runtimeStopped && !crashed) void get().refreshState(key)
      void get().refreshSessions()
      // The agent just edited files, so the branch chip and the review panel
      // should hear about the new working tree.
      if (!realGet || viewKeyOf(realGet()) === key) void get().refreshGit()
      // The prompt of this turn is a new branch point. Refreshing here as
      // well as on `message_start` covers the case where Pi had not recorded
      // the message yet when the event arrived.
      if (!event.runtimeStopped && !crashed) void get().refreshForkTargets(key)
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
      // Pi can publish a name from a `set_session_name` that did not go
      // through `supervisor.rename` (a scheduled task, `/name` in a draft).
      // The JSONL carries the new `session_info`, so re-read the rows too.
      void get().refreshSessions()
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
        // A provider retry is no longer an active model response. If the
        // failed attempt omitted its completion event, freeze rather than
        // counting the retry backoff as model time.
        run: {
          ...state.run,
          phase: phaseFor(state, 'retrying'),
          modelTurnStartedAt: undefined,
          firstTokenAt: undefined,
          settled: false
        },
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
      if (role === 'assistant') {
        // A fresh answer starts its own generation window; a start left open
        // by an interrupted one must not swallow the new answer's time.
        set((state) => ({
          run: {
            ...state.run,
            messageGenerationBaseMs: state.run.generationMs ?? 0,
            messageGenerationStartedAt: undefined
          }
        }))
      }
      if (role === 'user') {
        const startedAt = Date.now()
        const startedMonotonicAt = monotonicNow()
        set((state) => ({
          // A prompt can start before `agent_start`; invalidate the same
          // cached snapshot here so transcript usage stays current.
          stats: undefined,
          run:
            !state.run.runId || state.run.phase === 'idle' || state.run.settled
              ? // A prompt that started a run before the client saw `agent_start`
                // still needs one, or the items would belong to no run.
                {
                  phase: 'working',
                  runId: nextId('run'),
                  turns: 0,
                  startedAt,
                  startedMonotonicAt,
                  generationMs: 0,
                  settled: false
                }
              : {
                  // A steer arrives between assistant turns in the same run.
                  // The usage line measures the newest prompt, so earlier
                  // answers in this run must not remain in its TPS window.
                  ...state.run,
                  generationMs: 0,
                  messageGenerationBaseMs: 0,
                  messageGenerationStartedAt: undefined
                }
        }))
      }
      scheduleItems(set, get, event)
      if (role === 'user') {
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
      if (event.type === 'compaction_start') {
        const startedAt = Date.now()
        const startedMonotonicAt = monotonicNow()
        set((state) => ({
          run: {
            ...state.run,
            compaction: {
              reason: String(event.reason ?? 'manual'),
              startedAt,
              startedMonotonicAt
            }
          }
        }))
      } else if (event.type === 'compaction_end') {
        set((state) => ({ run: { ...state.run, compaction: undefined } }))
      }
      let eventForItems = event
      if (event.type === 'tool_execution_end') {
        // Apply a queued start first so its monotonic clock can fill in when
        // Pi omitted the duration on the completion event.
        drainPending()
        const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined
        const existing = toolCallId
          ? get().items.find((item) => item.kind === 'tool' && item.toolCallId === toolCallId)
          : undefined
        const terminal = existing?.kind === 'tool' &&
          (existing.status === 'ok' || existing.status === 'error' || existing.status === 'aborted')
        const timingKey = owner ? threadKey(owner) : viewKeyOf(get())
        const startedMonotonicAt = toolCallId ? takeToolStart(timingKey, toolCallId) : undefined
        if (!terminal && toolCallId) {
          const supplied = typeof event.durationMs === 'number' &&
            Number.isFinite(event.durationMs) && event.durationMs >= 0
            ? event.durationMs
            : undefined
          const observed = supplied ?? (startedMonotonicAt !== undefined
            ? Math.max(0, monotonicNow() - startedMonotonicAt)
            : undefined)
          if (observed !== undefined) {
            recordToolDuration(timingKey, toolCallId, observed)
            if (supplied === undefined) eventForItems = { ...event, durationMs: observed }
          } else {
            eventForItems = {
              ...event,
              durationMs: undefined,
              __piDesktopDurationUnavailable: true
            }
          }
        }
      } else if (event.type === 'tool_execution_start') {
        const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined
        const existing = toolCallId
          ? get().items.find((item) => item.kind === 'tool' && item.toolCallId === toolCallId)
          : undefined
        const terminal = existing?.kind === 'tool' &&
          (existing.status === 'ok' || existing.status === 'error' || existing.status === 'aborted')
        if (!terminal && toolCallId) {
          rememberToolStart(owner ? threadKey(owner) : viewKeyOf(get()), toolCallId)
        }
      }
      // Capture the reducer's tool `startedAt` at event arrival; if the start
      // waited for a paint frame, a fast tool could finish before that clock
      // was recorded.
      scheduleItems(set, get, eventForItems, event.type === 'tool_execution_start')
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
        // A file edit or a new file has landed on disk, so the review list is
        // already out of date while the run is still going. Waiting for
        // `agent_settled` made the panel show the previous batch of files for
        // the rest of the run. `refreshGit` reads the *active* project, so a
        // run in another conversation of the same project is worth reading too
        // — only a run in a different project is not.
        if (touchesWorkingTree(event.toolName) && gitBelongsToView(get, realGet, owner)) {
          get().scheduleGitRefresh()
        }
      }
      if (event.type === 'message_end') {
        const message = event.message as { role?: unknown; timestamp?: unknown } | undefined
        if (message?.role === 'assistant' || (message?.role === undefined && get().run.modelTurnStartedAt !== undefined)) {
          // The answer's own window, not the whole run's: tool execution in
          // between is not model generation time.
          closeGenerationWindow(set)
          finishModelTiming(
            set,
            get,
            owner,
            typeof message?.timestamp === 'number' ? message.timestamp : undefined
          )
        }
      }
      // Only text moves the visible phase to generating. Thinking and tool
      // arguments still count as content for timing without changing that phase.
      if (event.type === 'message_update') {
        const payload = event.assistantMessageEvent as {
          type?: string
          delta?: unknown
          message?: { timestamp?: unknown }
        } | undefined
        const kind = payload?.type
        const textBlockStarted = kind === 'text_start'
        const contentDelta = (kind === 'text_delta' || kind === 'thinking_delta' || kind === 'toolcall_delta') &&
          typeof payload?.delta === 'string' &&
          payload.delta.length > 0
        const textDelta = kind === 'text_delta' && contentDelta
        // Output tokens also come from thinking and tool-call blocks, so the
        // answer's generation window starts at its first block of any kind.
        // TTFT is recorded separately from Pi's agent_start to first text delta.
        const generatingDelta =
          textBlockStarted ||
          textDelta ||
          kind === 'thinking_start' ||
          kind === 'thinking_delta' ||
          kind === 'toolcall_start' ||
          kind === 'toolcall_delta'
        const finished =
          kind === 'done' ||
          kind === 'text_end' ||
          kind === 'thinking_end' ||
          kind === 'toolcall_end'
        if (finished) {
          // Some providers close a message through `message_update:done`
          // instead of a top-level `message_end`; both bound TPS.
          closeGenerationWindow(set)
        }
        if (kind === 'done') {
          finishModelTiming(
            set,
            get,
            owner,
            typeof payload?.message?.timestamp === 'number' ? payload.message.timestamp : undefined
          )
        }
        const needsFirstToken = contentDelta && get().run.firstTokenAt === undefined
        const needsWindowStart = generatingDelta && get().run.messageGenerationStartedAt === undefined
        const needsPhase = textDelta && get().run.phase !== phaseFor(get(), 'generating')
        if (needsFirstToken || needsWindowStart || needsPhase) {
          const now = Date.now()
          const monotonic = monotonicNow()
          set((state) => ({
            run: {
              ...state.run,
              ...(textDelta ? { phase: phaseFor(state, 'generating') } : {}),
              settled: false,
              ...(needsFirstToken
                ? { firstTokenAt: now }
                : {}),
              // The start of this answer's generation window. It stays until
              // the block ends, so TPS never counts a tool gap.
              ...(state.run.messageGenerationStartedAt === undefined
                ? { messageGenerationStartedAt: monotonic }
                : {})
            }
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
      // Extension "info" is terminal chatter — startup banners such as
      // "Ponytail loaded: full" arrive on every cold start. Only a warning or
      // an error is worth interrupting what the user is writing.
      const level = request.notifyType ?? 'info'
      if (level === 'warning' || level === 'error') {
        get().showToast(stripAnsi(request.message ?? ''), level)
      }
      break
    }
    case 'setStatus': {
      const key = request.statusKey
      if (!key) break
      if (key === GENERATION_TIMING_STATUS_KEY) {
        let sample: { ttftMs?: unknown }
        try { sample = JSON.parse(request.statusText ?? '') } catch { break }
        const ttftMs = sample?.ttftMs
        const state = get()
        if (typeof ttftMs !== 'number' || !Number.isFinite(ttftMs) || ttftMs < 0 ||
            state.run.settled || !state.run.runId || state.run.ttftMs !== undefined) break
        recordTtftDuration(owner ? threadKey(owner) : viewKeyOf(state), state.run.runId, ttftMs)
        set((current) => ({ run: { ...current.run, ttftMs } }))
        break
      }
      if (key === SUBAGENT_EDITOR_CANCEL_STATUS_KEY) {
        let cancellation: { requestId?: unknown }
        try { cancellation = JSON.parse(request.statusText ?? '') } catch { break }
        const requestId = cancellation?.requestId
        const state = get()
        if (typeof requestId !== 'string' || state.uiRequest?.id !== requestId) break
        const sessionKey = taggedRequest.sessionKey || viewKeyOf(state)
        set((current) => ({
          uiRequest: undefined,
          run: current.run.phase === 'waiting_approval'
            ? { ...current.run, phase: 'working' as const }
            : current.run
        }))
        void window.pi.runtime.respondUi(requestId, { confirmed: false, cancelled: true }, sessionKey)
          .catch((error: unknown) => get().showToast(messageOf(error), 'error'))
        break
      }
      if (key === CONTEXT_BREAKDOWN_STATUS_KEY) {
        const contextBreakdown = parseRequestContextBreakdown(request.statusText)
        if (contextBreakdown) {
          if (taggedRequest.sessionKey) {
            bindSet(set, get, taggedRequest.sessionKey)({ contextBreakdown })
          } else {
            set({ contextBreakdown })
          }
        }
        break
      }
      if (key === 'pi-desktop-mode') {
        const mode = request.statusText
        if (mode === 'default' || mode === 'goal' || mode === 'plan' || mode === 'subagent' || mode === 'plugin') set({ agentMode: mode })
        break
      }
      const text = request.statusText
        ? stripAnsi(request.statusText).replace(/\s+/g, ' ').trim()
        : ''
      set((state) => ({
        uiStatuses: text
          ? [...state.uiStatuses.filter((entry) => entry.key !== key), { key, text }]
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
                lines: request.widgetLines!.map((line) => stripAnsi(line)),
                placement: request.widgetPlacement ?? 'aboveEditor'
              }
            ]
          : state.uiWidgets.filter((entry) => entry.key !== key)
      }))
      break
    }
    case 'setTitle': {
      set({ uiTitle: request.title ? stripAnsi(request.title) : request.title })
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
