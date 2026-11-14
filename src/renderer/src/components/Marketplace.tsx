import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  FileText,
  GitBranch,
  Loader2,
  Package,
  Palette,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  Sparkles,
  UserRound,
  X
} from 'lucide-react'
import type { AppLanguage } from '@shared/types'
import type {
  MarketplaceEntry,
  MarketplaceKind,
  MarketplaceSnapshot,
  MarketplaceSort
} from '@shared/marketplace'
import { formatDownloads } from '@shared/marketplace'
import { formatRelativeTime } from '../lib/format'
import { useT } from '../lib/i18n'
import { useAppStore } from '../store/useAppStore'
import { ConfirmDialog } from './ConfirmDialog'
import { Popover } from './Popover'
import { CreateResourceDialog, ResourceManager, type CreateMode } from './ResourceManager'
import '../styles/marketplace.css'

const INSTALLED_STORAGE_KEY = 'pi-desktop.marketplace.installed'

/**
 * The create control is a menu, not a single button: a local plugin, an npm
 * package and a cloned repository are three different doors, and the dialog
 * opens on the one the user picked.
 */
const CREATE_OPTIONS: {
  mode: CreateMode
  icon: typeof Plus
  label: string
  description: string
}[] = [
  {
    mode: 'custom',
    icon: Plus,
    label: 'Create your own',
    description: 'Create a plugin or skill in this project.'
  },
  {
    mode: 'npm',
    icon: Package,
    label: 'npm package',
    description: 'Install from npm'
  },
  {
    mode: 'github',
    icon: GitBranch,
    label: 'GitHub repository',
    description: 'Clone a repository and install it.'
  }
]

type MarketplaceStatus = 'loading' | 'ready' | 'error'
type ToastTone = 'success' | 'error'

interface ToastState {
  id: number
  tone: ToastTone
  title: string
  note?: string
}

const SORT_OPTIONS: { value: MarketplaceSort; label: string }[] = [
  { value: 'downloads', label: 'Most downloaded' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'name', label: 'Name' }
]

const EMPTY_SNAPSHOT: MarketplaceSnapshot = {
  generatedAt: new Date(0).toISOString(),
  source: 'pi',
  minStars: 0,
  entries: []
}

const KIND_ICONS: Record<MarketplaceKind, typeof Package> = {
  plugin: Package,
  skill: Sparkles,
  theme: Palette,
  prompt: FileText
}

const KIND_LABELS: Record<MarketplaceKind, string> = {
  plugin: 'Plugins',
  skill: 'Skills',
  theme: 'Themes',
  prompt: 'Prompt templates'
}

const PAGE_SIZE = 50

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Collapse CLI output to one readable, truncated line for a card. */
function truncateOutput(output: string, limit = 180): string {
  const text = output.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function relativeFromIso(iso: string, language: AppLanguage): string {
  const timestamp = Date.parse(iso)
  return Number.isNaN(timestamp) ? '' : formatRelativeTime(timestamp, language)
}

/** Installed ids are a view convenience, so they survive leaving the page. */
function readInstalledIds(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(INSTALLED_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return {}
    const result: Record<string, boolean> = {}
    for (const id of parsed) {
      if (typeof id === 'string') result[id] = true
    }
    return result
  } catch {
    return {}
  }
}

/** Deterministic tile colour for an entry whose upstream avatar cannot load. */
function avatarColor(name: string): string {
  let hash = 0
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) | 0
  }
  return `hsl(${((hash % 360) + 360) % 360} 55% 48%)`
}

/**
 * The card's upstream mark.
 *
 * GitHub serves an owner's avatar at `github.com/<owner>.png`; the renderer
 * loads it directly and lets the browser cache it, the way DSH's market does.
 * The initial tile is the fallback for a repo with no owner, a blocked image
 * or an offline machine — never a broken image icon.
 */
