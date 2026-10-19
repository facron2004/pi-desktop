import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SessionMeta } from '@shared/types'

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
export function resolveSessionRoot(): string {
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

function readSessionFile(file: string): string[] {
  try {
    const stats = statSync(file)
    if (stats.size > MAX_SESSION_BYTES) return []
    return readFileSync(file, 'utf8').split('\n')
  } catch {
    return []
  }
}

function parseSession(file: string): SessionMeta | null {
  const lines = readSessionFile(file)
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

  const updatedAt = Date.parse(entries[entries.length - 1]?.timestamp ?? header.timestamp ?? '') || 0

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
