import { create } from 'zustand'
import {
  CONTEXT_BREAKDOWN_STATUS_KEY,
  GENERATION_TIMING_STATUS_KEY,
  GOAL_CONTINUE_CUSTOM_TYPE,
  GOAL_STATUS_KEY,
  SUBAGENT_EDITOR_CANCEL_STATUS_KEY,
  TASK_MODE_STATUS_KEY
} from '@shared/types'
import { isAgentMode } from '@shared/task-mode-state'
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
  RuntimeQueueEvent,
  RuntimeStatus,
  SessionHydrationResult,
  SessionMeta,
  SessionSearchHit,
  SessionStats,
  SettingsPatchBaseline,
  Workspace
} from '@shared/types'
import type { ProviderProfile, SaveProviderInput } from '@shared/providers'
import { modelsFromProfiles, resolveSavedModel, selectableModels } from '@shared/provider-models'
import type { SessionNotice } from '../lib/session-indicator'
import { loadSessionNotices, saveSessionNotices } from '../lib/session-notices'
import {
  applyEventBatch,
  applyEvent,
  changedThreadItemsFrom,
  clearPendingPrompts,
  itemsFromMessages,
  lastAssistantText,
  markAborted,
  mergeHydratedItems,
  nextId,
  nextOrder,
  textOf,
  type ThreadItem,
  type UserItem
} from '../lib/thread'
import { basename, resolveAgainst, samePath } from '../lib/path'
import {
  activeConversationTitle,
  conversationRows,
  listPendingUiSessions,
  updateThreadSessionName,
  type PendingUiSession
} from '../lib/live-sessions'
import { stripAnsi } from '../lib/ansi'
import { accentInk } from '../lib/accent-ink'
import { trayConversations } from '../lib/tray-conversations'
import { translate } from '../lib/i18n'
import { collectProjects, type Project } from '../lib/projects'
import { APP_COMMANDS, normalizeAppCommandInput } from '../lib/app-commands'
import { COMPACTION_EXTENSION_MANAGED_MESSAGE, compactionOwnedByExtension, describeCompactionFailure } from '../lib/compaction-error'
import { isMcpOrSkillChatter } from '../lib/extension-notices'
import { SWARM_STATUS_KEY } from '../lib/swarm'
import { needsSessionHydration, scopeEvent, scopeStatus } from '../lib/session-scope'
import { clearScrollMemory, migrateScrollMemory, rememberScrollPosition, scrollKeyOf } from '../lib/scroll-memory'
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
  recordRoundDuration,
  recordRunDuration,
  recordToolDuration,
  recordTtftDuration
} from '../lib/session-timing'
import { conversationStarted, nextWorktreeBranch } from '../lib/worktree-name'
import {
  composerDraftAfterSend,
  forgetLastDraftKey,
  loadComposerDrafts,
  pruneComposerDrafts,
  saveComposerDrafts
} from '../lib/composer-drafts'
import type { ComposerDraft, ComposerImageOptions } from '../lib/composer-drafts'
import { FONT_STACK_PROPERTIES, uiFontStack } from '../lib/ui-font'

export { listPendingUiSessions, type PendingUiSession }
export type {
  ComposerDraft,
  ComposerDraftCommand,
  ComposerDraftImage,
  ComposerImageOptions
} from '../lib/composer-drafts'
export type { ComposerDraftFile } from '../lib/composer-files'

export type QueueKind = 'steer' | 'followUp'

export type CwdWaitState = Omit<RuntimeQueueEvent, 'ownerId' | 'queued'>

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
  /** Number of turns in the active Goal Mode round, or undefined before a continuation. */
  roundTurns?: number
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
  /** True when the run hit an extension or retry error before settling. */
  hadError?: boolean
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
  /** The transcript has its history, even if live events arrived before the read. */
  historyLoaded?: boolean
  /** The visible transcript is a bounded tail, not the complete session history. */
  historyTruncated?: boolean
  run: RunState
  isStreaming: boolean
  transport: 'connected' | 'disconnected'
  uiRequest?: ExtensionUiRequest
  /** FIFO blocking extension dialogs for this conversation (`uiRequest === uiRequests[0]`). */
  uiRequests: ExtensionUiRequest[]
  /** Stable client identity preserved across draft -> file promotion (`rekeyThread`), fresh on fork. */
  clientKey: string
  /** Set while queued behind another session holding an overlapping working directory. */
  cwdWait?: CwdWaitState | null
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
  /** Live mode and goal status outrank a read of the same conversation from disk. */
  hasLiveTaskMode?: boolean
  models: ModelInfo[]
  thinkingLevels: string[]
  commands: PiCommand[]
  version: number
  /** Monotonic counter bumped when a user prompt or inline command is submitted in this conversation. */
  submitSeq?: number
  /**
   * What the last background run left behind: a failure, or an answer the
   * reader has not seen yet. It is cleared when the conversation is opened,
   * so it only ever marks the rows that are not on screen.
   */
  notice?: SessionNotice
}

const THREAD_KEYS = [
  'items',
  'historyLoaded',
  'historyTruncated',
  'run',
  'isStreaming',
  'transport',
  'uiRequest',
  'uiRequests',
  'clientKey',
  'cwdWait',
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
  'hasLiveTaskMode',
  'models',
  'thinkingLevels',
  'commands',
  'submitSeq',
  'notice'
] as const

function mintClientKey(): string {
  return nextId('client')
}

function emptyThread(
  cwd?: string,
  agentMode: AgentMode = 'default',
  historyLoaded = false
): SessionThread {
  return {
    items: [],
    historyLoaded,
    historyTruncated: false,
    run: IDLE_RUN,
    isStreaming: false,
    transport: 'connected',
    uiRequests: [],
    clientKey: mintClientKey(),
    uiStatuses: [],
    uiWidgets: [],
    queue: { steering: [], followUp: [] },
    status: { phase: 'ready', cwd },
    forkTargets: [],
    agentMode,
    models: [],
    thinkingLevels: [],
    commands: APP_COMMANDS,
    submitSeq: 0,
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

export function draftKeyOf(state: { activeSessionFile?: string; draftId?: string }): string {
  return state.activeSessionFile || state.draftId || ''
}

function viewKeyOf(state: { activeSessionFile?: string; draftId?: string }): string {
  return draftKeyOf(state)
}

/**
 * The model the active conversation runs on.
 *
 * The live process's choice wins. A cold conversation reads its own persisted
 * model — Pi records every `model_change` in the session file and the sessions
 * list carries the last one — so a conversation keeps the model it last used
 * instead of following whatever the app default currently is. A draft has no
 * model of its own yet and shows the app default.
 */
function currentConversationModel(
  state: {
    activeSessionFile?: string
    sessions: SessionMeta[]
    piState?: { model?: ModelInfo }
    settings: { model?: string; provider?: string }
  },
  models: ModelInfo[]
): ModelInfo | undefined {
  const live = state.piState?.model
  if (live?.id && live.provider) return live
  const key = state.activeSessionFile
  const spec = key ? state.sessions.find((entry) => entry.file === key)?.model : undefined
  return resolveSavedModel(spec ?? state.settings.model, state.settings.provider, models)
}

/** Record a conversation's model choice in the sessions list immediately, so
 * the picker keeps showing it before the watcher re-reads the session file. */
function rememberSessionModel(
  set: (partial: Partial<AppStore> | ((state: AppStore) => Partial<AppStore>)) => void,
  key: string,
  spec: string
): void {
  set((state) => ({
    sessions: state.sessions.map((entry) =>
      entry.file === key && entry.model !== spec ? { ...entry, model: spec } : entry
    )
  }))
}

function pinScrollToBottom(sessionKey: string | undefined): void {
  const raw = sessionKey?.trim()
  if (!raw) return
  const snapshot = { top: Number.MAX_SAFE_INTEGER, atBottom: true }
  rememberScrollPosition(scrollKeyOf(raw), snapshot)
  const canonical = threadKey(raw)
  if (canonical && canonical !== raw) {
    rememberScrollPosition(scrollKeyOf(canonical), snapshot)
  }
}

/**
 * True when an installed extension has taken over context compaction.
 *
 * See `compactionOwnedByExtension` in `lib/compaction-error.ts`: the live
 * process's command list says whether a native compact would be vetoed.
 */

function mintDraft(): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return `draft:${id}`
}

function draftWorkspaceKey(workspace: Workspace | undefined): string {
  return workspace?.id ?? 'projectless'
}

interface ComposerSubmission {
  draft: ComposerDraft
  text: string
  kind: QueueKind
  imageOptions?: ComposerImageOptions
  sendImage?: ComposerImageOptions
}

function composerClientKey(state: AppStore, key: string): string {
  return state.threads[key]?.clientKey || key || state.clientKey || '__fallback__'
}

function restoreCancelledPrompts(
  state: AppStore,
  key: string,
  removed: { steering: string[]; followUp: string[] } | undefined,
  submission: ComposerSubmission | undefined
): void {
  const prompts = [...(removed?.steering ?? []), ...(removed?.followUp ?? [])]
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (submission && state.drafts[threadKey(key)] === submission.draft) {
    // One cancelled prompt already survives in the editor until acceptance.
    const text = normalizeAppCommandInput(submission.text.trim())
    const index = prompts.lastIndexOf(text)
    if (index >= 0) prompts.splice(index, 1)
  }
  if (prompts.length) state.insertIntoComposer(prompts.join('\n'), 'append', key)
}

let draftPersistenceWarning: 'partial' | 'failed' | undefined
const DRAFT_SAVE_DEBOUNCE_MS = 350
const cachedLastDraftKeysByStorage = new WeakMap<Storage, Record<string, string>>()
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null
let pendingDraftSnapshotWrite: {
  state: AppStore
  drafts: Record<string, ComposerDraft>
  lastDraftKeys: Record<string, string>
} | null = null

function cachedDraftStorage(): Storage | undefined {
  try {
    if (typeof localStorage !== 'undefined') return localStorage
    if (typeof window !== 'undefined') return window.localStorage
    return undefined
  } catch {
    return undefined
  }
}

function readCachedLastDraftKeys(): Record<string, string> {
  const storage = cachedDraftStorage()
  if (storage) {
    const cached = cachedLastDraftKeysByStorage.get(storage)
    if (cached) return { ...cached }
  }
  const saved = loadComposerDrafts()
  if (storage) cachedLastDraftKeysByStorage.set(storage, { ...saved.lastDraftKeys })
  return { ...saved.lastDraftKeys }
}

function rememberCachedLastDraftKeys(lastDraftKeys: Record<string, string>): void {
  const storage = cachedDraftStorage()
  if (storage) cachedLastDraftKeysByStorage.set(storage, { ...lastDraftKeys })
}

function writeDraftSnapshot(
  state: AppStore,
  snapshot: { drafts: Record<string, ComposerDraft>; lastDraftKeys: Record<string, string> }
): void {
  rememberCachedLastDraftKeys(snapshot.lastDraftKeys)
  const result = saveComposerDrafts(snapshot)
  if (result === 'saved') {
    draftPersistenceWarning = undefined
    return
  }
  if (draftPersistenceWarning === result) return
  draftPersistenceWarning = result
  const zh = state.settings.language === 'zh-CN'
  const message = result === 'partial'
    ? zh
      ? '草稿图片超出存储配额，重启后可能不完整。文字和文件引用已保存。'
      : 'Draft images exceeded the storage limit and may be incomplete after restart. Text and file references were saved.'
    : zh
      ? '草稿无法保存，重启后可能无法恢复。'
      : 'This draft could not be saved for restart recovery.'
  // Some callers are inside a Zustand updater; publish the notice after that
  // state transition rather than nesting another store write in it.
  queueMicrotask(() => state.showToast(message, 'warning'))
}

function flushPendingDraftWrite(): void {
  if (draftSaveTimer !== null) {
    globalThis.clearTimeout(draftSaveTimer)
    draftSaveTimer = null
  }
  const pending = pendingDraftSnapshotWrite
  if (!pending) return
  pendingDraftSnapshotWrite = null
  writeDraftSnapshot(pending.state, {
    drafts: pending.drafts,
    lastDraftKeys: pending.lastDraftKeys
  })
}

function persistDraftSnapshot(
  state: AppStore,
  drafts: Record<string, ComposerDraft>,
  lastDraftKey?: string | null,
  options?: { debounce?: boolean }
): void {
  const lastDraftKeys = readCachedLastDraftKeys()
  const workspaceKey = draftWorkspaceKey(state.workspace)
  if (lastDraftKey === null) delete lastDraftKeys[workspaceKey]
  else if (lastDraftKey) lastDraftKeys[workspaceKey] = lastDraftKey
  rememberCachedLastDraftKeys(lastDraftKeys)

  if (options?.debounce) {
    pendingDraftSnapshotWrite = { state, drafts, lastDraftKeys }
    if (draftSaveTimer !== null) globalThis.clearTimeout(draftSaveTimer)
    draftSaveTimer = globalThis.setTimeout(() => {
      draftSaveTimer = null
      flushPendingDraftWrite()
    }, DRAFT_SAVE_DEBOUNCE_MS)
    ;(draftSaveTimer as unknown as { unref?: () => void }).unref?.()
    return
  }

  if (draftSaveTimer !== null) {
    globalThis.clearTimeout(draftSaveTimer)
    draftSaveTimer = null
  }
  pendingDraftSnapshotWrite = null
  writeDraftSnapshot(state, { drafts, lastDraftKeys })
}

function persistPromotedDraft(state: AppStore, from: string, drafts: Record<string, ComposerDraft>): void {
  if (draftSaveTimer !== null) {
    globalThis.clearTimeout(draftSaveTimer)
    draftSaveTimer = null
  }
  pendingDraftSnapshotWrite = null
  const lastDraftKeys = readCachedLastDraftKeys()
  const updated = forgetLastDraftKey({ drafts, lastDraftKeys }, from)
  writeDraftSnapshot(state, updated)
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', flushPendingDraftWrite)
  window.addEventListener('beforeunload', flushPendingDraftWrite)
  window.addEventListener('blur', flushPendingDraftWrite)
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingDraftWrite()
  })
}

export interface AppStore {
  info?: AppInfo
  settings: AppSettings
  workspace?: Workspace
  sessions: SessionMeta[]
  status: RuntimeStatus
  agentMode: AgentMode
  hasLiveTaskMode?: boolean
  setAgentMode: (mode: AgentMode) => Promise<void>
  /** Run a task-mode extension command through the live Pi process. */
  runTaskCommand: (command: string) => Promise<string | undefined>
  /**
   * Stop one running or queued subagent task. The id is the `toolCallId:index`
   * the subagent tree shows; a session that is not on screen is targeted by key.
   */
  cancelSubagentTask: (taskId: string, sessionKey?: string) => Promise<void>
  /**
   * Stop one swarm worker in the visible conversation. The lead turn is
   * blocked inside a swarm tool call, so this travels as an extension command.
   */
  stopSwarmWorker: (name: string, sessionKey?: string) => Promise<void>
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
  historyLoaded?: boolean
  /** True when the active transcript was hydrated from a bounded disk tail. */
  historyTruncated?: boolean
  /** Transcript and run of every conversation, keyed by file path or draft id. */
  threads: Record<string, SessionThread>
  /**
   * Monotonic counter bumped only when thread keys change or a thread's
   * sidebar/dialog metadata changes (`isStreaming`, `notice`, `pendingUiRequests.length`,
   * `firstPrompt`, `sessionFile`) — never on pure text/thinking stream deltas.
   */
  threadsMetaVersion: number
  /**
   * Monotonic counter bumped only when the active thread changes/hydrates/clears
   * or a tool item in the active thread changes — never on pure text/thinking deltas.
   */
  activeToolsRevision: number
  /**
   * Monotonic counter bumped when any thread's tool items change (or thread keys
   * change) — lets cross-session views such as SubagentPanel ignore 60fps text deltas.
   */
  threadsToolsRevision: number
  /**
   * Unread/failed marks that outlive the in-memory thread, keyed by session
   * file. A background run's notice must survive a restart so the sidebar can
   * keep pointing at the conversation the reader has not opened yet.
   */
  sessionNotices: Record<string, SessionNotice>
  rememberSessionNotice: (file: string, notice: SessionNotice) => void
  forgetSessionNotice: (file: string) => void
  /** Per-session unsent composer text, attachments, pasted chunks, and input history. */
  drafts: Record<string, ComposerDraft>
  updateDraft: (
    sessionKey: string,
    updater: Partial<ComposerDraft> | ((prev: ComposerDraft) => ComposerDraft)
  ) => void
  clearDraft: (sessionKey: string) => void
  /** Conversation that has not been given a file yet. */
  draftId?: string
  queue: { steering: string[]; followUp: string[] }
  activeSessionFile?: string
  /** Stable identity of the viewed conversation across draft -> file rekeying. */
  clientKey: string
  /** Queue metadata when the viewed session is waiting behind another session holding its cwd. */
  cwdWait?: CwdWaitState | null
  /** The conversation column is showing the plugin/skill marketplace or scheduled tasks instead of the thread. */
  deskPage: 'marketplace' | 'scheduled' | null
  setDeskPage: (page: 'marketplace' | 'scheduled' | null) => void
  /** Session file whose historical messages are being hydrated into the view. */
  hydratingSessionFile?: string
  /** User messages the active branch can be forked from. */
  forkTargets: ForkTarget[]
  /** True while a fork or an edit rewind is in flight, so the button cannot be pressed twice. */
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
  toast?: { text: string; level: 'info' | 'warning' | 'error'; sessionKey?: string }
  /** Branch and working tree of the open project, when it is a git repo. */
  git?: GitStatus
  /** Bumped when the app asks the review panel to open its commit dialog. */
  commitRequest: number
  /** Monotonic counter bumped when a user prompt or inline command is submitted in this conversation. */
  submitSeq?: number
  /** A message the thread has been asked to scroll to and flash. */
  pendingJump?: PendingJump
  /**
   * A project the user asked for while a run was going. The run is never
   * ended for it: the switch happens once `agent_settled` arrives.
   */
  pendingProject?: { path: string | null; name: string }
  /**
   * The branch-menu checkbox. Checking it does not create a worktree; the
   * folder is created when the next empty conversation sends its first prompt.
   */
  pendingWorktree: boolean
  setPendingWorktree: (armed: boolean) => void

