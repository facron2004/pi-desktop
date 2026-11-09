import { createHash, randomBytes } from 'node:crypto'
import { constants, createReadStream, existsSync, readFileSync } from 'node:fs'
import { appendFile, chmod, lstat, mkdir, open, readdir, realpath, rename, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises'
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
import {
  EXTERNAL_CONTEXT_ENTRY,
  EXTERNAL_CONTEXT_CHECKED_ENTRY,
  EXTERNAL_CONTEXT_CLASSIFICATION_VERSION,
  EXTERNAL_CONTEXT_UNKNOWN_ENTRY,
  EXTERNAL_TOOL_OVERRIDE_ENTRY,
  LOCAL_TOOL_NAMES
} from './memory/policy'

/**
 * Bytes of one session a read may hold at once.
 *
 * A larger file is not dropped: its transcript is read from the tail, so the
 * newest conversation is still openable. Metadata comes from bounded windows
 * at both ends instead of the whole file.
 */
const MAX_SESSION_BYTES = 24 * 1024 * 1024
/** Maximum look-back when a trailing JSONL record consumes the whole tail window. */
const MAX_OVERSIZED_RECORD_SCAN_BYTES = 64 * 1024 * 1024
/** A long session's header and first prompt come from its head. */
const MAX_META_HEAD_BYTES = 2 * 1024 * 1024
/** Its newest name, model and timestamps come from its tail. */
const MAX_META_TAIL_BYTES = 1 * 1024 * 1024
const MAX_SEARCH_FILES = 240
/**
 * Bytes of one session a direct search reads.
 *
 * A shorter session is scanned in place; a longer one is searched through its
 * index, so the cap no longer decides whether its content is reachable.
 */
const MAX_SEARCH_FILE_BYTES = 8 * 1024 * 1024
/**
 * Bytes of source and searchable text one full-text search may process.
 *
 * A cold build can read 64 MB of source; a cold reload can read one 64 MB
 * sidecar. Both share the remaining allowance with extracted-text scanning.
 * The newest sessions are searched first, so this bounds an expensive query
 * that finds no hits.
 */
const MAX_SEARCH_TOTAL_BYTES = 128 * 1024 * 1024
/**
 * A session longer than this is searched through a per-session index.
 *
 * Building the index costs one pass over the JSONL; every later keystroke
 * scans only the user/assistant text, which is a fraction of the file. The
 * index is stored under the app's data folder and updated by reading the
 * appended region, so a growing conversation does not replay its history.
 */
const MAX_INDEX_FILE_BYTES = 64 * 1024 * 1024
/** Snapshots kept in memory, so a query does not re-read the index from disk. */
const MAX_CACHED_SEARCH_INDEXES = 8
/** A count cap alone lets eight large sessions retain over a gigabyte of text. */
const MAX_CACHED_SEARCH_INDEX_BYTES = 64 * 1024 * 1024
/** Persisted indexes are disposable; cap both their total size and file count. */
const MAX_SEARCH_INDEX_DISK_BYTES = 512 * 1024 * 1024
const MAX_SEARCH_INDEX_FILES = 512
/** A cold search never loads one index sidecar larger than the source scan window. */
const MAX_SEARCH_INDEX_FILE_BYTES = 64 * 1024 * 1024
/** A changed shape must rebuild instead of being read as the old one. */
const SEARCH_INDEX_VERSION = 7
const LF = 0x0a
const CR = 0x0d
const CHUNK_SIZE = 64 * 1024
const MAX_CACHE_ENTRIES = 2000
/** The usage cache keeps per-message projections, so bound it by source bytes as well as count. */
const MAX_USAGE_CACHE_SOURCE_BYTES = 32 * 1024 * 1024
const MAX_CACHED_SESSION_MESSAGE_FILES = 12
const MAX_CACHED_SESSION_MESSAGE_BYTES = 16 * 1024 * 1024

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
  identity: string
  mtime: number
  size: number
  meta: SessionMeta
}

interface SessionFileStats {
  size: number
  mtimeMs: number
  identity?: string
}

const sessionMetaCache = new Map<string, SessionCacheEntry>()
const inFlightReads = new Map<string, Promise<SessionMeta | null>>()
// Reuse messages parsed for the sidebar, while keeping memory bounded.
const sessionMessagesCache = new Map<
  string,
  {
    identity: string
    mtime: number
    size: number
    messages: AgentMessage[]
    externalContext: boolean
    contextChecked: boolean
  }
>()
let sessionMessagesCacheBytes = 0

interface CachedFileUsage {
  identity: string
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
let usageCacheSourceBytes = 0

function deleteCachedUsage(key: string): void {
  const cached = usageCache.get(key)
  if (!cached) return
  usageCache.delete(key)
  usageCacheSourceBytes = Math.max(0, usageCacheSourceBytes - cached.size)
}

function cacheUsage(key: string, value: CachedFileUsage): void {
  deleteCachedUsage(key)
  if (value.size > MAX_USAGE_CACHE_SOURCE_BYTES) return
  while (
    usageCache.size >= MAX_CACHE_ENTRIES ||
    usageCacheSourceBytes + value.size > MAX_USAGE_CACHE_SOURCE_BYTES
  ) {
    const oldestKey = usageCache.keys().next().value
    if (oldestKey === undefined) break
    deleteCachedUsage(oldestKey)
  }
  usageCache.set(key, value)
  usageCacheSourceBytes += value.size
}

export function getUsageCacheStats(): { entries: number; sourceBytes: number } {
  return { entries: usageCache.size, sourceBytes: usageCacheSourceBytes }
}

/** One searchable message of a large session, with the lower-case copy kept for queries. */
interface SearchIndexEntry {
  id?: string
  role: 'user' | 'assistant'
  /** Ordinal among user/assistant messages scanned into this index window. */
  index: number
  /** Byte offsets in the session JSONL, used to drop entries outside the tail window. */
  startOffset: number
  endOffset: number
  text: string
  lower: string
}

interface SearchIndexSnapshot {
  version: number
  /** Canonical path the index was built for. */
  file: string
  /** Filesystem identity prevents a same-size replacement reusing this index. */
  identity: string
  sessionId: string
  cwd: string
  name?: string
  preview: string
  /** End offset of the last complete JSONL record indexed by this snapshot. */
  indexedSize: number
  /** File size this snapshot was checked against, including any incomplete tail. */
  sourceSize: number
  /** Start of the indexed tail window in the source JSONL. */
  indexedFrom: number
  mtime: number
  /** User/assistant messages counted so far, including ones with no text. */
  messageIndex: number
  entries: SearchIndexEntry[]
}

interface SearchIndexLoad {
  snapshot: SearchIndexSnapshot | null
  /** Source JSONL bytes read to build or extend the index in this call. */
  sourceBytesRead: number
  /** Persisted index bytes loaded in this call. */
  indexBytesRead: number
}

/** Folder the index files live in; null means large sessions are not indexed. */
let searchIndexDir: string | null = null
const searchIndexCache = new Map<string, SearchIndexSnapshot>()
const searchIndexCacheWeights = new Map<string, number>()
let searchIndexCacheBytes = 0
const inFlightSearchIndexes = new Map<string, {
  size: number
  mtime: number
  task: Promise<SearchIndexLoad>
}>()
let searchIndexPruneQueue = Promise.resolve()
const activeSearchIndexTemps = new Set<string>()

function removeCachedSearchIndex(indexPath: string): void {
  searchIndexCache.delete(indexPath)
  const weight = searchIndexCacheWeights.get(indexPath)
  if (weight !== undefined) searchIndexCacheBytes = Math.max(0, searchIndexCacheBytes - weight)
  searchIndexCacheWeights.delete(indexPath)
}

function clearSearchIndexCache(): void {
  searchIndexCache.clear()
  searchIndexCacheWeights.clear()
  searchIndexCacheBytes = 0
}

function estimateSearchIndexMemory(snapshot: SearchIndexSnapshot): number {
  let bytes = 512 + (snapshot.file.length + snapshot.identity.length + snapshot.sessionId.length + snapshot.cwd.length) * 2
  if (snapshot.name) bytes += snapshot.name.length * 2
  bytes += snapshot.preview.length * 2
  for (const entry of snapshot.entries) {
    // Two UTF-16 string copies plus a conservative allowance for the entry and
    // its array/map bookkeeping.
    bytes += 256 + (entry.text.length + entry.lower.length + (entry.id?.length ?? 0)) * 2
  }
  return bytes
}

function cacheSearchIndex(indexPath: string, snapshot: SearchIndexSnapshot): void {
  removeCachedSearchIndex(indexPath)
  const weight = estimateSearchIndexMemory(snapshot)
  if (weight > MAX_CACHED_SEARCH_INDEX_BYTES) return

  while (
    searchIndexCache.size >= MAX_CACHED_SEARCH_INDEXES ||
    searchIndexCacheBytes + weight > MAX_CACHED_SEARCH_INDEX_BYTES
  ) {
    const oldest = searchIndexCache.keys().next().value
    if (oldest === undefined) break
    removeCachedSearchIndex(oldest)
  }
  searchIndexCache.set(indexPath, snapshot)
  searchIndexCacheWeights.set(indexPath, weight)
  searchIndexCacheBytes += weight
}

/** Cache footprint and active index-build count for diagnostics and tests. */
export function getSessionSearchIndexCacheStats(): { entries: number; estimatedBytes: number; inFlight: number } {
  return {
    entries: searchIndexCache.size,
    estimatedBytes: searchIndexCacheBytes,
    inFlight: inFlightSearchIndexes.size
  }
}

async function pruneSearchIndexDirectory(dir: string, maxBytes: number): Promise<void> {
  await secureSearchIndexDirectory(dir)
  let names
  try {
    names = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  const files: Array<{ file: string; size: number; mtimeMs: number }> = []
  for (const entry of names) {
    if (!entry.isFile() || (!entry.name.endsWith('.json') && !entry.name.endsWith('.tmp'))) continue
    const file = path.join(dir, entry.name)
    // A live writer still needs its temporary file for the atomic rename.
    if (activeSearchIndexTemps.has(file)) continue
    try {
      const info = await stat(file)
      if (info.isFile()) files.push({ file, size: info.size, mtimeMs: info.mtimeMs })
    } catch {
      /* a sidecar that vanished during the scan is already gone */
    }
  }

  let totalBytes = files.reduce((total, file) => total + file.size, 0)
  let remainingFiles = files.length
  if (totalBytes <= maxBytes && remainingFiles <= MAX_SEARCH_INDEX_FILES) return
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file))
  for (const file of files) {
    if (totalBytes <= maxBytes && remainingFiles <= MAX_SEARCH_INDEX_FILES) break
    try {
      await unlink(file.file)
      totalBytes -= file.size
      remainingFiles -= 1
      removeCachedSearchIndex(file.file)
    } catch {
      /* keep going; indexes are recoverable and pruning is best-effort */
    }
  }
}

