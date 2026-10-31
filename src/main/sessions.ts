import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { appendFile, readdir, realpath, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentMessage,
  AggregatedUsageStats,
  DailyUsageStat,
  ModelUsageStat,
  PeriodUsage,
  SessionMeta,
  SessionSearchHit,
  TokenUsageMetrics
} from '@shared/types'
import { canonicalSessionFile } from './pi/session-file'

const MAX_SESSION_BYTES = 24 * 1024 * 1024
const MAX_SEARCH_FILES = 240
const MAX_SEARCH_FILE_BYTES = 8 * 1024 * 1024
const LF = 0x0a
const CR = 0x0d
const CHUNK_SIZE = 64 * 1024
const MAX_CACHE_ENTRIES = 2000

interface SessionHeader {
  type: 'session'
  id: string
  timestamp?: string
  cwd?: string
}

interface BaseEntry {
  type: string
  id?: string
  parentId?: string | null
  timestamp?: string
}

interface TreeEntry extends BaseEntry {
  message?: AgentMessage
}

export interface SessionCacheEntry {
  mtime: number
  size: number
  meta: SessionMeta
}

const sessionMetaCache = new Map<string, SessionCacheEntry>()
const inFlightReads = new Map<string, Promise<SessionMeta | null>>()

interface CachedFileUsage {
  mtime: number
  size: number
  sessionId: string
  timestamps: number[]
  metrics: Array<{
    ts: number
    model: string
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
    cost: number
  }>
}

const usageCache = new Map<string, CachedFileUsage>()

function homeDir(): string {
  return os.homedir()
}

/** Where Pi stores session files. Mirrors the CLI precedence rules. */
export function resolveSessionRoot(customDir?: string): string {
  if (customDir && customDir.trim()) return path.resolve(customDir.trim())
  const fromEnv = process.env.PI_CODING_AGENT_SESSION_DIR
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim())

  const settingsFile = path.join(homeDir(), '.pi', 'agent', 'settings.json')
  try {
    if (existsSync(settingsFile)) {
      const raw = JSON.parse(readFileSync(settingsFile, 'utf8')) as { sessionDir?: string }
      if (raw.sessionDir && raw.sessionDir.trim()) return path.resolve(raw.sessionDir.trim())
    }
  } catch {
    /* fall through to the default location */
  }
  return path.join(homeDir(), '.pi', 'agent', 'sessions')
}

/** Pi encodes the working directory as `--<path>--` with separators replaced. */
export function encodeWorkspaceDir(cwd: string): string {
  const normalized = path.resolve(cwd)
  return `--${normalized.replace(/^[/\\]+/, '').replace(/[/\\:]/g, '-')}--`
}

/**
 * Test whether two paths refer to the same filesystem location,
 * taking Windows case-insensitivity and separator differences into account.
 */
export function pathsEqual(a: string, b: string): boolean {
  if (a === b) return true
  const normA = path.resolve(a)
  const normB = path.resolve(b)
  if (normA === normB) return true
  if (process.platform === 'win32') {
    return normA.toLowerCase() === normB.toLowerCase()
  }
  return false
}

/**
 * Locate the targeted session directory for a given workspace `cwd`.
 * Prioritizes direct encoded match, then Windows drive casing flip,
 * realpath resolution, and case-insensitive top-level directory matching.
 * Returns null if no matching session directory exists.
 */