function MarketplaceAvatar({ entry }: { entry: MarketplaceEntry }) {
  const [failed, setFailed] = useState(false)
  const owner = entry.repo.includes('/') ? entry.repo.slice(0, entry.repo.indexOf('/')) : ''
  const displayName = entry.name.replace(/^(?:pi|dsh)[-_]?/i, '').trim()
  const initial = displayName.charAt(0).toUpperCase()
    || entry.name.trim().charAt(0).toUpperCase()
    || 'P'
  if (!owner || failed) {
    return (
      <span
        className="marketplace-card__sigil marketplace-card__sigil--initial"
        data-kind={entry.kind}
        style={{ backgroundColor: avatarColor(entry.name) }}
        aria-hidden="true"
      >
        {initial}
      </span>
    )
  }
  return (
    <span className="marketplace-card__sigil" data-kind={entry.kind} data-has-icon="true" aria-hidden="true">
      <img
        className="marketplace-card__avatar"
        src={`https://github.com/${encodeURIComponent(owner)}.png?size=96`}
        alt=""
        width={40}
        height={40}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </span>
  )
}

function MarketplaceSkeleton() {
  return (
    <div className="marketplace-card marketplace-card--skeleton" aria-hidden="true">
      <div className="marketplace-skeleton__head">
        <span className="marketplace-skeleton__sigil" />
        <span className="marketplace-skeleton__lines">
          <span className="marketplace-skeleton__line marketplace-skeleton__line--title" />
          <span className="marketplace-skeleton__line marketplace-skeleton__line--repo" />
        </span>
      </div>
      <span className="marketplace-skeleton__line" />
      <span className="marketplace-skeleton__line" />
      <span className="marketplace-skeleton__line marketplace-skeleton__line--short" />
      <span className="marketplace-skeleton__line marketplace-skeleton__line--command" />
    </div>
  )
}

