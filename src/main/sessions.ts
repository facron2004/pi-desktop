import { createHash, randomBytes } from 'node:crypto'
import { constants, createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, realpath, rename, stat, unlink, type FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { StringDecoder } from 'node:string_decoder'
import os from 'node:os'
import path from 'node:path'
import {
  GOAL_CONTINUE_CUSTOM_TYPE,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SIDE_CHAT_REFERENCES,
  MAX_SIDE_CHAT_SNIPPET_CHARS,
  SIDE_CHAT_DIR_NAME,
  SIDE_CHAT_META_ENTRY_TYPE,
  SIDE_CHAT_TURN_META_ENTRY_TYPE,
  TASK_MODE_STATUS_KEY,
  isSideSessionKey
} from '@shared/types'
import { isAgentMode, readGoalState } from '@shared/task-mode-state'
import type {
  AgentMessage,
  AggregatedUsageStats,
  DailyUsageStat,
  ModelUsageStat,
  PeriodUsage,
  SessionMeta,
  SessionSearchHit,
  SessionTaskMode,
  SideChatReference,
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
// Bound concurrent candidate metadata lookups during full-history search.
const MAX_CONCURRENT_SEARCH_CANDIDATE_READS = 16
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
const SEARCH_INDEX_SCAN_CHUNK_CHARS = 1024 * 1024
/** A changed shape must rebuild instead of being read as the old one. */
const SEARCH_INDEX_VERSION = 8
const SEARCH_INDEX_FILE_MAGIC = `pi-desktop-search-index-v${SEARCH_INDEX_VERSION}\n`
const LF = 0x0a
const CR = 0x0d
const CHUNK_SIZE = 64 * 1024
const MAX_CACHE_ENTRIES = 2000
const MAX_CONCURRENT_SESSION_META_READS = 4
/** Workspace folders listed at once; each folder still caps its own file reads. */
const MAX_CONCURRENT_WORKSPACE_DIRECTORIES = 4
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
  SessionConversationRead & {
    identity: string
    mtime: number
    size: number
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

type SearchIndexHeader = Omit<SearchIndexSnapshot, 'entries' | 'messageIndex'> & {
  messageIndex?: number
}

class SearchIndexTooLargeError extends Error {}

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
  cancellation: { cancelled: boolean }
}>()
let searchIndexPruneQueue = Promise.resolve()
let autoPruneWritesSinceLastPrune = 0
let lastAutoPruneAt = 0
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
  autoPruneWritesSinceLastPrune = 0
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
  for (const build of inFlightSearchIndexes.values()) build.cancellation.cancelled = true
  inFlightSearchIndexes.clear()
  if (searchIndexDir) void pruneSessionSearchIndexFiles()
}

/** Remove a session's index after any active writer has exited. */
export async function forgetSessionSearchIndex(file: string): Promise<void> {
  const indexPath = searchIndexPath(file)
  if (!indexPath) return
  removeCachedSearchIndex(indexPath)
  const inFlightPrefix = `${indexPath}\0`
  const pending: Promise<SearchIndexLoad>[] = []
  for (const [key, build] of inFlightSearchIndexes) {
    if (!key.startsWith(inFlightPrefix)) continue
    build.cancellation.cancelled = true
    pending.push(build.task)
  }
  await Promise.allSettled(pending)
  for (const [key, build] of inFlightSearchIndexes) {
    if (key.startsWith(inFlightPrefix) && build.cancellation.cancelled) {
      inFlightSearchIndexes.delete(key)
    }
  }
  await unlink(indexPath).catch(() => {})
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
let cachedSessionRootSetting: { file: string; version: string; root: string } | undefined

function settingsFileVersionKey(file: string): string {
  try {
    const s = statSync(file, { bigint: true, throwIfNoEntry: false })
    return s ? `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` : 'missing'
  } catch {
    return 'error'
  }
}

export function resolveSessionRoot(customDir?: string): string {
  if (customDir && customDir.trim()) return path.resolve(customDir.trim())
  const fromEnv = process.env.PI_CODING_AGENT_SESSION_DIR
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim())

  const home = homeDir()
  const settingsFile = path.join(home, '.pi', 'agent', 'settings.json')
  const version = settingsFileVersionKey(settingsFile)
  if (
    cachedSessionRootSetting &&
    cachedSessionRootSetting.file === settingsFile &&
    cachedSessionRootSetting.version === version
  ) {
    return cachedSessionRootSetting.root
  }

  let root = path.join(home, '.pi', 'agent', 'sessions')
  try {
    if (version !== 'missing' && existsSync(settingsFile)) {
      const raw = JSON.parse(readFileSync(settingsFile, 'utf8')) as { sessionDir?: string }
      if (raw.sessionDir && raw.sessionDir.trim()) root = path.resolve(raw.sessionDir.trim())
    }
  } catch {
    /* fall through to the default location */
  }
  cachedSessionRootSetting = { file: settingsFile, version, root }
  return root
}

let configuredExternalSessionRoots: (() => readonly string[]) | undefined

/** Read custom chat folders configured in app settings. */
export function configureExternalSessionRoots(getRoots: () => readonly string[]): void {
  configuredExternalSessionRoots = getRoots
}

/** Current and previous custom chat folders plus Pi's configured root. */
export function resolveSessionRoots(customDir?: string): string[] {
  const rawRoots = [
    customDir?.trim(),
    ...(configuredExternalSessionRoots?.() ?? []),
    resolveSessionRoot()
  ]
  const seen = new Set<string>()
  const unique: string[] = []
  for (const item of rawRoots) {
    const trimmed = item?.trim()
    if (!trimmed) continue
    const resolved = path.resolve(trimmed)
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(resolved)
  }
  return unique
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
  sessionRoot: string | readonly string[] = resolveSessionRoots(),
  writable = false,
  preResolvedRoot?: string
): Promise<{ target: string; handle: FileHandle } | null> {
  if (Array.isArray(sessionRoot)) {
    for (const root of sessionRoot) {
      const opened = await openSessionFile(file, root, writable)
      if (opened) return opened
    }
    return null
  }
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
    const [realRoot, realTarget] = preResolvedRoot
      ? [preResolvedRoot, await realpath(target)]
      : await Promise.all([realpath(root), realpath(target)])
    if (
      !isBelowDirectory(realRoot, realTarget) ||
      path.extname(realTarget).toLowerCase() !== '.jsonl'
    ) return null
    const details = await stat(realTarget)
    if (!details.isFile() || details.nlink > 1) return null

    handle = await open(realTarget, writable ? SESSION_FILE_WRITE_FLAGS : SESSION_FILE_FLAGS)
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || opened.nlink > 1n) return null
    const currentTarget = await realpath(target)
    const currentRoot = preResolvedRoot ?? await realpath(root)
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
  sessionRoot: string | readonly string[] = resolveSessionRoots()
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
  conversation: SessionConversationRead
): void {
  const key = canonicalSessionFile(file)
  deleteCachedSessionMessages(key)
  if (!fileStats.identity || !conversation.messages.length || fileStats.size > MAX_CACHED_SESSION_MESSAGE_BYTES) return

  while (
    sessionMessagesCache.size >= MAX_CACHED_SESSION_MESSAGE_FILES ||
    sessionMessagesCacheBytes + fileStats.size > MAX_CACHED_SESSION_MESSAGE_BYTES
  ) {
    const oldestKey = sessionMessagesCache.keys().next().value
    if (!oldestKey) break
    deleteCachedSessionMessages(oldestKey)
  }

  sessionMessagesCache.set(key, {
    ...conversation,
    identity: fileStats.identity,
    mtime: fileStats.mtimeMs,
    size: fileStats.size
  })
  sessionMessagesCacheBytes += fileStats.size
}

export function getSessionCacheSize(): number {
  return sessionMetaCache.size
}

function recordInCache(key: string, entry: SessionCacheEntry): void {
  if (sessionMetaCache.has(key)) {
    sessionMetaCache.delete(key)
  } else if (sessionMetaCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = sessionMetaCache.keys().next().value
    if (oldestKey) sessionMetaCache.delete(oldestKey)
  }
  sessionMetaCache.set(key, entry)
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Bound the sessions parsed at once across every caller.
 *
 * The per-directory workers below make the global listing faster, but a
 * medium session is held as parsed entries for its whole branch, so sixteen
 * 20 MB files at once would be a memory spike, not a speed-up. Opening and
 * stat-ing still run concurrently; only the parse waits for a slot.
 */
let activeMetaParses = 0
const metaParseWaiters: Array<() => void> = []

async function withMetaParseSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeMetaParses >= MAX_CONCURRENT_SESSION_META_READS) {
    await new Promise<void>((resolve) => metaParseWaiters.push(resolve))
  } else {
    activeMetaParses += 1
  }
  try {
    return await task()
  } finally {
    // Hand the slot straight to the next waiter, so a reader that resumed on
    // the same tick cannot push the count past the limit.
    const next = metaParseWaiters.shift()
    if (next) next()
    else activeMetaParses -= 1
  }
}

