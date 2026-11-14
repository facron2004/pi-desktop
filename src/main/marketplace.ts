import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import type {
  CreateResourceInput,
  ManagedPackage,
  MarketplaceActionResult,
  MarketplaceEntry,
  MarketplaceInstallResult,
  MarketplaceSnapshot
} from '@shared/marketplace'
import { MARKETPLACE_SNAPSHOT } from '@shared/marketplace-data'
import { runPiCli } from './pi/cli'
import { properLockfile } from './proper-lockfile'
import { openWorkspaceFile, resolveWorkspacePath } from './workspace-files'

/** Cache file under the Electron userData directory holding the last refresh. */
export const MARKETPLACE_CACHE_FILE = 'marketplace-cache.json'

/** GitHub search queries. Kept to four topic searches: the unauthenticated API
 *  allows ten requests a minute, and a broader search such as
 *  `topic:pi-coding-agent` finds coding agents that are not Pi packages at all. */
const GITHUB_SEARCH_QUERIES = [
  'topic:pi-package',
  'topic:pi-extension',
  'topic:pi-skill',
  'topic:pi-skills'
]

const GITHUB_HEADERS: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'pi-desktop-marketplace',
  'X-GitHub-Api-Version': '2022-11-28'
}

/** Stars a repository needs before a refresh may add it to the marketplace. */
const DEFAULT_MIN_STARS = 100
export const MAX_MARKETPLACE_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_MARKETPLACE_CACHE_BYTES = 4 * 1024 * 1024
const MAX_MARKETPLACE_SETTINGS_BYTES = 8 * 1024 * 1024

/** How long `pi install` or a skill collection clone may take. */
const INSTALL_TIMEOUT_MS = 180000
const packageSettingsLockWait = new Int32Array(new SharedArrayBuffer(4))

/** The cache file's on-disk shape. */
export interface MarketplaceCache {
  fetchedAt: string
  entries: MarketplaceEntry[]
}

export interface MarketplaceInstallOptions {
  cwd?: string
  customPiPath?: string
  /** Receives the CLI's output as it arrives, for a dialog that shows progress. */
  onProgress?: (chunk: string) => void
}

export type MarketplaceInstallSource = 'npm' | 'git' | 'skills'

type PackageScope = 'user' | 'project'

/** The four resource filters Pi uses to express a disabled package. */
const PACKAGE_FILTER_KEYS = ['extensions', 'skills', 'prompts', 'themes'] as const

/** The workspace the last `listManagedPackages` call read, used by the
 *  project-scope set/remove actions whose IPC signature carries only the id. */
let managedWorkspacePath: string | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function cloneEntry(entry: MarketplaceEntry): MarketplaceEntry {
  return { ...entry, topics: [...entry.topics], tags: [...entry.tags] }
}

function effectiveMinStars(snapshot: MarketplaceSnapshot): number {
  return Number.isFinite(snapshot.minStars) && snapshot.minStars > 0
    ? snapshot.minStars
    : DEFAULT_MIN_STARS
}

/**
 * What kind of install command an entry carries.
 *
 * `npm:` and `git:github.com/` are handled by the Pi CLI. `skills:` points at a
 * plain skill collection with no package manifest, which has to be cloned into
 * Pi's own skills directory. Anything else is rejected before it reaches a
 * process: an entry's source never comes from the renderer.
 */
const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/

/** A repository path segment must not be a dot segment (`.` / `..`). */
function isRepoSegment(value: string): boolean {
  return REPO_SEGMENT.test(value) && value !== '.' && value !== '..'
}

export function installSourceKind(source: string): MarketplaceInstallSource | null {
  const value = source.trim()
  if (/^npm:\S+$/.test(value)) return 'npm'
  const git = /^git:github\.com\/([^/]+)\/([^/]+)$/.exec(value)
  if (git && isRepoSegment(git[1]) && isRepoSegment(git[2])) return 'git'
  const skills = /^skills:github\.com\/([^/]+)\/([^/]+)$/.exec(value)
  if (skills && isRepoSegment(skills[1]) && isRepoSegment(skills[2])) return 'skills'
  return null
}

/**
 * Canonical spelling of a package source read from Pi's `packages` setting.
 *
 * Settings collect whatever install command the user typed, so the same
 * repository can appear as `git:github.com/owner/repo@main`,
 * `https://github.com/owner/repo/` or a plain `npm:` package. Marketplace
 * entries use one spelling of each; this helper turns a settings value into
 * that spelling, or null when the source is not a GitHub repository.
 */
