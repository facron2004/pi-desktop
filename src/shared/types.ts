/**
 * Shared type contracts between the Electron main process, the preload bridge
 * and the renderer. Everything crossing the IPC boundary is described here.
 */

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

export interface Workspace {
  id: string
  path: string
  name: string
  lastOpenedAt: number
}

export interface SessionMeta {
  /** Session id from the file header. */
  id: string
  /** Absolute path of the .jsonl session file. */
  file: string
  /** Working directory the session belongs to. */
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

/* ------------------------------------------------------------------ *
 * Git
 * ------------------------------------------------------------------ */

/** One entry of `git status --porcelain`, with its line counts when known. */
export interface GitFileStatus {
  path: string
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

export interface AppSettings {
  workspaces: Workspace[]
  activeWorkspaceId?: string
  /** Session files the user pinned to the top of the sidebar. */
  pinnedSessions?: string[]
  /** The conversation that was open in a project, by project path. */
  lastSessions?: Record<string, string>
  /** Absolute path to a custom `pi` executable or CLI script. */
  piPath?: string
  model?: string
  provider?: string
  thinkingLevel?: string
  /** User instructions appended to Pi's system prompt when the runtime starts. */
  customInstructions?: string
  theme: ThemePreference
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

/* ------------------------------------------------------------------ *
 * Renderer bridge
 * ------------------------------------------------------------------ */

export interface PiDesktopBridge {
  app: {
    info(): Promise<AppInfo>
    /** Sync the native window controls with the current theme. */
    setTheme(theme: 'dark' | 'light'): Promise<void>
  }
  settings: {
    get(): Promise<AppSettings>
    patch(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  workspaces: {
    pick(): Promise<Workspace | null>
    remove(id: string): Promise<AppSettings>
    /** Register a project by path and make it the active one. */
    add(path: string): Promise<{ workspace: Workspace; settings: AppSettings }>
  }
  sessions: {
    list(cwd?: string): Promise<SessionMeta[]>
    /** Move a session file to the OS trash. Returns false when it fails. */
    remove(file: string): Promise<boolean>
    /** Search the text of every conversation on disk. */
    search(query: string, limit?: number): Promise<SessionSearchHit[]>
  }
  runtime: {
    start(options: RuntimeStartOptions): Promise<{ ok: boolean; error?: string }>
    stop(): Promise<void>
    request<T = unknown>(
      command: string,
      payload?: Record<string, unknown>,
      timeoutMs?: number
    ): Promise<T>
    /** Answer a blocking extension dialog so the agent can continue. */
    respondUi(id: string, response: ExtensionUiResponse): Promise<void>
    onEvent(handler: (event: PiEvent) => void): () => void
    onStatus(handler: (status: RuntimeStatus) => void): () => void
  }
  auth: {
    check(provider?: string): Promise<AuthStatus>
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
    /** Discard the working-tree changes of a tracked file. */
    revertFile(file: string): Promise<GitCommitResult>
    /** Move one file into (or out of) the index. */
    stageFile(file: string): Promise<GitCommitResult>
    unstageFile(file: string): Promise<GitCommitResult>
    stageAll(): Promise<GitCommitResult>
    unstageAll(): Promise<GitCommitResult>
  }
  shell: {
    openPath(target: string): Promise<string>
    openExternal(url: string): Promise<void>
  }
  fs: {
    /** List a directory inside the open workspace. */
    list(dir: string): Promise<FileEntry[]>
    /** Read a text file inside the open workspace. */
    read(file: string): Promise<FileContent | null>
    /** Find files inside the open workspace whose name contains the query. */
    search(query: string, limit?: number): Promise<FileEntry[]>
    /** Show a file in the file manager of the operating system. */
    reveal(file: string): Promise<void>
    /** Write a picture the model produced to a file the user picks. */
    saveImage(data: string, mimeType: string): Promise<string | null>
  }
}

export interface FileEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  size?: number
}

export interface FileContent {
  path: string
  content: string
  truncated: boolean
  /** Size of the file on disk, in bytes. */
  size?: number
  language: string
}

export interface RuntimeStartOptions {
  cwd: string
  /** Resume a specific session file instead of starting a new one. */
  sessionFile?: string
  model?: string
  thinkingLevel?: string
  /** App-level instructions appended to the system prompt for this process. */
  customInstructions?: string
}

export interface RuntimeStatus {
  phase: 'stopped' | 'starting' | 'ready' | 'error'
  cwd?: string
  error?: string
  sessionFile?: string
  sessionId?: string
}