export async function findWorkspaceSessionDir(sessionRoot: string, cwd: string): Promise<string | null> {
  if (!cwd || !sessionRoot) return null
  try {
    const rootStat = await stat(sessionRoot)
    if (!rootStat.isDirectory()) return null
  } catch {
    return null
  }

  // 1. Primary candidate
  const directEncoded = encodeWorkspaceDir(cwd)
  const directPath = path.join(sessionRoot, directEncoded)
  try {
    const s = await stat(directPath)
    if (s.isDirectory()) return directPath
  } catch {
    /* miss */
  }

  // 2. Windows drive letter casing candidate (e.g. e: vs E:)
  const driveMatch = cwd.match(/^([a-zA-Z]):[\\/]/)
  if (driveMatch) {
    const drive = driveMatch[1]
    const flippedDrive = drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()
    const flippedCwd = flippedDrive + cwd.slice(1)
    const altEncoded = encodeWorkspaceDir(flippedCwd)
    const altPath = path.join(sessionRoot, altEncoded)
    try {
      const s = await stat(altPath)
      if (s.isDirectory()) return altPath
    } catch {
      /* miss */
    }
  }

  // 3. Symlink / junction resolution via realpath
  try {
    const realCwd = await realpath(cwd)
    if (realCwd !== cwd) {
      const realEncoded = encodeWorkspaceDir(realCwd)
      const realPath = path.join(sessionRoot, realEncoded)
      const s = await stat(realPath)
      if (s.isDirectory()) return realPath
    }
  } catch {
    /* miss */
  }

  // 4. Shallow case-insensitive scan of immediate subdirectory names under sessionRoot
  try {
    const directLower = directEncoded.toLowerCase()
    const entries = await readdir(sessionRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.toLowerCase() === directLower) {
        return path.join(sessionRoot, entry.name)
      }
    }
  } catch {
    /* miss */
  }

  return null
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== 'object') return ''
        const typed = block as { type?: string; text?: string; thinking?: string }
        if (typed.type === 'text') return typed.text ?? ''
        if (typed.type === 'thinking') return typed.thinking ?? ''
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * The part of a message a search should look at.
 *
 * Reasoning blocks are left out: they are the model talking to itself, and a
 * hit there would send the user to a message that does not show the words.
 */
function searchableText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const typed = block as { type?: string; text?: string }
      return typed.type === 'text' ? (typed.text ?? '') : ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Streams lines from a JSONL file splitting strictly on LF (0x0A) with optional trailing CR (0x0D).
 * Complies with AGENTS.md: Never uses readline. Handles U+2028 / U+2029 correctly.
 */
export async function* readJsonlLines(
  file: string,
  maxBytes = MAX_SESSION_BYTES
): AsyncGenerator<string, void, void> {
  let stream
  try {
    stream = createReadStream(file, { highWaterMark: CHUNK_SIZE })
  } catch {
    return
  }

  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let bytesRead = 0

  try {
    for await (const chunk of stream) {
      const bufChunk = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
      bytesRead += bufChunk.length
      if (bytesRead > maxBytes) {
        stream.destroy()
        return
      }

      buffer = buffer.length === 0 ? bufChunk : Buffer.concat([buffer, bufChunk])
      let index = buffer.indexOf(LF)
      while (index !== -1) {
        let lineBuf = buffer.subarray(0, index)
        buffer = buffer.subarray(index + 1)
        if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === CR) {
          lineBuf = lineBuf.subarray(0, lineBuf.length - 1)
        }
        yield lineBuf.toString('utf8')
        index = buffer.indexOf(LF)
      }
    }

    if (buffer.length > 0) {
      let lineBuf = buffer
      if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === CR) {
        lineBuf = lineBuf.subarray(0, lineBuf.length - 1)
      }
      yield lineBuf.toString('utf8')
    }
  } catch {
    return
  } finally {
    stream.destroy()
  }
}

export function clearSessionCache(): void {
  sessionMetaCache.clear()
  usageCache.clear()
}

export function invalidateSessionCache(file?: string): void {
  if (file) {
    const key = canonicalSessionFile(file)
    sessionMetaCache.delete(key)
    usageCache.delete(key)
  } else {
    sessionMetaCache.clear()
    usageCache.clear()
  }
}

export function getSessionCacheSize(): number {
  return sessionMetaCache.size
}

function recordInCache(key: string, entry: SessionCacheEntry): void {
  if (sessionMetaCache.size >= MAX_CACHE_ENTRIES && !sessionMetaCache.has(key)) {
    const oldestKey = sessionMetaCache.keys().next().value
    if (oldestKey) sessionMetaCache.delete(oldestKey)
  }
  sessionMetaCache.set(key, entry)
}

/**
 * Returns metadata for a session file, reusing the incremental (mtime, size) cache
 * when valid and coalescing in-flight concurrent reads.
 */