export function normaliseInstalledSource(source: string): string | null {
  if (typeof source !== 'string') return null
  let value = source.trim()
  if (!value) return null
  value = value.replace(/\/+$/, '')

  if (value.startsWith('npm:')) {
    const name = value.slice('npm:'.length)
    return name ? `npm:${name}` : null
  }

  const direct = /^git:github\.com\/(.+)$/i.exec(value)
  const url = /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)(?:[?#].*)?$/i.exec(value)
  const skills = /^skills:github\.com\/(.+)$/i.exec(value)
  if (!direct && !url && !skills) return null

  let owner: string
  let repo: string
  let prefix = 'git:github.com'
  if (direct) {
    const parts = direct[1].split('/')
    owner = parts[0]
    repo = parts.slice(1).join('/')
  } else if (url) {
    owner = url[1]
    repo = url[2]
  } else {
    const parts = skills ? skills[1].split('/') : []
    owner = parts[0] ?? ''
    repo = parts.slice(1).join('/')
    prefix = 'skills:github.com'
  }

  // A `@ref` suffix and a `.git` suffix name the same repository.
  const at = repo.indexOf('@')
  if (at >= 0) repo = repo.slice(0, at)
  repo = repo.replace(/\.git$/i, '')
  owner = owner.replace(/\.git$/i, '')
  if (!owner || !repo || !isRepoSegment(owner) || !isRepoSegment(repo)) return null
  return `${prefix}/${owner}/${repo}`
}

function isMarketplaceEntry(value: unknown): value is MarketplaceEntry {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    value.id.includes('/') &&
    (value.kind === 'plugin' || value.kind === 'skill') &&
    typeof value.name === 'string' &&
    typeof value.repo === 'string' &&
    typeof value.url === 'string' &&
    typeof value.description === 'string' &&
    finiteNumber(value.stars) !== null &&
    finiteNumber(value.forks) !== null &&
    (typeof value.language === 'string' || value.language === null) &&
    Array.isArray(value.topics) &&
    value.topics.every((topic) => typeof topic === 'string') &&
    (typeof value.license === 'string' || value.license === null) &&
    typeof value.updatedAt === 'string' &&
    typeof value.install === 'string' &&
    (typeof value.npmPackage === 'string' || value.npmPackage === null) &&
    typeof value.official === 'boolean' &&
    typeof value.category === 'string' &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === 'string')
  )
}

/**
 * Merge a live snapshot over the curated one.
 *
 * Curated copy wins for every field that describes the entry — description,
 * category, tags, install command, official mark. GitHub wins for the numbers
 * that change: stars, forks, language and the last push date. Repositories the
 * bundle does not know yet are appended when they clear the curated star bar.
 */
export function mergeMarketplaceSnapshot(
  base: MarketplaceSnapshot,
  live: MarketplaceSnapshot
): MarketplaceSnapshot {
  const minStars = effectiveMinStars(base)
  const liveById = new Map<string, MarketplaceEntry>()
  for (const entry of live.entries) liveById.set(entry.id.toLowerCase(), entry)

  const curatedIds = new Set<string>()
  const entries = base.entries.map((entry) => {
    const key = entry.id.toLowerCase()
    curatedIds.add(key)
    const fresh = liveById.get(key)
    if (!fresh) return cloneEntry(entry)
    return {
      ...cloneEntry(entry),
      stars: fresh.stars,
      forks: fresh.forks,
      language: fresh.language,
      updatedAt: fresh.updatedAt || entry.updatedAt
    }
  })

  const additions: MarketplaceEntry[] = []
  const addedIds = new Set<string>()
  const candidates = live.entries
    .filter(
      (entry) =>
        !curatedIds.has(entry.id.toLowerCase()) &&
        entry.stars >= minStars &&
        installSourceKind(entry.install) !== null
    )
    .sort((left, right) => right.stars - left.stars || left.name.localeCompare(right.name))
  for (const entry of candidates) {
    const key = entry.id.toLowerCase()
    if (addedIds.has(key)) continue
    addedIds.add(key)
    additions.push(cloneEntry(entry))
  }

  return {
    generatedAt: live.generatedAt || base.generatedAt,
    source: 'github',
    minStars,
    entries: [...entries, ...additions],
    live: true
  }
}

function readMarketplaceCache(userDataDir: string): MarketplaceCache | null {
  try {
    const file = path.join(userDataDir, MARKETPLACE_CACHE_FILE)
    const stats = statSync(file)
    if (!stats.isFile() || stats.size > MAX_MARKETPLACE_CACHE_BYTES) return null
    const raw = readFileSync(file, 'utf8')
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''))
    if (
      !isRecord(parsed) ||
      typeof parsed.fetchedAt !== 'string' ||
      !parsed.fetchedAt.trim() ||
      !Array.isArray(parsed.entries)
    ) {
      return null
    }
    return {
      fetchedAt: parsed.fetchedAt,
      entries: parsed.entries.filter(isMarketplaceEntry)
    }
  } catch {
    // A missing or corrupt cache is not an error: the bundle is the snapshot.
    return null
  }
}

function writeMarketplaceCache(userDataDir: string, snapshot: MarketplaceSnapshot): void {
  try {
    mkdirSync(userDataDir, { recursive: true })
    const file = path.join(userDataDir, MARKETPLACE_CACHE_FILE)
    const temporary = `${file}.tmp`
    const payload: MarketplaceCache = {
      fetchedAt: snapshot.generatedAt,
      entries: snapshot.entries
    }
    writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(temporary, file)
  } catch (error) {
    // The refreshed snapshot is still useful for this session even when the
    // cache cannot be written (read-only profile, disk full, ...).
    console.error('[pi-desktop] failed to write marketplace cache:', error)
  }
}

/**
 * The bundled snapshot, with the last cached refresh layered over it.
 *
 * `userDataDir` is injectable so tests and the screenshot harness can point at
 * a throwaway profile. The cache is advisory: every curated entry survives it.
 */
export async function listMarketplace(
  userDataDir: string = app.getPath('userData')
): Promise<MarketplaceSnapshot> {
  const cache = readMarketplaceCache(userDataDir)
  if (!cache) {
    return { ...MARKETPLACE_SNAPSHOT, entries: MARKETPLACE_SNAPSHOT.entries.map(cloneEntry) }
  }
  return mergeMarketplaceSnapshot(MARKETPLACE_SNAPSHOT, {
    generatedAt: cache.fetchedAt,
    source: 'github',
    minStars: effectiveMinStars(MARKETPLACE_SNAPSHOT),
    entries: cache.entries,
    live: true
  })
}