  /** A blocking extension dialog waiting for an answer. */
  uiRequest?: ExtensionUiRequest
  /** FIFO queue of blocking dialogs for the viewed conversation (`uiRequest === uiRequests[0]`). */
  uiRequests: ExtensionUiRequest[]
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
  ) => Promise<string | undefined>
  pickWorkspace: () => Promise<void>
  closeWorkspace: () => Promise<void>
  /**
   * Make the project at `path` the active one and run Pi there.
   *
   * `allowWhileRunning` is for a *deliberate* project change (a picked folder,
   * a worktree, the launcher). A project row in the sidebar only expands and
   * collapses, so it never has to ask, and expanding never ends a run.
   */
  switchProject: (path: string | null, options?: { allowWhileRunning?: boolean }) => Promise<string | undefined>
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
  hydrateSession: (file: string, scope?: 'branch') => Promise<void>
  renameSession: (name: string) => Promise<boolean>
  /** Name a conversation from the list, active or not. */
  renameSessionFile: (file: string, name: string) => Promise<boolean>
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
  submittingDrafts: Record<string, ComposerSubmission>
  submitComposerDraft: (sessionKey: string, submission: ComposerSubmission) => Promise<boolean>
  send: (
    text: string,
    images: { data: string; mimeType: string }[],
    kind?: QueueKind,
    image?: ComposerImageOptions
  ) => Promise<boolean>
  sendPrompt: (
    sessionKey: string,
    text: string,
    images: { data: string; mimeType: string }[],
    kind: QueueKind,
    image?: ComposerImageOptions
  ) => Promise<boolean>
  /** Execute a shell command inline in the thread via Pi's `bash` RPC. */
  runInlineBash: (command: string, excludeFromContext?: boolean) => Promise<boolean>
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
  refreshState: (sessionKey?: string, options?: { includeCatalog?: boolean }) => Promise<void>
  /**
   * Ask Pi for `get_session_stats` right now.
   *
   * Returns `undefined` when no process is running for that conversation —
   * this never starts one — so the caller can fall back to the transcript.
   */
  readSessionStats: (sessionKey?: string) => Promise<SessionStats | undefined>
  /**
   * Keep the visible statistics moving while a run is live.
   *
   * `agent_start` drops the last snapshot so the transcript can drive the
   * usage line; Pi becomes the authority again as soon as an answer lands.
   * This reads only `get_session_stats`, throttled per conversation, so a
   * long tool-heavy run does not wait for `agent_settled` to show its totals.
   * It never starts a process.
   */
  refreshLiveStats: (sessionKey?: string) => void
  refreshInfo: () => Promise<void>
  /** Remember the conversation that is open in the current project. */
  rememberSession: (file: string) => Promise<void>
  reloadMessages: (sessionKey?: string, history?: Pick<SessionHydrationResult, 'messages' | 'historyTruncated'>) => Promise<void>
  refreshCommands: (sessionKey?: string) => Promise<void>
  refreshSkillCommands: (sessionKey?: string) => Promise<void>
  /** Run one of the commands the app itself provides. */
  runAppCommand: (name: string) => Promise<void>
  updateSettings: (patch: Partial<AppSettings>, baseline?: SettingsPatchBaseline) => Promise<void>
  saveProvider: (input: SaveProviderInput) => Promise<{ provider: ProviderProfile; applied: boolean; applyError?: string }>
  removeProvider: (id: string) => Promise<void>
  /** Pin a conversation to the top of the sidebar, or unpin it. */
  togglePin: (file: string) => Promise<void>
  dismissError: () => void
  showToast: (message: string, level?: 'info' | 'warning' | 'error', sessionKey?: string) => void
  clearToast: () => void
  respondUi: (
    response: ExtensionUiResponse,
    target?: { sessionKey?: string; requestId?: string }
  ) => Promise<void>
  dismissUi: (target?: { sessionKey?: string; requestId?: string }) => Promise<void>
  clearComposerText: () => void
  /** Append text to the composer and focus it. */
  insertIntoComposer: (text: string, mode?: 'append' | 'replace', sessionKey?: string) => void
  refreshForkTargets: (sessionKey?: string) => Promise<void>
  /** Start a new branch that keeps the history before `entryId`. */
  forkFrom: (entryId: string) => Promise<void>
  /**
   * Move this conversation back to before `entryId` in the same session file
   * and put the original prompt back in the composer for editing.
   */
  editMessageFrom: (
    target: string | UserItem,
    text?: string,
    images?: { data: string; mimeType: string }[]
  ) => Promise<void>
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
  commitChanges: (message: string, includeUnstaged: boolean, expectedRoot: string) => Promise<GitCommitResult>
  /** Move one file into (or out of) the index and refresh the git state. */
  stageFile: (file: string, expectedRoot: string) => Promise<GitCommitResult>
  unstageFile: (file: string, expectedRoot: string) => Promise<GitCommitResult>
  stageAll: (expectedRoot: string) => Promise<GitCommitResult>
  unstageAll: (expectedRoot: string) => Promise<GitCommitResult>
  pushGit: (expectedRoot: string) => Promise<GitCommitResult>
  pullGit: (expectedRoot: string) => Promise<GitCommitResult>
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
let sessionMutationSeq = 0
let sessionsRefreshInFlight: { epoch: number; mutation: number; promise: Promise<void> } | null = null
/** Prevent older Pi state reads from overwriting a newer snapshot per thread. */
let refreshStateRequestSequence = 0
const refreshStateRequests = new Map<string, number>()
/**
 * One live `get_session_stats` per conversation at a time, and the earliest
 * moment the next one may start. A tool-heavy turn ends a message every few
 * seconds; asking Pi after each of them is enough to keep the usage line and
 * the context ring moving without flooding the RPC pipe.
 */
const LIVE_STATS_INTERVAL_MS = 1_500
const MAX_SESSION_TRACKER_ENTRIES = 200
const liveStatsAt = new Map<string, number>()
const liveStatsInFlight = new Map<string, Promise<void>>()
/**
 * A run's start invalidates a read that was already in flight: it describes
 * the session before this run's first token, and letting it land would mask
 * the fresh transcript numbers with the previous totals.
 */
const liveStatsEpoch = new Map<string, number>()

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, limit = MAX_SESSION_TRACKER_ENTRIES): void {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  while (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

function addBoundedSet<T>(set: Set<T>, value: T, limit = MAX_SESSION_TRACKER_ENTRIES): void {
  if (set.has(value)) set.delete(value)
  set.add(value)
  while (set.size > limit) {
    const oldest = set.values().next().value
    if (oldest === undefined) break
    set.delete(oldest)
  }
}
let modelCatalogRequestSequence = 0
let agentSettingSelectionInFlight = false
/** Owners whose compact RPC is still running. Pi aborts the previous compaction
 *  when a second `compact` command lands, so a double click used to cancel the
 *  first run and report it as a failure. */
const compactionInFlight = new Set<string>()
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
let gitMutationSeq = 0
let gitRefreshInFlight: { epoch: number; mutation: number; promise: Promise<void> } | null = null

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

const hydrationInFlight = new Map<string, Promise<void>>()
let pendingRewind: { sessionKey: string; error?: string } | undefined
const inlineBashCounts = new Map<string, number>()
const respondingUiIds = new Set<string>()

/**
 * Prompts the reader submitted that the main process has not handed to Pi yet.
 *
 * The supervisor answers `prompt` only once the working folder is free, so a
 * message can sit inside the desktop while the composer is already empty. A
 * `queued` event from the supervisor is the proof that this happened, and is
 * the moment its bubble is revealed; a prompt that Pi takes directly never
 * needs one.
 */
const queuedPromptDrafts = new Map<string, UserItem[]>()

function rememberQueuedPrompt(sessionKey: string, prompt: UserItem): void {
  const key = threadKey(sessionKey)
  const list = queuedPromptDrafts.get(key)
  if (list) list.push(prompt)
  else queuedPromptDrafts.set(key, [prompt])
}

function forgetQueuedPrompt(sessionKey: string, id: string): void {
  const key = threadKey(sessionKey)
  const list = queuedPromptDrafts.get(key)
  if (!list) return
  const next = list.filter((entry) => entry.id !== id)
  if (next.length > 0) queuedPromptDrafts.set(key, next)
  else queuedPromptDrafts.delete(key)
}

function takeQueuedPrompts(sessionKey: string): UserItem[] {
  const key = threadKey(sessionKey)
  const list = queuedPromptDrafts.get(key)
  if (!list || list.length === 0) return []
  queuedPromptDrafts.delete(key)
  return list
}

function migrateQueuedPrompts(from: string, to: string): void {
  const list = queuedPromptDrafts.get(from)
  if (!list) return
  queuedPromptDrafts.delete(from)
  const existing = queuedPromptDrafts.get(to)
  queuedPromptDrafts.set(to, existing ? [...existing, ...list] : list)
}

function hasThreadWork(thread: SessionThread): boolean {
  if (thread.items.length > 0) return true
  if (thread.isStreaming) return true
  if (thread.uiRequest || (thread.uiRequests && thread.uiRequests.length > 0)) return true
  if (thread.queue.steering.length > 0 || thread.queue.followUp.length > 0) return true
  return thread.run.phase !== 'idle' && !thread.run.settled
}

/** Remove abandoned empty `draft:` threads when switching views so they never accumulate in `threads`. */
function pruneIdleDraftThreads(
  threads: Record<string, SessionThread>,
  keepKey?: string
): Record<string, SessionThread> {
  const canonicalKeep = keepKey ? threadKey(keepKey) : undefined
  let next: Record<string, SessionThread> | undefined
  for (const [key, thread] of Object.entries(threads)) {
    if (!key.startsWith('draft:')) continue
    if (key === keepKey || key === canonicalKeep) continue
    if (hasThreadWork(thread)) continue
    next ??= { ...threads }
    delete next[key]
  }
  return next ?? threads
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
    if (thread.uiRequest || (thread.uiRequests && thread.uiRequests.length > 0)) continue
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
        models: [],
        commands: [],
        forkTargets: [],
        stats: undefined,
        contextBreakdown: undefined,
        uiWidgets: [],
        historyLoaded: false,
        version: 0
      }
      changed = true
    }
    // Keep `historyFirstVisibleTurn` across LRU item eviction so returning
    // to an older conversation restores the reader's expanded history slice.
    clearViewState(key, { preserveHistoryWindow: true })
    liveStatsAt.delete(key)
    liveStatsEpoch.delete(key)
    for (const attempt of modelRestoreAttempts) {
      if (attempt.startsWith(`${key}:`)) modelRestoreAttempts.delete(attempt)
    }
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
    if (state.threads[key]?.isStreaming || state.threads[key]?.run.settled === false) return
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

/**
 * The armed worktree checkbox becomes a folder only when a session starts.
 *
 * A conversation that already has a prompt keeps its current checkout. The
 * first prompt of an empty one is the start: create the sibling worktree,
 * switch to it, then let `send` continue in that folder.
 */
async function createWorktreeForSessionStart(get: GetState, source: string): Promise<string | undefined> {
  const state = get()
  const epoch = workspaceEpoch
  state.setPendingWorktree(false)
  let target: string
  try {
    const listed = await window.pi.git.branches(source)
    if (epoch !== workspaceEpoch) return
    const taken = [
      ...(listed?.branches ?? []).map((branch) => branch.name),
      ...(listed?.worktrees ?? []).flatMap((worktree) => (worktree.branch ? [worktree.branch] : []))
    ]
    const name = nextWorktreeBranch(listed?.current ?? state.git?.branch, taken)
    const result = await window.pi.git.addWorktree('', name, true, source)
    if (!result.ok || !result.path) throw new Error(result.error ?? 'Could not add the worktree')
    target = result.path
  } catch (error) {
    if (epoch === workspaceEpoch) {
      get().setPendingWorktree(true)
      get().showToast(messageOf(error), 'error')
    }
    return
  }

  get().showToast(`Worktree created at ${target}`)
  if (epoch !== workspaceEpoch) return
  try {
    return await get().switchProject(target, { allowWhileRunning: true })
  } catch (error) {
    get().showToast(`Could not open the new worktree (${messageOf(error)})`, 'error')
    return
  }
}

interface ThreadMetaDigest {
  isStreaming: boolean
  notice: SessionNotice | undefined
  pendingUiCount: number
  firstPrompt: string
  firstPromptIndex: number
  itemsRef: readonly ThreadItem[]
  sessionFile: string | undefined
}

const threadMetaDigests = new WeakMap<SessionThread, ThreadMetaDigest>()

function threadFirstPrompt(
  items: readonly ThreadItem[],
  previous?: ThreadMetaDigest
): { text: string; index: number } {
  if (
    previous &&
    previous.firstPromptIndex >= 0 &&
    items.length > previous.firstPromptIndex &&
    items[previous.firstPromptIndex] === previous.itemsRef[previous.firstPromptIndex]
  ) {
    if (previous.firstPromptIndex === 0) {
      return { text: previous.firstPrompt, index: 0 }
    }
    const diff = changedThreadItemsFrom(items as ThreadItem[], previous.itemsRef as ThreadItem[])
    if (diff !== undefined && diff > previous.firstPromptIndex) {
      return { text: previous.firstPrompt, index: previous.firstPromptIndex }
    }
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.kind === 'user' && item.text.trim()) {
      return { text: item.text, index }
    }
  }
  return { text: '', index: -1 }
}

function digestOfThread(thread: SessionThread, previousThread?: SessionThread): ThreadMetaDigest {
  const cached = threadMetaDigests.get(thread)
  if (cached) return cached
  const prevDigest = previousThread ? threadMetaDigests.get(previousThread) : undefined
  const firstPrompt =
    prevDigest && prevDigest.itemsRef === thread.items
      ? { text: prevDigest.firstPrompt, index: prevDigest.firstPromptIndex }
      : threadFirstPrompt(thread.items, prevDigest)
  const digest: ThreadMetaDigest = {
    isStreaming: thread.isStreaming,
    notice: thread.notice,
    pendingUiCount: pendingDialogsFor(thread).length,
    firstPrompt: firstPrompt.text,
    firstPromptIndex: firstPrompt.index,
    itemsRef: thread.items,
    sessionFile: thread.piState?.sessionFile
  }
  threadMetaDigests.set(thread, digest)
  return digest
}

function hasThreadsMetaChange(
  prevThreads: Readonly<Record<string, SessionThread>>,
  nextThreads: Readonly<Record<string, SessionThread>>
): boolean {
  if (prevThreads === nextThreads) return false
  const prevKeys = Object.keys(prevThreads)
  const nextKeys = Object.keys(nextThreads)
  if (prevKeys.length !== nextKeys.length) return true
  for (let index = 0; index < nextKeys.length; index += 1) {
    const key = nextKeys[index]
    if (!(key in prevThreads)) return true
    const prevThread = prevThreads[key]
    const nextThread = nextThreads[key]
    if (prevThread === nextThread) continue
    const prevDigest = digestOfThread(prevThread)
    const nextDigest = digestOfThread(nextThread, prevThread)
    if (
      prevDigest.isStreaming !== nextDigest.isStreaming ||
      prevDigest.notice !== nextDigest.notice ||
      prevDigest.pendingUiCount !== nextDigest.pendingUiCount ||
      prevDigest.firstPrompt !== nextDigest.firstPrompt ||
      prevDigest.sessionFile !== nextDigest.sessionFile
    ) {
      return true
    }
  }
  return false
}

function hasToolItemChange(
  prevItems: readonly ThreadItem[],
  nextItems: readonly ThreadItem[]
): boolean {
  if (prevItems === nextItems) return false
  const firstDiff = changedThreadItemsFrom(nextItems as ThreadItem[], prevItems as ThreadItem[])
  if (firstDiff !== undefined) {
    const end = Math.max(prevItems.length, nextItems.length)
    for (let index = firstDiff; index < end; index += 1) {
      if (prevItems[index]?.kind === 'tool' || nextItems[index]?.kind === 'tool') {
        return true
      }
    }
    return false
  }
  let prevTools = 0
  for (let index = 0; index < prevItems.length; index += 1) {
    if (prevItems[index]?.kind === 'tool') prevTools += 1
  }
  let nextTools = 0
  let cursor = 0
  for (let index = 0; index < nextItems.length; index += 1) {
    const nextItem = nextItems[index]
    if (nextItem?.kind !== 'tool') continue
    nextTools += 1
    while (cursor < prevItems.length && prevItems[cursor]?.kind !== 'tool') {
      cursor += 1
    }
    if (cursor >= prevItems.length || prevItems[cursor] !== nextItem) {
      return true
    }
    cursor += 1
  }
  return prevTools !== nextTools
}

function hasThreadsToolsChange(
  prevThreads: Readonly<Record<string, SessionThread>>,
  nextThreads: Readonly<Record<string, SessionThread>>
): boolean {
  if (prevThreads === nextThreads) return false
  const prevKeys = Object.keys(prevThreads)
  const nextKeys = Object.keys(nextThreads)
  if (prevKeys.length !== nextKeys.length) return true
  for (let index = 0; index < nextKeys.length; index += 1) {
    const key = nextKeys[index]
    if (!(key in prevThreads)) return true
    const prevThread = prevThreads[key]
    const nextThread = nextThreads[key]
    if (prevThread === nextThread || prevThread.items === nextThread.items) continue
    if (hasToolItemChange(prevThread.items, nextThread.items)) return true
  }
  return false
}

