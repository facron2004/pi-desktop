/**
 * Shared type contracts between the Electron main process, the preload bridge
 * and the renderer. Everything crossing the IPC boundary is described here.
 */
import type { ProviderConnection, ProviderModel, ProviderProbeResult, ProviderProfile, SaveProviderInput } from './providers'
import type {
  CreateResourceInput,
  ManagedPackage,
  MarketplaceActionResult,
  MarketplaceInstallResult,
  MarketplaceSnapshot
} from './marketplace'
export type {
  CreateResourceInput,
  ManagedPackage,
  MarketplaceActionResult,
  MarketplaceInstallResult,
  MarketplaceSnapshot
} from './marketplace'

/** Maximum image payload shared by file picking, drops, paste and image writes. */
export const MAX_IMAGE_DATA_BYTES = 24 * 1024 * 1024

/** Maximum prompt length accepted by the remote phone companion. */
export const MAX_REMOTE_MESSAGE_CHARS = 100_000

/* ------------------------------------------------------------------ *
 * Pi RPC protocol
 * ------------------------------------------------------------------ */

export interface RpcResponse<T = unknown> {
  id?: string
  type: 'response'
  command: string
  success: boolean
  data?: T
  error?: string
}

/** Any record Pi writes to stdout that is not a command response. */
export interface PiEvent {
  type: string
  [key: string]: unknown
}

export interface RuntimeEvent {
  ownerId: string
  event: PiEvent
}

export interface RuntimeStatusEvent {
  ownerId: string
  status: RuntimeStatus
}

export interface RuntimeRekey {
  from: string
  to: string
  /** Startup replaced a file that had not been persisted, rather than forking it. */
  replace?: boolean
}

/* ------------------------------------------------------------------ *
 * Content blocks / messages
 * ------------------------------------------------------------------ */

export interface TextContent {
  type: 'text'
  text: string
  textSignature?: string
}

export interface ImageContent {
  type: 'image'
  data: string
  mimeType: string
}

export interface ThinkingContent {
  type: 'thinking'
  thinking: string
  thinkingSignature?: string
  redacted?: boolean
}

export interface ToolCallContent {
  type: 'toolCall'
  id: string
  name: string
  arguments: Record<string, unknown>
  namespace?: string
}

export type ContentBlock = TextContent | ImageContent | ThinkingContent | ToolCallContent

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost?: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}

export interface AgentMessage {
  role: string
  content: string | ContentBlock[]
  timestamp: number
  usage?: Usage
  stopReason?: string
  errorMessage?: string
  api?: string
  provider?: string
  model?: string
  thinkingLevel?: string
  toolCallId?: string
  toolName?: string
  isError?: boolean
  [key: string]: unknown
}

export interface ModelInfo {
  id: string
  name: string
  api: string
  provider: string
  baseUrl?: string
  reasoning: boolean
  input: string[]
  contextWindow: number
  maxTokens: number
  cost?: Record<string, number>
}

export interface PiCommand {
  name: string
  description?: string
  /** `app` covers the commands the desktop app itself provides. */
  source: 'extension' | 'prompt' | 'skill' | 'app'
  /** The command needs an argument, so it is typed rather than run. */
  takesArgument?: boolean
  sourceInfo?: {
    path?: string
    source?: string
    scope?: string
    origin?: string
    baseDir?: string
  }
}

/**
 * A user message the active branch can be forked from.
 *
 * Pi forks *before* the message, so the new branch keeps everything that came
 * earlier and the prompt itself comes back as text for the user to re-send.
 */
export interface ForkTarget {
  entryId: string
  text: string
}

/** What the app shell is asked to show in the inspector. */
export interface InspectorRequest {
  tab?: 'changes' | 'files'
  /** A file to open, optionally at a line. */
  file?: string
  line?: number
}

export interface PiState {
  model?: ModelInfo
  thinkingLevel?: string
  isStreaming: boolean
  isCompacting: boolean
  steeringMode?: string
  followUpMode?: string
  sessionFile?: string
  sessionId?: string
  sessionName?: string
  autoCompactionEnabled?: boolean
  autoRetryEnabled?: boolean
  messageCount?: number
  pendingMessageCount?: number
}

export interface SessionStats {
  sessionFile?: string
  sessionId?: string
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolResults: number
  totalMessages: number
  /**
   * Token totals for the whole session. This is not the `Usage` shape an
   * assistant message carries — Pi reports the sum under `total`.
   */
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  cost: number
  contextUsage?: {
    tokens: number | null
    contextWindow: number
    percent: number | null
  }
}

/** Approximate token breakdown from the current request or saved session. */
export interface ContextBreakdown {
  systemPrompt: number | null
  toolDefinitions: number | null
  conversationMessages: number | null
  source: 'request' | 'session'
}

export const CONTEXT_BREAKDOWN_STATUS_KEY = 'pi-desktop-context-breakdown'
export const GENERATION_TIMING_STATUS_KEY = 'pi-desktop-generation-timing'
export const SUBAGENT_EDITOR_PENDING_STATUS_KEY = 'pi-desktop-subagent-editor-pending'
export const SUBAGENT_EDITOR_CANCEL_STATUS_KEY = 'pi-desktop-subagent-editor-cancel'