function MarketplaceCard({
  entry,
  language,
  installed,
  installing,
  installBusy,
  canInstall,
  installError,
  onInstall,
  onOpenGithub,
  onOpenNpm,
  onCopy
}: {
  entry: MarketplaceEntry
  language: AppLanguage
  installed: boolean
  installing: boolean
  installBusy: boolean
  canInstall: boolean
  installError?: string
  onInstall: (entry: MarketplaceEntry) => void
  onOpenGithub: (entry: MarketplaceEntry) => void
  onOpenNpm: (entry: MarketplaceEntry) => void
  onCopy: (entry: MarketplaceEntry) => void
}) {
  const t = useT()
  const updated = relativeFromIso(entry.updatedAt, language)
  // The category is already its own chip; a tag that repeats it would read as
  // a duplicate badge ("MCP MCP").
  const tags = entry.tags.filter(
    (tag, index) => tag !== entry.category && entry.tags.indexOf(tag) === index
  )

  return (
    <article className="marketplace-card" data-installed={installed || undefined} aria-label={entry.name}>
      <div className="marketplace-card__head">
        <div className="marketplace-card__identity">
          <MarketplaceAvatar entry={entry} />
          <div className="marketplace-card__names">
            <div className="marketplace-card__title-row">
              <h3 className="marketplace-card__title" title={entry.name}>
                {entry.name}
              </h3>
              {entry.official ? (
                <span className="settings-tag" data-tone="accent">
                  {t('Official')}
                </span>
              ) : null}
            </div>
            <span className="marketplace-card__repo" title={entry.repo || entry.author}>
              {entry.repo || entry.author || ''}
            </span>
          </div>
        </div>
      </div>

      <p className="marketplace-card__desc" title={entry.description}>
        {entry.description || t('No description provided.')}
      </p>

      <div className="marketplace-card__meta">
        {entry.source === 'pi' ? (
          <>
            <span className="marketplace-card__stat marketplace-card__stars" title={t('Downloads per month')}>
              <Download size={12} />
              {formatDownloads(entry.downloads ?? 0)}
            </span>
            {entry.author ? (
              <span className="marketplace-card__stat" title={t('Author')}>
                <UserRound size={12} />
                {entry.author}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span className="marketplace-card__stat marketplace-card__stars" title={t('Stars')}>
              <Package size={12} />
              {entry.stars >= 1000 ? `${(entry.stars / 1000).toFixed(1)}k` : entry.stars}
            </span>
            <span className="marketplace-card__stat" title={t('Forks')}>
              <GitBranch size={12} />
              {entry.forks >= 1000 ? `${(entry.forks / 1000).toFixed(1)}k` : entry.forks}
            </span>
            {entry.language ? (
              <span className="marketplace-card__stat" title={t('Programming language')}>
                <span className="marketplace-card__dot" aria-hidden="true" />
                {entry.language}
              </span>
            ) : null}
          </>
        )}
        {updated ? (
          <span className="marketplace-card__stat" title={t('Last updated')}>
            {updated}
          </span>
        ) : null}
      </div>

      <div className="marketplace-card__badges">
        {entry.category ? <span className="settings-tag">{entry.category}</span> : null}
        {tags.map((tag) => (
          <span className="settings-tag" key={tag}>
            {tag}
          </span>
        ))}
      </div>

      <div className="marketplace-card__command">
        <code title={entry.install}>{entry.install}</code>
        {entry.npmPackage ? (
          <button
            type="button"
            className="marketplace-card__npm"
            title={t('Open on npm')}
            aria-label={t('Open on npm')}
            onClick={() => onOpenNpm(entry)}
          >
            npm
          </button>
        ) : null}
        <button
          type="button"
          className="icon-btn"
          title={t('Copy install command')}
          aria-label={t('Copy install command')}
          onClick={() => onCopy(entry)}
        >
          <Copy size={12} />
        </button>
      </div>

      {installError ? (
        <p className="marketplace-card__error" title={installError} role="alert">
          <AlertTriangle size={12} />
          <span>{installError}</span>
        </p>
      ) : null}

      <div className="marketplace-card__actions">
        <button
          type="button"
          className="btn btn--sm btn--primary marketplace-card__install"
          disabled={installed || installing || installBusy || !canInstall}
          aria-busy={installing || undefined}
          title={canInstall ? undefined : t('The marketplace is not available in this build.')}
          onClick={() => onInstall(entry)}
        >
          {installing ? (
            <Loader2 size={13} className="spin" />
          ) : installed ? (
            <Check size={13} />
          ) : (
            <Download size={13} />
          )}
          {installing ? t('Installing…') : installed ? t('Installed') : t('Install')}
        </button>
        {entry.repo ? (
          <button
            type="button"
            className="btn btn--sm marketplace-card__github"
            title={t('Open the repository on GitHub')}
            onClick={() => onOpenGithub(entry)}
          >
            <ExternalLink size={13} />
            {t('GitHub')}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--sm marketplace-card__github"
            title={t('Open the package page')}
            onClick={() => onOpenGithub(entry)}
          >
            <ExternalLink size={13} />
            {t('Details')}
          </button>
        )}
      </div>
    </article>
  )
}

export function Marketplace() {
  const t = useT()
  const language = useAppStore((state) => state.settings.language)
  const [snapshot, setSnapshot] = useState<MarketplaceSnapshot>(EMPTY_SNAPSHOT)
  const [status, setStatus] = useState<MarketplaceStatus>('loading')
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [kind, setKind] = useState<MarketplaceKind>('plugin')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<MarketplaceSort>('downloads')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [installed, setInstalled] = useState<Record<string, boolean>>(readInstalledIds)
  const [serverInstalled, setServerInstalled] = useState<string[]>([])
  const [mineOnly, setMineOnly] = useState(false)
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({})
  const [pendingInstall, setPendingInstall] = useState<MarketplaceEntry | null>(null)
  const [view, setView] = useState<'marketplace' | 'manage'>('marketplace')
  const [createOpen, setCreateOpen] = useState(false)
  const [createMode, setCreateMode] = useState<CreateMode>('custom')
  const [toast, setToast] = useState<ToastState | null>(null)
  // A slow page from the mount must not overwrite a newer search.
  const requestSeq = useRef(0)

  const catalog = window.pi?.marketplace?.piCatalog
  const canInstall = typeof window.pi?.marketplace?.installNpm === 'function'
  const canRefresh = typeof catalog === 'function'
  const hasFilters = query.trim().length > 0 || mineOnly

  const showToast = useCallback((tone: ToastTone, title: string, note?: string) => {
    setToast({ id: Date.now(), tone, title, note })
  }, [])

  const loadPage = useCallback(
    async (nextPage: number, append: boolean, force = false) => {
      if (typeof catalog !== 'function') {
        setError(t('The marketplace is not available in this build.'))
        setStatus('error')
        return false
      }
      const seq = ++requestSeq.current
      if (append) setLoadingMore(true)
      else {
        setStatus('loading')
        setError('')
      }
      try {
        const result = await catalog({
          query: query.trim() || undefined,
          kind,
          sort,
          page: nextPage,
          force: force || undefined
        })
        if (seq !== requestSeq.current) return
        setSnapshot((previous) => ({
          generatedAt: new Date().toISOString(),
          source: 'pi',
          minStars: 0,
          entries: append ? [...previous.entries, ...result.entries] : result.entries,
          total: result.total,
          live: true
        }))
        setPage(nextPage)
        setTotal(result.total)
        setStatus('ready')
      } catch (cause) {
        if (seq !== requestSeq.current) return false
        if (append) showToast('error', t('Could not load more packages'), truncateOutput(errorMessage(cause)))
        else {
          setError(errorMessage(cause))
          setStatus('error')
        }
        return false
      } finally {
        if (append && seq === requestSeq.current) setLoadingMore(false)
      }
      return true
    },
    [catalog, kind, query, sort, showToast, t]
  )

  useEffect(() => {
    // Typing filters the server-side catalog; wait for a pause instead of
    // asking for one page per keystroke.
    const timer = window.setTimeout(() => void loadPage(1, false), query.trim() ? 300 : 0)
    return () => window.clearTimeout(timer)
  }, [loadPage, query])

  useEffect(() => {
    let cancelled = false
    const installedFn = window.pi?.marketplace?.installed
    if (typeof installedFn !== 'function') return
    void installedFn()
      .then((ids) => {
        if (cancelled || !Array.isArray(ids)) return
        const list = ids.filter((id): id is string => typeof id === 'string')
        setServerInstalled(list)
        // The two marks answer the same question. Once the file is readable it
        // is the truth, so a package removed on the Manage page cannot stay
        // "Installed" through the localStorage fallback.
        const known = new Set(list.map((id) => id.toLowerCase()))
        setInstalled((previous) => {
          const next: Record<string, boolean> = {}
          for (const [id, value] of Object.entries(previous)) {
            if (known.has(id.toLowerCase())) next[id] = value
          }
          return Object.keys(next).length === Object.keys(previous).length ? previous : next
        })
      })
      .catch(() => {
        // The local marks still work when the settings file cannot be read.
      })
    return () => {
      cancelled = true
    }
    // Leaving the Manage page can have removed or added a package; re-reading
    // the installed list keeps a card from staying disabled as "Installed".
  }, [view])

  useEffect(() => {
    try {
      localStorage.setItem(INSTALLED_STORAGE_KEY, JSON.stringify(Object.keys(installed)))
    } catch {
      // A blocked storage write only costs the installed marks; the page still works.
    }
  }, [installed])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const refresh = useCallback(async () => {
    if (typeof catalog !== 'function') {
      showToast('error', t('The marketplace is not available in this build.'))
      return
    }
    setRefreshing(true)
    try {
      const ok = await loadPage(1, false, true)
      if (ok) showToast('success', t('Marketplace updated'))
      else showToast('error', t('Could not refresh the marketplace'))
    } finally {
      setRefreshing(false)
    }
  }, [catalog, loadPage, showToast, t])

  const install = useCallback(
    async (entry: MarketplaceEntry) => {
      // Official catalog entries install through `pi install npm:<package>`;
      // the old GitHub lookup only knows the bundled snapshot.
      const installFn = window.pi?.marketplace?.installNpm
      if (typeof installFn !== 'function') {
        setInstallErrors((prev) => ({
          ...prev,
          [entry.id]: t('The marketplace is not available in this build.')
        }))
        return
      }
      setInstallingId(entry.id)
      setInstallErrors((prev) => {
        if (!(entry.id in prev)) return prev
        const next = { ...prev }
        delete next[entry.id]
        return next
      })
      try {
        const result = await installFn(entry.npmPackage ?? entry.id)
        if (result.ok) {
          setInstalled((prev) => ({ ...prev, [entry.id]: true }))
          showToast('success', t('Install complete'), t('Restart Pi Desktop to load it.'))
        } else {
          const output = truncateOutput(result.output) || t('Install failed')
          setInstallErrors((prev) => ({ ...prev, [entry.id]: output }))
          showToast('error', t('Install failed'), output)
        }
      } catch (cause) {
        const output = truncateOutput(errorMessage(cause))
        setInstallErrors((prev) => ({ ...prev, [entry.id]: output }))
        showToast('error', t('Install failed'), output || undefined)
      } finally {
        setInstallingId(null)
      }
    },
    [showToast, t]
  )

  const requestInstall = useCallback(
    (entry: MarketplaceEntry) => {
      if (!canInstall) {
        setInstallErrors((prev) => ({
          ...prev,
          [entry.id]: t('The marketplace is not available in this build.')
        }))
        return
      }
      if (installingId) return
      setPendingInstall(entry)
    },
    [canInstall, installingId, t]
  )

  const copyCommand = useCallback(
    async (entry: MarketplaceEntry) => {
      try {
        if (!navigator.clipboard) throw new Error('Clipboard is unavailable')
        // The card shows the source argument; the command the user pastes has
        // to include the executable, or it would only print a package name.
        await navigator.clipboard.writeText(`pi install ${entry.install}`)
        showToast('success', t('Copied to clipboard'))
      } catch {
        showToast('error', t('Could not copy the install command'))
      }
    },
    [showToast, t]
  )

  const openGithub = useCallback(
    (entry: MarketplaceEntry) => {
      void window.pi.shell
        .openExternal(entry.url)
        .catch(() => showToast('error', t('Could not open the package page')))
    },
    [showToast, t]
  )

  const openNpm = useCallback(
    (entry: MarketplaceEntry) => {
      if (!entry.npmPackage) return
      void window.pi.shell
        .openExternal(`https://www.npmjs.com/package/${entry.npmPackage}`)
        .catch(() => showToast('error', t('Could not open the npm page')))
    },
    [showToast, t]
  )

  const installedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const id of Object.keys(installed)) ids.add(id.toLowerCase())
    for (const id of serverInstalled) ids.add(id.toLowerCase())
    return ids
  }, [installed, serverInstalled])

  const mineCount = useMemo(
    () =>
      snapshot.entries.filter(
        (entry) => entry.kind === kind && installedIds.has(entry.id.toLowerCase())
      ).length,
    [snapshot.entries, kind, installedIds]
  )

  const visible = useMemo(() => {
    return mineOnly
      ? snapshot.entries.filter((entry) => installedIds.has(entry.id.toLowerCase()))
      : snapshot.entries
  }, [snapshot.entries, mineOnly, installedIds])

  const kindTotal = total
  const updatedLabel = snapshot.entries.length
    ? relativeFromIso(snapshot.generatedAt, language)
    : ''
  const searchLabel = t('Search Pi packages…')

  const switchKind = (next: MarketplaceKind) => {
    setKind(next)
  }

  const clearFilters = () => {
    setQuery('')
    setMineOnly(false)
  }

  const finishCreate = (path?: string) => {
    setCreateOpen(false)
    if (path) {
      showToast('success', t('Created'), path)
      // A local scaffold lives under the agent directory and is not a package
      // entry yet, so the package manager would show nothing for it.
      setView('marketplace')
    } else {
      showToast('success', t('Install complete'), t('Restart Pi Desktop to load it.'))
      setView('manage')
    }
  }

  const toastNode = toast ? (
    <div className="marketplace-toast" data-tone={toast.tone} role="status">
      {toast.tone === 'success' ? <Check size={15} /> : <AlertTriangle size={15} />}
      <div className="marketplace-toast__body">
        <strong>{toast.title}</strong>
        {toast.note ? <span>{toast.note}</span> : null}
      </div>
    </div>
  ) : null

  return (
    <div className="marketplace-page">
      {view === 'manage' ? (
        <ResourceManager onBack={() => setView('marketplace')} />
      ) : (
        <>
          <div className="marketplace-top">
            <div className="segmented marketplace-tabs" role="group" aria-label={t('Marketplace sections')}>
              {(Object.keys(KIND_LABELS) as MarketplaceKind[]).map((value) => {
                const Icon = KIND_ICONS[value]
                return (
                  <button
                    key={value}
                    type="button"
                    data-active={kind === value}
                    aria-pressed={kind === value}
                    onClick={() => switchKind(value)}
                  >
                    <Icon size={13} />
                    {t(KIND_LABELS[value])}
                  </button>
                )
              })}
            </div>
            <div className="marketplace-top__actions">
              <Popover
                align="left"
                width={256}
                className="marketplace-create-menu__popover"
                renderTrigger={({ open, toggle }) => (
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    aria-haspopup="menu"
                    aria-expanded={open}
                    onClick={toggle}
                  >
                    <Plus size={13} />
                    {t('Create')}
                    <ChevronDown
                      size={12}
                      className="marketplace-create-menu__caret"
                      data-open={open}
                    />
                  </button>
                )}
              >
                {(close) => (
                  <div className="marketplace-create-menu" role="menu">
                    {CREATE_OPTIONS.map(({ mode, icon: Icon, label, description }) => (
                      <button
                        key={mode}
                        type="button"
                        role="menuitem"
                        className="marketplace-create-menu__item"
                        onClick={() => {
                          close()
                          setCreateMode(mode)
                          setCreateOpen(true)
                        }}
                      >
                        <span className="marketplace-create-menu__icon">
                          <Icon size={15} />
                        </span>
                        <span className="marketplace-create-menu__text">
                          <span className="marketplace-create-menu__title">{t(label)}</span>
                          <span className="marketplace-create-menu__desc" title={t(description)}>
                            {t(description)}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </Popover>
              <button type="button" className="btn btn--sm" onClick={() => setView('manage')}>
                <Settings2 size={13} />
                {t('Manage')}
              </button>
            </div>
          </div>
          <header className="marketplace-head">
        <div className="marketplace-head__intro">
          <h2 className="marketplace-head__title">{t('Pi Package Catalog')}</h2>
          <p className="marketplace-head__desc">
            {t('Every extension, skill, theme and prompt published to npm for Pi. Install one with a click.')}
          </p>
        </div>
        <div className="marketplace-head__actions">
          {updatedLabel ? (
            <span className="marketplace-updated">
              {t('Updated {time}').replace('{time}', updatedLabel)}
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void refresh()}
            disabled={refreshing || !canRefresh}
            title={canRefresh ? undefined : t('The marketplace is not available in this build.')}
          >
            <RefreshCw size={13} className={refreshing ? 'spin' : undefined} />
            {refreshing ? t('Refreshing…') : t('Refresh')}
          </button>
        </div>
      </header>

      <div className="marketplace-security" role="note">
        <ShieldAlert size={14} aria-hidden="true" />
        <span>
          {t(
            'Third-party plugins and skills run with your full permissions. Install only sources you trust.'
          )}
        </span>
      </div>

      <div className="marketplace-toolbar">
        <div className="marketplace-toolbar__controls">
          <div className="settings-search marketplace-search">
            <Search size={13} />
            <input
              type="search"
              value={query}
              aria-label={searchLabel}
              placeholder={searchLabel}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <button
                type="button"
                className="icon-btn"
                aria-label={t('Clear the filter')}
                onClick={() => setQuery('')}
              >
                <X size={12} />
              </button>
            ) : null}
          </div>

          <div
            className="segmented segmented--tight marketplace-sort"
            role="group"
            aria-label={t('Sort by')}
          >
            {SORT_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.value}
                data-active={sort === option.value}
                aria-pressed={sort === option.value}
                onClick={() => setSort(option.value)}
              >
                {t(option.label)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="marketplace-categories" role="group" aria-label={t('Filters')}>
        <button
          type="button"
          className="pill marketplace-mine"
          data-active={mineOnly}
          aria-pressed={mineOnly}
          onClick={() => setMineOnly((value) => !value)}
        >
          <UserRound size={13} />
          {t('Mine')}
          {mineCount > 0 ? <span className="marketplace-mine__count">{mineCount}</span> : null}
        </button>
      </div>

      {error && !(status === 'error' && snapshot.entries.length === 0) ? (
        <div className="marketplace-banner" role="alert">
          <AlertTriangle size={14} />
          <span>{truncateOutput(error, 240)}</span>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void loadPage(1, false)}
          >
            {t('Retry')}
          </button>
        </div>
      ) : null}

      {status === 'loading' && snapshot.entries.length === 0 ? (
        <div className="marketplace-grid" aria-busy="true" aria-label={t('Loading the marketplace…')}>
          {Array.from({ length: 6 }, (_, index) => (
            <MarketplaceSkeleton key={index} />
          ))}
        </div>
      ) : status === 'error' && snapshot.entries.length === 0 ? (
        <div className="marketplace-empty marketplace-empty--error" role="alert">
          <ShieldAlert size={20} />
          <strong>{t('Could not load the marketplace.')}</strong>
          <span>{truncateOutput(error, 240)}</span>
          <button type="button" className="btn btn--sm" onClick={() => void loadPage(1, false)}>
            {t('Retry')}
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div className="marketplace-empty">
          <Package size={20} />
          <strong>
            {mineOnly && mineCount === 0
              ? t('You have not installed any plugins or skills yet.')
              : kindTotal === 0
                ? t('No packages are available in this section yet.')
                : t('No entries match your filters.')}
          </strong>
          {kindTotal > 0 && !(mineOnly && mineCount === 0) ? (
            <span>{t('Try a different search or clear the filters.')}</span>
          ) : null}
          {hasFilters ? (
            <button type="button" className="btn btn--sm" onClick={clearFilters}>
              {t('Clear filters')}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="marketplace-grid">
          {visible.map((entry) => (
            <MarketplaceCard
              key={entry.id}
              entry={entry}
              language={language}
              installed={installedIds.has(entry.id.toLowerCase())}
              installing={installingId === entry.id}
              installBusy={installingId !== null}
              canInstall={canInstall}
              installError={installErrors[entry.id]}
              onInstall={requestInstall}
              onOpenGithub={openGithub}
              onOpenNpm={openNpm}
              onCopy={copyCommand}
            />
          ))}
        </div>
      )}

      {status === 'ready' && !mineOnly && visible.length > 0 && page * PAGE_SIZE < total ? (
        <div className="marketplace-more">
          <button
            type="button"
            className="btn btn--sm"
            disabled={loadingMore}
            onClick={() => void loadPage(page + 1, true)}
          >
            {loadingMore ? <Loader2 size={13} className="spin" /> : <ChevronDown size={13} />}
            {loadingMore ? t('Loading…') : t('Load more')}
          </button>
        </div>
      ) : null}

        </>
      )}

      {toastNode}

      {pendingInstall ? (
        <ConfirmDialog
          title={t('Install {name}?').replace('{name}', pendingInstall.name)}
          body={t(
            'Third-party plugins and skills run with full system permissions. Only install sources you trust.'
          )}
          confirmLabel="Install"
          onConfirm={() => {
            const entry = pendingInstall
            setPendingInstall(null)
            void install(entry)
          }}
          onCancel={() => setPendingInstall(null)}
        />
      ) : null}

      {createOpen ? (
        <CreateResourceDialog
          initialMode={createMode}
          onClose={() => setCreateOpen(false)}
          onCreated={finishCreate}
        />
      ) : null}
    </div>
  )
}
