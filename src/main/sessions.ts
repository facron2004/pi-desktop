import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  AggregatedUsageStats,
  DailyUsageStat,
  ModelUsageStat,
  PeriodUsage,
  SessionMeta,
  SessionSearchHit,
  TokenUsageMetrics
} from '@shared/types'

const MAX_SESSION_BYTES = 24 * 1024 * 1024

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

function readSessionFile(file: string): { lines: string[]; mtime: number } {
  try {
    const stats = statSync(file)
    if (stats.size > MAX_SESSION_BYTES) return { lines: [], mtime: 0 }
    return { lines: readFileSync(file, 'utf8').split('\n'), mtime: stats.mtimeMs }
  } catch {
    return { lines: [], mtime: 0 }
  }
}

function parseSession(file: string): SessionMeta | null {
  const { lines, mtime } = readSessionFile(file)
  if (!lines.length) return null

  let header: SessionHeader | null = null
  const entries: BaseEntry[] = []
  for (const raw of lines) {
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
      const value = (entry as unknown as { modelId?: string }).modelId
      if (value) model = value
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
  const updatedAt = Math.max(entryTime, mtime)

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
export function listSessions(cwd?: string): SessionMeta[] {
  const root = resolveSessionRoot()
  if (!existsSync(root)) return []

  const results: SessionMeta[] = []
  let workspaceDirs: string[]
  try {
    workspaceDirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }

  const target = cwd ? path.resolve(cwd) : null

  for (const dir of workspaceDirs) {
    let files: string[]
    try {
      files = readdirSync(path.join(root, dir))
        .filter((file) => file.endsWith('.jsonl'))
        .map((file) => path.join(root, dir, file))
    } catch {
      continue
    }
    for (const file of files) {
      const meta = parseSession(file)
      if (!meta) continue
      if (target && path.resolve(meta.cwd) !== target) continue
      results.push(meta)
    }
  }

  results.sort((a, b) => b.updatedAt - a.updatedAt)
  return results
}

/** How many session files a search is allowed to read, newest first. */
const MAX_SEARCH_FILES = 240
/** How much of a session a search reads before giving up on it. */
const MAX_SEARCH_FILE_BYTES = 8 * 1024 * 1024

/**
 * Search the text of every conversation on disk.
 *
 * The sidebar can only filter the conversations it has loaded; this walks the
 * session folder so a run can be found by something that was said in it, long
 * after it scrolled out of the list. The newest files are read first, and the
 * search stops once it has enough hits.
 */
export function searchSessions(query: string, limit = 30): SessionSearchHit[] {
  const needle = query.trim()
  if (needle.length < 2) return []
  const needleLower = needle.toLowerCase()
  const ceiling = Math.min(Math.max(limit, 1), 100)
  const root = resolveSessionRoot()
  if (!existsSync(root)) return []

  const candidates: { file: string; mtime: number }[] = []
  let workspaceDirs: string[]
  try {
    workspaceDirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  for (const dir of workspaceDirs) {
    const folder = path.join(root, dir)
    let names: string[]
    try {
      names = readdirSync(folder)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(folder, name)
      try {
        candidates.push({ file, mtime: statSync(file).mtimeMs })
      } catch {
        /* a file that vanished is not a search result */
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)

  const hits: SessionSearchHit[] = []
  for (const candidate of candidates.slice(0, MAX_SEARCH_FILES)) {
    if (hits.length >= ceiling) break
    hits.push(...searchSessionFile(candidate.file, needleLower, needle.length, ceiling - hits.length))
  }
  return hits
}

/** Read one session file and collect the matching messages of any branch. */
function searchSessionFile(
  file: string,
  needleLower: string,
  needleLength: number,
  remaining: number
): SessionSearchHit[] {
  let raw: string
  try {
    const stats = statSync(file)
    if (stats.size > MAX_SEARCH_FILE_BYTES) return []
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }

  let sessionId = path.basename(file, '.jsonl')
  let cwd = ''
  let name: string | undefined
  let preview = ''
  let mtime = 0
  try {
    mtime = statSync(file).mtimeMs
  } catch {
    mtime = 0
  }

  const hits: SessionSearchHit[] = []
  // One file can match on both branches of a conversation, or on the same
  // words in two messages; a handful of rows per conversation is enough to
  // recognise it, so identical snippets are dropped and the list stays short.
  const seenSnippets = new Set<string>()
  let messageIndex = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
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
export function getAggregatedUsage(customRoot?: string): AggregatedUsageStats {
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

  if (!existsSync(root)) {
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
    workspaceDirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    workspaceDirs = []
  }

  for (const dir of workspaceDirs) {
    const dirPath = path.join(root, dir)
    let files: string[] = []
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }

    for (const file of files) {
      const fullPath = path.join(dirPath, file)
      let content = ''
      try {
        const stats = statSync(fullPath)
        if (stats.size > MAX_SESSION_BYTES) continue
        content = readFileSync(fullPath, 'utf8')
      } catch {
        continue
      }

      const sessionId = file.replace(/\.jsonl$/, '')
      activeInAllTime.add(sessionId)

      const lines = content.split('\n')
      for (const line of lines) {
        if (!line.trim() || !line.includes('"message"')) continue
        try {
          const record = JSON.parse(line) as {
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

          if (ts >= startOfToday) activeInToday.add(sessionId)
          if (ts >= startOfWeek) activeInWeek.add(sessionId)
          if (ts >= startOfMonth) activeInMonth.add(sessionId)

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

            const addMetrics = (target: PeriodUsage) => {
              target.tokens.input += input
              target.tokens.output += output
              target.tokens.cacheRead += cacheRead
              target.tokens.cacheWrite += cacheWrite
              target.tokens.totalTokens += total
              target.tokens.cost += cost
              target.messageCount += 1
            }

            addMetrics(allTime)
            if (ts >= startOfMonth) addMetrics(month)
            if (ts >= startOfWeek) addMetrics(week)
            if (ts >= startOfToday) addMetrics(today)

            const modelName = msg.model || 'Unknown'
            const existingModel = modelStats.get(modelName) || {
              model: modelName,
              totalTokens: 0,
              input: 0,
              output: 0,
              messageCount: 0,
              cost: 0
            }
            existingModel.totalTokens += total
            existingModel.input += input
            existingModel.output += output
            existingModel.messageCount += 1
            existingModel.cost += cost
            modelStats.set(modelName, existingModel)

            if (ts > 0) {
              const d = new Date(ts)
              const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
              const dayBucket = recentDaysMap.get(dateKey)
              if (dayBucket) {
                dayBucket.totalTokens += total
                dayBucket.messageCount += 1
                dayBucket.conversations.add(sessionId)
              }
            }
          }
        } catch {
          // ignore malformed lines
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