/* ------------------------------------------------------------------ *
 * Extension UI sub-protocol
 * ------------------------------------------------------------------ */

/**
 * A user-interaction request raised by a Pi extension.
 *
 * Dialog methods (`select`, `confirm`, `input`, `editor`) block the agent
 * until the client answers with an `extension_ui_response` carrying the
 * same `id`. The remaining methods are fire-and-forget.
 */
export interface ExtensionUiRequest {
  type: 'extension_ui_request'
  id: string
  method: ExtensionUiMethod
  title?: string
  message?: string
  /** Added by main for tool calls awaiting the user's approval. */
  approval?: ToolApproval
  placeholder?: string
  prefill?: string
  options?: string[]
  /** Milliseconds before the agent resolves the request on its own. */
  timeout?: number
  notifyType?: 'info' | 'warning' | 'error'
  statusKey?: string
  statusText?: string
  widgetKey?: string
  widgetLines?: string[]
  widgetPlacement?: 'aboveEditor' | 'belowEditor'
  text?: string
  /** Originating runtime/session key so responses route back to the correct session. */
  sessionKey?: string
  ownerId?: string
}

export type ExtensionUiMethod =
  | 'select'
  | 'confirm'
  | 'input'
  | 'editor'
  | 'notify'
  | 'setStatus'
  | 'setWidget'
  | 'setTitle'
  | 'set_editor_text'

/** The answer sent back to the agent for a blocking dialog. */
export interface ExtensionUiResponse {
  value?: string
  confirmed?: boolean
  cancelled?: boolean
}

/* ------------------------------------------------------------------ *
 * App domain
 * ------------------------------------------------------------------ */

/**
 * The tint a project icon can wear.
 *
 * The eight hues are the ones MCode offers; each maps to one token, so the
 * colour never appears as a literal in a component.
 */
export type ProjectIconColor =
  | 'neutral'
  | 'yellow'
  | 'orange'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'red'

export interface Workspace {
  id: string
  path: string
  name: string
  /** Activity metadata; the sidebar order is the array order, never this. */
  lastOpenedAt: number
  folders?: string[]
  /** Emoji the project wears instead of the folder icon. */
  icon?: string
  /** Tint of the project icon. */
  iconColor?: ProjectIconColor
}

export interface SessionMeta {
  /** Session id from the file header. */
  id: string
  /** Absolute path of the .jsonl session file. */
  file: string
  /** Working directory the session belongs to; empty for chats without a project. */
  cwd: string
  /** User-assigned session name, when present. */
  name?: string
  /** First user message on the active branch, used as the list preview. */
  preview: string
  /** ISO timestamp of the last activity. */
  updatedAt: number
  messageCount: number
  model?: string
}

/** A conversation renamed in the main process, pushed so the UI can re-read it. */
export interface SessionNameChange {
  file: string
  name: string
}

export type ScheduledTaskSchedule =
  | { kind: 'once'; at: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; time: string; weekday: number }

export type ScheduledTaskStatus = 'running' | 'completed' | 'error' | 'aborted'

export interface ScheduledTaskInput {
  title: string
  prompt: string
  workspaceId: string
  schedule: ScheduledTaskSchedule
}

export interface ScheduledTask extends ScheduledTaskInput {
  id: string
  enabled: boolean
  createdAt: number
  nextRunAt?: number
  lastRunAt?: number
  lastStatus?: ScheduledTaskStatus
  lastError?: string
  lastSessionFile?: string
}

/**
 * One hit of a full-text search over the conversations on disk.
 *
 * The snippet is a single line of text around the match, so the sidebar can
 * show why a conversation matched without loading the whole session.
 */
export interface SessionSearchHit {
  file: string
  sessionId: string
  /** Name the user gave the conversation, when it has one. */
  name?: string
  /** First user message on the active branch, used when there is no name. */
  preview: string
  cwd: string
  updatedAt: number
  role: 'user' | 'assistant'
  snippet: string
  /** Where the query sits inside `snippet`, in UTF-16 code units. */
  matchStart: number
  matchLength: number
  messageIndex: number
}

export interface TokenUsageMetrics {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
}

export interface PeriodUsage {
  period: 'today' | 'week' | 'month' | 'allTime'
  tokens: TokenUsageMetrics
  conversationsCount: number
  messageCount: number
}

export interface ModelUsageStat {
  model: string
  totalTokens: number
  input: number
  output: number
  messageCount: number
  cost: number
}

export interface DailyUsageStat {
  date: string
  totalTokens: number
  conversationsCount: number
  messageCount: number
  /** Token split for the day, when the aggregator has it. */
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  cost?: number
}

export interface AggregatedUsageStats {
  today: PeriodUsage
  week: PeriodUsage
  month: PeriodUsage
  allTime: PeriodUsage
  byModel: ModelUsageStat[]
  recentDays: DailyUsageStat[]
  heatmapDays?: DailyUsageStat[]
  updatedAt: number
}

/* ------------------------------------------------------------------ *
 * Git
 * ------------------------------------------------------------------ */

