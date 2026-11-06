/**
 * Marketplace domain types.
 *
 * A marketplace entry is one GitHub repository that publishes a Pi plugin or a
 * set of Pi skills. The bundled snapshot is curated at build time; a refresh
 * updates the live numbers from GitHub without losing the curated copy.
 */
export type MarketplaceKind = 'plugin' | 'skill'

export type MarketplaceSort = 'stars' | 'updated' | 'name'

export interface MarketplaceEntry {
  /** `owner/repo`, unique inside a snapshot. */
  id: string
  kind: MarketplaceKind
  /** Display name; normally the repository name. */
  name: string
  /** `owner/repo` on GitHub. */
  repo: string
  url: string
  description: string
  stars: number
  forks: number
  language: string | null
  topics: string[]
  license: string | null
  /** ISO date of the last push, as reported by GitHub. */
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
}

export interface MarketplaceSnapshot {
  generatedAt: string
  source: 'github'
  minStars: number
  entries: MarketplaceEntry[]
  /** True when the numbers come from a cached GitHub refresh rather than the bundle. */
  live?: boolean
}

export interface MarketplaceInstallResult {
  ok: boolean
  /** CLI output, trimmed for the dialog. */
  output: string
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

  const sort = filter.sort ?? 'stars'
  return filtered.sort((a, b) => {
    if (sort === 'updated') {
      const delta = Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
      if (delta !== 0) return delta
    }
    if (sort === 'name') return collator.compare(a.name, b.name)
    if (b.stars !== a.stars) return b.stars - a.stars
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
