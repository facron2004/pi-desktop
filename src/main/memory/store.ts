import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import type { MemoryEntry, MemoryKind, MemoryScope, MemoryState } from '@shared/types'
import { redactSecrets } from './redact'

export const MAX_ENTRIES = 300
export const MAX_PROJECT_ENTRIES = 80
export const MAX_ENTRY_CHARS = 400
/** Codex caps its injected summary by UTF-8 bytes; CJK text is 3 bytes a character. */
export const MAX_SUMMARY_BYTES = 10_000
/** Kept as a character ceiling for callers that want a stricter prose budget. */
export const MAX_SUMMARY_CHARS = 8000

const KIND_ORDER: MemoryKind[] = ['preference', 'environment', 'knowledge', 'failure']
const KIND_LABEL: Record<MemoryKind, string> = {
  preference: 'User preferences',
  environment: 'Environment',
  knowledge: 'Project knowledge',
  failure: 'Failures and fixes'
}

interface MemoryFile {
  version: 1
  updatedAt: number
  entries: MemoryEntry[]
}

export interface MemorySessionRecord {
  mtimeMs: number
  size: number
  at: number
  /** Why this session was not learned from, when it was deliberately skipped. */
  skipped?: string
  /** Number of failed extraction attempts for this revision. */
  attempts?: number
  lastError?: string
}

interface MemoryLedgerFile {
  version: 1
  sessions: Record<string, MemorySessionRecord>
}

export interface MemoryCandidate {
  scope: MemoryScope
  kind: MemoryKind
  text: string
  projectPath?: string
  projectName?: string
  source?: string
}

export interface MergeResult {
  added: number
  total: number
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as T
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

function writeTextAtomic(file: string, value: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, value, 'utf8')
  renameSync(tmp, file)
}

/** Windows sometimes reports the same folder with a `\\?\` extended prefix. */
function stripExtendedPath(value: string): string {
  return value.replace(/^\\\\\?\\/, '')
}

