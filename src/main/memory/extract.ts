import { app } from 'electron'
import type { AgentMessage, AppSettings, SessionMeta } from '@shared/types'
import { runPiCli } from '../pi/cli'
import { getSessionMeta, readSessionMessages } from '../sessions'
import {
  buildMemoryPrompt,
  buildTranscript,
  parseMemoryResponse,
  shouldLearnFromSession
} from './prompt'
import type { MemoryCandidate, MemoryStore } from './store'

export interface ExtractionRunArgs {
  prompt: string
  cwd: string
  model?: string
  timeoutMs: number
}

export type ExtractionRunner = (
  args: ExtractionRunArgs
) => Promise<{ code: number | null; stdout: string; stderr: string }>

export interface ExtractionDeps {
  readMessages?: (file: string) => Promise<AgentMessage[]>
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
    timeoutMs: args.timeoutMs
  })
}

export async function extractFromSession(
  store: MemoryStore,
  sessionFile: string,
  options: { cwd?: string; settings?: AppSettings; deps?: ExtractionDeps } = {}
): Promise<ExtractionOutcome> {
  const deps = options.deps ?? {}
  const settings = options.settings
  const readMessages = deps.readMessages ?? readSessionMessages
  const getMeta = deps.getMeta ?? getSessionMeta
  let meta: SessionMeta | null | undefined
  try {
    meta = await getMeta(sessionFile)
  } catch {
    meta = null
  }
  const cwd = options.cwd ?? meta?.cwd
  if (!cwd) return { added: 0, skipped: 'Could not determine the conversation folder' }

  const messages = await readMessages(sessionFile)
  const transcript = buildTranscript(messages)
  const enough = shouldLearnFromSession(transcript)
  if (!enough.ok) return { added: 0, skipped: enough.reason }
  if (options.settings?.memorySkipExternalContext !== false && transcript.externalContext) {
    return { added: 0, skipped: 'External-context conversation' }
  }

  const projectName = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd
  const prompt = buildMemoryPrompt({
    cwd,
    projectName,
    transcript: transcript.text,
    existingSummary: store.summaryFor(cwd)
  })
  const runner = deps.run ?? defaultRunner
  const result = await runner({
    prompt,
    cwd: deps.userDataDir ?? app.getPath('userData'),
    model: settings?.memoryModel?.trim() || settings?.model || meta?.model,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  })
  const raw = result.stdout.trim()
  if (result.code !== 0 || !raw) {
    return {
      added: 0,
      error: result.stderr.trim() || 'Memory extraction failed'
    }
  }

  const candidates = parseMemoryResponse(raw).map((candidate) => ({
    ...candidate,
    projectPath: candidate.scope === 'project' ? cwd : undefined,
    projectName: candidate.scope === 'project' ? projectName : undefined,
    source: sessionFile
  }))
  store.writeRolloutSummary(sessionFile, { cwd, candidates, raw })
  if (!candidates.length) return { added: 0, skipped: 'No durable memories found', candidates }
  const merged = store.merge(candidates)
  return { added: merged.added, candidates }
}