/** Read package sources from a parsed Pi settings file. */
function packageSources(parsed: Record<string, unknown> | null): string[] {
  if (!parsed || !Array.isArray(parsed.packages)) return []
  const sources: string[] = []
  for (const item of parsed.packages) {
    if (typeof item === 'string') {
      sources.push(item)
    } else if (isRecord(item)) {
      if (typeof item.source === 'string') sources.push(item.source)
      else if (typeof item.package === 'string') sources.push(item.package)
    }
  }
  return sources
}

/** A skill collection counts as installed when its clone has a `.git` child or
 *  a `SKILL.md` at the repository root or one directory below it. */
function hasInstalledSkillDirectory(agentDir: string, repo: string): boolean {
  const target = path.join(agentDir, 'skills', repo)
  try {
    if (!statSync(target).isDirectory()) return false
    if (existsSync(path.join(target, '.git'))) return true
    if (existsSync(path.join(target, 'SKILL.md'))) return true
    for (const child of readdirSync(target, { withFileTypes: true })) {
      if (!child.isDirectory()) continue
      if (existsSync(path.join(target, child.name, 'SKILL.md'))) return true
    }
  } catch {
    return false
  }
  return false
}

/**
 * Marketplace entry ids that Pi already has installed, read from the agent
 * settings and the optional project settings. `skills:` entries are also
 * detected from the clone in the agent's skills directory, because they never
 * appear in the `packages` list.
 */
export async function listInstalledMarketplaceIds(
  options: { cwd?: string; userDataDir?: string } = {}
): Promise<string[]> {
  const snapshot = await listMarketplace(options.userDataDir)
  const agentDir = agentDirectory()
  const installedSources = new Set<string>()
  const userSettings = readSettingsDocument(path.join(agentDir, 'settings.json'))
  for (const source of packageSources(userSettings)) {
    const normalized = normaliseInstalledSource(source)
    if (normalized) installedSources.add(normalized.toLowerCase())
  }
  const cwd = options.cwd && options.cwd.trim() ? path.resolve(options.cwd.trim()) : undefined
  if (cwd) {
    const projectSettings = await readWorkspaceSettingsDocument(cwd, '.pi/settings.json')
    for (const source of packageSources(projectSettings?.document ?? null)) {
      const normalized = normaliseInstalledSource(source)
      if (normalized) installedSources.add(normalized.toLowerCase())
    }
  }

  const ids: string[] = []
  const seen = new Set<string>()
  for (const entry of snapshot.entries) {
    const key = entry.id.toLowerCase()
    if (seen.has(key)) continue
    const entrySource = normaliseInstalledSource(entry.install)
    let installed = entrySource !== null && installedSources.has(entrySource.toLowerCase())
    if (!installed && entry.kind === 'skill' && /^skills:github\.com\//i.test(entry.install.trim())) {
      const slash = entry.repo.indexOf('/')
      const repo = slash >= 0 ? entry.repo.slice(slash + 1) : ''
      if (repo && isRepoSegment(repo)) installed = hasInstalledSkillDirectory(agentDir, repo)
    }
    if (installed) {
      seen.add(key)
      ids.push(entry.id)
    }
  }
  return ids
}

/** The source string of one `packages` entry, or null when the entry is unusable. */
function packageSourceOf(value: unknown): string | null {
  if (typeof value === 'string') {
    const source = value.trim()
    return source || null
  }
  if (!isRecord(value)) return null
  const source =
    typeof value.source === 'string' && value.source.trim()
      ? value.source
      : typeof value.package === 'string'
        ? value.package
        : ''
  const trimmed = source.trim()
  return trimmed || null
}