/**
 * Returns metadata for a session file from an already-verified open handle,
 * reusing the incremental (identity, mtime, size) LRU cache when valid.
 */
export async function getSessionMetaFromHandle(
  file: string,
  handle: FileHandle,
  knownStats?: Stats
): Promise<SessionMeta | null> {
  const key = canonicalSessionFile(file)
  const s = knownStats ?? await handle.stat()
  const identity = fileIdentity(s)
  const cached = sessionMetaCache.get(key)
  if (cached && cached.identity === identity && cached.mtime === s.mtimeMs && cached.size === s.size) {
    sessionMetaCache.delete(key)
    sessionMetaCache.set(key, cached)
    return cached.meta
  }

  const meta = await withMetaParseSlot(() =>
    parseSession(file, { size: s.size, mtimeMs: s.mtimeMs, identity }, handle, { cacheMessages: false })
  )
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
}

/** Verify containment & regular single-link status using one `lstat` when directory is already verified. */
async function statCachedSessionFile(
  file: string,
  sessionRoot?: string | readonly string[],
  dirAlreadyVerified = false
): Promise<Stats | null> {
  if (path.extname(file).toLowerCase() !== '.jsonl') return null
  if (sessionRoot && !dirAlreadyVerified) {
    if (!path.isAbsolute(file)) return null
    const roots = Array.isArray(sessionRoot) ? sessionRoot : [sessionRoot]
    const target = path.resolve(file)
    try {
      const parentReal = await realpath(path.dirname(target))
      let inside = false
      for (const root of roots) {
        if (typeof root !== 'string' || !root.trim()) continue
        const rootReal = await realpath(path.resolve(root)).catch(() => null)
        if (rootReal && isBelowDirectory(rootReal, path.join(parentReal, path.basename(target)))) {
          inside = true
          break
        }
      }
      if (!inside) return null
    } catch {
      return null
    }
  }
  try {
    const s = await lstat(file)
    if (s.isSymbolicLink() || !s.isFile() || s.nlink > 1) return null
    return s
  } catch {
    return null
  }
}

/**
 * Returns metadata for a session file, reusing the incremental (mtime, size) cache
 * when valid and coalescing in-flight concurrent reads.
 */