export async function getSessionMeta(file: string): Promise<SessionMeta | null> {
  const key = canonicalSessionFile(file)
  const existing = inFlightReads.get(key)
  if (existing) return existing

  const task = (async (): Promise<SessionMeta | null> => {
    let s: Stats
    try {
      s = await stat(file)
      if (s.size > MAX_SESSION_BYTES) return null
    } catch {
      sessionMetaCache.delete(key)
      return null
    }

    const cached = sessionMetaCache.get(key)
    if (cached && cached.mtime === s.mtimeMs && cached.size === s.size) {
      return cached.meta
    }

    const meta = await parseSession(file, { size: s.size, mtimeMs: s.mtimeMs })
    if (meta) {
      recordInCache(key, {
        mtime: s.mtimeMs,
        size: s.size,
        meta
      })
    } else {
      sessionMetaCache.delete(key)
    }
    return meta
  })()

  inFlightReads.set(key, task)
  try {
    return await task
  } finally {
    inFlightReads.delete(key)
  }
}

/** Active-branch entries, leaf first in the walk and then reversed into order. */
function activeBranch(lines: string[]): TreeEntry[] {
  const entries: TreeEntry[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    try {
      const parsed = JSON.parse(line) as TreeEntry
      if (parsed && typeof parsed === 'object' && parsed.type && parsed.type !== 'session') {
        entries.push(parsed)
      }
    } catch {
      /* a torn line is not a message */
    }
  }
  const parentIds = new Set<string>()
  const byId = new Map<string, TreeEntry>()
  for (const entry of entries) {
    if (!entry.id) continue
    byId.set(entry.id, entry)
    if (entry.parentId) parentIds.add(entry.parentId)
  }
  let leaf: TreeEntry | null = null
  for (const entry of entries) {
    if (entry.id && !parentIds.has(entry.id)) leaf = entry
  }
  if (!leaf) leaf = entries[entries.length - 1] ?? null
  const branch: TreeEntry[] = []
  const seen = new Set<string>()
  let cursor: TreeEntry | null = leaf
  while (cursor && cursor.id && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    branch.push(cursor)
    cursor = cursor.parentId ? byId.get(cursor.parentId) ?? null : null
  }
  branch.reverse()
  return branch
}

/**
 * Messages on the active branch, without starting Pi.
 * Compaction and bookkeeping entries stay out; the leaf walk already follows
 * the branch Pi would show.
 */
export async function readSessionMessages(file: string): Promise<AgentMessage[]> {
  const lines: string[] = []
  for await (const line of readJsonlLines(file, MAX_SESSION_BYTES)) {
    lines.push(line)
  }
  if (!lines.length) return []
  const messages: AgentMessage[] = []
  for (const entry of activeBranch(lines)) {
    if (entry.type !== 'message' || !entry.message) continue
    const message = entry.message
    const timestamp = message.timestamp
    messages.push({
      ...message,
      timestamp: typeof timestamp === 'number' ? timestamp : Date.parse(String(timestamp ?? '')) || Date.now()
    })
  }
  return messages
}

/**
 * Name a cold session by appending one `session_info` entry, the same record
 * Pi writes. Refuses a missing file. The caller must already know that no
 * runtime is writing this JSONL.
 */
export async function appendSessionName(file: string, name: string): Promise<boolean> {
  const sanitized = name.replace(/[\r\n]+/g, ' ').trim()
  if (!sanitized) return false
  try {
    const s = await stat(file)
    if (!s.isFile()) return false
  } catch {
    return false
  }

  const lines: string[] = []
  for await (const line of readJsonlLines(file, MAX_SESSION_BYTES)) {
    lines.push(line)
  }
  if (!lines.length) return false

  const branch = activeBranch(lines)
  const leaf = branch[branch.length - 1]
  const entry = {
    type: 'session_info',
    id: randomBytes(4).toString('hex'),
    parentId: leaf?.id ?? null,
    timestamp: new Date().toISOString(),
    name: sanitized
  }
  await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
  invalidateSessionCache(file)
  return true
}