/** Session text in an index is sensitive; keep existing sidecars owner-only. */
async function secureSearchIndexDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  await chmod(dir, 0o700).catch(() => {})
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isFile() || (!entry.name.endsWith('.json') && !entry.name.endsWith('.tmp'))) continue
    await chmod(path.join(dir, entry.name), 0o600).catch(() => {})
  }
}

/** A cold query can race startup pruning, so secure the sidecar before reading it. */
async function secureSearchIndexFile(indexPath: string): Promise<boolean> {
  if (process.platform === 'win32') return true
  try {
    const info = await lstat(indexPath)
    if (!info.isFile()) return false
    if ((info.mode & 0o077) !== 0) await chmod(indexPath, 0o600)
    const secured = await stat(indexPath)
    return (secured.mode & 0o077) === 0
  } catch {
    return false
  }
}

/** Prune disposable sidecars; the optional limit keeps the policy testable. */
export async function pruneSessionSearchIndexFiles(
  maxBytes = MAX_SEARCH_INDEX_DISK_BYTES
): Promise<void> {
  const dir = searchIndexDir
  if (!dir) return
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : MAX_SEARCH_INDEX_DISK_BYTES
  const task = searchIndexPruneQueue.then(() => pruneSearchIndexDirectory(dir, limit))
  searchIndexPruneQueue = task.catch(() => {})
  await task
}

/**
 * Point the large-session index at a folder (the app's own data folder).
 * Passing null turns indexing off, which is also how tests isolate themselves.
 */
export function configureSessionSearchIndex(dir: string | null): void {
  searchIndexDir = dir && dir.trim() ? path.resolve(dir.trim()) : null
  clearSearchIndexCache()
  inFlightSearchIndexes.clear()
  if (searchIndexDir) void pruneSessionSearchIndexFiles()
}

/** Best-effort removal of a session's index when its file goes away. */
export function forgetSessionSearchIndex(file: string): void {
  const indexPath = searchIndexPath(file)
  if (!indexPath) return
  removeCachedSearchIndex(indexPath)
  void unlink(indexPath).catch(() => {})
}

function searchIndexPath(file: string): string | null {
  if (!searchIndexDir) return null
  const digest = createHash('sha1').update(canonicalSessionFile(file)).digest('hex')
  return path.join(searchIndexDir, `${digest}.json`)
}

function homeDir(): string {
  return os.homedir()
}

function fileIdentity(stats: Pick<Stats, 'dev' | 'ino'>): string {
  return `${stats.dev}:${stats.ino}`
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

const SESSION_FILE_FLAGS = constants.O_NONBLOCK === undefined
  ? 'r'
  : constants.O_RDONLY | constants.O_NONBLOCK
const SESSION_FILE_WRITE_FLAGS = constants.O_RDWR | constants.O_APPEND |
  (constants.O_NONBLOCK ?? 0)

function isBelowDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
}