function parseSettingsDocument(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readSettingsDocument(file: string): Record<string, unknown> | null {
  try {
    const stats = statSync(file)
    if (!stats.isFile() || stats.size > MAX_MARKETPLACE_SETTINGS_BYTES) return null
    return parseSettingsDocument(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

async function readWorkspaceSettingsDocument(
  root: string,
  relative: string
): Promise<{ target: string; document: Record<string, unknown> | null } | null> {
  const opened = await openWorkspaceFile(root, relative)
  if (!opened) return null
  try {
    const stats = await opened.handle.stat()
    if (!stats.isFile() || stats.size > MAX_MARKETPLACE_SETTINGS_BYTES) {
      return { target: opened.target, document: null }
    }

    const chunks: Buffer[] = []
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let size = 0
    while (size <= MAX_MARKETPLACE_SETTINGS_BYTES) {
      const length = Math.min(buffer.length, MAX_MARKETPLACE_SETTINGS_BYTES + 1 - size)
      const { bytesRead } = await opened.handle.read(buffer, 0, length, null)
      if (bytesRead === 0) break
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
      size += bytesRead
    }
    if (size > MAX_MARKETPLACE_SETTINGS_BYTES) {
      return { target: opened.target, document: null }
    }
    return {
      target: opened.target,
      document: parseSettingsDocument(Buffer.concat(chunks, size).toString('utf8'))
    }
  } catch {
    return { target: opened.target, document: null }
  } finally {
    await opened.handle.close().catch(() => {})
  }
}

function readPackageEntries(document: Record<string, unknown> | null): unknown[] {
  return document && Array.isArray(document.packages) ? document.packages : []
}

/**
 * Pi's disable representation keeps the package in the list with every
 * resource filter empty. A single omitted filter means the package is still
 * loading that resource type, so only all four present-and-empty disables it.
 */
function isDisabledPackageEntry(value: unknown): boolean {
  if (!isRecord(value)) return false
  return PACKAGE_FILTER_KEYS.every((key) => {
    const filter = value[key]
    return Array.isArray(filter) && filter.length === 0
  })
}

/** npm package name behind a settings source, including scoped names and a
 *  version suffix. Bare names (the `{ package }` form) are accepted too. */
function npmNameFromSource(source: string): string | null {
  let value = source.trim()
  if (!value) return null
  const lower = value.toLowerCase()
  if (lower.startsWith('npm:')) {
    value = value.slice('npm:'.length)
  } else if (
    lower.startsWith('git:') ||
    lower.startsWith('skills:') ||
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('github.com/') ||
    lower.startsWith('www.github.com/') ||
    lower.startsWith('file:') ||
    value.startsWith('.') ||
    value.startsWith('/') ||
    value.includes('\\')
  ) {
    return null
  }
  if (value.startsWith('@')) {
    const slash = value.indexOf('/')
    if (slash < 0) return null
    const name = `${value.slice(0, slash + 1)}${value.slice(slash + 1).split('@')[0]}`
    return name || null
  }
  if (value.includes('/')) return null
  return value.split('@')[0] || null
}

function managedPackageName(source: string): string {
  const value = source.trim()
  if (value.toLowerCase().startsWith('npm:')) return npmNameFromSource(value) ?? value
  const normalized = normaliseInstalledSource(value)
  if (normalized?.startsWith('git:github.com/')) {
    const repo = normalized.slice('git:github.com/'.length)
    return repo.split('/').pop() || repo
  }
  if (normalized?.startsWith('skills:github.com/')) {
    const repo = normalized.slice('skills:github.com/'.length)
    return repo.split('/').pop() || repo
  }
  const npmName = npmNameFromSource(value)
  if (npmName) return npmName
  const cleaned = value.replace(/\/+$/, '').replace(/\.git$/i, '')
  return cleaned.split('/').pop() || cleaned || value
}

function findMarketplaceEntryForSource(source: string): MarketplaceEntry | undefined {
  const normalized = normaliseInstalledSource(source)?.toLowerCase()
  const npmName = npmNameFromSource(source)?.toLowerCase()
  const gitRepo = normalized?.startsWith('git:github.com/')
    ? normalized.slice('git:github.com/'.length)
    : undefined
  return MARKETPLACE_SNAPSHOT.entries.find((entry) => {
    const entryInstall = normaliseInstalledSource(entry.install)?.toLowerCase()
    if (normalized && entryInstall && normalized === entryInstall) return true
    if (entry.npmPackage && npmName && entry.npmPackage.toLowerCase() === npmName) return true
    if (gitRepo && entry.repo && entry.repo.toLowerCase() === gitRepo) return true
    return false
  })
}

function managedPackageKind(
  source: string,
  name: string,
  matched: MarketplaceEntry | undefined
): ManagedPackage['kind'] {
  if (matched) {
    return matched.kind === 'skill' ? 'skill' : matched.kind === 'plugin' ? 'plugin' : 'package'
  }
  if (/skill/i.test(`${source} ${name}`)) return 'skill'
  // An npm package outside the curated snapshot is still a package; a git
  // repository is treated as a plugin unless its name says skill.
  if (npmNameFromSource(source) !== null) return 'package'
  return 'plugin'
}

function packageSettingsFile(scope: PackageScope, workspacePath?: string): string | null {
  if (scope === 'user') return path.join(agentDirectory(), 'settings.json')
  const workspace = workspacePath && workspacePath.trim() ? path.resolve(workspacePath.trim()) : ''
  return workspace ? path.join(workspace, '.pi', 'settings.json') : null
}

function parseManagedPackageId(id: string): { scope: PackageScope; source: string } | null {
  if (typeof id !== 'string') return null
  const colon = id.indexOf(':')
  if (colon <= 0) return null
  const scope = id.slice(0, colon)
  const source = id.slice(colon + 1).trim()
  if ((scope !== 'user' && scope !== 'project') || !source) return null
  return { scope, source }
}

function writeSettingsDocument(file: string, document: Record<string, unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const target = existsSync(file) ? realpathSync(file) : file
  const temporary = `${target}.${randomUUID()}.tmp`
  const mode = existsSync(target) ? statSync(target).mode & 0o7777 : 0o600
  try {
    writeFileSync(temporary, JSON.stringify(document, null, 2), { encoding: 'utf8', mode })
    renameSync(temporary, target)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* the temporary file may not exist */ }
    throw error
  }
}

async function writeWorkspaceSettingsDocument(
  root: string,
  relative: string,
  target: string,
  document: Record<string, unknown>
): Promise<void> {
  const currentTarget = await resolveWorkspacePath(root, relative)
  if (currentTarget !== target) throw new Error('The project package settings changed while it was being updated.')

  const temporary = `${target}.${randomUUID()}.tmp`
  const mode = statSync(target).mode & 0o7777
  try {
    writeFileSync(temporary, JSON.stringify(document, null, 2), { encoding: 'utf8', mode })
    const latestTarget = await resolveWorkspacePath(root, relative)
    if (latestTarget !== target) {
      throw new Error('The project package settings changed while it was being updated.')
    }
    renameSync(temporary, target)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* the temporary file may not exist */ }
    throw error
  }
}

/** Coordinate package edits with Pi and the desktop's other settings writers. */
async function withPackageSettingsLock<T>(
  file: string,
  operation: () => Promise<T> | T
): Promise<T> {
  let release: () => void
  for (let attempt = 0; ; attempt += 1) {
    try {
      // Pi's settings manager uses realpath:false for both settings files.
      release = properLockfile.lockSync(file, { realpath: false, retries: 0 })
      break
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : undefined
      if (code !== 'ELOCKED' || attempt >= 49) throw error
      Atomics.wait(packageSettingsLockWait, 0, 0, 10)
    }
  }
  try {
    return await operation()
  } finally {
    try {
      release()
    } catch (error) {
      console.error('[pi-desktop] could not release package settings lock:', error)
    }
  }
}

function workspaceForPackageAction(cwd?: string): string | undefined {
  return cwd && cwd.trim() ? path.resolve(cwd.trim()) : managedWorkspacePath
}

async function withPackageSettingsDocument<T>(
  scope: PackageScope,
  file: string,
  workspaceRoot: string | undefined,
  operation: (
    document: Record<string, unknown>,
    write: (document: Record<string, unknown>) => Promise<void>
  ) => Promise<T> | T
): Promise<T> {
  const unreadable = () => new Error(`Could not read the package list from ${file}.`)

  if (scope === 'project') {
    if (!workspaceRoot) throw unreadable()
    const relative = '.pi/settings.json'
    const initial = await readWorkspaceSettingsDocument(workspaceRoot, relative)
    if (!initial?.document) throw unreadable()
    return await withPackageSettingsLock(initial.target, async () => {
      const current = await readWorkspaceSettingsDocument(workspaceRoot, relative)
      if (!current?.document || current.target !== initial.target) throw unreadable()
      return operation(current.document, (document) =>
        writeWorkspaceSettingsDocument(workspaceRoot, relative, initial.target, document)
      )
    })
  }

  if (!existsSync(file)) throw unreadable()
  return await withPackageSettingsLock(file, async () => {
    const document = readSettingsDocument(file)
    if (!document) throw unreadable()
    return operation(document, async (next) => writeSettingsDocument(file, next))
  })
}

/**
 * Packages configured in Pi's user settings and the open project's settings,
 * shaped for the management view. One row per (scope, source).
 */
export async function listManagedPackages(
  options: { cwd?: string } = {}
): Promise<ManagedPackage[]> {
  const cwd = options.cwd && options.cwd.trim() ? path.resolve(options.cwd.trim()) : undefined
  if (cwd) managedWorkspacePath = cwd

  const rows: ManagedPackage[] = []
  const seen = new Set<string>()
  const userFile = packageSettingsFile('user')
  const userSettings = userFile ? readSettingsDocument(userFile) : null
  const projectSettings = cwd
    ? await readWorkspaceSettingsDocument(cwd, '.pi/settings.json')
    : null
  const scopes: Array<{ scope: PackageScope; document: Record<string, unknown> | null }> = [
    { scope: 'user', document: userSettings },
    { scope: 'project', document: projectSettings?.document ?? null }
  ]
  for (const { scope, document } of scopes) {
    for (const raw of readPackageEntries(document)) {
      const source = packageSourceOf(raw)
      if (!source) continue
      const id = `${scope}:${source}`
      if (seen.has(id)) continue
      seen.add(id)
      const name = managedPackageName(source)
      rows.push({
        id,
        name,
        source,
        kind: managedPackageKind(source, name, findMarketplaceEntryForSource(source)),
        enabled: !isDisabledPackageEntry(raw),
        scope
      })
    }
  }
  return rows
}

/**
 * Enable or disable one managed package by rewriting its settings entry.
 * Disabling uses Pi's four-empty-filter representation; enabling removes those
 * filters and collapses a bare object back to a string.
 */
export async function setPackageEnabled(
  id: string,
  enabled: boolean,
  cwd?: string
): Promise<MarketplaceActionResult> {
  if (typeof enabled !== 'boolean') return { ok: false, output: 'Invalid package action.' }
  const parsed = parseManagedPackageId(id)
  if (!parsed) return { ok: false, output: 'Invalid package id.' }
  const workspaceRoot = parsed.scope === 'project' ? workspaceForPackageAction(cwd) : undefined
  const file = packageSettingsFile(parsed.scope, workspaceRoot)
  if (!file) return { ok: false, output: 'The project workspace is not available.' }
  try {
    return await withPackageSettingsDocument(parsed.scope, file, workspaceRoot, async (document, write) => {
      const packages = document && Array.isArray(document.packages) ? document.packages : null
      if (!document || !packages) {
        return { ok: false, output: `Could not read the package list from ${file}.` }
      }

      const indices: number[] = []
      packages.forEach((entry, index) => {
        if (packageSourceOf(entry) === parsed.source) indices.push(index)
      })
      if (!indices.length) return { ok: false, output: `Package not found: ${parsed.source}` }

      for (const index of indices) {
        const current = packages[index]
        if (enabled) {
          if (isRecord(current)) {
            const next: Record<string, unknown> = { ...current }
            for (const key of PACKAGE_FILTER_KEYS) delete next[key]
            const keys = Object.keys(next)
            const onlySource = keys.length === 1 && (keys[0] === 'source' || keys[0] === 'package')
            packages[index] = onlySource ? next[keys[0]] : next
          }
        } else if (typeof current === 'string') {
          packages[index] = {
            source: current.trim(),
            extensions: [],
            skills: [],
            prompts: [],
            themes: []
          }
        } else if (isRecord(current)) {
          packages[index] = {
            ...current,
            extensions: [],
            skills: [],
            prompts: [],
            themes: []
          }
        }
      }

      await write(document)
      return {
        ok: true,
        output: `${enabled ? 'Enabled' : 'Disabled'} package "${parsed.source}" (${parsed.scope}).`
      }
    })
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  }
}

/** Remove one package declaration from its settings file. The Pi CLI is not
 *  consulted: settings are the source of truth for what loads. */
export async function removePackage(
  id: string,
  cwd?: string
): Promise<MarketplaceActionResult> {
  const parsed = parseManagedPackageId(id)
  if (!parsed) return { ok: false, output: 'Invalid package id.' }
  const workspaceRoot = parsed.scope === 'project' ? workspaceForPackageAction(cwd) : undefined
  const file = packageSettingsFile(parsed.scope, workspaceRoot)
  if (!file) return { ok: false, output: 'The project workspace is not available.' }
  try {
    return await withPackageSettingsDocument(parsed.scope, file, workspaceRoot, async (document, write) => {
      const packages = document && Array.isArray(document.packages) ? document.packages : null
      if (!document || !packages) {
        return { ok: false, output: `Could not read the package list from ${file}.` }
      }
      let removed = 0
      for (let index = packages.length - 1; index >= 0; index -= 1) {
        if (packageSourceOf(packages[index]) === parsed.source) {
          packages.splice(index, 1)
          removed += 1
        }
      }
      if (!removed) return { ok: false, output: `Package not found: ${parsed.source}` }
      await write(document)
      return {
        ok: true,
        output: `Removed package "${parsed.source}" from ${parsed.scope} settings.`
      }
    })
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  }
}

function skillTemplate(name: string, description: string): string {
  const summary = description.replace(/\s+/g, ' ').trim()
  return `---\nname: ${name}\ndescription: ${summary}\n---\n\n# ${name}\n\n${description}\n\nUse this skill when working on ${name}.\n`
}

function pluginTemplate(name: string, description: string): string {
  return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand(${JSON.stringify(name)}, {
    description: ${JSON.stringify(description)},
    handler: async (_args, ctx) => {
      ctx.ui.notify(${JSON.stringify(`${name}: ${description}`)}, "info");
    }
  });
}
`
}

/**
 * Create a local skill or extension scaffold under the Pi agent directory.
 * Names are restricted to a lowercase slug so they are safe as path segments
 * and slash-command names.
 */
export async function createResource(input: CreateResourceInput): Promise<MarketplaceActionResult> {
  if (!isRecord(input)) return { ok: false, output: 'Invalid resource input.' }
  const kind = input.kind
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  if (kind !== 'plugin' && kind !== 'skill') {
    return { ok: false, output: 'Unsupported resource kind.' }
  }
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) {
    return { ok: false, output: 'Invalid resource name.' }
  }
  if (!description || description.length > 1024) {
    return { ok: false, output: 'Description is required and must be at most 1024 characters.' }
  }

  const agentDir = agentDirectory()
  const resourceRoot = path.join(agentDir, kind === 'skill' ? 'skills' : 'extensions')
  const directory = kind === 'skill' ? path.join(resourceRoot, name) : resourceRoot
  const target = kind === 'skill' ? path.join(directory, 'SKILL.md') : path.join(directory, `${name}.ts`)
  const alreadyExists = (): MarketplaceActionResult => ({
    ok: false,
    output: `${kind === 'skill' ? 'Skill' : 'Plugin'} "${name}" already exists.`
  })

  try {
    mkdirSync(agentDir, { recursive: true })
    try {
      mkdirSync(resourceRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const resourceRootStat = lstatSync(resourceRoot)
    if (resourceRootStat.isSymbolicLink() || !resourceRootStat.isDirectory()) {
      return { ok: false, output: 'The resource directory must be a real directory.' }
    }

    try {
      lstatSync(kind === 'skill' ? directory : target)
      return alreadyExists()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    if (kind === 'skill') mkdirSync(directory)
    writeFileSync(
      target,
      kind === 'skill' ? skillTemplate(name, description) : pluginTemplate(name, description),
      { encoding: 'utf8', flag: 'wx' }
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return alreadyExists()
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  }
  return {
    ok: true,
    output: `Created ${kind} "${name}".`,
    path: target
  }
}

/** Normalize the three GitHub repository forms the create dialog accepts. */
export function normaliseGitRepository(input: string): string | null {
  if (typeof input !== 'string') return null
  let value = input.trim()
  if (!value) return null
  value = value.replace(/\/+$/, '')
  const direct = normaliseInstalledSource(value)
  if (direct?.startsWith('git:github.com/')) return direct
  value = value
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\.git$/i, '')
  const parts = value.split('/')
  if (parts.length !== 2) return null
  const [owner, repo] = parts
  if (!isRepoSegment(owner) || !isRepoSegment(repo)) return null
  return `git:github.com/${owner}/${repo}`
}

/** Install any public GitHub repository as a Pi package. */
export async function installGitRepository(
  input: string,
  options: MarketplaceInstallOptions = {}
): Promise<MarketplaceInstallResult> {
  const source = normaliseGitRepository(input)
  if (!source) throw new Error('Invalid GitHub repository.')
  const result = await runPiCli(['install', source], {
    cwd: options.cwd && options.cwd.trim() ? options.cwd : undefined,
    customPiPath: options.customPiPath,
    timeoutMs: 180000,
    onOutput: options.onProgress
  })
  return {
    ok: result.code === 0,
    output: `${result.stdout}\n${result.stderr}`.trim()
  }
}

function networkFailure(error: unknown): Error {
  if (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  ) {
    return new Error('GitHub did not answer within 15 seconds. Check the network and try again.')
  }
  return new Error('Could not reach GitHub. Check the network connection and try again.')
}

function githubFailure(response: Response, body: string): Error {
  const status = response.status
  const header = (name: string): string | null => {
    const headers = response.headers
    return headers && typeof headers.get === 'function' ? headers.get(name) : null
  }
  if (status === 403 || status === 429) {
    const retryAfter = Number(header('retry-after'))
    const reset = Number(header('x-ratelimit-reset'))
    const remaining = header('x-ratelimit-remaining')
    const limited =
      status === 429 ||
      remaining === '0' ||
      (Number.isFinite(retryAfter) && retryAfter > 0)
    if (limited) {
      let seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0
      if (!seconds && Number.isFinite(reset) && reset > 0) {
        seconds = Math.max(1, Math.ceil(reset - Date.now() / 1000))
      }
      if (seconds > 0) {
        const minutes = Math.max(1, Math.ceil(seconds / 60))
        return new Error(
          `GitHub rate limit reached. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
        )
      }
      return new Error('GitHub rate limit reached. Try again later.')
    }
    return new Error(
      'GitHub rate limit reached or the marketplace search was refused (HTTP 403). Try again later.'
    )
  }

  // GitHub error pages can be HTML; only the API's own message is surfaced.
  let detail = ''
  try {
    const parsed: unknown = JSON.parse(body)
    if (isRecord(parsed) && typeof parsed.message === 'string') {
      detail = parsed.message.slice(0, 200)
    }
  } catch {
    /* deliberately ignore non-JSON bodies */
  }
  return new Error(
    `GitHub marketplace search failed (HTTP ${status}${detail ? `: ${detail}` : ''}).`
  )
}