/** One entry of `git status --porcelain`, with its line counts when known. */
export interface GitFileStatus {
  path: string
  /** The path a rename or copy came from. */
  oldPath?: string
  /** Index (staged) status code, as git reports it: M, A, D, R, … */
  index: string
  /** Worktree status code. */
  worktree: string
  staged: boolean
  untracked: boolean
  added?: number
  removed?: number
}

export interface GitStatus {
  /** False when the open folder is not inside a git work tree. */
  isRepo: boolean
  /** Top level of the work tree. */
  root?: string
  branch?: string
  /** Short hash of HEAD, when the repository has a commit. */
  head?: string
  /** True when HEAD points at a commit rather than a branch. */
  detached: boolean
  /** Commits the branch is ahead of and behind its upstream. */
  ahead: number
  behind: number
  files: GitFileStatus[]
  staged: number
  unstaged: number
  /** No changes in the working tree and nothing untracked. */
  clean: boolean
}

export interface GitCommit {
  hash: string
  subject: string
  author: string
  /** Unix milliseconds. */
  date: number
}

export interface GitCommitResult {
  ok: boolean
  hash?: string
  error?: string
  /** Files that went into the commit. */
  files?: number
}

/** A unified diff of the working tree against HEAD. */
export interface GitPatch {
  text: string
  /** The patch (or one file in it) was too large to write whole. */
  truncated: boolean
}

/** One file of a commit, as `git show --numstat` reports it. */
export interface GitCommitFile {
  path: string
  /** The path before a rename. */
  oldPath?: string
  /** A, M, D, R or C. */
  status: string
  added: number
  removed: number
  binary: boolean
}

/** Everything the commit dialog shows when a commit is opened. */
export interface GitCommitDetail {
  hash: string
  /** The first parent, when the commit has one. */
  parentHash?: string
  subject: string
  author: string
  /** Unix milliseconds. */
  date: number
  body: string
  files: GitCommitFile[]
  /** `git show` output for the whole commit. */
  patch: string
  truncated: boolean
}

/** The two sides of one file at one commit. */
export interface GitCommitFileDiff {
  path: string
  oldText: string
  newText: string
  binary: boolean
  truncated: boolean
}

/** One local branch of the open repository. */
export interface GitBranch {
  name: string
  current: boolean
  /** Short hash of the branch tip. */
  tip?: string
  /** The subject of the tip commit. */
  subject?: string
  upstream?: string
}

/** One worktree of the open repository. */
export interface GitWorktree {
  path: string
  /** Branch checked out there, when it is not detached. */
  branch?: string
  current: boolean
  bare: boolean
  /** Number of changed and untracked files in that worktree. */
  dirty?: number
}

export interface GitBranches {
  isRepo?: boolean
  current?: string
  detached: boolean
  branches: GitBranch[]
  worktrees: GitWorktree[]
}

export interface GitWorktreeResult extends GitCommitResult {
  /** Absolute path of the new worktree. */
  path?: string
  branch?: string
}

/* ------------------------------------------------------------------ *
 * MCP configuration
 * ------------------------------------------------------------------ */

/** One MCP server, as the configuration files describe it. */
export interface McpServerInfo {
  name: string
  /** Where the entry comes from. `both` means a project override of a user server. */
  scope: 'user' | 'project' | 'both'
  transport: 'stdio' | 'http' | 'unknown'
  enabled: boolean
  description?: string
  command?: string
  args?: string[]
  url?: string
  timeout?: number
  /** Names of the environment variables, never their values. */
  envKeys: string[]
  /** Names of the HTTP headers, never their values. */
  headerKeys: string[]
  /** The project entry changes only options of the user entry. */
  overrideOnly?: boolean
}

/** What the MCP dialog reads; it never connects to a server. */
export interface McpConfig {
  userPath: string
  projectPath: string
  userExists: boolean
  projectExists: boolean
  /** Project configuration is present but is not loaded because trust is off. */
  projectIgnored: boolean
  servers: McpServerInfo[]
  /** Problems reading or parsing one of the files. */
  errors: string[]
}

/**
 * The two sides of one working-tree file, for the review tab.
 *
 * The renderer turns them into a line diff with the same builder the thread
 * uses, so a review looks exactly like an inline diff.
 */
export interface GitFileDiff {
  path: string
  /** Porcelain status of the file: two letters, or `??` when untracked. */
  status: string
  untracked: boolean
  /** Content at HEAD — empty for a file that was just created. */
  oldText: string
  /** Content in the working tree — empty for a deleted file. */
  newText: string
  binary: boolean
  /** One of the sides was too large to read whole. */
  truncated: boolean
  error?: string
}

export type ThemePreference = 'dark' | 'light' | 'system'
export type AppLanguage = 'en' | 'zh-CN'
export type PermissionMode = 'ask' | 'auto' | 'full'
/**
 * A conversation's task mode. Plan explores without writing and submits its
 * plan for approval; Goal keeps working until the goal is done or blocked;
 * Subagent makes the model delegate self-contained work to isolated children;
 * Plugin makes it build or modify a Pi extension.
 * Computer Use is not a mode: it is the `computerUse` setting.
 */