/** Open an IPC-supplied session file inside Pi's store, rejecting hard links that bypass containment. */
export async function openSessionFile(
  file: unknown,
  sessionRoot = resolveSessionRoot(),
  writable = false
): Promise<{ target: string; handle: FileHandle } | null> {
  if (
    typeof file !== 'string' ||
    !file ||
    typeof sessionRoot !== 'string' ||
    !sessionRoot.trim() ||
    !path.isAbsolute(file) ||
    path.extname(file).toLowerCase() !== '.jsonl'
  ) {
    return null
  }
  const root = path.resolve(sessionRoot)
  const target = path.resolve(file)
  if (!isBelowDirectory(root, target)) return null
  let handle: FileHandle | undefined
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)])
    if (
      !isBelowDirectory(realRoot, realTarget) ||
      path.extname(realTarget).toLowerCase() !== '.jsonl'
    ) return null
    const details = await stat(realTarget)
    if (!details.isFile() || details.nlink > 1) return null

    handle = await open(realTarget, writable ? SESSION_FILE_WRITE_FLAGS : SESSION_FILE_FLAGS)
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || opened.nlink > 1n) return null
    const [currentRoot, currentTarget] = await Promise.all([realpath(root), realpath(target)])
    if (
      currentRoot !== realRoot ||
      currentTarget !== realTarget ||
      !isBelowDirectory(currentRoot, currentTarget)
    ) return null
    const named = await stat(currentTarget, { bigint: true })
    if (opened.dev !== named.dev || opened.ino !== named.ino || named.nlink > 1n) return null

    const result = { target: realTarget, handle }
    handle = undefined
    return result
  } catch {
    return null
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

/** Resolve a renderer-supplied path only after opening and verifying its file identity. */
export async function resolveSessionFilePath(
  file: unknown,
  sessionRoot = resolveSessionRoot()
): Promise<string | null> {
  const opened = await openSessionFile(file, sessionRoot)
  if (!opened) return null
  await opened.handle.close().catch(() => {})
  return opened.target
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
  maxBytes = MAX_SESSION_BYTES,
  startOffset = 0,
  skipPartialFirst = startOffset > 0,
  handle?: FileHandle
): AsyncGenerator<string, void, void> {
  for await (const record of readJsonlRecords(file, maxBytes, startOffset, skipPartialFirst, handle)) {
    yield record.line
  }
}

interface JsonlRecord {
  line: string
  startOffset: number
  endOffset: number
  terminated: boolean
}

async function* readJsonlRecords(
  file: string,
  maxBytes: number,
  startOffset: number,
  skipPartialFirst: boolean,
  handle?: FileHandle
): AsyncGenerator<JsonlRecord, void, void> {
  const byteLimit = Math.floor(maxBytes)
  if (!Number.isFinite(byteLimit) || byteLimit <= 0) return

  let stream: ReturnType<typeof createReadStream> | undefined
  let chunks: AsyncIterable<Buffer | string>
  try {
    const options = {
      highWaterMark: CHUNK_SIZE,
      ...(startOffset > 0 ? { start: startOffset } : {}),
      end: startOffset + byteLimit - 1
    }
    if (handle) {
      chunks = readHandleChunks(handle, startOffset, byteLimit)
    } else {
      stream = createReadStream(file, options)
      chunks = stream
    }
  } catch {
    return
  }

  let pendingChunks: Buffer[] = []
  let pendingLength = 0
  let bufferStartOffset = startOffset
  // A window that starts mid-file begins in the middle of a line; that
  // fragment is not a whole record, so skip through its newline first. An
  // append read starts exactly at a line boundary and must keep its first line.
  let skipPartial = skipPartialFirst

  try {
    for await (const chunk of chunks) {
      const bufChunk = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
      let cursor = 0
      if (skipPartial) {
        const firstNewline = bufChunk.indexOf(LF)
        if (firstNewline === -1) {
          bufferStartOffset += bufChunk.length
          continue
        }
        cursor = firstNewline + 1
        bufferStartOffset += cursor
        skipPartial = false
      }

      while (cursor < bufChunk.length) {
        const newline = bufChunk.indexOf(LF, cursor)
        if (newline === -1) {
          const tail = bufChunk.subarray(cursor)
          pendingChunks.push(tail)
          pendingLength += tail.length
          break
        }

        const current = bufChunk.subarray(cursor, newline)
        const recordStart = bufferStartOffset
        const recordEnd = recordStart + pendingLength + current.length + 1
        let lineBuf: Buffer
        if (pendingLength === 0) {
          lineBuf = current
        } else {
          const parts = current.length > 0 ? [...pendingChunks, current] : pendingChunks
          lineBuf = parts.length === 1
            ? parts[0]!
            : Buffer.concat(parts, pendingLength + current.length)
        }
        pendingChunks = []
        pendingLength = 0
        bufferStartOffset = recordEnd
        if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === CR) {
          lineBuf = lineBuf.subarray(0, lineBuf.length - 1)
        }
        yield {
          line: lineBuf.toString('utf8'),
          startOffset: recordStart,
          endOffset: recordEnd,
          terminated: true
        }
        cursor = newline + 1
      }
    }

    if (pendingLength > 0) {
      const lineBuf = pendingChunks.length === 1
        ? pendingChunks[0]!
        : Buffer.concat(pendingChunks, pendingLength)
      let finalLine = lineBuf
      if (finalLine.length > 0 && finalLine[finalLine.length - 1] === CR) {
        finalLine = finalLine.subarray(0, finalLine.length - 1)
      }
      yield {
        line: finalLine.toString('utf8'),
        startOffset: bufferStartOffset,
        endOffset: bufferStartOffset + pendingLength,
        terminated: false
      }
    }
  } catch {
    return
  } finally {
    stream?.destroy()
  }
}

async function* readHandleChunks(
  handle: FileHandle,
  startOffset: number,
  byteLimit: number
): AsyncGenerator<Buffer, void, void> {
  let position = startOffset
  let remaining = byteLimit
  while (remaining > 0) {
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, remaining))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
    if (bytesRead === 0) return
    position += bytesRead
    remaining -= bytesRead
    yield buffer.subarray(0, bytesRead)
  }
}

/** Find the newline immediately before a bounded range, scanning backwards in small chunks. */
async function findPreviousNewline(
  file: string,
  beforeOffset: number,
  handle?: FileHandle
): Promise<number | null> {
  let ownedHandle: FileHandle | undefined
  try {
    const reader = handle ?? (ownedHandle = await open(file, 'r'))
    const floor = Math.max(0, beforeOffset - MAX_OVERSIZED_RECORD_SCAN_BYTES)
    let end = beforeOffset
    while (end > floor) {
      const start = Math.max(floor, end - CHUNK_SIZE)
      const buffer = Buffer.allocUnsafe(end - start)
      const { bytesRead } = await reader.read(buffer, 0, buffer.length, start)
      if (bytesRead !== buffer.length) return null
      const newline = buffer.lastIndexOf(LF)
      if (newline !== -1) return start + newline
      end = start
    }
  } catch {
    return null
  } finally {
    await ownedHandle?.close().catch(() => {})
  }
  return null
}

export function clearSessionCache(): void {
  sessionMetaCache.clear()
  sessionMessagesCache.clear()
  sessionMessagesCacheBytes = 0
  usageCache.clear()
  usageCacheSourceBytes = 0
  clearSearchIndexCache()
}

export function invalidateSessionCache(file?: string): void {
  if (file) {
    const key = canonicalSessionFile(file)
    sessionMetaCache.delete(key)
    deleteCachedSessionMessages(key)
    deleteCachedUsage(key)
  } else {
    sessionMetaCache.clear()
    sessionMessagesCache.clear()
    sessionMessagesCacheBytes = 0
    usageCache.clear()
    usageCacheSourceBytes = 0
  }
}

function deleteCachedSessionMessages(key: string): void {
  const cached = sessionMessagesCache.get(key)
  if (!cached) return
  sessionMessagesCacheBytes -= cached.size
  sessionMessagesCache.delete(key)
}