export async function parseSession(
  file: string,
  fileStats?: { size: number; mtimeMs: number }
): Promise<SessionMeta | null> {
  let stats = fileStats
  if (!stats) {
    try {
      const s = await stat(file)
      stats = { size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      return null
    }
  }
  if (stats.size > MAX_SESSION_BYTES) return null

  let header: SessionHeader | null = null
  const entries: BaseEntry[] = []

  for await (const raw of readJsonlLines(file, MAX_SESSION_BYTES)) {
    const line = raw.trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const record = parsed as BaseEntry & { message?: { role?: string; content?: unknown } }
    if (!header && record.type === 'session') {
      header = record as unknown as SessionHeader
      continue
    }
    entries.push(record)
  }

  if (!header) return null

  const parentIds = new Set<string>()
  const byId = new Map<string, BaseEntry>()
  for (const entry of entries) {
    if (!entry.id) continue
    byId.set(entry.id, entry)
    if (entry.parentId) parentIds.add(entry.parentId)
  }

  // The leaf is the newest entry that is not the parent of another entry.
  let leaf: BaseEntry | null = null
  for (const entry of entries) {
    if (!entry.id) continue
    if (!parentIds.has(entry.id)) leaf = entry
  }
  if (!leaf) leaf = entries[entries.length - 1] ?? null

  // Walk from the leaf back to the root to recover the active branch.
  const branch: BaseEntry[] = []
  const seen = new Set<string>()
  let cursor: BaseEntry | null = leaf
  while (cursor && cursor.id && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    branch.push(cursor)
    cursor = cursor.id ? byId.get(cursor.parentId ?? '') ?? null : null
  }
  branch.reverse()

  let name: string | undefined
  let preview = ''
  let messageCount = 0
  let model: string | undefined

  for (const entry of branch) {
    if (entry.type === 'session_info') {
      const value = (entry as unknown as { name?: string }).name
      if (value) name = value
      continue
    }
    if (entry.type === 'model_change') {
      const change = entry as unknown as { provider?: string; modelId?: string }
      // The provider is part of the identity. Keeping only the id makes the
      // same model name on two providers indistinguishable, and a later restore
      // has nothing to pass to `--model`.
      if (change.modelId) model = change.provider ? `${change.provider}/${change.modelId}` : change.modelId
      continue
    }
    if (entry.type !== 'message') continue
    const message = (entry as unknown as { message?: { role?: string; content?: unknown } }).message
    if (!message) continue
    if (message.role === 'user') {
      messageCount += 1
      if (!preview) {
        preview = extractText(message.content).trim()
      }
    } else if (message.role === 'assistant') {
      messageCount += 1
      if (!model) {
        const value = (entry as unknown as { message?: { model?: string } }).message?.model
        if (value) model = value
      }
    } else if (message.role === 'toolResult' || message.role === 'bashExecution') {
      messageCount += 1
    }
  }

  // A fork copies the entries of the original branch, so their timestamps are
  // old. The file itself was just written, and that is what the sidebar has
  // to sort by.
  const entryTime = Date.parse(entries[entries.length - 1]?.timestamp ?? header.timestamp ?? '') || 0
  const updatedAt = Math.max(entryTime, stats.mtimeMs)

  return {
    id: header.id,
    file,
    cwd: header.cwd ?? '',
    name,
    preview: preview.replace(/\s+/g, ' ').slice(0, 120),
    updatedAt,
    messageCount,
    model
  }
}

/**
 * List every session Pi has on disk, optionally restricted to one working
 * directory. Results are sorted by most recent activity first.
 */
export async function listSessions(cwd?: string): Promise<SessionMeta[]> {
  const root = resolveSessionRoot()
  try {
    const rootStat = await stat(root)
    if (!rootStat.isDirectory()) return []
  } catch {
    return []
  }

  const results: SessionMeta[] = []

  if (cwd && cwd.trim()) {
    // Targeted workspace directory resolution (R3)
    const targetDir = await findWorkspaceSessionDir(root, cwd)
    if (!targetDir) {
      return []
    }

    let files: string[]
    try {
      const names = await readdir(targetDir)
      files = names.filter((f) => f.endsWith('.jsonl')).map((f) => path.join(targetDir, f))
    } catch {
      return []
    }

    for (const file of files) {
      const meta = await getSessionMeta(file)
      if (!meta) continue
      if (!pathsEqual(meta.cwd, cwd)) continue
      results.push(meta)
    }
  } else {
    // Global listing across all workspaces
    let workspaceDirs: string[]
    try {
      const entries = await readdir(root, { withFileTypes: true })
      workspaceDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return []
    }

    for (const dir of workspaceDirs) {
      const dirPath = path.join(root, dir)
      let files: string[]
      try {
        const names = await readdir(dirPath)
        files = names.filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dirPath, f))
      } catch {
        continue
      }
      for (const file of files) {
        const meta = await getSessionMeta(file)
        if (!meta) continue
        results.push(meta)
      }
    }
  }

  results.sort((a, b) => b.updatedAt - a.updatedAt)
  return results
}