export type AgentMode = 'default' | 'goal' | 'plan' | 'subagent' | 'plugin'

export type SubagentTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'aborted' | 'timed_out'

/** Progress published in the subagent tool's result details. */
export interface SubagentTaskProgress {
  task: string
  /** Short display name; the tree falls back to the full briefing for old sessions. */
  label?: string
  cwd: string
  status: SubagentTaskStatus
  model?: string
  activity?: string
  toolName?: string
  /** Bounded tail of the child's live answer text while it is streaming. */
  progressText?: string
  startedAt?: number
  finishedAt?: number
  output?: string
  errorMessage?: string
  /** The child's transcript, captured from its JSON event stream. */
  messages?: AgentMessage[]
  /** True when older transcript messages were dropped to keep progress bounded. */
  messagesTruncated?: boolean
}

export interface ToolApproval {
  toolName: string
  input: Record<string, unknown>
  /** Pi's source classification; only built-in tools may use automatic approval. */
  toolSource?: string
  /** Child working directory when approval is relayed from a subagent. */
  cwd?: string
}

export interface AppSettings {
  workspaces: Workspace[]
  /**
   * Display order of every project row, including folders only known from
   * sessions. This is the sidebar order; selecting a project never changes it.
   */
  projectOrder?: string[]
  /** Null explicitly selects working without a project. */
  activeWorkspaceId?: string | null
  /** Session files the user pinned to the top of the sidebar. */
  pinnedSessions?: string[]
  /** Session files the user archived. They leave the sidebar and live in Settings. */
  archivedSessions?: string[]
  /**
   * Project paths the user removed from the sidebar. Conversations on disk
   * would otherwise put the folder back. A project that is opened again is
   * registered and shows up despite being listed here.
   */
  hiddenProjects?: string[]
  /** The conversation that was open in a project, by project path. */
  lastSessions?: Record<string, string>
  /** Absolute path to a custom `pi` executable or CLI script. */
  piPath?: string
  model?: string
  provider?: string
  thinkingLevel?: string
  /** User instructions appended to Pi's system prompt when the runtime starts. */
  customInstructions?: string
  /** Inject memories learned from earlier conversations into new sessions. */
  memoriesEnabled?: boolean
  /** Let Pi learn durable memories from finished conversations in the background. */
  memoryGeneration?: boolean
  /** Keep conversations that used MCP, web search, computer use or subagents out of memory. */
  memorySkipExternalContext?: boolean
  /** Model for memory extraction; empty uses the model of the conversation being learned from. */
  memoryModel?: string
  /** Approval policy for agent tool calls, independent of project trust. */
  permissionMode?: PermissionMode
  theme: ThemePreference
  themePreset?: string
  themeTone?: string
  accentColor?: string
  customBg?: string
  customFg?: string
  fontFamily?: string
  language: AppLanguage
  fontScale: number
  /** Show diffs side by side instead of unified. */
  diffSplit: boolean
  /** Width of the inspector panel in pixels. */
  drawerWidth: number
  /** Width of the sidebar in pixels. */
  sidebarWidth?: number
  /** Height of the terminal drawer in pixels. */
  terminalHeight?: number
  /** Automatically accept the working directory of new workspaces. */
  trustProject: boolean
  /** Send a system notification when a background turn finishes or needs input. */
  desktopNotifications?: boolean
  /** Default storage location for chats outside workspaces. */
  externalChatFolder?: string
  /** Previous custom chat folders kept available for existing conversations. */
  externalChatFolderHistory?: string[]
  /** Default location to open files and folders: 'vscode' | 'cursor' | 'windsurf' | 'system'. */
  defaultFileOpener?: string
  /** Agent environment on Windows: 'windows' | 'wsl'. */
  agentEnvironment?: string
  /** Integrated terminal shell: 'powershell' | 'cmd' | 'gitbash' | 'wsl'. */
  terminalShell?: string
  /** Compact older local chat history. */
  compactChatHistory?: boolean
  /** Allow using installed plugins. */
  pluginsEnabled?: boolean
  /** Plain text editor mode in composer. */
  plainTextEditor?: boolean
  /** Show context window usage ring/indicator. */
  showContextUsage?: boolean
  /** Send shortcut key: 'enter' (Enter to send) or 'ctrlEnter' (Ctrl+Enter to send). */
  sendShortcut?: 'enter' | 'ctrlEnter'
  /**
   * Rebound app shortcuts, keyed by the id in `lib/shortcuts.ts`. A chord is
   * the display names of its keys in canonical order (`['Ctrl','Shift','P']`);
   * an id that is absent keeps the built-in chord.
   */
  shortcutBindings?: Record<string, string[]>
  /** Follow-up handling method: 'queue' or 'steer'. */
  followUpMode?: 'queue' | 'steer'
  /**
   * Let the agent see and operate this Windows desktop.
   * Off until the user turns it on in Settings. Plan Mode never receives it.
   */
  computerUse?: boolean
  /**
   * Start a brand-new conversation in Plan Mode. Only a session Pi has never
   * written gets the default: a resumed one keeps the mode it stored itself.
   */
  defaultPlanMode?: boolean
  /**
   * The model a spawned subagent runs on. Empty follows the conversation's own
   * model, which is how subagents behaved before this setting existed.
   */
  subagentModel?: string
  /** Provider of `subagentModel`, kept the way `model` and `provider` are kept. */
  subagentProvider?: string
  /** Reasoning effort for a spawned subagent. Empty follows the conversation. */
  subagentThinking?: string
  /** Reference a pasted picture in the message, not only attach it. */
  pasteMentions?: boolean
  /** Fold a settled turn's working process so the answer is what stays on screen. */
  autoFoldProcess?: boolean
  /** Gather a run of consecutive tool calls into one summary line. */
  toolCallSummary?: boolean
  /** Name a new conversation from its first exchange with a throwaway model call. */
  autoTitle?: boolean
  /** Automatically download available application and service updates. */
  automaticUpdates?: boolean
  /**
   * Closing the window hides the app in the system tray instead of quitting.
   * Off leaves the close button as a quit, which is how the app behaved before
   * the switch existed.
   */
  trayPersistent?: boolean
}