function entryFromGitHubRepository(raw: unknown): MarketplaceEntry | null {
  if (!isRecord(raw)) return null
  const id = typeof raw.full_name === 'string' ? raw.full_name.trim() : ''
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(id)) return null

  const name =
    typeof raw.name === 'string' && raw.name.trim()
      ? raw.name.trim()
      : id.slice(id.indexOf('/') + 1)
  const topics = stringArray(raw.topics)
  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  const license =
    isRecord(raw.license) &&
    typeof raw.license.spdx_id === 'string' &&
    raw.license.spdx_id !== 'NOASSERTION'
      ? raw.license.spdx_id
      : null
  const updatedAt =
    typeof raw.pushed_at === 'string'
      ? raw.pushed_at
      : typeof raw.updated_at === 'string'
        ? raw.updated_at
        : ''

  return {
    id,
    kind: /skill/i.test(`${name} ${description} ${topics.join(' ')}`) ? 'skill' : 'plugin',
    name,
    repo: id,
    url:
      typeof raw.html_url === 'string' && raw.html_url
        ? raw.html_url
        : `https://github.com/${id}`,
    description,
    stars: finiteNumber(raw.stargazers_count) ?? 0,
    forks: finiteNumber(raw.forks_count) ?? 0,
    language: typeof raw.language === 'string' && raw.language ? raw.language : null,
    topics,
    license,
    updatedAt,
    install: `git:github.com/${id}`,
    npmPackage: null,
    official: false,
    category: '其他',
    tags: [...topics].slice(0, 4)
  }
}

