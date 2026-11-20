import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import type {
  MarketplaceEntry,
  MarketplaceKind,
  MarketplaceSort,
  PiCatalogPage,
  PiCatalogQuery
} from '@shared/marketplace'

/**
 * Pi's official package catalog.
 *
 * `pi.dev/packages` is a server-rendered page, not a JSON API: each card is an
 * `<article data-package-card="true">` with its fields on data attributes and
 * in a few well-known classes. The parser below is deliberately tolerant — it
 * reads the attributes first and only falls back to the visible text — so a
 * small markup change loses a field rather than the whole catalog.
 *
 * The server takes seconds to answer a cold page, and search and type filters
 * must be sent to it: the catalog has thousands of packages, and filtering only
 * the first page locally would hide most of them. So a page is cached twice —
 * in memory and on disk — and a cached page older than the five-minute TTL is
 * still painted immediately while a fresh copy is fetched in the background.
 */
const PI_CATALOG_URL = 'https://pi.dev/packages'
const PAGE_SIZE = 50
const CACHE_TTL_MS = 5 * 60 * 1000
/** How long a page may be painted from disk after it stops being fresh. */
const MAX_STALE_MS = 24 * 60 * 60 * 1000
const MAX_CACHE_ENTRIES = 24
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const USER_AGENT = 'pi-desktop-marketplace/1.0'

interface CacheEntry {
  at: number
  page: PiCatalogPage
}

const pageCache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<PiCatalogPage>>()
let cacheFile: string | null = null
let diskLoaded = false
let writeChain: Promise<void> = Promise.resolve()

/** Point the disk cache at the app's own data folder; null turns it off. */
export function configurePiCatalogCache(file: string | null): void {
  cacheFile = file
  diskLoaded = false
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

/** Decode the handful of entities pi.dev emits in attribute values and text. */
export function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
}

function attribute(block: string, name: string): string {
  const match = new RegExp(`${name}="([^"]*)"`, 'i').exec(block)
  return match ? decodeHtml(match[1]) : ''
}

function firstMatch(block: string, pattern: RegExp): string {
  const match = pattern.exec(block)
  return match ? match[1] : ''
}

/** Pi's catalog type for a marketplace tab. */
function catalogType(kind: MarketplaceKind | undefined): string {
  if (kind === 'skill') return 'skill'
  if (kind === 'theme') return 'theme'
  if (kind === 'prompt') return 'prompt'
  // Plugins are `extension` or generic `package` entries; the catalog only
  // filters one type at a time, so the plugin tab asks for everything and the
  // parser keeps the plugin-shaped results.
  return ''
}

function kindOf(packageType: string): MarketplaceKind {
  if (packageType === 'skill') return 'skill'
  if (packageType === 'theme') return 'theme'
  if (packageType === 'prompt') return 'prompt'
  return 'plugin'
}

function sortParam(sort: MarketplaceSort | undefined): string {
  if (sort === 'name') return 'name'
  if (sort === 'updated') return 'recent'
  return 'downloads'
}

function isPluginType(packageType: string): boolean {
  return packageType === 'extension' || packageType === 'package' || packageType === ''
}

/** Map one `<article data-package-card>` block into the shared entry shape. */
export function parsePiCatalogCard(block: string): MarketplaceEntry | null {
  const name = attribute(block, 'data-package-name')
  if (!name) return null
  const packageType = firstMatch(
    block,
    /class="meta-chip packages-badge"[^>]*data-type="([^"]+)"/i
  ) || attribute(block, 'data-package-types').split(',')[0]?.trim() || 'package'
  const description = firstMatch(block, /<p class="packages-desc">([\s\S]*?)<\/p>/i)
  const meta = firstMatch(block, /<div class="packages-meta">([\s\S]*?)<\/div>/i)
  const metaParts = [...meta.matchAll(/<span>([\s\S]*?)<\/span>/gi)].map((match) =>
    stripTags(match[1])
  )
  const author = metaParts[0] ?? ''
  const downloads = Number(attribute(block, 'data-package-downloads')) || 0
  const publishedAt = Number(attribute(block, 'data-package-date')) || 0
  const repoMatch = /href="(https:\/\/github\.com\/[^"]+)"/i.exec(block)
  const repoUrl = repoMatch ? decodeHtml(repoMatch[1]).replace(/\/+$/, '') : ''
  const repo = repoUrl
    ? repoUrl.replace(/^https:\/\/github\.com\//i, '').replace(/\/+$/, '')
    : ''
  const createdAt = publishedAt > 0 ? new Date(publishedAt).toISOString() : ''

  return {
    id: name,
    kind: kindOf(packageType),
    name,
    repo,
    url: `https://pi.dev/packages/${encodeURIComponent(name)}`,
    description: stripTags(description),
    stars: 0,
    forks: 0,
    language: null,
    topics: [],
    license: null,
    updatedAt: createdAt,
    install: `npm:${name}`,
    npmPackage: name,
    official: author.toLowerCase() === 'earendil-works' || name.startsWith('@earendil-works/'),
    category: packageType,
    tags: packageType ? [packageType] : [],
    source: 'pi',
    downloads,
    author,
    packageType
  }
}

