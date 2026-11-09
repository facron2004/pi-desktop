import { app } from 'electron'
import type { AgentMessage, AppSettings, MemoryScope, SessionMeta } from '@shared/types'
import { runPiCli } from '../pi/cli'
import {
  openSessionFile,
  parseSession,
  readSessionConversation,
  type SessionConversationRead
} from '../sessions'
import {
  buildMemoryPrompt,
  buildTranscript,
  hasExplicitGlobalScopeEvidence,
  parseMemoryResponse,
  shouldLearnFromSession
} from './prompt'
import type { MemoryCandidate, MemoryStore } from './store'

export interface ExtractionRunArgs {
  prompt: string
  cwd: string
  model?: string
  timeoutMs: number
  signal?: AbortSignal
}

export type ExtractionRunner = (
  args: ExtractionRunArgs
) => Promise<{ code: number | null; stdout: string; stderr: string }>

export interface ExtractionDeps {
  readMessages?: (file: string) => Promise<AgentMessage[]>
  readConversation?: (file: string) => Promise<SessionConversationRead>
  getMeta?: (file: string) => Promise<SessionMeta | null>
  run?: ExtractionRunner
  /** Isolated directory for the throwaway Pi process. */
  userDataDir?: string
  timeoutMs?: number
}

export interface ExtractionOutcome {
  added: number
  skipped?: string
  error?: string
  candidates?: MemoryCandidate[]
}

const DEFAULT_TIMEOUT_MS = 180_000

/**
 * A throwaway Pi process, not the conversation's process: extracting memory
 * must not append messages to the session or compete with the live run.
 * Extensions, skills, MCP and context files are off so the prompt is the only
 * input and a project's local configuration cannot influence the extractor.
 */
async function defaultRunner(args: ExtractionRunArgs): Promise<{
  code: number | null
  stdout: string
  stderr: string
}> {
  const cliArgs = [
    '--print',
    '--no-session',
    '--no-tools',
    '--no-extensions',
    '--no-skills',
    '--no-mcp',
    '--no-context-files',
    '--no-approve'
  ]
  if (args.model) cliArgs.push('--model', args.model)
  return runPiCli(cliArgs, {
    cwd: args.cwd,
    input: args.prompt,
    timeoutMs: args.timeoutMs,
    signal: args.signal
  })
}

export async function extractFromSession(
  store: MemoryStore,
  sessionFile: string,
  options: {
    cwd?: string
    settings?: AppSettings
    deps?: ExtractionDeps
    shouldCommit?: () => boolean
    storeGeneration?: number
    signal?: AbortSignal
  } = {}
): Promise<ExtractionOutcome> {
  const deps = options.deps ?? {}
  const settings = options.settings
  const storeGeneration = options.storeGeneration ?? store.generation()
  const opened = !deps.getMeta || (!deps.readMessages && !deps.readConversation)
    ? await openSessionFile(sessionFile)
    : null
  if ((!deps.getMeta || (!deps.readMessages && !deps.readConversation)) && !opened) {
    return { added: 0, skipped: "Conversation file is not in Pi's session store" }
  }

  let meta: SessionMeta | null | undefined
  let cwd: string | undefined
  let messages: AgentMessage[] = []
  let externalContext = false
  let contextChecked = true
  try {
    if (deps.getMeta) {
      try {
        meta = await deps.getMeta(sessionFile)
      } catch {
        meta = null
      }
    } else if (opened) {
      const stats = await opened.handle.stat()
      meta = await parseSession(opened.target, { size: stats.size, mtimeMs: stats.mtimeMs }, opened.handle)
    }
    cwd = options.cwd ?? meta?.cwd
    if (!cwd) return { added: 0, skipped: 'Could not determine the conversation folder' }

    if (deps.readConversation) {
      const conversation = await deps.readConversation(sessionFile)
      messages = conversation.messages
      externalContext = conversation.externalContext
      contextChecked = conversation.contextChecked !== false
    } else if (deps.readMessages) {
      messages = await deps.readMessages(sessionFile)
    } else if (opened) {
      const conversation = await readSessionConversation(opened.target, opened.handle)
      messages = conversation.messages
      externalContext = conversation.externalContext
      contextChecked = conversation.contextChecked
    }
  } finally {
    if (opened) await opened.handle.close().catch(() => {})
  }

  const transcript = buildTranscript(messages)
  const enough = shouldLearnFromSession(transcript)
  if (!enough.ok) return { added: 0, skipped: enough.reason }
  if (
    options.settings?.memorySkipExternalContext !== false &&
    (transcript.externalContext || externalContext)
  ) {
    return { added: 0, skipped: 'External-context conversation' }
  }
  if (options.settings?.memorySkipExternalContext !== false && !contextChecked) {
    return { added: 0, skipped: 'External-context status is unknown for this conversation' }
  }
  if (options.signal?.aborted || (options.shouldCommit && !options.shouldCommit())) {
    return { added: 0, skipped: 'Memory generation was cancelled' }
  }

  const projectName = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd
  const prompt = buildMemoryPrompt({
    cwd,
    projectName,
    transcript: transcript.text
  })
  const runner = deps.run ?? defaultRunner
  const result = await runner({
    prompt,
    cwd: deps.userDataDir ?? app.getPath('userData'),
    model: settings?.memoryModel?.trim() || settings?.model || meta?.model,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: options.signal
  })
  const raw = result.stdout.trim()
  if (result.code !== 0 || !raw) {
    return {
      added: 0,
      error: result.stderr.trim() || 'Memory extraction failed'
    }
  }
  const candidates = parseMemoryResponse(raw).map(({ scopeEvidence, ...candidate }) => {
    const scope: MemoryScope = candidate.scope === 'global' &&
      hasExplicitGlobalScopeEvidence(scopeEvidence, transcript.userMessages)
      ? 'global'
      : 'project'
    return {
      ...candidate,
      scope,
      projectPath: scope === 'project' ? cwd : undefined,
      projectName: scope === 'project' ? projectName : undefined,
      source: sessionFile
    }
  })
  const committed = await store.commitExtraction(
    sessionFile,
    { cwd, candidates, raw },
    storeGeneration,
    options.shouldCommit
  )
  if (!committed) return { added: 0, skipped: 'Memory generation was cancelled' }
  if (!candidates.length) return { added: 0, skipped: 'No durable memories found', candidates }
  return { added: committed.added, candidates }
}
