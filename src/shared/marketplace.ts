/**
 * Marketplace domain types.
 *
 * An entry is one package published to Pi's official catalog (`pi.dev/packages`).
 * The catalog lists packages published to npm; older snapshots could also come
 * from a GitHub topic search, so the source is explicit on the snapshot.
 */
export type MarketplaceKind = 'plugin' | 'skill' | 'theme' | 'prompt'

export type MarketplaceSort = 'downloads' | 'stars' | 'updated' | 'name'

export type MarketplaceEntrySource = 'pi' | 'github'

export interface MarketplaceEntry {
  /** The npm package name, unique inside a snapshot. */
  id: string
  kind: MarketplaceKind
  /** Display name; the npm package name. */
  name: string
  /** `owner/repo` on GitHub when the catalog links one. */
  repo: string
  /** The catalog page for this package. */
  url: string
  description: string
  stars: number
  forks: number
  language: string | null
  topics: string[]
  license: string | null
  /** ISO date of the last publish, as reported by the catalog. */
  updatedAt: string
  /**
   * How the entry is installed:
   * - `npm:<package>` — a published Pi package, installed by `pi install npm:...`
   * - `git:github.com/<owner>/<repo>` — a Pi package in a git repository
   * - `skills:github.com/<owner>/<repo>` — a plain skill collection cloned into
   *   `<agent dir>/skills/<repo>` (the layout Pi discovers recursively)
   */
  install: string
  /** npm package name when the repository publishes one. */
  npmPackage: string | null
  /** Known first-party packages get a mark in the UI. */
  official: boolean
  /** Shop category used for the filter row. */
  category: string
  /** Short badges shown under the description. */
  tags: string[]
  /** Where the entry came from. Absent means the bundled GitHub snapshot. */
  source?: MarketplaceEntrySource
  /** Monthly npm downloads, from Pi's catalog. */
  downloads?: number
  /** npm scope/author shown on the card. */
  author?: string
  /** Pi's own resource type (`extension`, `skill`, `theme`, `prompt`, `package`). */
  packageType?: string
}

export interface MarketplaceSnapshot {
  generatedAt: string
  source: MarketplaceEntrySource
  minStars: number
  entries: MarketplaceEntry[]
  /** True when the numbers come from a cached live refresh rather than a bundle. */
  live?: boolean
  /** Everything the catalog matches, not only the page in `entries`. */
  total?: number
}

/** One page of Pi's official package catalog. */
export interface PiCatalogQuery {
  query?: string
  kind?: MarketplaceKind
  sort?: MarketplaceSort
  page?: number
  /** Skip the in-memory page cache, so Refresh really re-reads the catalog. */
  force?: boolean
}

export interface PiCatalogPage {
  entries: MarketplaceEntry[]
  total: number
  page: number
  pageSize: number
}

export interface MarketplaceInstallResult {
  ok: boolean
  /** CLI output, trimmed for the dialog. */
  output: string
}

/**
 * One live line from an install that is still running.
 *
 * A package install is a `pi install` process that can take a minute and
 * prints its own progress; the dialog shows the newest line so a slow network
 * does not read as a frozen app. `runId` is minted by the renderer, so a
 * dialog ignores a line that belongs to another install.
 */
export interface MarketplaceInstallProgress {
  runId: string
  /** Newest line the CLI printed, already trimmed and shortened. */
  line: string
}

/** One package entry from Pi's `packages` settings, shown in the management view. */
export interface ManagedPackage {
  /** Stable key: `<scope>:<source>`. */
  id: string
  name: string
  source: string
  kind: 'plugin' | 'skill' | 'package'
  enabled: boolean
  scope: 'user' | 'project'
}

/** Result of a management/create action. */
export interface MarketplaceActionResult {
  ok: boolean
  output: string
  /** Created file or directory, when the action created a local resource. */
  path?: string
}

export interface CreateResourceInput {
  kind: 'plugin' | 'skill'
  name: string
  description: string
}

export interface MarketplaceFilter {
  kind: MarketplaceKind
  query?: string
  minStars?: number
  category?: string | null
  sort?: MarketplaceSort
}

const collator = new Intl.Collator('en', { sensitivity: 'base' })

/** Filter and sort marketplace entries. Kept pure so both the UI and tests use it. */
export function filterMarketplaceEntries(
  entries: MarketplaceEntry[],
  filter: MarketplaceFilter
): MarketplaceEntry[] {
  const needle = filter.query?.trim().toLowerCase() ?? ''
  const minStars = filter.minStars ?? 0
  const filtered = entries.filter((entry) => {
    if (entry.kind !== filter.kind) return false
    if (entry.stars < minStars) return false
    if (filter.category && entry.category !== filter.category) return false
    if (!needle) return true
    const haystack = [
      entry.name,
      entry.repo,
      entry.description,
      entry.category,
      ...entry.tags,
      ...entry.topics
    ]
      .join('\n')
      .toLowerCase()
    return haystack.includes(needle)
  })

  const sort = filter.sort ?? 'downloads'
  return filtered.sort((a, b) => {
    if (sort === 'updated') {
      const delta = Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
      if (delta !== 0) return delta
    }
    if (sort === 'name') return collator.compare(a.name, b.name)
    const left = sort === 'downloads' ? a.downloads ?? a.stars : a.stars
    const right = sort === 'downloads' ? b.downloads ?? b.stars : b.stars
    if (right !== left) return right - left
    return collator.compare(a.name, b.name)
  })
}

/** Categories that actually have entries of the given kind, in display order. */
export function marketplaceCategories(entries: MarketplaceEntry[], kind: MarketplaceKind): string[] {
  const preferred = ['全部', '效率', '上下文', '多代理', 'MCP', '模型', '界面', '安全', '开发', '研究', '其他']
  const present = new Set(entries.filter((entry) => entry.kind === kind).map((entry) => entry.category))
  return preferred.filter((category) => category === '全部' || present.has(category))
}

/** Compact star label used on cards: 1.2k, 18.4k. */
export function formatStarCount(stars: number): string {
  if (stars >= 1000) {
    const value = stars / 1000
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}k`
  }
  return String(stars)
}

/** Monthly downloads as the catalog states them: 3.3M/mo, 173.7k/mo. */
export function formatDownloads(downloads: number): string {
  if (!Number.isFinite(downloads) || downloads <= 0) return '—'
  if (downloads >= 1_000_000) {
    const value = downloads / 1_000_000
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}M/mo`
  }
  if (downloads >= 1_000) {
    const value = downloads / 1_000
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}k/mo`
  }
  return `${downloads}/mo`
}