export interface PiLaunchInfo {
  source: 'custom' | 'bundled' | 'path' | 'none'
  command?: string
  args?: string[]
  display: string
  version?: string
}

export interface AppInfo {
  version: string
  electron: string
  node: string
  platform: string
  isPackaged: boolean
  pi: PiLaunchInfo
  sessionRoot: string
  /**
   * A theme forced for this run by a development flag. It only changes what
   * is rendered; the stored setting stays as the user left it.
   */
  forcedTheme?: 'light' | 'dark' | 'system'
}

export interface AuthStatus {
  provider?: string
  ready: boolean
  state: 'ready' | 'not_ready' | 'invalid' | 'unknown'
  detail?: string
}

export interface VersionItemStatus {
  current: string
  latest?: string
  hasUpdate: boolean
  error?: string
}

export interface VersionCheckResult {
  app: VersionItemStatus
  piCli: VersionItemStatus
}

/** Progress of the development Pi CLI upgrade while npm is running. */
export interface PiCliUpgradeProgress {
  stage: 'preparing' | 'downloading' | 'installing'
  /** Monotonic percentage for the bar; capped below 100 until npm exits. */
  percent: number
}

export interface UpgradeResult {
  success: boolean
  version?: string
  error?: string
}

/* ------------------------------------------------------------------ *
 * Memory
 * ------------------------------------------------------------------ */

/** What a memory is about. The kind only groups the summary; all kinds are facts. */
export type MemoryKind = 'preference' | 'knowledge' | 'failure' | 'environment'

/** Global memories apply everywhere; project memories apply to one working folder. */
export type MemoryScope = 'global' | 'project'

export interface MemoryEntry {
  id: string
  scope: MemoryScope
  kind: MemoryKind
  /** One durable fact, kept short so the injected summary stays cheap. */
  text: string
  /** Working folder for a project memory. Undefined for a global memory. */
  projectPath?: string
  projectName?: string
  /** Session file this entry was learned from. */
  source?: string
  createdAt: number
  updatedAt: number
}

/** What the Memory settings page and the composer-facing state need. */
export interface MemoryState {
  /** Absolute path of the memory directory, so the UI can open it. */
  root: string
  /** The full summary markdown stored on disk (all projects). */
  summary: string
  entries: MemoryEntry[]
  /** When the memory store was last changed. */
  updatedAt?: number
  /** Sessions waiting for their background extraction. */
  pending: number
  /** True while an extraction or consolidation is running. */
  generating: boolean
  lastError?: string
}

export interface MemoryGenerateOptions {
  /** Learn from this session file. Omit to scan recent conversations. */
  sessionFile?: string
  /** How many recent conversations to scan when sessionFile is omitted. Defaults to 3. */
  limit?: number
}

export interface MemoryGenerateResult {
  ok: boolean
  /** New entries added across all sessions in this run. */
  added: number
  /** Why nothing was learned, when that is a normal outcome. */
  skipped?: string
  error?: string
}

/* ------------------------------------------------------------------ *
 * Renderer bridge
 * ------------------------------------------------------------------ */

/** A file chosen for the composer. Pictures are inlined; other files stay as paths. */
export type PickedFile =
  | { kind: 'image'; data: string; mimeType: string }
  | { kind: 'path'; path: string }

export interface RemoteAccessDevice {
  id: string
  name: string
  pairedAt: number
}

export interface RemoteAccessStatus {
  enabled: boolean
  urls: string[]
  pairingUrl?: string
  pairingExpiresAt?: number
  devices: RemoteAccessDevice[]
  error?: string
}

export interface RemoteWorkspace {
  id: string
  name: string
  icon?: string
  iconColor?: ProjectIconColor
}

export interface RemoteSession {
  id: string
  name?: string
  preview: string
  updatedAt: number
  messageCount: number
  model?: string
  isRunning: boolean
}

