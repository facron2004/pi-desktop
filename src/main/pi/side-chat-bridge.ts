import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { createTwoFilesPatch } from 'diff'
import {
  MAX_SIDE_CHAT_REFERENCES,
  MAX_SIDE_CHAT_SNIPPET_CHARS,
  isSideSessionKey,
  type RuntimeRekey,
  type SideChatReference,
  type SideChatStagePromptInput,
  type SideChatTurnMetaPayload
} from '@shared/types'
import { readFileDiff, readStatus } from '../git'
import { decodeBoundedTextBuffer } from '../text-decode'
import { openWorkspaceFile } from '../workspace-files'
import { resolveSessionRoots } from '../sessions'
import type { SideChatBindingService } from '../side-chats'
import {
  MAX_INSPECT_OUTPUT_CHARS,
  type InspectMainConversationParams,
  type MainConversationMirror
} from './main-mirror'
import { canonicalSessionFile } from './session-file'
import type { SessionSupervisor } from './supervisor'

export interface InspectMainChangesParams {
  scope?: 'session' | 'worktree' | 'all'
  file?: string
  staged?: boolean
  offsetLines?: number
}

interface RegisteredRuntimeToken {
  sideOwnerId: string
  fallbackParentKey?: string
  fallbackCwd: string
}

interface StagedTurnRecord {
  input: SideChatStagePromptInput
  stagedAt: number
}

export interface SideChatBridgeServerOptions {
  mirror: MainConversationMirror
  bindings: SideChatBindingService
  supervisor?: SessionSupervisor
  getSessionRoots?: () => readonly string[]
}

const MAX_BRIDGE_REQUEST_BYTES = 256 * 1024
const DIFF_LINES_PER_PAGE = 300
const MAX_FALLBACK_FILE_BYTES = 512 * 1024

function normKey(key: string): string {
  return key.startsWith('draft:') ? key : canonicalSessionFile(key)
}

function normalizeRelativeFile(cwd: string, file: string): string {
  const trimmed = file.trim()
  if (!trimmed) return ''
  const resolved = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(cwd, trimmed)
  const rel = path.relative(path.resolve(cwd), resolved)
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return ''
  }
  return rel.replace(/\\/g, '/')
}

function safeTokenCompare(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > MAX_BRIDGE_REQUEST_BYTES) {
      throw new Error('Request payload exceeds maximum size.')
    }
    chunks.push(buf)
  }
  if (total === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {}
  }
  return parsed as Record<string, unknown>
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload, 'utf8'),
    'Cache-Control': 'no-store'
  })
  res.end(payload)
}

function sanitizeReferences(refs?: SideChatReference[]): SideChatReference[] | undefined {
  if (!Array.isArray(refs) || refs.length === 0) return undefined
  return refs.slice(0, MAX_SIDE_CHAT_REFERENCES).map((ref) => {
    if (ref.kind === 'selection') {
      return { ...ref, snippet: ref.snippet.slice(0, MAX_SIDE_CHAT_SNIPPET_CHARS) }
    }
    if (ref.kind === 'turn') {
      return { ...ref, preview: ref.preview.slice(0, MAX_SIDE_CHAT_SNIPPET_CHARS) }
    }
    if (ref.kind === 'tool') {
      return { ...ref, summary: ref.summary.slice(0, MAX_SIDE_CHAT_SNIPPET_CHARS) }
    }
    if (ref.kind === 'error') {
      return { ...ref, message: ref.message.slice(0, MAX_SIDE_CHAT_SNIPPET_CHARS) }
    }
    return {
      ...ref,
      ...(ref.snippet !== undefined ? { snippet: ref.snippet.slice(0, MAX_SIDE_CHAT_SNIPPET_CHARS) } : {})
    }
  })
}