/** Parse one catalog page. Exported so tests can run against a saved page. */
export function parsePiCatalogHtml(html: string): { entries: MarketplaceEntry[]; total: number } {
  const cards = [...html.matchAll(/<article\b[^>]*data-package-card="true"[\s\S]*?<\/article>/gi)]
  const entries: MarketplaceEntry[] = []
  for (const match of cards) {
    const entry = parsePiCatalogCard(match[0])
    if (entry) entries.push(entry)
  }
  const countText = firstMatch(html, /<span class="packages-count">([^<]+)<\/span>/i)
  const number = (value: string | undefined): number | null => {
    if (!value) return null
    const digits = value.replace(/[^\d]/g, '')
    return digits ? Number(digits) : null
  }
  // "1-50 / 5398" is one page of the whole catalog; "1-14 / 14 (of 5398)" is a
  // filtered result whose own count is the middle number.
  const filtered = /\(of\s+[\d,]+\)/i.test(countText)
  const total = filtered
    ? number(countText.split('(of')[0].split('/').pop()) ?? entries.length
    : number(countText.split('/').pop()) ?? entries.length
  return { entries, total }
}

function pageUrl(query: PiCatalogQuery): string {
  const url = new URL(PI_CATALOG_URL)
  const page = Math.max(1, Math.floor(query.page ?? 1))
  if (page > 1) url.searchParams.set('page', String(page))
  const name = query.query?.trim()
  if (name) url.searchParams.set('name', name)
  const type = catalogType(query.kind)
  if (type) url.searchParams.set('type', type)
  url.searchParams.set('sort', sortParam(query.sort))
  return url.toString()
}

async function downloadPage(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { Accept: 'text/html', 'User-Agent': USER_AGENT },
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`The Pi package catalog answered HTTP ${response.status}.`)
    const reader = response.body?.getReader()
    if (!reader) return await response.text()
    const chunks: Uint8Array[] = []
    let bytes = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        throw new Error('The Pi package catalog page was too large.')
      }
      chunks.push(value)
    }
    const decoder = new TextDecoder()
    return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One page of the official catalog, with search, type and sort applied.
 *
 * A page younger than the TTL is returned as is. An older page is still
 * returned — instantly — while a fresh copy is fetched for the next reader; a
 * manual refresh (`force`) waits for the network instead. Network failures fall
 * back to the cached page when one exists: a marketplace that shows the last
 * response is more useful than an empty error screen.
 */
export async function fetchPiCatalog(query: PiCatalogQuery = {}): Promise<PiCatalogPage> {
  loadDiskCache()
  const page = Math.max(1, Math.floor(query.page ?? 1))
  const key = cacheKey(query, page)
  const cached = pageCache.get(key)
  if (!query.force) {
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.page
    if (cached) {
      // Yesterday's catalog opens at once; the fresh copy lands in the cache
      // for the next open instead of making this one wait.
      void sharedFetch(key, query, page).catch(() => {})
      return cached.page
    }
  }
  try {
    return await sharedFetch(key, query, page)
  } catch (error) {
    if (cached) return cached.page
    throw error
  }
}

function cacheKey(query: PiCatalogQuery, page: number): string {
  return JSON.stringify({
    query: query.query?.trim() ?? '',
    kind: query.kind ?? 'plugin',
    sort: query.sort ?? 'downloads',
    page
  })
}

/** One request per page even when a prefetch and a click ask at once. */
function sharedFetch(key: string, query: PiCatalogQuery, page: number): Promise<PiCatalogPage> {
  const running = inFlight.get(key)
  if (running) return running
  const request = loadPageFromNetwork(key, query, page)
  inFlight.set(key, request)
  const settle = () => {
    if (inFlight.get(key) === request) inFlight.delete(key)
  }
  void request.then(settle, settle)
  return request
}

async function loadPageFromNetwork(
  key: string,
  query: PiCatalogQuery,
  page: number
): Promise<PiCatalogPage> {
  const html = await downloadPage(pageUrl({ ...query, page }))
  const parsed = parsePiCatalogHtml(html)
  const entries =
    query.kind === 'plugin'
      ? parsed.entries.filter((entry) => isPluginType(entry.packageType ?? ''))
      : parsed.entries
  const result: PiCatalogPage = {
    entries,
    total: parsed.total,
    page,
    pageSize: PAGE_SIZE
  }
  pageCache.set(key, { at: Date.now(), page: result })
  trimCache()
  persistCache()
  return result
}

function trimCache(): void {
  if (pageCache.size <= MAX_CACHE_ENTRIES) return
  const oldest = [...pageCache.entries()].sort((a, b) => a[1].at - b[1].at)
  for (const [key] of oldest.slice(0, pageCache.size - MAX_CACHE_ENTRIES)) pageCache.delete(key)
}

/**
 * Read the last session's pages once, before the first request. The file is
 * only a warm start: an unreadable or oversized cache is ignored and the next
 * network page rewrites it.
 */
function loadDiskCache(): void {
  if (diskLoaded) return
  diskLoaded = true
  if (!cacheFile) return
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, 'utf8')) as {
      entries?: Array<{ key?: unknown; at?: unknown; page?: PiCatalogPage }>
    }
    if (!Array.isArray(parsed.entries)) return
    const now = Date.now()
    for (const entry of parsed.entries) {
      if (!entry || typeof entry.key !== 'string' || typeof entry.at !== 'number') continue
      if (!entry.page || !Array.isArray(entry.page.entries)) continue
      if (now - entry.at > MAX_STALE_MS) continue
      pageCache.set(entry.key, { at: entry.at, page: entry.page })
    }
    trimCache()
  } catch {
    // No cache yet, or it was written by a different version: start cold.
  }
}

/** Write the cache in the background; the response never waits on the disk. */
function persistCache(): void {
  if (!cacheFile) return
  const file = cacheFile
  const entries = [...pageCache.entries()]
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_CACHE_ENTRIES)
    .map(([key, entry]) => ({ key, at: entry.at, page: entry.page }))
  const payload = JSON.stringify({ version: 1, entries })
  writeChain = writeChain
    .then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      const temp = `${file}.tmp`
      await fs.writeFile(temp, payload, 'utf8')
      await fs.rename(temp, file)
    })
    .catch(() => {})
}