/**
 * Search the text of every conversation on disk.
 *
 * The sidebar can only filter the conversations it has loaded; this walks the
 * session folder so a run can be found by something that was said in it, long
 * after it scrolled out of the list. The newest files are read first, and the
 * search stops once it has enough hits.
 */
export async function searchSessions(query: string, limit = 30): Promise<SessionSearchHit[]> {
  const needle = query.trim()
  if (needle.length < 2) return []
  const needleLower = needle.toLowerCase()
  const ceiling = Math.min(Math.max(limit, 1), 100)
  const root = resolveSessionRoot()
  try {
    const rootStat = await stat(root)
    if (!rootStat.isDirectory()) return []
  } catch {
    return []
  }

  const candidates: { file: string; mtime: number }[] = []
  let workspaceDirs: string[]
  try {
    const entries = await readdir(root, { withFileTypes: true })
    workspaceDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }

  for (const dir of workspaceDirs) {
    const folder = path.join(root, dir)
    let names: string[]
    try {
      names = await readdir(folder)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(folder, name)
      try {
        const s = await stat(file)
        candidates.push({ file, mtime: s.mtimeMs })
      } catch {
        /* a file that vanished is not a search result */
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)

  const hits: SessionSearchHit[] = []
  for (const candidate of candidates.slice(0, MAX_SEARCH_FILES)) {
    if (hits.length >= ceiling) break
    const fileHits = await searchSessionFile(
      candidate.file,
      candidate.mtime,
      needleLower,
      needle.length,
      ceiling - hits.length
    )
    hits.push(...fileHits)
  }
  return hits
}

/** Read one session file and collect the matching messages of any branch. */
async function searchSessionFile(
  file: string,
  mtime: number,
  needleLower: string,
  needleLength: number,
  remaining: number
): Promise<SessionSearchHit[]> {
  let sessionId = path.basename(file, '.jsonl')
  let cwd = ''
  let name: string | undefined
  let preview = ''

  const hits: SessionSearchHit[] = []
  // One file can match on both branches of a conversation, or on the same
  // words in two messages; a handful of rows per conversation is enough to
  // recognise it, so identical snippets are dropped and the list stays short.
  const seenSnippets = new Set<string>()
  let messageIndex = 0

  for await (const raw of readJsonlLines(file, MAX_SEARCH_FILE_BYTES)) {
    const line = raw.trim()
    if (!line) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (!record || typeof record !== 'object') continue

    if (record.type === 'session') {
      if (typeof record.id === 'string') sessionId = record.id
      if (typeof record.cwd === 'string') cwd = record.cwd
      continue
    }
    if (record.type === 'session_info') {
      if (typeof record.name === 'string' && record.name.trim()) name = record.name.trim()
      continue
    }
    if (record.type !== 'message') continue

    const message = record.message as { role?: string; content?: unknown } | undefined
    if (!message) continue
    if (message.role === 'user' || message.role === 'assistant') messageIndex += 1
    if (message.role !== 'user' && message.role !== 'assistant') continue

    const text = searchableText(message.content)
    if (!text) continue
    if (!preview && message.role === 'user') preview = text.replace(/\s+/g, ' ').slice(0, 120)

    const at = text.toLowerCase().indexOf(needleLower)
    if (at === -1) continue
    const windowStart = Math.max(0, at - 70)
    const windowEnd = Math.min(text.length, at + needleLength + 90)
    const prefix = text.slice(windowStart, at).replace(/\s+/g, ' ')
    const matched = text.slice(at, at + needleLength).replace(/\s+/g, ' ')
    const suffix = text.slice(at + needleLength, windowEnd).replace(/\s+/g, ' ')
    const snippet = `${prefix}${matched}${suffix}`
    if (seenSnippets.has(snippet)) continue
    seenSnippets.add(snippet)
    hits.push({
      file,
      sessionId,
      name,
      preview,
      cwd,
      updatedAt: mtime,
      role: message.role,
      snippet,
      matchStart: prefix.length,
      matchLength: matched.length,
      messageIndex
    })
    // Two rows from one conversation say enough about why it matched.
    if (hits.length >= Math.min(remaining, 2)) break
  }
  return hits
}

function emptyMetrics(): TokenUsageMetrics {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0
  }
}

function emptyPeriod(period: 'today' | 'week' | 'month' | 'allTime'): PeriodUsage {
  return {
    period,
    tokens: emptyMetrics(),
    conversationsCount: 0,
    messageCount: 0
  }
}

/**
 * Aggregate token usage and conversation records across all sessions on disk
 * for Today, This Week, This Month, and All-Time.
 */
export async function getAggregatedUsage(customRoot?: string): Promise<AggregatedUsageStats> {
  const root = resolveSessionRoot(customRoot)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = now.getDay()
  const diffToMonday = day === 0 ? 6 : day - 1
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday).getTime()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime()

  const today = emptyPeriod('today')
  const week = emptyPeriod('week')
  const month = emptyPeriod('month')
  const allTime = emptyPeriod('allTime')

  const activeInToday = new Set<string>()
  const activeInWeek = new Set<string>()
  const activeInMonth = new Set<string>()
  const activeInAllTime = new Set<string>()

  const modelStats = new Map<string, ModelUsageStat>()

  // Recent 7 days buckets
  const recentDaysMap = new Map<string, { totalTokens: number; conversations: Set<string>; messageCount: number }>()
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    recentDaysMap.set(key, { totalTokens: 0, conversations: new Set(), messageCount: 0 })
  }

  let rootStat: Stats
  try {
    rootStat = await stat(root)
    if (!rootStat.isDirectory()) throw new Error('not a directory')
  } catch {
    return {
      today,
      week,
      month,
      allTime,
      byModel: [],
      recentDays: Array.from(recentDaysMap.entries()).map(([date, d]) => ({
        date,
        totalTokens: d.totalTokens,
        conversationsCount: d.conversations.size,
        messageCount: d.messageCount
      })),
      updatedAt: Date.now()
    }
  }

  let workspaceDirs: string[] = []
  try {
    const entries = await readdir(root, { withFileTypes: true })
    workspaceDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    workspaceDirs = []
  }

  for (const dir of workspaceDirs) {
    const dirPath = path.join(root, dir)
    let files: string[] = []
    try {
      const names = await readdir(dirPath)
      files = names.filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }

    for (const file of files) {
      const fullPath = path.join(dirPath, file)
      let s: Stats
      try {
        s = await stat(fullPath)
        if (s.size > MAX_SESSION_BYTES) continue
      } catch {
        continue
      }

      const key = canonicalSessionFile(fullPath)
      const sessionId = file.replace(/\.jsonl$/, '')
      let usageData = usageCache.get(key)

      if (!usageData || usageData.mtime !== s.mtimeMs || usageData.size !== s.size) {
        const timestamps: number[] = []
        const metrics: CachedFileUsage['metrics'] = []

        for await (const raw of readJsonlLines(fullPath, MAX_SESSION_BYTES)) {
          if (!raw.includes('"message"')) continue
          try {
            const record = JSON.parse(raw) as {
              type?: string
              timestamp?: string
              message?: {
                role?: string
                timestamp?: string | number
                model?: string
                usage?: {
                  input?: number
                  output?: number
                  cacheRead?: number
                  cacheWrite?: number
                  totalTokens?: number
                  cost?: number | { total?: number }
                }
              }
            }

            if (record.type !== 'message' || !record.message) continue
            const msg = record.message
            const ts =
              Date.parse(record.timestamp ?? '') ||
              (typeof msg.timestamp === 'number'
                ? msg.timestamp
                : Date.parse(String(msg.timestamp ?? ''))) ||
              0

            if (ts > 0) timestamps.push(ts)

            if (msg.role === 'assistant' && msg.usage) {
              const u = msg.usage
              const input = typeof u.input === 'number' ? u.input : 0
              const output = typeof u.output === 'number' ? u.output : 0
              const cacheRead = typeof u.cacheRead === 'number' ? u.cacheRead : 0
              const cacheWrite = typeof u.cacheWrite === 'number' ? u.cacheWrite : 0
              const total =
                typeof u.totalTokens === 'number' && u.totalTokens > 0
                  ? u.totalTokens
                  : input + output + cacheRead + cacheWrite
              const cost =
                typeof u.cost === 'number'
                  ? u.cost
                  : typeof u.cost?.total === 'number'
                    ? u.cost.total
                    : 0

              metrics.push({
                ts,
                model: msg.model || 'Unknown',
                input,
                output,
                cacheRead,
                cacheWrite,
                total,
                cost
              })
            }
          } catch {
            // ignore malformed line
          }
        }

        usageData = {
          mtime: s.mtimeMs,
          size: s.size,
          sessionId,
          timestamps,
          metrics
        }
        if (usageCache.size >= MAX_CACHE_ENTRIES) {
          const oldest = usageCache.keys().next().value
          if (oldest) usageCache.delete(oldest)
        }
        usageCache.set(key, usageData)
      }

      activeInAllTime.add(usageData.sessionId)
      for (const ts of usageData.timestamps) {
        if (ts >= startOfToday) activeInToday.add(usageData.sessionId)
        if (ts >= startOfWeek) activeInWeek.add(usageData.sessionId)
        if (ts >= startOfMonth) activeInMonth.add(usageData.sessionId)
      }

      for (const m of usageData.metrics) {
        const addMetrics = (target: PeriodUsage) => {
          target.tokens.input += m.input
          target.tokens.output += m.output
          target.tokens.cacheRead += m.cacheRead
          target.tokens.cacheWrite += m.cacheWrite
          target.tokens.totalTokens += m.total
          target.tokens.cost += m.cost
          target.messageCount += 1
        }

        addMetrics(allTime)
        if (m.ts >= startOfMonth) addMetrics(month)
        if (m.ts >= startOfWeek) addMetrics(week)
        if (m.ts >= startOfToday) addMetrics(today)

        const modelName = m.model
        const existingModel = modelStats.get(modelName) || {
          model: modelName,
          totalTokens: 0,
          input: 0,
          output: 0,
          messageCount: 0,
          cost: 0
        }
        existingModel.totalTokens += m.total
        existingModel.input += m.input
        existingModel.output += m.output
        existingModel.messageCount += 1
        existingModel.cost += m.cost
        modelStats.set(modelName, existingModel)

        if (m.ts > 0) {
          const d = new Date(m.ts)
          const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
          const dayBucket = recentDaysMap.get(dateKey)
          if (dayBucket) {
            dayBucket.totalTokens += m.total
            dayBucket.messageCount += 1
            dayBucket.conversations.add(usageData.sessionId)
          }
        }
      }
    }
  }

  today.conversationsCount = activeInToday.size
  week.conversationsCount = activeInWeek.size
  month.conversationsCount = activeInMonth.size
  allTime.conversationsCount = activeInAllTime.size

  const byModel = Array.from(modelStats.values()).sort((a, b) => b.totalTokens - a.totalTokens)
  const recentDays: DailyUsageStat[] = Array.from(recentDaysMap.entries()).map(([date, d]) => ({
    date,
    totalTokens: d.totalTokens,
    conversationsCount: d.conversations.size,
    messageCount: d.messageCount
  }))

  return {
    today,
    week,
    month,
    allTime,
    byModel,
    recentDays,
    updatedAt: Date.now()
  }
}