/** Two spellings of the same folder compare equal on Windows. */
export function memoryPathKey(value: string | undefined): string {
  if (!value) return ''
  const resolved = path.resolve(stripExtendedPath(value)).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function projectNameOf(value: string | undefined): string | undefined {
  if (!value) return undefined
  return path.basename(value.replace(/[\\/]+$/, '')) || value
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_#>]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokensOf(value: string): Set<string> {
  return new Set(
    normalizeText(value)
      .split(' ')
      .filter((token) => token.length > 2)
  )
}

/** Near-duplicates are common across sessions; exact matches are not enough. */
function similarText(a: string, b: string): boolean {
  const left = normalizeText(a)
  const right = normalizeText(b)
  if (!left || !right) return false
  if (left === right) return true
  const aTokens = tokensOf(left)
  const bTokens = tokensOf(right)
  if (!aTokens.size || !bTokens.size) return false
  let common = 0
  for (const token of aTokens) if (bTokens.has(token)) common += 1
  return common / (aTokens.size + bTokens.size - common) >= 0.82
}

function sanitizeCandidate(candidate: MemoryCandidate): MemoryCandidate | null {
  const text = redactSecrets(String(candidate.text ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ENTRY_CHARS)
  if (text.length < 8) return null
  if (/^(?:ok|okay|done|yes|no|thanks|thank you)\.?$/i.test(text)) return null
  const scope: MemoryScope = candidate.scope === 'global' ? 'global' : 'project'
  const kind: MemoryKind = KIND_ORDER.includes(candidate.kind) ? candidate.kind : 'knowledge'
  if (scope === 'project' && !candidate.projectPath) return null
  return {
    scope,
    kind,
    text,
    projectPath:
      scope === 'project' ? path.resolve(stripExtendedPath(candidate.projectPath!)) : undefined,
    projectName:
      scope === 'project'
        ? candidate.projectName || projectNameOf(candidate.projectPath)
        : undefined,
    source: candidate.source
  }
}

function keepScore(entry: MemoryEntry): number {
  const kindWeight =
    entry.kind === 'preference' ? 4 : entry.kind === 'failure' ? 3 : entry.kind === 'knowledge' ? 2 : 1
  return kindWeight * 1e13 + entry.updatedAt
}

function enforceCaps(entries: MemoryEntry[]): MemoryEntry[] {
  const ordered = [...entries].sort((a, b) => keepScore(b) - keepScore(a))
  const kept: MemoryEntry[] = []
  const perProject = new Map<string, number>()
  for (const entry of ordered) {
    if (kept.length >= MAX_ENTRIES) break
    if (entry.scope === 'project') {
      const key = memoryPathKey(entry.projectPath)
      const count = perProject.get(key) ?? 0
      if (count >= MAX_PROJECT_ENTRIES) continue
      perProject.set(key, count + 1)
    }
    kept.push(entry)
  }
  return kept.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Render the part of memory that Pi sees.
 *
 * With a `cwd`, global memories and that one project are included. Without
 * one, every project is included — that is the human-readable file on disk,
 * not what goes into a prompt.
 */
export function renderMemorySummary(
  entries: MemoryEntry[],
  options: { cwd?: string; maxChars?: number; maxBytes?: number } = {}
): string {
  const maxChars = options.maxChars ?? MAX_SUMMARY_CHARS
  const maxBytes = options.maxBytes ?? MAX_SUMMARY_BYTES
  const fits = (candidate: string): boolean =>
    candidate.length <= maxChars && Buffer.byteLength(candidate, 'utf8') <= maxBytes
  const wantedProject = memoryPathKey(options.cwd)
  const relevant = entries.filter((entry) => {
    if (entry.scope === 'global') return true
    if (!options.cwd) return true
    return memoryPathKey(entry.projectPath) === wantedProject
  })
  if (!relevant.length) return ''

  const global = relevant.filter((entry) => entry.scope === 'global')
  const projects = new Map<string, { path: string; name: string; entries: MemoryEntry[] }>()
  for (const entry of relevant) {
    if (entry.scope !== 'project') continue
    const key = memoryPathKey(entry.projectPath)
    const group = projects.get(key) ?? {
      path: entry.projectPath ?? '',
      name: entry.projectName || projectNameOf(entry.projectPath) || entry.projectPath || 'Project',
      entries: []
    }
    group.entries.push(entry)
    projects.set(key, group)
  }

  const header = '# Pi memory\n\n'
  let text = fits(header) ? header : ''
  if (!text) return ''
  const add = (line: string): boolean => {
    const candidate = `${text}${line}\n`
    if (!fits(candidate)) return false
    text = candidate
    return true
  }

  const addSection = (label: string, sectionEntries: MemoryEntry[]): boolean => {
    if (!sectionEntries.length) return true
    const sorted = [...sectionEntries].sort((a, b) => b.updatedAt - a.updatedAt)
    const heading = `## ${label}`
    // Do not leave a bare heading when there is no room for a single line.
    if (!fits(`${text}${heading}\n\n`)) return false
    text += `${heading}\n`
    for (const entry of sorted) {
      if (!add(`- ${entry.text}`)) return false
    }
    text += '\n'
    return true
  }

  for (const kind of KIND_ORDER) {
    if (!addSection(KIND_LABEL[kind], global.filter((entry) => entry.kind === kind))) break
  }

  for (const project of [...projects.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!fits(`${text}## Project: ${project.name}\n_${project.path}_\n\n`)) break
    text += `## Project: ${project.name}\n`
    if (project.path) text += `_${project.path}_\n\n`
    for (const kind of KIND_ORDER) {
      if (!addSection(KIND_LABEL[kind], project.entries.filter((entry) => entry.kind === kind))) {
        break
      }
    }
  }

  return text.replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/**
 * File-backed, human-readable memory. Entries are canonical; the markdown
 * summary is a projection, so deleting an entry cannot leave a stale line in
 * the prompt.
 */
export class MemoryStore {
  readonly root: string
  readonly entriesFile: string
  readonly ledgerFile: string
  readonly summaryFile: string
  readonly rolloutDir: string

  constructor(root: string) {
    this.root = path.resolve(root)
    this.entriesFile = path.join(this.root, 'memories.json')
    this.ledgerFile = path.join(this.root, 'state.json')
    this.summaryFile = path.join(this.root, 'memory_summary.md')
    this.rolloutDir = path.join(this.root, 'rollout_summaries')
  }

  ensure(): void {
    mkdirSync(this.root, { recursive: true })
    mkdirSync(this.rolloutDir, { recursive: true })
  }

  readEntries(): MemoryEntry[] {
    const file = readJson<MemoryFile>(this.entriesFile, { version: 1, updatedAt: 0, entries: [] })
    if (!Array.isArray(file.entries)) return []
    return file.entries
      .filter(
        (entry) =>
          entry &&
          typeof entry.id === 'string' &&
          typeof entry.text === 'string' &&
          (entry.scope === 'global' || entry.scope === 'project') &&
          KIND_ORDER.includes(entry.kind)
      )
      .map((entry) => ({
        ...entry,
        text: redactSecrets(entry.text).slice(0, MAX_ENTRY_CHARS)
      }))
  }

  writeEntries(entries: MemoryEntry[]): void {
    this.ensure()
    const next = enforceCaps(entries)
    writeJsonAtomic(this.entriesFile, {
      version: 1,
      updatedAt: Date.now(),
      entries: next
    } satisfies MemoryFile)
    writeTextAtomic(this.summaryFile, renderMemorySummary(next))
  }

  merge(candidates: MemoryCandidate[]): MergeResult {
    const entries = this.readEntries()
    const now = Date.now()
    let added = 0
    for (const raw of candidates) {
      const candidate = sanitizeCandidate(raw)
      if (!candidate) continue
      const projectKey = memoryPathKey(candidate.projectPath)
      const existing = entries.find(
        (entry) =>
          entry.scope === candidate.scope &&
          entry.kind === candidate.kind &&
          memoryPathKey(entry.projectPath) === projectKey &&
          similarText(entry.text, candidate.text)
      )
      if (existing) {
        existing.updatedAt = now
        if (candidate.source) existing.source = candidate.source
        continue
      }
      entries.push({
        id: randomUUID(),
        scope: candidate.scope,
        kind: candidate.kind,
        text: candidate.text,
        projectPath: candidate.projectPath,
        projectName: candidate.projectName,
        source: candidate.source,
        createdAt: now,
        updatedAt: now
      })
      added += 1
    }
    this.writeEntries(entries)
    return { added, total: this.readEntries().length }
  }

  remove(id: string): void {
    this.writeEntries(this.readEntries().filter((entry) => entry.id !== id))
  }

  clear(): void {
    this.ensure()
    writeJsonAtomic(this.entriesFile, { version: 1, updatedAt: Date.now(), entries: [] } satisfies MemoryFile)
    writeTextAtomic(this.summaryFile, '')
    writeJsonAtomic(this.ledgerFile, { version: 1, sessions: {} } satisfies MemoryLedgerFile)
    rmSync(this.rolloutDir, { recursive: true, force: true })
    mkdirSync(this.rolloutDir, { recursive: true })
  }

  summaryFor(cwd?: string): string {
    return renderMemorySummary(this.readEntries(), { cwd })
  }

  fullSummary(): string {
    return renderMemorySummary(this.readEntries())
  }

  readLedger(): MemoryLedgerFile {
    const file = readJson<MemoryLedgerFile>(this.ledgerFile, { version: 1, sessions: {} })
    return {
      version: 1,
      sessions: file && typeof file.sessions === 'object' && file.sessions ? file.sessions : {}
    }
  }

  private writeLedger(ledger: MemoryLedgerFile): void {
    writeJsonAtomic(this.ledgerFile, ledger)
  }

  /** True when this exact file revision has already been considered. */
  wasProcessed(file: string, stats?: { mtimeMs: number; size: number }): boolean {
    const record = this.readLedger().sessions[file]
    if (!record) return false
    const current = stats ?? statSafe(file)
    if (!current) return false
    return record.mtimeMs === current.mtimeMs && record.size === current.size
  }

  markProcessed(file: string, skipped?: string, lastError?: string): void {
    const stats = statSafe(file)
    if (!stats) return
    const ledger = this.readLedger()
    const previous = ledger.sessions[file]
    const attempts = skipped === 'error' ? (previous?.attempts ?? 0) + 1 : 0
    ledger.sessions[file] = {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      at: Date.now(),
      ...(skipped ? { skipped } : {}),
      ...(attempts ? { attempts } : {}),
      ...(lastError && skipped === 'error' ? { lastError } : {})
    }
    this.writeLedger(ledger)
  }

  sessionRecord(file: string): MemorySessionRecord | undefined {
    return this.readLedger().sessions[file]
  }

  writeRolloutSummary(
    sessionFile: string,
    payload: { cwd?: string; candidates: MemoryCandidate[]; raw?: string }
  ): void {
    this.ensure()
    const name = `${path.basename(sessionFile, path.extname(sessionFile))}.md`
    const file = path.join(this.rolloutDir, name)
    const lines = [
      `# Session memory`,
      '',
      `- session: ${sessionFile}`,
      `- cwd: ${payload.cwd ?? ''}`,
      `- learned_at: ${new Date().toISOString()}`,
      ''
    ]
    if (payload.candidates.length) {
      lines.push('## Entries', '')
      for (const candidate of payload.candidates) {
        lines.push(
          `- [${candidate.scope}/${candidate.kind}] ${redactSecrets(candidate.text).slice(0, MAX_ENTRY_CHARS)}`
        )
      }
      lines.push('')
    } else {
      lines.push('No durable memories were found.', '')
    }
    if (payload.raw?.trim()) {
      const raw = redactSecrets(payload.raw.trim()).slice(0, 20_000)
      lines.push('## Model output', '', '```text', raw, '```', '')
    }
    writeTextAtomic(file, lines.join('\n'))
  }

  state(pending: number, generating: boolean, lastError?: string): MemoryState {
    const entries = this.readEntries()
    const updatedAt = latestUpdatedAt(entries)
    return {
      root: this.root,
      summary: this.fullSummary(),
      entries,
      updatedAt,
      pending,
      generating,
      lastError
    }
  }
}

function statSafe(file: string): { mtimeMs: number; size: number } | undefined {
  try {
    const stat = statSync(file)
    return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : undefined
  } catch {
    return undefined
  }
}

function latestUpdatedAt(entries: MemoryEntry[]): number | undefined {
  let latest = 0
  for (const entry of entries) latest = Math.max(latest, entry.updatedAt || 0)
  return latest || undefined
}