interface RevisionOptions {
  activeThreadHydrated?: boolean
  toolChangedHint?: boolean
}

function withRevisions(
  prev: AppStore,
  patch: Partial<AppStore>,
  options?: RevisionOptions
): Partial<AppStore> {
  if (!patch || patch === prev) return patch
  let hasKey = false
  for (const _key in patch) {
    hasKey = true
    break
  }
  if (!hasKey && !options?.activeThreadHydrated) return patch
  const bumpMeta =
    'threads' in patch && patch.threads !== undefined && hasThreadsMetaChange(prev.threads, patch.threads)

  const nextActiveFile = 'activeSessionFile' in patch ? patch.activeSessionFile : prev.activeSessionFile
  const nextDraftId = 'draftId' in patch ? patch.draftId : prev.draftId
  const prevViewKey = viewKeyOf(prev)
  const nextViewKey = viewKeyOf({ activeSessionFile: nextActiveFile, draftId: nextDraftId })
  const viewChanged = prevViewKey !== nextViewKey

  let bumpTools = viewChanged || Boolean(options?.activeThreadHydrated)
  if (!bumpTools && 'items' in patch && patch.items !== undefined && patch.items !== prev.items) {
    bumpTools =
      options?.toolChangedHint !== undefined
        ? options.toolChangedHint
        : hasToolItemChange(prev.items, patch.items)
  }

  const bumpThreadsTools =
    bumpTools ||
    ('threads' in patch &&
      patch.threads !== undefined &&
      hasThreadsToolsChange(prev.threads, patch.threads))

  if (!bumpMeta && !bumpTools && !bumpThreadsTools) return patch
  return {
    ...patch,
    ...(bumpMeta ? { threadsMetaVersion: prev.threadsMetaVersion + 1 } : {}),
    ...(bumpTools ? { activeToolsRevision: prev.activeToolsRevision + 1 } : {}),
    ...(bumpThreadsTools ? { threadsToolsRevision: prev.threadsToolsRevision + 1 } : {})
  }
}