function cacheSessionMessages(
  file: string,
  fileStats: SessionFileStats,
  messages: AgentMessage[],
  externalContext = false,
  contextChecked = true
): void {
  const key = canonicalSessionFile(file)
  deleteCachedSessionMessages(key)
  if (!fileStats.identity || !messages.length || fileStats.size > MAX_CACHED_SESSION_MESSAGE_BYTES) return

  while (
    sessionMessagesCache.size >= MAX_CACHED_SESSION_MESSAGE_FILES ||
    sessionMessagesCacheBytes + fileStats.size > MAX_CACHED_SESSION_MESSAGE_BYTES
  ) {
    const oldestKey = sessionMessagesCache.keys().next().value
    if (!oldestKey) break
    deleteCachedSessionMessages(oldestKey)
  }

  sessionMessagesCache.set(key, {
    identity: fileStats.identity,
    mtime: fileStats.mtimeMs,
    size: fileStats.size,
    messages,
    externalContext,
    contextChecked
  })
  sessionMessagesCacheBytes += fileStats.size
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
export async function getSessionMeta(file: string, sessionRoot?: string): Promise<SessionMeta | null> {
  const key = canonicalSessionFile(file)
  const inFlightKey = sessionRoot ? `${key}\0${path.resolve(sessionRoot)}` : key
  const existing = inFlightReads.get(inFlightKey)
  if (existing) return existing

  const task = (async (): Promise<SessionMeta | null> => {
    const opened = sessionRoot ? await openSessionFile(file, sessionRoot) : null
    if (sessionRoot && !opened) {
      sessionMetaCache.delete(key)
      return null
    }
    try {
      const s = opened ? await opened.handle.stat() : await stat(file)
      const identity = fileIdentity(s)
      const cached = sessionMetaCache.get(key)
      if (cached && cached.identity === identity && cached.mtime === s.mtimeMs && cached.size === s.size) {
        return cached.meta
      }

      const meta = await parseSession(file, { size: s.size, mtimeMs: s.mtimeMs, identity }, opened?.handle)
      if (meta) {
        recordInCache(key, {
          identity,
          mtime: s.mtimeMs,
          size: s.size,
          meta
        })
      } else {
        sessionMetaCache.delete(key)
      }
      return meta
    } catch {
      sessionMetaCache.delete(key)
      return null
    } finally {
      if (opened) await opened.handle.close().catch(() => {})
    }
  })()

  inFlightReads.set(inFlightKey, task)
  try {
    return await task
  } finally {
    inFlightReads.delete(inFlightKey)
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

function messagesFromBranch(entries: BaseEntry[]): AgentMessage[] {
  const messages: AgentMessage[] = []
  for (const entry of entries) {
    if (entry.type !== 'message') continue
    const message = (entry as BaseEntry & { message?: AgentMessage }).message
    if (!message) continue
    const timestamp = message.timestamp
    messages.push({
      ...message,
      timestamp: typeof timestamp === 'number' ? timestamp : Date.parse(String(timestamp ?? '')) || Date.now()
    })
  }
  return messages
}

function hasExternalContext(entries: BaseEntry[]): boolean {
  return entries.some((entry) => {
    const record = entry as BaseEntry & { customType?: unknown; data?: unknown }
    if (record.type === 'custom' && record.customType === EXTERNAL_CONTEXT_ENTRY) return true
    if (record.type !== 'custom' || record.customType !== EXTERNAL_TOOL_OVERRIDE_ENTRY) return false
    if (!record.data || typeof record.data !== 'object') return false
    const data = record.data as { toolName?: unknown; toolNames?: unknown }
    const names = Array.isArray(data.toolNames) ? data.toolNames : [data.toolName]
    return names.some((toolName) =>
      typeof toolName === 'string' &&
      (LOCAL_TOOL_NAMES as readonly string[]).includes(toolName)
    )
  })
}

function hasExternalContextChecked(entries: BaseEntry[]): boolean {
  const lastMessageIndex = entries.reduce(
    (last, entry, index) => entry.type === 'message' ? index : last,
    -1
  )
  return entries.some((entry, index) => {
    const record = entry as BaseEntry & { customType?: unknown; data?: unknown }
    const data = record.data as { version?: unknown } | undefined
    return record.type === 'custom' &&
      record.customType === EXTERNAL_CONTEXT_CHECKED_ENTRY &&
      data?.version === EXTERNAL_CONTEXT_CLASSIFICATION_VERSION &&
      index > lastMessageIndex
  })
}

function hasExternalContextUnknown(entries: BaseEntry[]): boolean {
  return entries.some((entry) => {
    const record = entry as BaseEntry & { customType?: unknown }
    return record.type === 'custom' && record.customType === EXTERNAL_CONTEXT_UNKNOWN_ENTRY
  })
}

function hasLocalToolCall(entries: BaseEntry[]): boolean {
  return entries.some((entry) => {
    if (entry.type !== 'message') return false
    const message = (entry as BaseEntry & { message?: { content?: unknown } }).message
    if (!Array.isArray(message?.content)) return false
    return message.content.some((block) => {
      if (!block || typeof block !== 'object') return false
      const call = block as { type?: unknown; name?: unknown }
      return call.type === 'toolCall' &&
        typeof call.name === 'string' &&
        (LOCAL_TOOL_NAMES as readonly string[]).includes(call.name)
    })
  })
}

/**
 * Messages on the active branch, without starting Pi.
 * Compaction and bookkeeping entries stay out; the leaf walk already follows
 * the branch Pi would show.
 */
export interface SessionConversationRead {
  messages: AgentMessage[]
  externalContext: boolean
  contextChecked: boolean
}

/** Active-branch messages plus Pi Desktop's persisted tool-source classification. */
export async function readSessionConversation(
  file: string,
  handle?: FileHandle
): Promise<SessionConversationRead> {
  let fileStats: Stats
  try {
    fileStats = handle ? await handle.stat() : await stat(file)
  } catch {
    deleteCachedSessionMessages(canonicalSessionFile(file))
    return { messages: [], externalContext: false, contextChecked: false }
  }
  const identity = fileIdentity(fileStats)
  if (fileStats.size > MAX_SESSION_BYTES) {
    deleteCachedSessionMessages(canonicalSessionFile(file))
  }

  const key = canonicalSessionFile(file)
  const cached = sessionMessagesCache.get(key)
  if (
    cached && cached.identity === identity &&
    cached.mtime === fileStats.mtimeMs && cached.size === fileStats.size
  ) {
    sessionMessagesCache.delete(key)
    sessionMessagesCache.set(key, cached)
    return {
      messages: cached.messages,
      externalContext: cached.externalContext,
      contextChecked: cached.contextChecked
    }
  }
  if (cached) deleteCachedSessionMessages(key)

  const lines: string[] = []
  // A conversation too long to hold at once still opens: the newest window of
  // the file carries the recent branch. The branch walk stops where the
  // window starts, so the transcript begins mid-history instead of refusing.
  const windowStart = fileStats.size > MAX_SESSION_BYTES
    ? fileStats.size - MAX_SESSION_BYTES
    : 0
  for await (const line of readJsonlLines(file, MAX_SESSION_BYTES, windowStart, windowStart > 0, handle)) {
    lines.push(line)
  }
  if (!lines.length && windowStart > 0) {
    // If one final record is larger than the tail window, the partial record
    // is correctly skipped but there are no later records to show. Fall back
    // to the newest bounded window before that record so the conversation is
    // still usable without loading the oversized result into memory.
    const previousNewline = await findPreviousNewline(file, windowStart, handle)
    if (previousNewline !== null) {
      const endOffset = previousNewline + 1
      const startOffset = Math.max(0, endOffset - MAX_SESSION_BYTES)
      lines.length = 0
      for await (const line of readJsonlLines(
        file,
        endOffset - startOffset,
        startOffset,
        startOffset > 0,
        handle
      )) {
        lines.push(line)
      }
    }
  }
  if (!lines.length) return { messages: [], externalContext: false, contextChecked: false }
  const branch = activeBranch(lines)
  const messages = messagesFromBranch(branch)
  const externalContext = hasExternalContext(branch)
  const contextChecked = !hasExternalContextUnknown(branch) && (
    hasExternalContextChecked(branch) || (fileStats.size <= MAX_SESSION_BYTES && !hasLocalToolCall(branch))
  )
  cacheSessionMessages(
    file,
    { size: fileStats.size, mtimeMs: fileStats.mtimeMs, identity },
    messages,
    externalContext,
    contextChecked
  )
  return { messages, externalContext, contextChecked }
}

export async function readSessionMessages(file: string, handle?: FileHandle): Promise<AgentMessage[]> {
  return (await readSessionConversation(file, handle)).messages
}

/**
 * Name a cold session by appending one `session_info` entry, the same record
 * Pi writes. Refuses a missing file. The caller must already know that no
 * runtime is writing this JSONL.
 */
export async function appendSessionName(
  file: string,
  name: string,
  handle?: FileHandle
): Promise<boolean> {
  const sanitized = name.replace(/[\r\n]+/g, ' ').trim()
  if (!sanitized) return false
  let fileStats: Stats
  try {
    fileStats = handle ? await handle.stat() : await stat(file)
    if (!fileStats.isFile()) return false
  } catch {
    return false
  }
  const size = fileStats.size

  // The new entry's parent is the current leaf, which sits at the end of the
  // file. Reading a long session's head would attach the rename to a node
  // from the middle of its history and split the active branch.
  let windowBytes = size > MAX_SESSION_BYTES ? MAX_META_TAIL_BYTES : MAX_SESSION_BYTES
  let lines: string[] = []
  while (true) {
    const windowStart = Math.max(0, size - windowBytes)
    lines = []
    for await (const line of readJsonlLines(file, windowBytes, windowStart, windowStart > 0, handle)) {
      lines.push(line)
    }
    if (lines.length || windowBytes >= MAX_SESSION_BYTES) break
    windowBytes = Math.min(MAX_SESSION_BYTES, windowBytes * 2)
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
  const serialized = `${JSON.stringify(entry)}\n`
  if (handle) {
    const current = await handle.stat()
    if (current.size !== fileStats.size || current.mtimeMs !== fileStats.mtimeMs) return false
    await handle.appendFile(serialized, 'utf8')
  } else {
    await appendFile(file, serialized, 'utf8')
  }
  invalidateSessionCache(file)
  return true
}

/**
 * Metadata for a session too long to parse whole.
 *
 * The header and the opening prompt sit at the top; renames, the newest model
 * and the timestamp sit at the bottom. Reading both ends keeps a long
 * conversation visible in the sidebar and the archive list without parsing —
 * or holding — its middle. `messageCount` counts the messages in those two
 * windows; it only feeds the "nothing cached yet" check and the archive row.
 */
export async function parseLargeSessionMeta(
  file: string,
  size: number,
  mtimeMs: number,
  handle?: FileHandle
): Promise<SessionMeta | null> {
  let header: SessionHeader | null = null
  let name: string | undefined
  let preview = ''
  let model: string | undefined
  let messageCount = 0
  let lastTimestamp = ''

  const scan = (raw: string): void => {
    const line = raw.trim()
    if (!line) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object') return
    const record = parsed as BaseEntry & {
      message?: { role?: string; content?: unknown; model?: string }
    }
    if (record.type === 'session') {
      if (!header) header = record as unknown as SessionHeader
      return
    }
    if (record.type === 'session_info') {
      const value = (record as unknown as { name?: string }).name
      if (value) name = value
      return
    }
    if (record.type === 'model_change') {
      const change = record as unknown as { provider?: string; modelId?: string }
      if (change.modelId) model = change.provider ? `${change.provider}/${change.modelId}` : change.modelId
      return
    }
    if (record.type !== 'message' || !record.message) return
    const message = record.message
    if (message.role === 'user') {
      messageCount += 1
      if (!preview) preview = extractText(message.content).trim()
    } else if (message.role === 'assistant') {
      messageCount += 1
      if (!model && message.model) model = message.model
    } else if (message.role === 'toolResult' || message.role === 'bashExecution') {
      messageCount += 1
    }
    const stamp = (record as { timestamp?: unknown }).timestamp
    if (typeof stamp === 'string') lastTimestamp = stamp
  }

  for await (const line of readJsonlLines(file, MAX_META_HEAD_BYTES, 0, false, handle)) scan(line)
  // `scan` assigns through a closure, so the flow analysis cannot see that the
  // header may be set; read it back through a cast instead of a null check it
  // would treat as impossible.
  const sessionHeader = header as SessionHeader | null
  if (!sessionHeader) return null
  // Only read the tail when it does not overlap the head, so a small file
  // (tests, an unusually compact session) is not counted twice.
  const tailStart = Math.max(0, size - MAX_META_TAIL_BYTES)
  if (tailStart > MAX_META_HEAD_BYTES) {
    for await (const line of readJsonlLines(file, MAX_META_TAIL_BYTES, tailStart, true, handle)) scan(line)
  }

  return {
    id: sessionHeader.id,
    file,
    cwd: sessionHeader.cwd ?? '',
    name,
    preview: preview.replace(/\s+/g, ' ').slice(0, 120),
    updatedAt: Math.max(Date.parse(lastTimestamp) || 0, mtimeMs),
    messageCount,
    model
  }
}

export async function parseSession(
  file: string,
  fileStats?: SessionFileStats,
  handle?: FileHandle
): Promise<SessionMeta | null> {
  let stats = fileStats
  if (!stats) {
    try {
      const s = await stat(file)
      stats = { size: s.size, mtimeMs: s.mtimeMs, identity: fileIdentity(s) }
    } catch {
      return null
    }
  }
  if (!stats.identity) {
    try {
      const s = handle ? await handle.stat() : await stat(file)
      stats = { ...stats, identity: fileIdentity(s) }
    } catch {
      /* parsing can still return metadata, but its messages will not be cached */
    }
  }
  if (stats.size > MAX_SESSION_BYTES) {
    return await parseLargeSessionMeta(file, stats.size, stats.mtimeMs, handle)
  }

  let header: SessionHeader | null = null
  const entries: BaseEntry[] = []

  for await (const raw of readJsonlLines(file, MAX_SESSION_BYTES, 0, false, handle)) {
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
  if (stats.size <= MAX_CACHED_SESSION_MESSAGE_BYTES) {
    const externalContext = hasExternalContext(branch)
    const contextChecked = !hasExternalContextUnknown(branch) && (
      hasExternalContextChecked(branch) || !hasLocalToolCall(branch)
    )
    cacheSessionMessages(
      file,
      stats,
      messagesFromBranch(branch),
      externalContext,
      contextChecked
    )
  } else {
    deleteCachedSessionMessages(canonicalSessionFile(file))
  }

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
      const meta = await getSessionMeta(file, root)
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
        const meta = await getSessionMeta(file, root)
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
 * search stops once it has enough hits or has spent its byte budget.
 */
export async function searchSessions(
  query: string,
  limit = 30,
  options: { budgetBytes?: number; shouldStop?: () => boolean } = {}
): Promise<SessionSearchHit[]> {
  const needle = query.trim()
  if (needle.length < 2) return []
  const needleLower = needle.toLowerCase()
  const ceiling = Math.min(Math.max(limit, 1), 100)
  const budget = Math.max(0, options.budgetBytes ?? MAX_SEARCH_TOTAL_BYTES)
  const shouldStop = () => options.shouldStop?.() === true
  if (shouldStop()) return []
  const root = resolveSessionRoot()
  try {
    const rootStat = await stat(root)
    if (!rootStat.isDirectory()) return []
  } catch {
    return []
  }

  const candidates: { file: string; mtime: number; size: number }[] = []
  let workspaceDirs: string[]
  if (shouldStop()) return []
  try {
    const entries = await readdir(root, { withFileTypes: true })
    workspaceDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }

  for (const dir of workspaceDirs) {
    if (shouldStop()) return []
    const folder = path.join(root, dir)
    let names: string[]
    try {
      names = await readdir(folder)
    } catch {
      continue
    }
    for (const name of names) {
      if (shouldStop()) return []
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(folder, name)
      const opened = await openSessionFile(file, root)
      if (!opened) continue
      try {
        const s = await opened.handle.stat()
        candidates.push({ file, mtime: s.mtimeMs, size: s.size })
      } catch {
        /* a file that vanished is not a search result */
      } finally {
        await opened.handle.close().catch(() => {})
      }
    }
  }
  if (shouldStop()) return []
  candidates.sort((a, b) => b.mtime - a.mtime)

  const hits: SessionSearchHit[] = []
  let bytesRead = 0
  for (const candidate of candidates.slice(0, MAX_SEARCH_FILES)) {
    // A newer query supersedes this one: stop at the next file boundary so a
    // burst of keystrokes does not leave several scans running at once.
    if (shouldStop()) break
    if (hits.length >= ceiling) break
    const opened = await openSessionFile(candidate.file, root)
    if (!opened) continue
    try {
      if (shouldStop()) continue
      const stats = await opened.handle.stat()
      const remaining = budget - bytesRead
      if (remaining <= 0) break
      // A long session is searched through its index: the first query pays for
      // one pass over the file, and later keystrokes scan only the extracted
      // message text. Without an index folder (tests) the direct scan remains.
      if (stats.size > MAX_SEARCH_FILE_BYTES && searchIndexDir) {
        const indexed = await searchIndexedSession(
          candidate.file,
          fileIdentity(stats),
          stats.mtimeMs,
          stats.size,
          needleLower,
          needle.length,
          ceiling - hits.length,
          remaining,
          opened.handle
        )
        bytesRead += indexed.workBytes
        if (indexed.usedIndex) {
          hits.push(...indexed.hits)
          continue
        }
      }
      // An index attempt may already have spent part of the budget reading its
      // sidecar. Charge the direct fallback against the remainder, never the
      // stale amount from before that attempt.
      const directRemaining = budget - bytesRead
      if (directRemaining <= 0) break
      const readLimit = Math.min(stats.size, MAX_SEARCH_FILE_BYTES, directRemaining)
      bytesRead += readLimit
      const fileHits = await searchSessionFile(
        candidate.file,
        stats.mtimeMs,
        needleLower,
        needle.length,
        ceiling - hits.length,
        readLimit,
        opened.handle
      )
      hits.push(...fileHits)
    } finally {
      await opened.handle.close().catch(() => {})
    }
  }
  return hits
}

/** The text a hit shows around the match, flattened to one line. */
function snippetAround(
  text: string,
  at: number,
  needleLength: number
): { snippet: string; matchStart: number; matchLength: number } {
  const windowStart = Math.max(0, at - 70)
  const windowEnd = Math.min(text.length, at + needleLength + 90)
  const prefix = text.slice(windowStart, at).replace(/\s+/g, ' ')
  const matched = text.slice(at, at + needleLength).replace(/\s+/g, ' ')
  const suffix = text.slice(at + needleLength, windowEnd).replace(/\s+/g, ' ')
  return { snippet: `${prefix}${matched}${suffix}`, matchStart: prefix.length, matchLength: matched.length }
}

/** Read one session file and collect the matching messages of any branch. */
async function searchSessionFile(
  file: string,
  mtime: number,
  needleLower: string,
  needleLength: number,
  remaining: number,
  maxBytes: number = MAX_SEARCH_FILE_BYTES,
  handle?: FileHandle
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

  for await (const raw of readJsonlLines(file, maxBytes, 0, false, handle)) {
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
    const snippet = snippetAround(text, at, needleLength)
    if (seenSnippets.has(snippet.snippet)) continue
    seenSnippets.add(snippet.snippet)
    hits.push({
      file,
      sessionId,
      name,
      preview,
      cwd,
      updatedAt: mtime,
      role: message.role,
      snippet: snippet.snippet,
      matchStart: snippet.matchStart,
      matchLength: snippet.matchLength,
      messageIndex
    })
    // Two rows from one conversation say enough about why it matched.
    if (hits.length >= Math.min(remaining, 2)) break
  }
  return hits
}

interface SearchIndexScan {
  sessionId: string
  cwd: string
  name?: string
  preview: string
  messageIndex: number
  entries: SearchIndexEntry[]
}

/**
 * Fold one JSONL record into the index.
 *
 * `knownIds` is passed while extending: a file that grew during the previous
 * read makes the append start before bytes that were already indexed, and the
 * ids keep those records from being counted twice.
 */
function scanIndexRecord(
  raw: string,
  state: SearchIndexScan,
  startOffset: number,
  endOffset: number,
  knownIds?: Set<string>
): void {
  const line = raw.trim()
  if (!line) return
  let record: Record<string, unknown>
  try {
    record = JSON.parse(line) as Record<string, unknown>
  } catch {
    return
  }
  if (!record || typeof record !== 'object') return

  if (record.type === 'session') {
    if (typeof record.id === 'string') state.sessionId = record.id
    if (typeof record.cwd === 'string') state.cwd = record.cwd
    return
  }
  if (record.type === 'session_info') {
    const value = record.name
    if (typeof value === 'string' && value.trim()) state.name = value.trim()
    return
  }
  if (record.type !== 'message' || !record.message) return

  const message = record.message as { role?: string; content?: unknown }
  if (message.role !== 'user' && message.role !== 'assistant') return
  const id = typeof record.id === 'string' ? record.id : undefined
  if (id && knownIds?.has(id)) return

  state.messageIndex += 1
  const text = searchableText(message.content)
  if (!text) return
  if (!state.preview && message.role === 'user') {
    state.preview = text.replace(/\s+/g, ' ').slice(0, 120)
  }
  state.entries.push({
    id,
    role: message.role,
    index: state.messageIndex,
    startOffset,
    endOffset,
    text,
    lower: text.toLowerCase()
  })
  if (id) knownIds?.add(id)
}

async function readSearchIndexFile(
  indexPath: string,
  maxReadBytes: number
): Promise<{ snapshot: SearchIndexSnapshot | null; indexBytesRead: number; skipped: boolean }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let indexBytesRead = 0
  try {
    if (!(await secureSearchIndexFile(indexPath))) {
      return { snapshot: null, indexBytesRead: 0, skipped: false }
    }
    handle = await open(indexPath, 'r')
    const stats = await handle.stat()
    if (!stats.isFile()) return { snapshot: null, indexBytesRead: 0, skipped: false }
    if (stats.size > MAX_SEARCH_INDEX_FILE_BYTES) {
      await handle.close()
      handle = undefined
      await unlink(indexPath).catch(() => {})
      return { snapshot: null, indexBytesRead: 0, skipped: false }
    }
    if (stats.size >= maxReadBytes) return { snapshot: null, indexBytesRead: 0, skipped: true }

    const buffer = Buffer.alloc(stats.size)
    let totalRead = 0
    while (totalRead < buffer.length) {
      const { bytesRead } = await handle.read(buffer, totalRead, buffer.length - totalRead, totalRead)
      if (bytesRead === 0) break
      totalRead += bytesRead
    }
    indexBytesRead = totalRead
    if (totalRead !== buffer.length) return { snapshot: null, indexBytesRead, skipped: false }

    const parsed = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>
    if (!parsed || parsed.version !== SEARCH_INDEX_VERSION || !Array.isArray(parsed.entries)) {
      return { snapshot: null, indexBytesRead, skipped: false }
    }
    if (
      typeof parsed.identity !== 'string' ||
      typeof parsed.indexedSize !== 'number' ||
      typeof parsed.sourceSize !== 'number' ||
      typeof parsed.indexedFrom !== 'number' ||
      typeof parsed.mtime !== 'number' ||
      parsed.indexedFrom < 0 ||
      parsed.indexedFrom > parsed.indexedSize ||
      parsed.sourceSize < parsed.indexedSize
    ) return { snapshot: null, indexBytesRead, skipped: false }
    const entries: SearchIndexEntry[] = []
    for (const raw of parsed.entries) {
      if (!raw || typeof raw !== 'object') continue
      const entry = raw as Partial<SearchIndexEntry>
      if (
        (entry.role !== 'user' && entry.role !== 'assistant') ||
        typeof entry.text !== 'string' ||
        typeof entry.lower !== 'string' ||
        typeof entry.index !== 'number' ||
        typeof entry.startOffset !== 'number' ||
        typeof entry.endOffset !== 'number' ||
        entry.startOffset < parsed.indexedFrom ||
        entry.endOffset < entry.startOffset ||
        entry.endOffset > parsed.indexedSize
      ) {
        continue
      }
      entries.push({
        id: typeof entry.id === 'string' ? entry.id : undefined,
        role: entry.role,
        index: entry.index,
        startOffset: entry.startOffset,
        endOffset: entry.endOffset,
        text: entry.text,
        lower: entry.lower
      })
    }
    const lastIndex = entries.length ? entries[entries.length - 1].index : 0
    return {
      snapshot: {
        version: SEARCH_INDEX_VERSION,
        file: typeof parsed.file === 'string' ? parsed.file : '',
        identity: parsed.identity,
        sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : '',
        cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
        name: typeof parsed.name === 'string' ? parsed.name : undefined,
        preview: typeof parsed.preview === 'string' ? parsed.preview : '',
        indexedSize: parsed.indexedSize,
        sourceSize: parsed.sourceSize,
        indexedFrom: parsed.indexedFrom,
        mtime: parsed.mtime,
        messageIndex: typeof parsed.messageIndex === 'number' ? parsed.messageIndex : lastIndex,
        entries
      },
      indexBytesRead,
      skipped: false
    }
  } catch {
    return { snapshot: null, indexBytesRead, skipped: false }
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

async function writeSearchIndexFile(indexPath: string, snapshot: SearchIndexSnapshot): Promise<void> {
  if (estimateSearchIndexMemory(snapshot) > MAX_SEARCH_INDEX_FILE_BYTES) {
    await unlink(indexPath).catch(() => {})
    return
  }
  const serialized = JSON.stringify(snapshot)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SEARCH_INDEX_FILE_BYTES) {
    await unlink(indexPath).catch(() => {})
    return
  }
  const temp = `${indexPath}.${randomBytes(4).toString('hex')}.tmp`
  activeSearchIndexTemps.add(temp)
  try {
    const directory = path.dirname(indexPath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(directory, 0o700).catch(() => {})
    await writeFile(temp, serialized, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, indexPath)
    await pruneSessionSearchIndexFiles()
  } catch {
    // An index is an optimization: a read-only or full folder must not fail a search.
    await unlink(temp).catch(() => {})
  } finally {
    activeSearchIndexTemps.delete(temp)
  }
}

/**
 * Bring a snapshot up to the last complete record in the file.
 *
 * A same-size snapshot is already current. A snapshot that only trails the
 * file is extended from its last complete JSONL boundary. A missing, foreign,
 * truncated or far-behind one is rebuilt from the newest window. An
 * unterminated tail is left for the next read, so an append that completes it
 * is parsed as one record instead of starting in the middle of the JSON.
 */
async function updateSearchIndex(
  file: string,
  indexPath: string,
  base: SearchIndexSnapshot | null,
  identity: string,
  size: number,
  mtime: number,
  indexBytesRead: number,
  handle: FileHandle
): Promise<SearchIndexLoad> {
  const canonical = canonicalSessionFile(file)
  if (base && base.identity === identity && base.sourceSize === size && base.mtime === mtime) {
    return { snapshot: base, sourceBytesRead: 0, indexBytesRead }
  }

  let state: SearchIndexScan
  let readBytes: number
  let indexedFrom: number
  let indexedSize = 0
  if (
    base &&
    base.file === canonical &&
    base.identity === identity &&
    base.indexedSize < size &&
    size - base.indexedSize <= MAX_INDEX_FILE_BYTES
  ) {
    state = {
      sessionId: base.sessionId || path.basename(file, '.jsonl'),
      cwd: base.cwd,
      name: base.name,
      preview: base.preview,
      messageIndex: base.messageIndex,
      entries: base.entries.slice()
    }
    indexedFrom = base.indexedFrom
    indexedSize = base.indexedSize
    const knownIds = new Set<string>()
    for (const entry of base.entries) if (entry.id) knownIds.add(entry.id)
    for await (const record of readJsonlRecords(
      file,
      size - base.indexedSize,
      base.indexedSize,
      false,
      handle
    )) {
      if (!record.terminated) break
      scanIndexRecord(record.line, state, record.startOffset, record.endOffset, knownIds)
      indexedSize = record.endOffset
    }
    readBytes = size - base.indexedSize
    const windowStart = Math.max(0, size - MAX_INDEX_FILE_BYTES)
    if (windowStart > indexedFrom) {
      state.entries = state.entries.filter((entry) => entry.startOffset >= windowStart)
      indexedFrom = windowStart
    }
  } else {
    const windowStart = size > MAX_INDEX_FILE_BYTES ? size - MAX_INDEX_FILE_BYTES : 0
    indexedFrom = windowStart
    state = {
      sessionId: path.basename(file, '.jsonl'),
      cwd: '',
      preview: '',
      messageIndex: 0,
      entries: []
    }
    for await (const record of readJsonlRecords(
      file,
      MAX_INDEX_FILE_BYTES,
      windowStart,
      windowStart > 0,
      handle
    )) {
      if (!record.terminated) break
      scanIndexRecord(record.line, state, record.startOffset, record.endOffset)
      indexedSize = record.endOffset
    }
    // The search window can start after Pi's header and opening prompt. Read
    // the same bounded metadata windows as the sidebar so cold indexes retain
    // the conversation's real project, name and preview.
    const metadata = await parseLargeSessionMeta(file, size, mtime, handle)
    if (metadata) {
      state.sessionId = metadata.id || state.sessionId
      state.cwd = metadata.cwd || state.cwd
      state.name = state.name ?? metadata.name
      state.preview = metadata.preview || state.preview
    }
    if (indexedSize === 0) indexedFrom = 0
    readBytes = size - windowStart + searchIndexMetadataReadBytes(size)
  }

  const snapshot: SearchIndexSnapshot = {
    version: SEARCH_INDEX_VERSION,
    file: canonical,
    identity,
    ...state,
    indexedSize,
    sourceSize: size,
    indexedFrom,
    mtime
  }
  await writeSearchIndexFile(indexPath, snapshot)
  return { snapshot, sourceBytesRead: readBytes, indexBytesRead }
}

async function ensureSearchIndex(
  file: string,
  identity: string,
  size: number,
  mtime: number,
  maxWorkBytes: number,
  handle: FileHandle
): Promise<SearchIndexLoad> {
  const indexPath = searchIndexPath(file)
  if (!indexPath) return { snapshot: null, sourceBytesRead: 0, indexBytesRead: 0 }
  const inFlightKey = `${indexPath}\0${identity}`
  while (true) {
    const cached = searchIndexCache.get(indexPath)
    if (cached && cached.identity === identity && cached.sourceSize === size && cached.mtime === mtime) {
      searchIndexCache.delete(indexPath)
      searchIndexCache.set(indexPath, cached)
      return { snapshot: cached, sourceBytesRead: 0, indexBytesRead: 0 }
    }

    const pending = inFlightSearchIndexes.get(inFlightKey)
    if (pending) {
      const load = await pending.task
      if (pending.size === size && pending.mtime === mtime) return load
      // A newer file version arrived during the build. Wait for the old writer
      // to finish, then rebuild or extend its snapshot against this version.
      if (inFlightSearchIndexes.get(inFlightKey) === pending) {
        inFlightSearchIndexes.delete(inFlightKey)
      }
      continue
    }

    const task = (async (): Promise<SearchIndexLoad> => {
      const cachedAppend = cached?.file === canonicalSessionFile(file) &&
        cached.identity === identity &&
        cached.indexedSize < size &&
        size - cached.indexedSize <= MAX_INDEX_FILE_BYTES
        ? cached
        : null
      const stored = cachedAppend ? null : await readSearchIndexFile(indexPath, maxWorkBytes)
      if (stored?.skipped) {
        return { snapshot: null, sourceBytesRead: 0, indexBytesRead: 0 }
      }
      const storedSnapshot = stored?.snapshot?.identity === identity ? stored.snapshot : null
      const base = cachedAppend ?? storedSnapshot
      const indexBytesRead = stored?.indexBytesRead ?? 0
      const sourceBytesEstimate = estimatedSearchIndexSourceReadBytes(file, identity, size, mtime, base)
      if (indexBytesRead + sourceBytesEstimate >= maxWorkBytes) {
        return { snapshot: null, sourceBytesRead: 0, indexBytesRead }
      }
      return await updateSearchIndex(file, indexPath, base, identity, size, mtime, indexBytesRead, handle)
    })()
    const build = { size, mtime, task }
    inFlightSearchIndexes.set(inFlightKey, build)
    try {
      const load = await task
      if (load.snapshot) {
        cacheSearchIndex(indexPath, load.snapshot)
      }
      return load
    } finally {
      if (inFlightSearchIndexes.get(inFlightKey) === build) {
        inFlightSearchIndexes.delete(inFlightKey)
      }
    }
  }
}

function estimatedSearchIndexSourceReadBytes(
  file: string,
  identity: string,
  size: number,
  mtime: number,
  base: SearchIndexSnapshot | null
): number {
  if (base && base.identity === identity && base.sourceSize === size && base.mtime === mtime) return 0
  if (
    base &&
    base.file === canonicalSessionFile(file) &&
    base.identity === identity &&
    base.indexedSize < size &&
    size - base.indexedSize <= MAX_INDEX_FILE_BYTES
  ) {
    return size - base.indexedSize
  }
  return Math.min(size, MAX_INDEX_FILE_BYTES) + searchIndexMetadataReadBytes(size)
}

/** Source bytes read for the bounded header and tail metadata pass. */
function searchIndexMetadataReadBytes(size: number): number {
  const headBytes = Math.min(size, MAX_META_HEAD_BYTES)
  const tailStart = Math.max(0, size - MAX_META_TAIL_BYTES)
  return headBytes + (tailStart > MAX_META_HEAD_BYTES ? MAX_META_TAIL_BYTES : 0)
}

/** Search a large session through its index; the first call builds it. */
async function searchIndexedSession(
  file: string,
  identity: string,
  mtime: number,
  size: number,
  needleLower: string,
  needleLength: number,
  remaining: number,
  maxWorkBytes: number,
  handle: FileHandle
): Promise<{ hits: SessionSearchHit[]; workBytes: number; usedIndex: boolean }> {
  const load = await ensureSearchIndex(file, identity, size, mtime, maxWorkBytes, handle)
  const loadedBytes = load.sourceBytesRead + load.indexBytesRead
  if (!load.snapshot) {
    return { hits: [], workBytes: loadedBytes, usedIndex: false }
  }
  if (loadedBytes >= maxWorkBytes) {
    return { hits: [], workBytes: loadedBytes, usedIndex: false }
  }
  const snapshot = load.snapshot
  const hits: SessionSearchHit[] = []
  const seenSnippets = new Set<string>()
  let scanned = 0
  const scanBudget = Math.max(0, maxWorkBytes - loadedBytes)
  for (const entry of snapshot.entries) {
    const remainingScan = scanBudget - scanned
    if (remainingScan <= 0) break
    const entryBytes = Math.min(entry.lower.length, remainingScan)
    const searchable = entryBytes < entry.lower.length
      ? entry.lower.slice(0, entryBytes)
      : entry.lower
    const at = searchable.indexOf(needleLower)
    scanned += entryBytes
    if (at === -1) {
      if (entryBytes < entry.lower.length) break
      continue
    }
    const snippet = snippetAround(entry.text, at, needleLength)
    if (seenSnippets.has(snippet.snippet)) continue
    seenSnippets.add(snippet.snippet)
    hits.push({
      file,
      sessionId: snapshot.sessionId || path.basename(file, '.jsonl'),
      name: snapshot.name,
      preview: snapshot.preview,
      cwd: snapshot.cwd,
      updatedAt: mtime,
      role: entry.role,
      snippet: snippet.snippet,
      matchStart: snippet.matchStart,
      matchLength: snippet.matchLength,
      messageIndex: entry.index
    })
    // Two rows from one conversation say enough about why it matched.
    if (hits.length >= Math.min(remaining, 2)) break
    if (entryBytes < entry.lower.length) break
  }
  return { hits, workBytes: loadedBytes + scanned, usedIndex: true }
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

  const createDailyBuckets = (count: number) => {
    const buckets = new Map<
      string,
      {
        totalTokens: number
        input: number
        output: number
        cacheRead: number
        cacheWrite: number
        cost: number
        conversations: Set<string>
        messageCount: number
      }
    >()
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      buckets.set(key, {
        totalTokens: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        conversations: new Set(),
        messageCount: 0
      })
    }
    return buckets
  }
  const recentDaysMap = createDailyBuckets(7)
  const heatmapDaysMap = createDailyBuckets(365)
  const toDailyStats = (days: typeof recentDaysMap): DailyUsageStat[] =>
    Array.from(days.entries()).map(([date, d]) => ({
      date,
      totalTokens: d.totalTokens,
      conversationsCount: d.conversations.size,
      messageCount: d.messageCount,
      input: d.input,
      output: d.output,
      cacheRead: d.cacheRead,
      cacheWrite: d.cacheWrite,
      cost: d.cost
    }))

  const recordActivity = (sessionId: string, ts: number) => {
    if (ts >= startOfToday) activeInToday.add(sessionId)
    if (ts >= startOfWeek) activeInWeek.add(sessionId)
    if (ts >= startOfMonth) activeInMonth.add(sessionId)
  }

  const recordMetric = (sessionId: string, m: CachedFileUsage['metrics'][number]) => {
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
      for (const days of [recentDaysMap, heatmapDaysMap]) {
        const dayBucket = days.get(dateKey)
        if (dayBucket) {
          dayBucket.totalTokens += m.total
          dayBucket.input += m.input
          dayBucket.output += m.output
          dayBucket.cacheRead += m.cacheRead
          dayBucket.cacheWrite += m.cacheWrite
          dayBucket.cost += m.cost
          dayBucket.messageCount += 1
          dayBucket.conversations.add(sessionId)
        }
      }
    }
  }

  const applyUsageData = (data: CachedFileUsage) => {
    activeInAllTime.add(data.sessionId)
    for (const ts of data.timestamps) recordActivity(data.sessionId, ts)
    for (const metric of data.metrics) recordMetric(data.sessionId, metric)
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
      recentDays: toDailyStats(recentDaysMap),
      heatmapDays: toDailyStats(heatmapDaysMap),
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
      const opened = await openSessionFile(fullPath, root)
      if (!opened) continue

      const key = canonicalSessionFile(fullPath)
      const sessionId = file.replace(/\.jsonl$/, '')
      let usageData = usageCache.get(key)

      try {
        const s = await opened.handle.stat()
        if (!s.isFile()) {
          deleteCachedUsage(key)
          continue
        }

        const identity = fileIdentity(s)
        const cacheable = s.size <= MAX_USAGE_CACHE_SOURCE_BYTES
        if (
          cacheable &&
          usageData?.identity === identity &&
          usageData.mtime === s.mtimeMs &&
          usageData.size === s.size
        ) {
          usageCache.delete(key)
          usageCache.set(key, usageData)
        } else {
          deleteCachedUsage(key)
          usageData = undefined
          const timestamps: number[] | undefined = cacheable ? [] : undefined
          const metrics: CachedFileUsage['metrics'] | undefined = cacheable ? [] : undefined

          for await (const raw of readJsonlLines(opened.target, s.size, 0, false, opened.handle)) {
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

              if (ts > 0) {
                if (timestamps) timestamps.push(ts)
                else recordActivity(sessionId, ts)
              }

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

                const metric = {
                  ts,
                  model: msg.model || 'Unknown',
                  input,
                  output,
                  cacheRead,
                  cacheWrite,
                  total,
                  cost
                }
                if (metrics) metrics.push(metric)
                else recordMetric(sessionId, metric)
              }
            } catch {
              // ignore malformed line
            }
          }

          if (cacheable) {
            usageData = {
              identity,
              mtime: s.mtimeMs,
              size: s.size,
              sessionId,
              timestamps: timestamps!,
              metrics: metrics!
            }
            cacheUsage(key, usageData)
          } else {
            activeInAllTime.add(sessionId)
          }
        }
      } catch {
        continue
      } finally {
        await opened.handle.close().catch(() => {})
      }

      if (usageData) applyUsageData(usageData)
    }
  }

  today.conversationsCount = activeInToday.size
  week.conversationsCount = activeInWeek.size
  month.conversationsCount = activeInMonth.size
  allTime.conversationsCount = activeInAllTime.size

  const byModel = Array.from(modelStats.values()).sort((a, b) => b.totalTokens - a.totalTokens)
  return {
    today,
    week,
    month,
    allTime,
    byModel,
    recentDays: toDailyStats(recentDaysMap),
    heatmapDays: toDailyStats(heatmapDaysMap),
    updatedAt: Date.now()
  }
}