class MarketplaceResponseTooLargeError extends Error {}

async function readResponseBody(response: Response): Promise<string> {
  const tooLarge = async (): Promise<never> => {
    await response.body?.cancel().catch(() => {})
    throw new MarketplaceResponseTooLargeError()
  }
  const contentLength = response.headers?.get?.('content-length')
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_MARKETPLACE_RESPONSE_BYTES) {
    return tooLarge()
  }

  const reader = response.body?.getReader()
  if (reader) {
    const chunks: Buffer[] = []
    let bytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (bytes + value.byteLength > MAX_MARKETPLACE_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {})
          throw new MarketplaceResponseTooLargeError()
        }
        const chunk = Buffer.from(value)
        chunks.push(chunk)
        bytes += chunk.length
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks, bytes).toString('utf8')
  }

  // Test doubles may only provide `text()` or `json()`; bound those fallback results too.
  if (typeof response.text === 'function') {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_MARKETPLACE_RESPONSE_BYTES) return tooLarge()
    return text
  }
  if (typeof response.json === 'function') {
    const text = JSON.stringify(await response.json())
    if (Buffer.byteLength(text, 'utf8') > MAX_MARKETPLACE_RESPONSE_BYTES) return tooLarge()
    return text
  }
  return ''
}

async function searchGitHub(query: string): Promise<MarketplaceEntry[]> {
  const url = new URL('https://api.github.com/search/repositories')
  url.searchParams.set('q', query)
  url.searchParams.set('sort', 'stars')
  url.searchParams.set('order', 'desc')
  url.searchParams.set('per_page', '100')

  let response: Response
  try {
    response = await fetch(url, {
      headers: GITHUB_HEADERS,
      signal: AbortSignal.timeout(15000)
    })
  } catch (error) {
    throw networkFailure(error)
  }

  let body: string
  try {
    body = await readResponseBody(response)
  } catch (error) {
    if (error instanceof MarketplaceResponseTooLargeError) {
      throw new Error(`GitHub returned a marketplace response larger than ${MAX_MARKETPLACE_RESPONSE_BYTES / 1024 / 1024} MB.`)
    }
    throw new Error('GitHub closed the connection while the marketplace was refreshing. Try again.')
  }
  if (!response.ok) throw githubFailure(response, body)

  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    throw new Error('GitHub returned an unexpected response while refreshing the marketplace.')
  }
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new Error('GitHub returned an unexpected search result while refreshing the marketplace.')
  }
  return payload.items
    .map(entryFromGitHubRepository)
    .filter((entry): entry is MarketplaceEntry => entry !== null)
}