async function readVerifiedWorkspacePreview(cwd: string, file: string): Promise<{ content: string; truncated: boolean; binary: boolean } | null> {
  // Non-negotiable #9: open via openWorkspaceFile and consume the exact same FileHandle
  const opened = await openWorkspaceFile(cwd, file)
  if (!opened) return null
  try {
    const stats = await opened.handle.stat({ bigint: true })
    if (!stats.isFile()) return null
    const truncated = stats.size > BigInt(MAX_FALLBACK_FILE_BYTES)
    const bytesToRead = Number(truncated ? BigInt(MAX_FALLBACK_FILE_BYTES) : stats.size)
    if (bytesToRead === 0) return { content: '', truncated: false, binary: false }
    const buffer = Buffer.allocUnsafe(bytesToRead)
    let totalRead = 0
    while (totalRead < bytesToRead) {
      const { bytesRead } = await opened.handle.read(buffer, totalRead, bytesToRead - totalRead, totalRead)
      if (bytesRead === 0) break
      totalRead += bytesRead
    }
    const slice = buffer.subarray(0, totalRead)
    if (slice.subarray(0, 8000).includes(0)) {
      return { content: '', truncated, binary: true }
    }
    return { content: decodeBoundedTextBuffer(slice), truncated, binary: false }
  } finally {
    await opened.handle.close().catch(() => {})
  }
}

export class SideChatBridgeServer {
  private readonly mirror: MainConversationMirror
  private readonly bindings: SideChatBindingService
  private supervisor?: SessionSupervisor
  private readonly getSessionRoots: () => readonly string[]
  private server: http.Server | null = null
  private listeningPromise: Promise<string> | null = null
  private baseUrl: string | null = null
  private readonly tokens = new Map<string, RegisteredRuntimeToken>()
  private readonly stagedPrompts = new Map<string, StagedTurnRecord>()
  private disposed = false

  constructor(options: SideChatBridgeServerOptions) {
    this.mirror = options.mirror
    this.bindings = options.bindings
    this.getSessionRoots = options.getSessionRoots ?? (() => resolveSessionRoots())
    if (options.supervisor) {
      this.attach(options.supervisor)
    }
  }

  attach(supervisor: SessionSupervisor): void {
    if (this.supervisor === supervisor) return
    if (this.supervisor) {
      this.supervisor.off('rekey', this.handleRekey)
    }
    this.supervisor = supervisor
    supervisor.on('rekey', this.handleRekey)
  }

  private readonly handleRekey = (change: RuntimeRekey): void => {
    const { from, to, replace } = change
    if (!from || !to || from === to) return

    if (isSideSessionKey(from) || isSideSessionKey(to)) {
      const fromKey = normKey(from)
      const toKey = normKey(to)
      for (const entry of this.tokens.values()) {
        if (normKey(entry.sideOwnerId) === fromKey) {
          entry.sideOwnerId = to
        }
      }
      const staged = this.stagedPrompts.get(fromKey)
      if (staged) {
        this.stagedPrompts.delete(fromKey)
        this.stagedPrompts.set(toKey, {
          ...staged,
          input: { ...staged.input, sideSessionKey: to }
        })
      }
      return
    }

    // Main conversation rekeyed (`draft:<m> -> <main>.jsonl` or startup replace)
    const migrate = replace === true || from.startsWith('draft:')
    if (!migrate) return
    const fromParent = normKey(from)
    for (const entry of this.tokens.values()) {
      if (entry.fallbackParentKey && normKey(entry.fallbackParentKey) === fromParent) {
        entry.fallbackParentKey = to
      }
    }
    for (const staged of this.stagedPrompts.values()) {
      if (normKey(staged.input.parentSessionKey) === fromParent) {
        staged.input = { ...staged.input, parentSessionKey: to }
      }
    }
  }