export interface PiDesktopBridge {
  modelCatalog: {
    /** Supported effort levels for a configured Pi model, without starting a conversation. */
    thinkingLevels(provider: string, modelId: string): Promise<string[]>
  }
  providers: {
    list(): Promise<ProviderProfile[]>
    /** Effective API key for one provider. Empty when there is nothing literal to show. */
    savedKey(id: string): Promise<string>
    models(connection: ProviderConnection): Promise<ProviderModel[]>
    probe(connection: ProviderConnection, modelId?: string): Promise<ProviderProbeResult>
    save(input: SaveProviderInput, sessionKey?: string): Promise<{ provider: ProviderProfile; settings: AppSettings; applied: boolean; applyError?: string }>
    remove(id: string): Promise<{ settings: AppSettings }>
  }
  app: {
    info(options?: { includePiVersion?: boolean }): Promise<AppInfo>
    /** Let the main process show the window after the initial UI is ready. */
    startupReady(): void
    /**
     * Sync the native window controls with the current theme. `colors` carries
     * the chrome background and glyph colour the renderer actually resolved, so
     * a custom background keeps the control strip on the same colour as the
     * menu bar instead of drifting back to a hard-coded default.
     */
    setTheme(theme: 'dark' | 'light', colors?: { color: string; symbolColor: string }): Promise<void>
    /** Query the font families installed on the operating system. */
    getSystemFonts(): Promise<string[]>
    /**
     * The platform's colour emoji font as bytes, so the renderer can register
     * it with the FontFace API even where the OS font registry has no path.
     */
    emojiFont(): Promise<Uint8Array | null>
    /** Check for updates for the application and Pi CLI. */
    checkUpdate(): Promise<VersionCheckResult>
    /** Upgrade the development Pi CLI; packaged builds use the bundled version. */
    upgradePiCli(): Promise<UpgradeResult>
    /** Progress of the running Pi CLI upgrade. */
    onPiCliUpgradeProgress(handler: (progress: PiCliUpgradeProgress) => void): () => void
    /** Open the latest Pi Desktop release page for a manual update. */
    openReleasePage(): Promise<UpgradeResult>
  }
  dialog: {
    pickDirectory(defaultPath?: string): Promise<string | null>
    /** One dialog for every file. Pictures come back inline; other files as paths. */
    pickFiles(defaultPath?: string): Promise<PickedFile[]>
  }
  settings: {
    get(): Promise<AppSettings>
    patch(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  remote: {
    status(): Promise<RemoteAccessStatus>
    setEnabled(enabled: boolean): Promise<RemoteAccessStatus>
    newPairing(): Promise<RemoteAccessStatus>
    revokeDevice(id: string): Promise<RemoteAccessStatus>
  }
  scheduledTasks: {
    list(): Promise<ScheduledTask[]>
    create(input: ScheduledTaskInput): Promise<ScheduledTask[]>
    update(id: string, input: ScheduledTaskInput): Promise<ScheduledTask[]>
    setEnabled(id: string, enabled: boolean): Promise<ScheduledTask[]>
    remove(id: string): Promise<ScheduledTask[]>
    runNow(id: string): Promise<ScheduledTask[]>
    onChanged(handler: (tasks: ScheduledTask[]) => void): () => void
  }
  memory: {
    /** Stored memories, the injected summary and background status. */
    get(): Promise<MemoryState>
    /** Delete one memory entry. */
    remove(id: string): Promise<MemoryState>
    /** Delete every memory entry and the per-session learning ledger. */
    clear(): Promise<MemoryState>
    /** Learn from one session, or from the most recent unprocessed sessions. */
    generate(options?: MemoryGenerateOptions): Promise<MemoryGenerateResult>
    /** Open the memory folder in the system file manager. */
    openFolder(): Promise<void>
    /** Fires after a background extraction or a manual change. */
    onChanged(handler: (state: MemoryState) => void): () => void
  }
  workspaces: {
    pick(): Promise<Workspace | null>
    remove(id?: string, hiddenPath?: string): Promise<AppSettings>
    /** Register a project by path and make it the active one. */
    add(path: string): Promise<{ workspace: Workspace; settings: AppSettings }>
  }
  sessions: {
    list(cwd?: string): Promise<SessionMeta[]>
    /** Move a session file to the OS trash. Returns false when it fails. */
    remove(file: string): Promise<boolean>
    /** Active-branch messages from disk. Does not start Pi. */
    hydrate(file: string): Promise<AgentMessage[]>
    /** Name a conversation. A hot one is renamed in its own process. */
    rename(file: string, name: string): Promise<boolean>
    /** Search the text of every conversation on disk. */
    search(query: string, limit?: number): Promise<SessionSearchHit[]>
    /** Aggregate token consumption and conversation records across all sessions. */
    usageStats(): Promise<AggregatedUsageStats>
    /** A conversation was renamed in the main process (auto-title, hot or cold). */
    onChanged(handler: (change: SessionNameChange) => void): () => void
  }
  terminal: {
    /** Start a real PTY shell for the open workspace. */
    create(options: TerminalCreateOptions): Promise<TerminalSessionInfo>
    write(id: string, data: string): Promise<void>
    resize(id: string, cols: number, rows: number): Promise<void>
    kill(id: string): Promise<void>
    acknowledgeOutput(id: string, sequence: number): void
    onData(handler: (payload: TerminalDataPayload) => void): () => void
    onExit(handler: (payload: TerminalExitPayload) => void): () => void
  }
  runtime: {
    start(options: RuntimeStartOptions): Promise<{ ok: boolean; error?: string }>
    /** Start Pi for one conversation if it is not already running. */
    ensure(options: RuntimeEnsureOptions): Promise<{ ok: boolean; error?: string }>
    /** Discover Skills for a cold composer without starting its conversation runtime. */
    listSkillCommands(): Promise<PiCommand[]>
    /** True when that conversation has a live process. */
    has(sessionKey: string): Promise<boolean>
    stop(sessionKey: string): Promise<void>
    /** Stop every process whose cwd is this workspace. */
    stopCwd(cwd: string): Promise<void>
    request<T = unknown>(
      command: string,
      payload?: Record<string, unknown>,
      timeoutMs?: number,
      trace?: RpcTraceHint,
      sessionKey?: string
    ): Promise<T>
    /** Answer a blocking extension dialog so the agent can continue. */
    respondUi(id: string, response: ExtensionUiResponse, sessionKey?: string): Promise<void>
    onEvent(handler: (event: RuntimeEvent) => void): () => void
    onStatus(handler: (status: RuntimeStatusEvent) => void): () => void
    onRekey(handler: (change: RuntimeRekey) => void): () => void
  }
  auth: {
    check(provider?: string): Promise<AuthStatus>
  }
  mcp: {
    /** The MCP servers the configuration files describe for the open project. */
    read(): Promise<McpConfig>
    setEnabled(name: string, enabled: boolean): Promise<MarketplaceActionResult>
    remove(name: string): Promise<MarketplaceActionResult>
  }
  marketplace: {
    /** Curated GitHub snapshot, with a cached refresh layered on top when one exists. */
    list(): Promise<MarketplaceSnapshot>
    /** Query GitHub for current star counts and merge them into the snapshot. */
    refresh(): Promise<MarketplaceSnapshot>
    /** Ids (`owner/repo`) of marketplace entries already installed in Pi. */
    installed(): Promise<string[]>
    /** Install one entry through `pi install`; `id` must exist in the snapshot. */
    install(id: string): Promise<MarketplaceInstallResult>
    /** Install an arbitrary npm package by name through `pi install npm:<name>`. */
    installNpm(packageName: string): Promise<MarketplaceInstallResult>
    /** Installed packages that can be switched or removed. */
    managed(): Promise<ManagedPackage[]>
    setPackageEnabled(id: string, enabled: boolean): Promise<MarketplaceActionResult>
    removePackage(id: string): Promise<MarketplaceActionResult>
    /** Create a local plugin or skill scaffold under the Pi agent directory. */
    createResource(input: CreateResourceInput): Promise<MarketplaceActionResult>
    /** Import and install a GitHub repository as a Pi package. */
    installGitRepository(repository: string): Promise<MarketplaceInstallResult>
  }
  git: {
    /** Branch, ahead/behind and the working tree of the open workspace. */
    status(): Promise<GitStatus>
    log(limit?: number): Promise<GitCommit[]>
    /**
     * Commit the staged files, or — with `includeUnstaged` — stage everything
     * first and commit the whole working tree.
     */
    commit(message: string, includeUnstaged?: boolean): Promise<GitCommitResult>
    /** Both sides of one working-tree file, for the review tab. */
    fileDiff(file: string): Promise<GitFileDiff>
    /** Unified patch of the whole working tree, or of one file. */
    patch(file?: string): Promise<GitPatch>
    /** Metadata, file list and patch of one commit. */
    commitDetail(hash: string): Promise<GitCommitDetail | null>
    /** Both sides of one file as they were in one commit. */
    commitFileDiff(hash: string, file: string): Promise<GitCommitFileDiff | null>
    /** Both sides of one file between a commit and the file on disk. */
    commitWorktreeDiff(hash: string, file: string): Promise<GitCommitFileDiff | null>
    /** Apply a unified patch to the working tree, optionally in reverse. */
    applyPatch(patch: string, reverse?: boolean): Promise<GitCommitResult>
    /** Local branches and worktrees of the open repository. */
    branches(): Promise<GitBranches>
    switchBranch(name: string): Promise<GitCommitResult>
    createBranch(name: string, checkout?: boolean): Promise<GitCommitResult>
    /** Add a worktree, creating its branch when `createBranch` is set. */
    addWorktree(
      path: string,
      branch: string,
      createBranch?: boolean
    ): Promise<GitWorktreeResult>
    /** Remove a registered worktree that is not the one that is open. */
    removeWorktree(path: string): Promise<GitCommitResult>
    /** Discard the working-tree changes of a tracked file. */
    revertFile(file: string): Promise<GitCommitResult>
    /** Move one file into (or out of) the index. */
    stageFile(file: string): Promise<GitCommitResult>
    unstageFile(file: string): Promise<GitCommitResult>
    stageAll(): Promise<GitCommitResult>
    unstageAll(): Promise<GitCommitResult>
    /** Push the current branch to its upstream remote. */
    push(): Promise<GitCommitResult>
    /** Pull changes from the upstream remote into the current branch. */
    pull(): Promise<GitCommitResult>
  }
  shell: {
    /** Data URLs of the installed editors' and shells' own icons. */
    nativeIcons(): Promise<Record<string, string>>
    openPath(target: string): Promise<string>
    openInExplorer(target: string): Promise<string>
    openExternal(url: string): Promise<void>
  }
  fs: {
    /** List a directory inside the open workspace. */
    list(dir: string): Promise<FileListResult>
    /** Read a text file inside the open workspace. */
    read(file: string): Promise<FileContent | null>
    /** Find files inside the open workspace whose name contains the query. */
    search(query: string, limit?: number, scope?: FileSearchScope): Promise<FileSearchResult>
    /** Find text inside the files of the open workspace. */
    searchText(query: string, limit?: number): Promise<TextSearchResult>
    /** Pictures found in one bounded walk of the open workspace. */
    listImages(): Promise<ImageListResult>
    /** Show a file in the file manager of the operating system. */
    reveal(file: string): Promise<void>
    /**
     * Write a picture pasted into the composer into the folder the conversation
     * runs in, so the reference it becomes resolves like a picked file. `root`
     * is that folder and `path` the file written. `null` when the type is not a
     * picture the agent can read, or when the folder refused the write — the
     * composer then keeps the picture as an attachment only.
     */
    savePastedImage(
      data: string,
      mimeType: string
    ): Promise<{ path: string; root: string } | null>
    /** Write a picture the model produced to a file the user picks. */
    saveImage(data: string, mimeType: string): Promise<string | null>
    /** Resolve the filesystem path of a dropped File object. */
    pathForFile(file: File): string
    /** A picture of the open project as a data URL, for the image viewer. */
    readImageDataUrl(file: string, maxBytes?: number): Promise<string | null>
  }
}

export interface FileEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  size?: number
}

export interface ImageListResult {
  entries: FileEntry[]
  /** True when result, depth or scan limits may have omitted more pictures. */
  truncated: boolean
}

export interface FileListResult {
  entries: FileEntry[]
  /** True when limits or a read error may have omitted directory entries. */
  truncated: boolean
}

export interface FileSearchResult {
  entries: FileEntry[]
  /** True when the result, depth, or scan limit may have omitted matching files. */
  truncated: boolean
}

export type FileSearchScope = 'composer-mention' | 'file-tree'

export interface FileContent {
  path: string
  content: string
  truncated: boolean
  /** Size of the file on disk, in bytes. */
  size?: number
  language: string
}

/**
 * One match of a text search inside the files of a project.
 *
 * `matchStart` and `matchLength` point into `preview`, not into the file, so
 * the renderer can highlight the match without reading the line again.
 */
export interface TextSearchHit {
  /** Absolute path of the file. */
  path: string
  /** 1-based line of the match in the file. */
  line: number
  /** 1-based column of the match in that line. */
  column: number
  /** The line around the match, trimmed and shortened to fit one row. */
  preview: string
  matchStart: number
  matchLength: number
}

export interface TextSearchResult {
  hits: TextSearchHit[]
  /** True when the result, depth, file-count, or byte limit may have omitted matches. */
  truncated: boolean
}

/**
 * Who asked the runtime to start or to send a command.
 *
 * This never reaches Pi. It exists so a development trace can tell a sidebar
 * click from a prompt, a project switch, or a restore without recording the
 * message that was sent.
 */
export interface RpcTraceHint {
  sourceAction: string
  /**
   * Desktop UI identity for the view that issued the command.
   * Today that is the JSONL path (`activeSessionFile`), not Pi's `sessionId`.
   */
  uiSessionId?: string
}

export interface RuntimeStartOptions {
  /** Empty uses the app's working directory for chats without a project. */
  cwd: string
  /** Resume a specific session file instead of starting a new one. */
  sessionFile?: string
  model?: string
  thinkingLevel?: string
  /** App-level instructions appended to the system prompt for this process. */
  customInstructions?: string
  /** Diagnostic only. Stripped before the process is spawned. */
  trace?: RpcTraceHint
}

/** Start the process for one conversation. Does not stop any other conversation. */
export interface RuntimeEnsureOptions extends RuntimeStartOptions {
  /** JSONL path, or `draft:…` until Pi has written a file. */
  sessionKey: string
}

export interface RuntimeStatus {
  phase: 'stopped' | 'starting' | 'ready' | 'error'
  cwd?: string
  error?: string
  sessionFile?: string
  sessionId?: string
}

/* ------------------------------------------------------------------ *
 * Terminal (real PTY)
 * ------------------------------------------------------------------ */

export const MAX_TERMINAL_SESSIONS = 12

export interface TerminalCreateOptions {
  cols: number
  rows: number
  /** The working directory; defaults to the open workspace. */
  cwd?: string
  /** A terminalShell setting value: powershell, cmd, gitbash or wsl. */
  shell?: string
}

export interface TerminalSessionInfo {
  id: string
  pid: number
  shell: string
  cwd: string
}

export interface TerminalDataPayload {
  id: string
  data: string
  sequence: number
}

export interface TerminalExitPayload {
  id: string
  exitCode: number
  signal?: number
}