/**
 * Query GitHub for current marketplace repositories and cache the merged
 * result. The curated copy is never replaced by a refresh — only its live
 * numbers change.
 */
export async function refreshMarketplace(
  userDataDir: string = app.getPath('userData')
): Promise<MarketplaceSnapshot> {
  const collected = new Map<string, MarketplaceEntry>()
  for (const query of GITHUB_SEARCH_QUERIES) {
    const found = await searchGitHub(query)
    for (const entry of found) {
      const key = entry.id.toLowerCase()
      const existing = collected.get(key)
      if (!existing) {
        collected.set(key, entry)
        continue
      }
      // The same repository can appear in more than one topic search.
      for (const topic of entry.topics) {
        if (!existing.topics.includes(topic)) existing.topics.push(topic)
      }
      for (const tag of entry.tags) {
        if (!existing.tags.includes(tag)) existing.tags.push(tag)
      }
    }
  }

  const snapshot = mergeMarketplaceSnapshot(MARKETPLACE_SNAPSHOT, {
    generatedAt: new Date().toISOString(),
    source: 'github',
    minStars: effectiveMinStars(MARKETPLACE_SNAPSHOT),
    entries: [...collected.values()],
    live: true
  })
  writeMarketplaceCache(userDataDir, snapshot)
  return snapshot
}