export const useAppStore = create<AppStore>((rawSet, get) => {
  const commit = (
    partial: Partial<AppStore> | ((state: AppStore) => Partial<AppStore>),
    options?: RevisionOptions
  ): void => {
    rawSet((state) => withRevisions(state, typeof partial === 'function' ? partial(state) : partial, options))
  }
  const set: SetState = (partial, options) => commit(partial, options)
  return {
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
  pendingWorktree: false,
  setPendingWorktree: (armed) => set({ pendingWorktree: armed }),
  threads: {},
  threadsMetaVersion: 0,
  activeToolsRevision: 0,
  threadsToolsRevision: 0,
  sessionNotices: loadSessionNotices(),
  rememberSessionNotice: (file, notice) => {
    const key = threadKey(file)
    if (!key || key.startsWith('draft:')) return
    if (get().sessionNotices[key] === notice) return
    const sessionNotices = { ...get().sessionNotices, [key]: notice }
    saveSessionNotices(sessionNotices)
    set({ sessionNotices })
  },
  forgetSessionNotice: (file) => {
    const key = threadKey(file)
    if (!key || !(key in get().sessionNotices)) return
    const sessionNotices = { ...get().sessionNotices }
    delete sessionNotices[key]
    saveSessionNotices(sessionNotices)
    set({ sessionNotices })
  },
  drafts: {},
  updateDraft: (sessionKey, updater) => {
    const key = threadKey(sessionKey.trim())
    if (!key) return
    set((state) => {
      const previous = state.drafts[key] ?? { text: '', images: [] }
      const nextDraft = typeof updater === 'function'
        ? updater(previous)
        : { ...previous, ...updater }
      const empty =
        !nextDraft.text &&
        !nextDraft.command &&
        !nextDraft.image &&
        nextDraft.images.length === 0 &&
        (nextDraft.files?.length ?? 0) === 0 &&
        (!nextDraft.pastedRefs || Object.keys(nextDraft.pastedRefs).length === 0) &&
        (!nextDraft.history || nextDraft.history.length === 0)
      if (empty) {
        if (!(key in state.drafts)) return state
        const drafts = { ...state.drafts }
        delete drafts[key]
        persistDraftSnapshot(state, drafts, undefined, { debounce: true })
        return { drafts }
      }
      const { [key]: _previous, ...rest } = state.drafts
      const drafts = pruneComposerDrafts({
        ...rest,
        [key]: nextDraft
      })
      persistDraftSnapshot(state, drafts, undefined, { debounce: true })
      return { drafts }
    })
  },
  clearDraft: (sessionKey) => {
    const key = threadKey(sessionKey.trim())
    if (!key) return
    set((state) => {
      if (!(key in state.drafts)) {
        flushPendingDraftWrite()
        return state
      }
      const drafts = { ...state.drafts }
      delete drafts[key]
      persistDraftSnapshot(state, drafts)
      return { drafts }
    })
  },
  queue: { steering: [], followUp: [] },
  clientKey: '',
  submitSeq: 0,
  uiRequests: [],
  deskPage: null,
  setDeskPage: (deskPage) => {
    set((state) => {
      if (deskPage !== null) return { deskPage }
      const key = viewKeyOf(state)
      const current = key ? state.threads[key] : undefined
      const canonical = key ? threadKey(key) : ''
      const hasPersistedNotice = Boolean(canonical && canonical in state.sessionNotices)
      if (!current?.notice && !state.notice && !hasPersistedNotice) return { deskPage: null }
      let nextNotices = state.sessionNotices
      if (hasPersistedNotice && canonical) {
        nextNotices = { ...state.sessionNotices }
        delete nextNotices[canonical]
        saveSessionNotices(nextNotices)
      }
      return {
        deskPage: null,
        notice: undefined,
        ...(hasPersistedNotice ? { sessionNotices: nextNotices } : {}),
        ...(current?.notice && key
          ? {
              threads: {
                ...state.threads,
                [key]: { ...current, notice: undefined }
              }
            }
          : {})
      }
    })
  },
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
      // Pi acknowledges handled commands even if their handler raised an error.
      // Return the owning conversation's published goal so edits can be confirmed.
      return bindGet(get, key)().uiStatuses.find((entry) => entry.key === GOAL_STATUS_KEY)?.text
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

  async stopSwarmWorker(name, sessionKey) {
    const key = sessionKey || viewKeyOf(get())
    if (!key) {
      get().showToast('Start a conversation first', 'warning')
      return
    }
    try {
      await get().ensureRuntime(key, 'swarm-stop')
      await tracedRpc(threadKey(key), 'prompt', { message: `/desktop-swarm-stop ${name}` }, 30_000, 'swarm-stop')
    } catch (error) {
      get().showToast(messageOf(error), 'warning')
    }
  },

  bootstrap() {
    if (bootstrapPromise) return bootstrapPromise
    const work = (async () => {
      const startupTheme = new URLSearchParams(window.location.search).get('piDesktopTheme')
      const startupForcedTheme =
        startupTheme === 'light' || startupTheme === 'dark' ? startupTheme : undefined
      let settingsApplied = false

      // Launch startup metadata, model catalog, and settings together so cold start
      // pays one IPC round trip instead of a waterfall.
      void window.pi.app.info({ includePiVersion: false }).then((info) => {
        set({ info })
        if (settingsApplied && info.forcedTheme !== startupForcedTheme) {
          applyAppearance(get().settings, info.forcedTheme)
        }
      }).catch((error: unknown) => {
        console.warn('[pi-desktop] could not load app info:', error)
      })
      void get().refreshModelCatalog()

      const settings = await window.pi.settings.get()
      set({ settings })
      settingsApplied = true
      applyAppearance(settings, get().info?.forcedTheme ?? startupForcedTheme)

      // StrictMode replays effects in development. bootstrapPromise above makes
      // this single startup transaction idempotent across that replay.
      unsubscribeRuntime?.()
      const ingestRuntimeEvent = (payload: unknown): void => {
        const scoped = scopeEvent(payload, viewKeyOf(get()))
        if (!scoped) return
        handleEvent(bindSet(set, get, scoped.ownerId), bindGet(get, scoped.ownerId), scoped.event, get, scoped.ownerId, set)
      }
      const offEvent = window.pi.runtime.onEvent((payload) => {
        if (Array.isArray(payload)) {
          for (const item of payload) ingestRuntimeEvent(item)
          return
        }
        ingestRuntimeEvent(payload)
      })
      const offRekey = window.pi.runtime.onRekey?.((change) => {
        if (prewarmOnlyRuntimes.delete(change.from)) prewarmOnlyRuntimes.add(change.to)
        if (retryArmed.delete(change.from)) retryArmed.add(change.to)
        rekeyThread(set, get, change.from, change.to, change.replace)
      })
      const offQueue = window.pi.runtime.onQueue?.((queueEvent) => {
        const key = threadKey(queueEvent.ownerId)
        if (!key) return
        bindSet(set, get, key)({
          cwdWait: queueEvent.queued
            ? {
                cwd: queueEvent.cwd,
                position: queueEvent.position,
                holderOwnerId: queueEvent.holderOwnerId,
                holderCwd: queueEvent.holderCwd,
                externalHolder: queueEvent.externalHolder
              }
            : undefined
        })
        // The supervisor is holding this prompt behind another conversation in
        // the same folder. Show it in the transcript now; the empty composer
        // would otherwise be the only sign that anything was sent.
        if (!queueEvent.queued) return
        const prompts = takeQueuedPrompts(key)
        if (prompts.length === 0) return
        bindSet(set, get, key)((state) => {
          const visible = new Set(
            state.items.filter((item) => item.kind === 'user').map((item) => item.id)
          )
          const missing = prompts.filter((prompt) => !visible.has(prompt.id))
          return missing.length > 0 ? { items: [...state.items, ...missing] } : {}
        })
      })
      const offStatus = window.pi.runtime.onStatus((incoming) => {
        const scoped = scopeStatus(incoming, viewKeyOf(get()))
        if (!scoped) return
        const { ownerId: owner, status } = scoped
        // A stopped or failed process takes its live readings with it, before
        // any rewrite below turns "stopped" into a usable cold conversation.
        // Nothing else retracts them: a crash writes no `session_shutdown`.
        if (status.phase === 'stopped' || status.phase === 'error') {
          bindSet(set, get, owner)((state) => {
            const kept = state.uiStatuses.filter((entry) => !PROCESS_LIVE_STATUS_KEYS.includes(entry.key))
            return kept.length === state.uiStatuses.length ? {} : { uiStatuses: kept }
          })
        }
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

      const offNotificationOpen = window.pi.app.onNotificationOpen?.(({ sessionKey, reply }) => {
        if (!sessionKey) return
        const state = get()
        const key = threadKey(sessionKey)
        if (deletedSessionKeys.has(key)) return
        const target = conversationRows(state.sessions, state.threads, state.workspace?.path)
          .find((row) => threadKey(row.file) === key)
        if (!target) return
        if (reply === undefined) {
          void state.selectSession(target, 'notification-open')
        } else {
          const text = reply.trim()
          if (text) void state.sendPrompt(key, text, [], 'followUp')
        }
      })

      // The tray bridge is added by the preload; a renderer hot-reload can land
      // before a dev process is rebuilt with that bridge, so tolerate its absence.
      const offTrayOpen = window.pi.tray?.onOpenConversation?.(({ key }) => {
        if (!key) return
        const state = get()
        // The key is a thread key (a file path or a draft id). Match through the
        // same projection the sidebar uses so a live, unflushed chat is found.
        const target = conversationRows(state.sessions, state.threads, state.workspace?.path)
          .find((row) => threadKey(row.file) === threadKey(key))
        if (target) void get().selectSession(target, 'tray-open')
      })

      unsubscribeRuntime = () => {
        offEvent()
        offRekey?.()
        offQueue?.()
        offStatus()
        offSessionsChanged?.()
        offNotificationOpen?.()
        offTrayOpen?.()
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
    flushPendingDraftWrite()
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
    flushPendingDraftWrite()
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
        await Promise.all([get().refreshSessions(), get().refreshGit()])
      }
      return epoch === workspaceEpoch ? viewKeyOf(get()) || undefined : undefined
    }
    pendingProjectPath = undefined
    set({ pendingProject: undefined })
    if (path === null) {
      const settings = await window.pi.settings.patch({ activeWorkspaceId: null })
      if (epoch !== workspaceEpoch) return
      set({ settings })
      return get().openWorkspace(undefined, undefined, 'project-switch')
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
    }, { workspaces: settings.workspaces })
    if (epoch !== workspaceEpoch) return
    set({ settings: next })
    applyAppearance(next, get().info?.forcedTheme)
    return get().openWorkspace({ ...workspace, lastOpenedAt: now }, undefined, 'project-switch')
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
    if (sessionFile) sessionFile = threadKey(sessionFile)
    flushPendingDraftWrite()
    const currentKey = viewKeyOf(get())
    if (currentKey) touchSessionLru(currentKey)
    stopPrewarmOnlyRuntime(currentKey)
    cancelScheduledPrewarm()
    const epoch = beginProjectChange(workspace?.path ?? null)
    drainPending()
    pendingProjectPath = undefined
    const cached = sessionFile ? get().threads[sessionFile] : undefined
    const shouldHydrate = Boolean(sessionFile && needsSessionHydration(sessionFile, cached))
    const hydratingSessionFile = shouldHydrate ? sessionFile : undefined
    const savedDrafts = loadComposerDrafts()
    rememberCachedLastDraftKeys(savedDrafts.lastDraftKeys)
    const drafts = { ...savedDrafts.drafts, ...get().drafts }
    const restoredDraftId = savedDrafts.lastDraftKeys[draftWorkspaceKey(workspace)]
    const draftId = sessionFile ? undefined : restoredDraftId || mintDraft()
    // Opening a conversation is what clears its mark: the reader has seen it.
    const thread = cached
      ? { ...cached, clientKey: cached.clientKey || mintClientKey(), notice: undefined }
      : emptyThread(workspace?.path, draftMode(get().settings), !sessionFile && !restoredDraftId)
    const noticeKey = sessionFile ? threadKey(sessionFile) : ''
    let nextSessionNotices = get().sessionNotices
    if (noticeKey && noticeKey in nextSessionNotices) {
      nextSessionNotices = { ...nextSessionNotices }
      delete nextSessionNotices[noticeKey]
      saveSessionNotices(nextSessionNotices)
    }
    if (sessionFile) {
      deletedSessionKeys.delete(sessionFile)
      deletedSessionKeys.delete(threadKey(sessionFile))
      touchSessionLru(sessionFile)
    }
    const activeKey = sessionFile ?? draftId!
    const prunedThreads = pruneIdleDraftThreads(get().threads, activeKey)
    const threads = enforceSessionLru(
      { ...prunedThreads, [activeKey]: thread },
      activeKey
    )
    set({
      workspace,
      threads,
      drafts,
      draftId,
      activeSessionFile: sessionFile,
      hydratingSessionFile,
      ...(nextSessionNotices !== get().sessionNotices ? { sessionNotices: nextSessionNotices } : {}),
      deskPage: null,
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
    if (!sessionFile && draftId) persistDraftSnapshot(get(), drafts, draftId)
    if (shouldHydrate && sessionFile) void get().hydrateSession(sessionFile)
    if (epoch !== workspaceEpoch) return
    const sessionsTask = get().refreshSessions()
    // Start the folder's Git read alongside the session index instead of serializing
    // the git subprocess behind disk scans.
    void get().refreshGit()
    await sessionsTask
    return epoch === workspaceEpoch ? activeKey : undefined
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
    const mutation = sessionMutationSeq
    if (
      sessionsRefreshInFlight &&
      sessionsRefreshInFlight.epoch === epoch &&
      sessionsRefreshInFlight.mutation === mutation
    ) {
      return sessionsRefreshInFlight.promise
    }
    const request = ++sessionListRequest
    const promise = (async () => {
      const sessions = await window.pi.sessions.list()
      // The list belongs to the project, not the conversation on screen, so a
      // view change must not invalidate it. The project epoch rejects reads
      // across project switches; the request sequence rejects older same-project
      // scans. A view epoch here made new conversations vanish from the sidebar.
      if (epoch !== projectEpoch || request !== sessionListRequest) return
      set({ sessions })
    })().finally(() => {
      if (sessionsRefreshInFlight?.promise === promise) sessionsRefreshInFlight = null
    })
    sessionsRefreshInFlight = { epoch, mutation, promise }
    return promise
  },

  async selectSession(session, sourceAction = 'sidebar-select') {
    void sourceAction
    flushPendingDraftWrite()
    const targetFile = threadKey(session.file)
    const currentKey = viewKeyOf(get())
    if (currentKey && currentKey !== targetFile) touchSessionLru(currentKey)
    cancelScheduledPrewarm()
    if (currentKey !== targetFile) stopPrewarmOnlyRuntime(currentKey)
    const workspace = get().workspace
    const changesProject = session.cwd
      ? !workspace || !samePath(session.cwd, workspace.path)
      : Boolean(workspace || get().settings.activeWorkspaceId !== null)
    const epoch = changesProject ? beginProjectChange(session.cwd ?? null) : beginViewChange()
    // Paint anything still queued for the conversation being left. Those
    // reducers name their own owner, so they cannot land in the new view.
    drainPending()
    const cached = get().threads[targetFile]
    // Opening a conversation is what clears its mark: the reader has seen it.
    const thread = cached
      ? { ...cached, clientKey: cached.clientKey || mintClientKey(), notice: undefined }
      : emptyThread(session.cwd)
    let nextSessionNotices = get().sessionNotices
    if (targetFile && targetFile in nextSessionNotices) {
      nextSessionNotices = { ...nextSessionNotices }
      delete nextSessionNotices[targetFile]
      saveSessionNotices(nextSessionNotices)
    }
    // Only a draft id has no file to read. Pi can persist an assigned path
    // before the sidebar has a saved row for it.
    const live = targetFile.startsWith('draft:')
    const shouldHydrate = needsSessionHydration(targetFile, thread)
    deletedSessionKeys.delete(session.file)
    deletedSessionKeys.delete(targetFile)
    touchSessionLru(targetFile)
    if (changesProject) pendingProjectPath = undefined
    const prunedThreads = pruneIdleDraftThreads(get().threads, targetFile)
    const threads = enforceSessionLru(
      { ...prunedThreads, [targetFile]: thread },
      targetFile
    )
    set({
      threads,
      draftId: live ? targetFile : undefined,
      activeSessionFile: live ? undefined : targetFile,
      hydratingSessionFile: shouldHydrate ? targetFile : undefined,
      ...(nextSessionNotices !== get().sessionNotices ? { sessionNotices: nextSessionNotices } : {}),
      deskPage: null,
      error: undefined,
      composerText: undefined,
      pendingJump: undefined,
      ...(changesProject ? { git: undefined, pendingProject: undefined } : {}),
      ...projectThread(thread)
    })
    schedulePrewarm(targetFile, session.messageCount)
    try {
      const settingsPromise = !session.cwd && (workspace || get().settings.activeWorkspaceId !== null)
        ? window.pi.settings.patch({ activeWorkspaceId: null }).then((settings) => {
            if (epoch !== workspaceEpoch) return
            set({ settings, workspace: undefined })
          })
        : session.cwd && (!workspace || !samePath(session.cwd, workspace.path))
          ? (() => {
              const workspaces = get().settings.workspaces
              const known = workspaces.find((item) => samePath(item.path, session.cwd))
              const target: Workspace = known ?? {
                id: `session-${session.id.slice(0, 8)}`,
                path: session.cwd,
                name: session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? session.cwd,
                lastOpenedAt: Date.now()
              }
              return window.pi.settings.patch({
                ...(known ? {} : { workspaces: [...workspaces, target] }),
                activeWorkspaceId: target.id
              }, known ? undefined : { workspaces }).then((settings) => {
                if (epoch !== workspaceEpoch) return
                set({ settings, workspace: target })
                void get().refreshGit()
              })
            })()
          : Promise.resolve()
      // Start hydration in parallel with project settings persistence: reading
      // the JSONL does not depend on `activeWorkspaceId`.
      const hydratePromise = shouldHydrate ? get().hydrateSession(targetFile) : Promise.resolve()
      await Promise.all([settingsPromise, hydratePromise])
    } catch (error) {
      if ((get().activeSessionFile ?? get().draftId) === targetFile) {
        set({
          error: messageOf(error),
          ...(get().hydratingSessionFile === targetFile ? { hydratingSessionFile: undefined } : {})
        })
      }
    }
  },

  async hydrateSession(file, scope) {
    file = threadKey(file)
    const existingHydration = hydrationInFlight.get(file)
    if (existingHydration) return existingHydration

    const hydrate = window.pi.sessions.hydrate
    const thread = get().threads[file]
    if (typeof hydrate !== 'function' || !thread || !needsSessionHydration(file, thread)) {
      if (get().hydratingSessionFile === file) set({ hydratingSessionFile: undefined })
      return
    }
    const clientKey = thread.clientKey
    const historyWasLoaded = thread.historyLoaded

    const work = (async () => {
      try {
        let viewEpoch = workspaceEpoch
        let result = await hydrate(file, scope)
        // The main process can cancel A's read when B opens. If the reader
        // already came back to A, restart the read shared by both A selections.
        while (
          !result.messages.length && !result.taskMode &&
          get().hydratingSessionFile === file && viewEpoch !== workspaceEpoch
        ) {
          viewEpoch = workspaceEpoch
          result = await hydrate(file, scope)
        }
        if (scope === 'branch' && !result.messages.length && !result.taskMode && !result.historyTruncated) {
          // Pi delays writing a branch with no user or assistant message.
          // Its live snapshot can still contain earlier shell output.
          const data = await tracedRpc<{ messages?: AgentMessage[] }>(
            file, 'get_messages', undefined, undefined, 'hydrate-branch'
          )
          if (data?.messages) result = { ...result, messages: data.messages }
        }
        const { messages, historyTruncated, taskMode } = result
        if (!messages.length && !taskMode) return

        drainPending(file)
        const current = get().threads[file]
        if (!current || current.clientKey !== clientKey || (!historyWasLoaded && current.historyLoaded)) return
        const savedMode = current.hasLiveTaskMode ? undefined : taskMode
        const next: SessionThread = {
          ...current,
          ...(savedMode ? {
            agentMode: savedMode.mode,
            uiStatuses: replaceUiStatus(
              current.uiStatuses,
              GOAL_STATUS_KEY,
              savedMode.goal ? JSON.stringify(savedMode.goal) : ''
            )
          } : {}),
          items: mergeHydratedItems(itemsFromMessages(messages), current.items),
          historyLoaded: true,
          historyTruncated,
          contextBreakdown: current.contextBreakdown?.source === 'request'
            ? current.contextBreakdown
            : estimateContextBreakdown(messages, current.stats?.contextUsage?.tokens),
          version: current.version + 1
        }
        const rawThreads = { ...get().threads, [file]: next }
        const threads = enforceSessionLru(rawThreads, viewKeyOf(get()))
        const isActive = get().activeSessionFile === file
        const clearHydrating = get().hydratingSessionFile === file ? { hydratingSessionFile: undefined } : {}
        if (isActive) {
          commit({ threads, ...projectThread(next), ...clearHydrating }, { activeThreadHydrated: true })
        } else {
          commit({ threads, ...clearHydrating })
        }
      } catch (error) {
        // `openWorkspace` fires this read without awaiting it; a rejected read
        // must surface on the conversation instead of becoming an unhandled
        // rejection in the renderer.
        if (get().activeSessionFile === file) set({ error: messageOf(error) })
      } finally {
        hydrationInFlight.delete(file)
        if (get().hydratingSessionFile === file) set({ hydratingSessionFile: undefined })
      }
    })()

    hydrationInFlight.set(file, work)
    return work
  },

  async renameSession(name: string) {
    const trimmed = name.trim()
    if (!trimmed) return false
    const file = get().activeSessionFile
    // A file on disk is renamed on its own worker, or appended cold.
    // That must not start or switch whichever process is on screen.
    if (file) return get().renameSessionFile(file, trimmed)
    try {
      const draftId = get().draftId
      await tracedRpc(draftId, 'set_session_name', { name: trimmed }, undefined, 'session-rename')
      set((state) => ({
        threads: draftId ? updateThreadSessionName(state.threads, draftId, trimmed) : state.threads,
        piState: state.piState ? { ...state.piState, sessionName: trimmed } : state.piState
      }))
      return true
    } catch (error) {
      set({ error: messageOf(error) })
      return false
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
    if (!trimmed || !file) return false
    try {
      if (typeof window.pi.sessions.rename !== 'function') {
        set({ error: 'Could not rename that conversation' })
        return false
      }
      sessionMutationSeq += 1
      const renamed = await window.pi.sessions.rename(file, trimmed)
      if (!renamed) {
        set({ error: 'Could not rename that conversation' })
        return false
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
      return true
    } catch (error) {
      set({ error: messageOf(error) })
      return false
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
      sessionMutationSeq += 1
      const removed = await window.pi.sessions.remove(file)
      if (!removed) {
        await get().refreshSessions().catch(() => {})
        set({ error: `Could not delete ${session?.name ?? 'the conversation'}` })
        return
      }
      const threads = { ...get().threads }
      delete threads[file]
      const drafts = { ...get().drafts }
      delete drafts[file]
      delete drafts[threadKey(file)]
      forgetDeletedThread(file)
      get().forgetSessionNotice(file)
      const sessions = get().sessions.filter((entry) => entry.file !== file)
      if (get().activeSessionFile === file) {
        const draftId = mintDraft()
        const thread = emptyThread(get().workspace?.path, draftMode(get().settings), true)
        threads[draftId] = thread
        persistDraftSnapshot(get(), drafts, draftId)
        set({
          sessions,
          threads,
          drafts,
          draftId,
          activeSessionFile: undefined,
          hydratingSessionFile: undefined,
          error: undefined,
          composerText: undefined,
          pendingJump: undefined,
          ...projectThread(thread)
        })
      } else {
        persistDraftSnapshot(get(), drafts)
        set({ sessions, threads, drafts })
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
          }, { pinnedSessions: pinned, archivedSessions: archived })
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
        }, { pinnedSessions: pinned, archivedSessions: archived })
        set({ settings })
        return true
      })
      if (!archivedNow) return
      get().forgetSessionNotice(file)
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
        }, { archivedSessions: archived })
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
    const thread = emptyThread(get().workspace?.path, draftMode(get().settings), true)
    const prunedThreads = pruneIdleDraftThreads(get().threads, draftId)
    const threads = enforceSessionLru(
      { ...prunedThreads, [draftId]: thread },
      draftId
    )
    persistDraftSnapshot(get(), get().drafts, draftId)
    set({
      draftId,
      activeSessionFile: undefined,
      hydratingSessionFile: undefined,
      deskPage: null,
      error: undefined,
      composerText: undefined,
      pendingJump: undefined,
      threads,
      stats: undefined,
      ...projectThread(thread),
      status: { phase: 'ready', cwd: get().workspace?.path }
    })
  },

  async ensureRuntime(sessionKey = viewKeyOf(get()), sourceAction = 'ensure') {
    const key = threadKey(sessionKey)
    if (!key) throw new Error('Missing conversation id')
    const isPrewarm = sourceAction === 'composer-focus'
    if (!isPrewarm) {
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
      ...(isPrewarm ? { prewarm: true } : {}),
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
    if (get().threads[key]?.isStreaming || get().threads[key]?.run.settled === false) return
    prewarmOnlyRuntimes.add(key)
    void get().ensureRuntime(key, 'composer-focus').catch(() => {
      // Keep the cold composer usable; an actual send retries and reports errors.
    })
  },

  submittingDrafts: {},
  async submitComposerDraft(sessionKey, submission) {
    const { draft, text, kind, imageOptions, sendImage } = submission
    const key = threadKey(sessionKey)
    const state = get()
    if (key && key !== threadKey(viewKeyOf(state))) return false
    const client = composerClientKey(state, key)
    if (state.submittingDrafts[client]) return false
    set({ submittingDrafts: { ...state.submittingDrafts, [client]: submission } })
    try {
      const images = draft.images.map(({ data, mimeType }) => ({ data, mimeType }))
      const accepted = await get().send(text, images, kind, sendImage)
      if (accepted && key && get().drafts[threadKey(key)] === draft) {
        get().updateDraft(key, () => composerDraftAfterSend(draft, text, imageOptions))
        flushPendingDraftWrite()
      }
      return accepted
    } catch (error) {
      bindSet(set, get, key)({ error: messageOf(error) })
      return false
    } finally {
      set((current) => {
        const submittingDrafts = { ...current.submittingDrafts }
        delete submittingDrafts[client]
        return { submittingDrafts }
      })
    }
  },

  async send(text, images, kind = 'steer', image) {
    flushPendingDraftWrite()
    const trimmed = normalizeAppCommandInput(text.trim())
    if (!trimmed && !images.length) return false
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
        return false
      }
      return get().runInlineBash(command, excludeFromContext)
    }
    // `/name <text>` renames the conversation instead of reaching the agent.
    if (trimmed === '/name' && !images.length) {
      get().showToast('Type the new name after /name', 'warning')
      return false
    }
    const rename = /^\/name\s+([\s\S]+)$/.exec(trimmed)
    if (rename && !images.length) return get().renameSession(rename[1].trim())
    // `/image [prompt]` is the composer's shortcut into its image mode: the
    // controls and the prompt belong to the chat box, not to a side panel.
    const imageCommand = /^\/image(?:\s+([\s\S]*))?$/i.exec(trimmed)
    if (imageCommand) {
      const arg = (imageCommand[1] ?? '').trim()
      window.dispatchEvent(
        new CustomEvent<{ prompt: string; off?: boolean }>('pi:enter-image-mode', {
          detail: arg.toLowerCase() === 'off' ? { prompt: '', off: true } : { prompt: arg }
        })
      )
      return true
    }
    // App commands are client features, not Pi slash commands. Typing one is
    // the same request as picking it from the palette.
    if (!images.length) {
      const appCommand = APP_COMMANDS.find(
        (command) => command.source === 'app' && !command.takesArgument && trimmed === `/${command.name}`
      )
      if (appCommand) {
        await get().runAppCommand(appCommand.name)
        return true
      }
    }
    const state = get()
    let key = viewKeyOf(state)
    if (state.pendingWorktree && !conversationStarted(state.items)) {
      if (state.workspace?.path && state.git?.isRepo) {
        const target = await createWorktreeForSessionStart(get, state.workspace.path)
        if (!target) return false
        key = target
      } else {
        state.setPendingWorktree(false)
      }
    }
    if (!key) {
      const draftId = mintDraft()
      const thread = emptyThread(get().workspace?.path, draftMode(get().settings), true)
      persistDraftSnapshot(get(), get().drafts, draftId)
      set({
        draftId,
        threads: { ...get().threads, [draftId]: thread },
        activeSessionFile: undefined,
        hydratingSessionFile: undefined,
        ...projectThread(thread)
      })
      key = draftId
    }
    return get().sendPrompt(key, trimmed, images, kind, image)
  },

  async sendPrompt(key, trimmed, images, kind, image) {
    const update = bindSet(set, get, key)
    const ownGet = bindGet(get, key)
    const view = get()
    const cwd = threadKey(viewKeyOf(view)) === threadKey(key) ? view.workspace?.path : undefined
    const payload: Record<string, unknown> = { message: trimmed, streamingBehavior: kind }
    if (images.length) payload.images = images
    pinScrollToBottom(key)
    // The prompt is recorded before it leaves, so a queue event from the main
    // process can show it as waiting. It is only put in the transcript once
    // the folder is busy: a prompt that reaches Pi at once never needs a
    // placeholder, and Pi's own `message_start` is what the reader sees.
    const pendingPrompt: UserItem = {
      id: nextId('user'),
      kind: 'user',
      text: trimmed,
      images: images ?? [],
      timestamp: Date.now(),
      order: nextOrder(),
      pending: true
    }
    rememberQueuedPrompt(key, pendingPrompt)
    update((state) => ({
      error: undefined,
      isStreaming: true,
      submitSeq: (state.submitSeq ?? 0) + 1,
      run: state.run.settled ? { phase: 'queued', turns: 0, settled: false } : state.run,
      status: { ...state.status, cwd: state.status.cwd ?? cwd }
    }))
    const settleIfCancelledBeforeSend = (cancelled = false): boolean => {
      const { run } = ownGet()
      if (!cancelled && run.phase !== 'aborting' && run.outcome !== 'aborted') return false

      forgetQueuedPrompt(key, pendingPrompt.id)
      // If Stop landed during setup before Pi opened a run, no agent_settled
      // event will arrive to take this conversation out of the aborting phase.
      if (!run.settled && !run.runId) {
        update((state) => ({
          cwdWait: undefined,
          isStreaming: false,
          run: { ...state.run, phase: 'idle', settled: true, outcome: 'aborted' },
          items: clearPendingPrompts(state.items, pendingPrompt.id)
        }))
      }
      return true
    }
    try {
      await get().ensureRuntime(key, 'prompt-send')
      if (settleIfCancelledBeforeSend()) return false
      // The image controls live in the composer, the tool lives in Pi: hand the
      // chosen options to the task-mode extension first, so the run that the
      // user's prompt starts is the one those options apply to.
      if (image && (trimmed || images.length > 0) && !trimmed.startsWith('/')) {
        const imagePrompt = trimmed || 'Create a refined variation based on the attached reference image.'
        payload.message = imagePrompt
        pendingPrompt.text = imagePrompt
        const setup = await tracedRpc<{ cancelled?: boolean }>(
          threadKey(key),
          'prompt',
          {
            message: `/desktop-image ${JSON.stringify({
              id: pendingPrompt.id,
              prompt: imagePrompt,
              model: image.model,
              size: image.size,
              quality: image.quality,
              n: image.count,
              references: images.length
            })}`
          },
          30_000,
          'image-params'
        )
        if (settleIfCancelledBeforeSend(setup?.cancelled)) {
          if (!setup?.cancelled) {
            await tracedRpc(
              threadKey(key),
              'prompt',
              { message: `/desktop-image ${JSON.stringify({ cancel: pendingPrompt.id })}` },
              5_000,
              'image-params-cancel'
            ).catch(() => {})
          }
          return false
        }
        void get().updateSettings({
          imageModel: image.model,
          imageSize: image.size,
          imageQuality: image.quality
        })
      }
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
      // or input handler consumed it (the handler may send a separate prompt),
      // `started` means Pi accepted it for a run, and `queued` means Pi is
      // holding it for a run that is already going. The phase has to
      // follow that answer rather than stay on the optimistic `queued`.
      // If the user clicked Stop before Pi opened a run (`!run.runId`), no
      // `agent_settled` event will ever arrive, so settle it here as aborted.
      const canSettlePreRun = (run: RunState) =>
        run.phase === 'queued' || (run.phase === 'aborting' && !run.runId)
      const settlePreRun = (run: RunState): RunState => ({
        ...run,
        phase: 'idle',
        settled: true,
        ...(run.phase === 'aborting' ? { outcome: 'aborted' as const } : {})
      })
      if (result?.disposition === 'handled') {
        forgetQueuedPrompt(key, pendingPrompt.id)
        const isModeCommand = /^\/(?:plan|goal|swarm|plugin)(?:\s|$)/.test(trimmed)
        update((state) => {
          const shouldSettle =
            canSettlePreRun(state.run) || (result.cancelled && state.run.phase === 'aborting')
          const items = clearPendingPrompts(state.items, pendingPrompt.id)
          return {
            cwdWait: undefined,
            isStreaming: shouldSettle ? false : state.isStreaming,
            run: shouldSettle ? settlePreRun(state.run) : state.run,
            // Mode shortcuts publish their own status and can send the task as
            // a separate user message. Its events can arrive on either side of
            // the command response.
            items: result.cancelled || isModeCommand
              ? items
              : applyEvent(items, {
                  type: 'client_notice',
                  level: 'info',
                  text: translate('Pi accepted {input}', state.settings.language).replace('{input}', () => trimmed)
                })
          }
        })
      } else if (result?.disposition === 'started') {
        // A run is opening. `agent_start` confirms it; until then this is the
        // truth, and it keeps the row from reading "Queued" for a run that is
        // already on its way.
        forgetQueuedPrompt(key, pendingPrompt.id)
        const startedAt = Date.now()
        const startedMonotonicAt = monotonicNow()
        update((state) => ({
          cwdWait: undefined,
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
      } else if (result?.disposition === 'queued') {
        // Pi is holding the prompt for its own run queue. It will echo it back
        // in `message_start`, so a bubble already revealed for the folder
        // queue stays until then.
        forgetQueuedPrompt(key, pendingPrompt.id)
      } else {
        // No run was opened and Pi did not say it queued the message, so the
        // optimistic phase must not be left standing. Nothing will echo the
        // prompt back, so its waiting bubble goes too.
        forgetQueuedPrompt(key, pendingPrompt.id)
        update((state) => {
          const shouldSettle = canSettlePreRun(state.run)
          return {
            cwdWait: undefined,
            isStreaming: shouldSettle ? false : state.isStreaming,
            run: shouldSettle ? settlePreRun(state.run) : state.run,
            items: clearPendingPrompts(state.items, pendingPrompt.id)
          }
        })
      }
      return result?.disposition === 'started' || result?.disposition === 'queued' ||
        (result?.disposition === 'handled' && result.cancelled !== true)
    } catch (error) {
      // An unconfirmed prompt must not leave its optimistic queue state open.
      forgetQueuedPrompt(key, pendingPrompt.id)
      update((state) => {
        const shouldSettle =
          state.run.phase === 'queued' || (state.run.phase === 'aborting' && !state.run.runId)
        return {
          cwdWait: undefined,
          error: state.run.phase === 'aborting' || state.run.outcome === 'aborted' ? state.error : messageOf(error),
          isStreaming: shouldSettle ? false : state.isStreaming,
          run: shouldSettle
            ? {
                ...state.run,
                phase: 'idle',
                settled: true,
                ...(state.run.phase === 'aborting' ? { outcome: 'aborted' as const } : {})
              }
            : state.run,
          items: clearPendingPrompts(state.items, pendingPrompt.id)
        }
      })
      return false
    }
  },

  async runInlineBash(command, excludeFromContext = false) {
    const trimmed = command.trim()
    if (!trimmed) return false
    const id = `inline-bash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    // Events that were still waiting for a frame belong to the conversation
    // before this command; they must not land after it.
    let owner = viewKeyOf(get())
    if (!owner) {
      const draftId = mintDraft()
      const thread = emptyThread(get().workspace?.path, draftMode(get().settings), true)
      persistDraftSnapshot(get(), get().drafts, draftId)
      set({
        draftId,
        threads: { ...get().threads, [draftId]: thread },
        activeSessionFile: undefined,
        hydratingSessionFile: undefined,
        ...projectThread(thread)
      })
      owner = draftId
    }
    const ownerKey = threadKey(owner)
    drainPending(ownerKey)
    const update = bindSet(set, get, owner)
    const ownGet = bindGet(get, owner)
    const entry: ThreadItem = {
      id,
      kind: 'bash',
      command: trimmed,
      output: '',
      excludeFromContext,
      timestamp: Date.now(),
      order: nextOrder()
    }
    let startedBashRun = false
    pinScrollToBottom(owner)
    update((state) => {
      if (state.run.settled) startedBashRun = true
      return {
        items: [...state.items, entry],
        error: undefined,
        isStreaming: true,
        submitSeq: (state.submitSeq ?? 0) + 1,
        run: state.run.settled ? { phase: 'queued', turns: 0, settled: false } : state.run,
        status: { ...state.status, cwd: state.status.cwd ?? get().workspace?.path }
      }
    })
    let countedKey: string | undefined
    try {
      const key = await get().ensureRuntime(owner, 'inline-bash')
      if (ownGet().run.phase === 'aborting' || ownGet().run.outcome === 'aborted') {
        if (startedBashRun && !ownGet().run.settled && !ownGet().run.runId) {
          update((state) => ({
            cwdWait: undefined,
            isStreaming: false,
            run: { ...state.run, phase: 'idle', settled: true, outcome: 'aborted' },
            items: state.items.map((item) =>
              item.kind === 'bash' && item.id === id
                ? { ...item, output: item.output || 'Cancelled', exitCode: 130 }
                : item
            )
          }))
        } else {
          update((state) => ({
            items: state.items.map((item) =>
              item.kind === 'bash' && item.id === id
                ? { ...item, output: item.output || 'Cancelled', exitCode: 130 }
                : item
            )
          }))
        }
        return false
      }
      countedKey = threadKey(key)
      inlineBashCounts.set(countedKey, (inlineBashCounts.get(countedKey) ?? 0) + 1)
      if (startedBashRun && ownGet().run.phase === 'queued') {
        update((state) =>
          state.run.phase === 'queued' && !state.run.runId
            ? {
                run: {
                  ...state.run,
                  phase: 'working',
                  startedAt: state.run.startedAt ?? Date.now(),
                  startedMonotonicAt: state.run.startedMonotonicAt ?? monotonicNow(),
                  phaseStartedAt: monotonicNow()
                }
              }
            : {}
        )
      }
      const result = await tracedRpc<{
        output?: string
        exitCode?: number
        cancelled?: boolean
      }>(key, 'bash', { command: trimmed, id, excludeFromContext }, 600_000, 'inline-bash')
      update((state) => {
        const bashOnly = startedBashRun && !state.run.settled && !state.run.runId
        return {
          items: state.items.map((item) =>
            item.kind === 'bash' && item.id === id
              ? {
                  ...item,
                  output: typeof result?.output === 'string' ? result.output : item.output,
                  exitCode: typeof result?.exitCode === 'number' ? result.exitCode : 0
                }
              : item
          ),
          ...(bashOnly
            ? {
                cwdWait: undefined,
                isStreaming: false,
                run: {
                  ...state.run,
                  phase: 'idle',
                  settled: true,
                  ...(result?.cancelled ? { outcome: 'aborted' as const } : {})
                }
              }
            : {})
        }
      })
      void get().refreshState(threadKey(owner))
      if (gitBelongsToView(ownGet, get, threadKey(owner))) void get().refreshGit()
      return result?.cancelled !== true
    } catch (error) {
      const message = messageOf(error)
      update((state) => {
        const bashOnly = startedBashRun && !state.run.settled && !state.run.runId
        return {
          items: state.items.map((item) =>
            item.kind === 'bash' && item.id === id
              ? {
                  ...item,
                  output: item.output ? `${item.output}\n${message}` : message,
                  exitCode: 1
                }
              : item
          ),
          ...(bashOnly
            ? {
                cwdWait: undefined,
                isStreaming: false,
                run: {
                  ...state.run,
                  phase: 'idle',
                  settled: true,
                  outcome: state.run.phase === 'aborting' ? ('aborted' as const) : ('failed' as const)
                }
              }
            : {})
        }
      })
      return false
    } finally {
      if (countedKey) {
        const resolved = threadKey(countedKey)
        const remaining = (inlineBashCounts.get(resolved) ?? 1) - 1
        if (remaining <= 0) inlineBashCounts.delete(resolved)
        else inlineBashCounts.set(resolved, remaining)
      }
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
    const state = get()
    const submission = state.submittingDrafts[composerClientKey(state, key)]
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
          cwdWait: undefined,
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
      // A prompt still waiting for the folder lock was cancelled with the
      // queue; its bubble goes back to being the composer text below.
      queuedPromptDrafts.delete(threadKey(key))
      update((state) => ({
        queue: { steering: [], followUp: [] },
        items: clearPendingPrompts(state.items)
      }))
      restoreCancelledPrompts(get(), key, removed, submission)
      if ((inlineBashCounts.get(threadKey(key)) ?? 0) > 0 && !ownGet().run.runId) {
        void tracedRpc(threadKey(key), 'abort_bash', undefined, undefined, 'user-stop').catch(() => {})
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
    const state = get()
    const key = viewKeyOf(state)
    const submission = state.submittingDrafts[composerClientKey(state, threadKey(key))]
    const update = bindSet(set, get, key)
    try {
      const removed = await tracedRpc<{ steering: string[]; followUp: string[] }>(
        key,
        'clear_queue',
        undefined,
        undefined,
        'clear-queue'
      )
      update((state) => ({
        queue: { steering: [], followUp: [] },
        items: clearPendingPrompts(state.items)
      }))
      if (key) queuedPromptDrafts.delete(threadKey(key))
      if (restoreToEditor) {
        restoreCancelledPrompts(get(), key, removed, submission)
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
      // A conversation keeps its own model: only a draft — a conversation that
      // does not exist yet — writes the app default. A session records the
      // choice in Pi's own session file, so switching models here cannot move
      // the default any other conversation reads.
      const fresh = !key || key.startsWith('draft:')
      if (!running && !starting) {
        const spec = `${model.provider}/${model.id}`
        if (selection === modelPreferenceSequence) {
          modelPreferenceValue = spec
          if (fresh) {
            const shouldWrite = get().settings.model !== spec ||
              get().settings.provider !== model.provider
            if (shouldWrite) {
              const settings = await window.pi.settings.patch({ provider: model.provider, model: spec })
              if (modelPreferenceSequence === selection) {
                set({ settings: { ...get().settings, provider: settings.provider, model: settings.model } })
              }
            }
          }
        }
        // A draft's next launch already receives the saved default through
        // `ensureRuntime`; only a resumed session needs the extra command.
        if (key && !fresh) {
          pendingModelSelections.set(key, { provider: model.provider, id: model.id })
          rememberSessionModel(set, key, spec)
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
        modelPreferenceValue = spec
        if (fresh) {
          const shouldWrite = get().settings.model !== spec ||
            get().settings.provider !== model.provider
          if (shouldWrite) {
            const settings = await window.pi.settings.patch({ provider: model.provider, model: spec })
            if (modelPreferenceSequence === selection) {
              set({ settings: { ...get().settings, provider: settings.provider, model: settings.model } })
            }
          }
        } else {
          rememberSessionModel(set, key, spec)
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
    const selected = currentConversationModel(state, models)
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
    // A second `compact` while one is running makes Pi abort the first one,
    // which rejects it with "Compaction cancelled". Answer the second click
    // instead of turning a double click into a failure banner.
    if (get().run.compaction || compactionInFlight.has(owner)) {
      get().showToast('Context compaction is already running', 'warning')
      return false
    }
    compactionInFlight.add(owner)
    try {
      const key = await get().ensureRuntime(owner, 'compact')
      // A live process lists the extension commands it registered. Read them
      // before asking Pi to compact: an extension that owns context (Billion-
      // Context) vetoes `session_before_compact`, so a native compact could
      // only ever come back as "Compaction cancelled".
      await get().refreshCommands(owner)
      if (compactionOwnedByExtension(bindGet(get, owner)().commands)) {
        get().showToast(COMPACTION_EXTENSION_MANAGED_MESSAGE, 'warning')
        return false
      }
      const payload: Record<string, unknown> = {}
      if (instructions?.trim()) payload.customInstructions = instructions.trim()
      // Pi may make multiple model calls while summarising a long session.
      // Its RPC client documents compaction as a command without a deadline.
      await tracedRpc(key, 'compact', payload, 0, 'compact')
      // Pi already emitted the compaction notice. get_messages now holds the
      // compacted model context, so reloading it would drop transcript history.
      await get().refreshState(threadKey(owner))
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
      bindSet(set, get, owner)((state) => {
        // A benign answer (cancelled, nothing to compact) must also clear a
        // compaction failure left over from an earlier attempt — otherwise the
        // red banner stays above a run that has just said it is fine.
        const staleCompactionError = /^Context compaction (?:failed|timed out)/.test(state.error ?? '')
        return {
          error: failure.benign
            ? (staleCompactionError ? undefined : state.error)
            : failure.message,
          run: { ...state.run, compaction: undefined }
        }
      })
      return false
    } finally {
      compactionInFlight.delete(owner)
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

  refreshLiveStats(sessionKey = viewKeyOf(get())) {
    const key = threadKey(sessionKey)
    if (!key) return
    if (liveStatsInFlight.has(key)) return
    const now = Date.now()
    const last = liveStatsAt.get(key) ?? 0
    if (now - last < LIVE_STATS_INTERVAL_MS) return
    setBoundedMap(liveStatsAt, key, now)
    const epoch = liveStatsEpoch.get(key) ?? 0
    const task = tracedRpc<SessionStats>(key, 'get_session_stats', undefined, 20_000, 'live-stats')
      .then((stats) => {
        if (!stats) return
        if (deletedSessionKeys.has(key)) return
        if ((liveStatsEpoch.get(key) ?? 0) !== epoch) return
        bindSet(set, get, key)({ stats })
      })
      .catch(() => {
        // A process that stopped between the event and the read is not an
        // error the reader has to see: the transcript still drives the line.
      })
      .finally(() => {
        liveStatsInFlight.delete(key)
      })
    liveStatsInFlight.set(key, task)
  },

  async refreshState(sessionKey = viewKeyOf(get()), options) {
    if (!sessionKey) return
    const key = threadKey(sessionKey)
    const request = ++refreshStateRequestSequence
    refreshStateRequests.set(key, request)
    const update = bindSet(set, get, key)
    const includeCatalog = options?.includeCatalog !== false
    try {
      const [state, models, levels, stats] = await Promise.all([
        tracedRpc<PiState>(key, 'get_state', undefined, undefined, 'refresh-state'),
        includeCatalog
          ? tracedRpc<{ models: ModelInfo[] }>(
              key,
              'get_available_models',
              undefined,
              undefined,
              'refresh-state'
            )
              .then((data) => data?.models ?? [])
              .catch(() => undefined as ModelInfo[] | undefined)
          : Promise.resolve(undefined as ModelInfo[] | undefined),
        includeCatalog
          ? tracedRpc<{ levels: string[] }>(
              key,
              'get_available_thinking_levels',
              undefined,
              undefined,
              'refresh-state'
            )
              .then((data) => data?.levels ?? [])
              .catch(() => undefined as string[] | undefined)
          : Promise.resolve(undefined as string[] | undefined),
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
          addBoundedSet(modelRestoreAttempts, attempt)
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
          addBoundedSet(modelRestoreAttempts, attempt)
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
    }, { lastSessions: last })
    if (epoch !== workspaceEpoch) return
    set({ settings })
  },

  async reloadMessages(sessionKey = viewKeyOf(get()), history) {
    const ownGet = bindGet(get, sessionKey)
    if (ownGet().isStreaming) return
    try {
      const data = await tracedRpc<{ messages: AgentMessage[] }>(
        threadKey(sessionKey),
        'get_messages',
        undefined,
        undefined,
        'reload-messages'
      ).catch((error: unknown) => {
        if (!history) throw error
        return undefined
      })
      if (ownGet().isStreaming) return
      const activeCanonical = viewKeyOf(get()) ? threadKey(viewKeyOf(get())) : ''
      const isViewed = !sessionKey || threadKey(sessionKey) === activeCanonical
      bindSet(set, get, sessionKey, { activeThreadHydrated: isViewed })({
        items: itemsFromMessages(history?.messages ?? data?.messages ?? []),
        ...(history || Array.isArray(data?.messages) ? { historyLoaded: true } : {}),
        ...(history ? { historyTruncated: history.historyTruncated } : {}),
        contextBreakdown: ownGet().contextBreakdown?.source === 'request'
          ? ownGet().contextBreakdown
          : data?.messages && estimateContextBreakdown(data.messages, ownGet().stats?.contextUsage?.tokens)
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
              command.name !== 'desktop-computer' &&
              command.name !== 'desktop-image' &&
              command.name !== 'desktop-rewind'
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
      case 'swarm':
        await get().setAgentMode(get().agentMode === 'swarm' ? 'default' : 'swarm')
        break
      case 'plugin':
        await get().setAgentMode(get().agentMode === 'plugin' ? 'default' : 'plugin')
        break
      case 'image':
        window.dispatchEvent(new CustomEvent('pi:enter-image-mode'))
        break
      default:
        break
    }
  },

  async updateSettings(patch, baseline) {
    if ('model' in patch || 'provider' in patch) {
      modelPreferenceSequence += 1
      const model = 'model' in patch ? patch.model : get().settings.model
      modelPreferenceValue = typeof model === 'string' ? model : null
    }
    if ('thinkingLevel' in patch) {
      thinkingPreferenceSequence += 1
      thinkingPreferenceValue = typeof patch.thinkingLevel === 'string' ? patch.thinkingLevel : null
    }
    const settings = await window.pi.settings.patch(patch, baseline)
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

  showToast(message, level = 'info', sessionKey) {
    set({ toast: { text: message, level, ...(sessionKey ? { sessionKey } : {}) } })
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
      const settings = await window.pi.settings.patch({ pinnedSessions: next }, { pinnedSessions: pinned })
      set({ settings })
      return wasPinned
    })
    const name = get().sessions.find((session) => session.file === file)?.name
    get().showToast(
      wasPinned ? `${name ?? 'Conversation'} unpinned` : `${name ?? 'Conversation'} pinned to the top`
    )
  },

  async respondUi(response, target) {
    const state = get()
    const viewKey = viewKeyOf(state)
    const explicitKey = target?.sessionKey ? threadKey(target.sessionKey.trim()) : undefined
    const lookupKey = explicitKey || (viewKey ? threadKey(viewKey) : '')
    const thread = lookupKey ? state.threads[lookupKey] : undefined
    const queue = pendingDialogsFor(thread, explicitKey ? undefined : state.uiRequest)
    let request = target?.requestId
      ? queue.find((entry) => entry.id === target.requestId)
      : queue[0]
    let resolvedKey = lookupKey
    if (!request && target?.requestId) {
      for (const [candidateKey, candidateThread] of Object.entries(state.threads)) {
        const found = pendingDialogsFor(candidateThread).find((entry) => entry.id === target.requestId)
        if (found) {
          request = found
          resolvedKey = threadKey(candidateKey)
          break
        }
      }
    }
    if (!request) return
    const routeKey = threadKey(request.sessionKey || resolvedKey || '')
    if (respondingUiIds.has(request.id)) return
    respondingUiIds.add(request.id)
    try {
      // Send over RPC before popping so a failed IPC leaves the dialog intact
      // for retry rather than silently leaving Pi waiting forever.
      await window.pi.runtime.respondUi(request.id, response, routeKey || request.ownerId)
      const ownerKey = routeKey || threadKey(viewKeyOf(get()))
      if (ownerKey) {
        bindSet(set, get, ownerKey)((current) => {
          const remaining = pendingDialogsFor(get().threads[ownerKey], current.uiRequest).filter(
            (entry) => entry.id !== request!.id
          )
          return {
            uiRequests: remaining,
            uiRequest: remaining[0],
            run:
              current.run.phase === 'waiting_approval'
                ? { ...current.run, phase: phaseAfterDialog(current, remaining.length) }
                : current.run
          }
        })
      } else {
        set((current) => ({
          uiRequests: (current.uiRequests ?? []).filter((entry) => entry.id !== request!.id),
          uiRequest: (current.uiRequests ?? []).filter((entry) => entry.id !== request!.id)[0],
          run:
            current.run.phase === 'waiting_approval'
              ? { ...current.run, phase: phaseAfterDialog(current, 0) }
              : current.run
        }))
      }
    } catch (error) {
      set({ error: messageOf(error) })
    } finally {
      respondingUiIds.delete(request.id)
    }
  },

  async dismissUi(target) {
    await get().respondUi({ cancelled: true }, target)
  },

  clearComposerText() {
    set({ composerText: undefined })
  },

  insertIntoComposer(text, mode = 'append', sessionKey) {
    const trimmed = text.trim()
    if (!trimmed) return
    // A trailing space is kept when there is one, so the user can go on
    // typing right after the text that was put in.
    const addition = text.endsWith(' ') ? `${trimmed} ` : trimmed
    const rawTarget = (sessionKey ?? viewKeyOf(get())).trim()
    const targetKey = rawTarget ? threadKey(rawTarget) : ''
    const currentView = viewKeyOf(get())
    const currentCanonical = currentView ? threadKey(currentView) : ''
    const isViewed = !targetKey || targetKey === currentCanonical
    set((state) => {
      const nextDrafts = { ...state.drafts }
      if (targetKey) {
        const previous = nextDrafts[targetKey] ?? { text: '', images: [] }
        const mergedText =
          mode === 'replace' || !previous.text.trim()
            ? addition
            : `${previous.text.trimEnd()}\n${addition}`
        nextDrafts[targetKey] = {
          ...previous,
          text: mergedText
        }
      }
      persistDraftSnapshot(state, nextDrafts, undefined, { debounce: true })
      return {
        drafts: nextDrafts,
        ...(isViewed
          ? {
              composerInsert: {
                text: addition,
                seq: (state.composerInsert?.seq ?? 0) + 1,
                mode
              }
            }
          : {})
      }
    })
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
      sessionMutationSeq += 1
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
      await get().hydrateSession(key, 'branch')
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
      sessionMutationSeq += 1
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
      await get().hydrateSession(key, 'branch')
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
      if (prompt) get().insertIntoComposer(prompt, 'replace', key)
      get().showToast('Branched into a new conversation')
    } catch (error) {
      bindSet(set, get, owner)({ error: messageOf(error) })
    } finally {
      set({ forking: false })
    }
  },

  async editMessageFrom(target, text, images = []) {
    if (get().forking) return
    if (get().isStreaming || get().run.phase !== 'idle' || get().run.compaction) {
      get().showToast('Wait for the current turn to finish before editing', 'warning')
      return
    }
    const state = get()
    const owner = viewKeyOf(state)
    const user = typeof target === 'string' ? undefined : state.items.find(
      (item): item is UserItem => item.kind === 'user' && item.id === target.id
    )
    if (!owner || (typeof target !== 'string' && (!user || user.pending))) {
      get().showToast('This message cannot be edited', 'warning')
      return
    }
    set({ forking: true })
    try {
      // Read the branch before moving its leaf. A match by entry ID gives
      // the same ancestry even if this read shares an earlier snapshot.
      const history = owner.startsWith('draft:') ? undefined : await window.pi.sessions.hydrate(owner, 'branch')
        .catch(() => undefined)
      let entryId = typeof target === 'string' ? target : user?.entryId
      if (!entryId && user && history) {
        // Live RPC messages have timestamps but no entry id. Read the saved
        // branch for a unique identity before rewinding.
        const matches = history.messages.filter(message =>
          message.role === 'user' && message.timestamp === user.timestamp && textOf(message.content) === user.text
        )
        if (matches.length === 1) entryId = matches[0].entryId
      }
      if (!entryId || !/^[A-Za-z0-9_-]+$/.test(entryId)) {
        get().showToast('This message cannot be edited', 'warning')
        return
      }
      const saved = state.forkTargets.find((item) => item.entryId === entryId)
      const prompt = (user?.text ?? text ?? saved?.text ?? '').trim()
      images = user?.images ?? images
      const key = threadKey(owner)
      await get().ensureRuntime(owner, 'message-edit')
      // A running Pi process keeps the extension set it started with. If this
      // build added the rewind command after that process booted, restart it
      // before sending the command so the id is not treated as a chat prompt.
      const commandList = await tracedRpc<{ commands?: PiCommand[] }>(
        key,
        'get_commands',
        undefined,
        undefined,
        'message-edit'
      )
      if (
        !(commandList?.commands ?? []).some((command) => command.name === 'desktop-rewind') &&
        typeof window.pi.runtime.stop === 'function'
      ) {
        await window.pi.runtime.stop(key)
        await get().ensureRuntime(owner, 'message-edit-reload')
      }
      // Pi acknowledges extension prompts as handled even when the handler
      // threw, so watch for the command error before changing the composer.
      const rewind: typeof pendingRewind = { sessionKey: key }
      pendingRewind = rewind
      const result = await tracedRpc<{ cancelled?: boolean; disposition?: string }>(
        key,
        'prompt',
        { message: `/desktop-rewind ${entryId}` },
        60_000,
        'message-edit'
      )
      if (rewind.error) throw new Error(rewind.error)
      if (result?.cancelled) {
        get().showToast('Editing was cancelled', 'warning')
        return
      }
      const editIndex = history?.messages.findIndex(message => message.role === 'user' && message.entryId === entryId) ?? -1
      await get().refreshState(key)
      // The runtime returns only the compacted model context. Replay the
      // saved transcript up to the entry Pi just confirmed it could rewind.
      await get().reloadMessages(key, history && editIndex >= 0 ? {
        messages: history.messages.slice(0, editIndex),
        historyTruncated: history.historyTruncated
      } : undefined)
      if (images.length > 0) {
        const previous = get().drafts[key] ?? { text: '', images: [] }
        get().updateDraft(key, {
          ...previous,
          images: images.map((image, index) => ({
            type: 'image' as const,
            data: image.data,
            mimeType: image.mimeType,
            id: `edited-${Date.now().toString(36)}-${index}`,
            name: `image-${index + 1}`,
            bytes: Math.ceil((image.data.length * 3) / 4)
          }))
        })
      }
      if (prompt) get().insertIntoComposer(prompt, 'replace', key)
      get().showToast('Message recalled for editing')
    } catch (error) {
      const message = messageOf(error)
      bindSet(set, get, owner)({ error: message })
      get().showToast(message, 'error')
    } finally {
      pendingRewind = undefined
      set({ forking: false })
    }
  },

  async refreshGit() {
    // Git describes the open folder, not the conversation on screen.
    const epoch = projectEpoch
    const mutation = gitMutationSeq
    if (
      gitRefreshInFlight &&
      gitRefreshInFlight.epoch === epoch &&
      gitRefreshInFlight.mutation === mutation
    ) {
      return gitRefreshInFlight.promise
    }
    const request = ++gitStatusRequest
    const promise = (async () => {
      try {
        const git = await window.pi.git.status(get().workspace?.path ?? '')
        if (epoch !== projectEpoch || request !== gitStatusRequest) return
        set({ git })
      } catch {
        if (epoch !== projectEpoch || request !== gitStatusRequest) return
        // A folder that is not a repository is a normal state, not an error.
        set({ git: undefined })
      }
    })().finally(() => {
      if (gitRefreshInFlight?.promise === promise) gitRefreshInFlight = null
    })
    gitRefreshInFlight = { epoch, mutation, promise }
    return promise
  },

  scheduleGitRefresh(delayMs = GIT_REFRESH_DEBOUNCE_MS) {
    // A run that touches a dozen files would otherwise ask git for the whole
    // working tree a dozen times. One trailing read is enough: the list on
    // screen has to catch up *during* the run, not once per edit.
    if (gitRefreshTimer !== null) return
    gitRefreshTimer = window.setTimeout(() => {
      gitRefreshTimer = null
      gitMutationSeq += 1
      void get().refreshGit()
    }, delayMs)
  },

  async commitChanges(message, includeUnstaged, expectedRoot) {
    const result = await window.pi.git.commit(message, includeUnstaged, expectedRoot)
    if (result.ok) {
      gitMutationSeq += 1
      get().showToast(result.hash ? `Committed ${result.hash}` : 'Changes committed')
      // The dialog closes on the commit itself; the branch chip and the
      // review panel catch up in the background rather than holding it open.
      void get().refreshGit()
    }
    // A failed commit is reported by the dialog inline, which keeps the
    // message and the file list in front of the reader.
    return result
  },

  async stageFile(file, expectedRoot) {
    const result = await window.pi.git.stageFile(file, expectedRoot)
    if (!result.ok) {
      get().showToast(result.error ?? 'The file could not be staged', 'error')
      return result
    }
    gitMutationSeq += 1
    await get().refreshGit()
    return result
  },

  async unstageFile(file, expectedRoot) {
    const result = await window.pi.git.unstageFile(file, expectedRoot)
    if (!result.ok) {
      get().showToast(result.error ?? 'The file could not be unstaged', 'error')
      return result
    }
    gitMutationSeq += 1
    await get().refreshGit()
    return result
  },

  async stageAll(expectedRoot) {
    const result = await window.pi.git.stageAll(expectedRoot)
    if (!result.ok) {
      get().showToast(result.error ?? 'The files could not be staged', 'error')
      return result
    }
    gitMutationSeq += 1
    await get().refreshGit()
    return result
  },

  async unstageAll(expectedRoot) {
    const result = await window.pi.git.unstageAll(expectedRoot)
    if (!result.ok) {
      get().showToast(result.error ?? 'The files could not be unstaged', 'error')
      return result
    }
    gitMutationSeq += 1
    await get().refreshGit()
    return result
  },

  async pushGit(expectedRoot) {
    const result = await window.pi.git.push(expectedRoot)
    if (!result.ok) {
      get().showToast(result.error ?? 'Could not push branch', 'error')
      return result
    }
    gitMutationSeq += 1
    await get().refreshGit()
    get().showToast('Pushed to remote')
    return result
  },

  async pullGit(expectedRoot) {
    const result = await window.pi.git.pull(expectedRoot)
    if (!result.ok) {
      get().showToast(result.error ?? 'Could not pull branch', 'error')
      return result
    }
    gitMutationSeq += 1
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
} })

const rawStoreSetState = useAppStore.setState.bind(useAppStore)
useAppStore.setState = ((partial, replace) => {
  if (replace) {
    rawStoreSetState(partial as AppStore, true)
    return
  }
  rawStoreSetState((state) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    if (!patch || patch === state) return patch
    return withRevisions(state, patch)
  })
}) as typeof useAppStore.setState

// Development aid: the screenshot harness drives the store to reach states
// that are hard to produce on purpose, such as a retry in progress.
if (typeof window !== 'undefined' && (window as { __piDesktopDev?: unknown }).__piDesktopDev) {
  ;(window as unknown as { __piDesktopStore?: typeof useAppStore }).__piDesktopStore = useAppStore
}

/**
 * Keep the tray's right-click menu in sync with the conversations on screen.
 * Only the fields the menu shows are signed, so the burst of text/thinking
 * deltas during a stream does not rebuild the native menu on every frame.
 */
let lastTraySessions: readonly SessionMeta[] | undefined
let lastTrayMetaVersion = -1
let lastTrayWorkspace: string | undefined
function pushTrayConversations(state: AppStore): void {
  // `threadsMetaVersion` bumps on isStreaming / name / first-prompt changes but
  // not on text deltas, so the menu is rebuilt only when its content can differ.
  if (
    state.sessions === lastTraySessions &&
    state.threadsMetaVersion === lastTrayMetaVersion &&
    state.workspace?.path === lastTrayWorkspace
  ) return
  lastTraySessions = state.sessions
  lastTrayMetaVersion = state.threadsMetaVersion
  lastTrayWorkspace = state.workspace?.path
  if (!window.pi?.tray) return
  const list = trayConversations(state.sessions, state.threads, state.workspace?.path)
  window.pi.tray.setConversations(list)
}
useAppStore.subscribe((state) => {
  pushTrayConversations(state)
})

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
 * The native title-bar buttons sit above the web content, so a full-window
 * scrim cannot swallow their clicks. Only the close button is gated on the same
 * overlay count the strip colour watches: a layer that waits on an answer must
 * not be hidden behind its own scrim. Minimize and maximize keep working — the
 * reader can move the window aside while a settings page or a dialog is open.
 */
function syncWindowControls(): void {
  if (typeof window.pi?.app?.setWindowClosable !== 'function') return
  const count = typeof document !== 'undefined' && typeof document.querySelectorAll === 'function'
    ? document.querySelectorAll(CHROME_OVERLAYS).length
    : 0
  void window.pi.app.setWindowClosable(count === 0)
}

/**
 * The native window controls are drawn by the OS over the top-right corner of
 * the web content, so their colour has to be what the page actually paints
 * there. The strip is the chrome token — and while a dialog is open it is the
 * scrim over that chrome, because the modal layer covers the whole window.
 */
function syncWindowChrome(dark: boolean): void {
  syncWindowControls()
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
  // Streaming text mutates the DOM on every frame, so skip subtrees that never
  // host non-portaled full-window layers (Lightbox and Mermaid fullscreen portal
  // directly to document.body) and avoid array allocations / subtree queries on
  // text or leaf nodes.
  const NON_OVERLAY_SUBTREES = '.assistant__text, .thinking__body, .terminal-pane'
  const isOverlayElement = (node: Element): boolean =>
    node.classList.contains('modal-layer') ||
    node.classList.contains('lightbox-layer') ||
    node.classList.contains('mermaid-layer')
  const listTouchesLayer = (nodes: NodeList): boolean => {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]
      if (node.nodeType !== 1) continue
      const element = node as Element
      if (isOverlayElement(element)) return true
      if (element.firstElementChild !== null && element.querySelector(CHROME_OVERLAYS)) return true
    }
    return false
  }
  const touchesLayer = (records: MutationRecord[]): boolean => {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]
      const target = record.target
      if (target instanceof Element && target.closest(NON_OVERLAY_SUBTREES)) continue
      if (listTouchesLayer(record.addedNodes) || listTouchesLayer(record.removedNodes)) return true
    }
    return false
  }
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

const appearanceSignatureByRoot = new WeakMap<Element, string>()

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
  const signature = [
    dark ? '1' : '0',
    settings.fontScale ?? 1,
    settings.themeTone ?? '',
    settings.accentColor ?? '',
    settings.customBg ?? '',
    settings.customFg ?? '',
    settings.fontFamily ?? 'system'
  ].join('\u0000')
  if (appearanceSignatureByRoot.get(root) === signature) {
    watchChromeOverlays()
    return
  }
  appearanceSignatureByRoot.set(root, signature)
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
  const accentInkColor = settings.accentColor ? resolveCssColor(settings.accentColor) : null
  if (settings.accentColor) {
    root.style.setProperty('--accent', settings.accentColor)
    root.style.setProperty('--focus-ring', settings.accentColor)
    root.style.setProperty('--accent-hover', `color-mix(in srgb, var(--accent) 88%, ${dark ? '#ffffff' : '#000000'})`)
    root.style.setProperty('--accent-soft', `color-mix(in srgb, var(--accent) 15%, transparent)`)
    root.style.setProperty('--accent-line', `color-mix(in srgb, var(--accent) 35%, transparent)`)
    root.style.setProperty('--accent-glow', `0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent)`)
    // The ink written on a filled accent (primary buttons, the update button's
    // ring) has to follow the accent the reader picked, not the theme's static
    // one: a pale accent with white ink made the ring vanish into its own fill.
    if (accentInkColor) root.style.setProperty('--accent-contrast', accentInk(accentInkColor))
    else remove('--accent-contrast')
  } else {
    remove('--accent')
    remove('--focus-ring')
    remove('--accent-hover')
    remove('--accent-soft')
    remove('--accent-line')
    remove('--accent-glow')
    remove('--accent-contrast')
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
  const fontStack = uiFontStack(settings.fontFamily)
  if (fontStack) {
    for (const property of FONT_STACK_PROPERTIES) root.style.setProperty(property, fontStack)
  } else {
    for (const property of FONT_STACK_PROPERTIES) remove(property)
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

function pendingDialogsFor(thread?: SessionThread, fallback?: ExtensionUiRequest): ExtensionUiRequest[] {
  if (thread) {
    if (thread.uiRequest === undefined) return []
    return thread.uiRequests?.length ? thread.uiRequests : [thread.uiRequest]
  }
  return fallback ? [fallback] : []
}

function phaseAfterDialog(
  state: { items: ThreadItem[]; run: RunState; retry?: RetryState },
  remainingQueueLength: number
): RunPhase {
  if (state.run.phase === 'aborting') return 'aborting'
  if (remainingQueueLength > 0) return 'waiting_approval'
  if (state.run.settled) return 'idle'
  if (state.retry) return 'retrying'
  if (state.items.some((item) => item.kind === 'tool' && item.status === 'running')) return 'tool_running'
  if (state.run.firstTokenAt !== undefined && state.run.messageGenerationStartedAt !== undefined) {
    return 'generating'
  }
  return 'working'
}

function replaceUiStatus(statuses: UiStatusEntry[], key: string, text: string): UiStatusEntry[] {
  const remaining = statuses.filter((entry) => entry.key !== key)
  if (text) remaining.push({ key, text })
  return remaining
}

const projectedThreadCache = new WeakMap<SessionThread, Pick<AppStore, (typeof THREAD_KEYS)[number]>>()

function projectThread(thread: SessionThread): Pick<AppStore, (typeof THREAD_KEYS)[number]> {
  const cached = projectedThreadCache.get(thread)
  if (cached) return cached
  const uiRequests = pendingDialogsFor(thread)
  const projected = {
    items: thread.items,
    historyLoaded: thread.historyLoaded,
    historyTruncated: thread.historyTruncated === true,
    run: thread.run,
    isStreaming: thread.isStreaming,
    transport: thread.transport,
    uiRequest: uiRequests[0],
    uiRequests,
    clientKey: thread.clientKey || '',
    cwdWait: thread.cwdWait,
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
    hasLiveTaskMode: thread.hasLiveTaskMode,
    models: thread.models ?? [],
    thinkingLevels: thread.thinkingLevels ?? [],
    commands: thread.commands ?? APP_COMMANDS,
    submitSeq: thread.submitSeq ?? 0,
    notice: thread.notice
  }
  projectedThreadCache.set(thread, projected)
  return projected
}

const EMPTY_THREAD_PROJECTION = projectThread(emptyThread())

function threadFromPatch(base: SessionThread, patch: Partial<AppStore>): SessionThread {
  const next = { ...base, version: base.version + 1 } as SessionThread
  const record = next as unknown as Record<string, unknown>
  for (const key of THREAD_KEYS) {
    if (key in patch) record[key] = patch[key]
  }
  return next
}

/** Tracks deleted session keys to prevent late events from resurrecting them. */
const deletedSessionKeys = new Set<string>()

function bindGet(get: GetState, owner: string): GetState {
  let lastState: AppStore | undefined
  let lastKey: string | undefined
  let lastProjected: AppStore | undefined
  return () => {
    const state = get()
    const key = threadKey(owner)
    if (lastState === state && lastKey === key && lastProjected !== undefined) {
      return lastProjected
    }
    const thread = state.threads[key]
    let result: AppStore
    if (!thread) {
      const viewCanonical = viewKeyOf(state) ? threadKey(viewKeyOf(state)) : ''
      if (key && (deletedSessionKeys.has(key) || key !== viewCanonical)) {
        // Isolate uncreated/deleted background keys from the currently viewed session's state.
        result = {
          ...state,
          ...EMPTY_THREAD_PROJECTION,
          activeSessionFile: key.startsWith('draft:') ? undefined : key,
          draftId: key.startsWith('draft:') ? key : undefined
        }
      } else {
        result = state
      }
    } else {
      result = {
        ...state,
        ...projectThread(thread),
        activeSessionFile: key.startsWith('draft:') ? undefined : key,
        draftId: key.startsWith('draft:') ? key : undefined
      }
    }
    lastState = state
    lastKey = key
    lastProjected = result
    return result
  }
}

function bindSet(
  set: SetState,
  get: GetState,
  owner: string,
  options?: RevisionOptions
): SetState {
  return (partial, callOptions) => {
    const state = get()
    const key = threadKey(owner)
    const base = state.threads[key]
    if (key && !base && deletedSessionKeys.has(key)) return
    // A background key has no thread yet, and its folder is not necessarily
    // the one on screen. Leave the cwd blank so the runtime's own status fills
    // it, instead of pointing the row at whichever project the reader opened.
    const thread = base ?? emptyThread()
    const patch = typeof partial === 'function' ? partial({ ...state, ...projectThread(thread) }) : partial
    const next = threadFromPatch(thread, patch)
    const threads = { ...state.threads, ...(key ? { [key]: next } : {}) }
    const viewKey = viewKeyOf(state)
    const viewCanonical = viewKey ? threadKey(viewKey) : ''
    const mergedOptions = callOptions ?? options
    if (!key || key === viewKey || (viewCanonical && key === viewCanonical)) {
      set({ ...patch, threads }, mergedOptions)
    } else {
      set({ threads }, mergedOptions)
    }
  }
}

function rekeyThread(
  set: SetState,
  get: GetState,
  from: string,
  to: string,
  replace = false
): void {
  from = threadKey(from)
  drainPending(from)
  if (from === to) return
  const shouldMove = replace || from.startsWith('draft:')
  rekeyStreamState(from, to, shouldMove)

  const state = get()
  const thread = state.threads[from]
  const threads = { ...state.threads }
  let nextDrafts: Record<string, ComposerDraft> | undefined

  if (shouldMove) {
    const stateRefreshRequest = refreshStateRequests.get(from)
    if (stateRefreshRequest !== undefined) {
      const targetRequest = refreshStateRequests.get(to)
      if (targetRequest === undefined || stateRefreshRequest > targetRequest) {
        refreshStateRequests.set(to, stateRefreshRequest)
      }
      refreshStateRequests.delete(from)
    }
    const bashCount = inlineBashCounts.get(from)
    if (bashCount !== undefined) {
      inlineBashCounts.set(to, (inlineBashCounts.get(to) ?? 0) + bashCount)
      inlineBashCounts.delete(from)
    }
    migrateToolStarts(from, to)
    // The reader's place belongs to the conversation, not to whether Pi has
    // written it to disk yet; carry it across the draft→file rename.
    migrateScrollMemory(from, to)
    migrateViewState(from, to)
    migrateSessionTiming(from, to)
    migrateQueuedPrompts(from, to)
    const aliases = [...(threadAliasesByTarget.get(from) ?? [])]
    for (const alias of aliases) {
      migrateScrollMemory(alias, to)
      migrateViewState(alias, to)
    }
    if (from in state.drafts) {
      nextDrafts = { ...state.drafts }
      const sourceDraft = nextDrafts[from]
      delete nextDrafts[from]
      if (
        !nextDrafts[to] ||
        (!nextDrafts[to].text &&
          nextDrafts[to].images.length === 0 &&
          (nextDrafts[to].files?.length ?? 0) === 0)
      ) {
        nextDrafts[to] = sourceDraft
      }
    }
    if (thread) {
      delete threads[from]
      for (const alias of aliases) setThreadAlias(alias, to)
      setThreadAlias(from, to)
      threads[to] = thread
    }
  } else if (thread) {
    // A fork or clone branches a second conversation while leaving the original
    // file intact on disk, so it gets its own fresh clientKey instead of moving
    // or aliasing `from`'s view state, scroll memory, timing, or drafts.
    threads[to] ??= {
      ...thread,
      items: [],
      historyLoaded: false,
      historyTruncated: false,
      contextBreakdown: undefined,
      forkTargets: [],
      clientKey: mintClientKey(),
      notice: undefined,
      uiRequests: pendingDialogsFor(thread)
    }
  }

  const targetThread = threads[to]
  const viewing = state.draftId === from || state.activeSessionFile === from
  const loadBranch = !shouldMove && targetThread && needsSessionHydration(to, targetThread)
  if (shouldMove && from.startsWith('draft:')) {
    persistPromotedDraft(state, from, nextDrafts ?? state.drafts)
  }
  set({
    threads,
    ...(nextDrafts ? { drafts: nextDrafts } : {}),
    ...(viewing
      ? {
          draftId: undefined,
          activeSessionFile: to,
          ...(targetThread ? projectThread(targetThread) : {}),
          ...(loadBranch ? { hydratingSessionFile: to } : {})
        }
      : {})
  })
  if (loadBranch) void get().hydrateSession(to, 'branch')
}

type SetState = (
  partial: Partial<AppStore> | ((state: AppStore) => Partial<AppStore>),
  options?: RevisionOptions
) => void
type GetState = () => AppStore

/**
 * Status entries that describe the *process* rather than the conversation.
 *
 * The swarm roster is the worker processes of one Pi process, published over
 * the status channel. When that process stops, the workers stop with it — but
 * the last roster it published would otherwise stay in the thread for the rest
 * of the app's life, and the Swarm page would keep a spinner (and a duration
 * that only grows) for work that is already gone. The mode and goal entries are
 * deliberately not here: they are persisted in the session and are restored
 * from disk, so they outlive the process that published them.
 */
const PROCESS_LIVE_STATUS_KEYS = [SWARM_STATUS_KEY]

function applyRuntimeStatus(set: SetState, status: RuntimeStatus): void {
  if (status.phase === 'error') {
    set({
      status,
      cwdWait: undefined,
      transport: 'disconnected',
      ...(status.error ? { error: status.error } : {})
    })
    return
  }
  if (status.phase === 'ready' || status.phase === 'starting') {
    // A fresh process means a fresh event channel, whatever happened to
    // the previous one. "starting" is that handoff, not a dropped connection.
    set({ status, transport: 'connected' })
  } else if (status.phase === 'stopped') {
    // The Pi process is gone. That is a lost transport, not proof that
    // the run failed, so the run state is left for the events to settle.
    set({ status, transport: 'disconnected' })
  } else {
    set({ status })
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
  const key = viewKeyOf(get())
  if (flushImmediately || typeof requestAnimationFrame !== 'function') {
    drainPending(key)
    set((state) => ({ items: applyEvent(state.items, event, context) }))
    return
  }
  const batch = pending.get(key) ?? { set, events: [] }
  if (!coalescePendingEvent(batch.events, event, context)) {
    batch.events.push({ event, context })
  }
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
 * Fold consecutive replaceable or additive deltas within one pending frame batch:
 * - `message_update` (`text_delta`, `thinking_delta`, `toolcall_delta`) with identical
 *   block `contentIndex` concatenate into one delta record.
 * - `tool_execution_update` replaces any trailing `tool_execution_update` for the
 *   same `toolCallId` (its `partialResult` is already the newest full snapshot).
 */
function coalescePendingEvent(
  events: { event: PiEvent; context: ReturnType<typeof runContextOf> }[],
  nextEvent: PiEvent,
  nextContext: ReturnType<typeof runContextOf>
): boolean {
  if (events.length === 0) return false
  if (nextEvent.type === 'tool_execution_update') {
    const nextToolId = typeof nextEvent.toolCallId === 'string' ? nextEvent.toolCallId : ''
    if (!nextToolId) return false
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const candidate = events[index]
      if (candidate.event.type !== 'tool_execution_update') break
      if (
        candidate.context.sessionKey === nextContext.sessionKey &&
        candidate.context.runId === nextContext.runId &&
        candidate.context.turnId === nextContext.turnId &&
        candidate.event.toolCallId === nextToolId
      ) {
        candidate.event = nextEvent
        candidate.context = nextContext
        return true
      }
    }
    return false
  }
  const last = events[events.length - 1]
  const merged = mergeTextDelta(last.event, last.context, nextEvent, nextContext)
  if (!merged) return false
  last.event = merged
  return true
}

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
  if (
    previous.type !== 'text_delta' &&
    previous.type !== 'thinking_delta' &&
    previous.type !== 'toolcall_delta'
  ) {
    return null
  }
  // Without a content index there is no proof the two deltas belong to the
  // same block, so leave them separate rather than risk merging two blocks.
  if (previous.contentIndex === undefined || next.contentIndex === undefined) return null
  if (previous.contentIndex !== next.contentIndex) return null
  const useLatestSnapshot = next.type === 'thinking_delta'
  return {
    ...(useLatestSnapshot ? nextEvent : previousEvent),
    assistantMessageEvent: {
      ...(useLatestSnapshot ? next : previous),
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

/** Apply queued frame batches (or just `onlyKey`'s batch when scoped to one session). */
function drainPending(onlyKey?: string): void {
  let entries: [string, { set: SetState; events: { event: PiEvent; context: ReturnType<typeof runContextOf> }[] }][]
  if (onlyKey !== undefined) {
    const batch = pending.get(onlyKey)
    if (!batch) return
    pending.delete(onlyKey)
    entries = [[onlyKey, batch]]
  } else {
    if (pending.size === 0) {
      if (hiddenFlushTimer !== null) {
        clearTimeout(hiddenFlushTimer)
        hiddenFlushTimer = null
      }
      if (flushHandle !== null) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(flushHandle)
        flushHandle = null
      }
      return
    }
    entries = [...pending.entries()]
    pending.clear()
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

  rawStoreSetState((state) => {
    const currentViewKey = viewKeyOf(state)
    const currentViewCanonical = currentViewKey ? threadKey(currentViewKey) : ''
    let nextThreads: Record<string, SessionThread> | undefined
    let activeItemsPatch: { items: ThreadItem[] } | undefined
    let toolChangedHint: boolean | undefined

    for (const [key, batch] of entries) {
      if (batch.events.length === 0) continue
      const base = (nextThreads ? nextThreads[key] : undefined) ?? state.threads[key]
      if (key && !base && deletedSessionKeys.has(key)) continue
      // Match `bindSet`: an uninitialized background thread belongs to its own
      // runtime's folder, never the active view's workspace.
      const thread = base ?? emptyThread()
      const nextItems = applyEventBatch(thread.items, batch.events)
      if (nextItems === thread.items) continue
      const nextThread = threadFromPatch(thread, { items: nextItems })

      if (!nextThreads) {
        nextThreads = { ...state.threads }
      }
      if (key) {
        nextThreads[key] = nextThread
      }

      if (!key || key === currentViewKey || (currentViewCanonical && threadKey(key) === currentViewCanonical)) {
        activeItemsPatch = { items: nextItems }
        toolChangedHint = hasToolItemChange(state.items, nextItems)
      }
    }

    if (!nextThreads && !activeItemsPatch) return state

    return withRevisions(
      state,
      {
        ...(activeItemsPatch ?? {}),
        ...(nextThreads ? { threads: nextThreads } : {})
      },
      { toolChangedHint }
    )
  })
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' && pending.size > 0) drainPending()
  })
}

function forgetDeletedThread(file: string): void {
  const keys = new Set([file, ...clearThreadAliasesForTarget(file)])
  for (const key of keys) {
    deletedSessionKeys.add(key)
  }
  if (deletedSessionKeys.size > 500) {
    const toPrune = [...deletedSessionKeys].slice(0, 100)
    for (const k of toPrune) deletedSessionKeys.delete(k)
  }
  if (scheduledPrewarmKey && keys.has(scheduledPrewarmKey)) cancelScheduledPrewarm()
  for (const key of keys) {
    refreshStateRequests.delete(key)
    retryArmed.delete(key)
    prewarmOnlyRuntimes.delete(key)
    pendingModelSelections.delete(key)
    toolStarts.delete(key)
    pending.delete(key)
    liveStatsAt.delete(key)
    liveStatsEpoch.delete(key)
    liveStatsInFlight.delete(key)
    forgetSessionLru(key)
    clearScrollMemory(key)
    clearViewState(key)
    forgetSessionTiming(key)
    resetStreamState(key)
    try {
      cachedDraftStorage()?.removeItem(`pi-desktop.session-tree.collapsed:${key}`)
    } catch {
      /* ignore disabled storage */
    }
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
  let completed = false
  const handle = requestAnimationFrame(() => {
    completed = true
    flushHandle = null
    drainPending()
  })
  if (!completed) flushHandle = handle
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
  return (
    toolName === 'edit' ||
    toolName === 'write' ||
    toolName === 'bash' ||
    toolName === 'powershell' ||
    toolName === 'generate_image'
  )
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

function recordActiveRoundDuration(
  timingKey: string,
  items: readonly ThreadItem[],
  durationMs: number
): void {
  let userOrdinal = 0
  let roundOrdinal = 0
  let starter:
    | { kind: 'user'; timestamp: number; ordinal: number }
    | { kind: 'roundBreak'; timestamp: number; ordinal: number }
    | undefined
  for (const item of items) {
    if (item.kind === 'user') {
      starter = { kind: 'user', timestamp: item.timestamp, ordinal: userOrdinal }
      userOrdinal += 1
    } else if (item.kind === 'roundBreak') {
      starter = { kind: 'roundBreak', timestamp: item.timestamp, ordinal: roundOrdinal }
      roundOrdinal += 1
    }
  }
  if (starter?.kind === 'user') {
    recordRunDuration(timingKey, starter.timestamp, durationMs, starter.ordinal)
  } else if (starter?.kind === 'roundBreak') {
    recordRoundDuration(timingKey, starter.timestamp, durationMs, starter.ordinal)
  }
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
      const sessionKey = runContextOf(get).sessionKey
      drainPending(sessionKey || (owner ? threadKey(owner) : undefined))
      beginStream(sessionKey)
      // A new run supersedes whatever the last one left behind, including the
      // persisted copy the sidebar falls back to after a restart.
      get().forgetSessionNotice(sessionKey || (owner ? threadKey(owner) : ''))
      // A live-stats read issued before this run describes the session as it
      // was; it must not land on the fresh transcript numbers below, and the
      // first answer of the new run should be allowed to ask again at once.
      setBoundedMap(liveStatsEpoch, sessionKey, (liveStatsEpoch.get(sessionKey) ?? 0) + 1)
      liveStatsAt.delete(sessionKey)
      // One run per prompt. A follow-up prompt that arrives while a run is
      // active does not open a second one: Pi folds it into the current run.
      const startedAt = Date.now()
      const startedMonotonicAt = monotonicNow()
      set((state) => ({
        isStreaming: true,
        error: undefined,
        cwdWait: undefined,
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
              roundTurns: 0,
              startedAt,
              startedMonotonicAt,
              generationMs: 0,
              settled: false,
              hadError: false
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
      const sessionKey = runContextOf(get).sessionKey
      drainPending(sessionKey || (owner ? threadKey(owner) : undefined))
      beginStream(sessionKey)
      const modelTurnStartedAt = monotonicNow()
      set((state) => ({
        isStreaming: true,
        retry: undefined,
        run: state.run.runId
          ? {
              ...state.run,
              turnId: nextId('turn'),
              turns: state.run.turns + 1,
              roundTurns: (state.run.roundTurns ?? state.run.turns) + 1,
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
    case 'entry_appended': {
      const entry = (event as {
        entry?: { type?: unknown; customType?: unknown }
      }).entry
      if (entry?.type === 'custom_message' && entry.customType === GOAL_CONTINUE_CUSTOM_TYPE) {
        const key = viewKeyOf(get())
        const timingKey = owner ? threadKey(owner) : key
        drainPending(key || (owner ? threadKey(owner) : undefined))
        const state = get()
        const durationMs =
          state.run.startedMonotonicAt !== undefined
            ? Math.max(0, monotonicNow() - state.run.startedMonotonicAt)
            : state.run.startedAt !== undefined
              ? Math.max(0, Date.now() - state.run.startedAt)
              : undefined
        if (durationMs !== undefined) {
          recordActiveRoundDuration(timingKey, state.items, durationMs)
        }
        const now = Date.now()
        const monotonic = monotonicNow()
        set((current) => ({
          run: {
            ...current.run,
            startedAt: now,
            startedMonotonicAt: monotonic,
            roundTurns: 0,
            modelTurnStartedAt: undefined,
            firstTokenAt: undefined,
            phase: phaseFor(current, 'working'),
            settled: false
          }
        }))
        scheduleItems(set, get, event, true)
      }
      break
    }
    case 'agent_settled': {
      // The one authoritative "the runtime is done" signal.
      const aborted = Boolean(event.aborted)
      // The supervisor mints this when the process died before it could write
      // its own settle. The user did not stop that run, so it failed.
      const crashed = Boolean(event.crashed)
      const settledKey = owner ? threadKey(owner) : ''
      // Anything still waiting for a frame is applied first: the final
      // state has to be the state the events actually produced.
      drainPending(settledKey || runContextOf(get).sessionKey || undefined)
      finishStream(runContextOf(get).sessionKey)
      const state = get()
      const durationMs =
        state.run.startedMonotonicAt !== undefined
          ? Math.max(0, monotonicNow() - state.run.startedMonotonicAt)
          : state.run.startedAt !== undefined
            ? Math.max(0, Date.now() - state.run.startedAt)
            : undefined
      const timingKey = owner ? threadKey(owner) : viewKeyOf(state)
      toolStarts.delete(timingKey)
      // Model durations are recorded only when the assistant message ends.
      // Settling without that event means the response was interrupted or
      // incomplete, so its wait time must not become a model-time sample.
      // Pi's own `agent_settled` carries only `aborted`; a failure is visible on
      // the last assistant message or recorded via mid-turn extension/retry errors.
      const lastAssistant = [...state.items]
        .reverse()
        .find((item) => item.kind === 'assistant')
      const failed =
        crashed ||
        (!aborted &&
          (Boolean(state.run.hadError) ||
            (lastAssistant?.kind === 'assistant' && lastAssistant.stopReason === 'error')))
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
      if (!aborted && !failed) {
        if (durationMs !== undefined) {
          recordActiveRoundDuration(timingKey, state.items, durationMs)
        }
        if (runUser?.kind === 'user') {
          // The summed windows of the answers in this turn. A tool gap between
          // them is not generation time and must not slow the restored TPS.
          const generatedMs = state.run.generationMs ?? 0
          if (generatedMs > 0) {
            recordGenerationWindow(timingKey, runUser.timestamp, generatedMs, runUserOrdinal)
          }
        }
      }
      // A mark means "there is something in this conversation the reader has
      // not looked at": a failure outranks an answer, and an answer that
      // finished while the reader was elsewhere (or while reading a desk page)
      // is unread. A conversation the reader is watching speaks for itself.
      const topState = realGet ? realGet() : get()
      const currentViewKey = viewKeyOf(topState)
      const viewed = settledKey
        ? settledKey === (currentViewKey ? threadKey(currentViewKey) : '') && topState.deskPage === null
        : true
      const notice: SessionNotice | undefined = viewed
        ? undefined
        : failed
          ? 'error'
          : aborted
            ? undefined
            : 'unread'
      set({
        isStreaming: false,
        cwdWait: undefined,
        items: aborted || crashed ? markAborted(state.items) : state.items,
        run: {
          ...state.run,
          phase: 'idle',
          compaction: undefined,
          messageGenerationStartedAt: undefined,
          modelTurnStartedAt: undefined,
          settled: true,
          hadError: undefined,
          outcome: aborted ? 'aborted' : failed ? 'failed' : 'completed',
          durationMs
        },
        retry: undefined,
        notice,
        ...(event.runtimeStopped ? { status: { ...state.status, phase: 'ready' as const }, transport: 'connected' as const } : {}),
        // Pi resolves a dialog on its own when its timeout expires. The
        // client is not told, so the dialog queue is cleared when the agent moves on.
        uiRequests: [],
        uiRequest: state.uiRequest ? undefined : state.uiRequest
      })
      // The mark has to outlive this thread: a scheduled or background run is
      // often read after the app has been restarted.
      if (notice) get().rememberSessionNotice(settledKey, notice)
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
      // A finish in another conversation is easy to miss while the reader is
      // watching this one: the row dot is the only mark, and a folded or long
      // project lists hide attention rows. A named toast says which
      // conversation moved and is itself the way back to it. A run the reader
      // stopped is not news, and an unfocused window already gets the system
      // notification.
      if (!viewed && settledKey && !aborted) {
        // Tests and non-DOM hosts have no focus concept; treat them as focused.
        const focused =
          typeof document === 'undefined' || typeof document.hasFocus !== 'function'
            ? true
            : document.hasFocus()
        if (focused) {
          const store = (realGet ?? get)()
          const language = store.settings.language ?? 'en'
          const title =
            activeConversationTitle(topState.sessions, topState.threads, settledKey) ||
            translate('A background conversation', language)
          const template = translate(failed ? '{title} failed' : '{title} finished', language)
          store.showToast(
            template.replace('{title}', title),
            failed ? 'error' : 'info',
            settledKey
          )
        }
      }
      if (realGet && realSet) {
        const current = realGet()
        const threads = enforceSessionLru(current.threads, viewKeyOf(current))
        if (threads !== current.threads) realSet({ threads })
      }
      const key = viewKeyOf(get())
      if (!event.runtimeStopped && !crashed) {
        const currentThread = get()
        void get().refreshState(key, {
          includeCatalog: currentThread.models.length === 0 || currentThread.thinkingLevels.length === 0
        })
      }
      void get().refreshSessions()
      // The agent just edited files, so the branch chip and the review panel
      // should hear about the new working tree.
      if (gitBelongsToView(get, realGet, owner)) void get().refreshGit()
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
    case 'auto_retry_end': {
      scheduleItems(set, get, event)
      const retryFailed =
        !Boolean(event.success) && String(event.finalError ?? '') !== 'Retry cancelled'
      set((state) => ({
        retry: undefined,
        run: {
          ...state.run,
          phase: phaseFor(state, 'working'),
          settled: false,
          ...(retryFailed ? { hadError: true } : {})
        }
      }))
      break
    }
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
        pinScrollToBottom(owner || viewKeyOf(get()))
        set((state) => ({
          // A prompt can start before `agent_start`; invalidate the same
          // cached snapshot here so transcript usage stays current.
          stats: undefined,
          submitSeq: (state.submitSeq ?? 0) + 1,
          run:
            !state.run.runId || state.run.phase === 'idle' || state.run.settled
              ? // A prompt that started a run before the client saw `agent_start`
                // still needs one, or the items would belong to no run.
                {
                  phase: 'working',
                  runId: nextId('run'),
                  turns: 0,
                  roundTurns: 0,
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
      scheduleItems(set, get, event, role === 'user')
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
      if (event.type === 'extension_error') {
        if (pendingRewind && event.extensionPath === 'command:desktop-rewind' &&
          threadKey(pendingRewind.sessionKey) === threadKey(owner || viewKeyOf(get()))) {
          pendingRewind.error = typeof event.error === 'string' ? event.error : 'This message cannot be edited'
        }
        set((state) => ({
          run: state.run.settled ? state.run : { ...state.run, hadError: true }
        }))
      }
      let eventForItems = event
      if (event.type === 'tool_execution_end') {
        // Apply only this thread's queued start/updates first so its monotonic
        // clock can fill in when Pi omitted duration on completion.
        const timingKey = owner ? threadKey(owner) : viewKeyOf(get())
        drainPending(timingKey || undefined)
        const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined
        const existing = toolCallId
          ? get().items.find((item) => item.kind === 'tool' && item.toolCallId === toolCallId)
          : undefined
        const terminal = existing?.kind === 'tool' &&
          (existing.status === 'ok' || existing.status === 'error' || existing.status === 'aborted')
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
      // was recorded. Apply tool completions synchronously too so phase reading
      // below inspects the settled tool list in a single pass.
      scheduleItems(
        set,
        get,
        eventForItems,
        event.type === 'tool_execution_start' || event.type === 'tool_execution_end'
      )
      // The run phase is exported from what the transcript actually holds:
      // a tool that started means one is running, and the run only goes back
      // to "the model is answering" when none is left.
      if (event.type === 'tool_execution_start') {
        set((state) => ({
          run: { ...state.run, phase: phaseFor(state, 'tool_running'), settled: false }
        }))
      }
      if (event.type === 'tool_execution_end') {
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
        // A tool result is part of the next prompt, and the session totals Pi
        // reports now include it. Pulling them here keeps the usage line and
        // the context ring moving between answers instead of jumping only at
        // `agent_settled`; the read is throttled per conversation.
        get().refreshLiveStats(owner ? threadKey(owner) : undefined)
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
          // `agent_start` cleared the last Pi snapshot so the transcript could
          // drive the line; this is the first moment a new one is worth
          // reading. Without it the bar showed the previous totals (or zero,
          // when the live items had not landed their usage yet) until the run
          // settled, which is a long wait on a tool-heavy turn.
          get().refreshLiveStats(owner ? threadKey(owner) : undefined)
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
          // Some providers close a message through `message_update:done` and
          // never emit a top-level `message_end`; the statistics read must
          // not depend on which of the two shapes the provider chose.
          get().refreshLiveStats(owner ? threadKey(owner) : undefined)
        }
        const currentState = get()
        const needsFirstToken = contentDelta && currentState.run.firstTokenAt === undefined
        const needsWindowStart = generatingDelta && currentState.run.messageGenerationStartedAt === undefined
        const needsPhase = textDelta && currentState.run.phase !== phaseFor(currentState, 'generating')
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
      handleExtensionUi(set, get, event as unknown as ExtensionUiRequest, owner, realGet, realSet)
      break
    }
    default:
      break
  }
}

/**
 * Apply one `extension_ui_request`.
 *
 * Dialog methods block the agent until an answer arrives, so they queue per
 * conversation in FIFO order (`uiRequests`, with `uiRequest === uiRequests[0]`).
 * The rest are fire-and-forget decorations or editor updates.
 */
function handleExtensionUi(
  set: SetState,
  get: GetState,
  request: ExtensionUiRequest,
  owner?: string,
  realGet?: GetState,
  realSet?: SetState
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
      // Queue blocking dialogs FIFO per thread so concurrent prompts (for
      // example from background sessions or sibling subagents) never drop.
      set((state) => {
        const existing = state.uiRequest
          ? (state.uiRequests?.length ? state.uiRequests : [state.uiRequest])
          : []
        const nextQueue = existing.some((entry) => entry.id === taggedRequest.id)
          ? existing
          : [...existing, taggedRequest]
        return {
          uiRequests: nextQueue,
          uiRequest: nextQueue[0],
          run: { ...state.run, phase: phaseFor(state, 'waiting_approval') }
        }
      })
      break
    }
    case 'notify': {
      // Extension "info" is terminal chatter — startup banners such as
      // "Ponytail loaded: full" arrive on every cold start. Only a warning or
      // an error is worth interrupting what the user is writing. MCP and skill
      // plugins also publish their own startup state through this channel;
      // those lines belong to the plugin, not the conversation, and are
      // deliberately kept out of the composer's toast slot.
      const level = request.notifyType ?? 'info'
      const message = stripAnsi(request.message ?? '')
      if ((level === 'warning' || level === 'error') && !isMcpOrSkillChatter(message)) {
        const topState = realGet ? realGet() : get()
        const viewKey = viewKeyOf(topState)
        const canonicalOwner = owner ? threadKey(owner) : ''
        const isBackground = Boolean(
          canonicalOwner && canonicalOwner !== (viewKey ? threadKey(viewKey) : '')
        )
        const title = isBackground
          ? activeConversationTitle(topState.sessions, topState.threads, canonicalOwner)
          : ''
        const attributed = title ? `[${title}] ${message}` : message
        ;(realGet ?? get)().showToast(attributed, level)
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
        const queue = state.uiRequest
          ? (state.uiRequests?.length ? state.uiRequests : [state.uiRequest])
          : []
        if (typeof requestId !== 'string' || !queue.some((entry) => entry.id === requestId)) break
        const sessionKey = taggedRequest.sessionKey || viewKeyOf(state)
        set((current) => {
          const currentQueue = current.uiRequest
            ? (current.uiRequests?.length ? current.uiRequests : [current.uiRequest])
            : []
          const remaining = currentQueue.filter((entry) => entry.id !== requestId)
          return {
            uiRequests: remaining,
            uiRequest: remaining[0],
            run:
              current.run.phase === 'waiting_approval'
                ? { ...current.run, phase: phaseAfterDialog(current, remaining.length) }
                : current.run
          }
        })
        void window.pi.runtime.respondUi(requestId, { confirmed: false, cancelled: true }, sessionKey)
          .catch((error: unknown) => get().showToast(messageOf(error), 'error'))
        break
      }
      if (key === CONTEXT_BREAKDOWN_STATUS_KEY) {
        const contextBreakdown = parseRequestContextBreakdown(request.statusText)
        if (contextBreakdown) {
          const targetKey = taggedRequest.sessionKey
          const canonicalOwner = owner ? threadKey(owner) : undefined
          if (targetKey && targetKey !== canonicalOwner && realSet && realGet) {
            bindSet(realSet, realGet, targetKey)({ contextBreakdown })
          } else {
            set({ contextBreakdown })
          }
        }
        break
      }
      if (key === TASK_MODE_STATUS_KEY) {
        const mode = request.statusText
        if (isAgentMode(mode)) set({ agentMode: mode, hasLiveTaskMode: true })
        break
      }
      const text = key === GOAL_STATUS_KEY
        ? request.statusText ?? ''
        : request.statusText ? stripAnsi(request.statusText).replace(/\s+/g, ' ').trim() : ''
      set((state) => ({
        uiStatuses: replaceUiStatus(state.uiStatuses, key, text),
        ...(key === GOAL_STATUS_KEY ? { hasLiveTaskMode: true } : {})
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
      const nextText = request.text ?? ''
      const targetKey = taggedRequest.sessionKey
        ? threadKey(taggedRequest.sessionKey)
        : owner
          ? threadKey(owner)
          : ''
      const topState = realGet ? realGet() : get()
      const currentView = viewKeyOf(topState)
      const isViewed = !realGet || !targetKey || targetKey === (currentView ? threadKey(currentView) : '')
      if (targetKey && realSet) {
        realSet((state) => {
          const previous = state.drafts[targetKey] ?? { text: '', images: [] }
          const nextDrafts = { ...state.drafts, [targetKey]: { ...previous, text: nextText } }
          persistDraftSnapshot(state, nextDrafts, undefined, { debounce: true })
          return {
            drafts: nextDrafts,
            ...(isViewed ? { composerText: nextText } : {})
          }
        })
      } else if (isViewed) {
        set({ composerText: nextText })
      }
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