export async function getSessionMeta(
  file: string,
  sessionRoot?: string | readonly string[],
  preResolvedRoot?: string,
  dirAlreadyVerified = false
): Promise<SessionMeta | null> {
  const key = canonicalSessionFile(file)
  const inFlightKey = sessionRoot ? `${key}\0${JSON.stringify(sessionRoot)}` : key
  const existing = inFlightReads.get(inFlightKey)
  if (existing) return existing

  const task = (async (): Promise<SessionMeta | null> => {
    const cached = sessionMetaCache.get(key)
    if (cached) {
      const fastStats = await statCachedSessionFile(file, sessionRoot, dirAlreadyVerified)
      if (
        fastStats &&
        cached.identity === fileIdentity(fastStats) &&
        cached.mtime === fastStats.mtimeMs &&
        cached.size === fastStats.size
      ) {
        sessionMetaCache.delete(key)
        sessionMetaCache.set(key, cached)
        return cached.meta
      }
    }

    const opened = sessionRoot
      ? await openSessionFile(file, sessionRoot, false, typeof sessionRoot === 'string' ? preResolvedRoot : undefined)
      : null
    if (sessionRoot && !opened) {
      sessionMetaCache.delete(key)
      return null
    }
    try {
      const s = opened ? await opened.handle.stat() : await stat(file)
      const identity = fileIdentity(s)
      const latestCached = sessionMetaCache.get(key)
      if (latestCached && latestCached.identity === identity && latestCached.mtime === s.mtimeMs && latestCached.size === s.size) {
        sessionMetaCache.delete(key)
        sessionMetaCache.set(key, latestCached)
        return latestCached.meta
      }

      const meta = await withMetaParseSlot(() =>
        parseSession(file, { size: s.size, mtimeMs: s.mtimeMs, identity }, opened?.handle, { cacheMessages: false })
      )
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

function parseSessionTreeEntry(raw: string): TreeEntry | undefined {
  const line = raw.trim()
  if (!line) return
  try {
    const parsed = JSON.parse(line) as TreeEntry
    if (parsed && typeof parsed === 'object' && parsed.type) return parsed
  } catch {
    /* a torn line is not a message */
  }
}

function activeBranch(lines: string[], leafId?: string): TreeEntry[] {
  const entries: TreeEntry[] = []
  for (const line of lines) {
    const entry = parseSessionTreeEntry(line)
    if (entry && entry.type !== 'session') entries.push(entry)
  }
  return branchFromEntries(entries, leafId)
}

/** Active-branch entries, leaf first in the walk and then reversed into order. */
function branchFromEntries(entries: TreeEntry[], leafId?: string): TreeEntry[] {
  const parentIds = new Set<string>()
  const byId = new Map<string, TreeEntry>()
  for (const entry of entries) {
    if (!entry.id) continue
    byId.set(entry.id, entry)
    if (entry.parentId) parentIds.add(entry.parentId)
  }
  let leaf = leafId ? byId.get(leafId) : undefined
  if (!leafId) {
    for (const entry of entries) {
      if (entry.id && !parentIds.has(entry.id)) leaf = entry
    }
    leaf ??= entries.at(-1)
  }
  const branch: TreeEntry[] = []
  const seen = new Set<string>()
  let cursor = leaf
  while (cursor && cursor.id && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    branch.push(cursor)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  branch.reverse()
  return branch
}

async function readEarlierBranch(
  file: string,
  leafId: string,
  beforeOffset: number,
  handle: FileHandle | undefined,
  shouldStop?: () => boolean
): Promise<TreeEntry[]> {
  // Follow the saved parent, even when a long abandoned branch separates it
  // from the tail. Test one bounded window at a time.
  while (beforeOffset > 0 && !shouldStop?.()) {
    const start = Math.max(0, beforeOffset - MAX_SESSION_BYTES)
    // Include the preceding byte so a record starting exactly at start is kept.
    const readStart = Math.max(0, start - 1)
    const lines: string[] = []
    let firstRecordStart: number | undefined
    for await (const record of readJsonlRecords(file, beforeOffset - readStart, readStart, start > 0, handle)) {
      if (shouldStop?.()) return []
      if (!record.terminated) continue
      firstRecordStart ??= record.startOffset
      lines.push(record.line)
      if (lines.length % 256 === 0) await yieldToEventLoop()
    }
    const branch = activeBranch(lines, leafId)
    if (branch.length) return branch
    // The skipped partial record can be complete in the preceding window.
    beforeOffset = firstRecordStart ?? start
  }
  return []
}

function parseSideChatReferences(raw: unknown): SideChatReference[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const valid: SideChatReference[] = []
  for (const item of raw) {
    if (valid.length >= MAX_SIDE_CHAT_REFERENCES) break
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const rec = item as Record<string, unknown>
    if (typeof rec.id !== 'string' || !rec.id || typeof rec.sourceMainKey !== 'string' || !rec.sourceMainKey) {
      continue
    }
    const kind = rec.kind
    if (kind === 'selection') {
      const source = rec.source
      if (
        (source === 'user' || source === 'assistant' || source === 'tool' || source === 'thinking') &&
        typeof rec.snippet === 'string'
      ) {
        valid.push({
          id: rec.id,
          kind: 'selection',
          sourceMainKey: rec.sourceMainKey,
          ...(typeof rec.turnId === 'string' ? { turnId: rec.turnId } : {}),
          ...(typeof rec.messageId === 'string' ? { messageId: rec.messageId } : {}),
          source,
          snippet: rec.snippet.slice(0, MAX_SIDE_CHAT_SNIPPET_CHARS)
        })
      }
    } else if (kind === 'turn') {
      if (typeof rec.turnId === 'string' && typeof rec.turnOrdinal === 'number' && typeof rec.preview === 'string') {
        valid.push({
          id: rec.id,
          kind: 'turn',
          sourceMainKey: rec.sourceMainKey,
          turnId: rec.turnId,
          turnOrdinal: rec.turnOrdinal,
          ...(typeof rec.assistantMessageId === 'string' ? { assistantMessageId: rec.assistantMessageId } : {}),
          preview: rec.preview.slice(0, MAX_SIDE_CHAT_SNIPPET_CHARS)
        })
      }
    } else if (kind === 'tool') {
      const status = rec.status
      if (
        typeof rec.toolCallId === 'string' &&
        typeof rec.toolName === 'string' &&
        typeof rec.summary === 'string' &&
        (status === 'proposed' || status === 'running' || status === 'ok' || status === 'error' || status === 'aborted')
      ) {
        valid.push({
          id: rec.id,
          kind: 'tool',
          sourceMainKey: rec.sourceMainKey,
          ...(typeof rec.turnId === 'string' ? { turnId: rec.turnId } : {}),
          toolCallId: rec.toolCallId,
          toolName: rec.toolName,
          summary: rec.summary.slice(0, MAX_SIDE_CHAT_SNIPPET_CHARS),
          status
        })
      }
    } else if (kind === 'error') {
      if (typeof rec.message === 'string') {
        valid.push({
          id: rec.id,
          kind: 'error',
          sourceMainKey: rec.sourceMainKey,
          ...(typeof rec.turnId === 'string' ? { turnId: rec.turnId } : {}),
          ...(typeof rec.title === 'string' ? { title: rec.title } : {}),
          message: rec.message.slice(0, MAX_SIDE_CHAT_SNIPPET_CHARS)
        })
      }
    } else if (kind === 'file-diff') {
      if (typeof rec.filePath === 'string') {
        const range = rec.lineRange
        const lineRange =
          range &&
          typeof range === 'object' &&
          !Array.isArray(range) &&
          typeof (range as Record<string, unknown>).start === 'number' &&
          typeof (range as Record<string, unknown>).end === 'number'
            ? {
                start: (range as { start: number }).start,
                end: (range as { end: number }).end
              }
            : undefined
        valid.push({
          id: rec.id,
          kind: 'file-diff',
          sourceMainKey: rec.sourceMainKey,
          filePath: rec.filePath,
          ...(lineRange ? { lineRange } : {}),
          ...(typeof rec.snippet === 'string' ? { snippet: rec.snippet.slice(0, MAX_SIDE_CHAT_SNIPPET_CHARS) } : {})
        })
      }
    }
  }
  return valid.length > 0 ? valid : undefined
}

function hasUpcomingUserMessageBeforeAssistant(entries: BaseEntry[], fromIndex: number): boolean {
  for (let i = fromIndex + 1; i < entries.length; i += 1) {
    const candidate = entries[i]!
    if (
      candidate.type === 'custom' &&
      (candidate as BaseEntry & { customType?: unknown }).customType === SIDE_CHAT_TURN_META_ENTRY_TYPE
    ) {
      return false
    }
    if (candidate.type !== 'message') continue
    const msg = (candidate as BaseEntry & { message?: AgentMessage }).message
    if (!msg) continue
    if (msg.role === 'user') return true
    if (msg.role === 'assistant') return false
  }
  return false
}

function messagesFromBranch(entries: BaseEntry[]): AgentMessage[] {
  const messages: AgentMessage[] = []
  let pendingSideRefs: SideChatReference[] | undefined
  let unansweredUserIndex = -1

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (entry.type === 'custom') {
      const custom = entry as BaseEntry & { customType?: unknown; data?: unknown }
      if (
        custom.customType === SIDE_CHAT_TURN_META_ENTRY_TYPE &&
        custom.data &&
        typeof custom.data === 'object'
      ) {
        const refs = parseSideChatReferences((custom.data as { references?: unknown }).references)
        if (refs) {
          if (hasUpcomingUserMessageBeforeAssistant(entries, index)) {
            pendingSideRefs = refs
          } else if (unansweredUserIndex >= 0 && !messages[unansweredUserIndex]?.sideRefs) {
            messages[unansweredUserIndex] = { ...messages[unansweredUserIndex]!, sideRefs: refs }
          } else {
            pendingSideRefs = refs
          }
        }
      }
      continue
    }
    if (entry.type === 'custom_message') {
      const custom = entry as BaseEntry & {
        customType?: unknown
        content?: AgentMessage['content']
        display?: unknown
        details?: unknown
      }
      if (custom.customType !== GOAL_CONTINUE_CUSTOM_TYPE) continue
      const timestamp = custom.timestamp
      messages.push({
        role: 'custom',
        customType: GOAL_CONTINUE_CUSTOM_TYPE,
        content: custom.content ?? '',
        display: typeof custom.display === 'boolean' ? custom.display : false,
        ...(custom.details !== undefined ? { details: custom.details } : {}),
        ...(custom.id ? { entryId: custom.id } : {}),
        timestamp: typeof timestamp === 'number' ? timestamp : Date.parse(String(timestamp ?? '')) || Date.now()
      })
      continue
    }
    if (entry.type !== 'message') continue
    const message = (entry as BaseEntry & { message?: AgentMessage }).message
    if (!message) continue
    const timestamp = message.timestamp
    const isUser = message.role === 'user'
    const attachedSideRefs = isUser ? pendingSideRefs ?? message.sideRefs : undefined
    if (isUser) pendingSideRefs = undefined
    messages.push({
      ...message,
      ...(isUser && typeof entry.id === 'string' ? { entryId: entry.id } : {}),
      ...(attachedSideRefs ? { sideRefs: attachedSideRefs } : {}),
      timestamp: typeof timestamp === 'number' ? timestamp : Date.parse(String(timestamp ?? '')) || Date.now()
    })
    if (isUser) {
      unansweredUserIndex = messages.length - 1
    } else if (message.role === 'assistant') {
      unansweredUserIndex = -1
    }
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
  taskMode?: SessionTaskMode
}

export interface SessionConversationWindowRead extends SessionConversationRead {
  historyTruncated: boolean
}

export interface ReadSessionOptions {
  shouldStop?: () => boolean
}

function taskModeFromBranch(branch: BaseEntry[]): SessionTaskMode | undefined {
  const entry = branch.findLast((item) =>
    item.type === 'custom' && (item as { customType?: unknown }).customType === TASK_MODE_STATUS_KEY
  )
  const data = (entry as { data?: unknown } | undefined)?.data
  if (!data || typeof data !== 'object') return
  const { mode, goal: savedGoal } = data as Record<string, unknown>
  const goal = readGoalState(savedGoal)
  return { mode: isAgentMode(mode) ? mode : 'default', ...(goal ? { goal } : {}) }
}

/** Active-branch messages plus Pi Desktop's persisted tool-source classification. */
export async function readSessionConversation(
  file: string,
  handle?: FileHandle,
  options?: ReadSessionOptions
): Promise<SessionConversationWindowRead> {
  let fileStats: Stats
  try {
    fileStats = handle ? await handle.stat() : await stat(file)
  } catch {
    deleteCachedSessionMessages(canonicalSessionFile(file))
    return { messages: [], externalContext: false, contextChecked: false, historyTruncated: false }
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
      contextChecked: cached.contextChecked,
      ...(cached.taskMode ? { taskMode: cached.taskMode } : {}),
      historyTruncated: fileStats.size > MAX_SESSION_BYTES
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
  let firstRecordStart = windowStart
  for await (const record of readJsonlRecords(file, MAX_SESSION_BYTES, windowStart, windowStart > 0, handle)) {
    if (options?.shouldStop?.()) {
      return { messages: [], externalContext: false, contextChecked: false, historyTruncated: false }
    }
    if (!lines.length) firstRecordStart = record.startOffset
    lines.push(record.line)
    if (lines.length % 256 === 0) {
      await yieldToEventLoop()
      if (options?.shouldStop?.()) {
        return { messages: [], externalContext: false, contextChecked: false, historyTruncated: false }
      }
    }
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
        if (options?.shouldStop?.()) {
          return { messages: [], externalContext: false, contextChecked: false, historyTruncated: false }
        }
        lines.push(line)
        if (lines.length % 256 === 0) {
          await yieldToEventLoop()
          if (options?.shouldStop?.()) {
            return { messages: [], externalContext: false, contextChecked: false, historyTruncated: false }
          }
        }
      }
    }
  }
  if (!lines.length) {
    return {
      messages: [],
      externalContext: false,
      contextChecked: false,
      historyTruncated: windowStart > 0
    }
  }
  let branch = activeBranch(lines)
  let messages = messagesFromBranch(branch)
  const missingParent = branch[0]?.parentId
  if (!messages.length && windowStart > 0 && missingParent) {
    lines.length = 0
    const earlier = await readEarlierBranch(file, missingParent, firstRecordStart, handle, options?.shouldStop)
    branch = [...earlier, ...branch]
    messages = messagesFromBranch(branch)
  }
  const externalContext = hasExternalContext(branch)
  const contextChecked = !hasExternalContextUnknown(branch) && (
    hasExternalContextChecked(branch) || (fileStats.size <= MAX_SESSION_BYTES && !hasLocalToolCall(branch))
  )
  const taskMode = taskModeFromBranch(branch)
  const conversation = { messages, externalContext, contextChecked, ...(taskMode ? { taskMode } : {}) }
  cacheSessionMessages(file, { size: fileStats.size, mtimeMs: fileStats.mtimeMs, identity }, conversation)
  return { ...conversation, historyTruncated: windowStart > 0 }
}

export async function readSessionMessages(
  file: string,
  handle?: FileHandle,
  options?: ReadSessionOptions
): Promise<AgentMessage[]> {
  return (await readSessionConversation(file, handle, options)).messages
}

/**
 * Read up to the head window (`MAX_META_HEAD_BYTES`) for auto-title generation,
 * reusing `sessionMessagesCache` on cache hits without evicting live threads.
 */
export async function readSessionHeadMessages(file: string, handle?: FileHandle): Promise<AgentMessage[]> {
  let fileStats: Stats
  try {
    fileStats = handle ? await handle.stat() : await stat(file)
  } catch {
    return []
  }
  const key = canonicalSessionFile(file)
  const identity = fileIdentity(fileStats)
  const cached = sessionMessagesCache.get(key)
  if (
    cached && cached.identity === identity &&
    cached.mtime === fileStats.mtimeMs && cached.size === fileStats.size
  ) {
    return cached.messages
  }

  const lines: string[] = []
  let sawUser = false
  let sawAssistant = false
  for await (const line of readJsonlLines(file, MAX_META_HEAD_BYTES, 0, false, handle)) {
    lines.push(line)
    if (lines.length % 256 === 0) await yieldToEventLoop()
    // Once we have the header + first user + first assistant reply on a young
    // file, stop early unless the file already fits easily in memory.
    if (!sawAssistant && line.includes('"role"')) {
      try {
        const record = JSON.parse(line) as { type?: string; message?: { role?: string } }
        if (record.type === 'message') {
          if (record.message?.role === 'user') sawUser = true
          else if (sawUser && record.message?.role === 'assistant') sawAssistant = true
        }
      } catch {
        /* ignore malformed line */
      }
    }
    if (sawUser && sawAssistant && fileStats.size > MAX_META_HEAD_BYTES) break
  }
  if (!lines.length) return []
  const branch = activeBranch(lines)
  const messages = messagesFromBranch(branch)
  if (messages.length > 0) return messages
  // If head lines didn't form a single connected leaf branch (e.g. truncated fork),
  // extract linear message records cleanly.
  const linear: AgentMessage[] = []
  for (const raw of lines) {
    try {
      const parsed = JSON.parse(raw) as TreeEntry
      if (parsed?.type === 'message' && parsed.message) linear.push(parsed.message)
    } catch {
      /* ignore malformed line */
    }
  }
  return linear
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
  const writer = handle ?? await open(file, SESSION_FILE_WRITE_FLAGS).catch(() => null)
  if (!writer) return false
  try {
    const fileStats = await writer.stat().catch(() => null)
    if (!fileStats?.isFile() || fileStats.size === 0) return false
    const size = fileStats.size
    const byte = Buffer.allocUnsafe(1)
    const maxBytes = Math.min(size, MAX_SESSION_BYTES)
    let windowBytes = size > MAX_SESSION_BYTES ? MAX_META_TAIL_BYTES : maxBytes
    let leaf: TreeEntry | undefined
    let separator = ''
    while (true) {
      const start = size - windowBytes
      if (start > 0 && (await writer.read(byte, 0, 1, start - 1)).bytesRead !== 1) return false
      const lines: string[] = []
      let last: JsonlRecord | undefined
      for await (const record of readJsonlRecords(file, windowBytes, start, start > 0 && byte[0] !== LF, writer)) {
        lines.push(record.line)
        last = record
      }
      if (last?.endOffset === size) {
        separator = last.terminated ? '' : '\n'
        leaf = activeBranch(lines).at(-1)
        if (leaf) break
        if (start === 0) {
          // A header-only session can be named without a parent entry.
          try {
            if (JSON.parse(lines.find(line => line.trim())?.trim() ?? 'null')?.type !== 'session') return false
          } catch {
            return false
          }
          break
        }
      }
      // A torn line or a blank line is not the leaf. Expand until the tail
      // contains a valid entry, or leave a file beyond the read budget alone.
      if (windowBytes === maxBytes) return false
      windowBytes = Math.min(maxBytes, windowBytes * 2)
    }

    const entry = {
      type: 'session_info',
      id: randomBytes(4).toString('hex'),
      parentId: leaf?.id ?? null,
      timestamp: new Date().toISOString(),
      name: sanitized
    }
    const current = await writer.stat()
    if (current.size !== fileStats.size || current.mtimeMs !== fileStats.mtimeMs) return false
    await writer.appendFile(`${separator}${JSON.stringify(entry)}\n`, 'utf8')
    invalidateSessionCache(file)
    return true
  } finally {
    if (!handle) await writer.close().catch(() => {})
  }
}

/**
 * Metadata for a session too long to parse whole.
 *
 * The header and the opening prompt sit at the top; renames, the newest model
 * and the timestamp sit at the bottom. Reading both ends keeps a long
 * conversation visible in the sidebar and the archive list. If the visible
 * branch was rewound, follow its saved parents before reporting its metadata.
 * `messageCount` counts the messages in the windows we inspected.
 */
export async function parseLargeSessionMeta(
  file: string,
  size: number,
  mtimeMs: number,
  handle?: FileHandle
): Promise<SessionMeta | null> {
  let name: string | undefined
  let preview = ''
  let model: string | undefined
  let messageCount = 0
  let lastTimestamp = ''

  const scan = (record: TreeEntry): void => {
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

  const head: TreeEntry[] = []
  let sessionHeader: SessionHeader | undefined
  for await (const line of readJsonlLines(file, MAX_META_HEAD_BYTES, 0, false, handle)) {
    const entry = parseSessionTreeEntry(line)
    if (entry?.type === 'session') sessionHeader ??= entry as unknown as SessionHeader
    else if (entry) head.push(entry)
  }
  if (!sessionHeader) return null
  // Only read the tail when it does not overlap the head, so a small file
  // (tests, an unusually compact session) is not counted twice.
  const tail: TreeEntry[] = []
  const tailStart = Math.max(0, size - MAX_META_TAIL_BYTES)
  let firstTailOffset = tailStart
  if (tailStart > MAX_META_HEAD_BYTES) {
    for await (const record of readJsonlRecords(file, MAX_META_TAIL_BYTES + 1, tailStart - 1, true, handle)) {
      const entry = parseSessionTreeEntry(record.line)
      if (!entry || entry.type === 'session') continue
      if (!tail.length) firstTailOffset = record.startOffset
      tail.push(entry)
    }
  }

  const isRewindMarker = (entry: TreeEntry): boolean => {
    const customType = (entry as { customType?: unknown }).customType
    return entry.type === 'custom' && (customType === 'pi-desktop-rewind' || customType === 'pi-desktop-undo-rewind')
  }
  const activeTail = tail.some(isRewindMarker) ? branchFromEntries(tail) : []
  if (activeTail.some(isRewindMarker)) {
    const parentId = activeTail[0]?.parentId
    let prefix = parentId ? branchFromEntries(head, parentId) : []
    if (parentId && !prefix.length) {
      prefix = await readEarlierBranch(file, parentId, firstTailOffset, handle)
    }
    for (const entry of prefix) scan(entry)
    for (const entry of activeTail) scan(entry)
  } else {
    for (const entry of head) scan(entry)
    for (const entry of tail) scan(entry)
  }

  return {
    id: sessionHeader.id,
    file,
    cwd: sessionHeader.cwd ?? '',
    name,
    preview: preview.replace(/\s+/g, ' ').slice(0, 120),
    // The header is the first line Pi writes and it is never rewritten, so its
    // timestamp is the conversation's start. `updatedAt` cannot stand in for
    // it: a resumed session moves that one forward on every message.
    createdAt: Date.parse(sessionHeader.timestamp ?? '') || 0,
    updatedAt: Math.max(Date.parse(lastTimestamp) || 0, mtimeMs),
    messageCount,
    model
  }
}

export async function parseSession(
  file: string,
  fileStats?: SessionFileStats,
  handle?: FileHandle,
  options: { cacheMessages?: boolean } = {}
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
  const cacheMessages = options.cacheMessages === true
  const entries: BaseEntry[] = []
  let lastEntryTimestamp: string | undefined
  let scannedLines = 0

  for await (const raw of readJsonlLines(file, MAX_SESSION_BYTES, 0, false, handle)) {
    scannedLines += 1
    if (scannedLines % 256 === 0) await yieldToEventLoop()
    const line = raw.trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const record = parsed as BaseEntry & {
      name?: string
      provider?: string
      modelId?: string
      message?: { role?: string; content?: unknown; model?: string }
    }
    if (!header && record.type === 'session') {
      header = record as unknown as SessionHeader
      continue
    }
    if (record.timestamp) lastEntryTimestamp = record.timestamp
    if (cacheMessages) {
      entries.push(record)
      continue
    }

    // Metadata scans only inspect branch shape, session name, model changes,
    // message count, and the first user preview. Shedding bulky tool arguments
    // and tool output immediately avoids holding megabytes of JSON in memory.
    const slim: BaseEntry & Record<string, unknown> = {
      type: record.type,
      id: record.id,
      parentId: record.parentId,
      timestamp: record.timestamp
    }
    if (record.type === 'session_info') {
      if (record.name) slim.name = record.name
    } else if (record.type === 'model_change') {
      if (record.provider) slim.provider = record.provider
      if (record.modelId) slim.modelId = record.modelId
    } else if (record.type === 'message' && record.message) {
      const msg = record.message
      const role = msg.role
      if (role === 'user') {
        slim.message = { role, content: extractText(msg.content).trim() }
      } else if (role === 'assistant') {
        slim.message = msg.model ? { role, model: msg.model } : { role }
      } else if (role === 'toolResult' || role === 'bashExecution') {
        slim.message = { role }
      }
    }
    entries.push(slim)
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
  // Decouple background metadata scans (listSessions, startupScan) from
  // evicting active conversations out of the 12-entry sessionMessagesCache.
  if (cacheMessages) {
    if (stats.size <= MAX_CACHED_SESSION_MESSAGE_BYTES) {
      const externalContext = hasExternalContext(branch)
      const contextChecked = !hasExternalContextUnknown(branch) && (
        hasExternalContextChecked(branch) || !hasLocalToolCall(branch)
      )
      const taskMode = taskModeFromBranch(branch)
      cacheSessionMessages(file, stats, {
        messages: messagesFromBranch(branch),
        externalContext,
        contextChecked,
        ...(taskMode ? { taskMode } : {})
      })
    } else {
      deleteCachedSessionMessages(canonicalSessionFile(file))
    }
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
        preview = typeof message.content === 'string'
          ? message.content
          : extractText(message.content).trim()
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
  const entryTime = Date.parse(lastEntryTimestamp ?? entries[entries.length - 1]?.timestamp ?? header.timestamp ?? '') || 0
  const updatedAt = Math.max(entryTime, stats.mtimeMs)

  return {
    id: header.id,
    file,
    cwd: header.cwd ?? '',
    name,
    preview: preview.replace(/\s+/g, ' ').slice(0, 120),
    createdAt: Date.parse(header.timestamp ?? '') || 0,
    updatedAt,
    messageCount,
    model
  }
}

/**
 * List every session Pi has on disk, optionally restricted to one working
 * directory. Results are sorted by most recent activity first.
 */
export async function listSessions(cwd?: string, customRoot?: string): Promise<SessionMeta[]> {
  const sessions = new Map<string, SessionMeta>()
  for (const root of resolveSessionRoots(customRoot)) {
    for (const session of await listSessionsInRoot(cwd, root)) {
      sessions.set(canonicalSessionFile(session.file), session)
    }
  }
  const results = [...sessions.values()]
  results.sort((a, b) => b.updatedAt - a.updatedAt)
  return results
}

async function listSessionsInRoot(cwd: string | undefined, root: string): Promise<SessionMeta[]> {
  let realRoot: string
  try {
    const rootStat = await stat(root)
    if (!rootStat.isDirectory()) return []
    realRoot = await realpath(root)
  } catch {
    return []
  }

  const results: SessionMeta[] = []
  const readMetas = async (
    files: string[],
    expectedCwd?: string,
    dirVerified = false
  ): Promise<SessionMeta[]> => {
    const metas: (SessionMeta | null)[] = new Array(files.length).fill(null)
    let next = 0
    const worker = async () => {
      while (next < files.length) {
        const index = next++
        metas[index] = await getSessionMeta(files[index]!, root, realRoot, dirVerified)
      }
    }
    const workerCount = Math.min(MAX_CONCURRENT_SESSION_META_READS, files.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    return metas.filter((meta): meta is SessionMeta =>
      meta !== null &&
      !isSideSessionKey(meta.file) &&
      (!expectedCwd || pathsEqual(meta.cwd, expectedCwd))
    )
  }

  if (cwd && cwd.trim()) {
    // Targeted workspace directory resolution (R3), plus direct `.jsonl` files
    // in `root` for flat custom session directories (`--session-dir`,
    // `PI_CODING_AGENT_SESSION_DIR`, or Pi's `settings.json:sessionDir`).
    const seen = new Set<string>()
    const appendMetas = (metas: SessionMeta[]) => {
      for (const meta of metas) {
        const key = canonicalSessionFile(meta.file)
        if (seen.has(key)) continue
        seen.add(key)
        results.push(meta)
      }
    }

    const targetDir = await findWorkspaceSessionDir(root, cwd)
    if (targetDir) {
      let files: string[] = []
      let dirVerified = false
      try {
        const [names, dirReal] = await Promise.all([readdir(targetDir), realpath(targetDir)])
        dirVerified = isBelowDirectory(realRoot, dirReal)
        files = names.filter((f) => f.endsWith('.jsonl')).map((f) => path.join(targetDir, f))
      } catch {
        files = []
      }
      if (files.length > 0) appendMetas(await readMetas(files, cwd, dirVerified))
    }

    let directFiles: string[] = []
    try {
      const entries = await readdir(root, { withFileTypes: true })
      directFiles = entries
        .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith('.jsonl'))
        .map((e) => path.join(root, e.name))
    } catch {
      directFiles = []
    }
    if (directFiles.length > 0) appendMetas(await readMetas(directFiles, cwd, true))
  } else {
    // Global listing across all workspaces. Directories are independent, so
    // they are read with a small worker pool instead of one after another: a
    // cold start pays this scan before the sidebar can paint, and a user with
    // many projects used to wait for the sum of every folder's reads.
    let workspaceDirs: string[]
    let directFiles: string[]
    try {
      const entries = await readdir(root, { withFileTypes: true })
      workspaceDirs = entries
        .filter((e) => e.isDirectory() && e.name !== SIDE_CHAT_DIR_NAME)
        .map((e) => e.name)
      directFiles = entries
        .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith('.jsonl'))
        .map((e) => path.join(root, e.name))
    } catch {
      return []
    }

    const readDirectory = async (dir: string): Promise<SessionMeta[]> => {
      const dirPath = path.join(root, dir)
      let files: string[]
      let dirVerified = false
      try {
        const [names, dirReal] = await Promise.all([readdir(dirPath), realpath(dirPath)])
        dirVerified = isBelowDirectory(realRoot, dirReal)
        files = names.filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dirPath, f))
      } catch {
        return []
      }
      return await readMetas(files, undefined, dirVerified)
    }

    const perDirectory: SessionMeta[][] = new Array(workspaceDirs.length)
    let nextDirectory = 0
    const directoryWorker = async () => {
      while (nextDirectory < workspaceDirs.length) {
        const index = nextDirectory++
        perDirectory[index] = await readDirectory(workspaceDirs[index]!)
      }
    }
    const directoryWorkers = Math.min(MAX_CONCURRENT_WORKSPACE_DIRECTORIES, workspaceDirs.length)
    await Promise.all([
      ...Array.from({ length: directoryWorkers }, () => directoryWorker()),
      directFiles.length > 0
        ? readMetas(directFiles, undefined, true).then((metas) => {
            results.push(...metas)
          })
        : Promise.resolve()
    ])
    for (const metas of perDirectory) results.push(...metas)
  }

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
  options: {
    budgetBytes?: number
    shouldStop?: () => boolean
    sessionRoots?: readonly string[]
    includeFile?: (file: string) => boolean
  } = {}
): Promise<SessionSearchHit[]> {
  if (typeof query !== 'string' || query.length > MAX_SEARCH_QUERY_LENGTH) return []
  const needle = query.trim()
  if (needle.length < 2) return []
  const needleLower = needle.toLowerCase()
  const ceiling = Math.min(Math.max(limit, 1), 100)
  const budget = Math.max(0, options.budgetBytes ?? MAX_SEARCH_TOTAL_BYTES)
  const shouldStop = () => options.shouldStop?.() === true
  if (shouldStop()) return []
  const candidatesByFile = new Map<string, { file: string; mtime: number; size: number; root: string; realRoot: string }>()
  for (const root of options.sessionRoots ?? resolveSessionRoots()) {
    if (shouldStop()) return []
    let realRoot: string
    try {
      const rootStat = await stat(root)
      if (!rootStat.isDirectory()) continue
      realRoot = await realpath(root)
    } catch {
      continue
    }

    let workspaceDirs: string[]
    let directFiles: string[]
    try {
      const entries = await readdir(root, { withFileTypes: true })
      workspaceDirs = entries
        .filter((entry) => entry.isDirectory() && entry.name !== SIDE_CHAT_DIR_NAME)
        .map((entry) => entry.name)
      directFiles = entries
        .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.jsonl'))
        .map((entry) => entry.name)
    } catch {
      continue
    }

    const collectCandidates = async (folder: string, realFolder: string, names: string[]): Promise<boolean> => {
      let nextFile = 0
      const indexCandidates = async () => {
        while (!shouldStop()) {
          const name = names[nextFile++]
          if (name === undefined) return
          if (!name.endsWith('.jsonl')) continue
          const file = path.join(folder, name)
          if (isSideSessionKey(file)) continue
          if (options.includeFile && !options.includeFile(file)) continue
          let metadata: { mtime: number; size: number } | undefined
          let target = path.join(realFolder, name)
          try {
            // Ranking needs metadata only. The selected file is reopened and
            // fully verified through openSessionFile before any content read.
            const entry = await lstat(file)
            let details = entry
            if (entry.isSymbolicLink()) {
              const resolvedTarget = await realpath(file)
              if (!isBelowDirectory(realRoot, resolvedTarget) || path.extname(resolvedTarget).toLowerCase() !== '.jsonl') continue
              target = resolvedTarget
              details = await stat(resolvedTarget)
            }
            if (!details.isFile() || details.nlink > 1 || details.size === 0) continue
            metadata = { mtime: details.mtimeMs, size: details.size }
          } catch {
            /* a file that vanished is not a search result */
            continue
          }
          if (!metadata) continue
          const canonical = process.platform === 'win32' ? path.resolve(target).toLowerCase() : path.resolve(target)
          candidatesByFile.set(canonical, { file, ...metadata, root, realRoot })
        }
      }
      const workers = Math.min(MAX_CONCURRENT_SEARCH_CANDIDATE_READS, names.length)
      await Promise.all(Array.from({ length: workers }, () => indexCandidates()))
      return !shouldStop()
    }

    if (directFiles.length > 0 && !(await collectCandidates(root, realRoot, directFiles))) {
      return []
    }

    for (const dir of workspaceDirs) {
      if (shouldStop()) return []
      const folder = path.join(root, dir)
      let realFolder: string
      try {
        realFolder = await realpath(folder)
        if (!isBelowDirectory(realRoot, realFolder)) continue
      } catch {
        continue
      }
      let names: string[]
      try {
        names = await readdir(folder)
      } catch {
        continue
      }
      if (!(await collectCandidates(folder, realFolder, names))) return []
    }
  }
  const candidates = [...candidatesByFile.values()]
  if (shouldStop()) return []
  candidates.sort((a, b) => b.mtime - a.mtime)

  let matches: { hits: SessionSearchHit[]; sourceIsCurrent: () => Promise<boolean> }[] = []
  let hitCount = 0
  const confirmedHits = async (): Promise<SessionSearchHit[]> => {
    // An open handle can still read a deleted or replaced file. Recheck the
    // names before returning so even an early hit must still have a source.
    const current: typeof matches = []
    const hits: SessionSearchHit[] = []
    for (const match of matches) {
      if (shouldStop()) return []
      if (!(await match.sourceIsCurrent())) continue
      current.push(match)
      hits.push(...match.hits)
    }
    matches = current
    hitCount = hits.length
    return shouldStop() ? [] : hits
  }
  let bytesRead = 0
  for (const candidate of candidates) {
    // A newer query supersedes this one: stop at the next file boundary so a
    // burst of keystrokes does not leave several scans running at once.
    if (shouldStop()) break
    if (hitCount >= ceiling) {
      const hits = await confirmedHits()
      if (hits.length >= ceiling || shouldStop()) return hits
    }
    const opened = await openSessionFile(candidate.file, candidate.root, false, candidate.realRoot)
    if (!opened) continue
    try {
      if (shouldStop()) continue
      const stats = await opened.handle.stat()
      const remaining = budget - bytesRead
      if (remaining <= 0) break
      const identity = fileIdentity(stats)
      const sourceIsCurrent = async (): Promise<boolean> => {
        try {
          if (await realpath(candidate.file) !== opened.target) return false
          const named = await stat(opened.target)
          return named.isFile() && named.nlink === 1 && fileIdentity(named) === identity
        } catch {
          return false
        }
      }
      let fileHits: SessionSearchHit[] | undefined
      // A long session is searched through its index: the first query pays for
      // one pass over the file, and later keystrokes scan only the extracted
      // message text. Without an index folder (tests) the direct scan remains.
      if (stats.size > MAX_SEARCH_FILE_BYTES && searchIndexDir) {
        const indexed = await searchIndexedSession(
          candidate.file,
          identity,
          stats.mtimeMs,
          stats.size,
          needleLower,
          needle.length,
          ceiling - hitCount,
          remaining,
          opened.handle,
          shouldStop,
          sourceIsCurrent
        )
        bytesRead += indexed.workBytes
        if (shouldStop()) return []
        if (indexed.usedIndex) fileHits = indexed.hits
      }
      // An index attempt may already have spent part of the budget reading its
      // sidecar. Charge the direct fallback against the remainder, never the
      // stale amount from before that attempt.
      if (!fileHits) {
        const directRemaining = budget - bytesRead
        if (directRemaining <= 0) break
        const readLimit = Math.min(stats.size, MAX_SEARCH_FILE_BYTES, directRemaining)
        bytesRead += readLimit
        fileHits = await searchSessionFile(
          candidate.file,
          stats.mtimeMs,
          needleLower,
          needle.length,
          ceiling - hitCount,
          readLimit,
          opened.handle,
          shouldStop
        )
        if (shouldStop()) return []
      }
      if (fileHits.length > 0) {
        matches.push({ hits: fileHits, sourceIsCurrent })
        hitCount += fileHits.length
      }
    } finally {
      await opened.handle.close().catch(() => {})
    }
  }
  return confirmedHits()
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
  handle?: FileHandle,
  shouldStop: () => boolean = () => false
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
    if (shouldStop()) break
    const line = raw.trim()
    if (!line) continue
    // Skip toolResult, bashExecution, custom, compaction, etc. before JSON.parse.
    if (
      !line.includes('"session') &&
      !line.includes('"user"') &&
      !line.includes('"assistant"') &&
      !line.includes('\\u')
    ) continue
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

    const magic = Buffer.from(SEARCH_INDEX_FILE_MAGIC)
    const foundMagic = Buffer.alloc(magic.length)
    let position = 0
    while (position < foundMagic.length) {
      const { bytesRead } = await handle.read(foundMagic, position, foundMagic.length - position, position)
      if (bytesRead === 0) break
      position += bytesRead
      indexBytesRead += bytesRead
    }
    if (position !== magic.length || !foundMagic.equals(magic)) {
      return { snapshot: null, indexBytesRead, skipped: false }
    }

    let header: SearchIndexHeader | undefined
    const entries: SearchIndexEntry[] = []
    const parseLine = (line: string): boolean => {
      if (!header) {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          return false
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
        const value = parsed as Record<string, unknown>
        if (
          value.version !== SEARCH_INDEX_VERSION ||
          typeof value.identity !== 'string' ||
          typeof value.indexedSize !== 'number' ||
          typeof value.sourceSize !== 'number' ||
          typeof value.indexedFrom !== 'number' ||
          typeof value.mtime !== 'number' ||
          value.indexedFrom < 0 ||
          value.indexedFrom > value.indexedSize ||
          value.sourceSize < value.indexedSize
        ) return false
        header = {
          version: SEARCH_INDEX_VERSION,
          file: typeof value.file === 'string' ? value.file : '',
          identity: value.identity,
          sessionId: typeof value.sessionId === 'string' ? value.sessionId : '',
          cwd: typeof value.cwd === 'string' ? value.cwd : '',
          name: typeof value.name === 'string' ? value.name : undefined,
          preview: typeof value.preview === 'string' ? value.preview : '',
          indexedSize: value.indexedSize,
          sourceSize: value.sourceSize,
          indexedFrom: value.indexedFrom,
          mtime: value.mtime,
          messageIndex: typeof value.messageIndex === 'number' ? value.messageIndex : undefined
        }
        return true
      }

      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        return false
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return true
      const entry = raw as Partial<SearchIndexEntry>
      if (
        (entry.role !== 'user' && entry.role !== 'assistant') ||
        typeof entry.text !== 'string' ||
        typeof entry.lower !== 'string' ||
        typeof entry.index !== 'number' ||
        typeof entry.startOffset !== 'number' ||
        typeof entry.endOffset !== 'number' ||
        entry.startOffset < header.indexedFrom ||
        entry.endOffset < entry.startOffset ||
        entry.endOffset > header.indexedSize
      ) {
        return true
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
      return true
    }

    const decoder = new StringDecoder('utf8')
    const pendingParts: string[] = []
    let lastYieldAt = performance.now()
    const maybeYield = async (): Promise<void> => {
      const now = performance.now()
      if (now - lastYieldAt >= 4) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        lastYieldAt = performance.now()
      }
    }
    const consumeText = async (text: string): Promise<boolean> => {
      let cursor = 0
      while (true) {
        const newline = text.indexOf('\n', cursor)
        if (newline < 0) break
        pendingParts.push(text.slice(cursor, newline))
        const line = pendingParts.join('')
        pendingParts.length = 0
        if (!parseLine(line)) return false
        cursor = newline + 1
        await maybeYield()
      }
      if (cursor < text.length) pendingParts.push(text.slice(cursor))
      return true
    }

    const buffer = Buffer.allocUnsafe(CHUNK_SIZE)
    position = magic.length
    while (position < stats.size) {
      const length = Math.min(buffer.length, stats.size - position)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (bytesRead === 0) break
      position += bytesRead
      indexBytesRead += bytesRead
      if (!(await consumeText(decoder.write(buffer.subarray(0, bytesRead))))) {
        return { snapshot: null, indexBytesRead, skipped: false }
      }
      await maybeYield()
    }
    const finalText = decoder.end()
    if (!(await consumeText(finalText))) return { snapshot: null, indexBytesRead, skipped: false }
    if (pendingParts.length > 0 && !parseLine(pendingParts.join(''))) {
      return { snapshot: null, indexBytesRead, skipped: false }
    }
    if (position !== stats.size || !header) {
      return { snapshot: null, indexBytesRead, skipped: false }
    }

    const lastIndex = entries.length ? entries[entries.length - 1].index : 0
    return {
      snapshot: {
        ...header,
        messageIndex: header.messageIndex ?? lastIndex,
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

class SearchIndexBuildCancelledError extends Error {}

async function writeSearchIndexFile(
  indexPath: string,
  snapshot: SearchIndexSnapshot,
  isCurrent: () => boolean
): Promise<void> {
  if (!isCurrent()) return
  if (estimateSearchIndexMemory(snapshot) > MAX_SEARCH_INDEX_FILE_BYTES) {
    if (isCurrent()) await unlink(indexPath).catch(() => {})
    return
  }
  const temp = `${indexPath}.${randomBytes(4).toString('hex')}.tmp`
  activeSearchIndexTemps.add(temp)
  let handle: FileHandle | undefined
  try {
    const directory = path.dirname(indexPath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(directory, 0o700).catch(() => {})
    handle = await open(temp, 'wx', 0o600)
    let writtenBytes = 0
    let batchBytes = 0
    let batch: string[] = []
    const assertCurrent = () => {
      if (!isCurrent()) throw new SearchIndexBuildCancelledError()
    }
    const flush = async () => {
      if (batchBytes === 0) return
      assertCurrent()
      const data = Buffer.from(batch.join(''))
      let offset = 0
      while (offset < data.length) {
        const { bytesWritten } = await handle!.write(data, offset, data.length - offset, null)
        if (bytesWritten === 0) throw new Error('Could not write the search index.')
        offset += bytesWritten
      }
      writtenBytes += data.length
      batch = []
      batchBytes = 0
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const queueLine = async (line: string) => {
      assertCurrent()
      const lineBytes = Buffer.byteLength(line, 'utf8')
      if (writtenBytes + batchBytes + lineBytes > MAX_SEARCH_INDEX_FILE_BYTES) {
        throw new SearchIndexTooLargeError()
      }
      batch.push(line)
      batchBytes += lineBytes
      if (batchBytes >= CHUNK_SIZE) await flush()
    }

    const { entries, ...header } = snapshot
    await queueLine(SEARCH_INDEX_FILE_MAGIC)
    await queueLine(`${JSON.stringify(header)}\n`)
    for (const entry of entries) {
      await queueLine(`${JSON.stringify(entry)}\n`)
    }
    await flush()
    await handle.close()
    handle = undefined
    assertCurrent()
    await rename(temp, indexPath)
    autoPruneWritesSinceLastPrune += 1
    const now = Date.now()
    if (autoPruneWritesSinceLastPrune >= 16 || now - lastAutoPruneAt >= 15_000) {
      autoPruneWritesSinceLastPrune = 0
      lastAutoPruneAt = now
      await pruneSessionSearchIndexFiles()
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    // An index is an optimization: a read-only or full folder must not fail a search.
    await unlink(temp).catch(() => {})
    if (error instanceof SearchIndexTooLargeError && isCurrent()) await unlink(indexPath).catch(() => {})
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
  handle: FileHandle,
  isCurrent: () => boolean
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
  await writeSearchIndexFile(indexPath, snapshot, isCurrent)
  return { snapshot, sourceBytesRead: readBytes, indexBytesRead }
}

async function ensureSearchIndex(
  file: string,
  identity: string,
  size: number,
  mtime: number,
  maxWorkBytes: number,
  handle: FileHandle,
  sourceIsCurrent: () => Promise<boolean>
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
      if (pending.cancellation.cancelled) return { ...load, snapshot: null }
      if (pending.size === size && pending.mtime === mtime) return load
      // A newer file version arrived during the build. Wait for the old writer
      // to finish, then rebuild or extend its snapshot against this version.
      if (inFlightSearchIndexes.get(inFlightKey) === pending) {
        inFlightSearchIndexes.delete(inFlightKey)
      }
      continue
    }

    const cancellation = { cancelled: false }
    const task = (async (): Promise<SearchIndexLoad> => {
      // Deletion may have forgotten the index while the scan still held the
      // file open, before this build was registered for cancellation.
      if (!(await sourceIsCurrent())) return { snapshot: null, sourceBytesRead: 0, indexBytesRead: 0 }
      if (cancellation.cancelled) return { snapshot: null, sourceBytesRead: 0, indexBytesRead: 0 }
      const cachedAppend = cached?.file === canonicalSessionFile(file) &&
        cached.identity === identity &&
        cached.indexedSize < size &&
        size - cached.indexedSize <= MAX_INDEX_FILE_BYTES
        ? cached
        : null
      const stored = cachedAppend ? null : await readSearchIndexFile(indexPath, maxWorkBytes)
      if (cancellation.cancelled) return { snapshot: null, sourceBytesRead: 0, indexBytesRead: 0 }
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
      return await updateSearchIndex(
        file,
        indexPath,
        base,
        identity,
        size,
        mtime,
        indexBytesRead,
        handle,
        () => !cancellation.cancelled
      )
    })()
    const build = { size, mtime, task, cancellation }
    inFlightSearchIndexes.set(inFlightKey, build)
    try {
      const load = await task
      if (!cancellation.cancelled && load.snapshot) {
        cacheSearchIndex(indexPath, load.snapshot)
      }
      if (cancellation.cancelled) return { ...load, snapshot: null }
      return load
    } finally {
      if (inFlightSearchIndexes.get(inFlightKey) === build && !cancellation.cancelled) {
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
  handle: FileHandle,
  shouldStop: () => boolean,
  sourceIsCurrent: () => Promise<boolean>
): Promise<{ hits: SessionSearchHit[]; workBytes: number; usedIndex: boolean }> {
  const load = await ensureSearchIndex(file, identity, size, mtime, maxWorkBytes, handle, sourceIsCurrent)
  const loadedBytes = load.sourceBytesRead + load.indexBytesRead
  if (shouldStop()) {
    return { hits: [], workBytes: loadedBytes, usedIndex: Boolean(load.snapshot) }
  }
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
    if (shouldStop()) return { hits: [], workBytes: loadedBytes + scanned, usedIndex: true }
    const remainingScan = scanBudget - scanned
    if (remainingScan <= 0) break
    const entryBytes = Math.min(entry.lower.length, remainingScan)
    const match = await findSearchIndexMatch(entry.lower, needleLower, entryBytes, shouldStop)
    scanned += match.scanned
    if (match.cancelled) return { hits: [], workBytes: loadedBytes + scanned, usedIndex: true }
    const at = match.at
    if (at === -1) {
      if (entryBytes < entry.lower.length || !match.complete) break
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

/** Search cached text in bounded chunks so a large conversation cannot block the main process. */
async function findSearchIndexMatch(
  text: string,
  needle: string,
  maxChars: number,
  shouldStop: () => boolean
): Promise<{ at: number; scanned: number; cancelled: boolean; complete: boolean }> {
  const limit = Math.min(text.length, Math.max(0, maxChars))
  const overlap = Math.max(0, needle.length - 1)
  let start = 0
  let scanned = 0
  let searchedTo = 0

  while (start < limit && scanned < maxChars) {
    if (shouldStop()) return { at: -1, scanned, cancelled: true, complete: false }
    const nextCoverage = Math.min(limit, start + Math.min(SEARCH_INDEX_SCAN_CHUNK_CHARS, maxChars - scanned))
    const end = Math.min(limit, nextCoverage + overlap)
    const reachedLimit = end >= limit
    const coveredTo = reachedLimit ? limit : nextCoverage
    const at = text.slice(start, end).indexOf(needle)
    scanned += coveredTo - start
    searchedTo = coveredTo
    if (at !== -1) return { at: start + at, scanned, cancelled: false, complete: true }
    if (reachedLimit) break
    start = coveredTo
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  return {
    at: -1,
    scanned,
    cancelled: shouldStop(),
    complete: searchedTo >= limit
  }
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

  const seenUsageFiles = new Set<string>()
  const usageTasks: Array<{ fullPath: string; root: string; realRoot: string; dirVerified: boolean; sessionId: string; key: string }> = []

  for (const root of resolveSessionRoots(customRoot)) {
    let realRoot: string
    try {
      const rootStat = await stat(root)
      if (!rootStat.isDirectory()) continue
      realRoot = await realpath(root)
    } catch {
      continue
    }

    let workspaceDirs: string[] = []
    let directFiles: string[] = []
    try {
      const entries = await readdir(root, { withFileTypes: true })
      workspaceDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      directFiles = entries
        .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.jsonl'))
        .map((entry) => entry.name)
    } catch {
      workspaceDirs = []
      directFiles = []
    }

    const pushUsageFile = (dirPath: string, file: string, dirVerified: boolean) => {
      if (!file.endsWith('.jsonl')) return
      const fullPath = path.join(dirPath, file)
      const key = canonicalSessionFile(fullPath)
      if (seenUsageFiles.has(key)) return
      seenUsageFiles.add(key)
      usageTasks.push({
        fullPath,
        root,
        realRoot,
        dirVerified,
        sessionId: file.replace(/\.jsonl$/, ''),
        key
      })
    }

    for (const file of directFiles) pushUsageFile(root, file, true)

    let nextWorkspaceDir = 0
    const dirWorker = async () => {
      while (nextWorkspaceDir < workspaceDirs.length) {
        const dir = workspaceDirs[nextWorkspaceDir++]!
        const dirPath = path.join(root, dir)
        let names: string[] = []
        let dirReal: string | undefined
        try {
          const [dirNames, resolvedDir] = await Promise.all([readdir(dirPath), realpath(dirPath)])
          names = dirNames
          dirReal = resolvedDir
        } catch {
          continue
        }
        const dirVerified = isBelowDirectory(realRoot, dirReal)
        if (dir === SIDE_CHAT_DIR_NAME) {
          for (const subDir of names) {
            const subPath = path.join(dirPath, subDir)
            try {
              const [subFiles, subReal] = await Promise.all([readdir(subPath), realpath(subPath)])
              const subVerified = isBelowDirectory(realRoot, subReal)
              for (const file of subFiles) pushUsageFile(subPath, file, subVerified)
            } catch {
              continue
            }
          }
          continue
        }
        for (const file of names) pushUsageFile(dirPath, file, dirVerified)
      }
    }
    const dirWorkers = Math.min(MAX_CONCURRENT_WORKSPACE_DIRECTORIES, workspaceDirs.length)
    await Promise.all(Array.from({ length: dirWorkers }, () => dirWorker()))
  }

  const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
  const tryExtractMessageTimestampFast = (raw: string): number | undefined => {
    const head = raw.slice(0, 1024)
    if (!/^\s*\{/.test(head)) return undefined
    if (!raw.trimEnd().endsWith('}')) return undefined
    const messageIdx = head.search(/"message"\s*:\s*\{/)
    if (messageIdx < 0) return undefined
    const prefix = head.slice(0, messageIdx)
    if (!/"type"\s*:\s*"message"\b/.test(prefix)) return undefined

    const entryTsMatch = prefix.match(/"timestamp"\s*:\s*"([^"]+)"/)
    if (entryTsMatch) {
      const parsed = Date.parse(entryTsMatch[1]!)
      if (parsed > 0) return parsed
    }

    const tail = raw.slice(-512)
    const msgNumTs = tail.match(/"timestamp"\s*:\s*(\d+)\s*\}\s*\}\s*$/)
    if (msgNumTs) {
      const parsed = Number(msgNumTs[1])
      if (Number.isFinite(parsed) && parsed > 0) return parsed
    }
    const msgStrTs = tail.match(/"timestamp"\s*:\s*"([^"]+)"\s*\}\s*\}\s*$/)
    if (msgStrTs) {
      const parsed = Date.parse(msgStrTs[1]!)
      if (parsed > 0) return parsed
    }
    return undefined
  }

  let nextTask = 0
  const usageWorker = async () => {
    while (nextTask < usageTasks.length) {
      const task = usageTasks[nextTask++]!
      const { fullPath, root, realRoot, dirVerified, sessionId, key } = task

      const cached = usageCache.get(key)
      if (cached) {
        const fastStats = await statCachedSessionFile(fullPath, root, dirVerified)
        if (
          fastStats &&
          fastStats.size <= MAX_USAGE_CACHE_SOURCE_BYTES &&
          cached.identity === fileIdentity(fastStats) &&
          cached.mtime === fastStats.mtimeMs &&
          cached.size === fastStats.size
        ) {
          usageCache.delete(key)
          usageCache.set(key, cached)
          applyUsageData(cached)
          continue
        }
      }

      const opened = await openSessionFile(fullPath, root, false, realRoot)
      if (!opened) continue
      const targetKey = canonicalSessionFile(opened.target)
      if (targetKey !== key && seenUsageFiles.has(targetKey)) {
        await opened.handle.close().catch(() => {})
        continue
      }
      seenUsageFiles.add(targetKey)

      let usageData = usageCache.get(targetKey) ?? (targetKey === key ? cached : undefined)
      try {
        const s = await opened.handle.stat()
        if (!s.isFile()) {
          deleteCachedUsage(targetKey)
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
          usageCache.delete(targetKey)
          usageCache.set(targetKey, usageData)
        } else {
          deleteCachedUsage(targetKey)
          usageData = undefined
          const timestamps: number[] | undefined = cacheable ? [] : undefined
          const metrics: CachedFileUsage['metrics'] | undefined = cacheable ? [] : undefined
          let scannedLines = 0

          for await (const raw of readJsonlLines(opened.target, s.size, 0, false, opened.handle)) {
            if (++scannedLines % 256 === 0) await yieldToEventLoop()
            if (!raw.includes('"message"')) continue
            if (raw.length > 2048 && !raw.includes('"usage"')) {
              const fastTs = tryExtractMessageTimestampFast(raw)
              if (fastTs !== undefined) {
                if (timestamps) timestamps.push(fastTs)
                else recordActivity(sessionId, fastTs)
                continue
              }
            }
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
            cacheUsage(targetKey, usageData)
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
  const usageWorkers = Math.min(MAX_CONCURRENT_SESSION_META_READS, usageTasks.length)
  await Promise.all(Array.from({ length: usageWorkers }, () => usageWorker()))

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

/**
 * Recover Side Chat `.jsonl` files bound to `parentSessionKey` by scanning
 * `pi-desktop-side-chat` custom entries inside `_side-chats/<workspaceDir>/`.
 * Used as a zero-token self-healing fallback if `<userData>/side-chats.json`
 * was removed externally.
 */
export async function findSideChatFilesForParent(
  parentSessionKey: string,
  cwd: string,
  sessionRoots: readonly string[] = resolveSessionRoots(),
  parentSessionId?: string
): Promise<string[]> {
  if (!parentSessionKey || parentSessionKey.startsWith('draft:')) return []
  const canonParent = canonicalSessionFile(parentSessionKey)
  const matches: Array<{ file: string; mtimeMs: number }> = []
  const seen = new Set<string>()
  const encodedDir = cwd ? encodeWorkspaceDir(cwd) : ''

  for (const root of sessionRoots) {
    let realRoot: string
    try {
      const rootStat = await stat(root)
      if (!rootStat.isDirectory()) continue
      realRoot = await realpath(root)
    } catch {
      continue
    }
    const sideBase = path.join(root, SIDE_CHAT_DIR_NAME)
    let candidateDirs: string[] = []
    if (encodedDir) {
      candidateDirs.push(path.join(sideBase, encodedDir))
      const driveMatch = cwd.match(/^([a-zA-Z]):[\\/]/)
      if (driveMatch) {
        const drive = driveMatch[1]!
        const flipped = (drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()) + cwd.slice(1)
        candidateDirs.push(path.join(sideBase, encodeWorkspaceDir(flipped)))
      }
    } else {
      try {
        const subEntries = await readdir(sideBase, { withFileTypes: true })
        candidateDirs = subEntries.filter((e) => e.isDirectory()).map((e) => path.join(sideBase, e.name))
      } catch {
        continue
      }
    }

    for (const dir of candidateDirs) {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const candidatePath = path.join(dir, name)
        const opened = await openSessionFile(candidatePath, root, false, realRoot)
        if (!opened) continue
        try {
          const canonSide = canonicalSessionFile(opened.target)
          if (seen.has(canonSide)) continue
          const fileStats = await opened.handle.stat()
          let matched = false
          let linesChecked = 0
          for await (const rawLine of readJsonlLines(opened.target, MAX_META_HEAD_BYTES, 0, false, opened.handle)) {
            linesChecked += 1
            if (linesChecked > 64) break
            if (!rawLine.includes(SIDE_CHAT_META_ENTRY_TYPE)) continue
            try {
              const parsed = JSON.parse(rawLine) as {
                type?: unknown
                customType?: unknown
                data?: { parentSessionKey?: unknown; parentSessionId?: unknown }
              }
              if (parsed.type !== 'custom' || parsed.customType !== SIDE_CHAT_META_ENTRY_TYPE || !parsed.data) {
                continue
              }
              const entryParentKey =
                typeof parsed.data.parentSessionKey === 'string' ? parsed.data.parentSessionKey : ''
              const entryParentId =
                typeof parsed.data.parentSessionId === 'string' ? parsed.data.parentSessionId : ''
              if (
                (entryParentKey && canonicalSessionFile(entryParentKey) === canonParent) ||
                (parentSessionId && entryParentId && entryParentId === parentSessionId)
              ) {
                matched = true
                break
              }
            } catch {
              /* ignore malformed line */
            }
          }
          if (matched) {
            seen.add(canonSide)
            matches.push({ file: opened.target, mtimeMs: fileStats.mtimeMs })
          }
        } finally {
          await opened.handle.close().catch(() => {})
        }
      }
    }
  }

  matches.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return matches.map((m) => m.file)
}