function agentDirectory(): string {
  const configured = process.env.PI_CODING_AGENT_DIR
  return configured && configured.trim()
    ? path.resolve(configured.trim())
    : path.join(os.homedir(), '.pi', 'agent')
}

function isPathWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

/** Resolve a skills collection destination without following a repository
 *  symlink placed inside Pi's skills directory. */
export function resolveSkillInstallTarget(
  skillsDirectory: string,
  repo: string
): { target: string; exists: boolean } | null {
  if (!isRepoSegment(repo)) return null

  const root = path.resolve(skillsDirectory)
  const target = path.resolve(root, repo)
  if (!isPathWithin(root, target)) return null

  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return null
  }

  try {
    const targetStat = lstatSync(target)
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) return null
    const realTarget = realpathSync(target)
    if (!isPathWithin(realRoot, realTarget)) return null
    return { target, exists: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { target, exists: false }
    }
    return null
  }
}

function runGit(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { timeout: INSTALL_TIMEOUT_MS, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`.trim()
        if (!error) {
          resolve({ ok: true, output })
          return
        }
        const detail = error.killed
          ? `git timed out after ${INSTALL_TIMEOUT_MS / 1000}s`
          : error.message
        resolve({ ok: false, output: [output, detail].filter(Boolean).join('\n') })
      }
    )
  })
}

async function installSkillCollection(source: string): Promise<MarketplaceInstallResult> {
  const match = /^skills:github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(source)
  if (!match) return { ok: false, output: 'Invalid skills install source.' }

  const [, owner, repo] = match
  // `path.join` would treat a bare `.` or `..` segment as a directory move;
  // reject it here even though the snapshot is curated, so a future data bug
  // cannot write outside the skills directory.
  if (!isRepoSegment(owner) || !isRepoSegment(repo)) {
    return { ok: false, output: 'Invalid skills install source.' }
  }
  const skillsDirectory = path.resolve(agentDirectory(), 'skills')
  try {
    mkdirSync(skillsDirectory, { recursive: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, output: message }
  }

  const destination = resolveSkillInstallTarget(skillsDirectory, repo)
  if (!destination) return { ok: false, output: 'Invalid skills install target.' }

  const result = destination.exists
    ? await runGit(['-C', destination.target, 'pull', '--ff-only'])
    : await runGit([
        'clone',
        '--depth',
        '1',
        `https://github.com/${owner}/${repo}`,
        destination.target
      ])
  return { ok: result.ok, output: result.output }
}

/** npm's own package-name alphabet: lowercase, digits, dot, dash, underscore,
 *  optionally behind one `@scope/`. This rejects whitespace, backslashes and
 *  path traversal before a name can become part of `pi install`'s argv. */
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/**
 * Install one npm package by name. The marketplace card for a search result
 * outside the curated snapshot only has a package name, so this validates it
 * here instead of trusting a raw source string from the renderer.
 */
export async function installNpmPackage(
  packageName: string,
  options: MarketplaceInstallOptions = {}
): Promise<MarketplaceInstallResult> {
  const name = typeof packageName === 'string' ? packageName.trim() : ''
  if (!name || name.length > 214 || !NPM_PACKAGE_NAME.test(name)) {
    throw new Error('Invalid npm package name.')
  }
  const result = await runPiCli(['install', `npm:${name}`], {
    cwd: options.cwd && options.cwd.trim() ? options.cwd : undefined,
    customPiPath: options.customPiPath,
    timeoutMs: 180000,
    onOutput: options.onProgress
  })
  return {
    ok: result.code === 0,
    output: `${result.stdout}\n${result.stderr}`.trim()
  }
}

/**
 * Install one marketplace entry by id. The source is looked up in the current
 * snapshot, so the renderer can never hand the main process a command to run.
 */
export async function installMarketplaceEntry(
  id: string,
  options: MarketplaceInstallOptions = {},
  userDataDir: string = app.getPath('userData')
): Promise<MarketplaceInstallResult> {
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('Invalid marketplace entry id.')
  }
  const snapshot = await listMarketplace(userDataDir)
  const wanted = id.trim().toLowerCase()
  const entry = snapshot.entries.find((item) => item.id.toLowerCase() === wanted)
  if (!entry) throw new Error(`Unknown marketplace entry: ${id}`)

  const source = entry.install.trim()
  const kind = installSourceKind(source)
  if (!kind) {
    throw new Error(`Marketplace entry ${entry.id} has an unsupported install source.`)
  }
  if (kind === 'skills') return installSkillCollection(source)

  const result = await runPiCli(['install', source], {
    cwd: options.cwd && options.cwd.trim() ? options.cwd : undefined,
    customPiPath: options.customPiPath,
    timeoutMs: 180000,
    onOutput: options.onProgress
  })
  return {
    ok: result.code === 0,
    output: `${result.stdout}\n${result.stderr}`.trim()
  }
}