  private async ensureStarted(): Promise<string> {
    if (this.disposed) throw new Error('SideChatBridgeServer has been disposed.')
    if (this.baseUrl) return this.baseUrl
    if (this.listeningPromise) return this.listeningPromise

    this.listeningPromise = new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res).catch((error) => {
          if (!res.headersSent) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : 'Internal bridge error' })
          }
        })
      })
      server.on('error', (error) => {
        if (!this.baseUrl) {
          this.listeningPromise = null
          reject(error)
        }
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (!addr || typeof addr === 'string') {
          server.close()
          this.listeningPromise = null
          reject(new Error('Could not bind SideChatBridgeServer to 127.0.0.1'))
          return
        }
        server.unref()
        this.server = server
        this.baseUrl = `http://127.0.0.1:${addr.port}`
        resolve(this.baseUrl)
      })
    })
    return this.listeningPromise
  }

  /** Mint a per-runtime 256-bit capability token and return the loopback URL + revoke handle. */
  async registerRuntime(
    sideOwnerId: string,
    parentSessionKey: string | undefined,
    cwd: string
  ): Promise<{ bridgeUrl: string; bridgeToken: string; revoke: () => void }> {
    const bridgeUrl = await this.ensureStarted()
    const bridgeToken = randomBytes(32).toString('base64url')
    this.tokens.set(bridgeToken, {
      sideOwnerId,
      fallbackParentKey: parentSessionKey,
      fallbackCwd: cwd
    })
    const revoke = () => {
      this.tokens.delete(bridgeToken)
    }
    return { bridgeUrl, bridgeToken, revoke }
  }

  /** Stage reference chips / workflow preset for the next Side Chat prompt turn. */
  stagePrompt(input: SideChatStagePromptInput): void {
    if (!input.sideSessionKey || !input.parentSessionKey) return
    const refs = sanitizeReferences(input.references)
    this.stagedPrompts.set(normKey(input.sideSessionKey), {
      input: {
        sideSessionKey: input.sideSessionKey,
        parentSessionKey: input.parentSessionKey,
        ...(refs ? { references: refs } : {}),
        ...(input.preset ? { preset: input.preset } : {}),
        ...(typeof input.stepText === 'string' && input.stepText.trim()
          ? { stepText: input.stepText.trim().slice(0, 500) }
          : {})
      },
      stagedAt: Date.now()
    })
  }

  private consumeStagedPrompt(sideOwnerId: string): SideChatStagePromptInput | undefined {
    const key = normKey(sideOwnerId)
    const staged = this.stagedPrompts.get(key)
    if (!staged) return undefined
    this.stagedPrompts.delete(key)
    return staged.input
  }

  private authenticate(req: IncomingMessage): RegisteredRuntimeToken | null {
    const auth = req.headers.authorization
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null
    const provided = auth.slice('Bearer '.length).trim()
    if (!provided) return null
    for (const [token, entry] of this.tokens) {
      if (safeTokenCompare(provided, token)) {
        return entry
      }
    }
    return null
  }

  private resolveTarget(entry: RegisteredRuntimeToken): { parentKey: string; cwd: string } {
    const bound = this.bindings.parentOfSide(entry.sideOwnerId)
    if (bound?.parentSessionKey) {
      return {
        parentKey: bound.parentSessionKey,
        cwd: bound.cwd || entry.fallbackCwd
      }
    }
    const supInfo = this.supervisor?.sessionInfo(entry.sideOwnerId)
    if (supInfo?.role === 'side' && supInfo.parentKey) {
      return {
        parentKey: supInfo.parentKey,
        cwd: supInfo.cwd || entry.fallbackCwd
      }
    }
    return {
      parentKey: entry.fallbackParentKey ?? '',
      cwd: entry.fallbackCwd
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' })
      return
    }
    const entry = this.authenticate(req)
    if (!entry) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }

    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid JSON body' })
      return
    }

    const url = req.url?.split('?')[0] ?? ''
    const { parentKey, cwd } = this.resolveTarget(entry)

    if (url === '/v1/digest') {
      const staged = this.consumeStagedPrompt(entry.sideOwnerId)
      const effectiveParent = parentKey || staged?.parentSessionKey || ''
      const { digestXml } = await this.mirror.buildDigest(effectiveParent, staged, this.getSessionRoots())
      let turnMeta: SideChatTurnMetaPayload | undefined
      if (staged && (staged.references?.length || staged.preset || staged.stepText)) {
        turnMeta = {
          ...(staged.references?.length ? { references: staged.references } : {}),
          ...(staged.preset ? { preset: staged.preset } : {}),
          ...(staged.stepText ? { stepText: staged.stepText } : {}),
          timestamp: Date.now()
        }
      }
      sendJson(res, 200, {
        digestXml,
        parentSessionKey: effectiveParent,
        ...(turnMeta ? { turnMeta } : {})
      })
      return
    }

    if (url === '/v1/inspect-conversation') {
      const params: InspectMainConversationParams = {
        view:
          body.view === 'turns' || body.view === 'tool' || body.view === 'plan' || body.view === 'search'
            ? body.view
            : undefined,
        turnStart: typeof body.turnStart === 'number' ? body.turnStart : undefined,
        turnCount: typeof body.turnCount === 'number' ? body.turnCount : undefined,
        fromEnd: typeof body.fromEnd === 'boolean' ? body.fromEnd : undefined,
        toolCallId: typeof body.toolCallId === 'string' ? body.toolCallId : undefined,
        outputOffsetLines: typeof body.outputOffsetLines === 'number' ? body.outputOffsetLines : undefined,
        query: typeof body.query === 'string' ? body.query : undefined
      }
      const result = await this.mirror.inspectConversation(parentKey, params, this.getSessionRoots())
      sendJson(res, 200, result)
      return
    }

    if (url === '/v1/inspect-changes') {
      const params: InspectMainChangesParams = {
        scope:
          body.scope === 'session' || body.scope === 'worktree' || body.scope === 'all'
            ? body.scope
            : 'all',
        file: typeof body.file === 'string' && body.file.trim() ? body.file.trim() : undefined,
        staged: typeof body.staged === 'boolean' ? body.staged : undefined,
        offsetLines: typeof body.offsetLines === 'number' ? body.offsetLines : 0
      }
      const result = await this.inspectChanges(parentKey, cwd, params)
      sendJson(res, 200, result)
      return
    }

    sendJson(res, 404, { error: 'Not found' })
  }

  async inspectChanges(
    parentKey: string,
    cwd: string,
    params: InspectMainChangesParams
  ): Promise<{ text: string; details: Record<string, unknown> }> {
    const scope = params.scope ?? 'all'
    if (!cwd) {
      return { text: 'No workspace directory is bound to this conversation.', details: { scope, files: [] } }
    }

    const [snapshot, gitStatus] = await Promise.all([
      this.mirror.getSnapshotMeta(parentKey, this.getSessionRoots()),
      readStatus(cwd)
    ])

    const sessionRelSet = new Set<string>()
    for (const raw of snapshot.sessionChangedFiles) {
      const rel = normalizeRelativeFile(cwd, raw)
      if (rel) sessionRelSet.add(rel)
    }

    // Specific file diff or preview
    if (params.file) {
      const relPath = normalizeRelativeFile(cwd, params.file)
      if (!relPath) {
        return {
          text: `Rejected path "${params.file}": file must be inside the bound workspace directory.`,
          details: { scope, file: params.file, rejected: true }
        }
      }

      const offset = Math.max(0, Math.trunc(params.offsetLines ?? 0))
      if (gitStatus.isRepo) {
        const diff = await readFileDiff(cwd, relPath)
        if (diff.error) {
          return { text: `Could not read diff for ${relPath}: ${diff.error}`, details: { file: relPath, error: diff.error } }
        }
        if (diff.binary) {
          return { text: `${relPath} is a binary or oversized file.`, details: { file: relPath, binary: true } }
        }
        let fullText: string
        if (diff.oldText === diff.newText && !diff.untracked) {
          // Unchanged vs HEAD — fall back to verified workspace file preview
          const preview = await readVerifiedWorkspacePreview(cwd, relPath)
          if (!preview) {
            return { text: `File "${relPath}" is unreadable or outside workspace containment.`, details: { file: relPath, rejected: true } }
          }
          if (preview.binary) {
            return { text: `${relPath} is a binary file.`, details: { file: relPath, binary: true } }
          }
          fullText = `File ${relPath} has no uncommitted git diff vs HEAD. Current contents:\n${preview.content}`
        } else {
          fullText = createTwoFilesPatch(
            diff.untracked ? '/dev/null' : `a/${relPath}`,
            `b/${relPath}`,
            diff.oldText,
            diff.newText,
            '',
            '',
            { context: 3 }
          )
        }
        return formatPagedDiff(relPath, fullText, offset, {
          scope,
          file: relPath,
          status: diff.status,
          untracked: diff.untracked,
          truncatedSource: diff.truncated,
          inSessionChanges: sessionRelSet.has(relPath)
        })
      }

      // Non-git folder: strictly use openWorkspaceFile single-handle read (Non-negotiable #9)
      const preview = await readVerifiedWorkspacePreview(cwd, relPath)
      if (!preview) {
        return {
          text: `Could not read "${relPath}": file does not exist or failed workspace containment verification.`,
          details: { scope, file: relPath, rejected: true }
        }
      }
      if (preview.binary) {
        return { text: `${relPath} is a binary file.`, details: { scope, file: relPath, binary: true } }
      }
      return formatPagedDiff(relPath, preview.content, offset, {
        scope,
        file: relPath,
        isRepo: false,
        truncatedSource: preview.truncated,
        inSessionChanges: sessionRelSet.has(relPath)
      })
    }

    // List summary mode
    const worktreeByPath = new Map(
      gitStatus.files
        .filter((f) => (params.staged === true ? f.staged : true))
        .map((f) => [f.path.replace(/\\/g, '/'), f])
    )
    const allPaths = new Set<string>()
    if (scope === 'session' || scope === 'all') {
      for (const rel of sessionRelSet) allPaths.add(rel)
    }
    if (scope === 'worktree' || scope === 'all') {
      for (const rel of worktreeByPath.keys()) allPaths.add(rel)
    }

    const sorted = [...allPaths].sort((a, b) => a.localeCompare(b))
    if (sorted.length === 0) {
      const repoNote = gitStatus.isRepo ? `Git branch: ${gitStatus.branch ?? '(detached)'} (clean)` : 'Not a git repository'
      return {
        text: `No changed files found for scope "${scope}". ${repoNote}.`,
        details: { scope, isRepo: gitStatus.isRepo, count: 0 }
      }
    }

    const lines: string[] = [
      `Changed files (scope=${scope}, total=${sorted.length}${gitStatus.isRepo ? `, branch=${gitStatus.branch ?? 'detached'}` : ', non-git'}):`
    ]
    for (const rel of sorted) {
      const inSession = sessionRelSet.has(rel)
      const wt = worktreeByPath.get(rel)
      const provenance = inSession && wt ? 'session+worktree' : inSession ? 'session' : 'worktree'
      const statusLabel = wt ? (wt.untracked ? '??' : `${wt.index}${wt.worktree}`.trim() || 'M') : 'edited'
      const statsLabel =
        wt && (wt.added !== undefined || wt.removed !== undefined)
          ? ` (+${wt.added ?? 0}/-${wt.removed ?? 0})`
          : ''
      lines.push(`- [${provenance}] ${statusLabel} ${rel}${statsLabel}`)
    }
    lines.push('\nPass `file: "<path>"` to inspect the unified diff for any file.')

    return {
      text: lines.join('\n').slice(0, MAX_INSPECT_OUTPUT_CHARS),
      details: {
        scope,
        isRepo: gitStatus.isRepo,
        count: sorted.length,
        sessionCount: sessionRelSet.size,
        worktreeCount: worktreeByPath.size
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.supervisor) {
      this.supervisor.off('rekey', this.handleRekey)
      this.supervisor = undefined
    }
    this.tokens.clear()
    this.stagedPrompts.clear()
    const server = this.server
    this.server = null
    this.baseUrl = null
    this.listeningPromise = null
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    }
  }
}

function formatPagedDiff(
  relPath: string,
  fullText: string,
  offsetLines: number,
  details: Record<string, unknown>
): { text: string; details: Record<string, unknown> } {
  const allLines = fullText ? fullText.split(/\r?\n/) : []
  const page = allLines.slice(offsetLines, offsetLines + DIFF_LINES_PER_PAGE)
  const nextOffsetLines =
    offsetLines + page.length < allLines.length ? offsetLines + page.length : undefined
  const header = `Diff for ${relPath} (lines ${allLines.length === 0 ? 0 : offsetLines + 1}..${offsetLines + page.length} of ${allLines.length}):`
  const trailer = nextOffsetLines !== undefined ? `\n[More lines available: pass offsetLines=${nextOffsetLines}]` : ''
  const combined = `${header}\n\n${page.join('\n')}${trailer}`
  return {
    text: combined.length > MAX_INSPECT_OUTPUT_CHARS ? `${combined.slice(0, MAX_INSPECT_OUTPUT_CHARS - 1)}…` : combined,
    details: {
      ...details,
      totalLines: allLines.length,
      ...(nextOffsetLines !== undefined ? { nextOffsetLines } : {})
    }
  }
}
