import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  ExternalLink,
  GitFork,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  Sparkles,
  Star,
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
import {
  filterMarketplaceEntries,
  formatStarCount,
  marketplaceCategories
} from '@shared/marketplace'
import { MARKETPLACE_SNAPSHOT } from '@shared/marketplace-data'
import { formatRelativeTime } from '../lib/format'
import { useT } from '../lib/i18n'
import { useAppStore } from '../store/useAppStore'
import { ConfirmDialog } from './ConfirmDialog'
import { CreateResourceDialog, ResourceManager } from './ResourceManager'
import '../styles/marketplace.css'

const INSTALLED_STORAGE_KEY = 'pi-desktop.marketplace.installed'

type MarketplaceStatus = 'loading' | 'ready' | 'error'
type ToastTone = 'success' | 'error'

interface ToastState {
  id: number
  tone: ToastTone
  title: string
  note?: string
}

const SORT_OPTIONS: { value: MarketplaceSort; label: string }[] = [
  { value: 'stars', label: 'Stars' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'name', label: 'Name' }
]

const MIN_STARS_OPTIONS = [0, 100, 300, 1000]

/** The same loose shape npm itself accepts for a package name. */
const NPM_PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

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
          <span className="marketplace-card__sigil" data-kind={entry.kind}>
            {entry.kind === 'skill' ? <Sparkles size={15} /> : <Package size={15} />}
          </span>
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
            <span className="marketplace-card__repo" title={entry.repo}>
              {entry.repo}
            </span>
          </div>
        </div>
      </div>

      <p className="marketplace-card__desc" title={entry.description}>
        {entry.description || t('No description provided.')}
      </p>

      <div className="marketplace-card__meta">
        <span className="marketplace-card__stat marketplace-card__stars" title={t('Stars')}>
          <Star size={12} />
          {formatStarCount(entry.stars)}
        </span>
        <span className="marketplace-card__stat" title={t('Forks')}>
          <GitFork size={12} />
          {formatStarCount(entry.forks)}
        </span>
        {entry.language ? (
          <span className="marketplace-card__stat" title={t('Programming language')}>
            <span className="marketplace-card__dot" aria-hidden="true" />
            {entry.language}
          </span>
        ) : null}
        {updated ? (
          <span className="marketplace-card__stat" title={t('Last updated')}>
            {updated}
          </span>
        ) : null}
      </div>

      <div className="marketplace-card__badges">
        <span className="settings-tag">{entry.category}</span>
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
        <button
          type="button"
          className="btn btn--sm marketplace-card__github"
          title={t('Open the repository on GitHub')}
          onClick={() => onOpenGithub(entry)}
        >
          <ExternalLink size={13} />
          {t('GitHub')}
        </button>
      </div>
    </article>
  )
}

export function Marketplace() {
  const t = useT()
  const language = useAppStore((state) => state.settings.language)
  const [snapshot, setSnapshot] = useState<MarketplaceSnapshot>(MARKETPLACE_SNAPSHOT)
  const [status, setStatus] = useState<MarketplaceStatus>('loading')
  const [error, setError] = useState('')
  const [errorFromRefresh, setErrorFromRefresh] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [kind, setKind] = useState<MarketplaceKind>('plugin')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<MarketplaceSort>('stars')
  const [minStars, setMinStars] = useState(0)
  const [category, setCategory] = useState<string | null>(null)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [installed, setInstalled] = useState<Record<string, boolean>>(readInstalledIds)
  const [serverInstalled, setServerInstalled] = useState<string[]>([])
  const [mineOnly, setMineOnly] = useState(false)
  const [npmName, setNpmName] = useState('')
  const [npmInstalling, setNpmInstalling] = useState(false)
  const [npmError, setNpmError] = useState('')
  const [pendingNpm, setPendingNpm] = useState<string | null>(null)
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({})
  const [pendingInstall, setPendingInstall] = useState<MarketplaceEntry | null>(null)
  const [view, setView] = useState<'marketplace' | 'manage'>('marketplace')
  const [createOpen, setCreateOpen] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  // A slow `list()` from the mount must not overwrite a newer `refresh()`.
  const requestSeq = useRef(0)

  const canInstall = typeof window.pi?.marketplace?.install === 'function'
  const canInstallNpm = typeof window.pi?.marketplace?.installNpm === 'function'
  const canRefresh = typeof window.pi?.marketplace?.refresh === 'function'
  const hasFilters =
    query.trim().length > 0 || minStars > 0 || category !== null || mineOnly

  const showToast = useCallback((tone: ToastTone, title: string, note?: string) => {
    setToast({ id: Date.now(), tone, title, note })
  }, [])

  const load = useCallback(async () => {
    const seq = ++requestSeq.current
    setStatus('loading')
    setError('')
    setErrorFromRefresh(false)
    const list = window.pi?.marketplace?.list
    if (typeof list !== 'function') {
      // An older preload only lacks the bridge; the bundled snapshot is still a
      // perfectly usable marketplace, so this is not an error state.
      setSnapshot(MARKETPLACE_SNAPSHOT)
      setStatus('ready')
      return
    }
    try {
      const next = await list()
      if (seq !== requestSeq.current) return
      setSnapshot(next)
      setStatus('ready')
    } catch (cause) {
      if (seq !== requestSeq.current) return
      setError(errorMessage(cause))
      setStatus('error')
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    let cancelled = false
    const installedFn = window.pi?.marketplace?.installed
    if (typeof installedFn !== 'function') return
    void installedFn()
      .then((ids) => {
        if (cancelled || !Array.isArray(ids)) return
        setServerInstalled(ids.filter((id): id is string => typeof id === 'string'))
      })
      .catch(() => {
        // The local marks still work when the settings file cannot be read.
      })
    return () => {
      cancelled = true
    }
  }, [])

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
    const refreshFn = window.pi?.marketplace?.refresh
    if (typeof refreshFn !== 'function') {
      showToast('error', t('The marketplace is not available in this build.'))
      return
    }
    const seq = ++requestSeq.current
    setRefreshing(true)
    setError('')
    setErrorFromRefresh(false)
    try {
      const next = await refreshFn()
      if (seq !== requestSeq.current) return
      setSnapshot(next)
      setStatus('ready')
      showToast('success', t('Marketplace updated'))
    } catch (cause) {
      if (seq !== requestSeq.current) return
      const message = errorMessage(cause)
      setError(message)
      setErrorFromRefresh(true)
      showToast('error', t('Could not refresh the marketplace'), truncateOutput(message))
    } finally {
      // A newer `load()` may have invalidated this refresh; the spinner still
      // has to stop, or the Refresh button stays disabled forever.
      setRefreshing(false)
    }
  }, [showToast, t])

  const install = useCallback(
    async (entry: MarketplaceEntry) => {
      const installFn = window.pi?.marketplace?.install
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
        const result = await installFn(entry.id)
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
      if (installingId || npmInstalling) return
      setPendingInstall(entry)
    },
    [canInstall, installingId, npmInstalling, t]
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
        .catch(() => showToast('error', t('Could not open the GitHub page')))
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

  const installNpm = useCallback(
    async (packageName: string) => {
      const installNpmFn = window.pi?.marketplace?.installNpm
      if (typeof installNpmFn !== 'function') {
        setNpmError(t('The marketplace is not available in this build.'))
        return
      }
      setNpmInstalling(true)
      setNpmError('')
      try {
        const result = await installNpmFn(packageName)
        if (result.ok) {
          const needle = packageName.toLowerCase()
          const match = snapshot.entries.find(
            (entry) =>
              entry.npmPackage?.toLowerCase() === needle ||
              entry.install.toLowerCase() === `npm:${needle}`
          )
          if (match) setInstalled((prev) => ({ ...prev, [match.id]: true }))
          setNpmName('')
          showToast('success', t('Install complete'), t('Restart Pi Desktop to load it.'))
        } else {
          const output = truncateOutput(result.output) || t('Install failed')
          setNpmError(output)
          showToast('error', t('Install failed'), output)
        }
      } catch (cause) {
        const output = truncateOutput(errorMessage(cause))
        setNpmError(output || t('Install failed'))
        showToast('error', t('Install failed'), output || undefined)
      } finally {
        setNpmInstalling(false)
      }
    },
    [showToast, snapshot.entries, t]
  )

  const submitNpm = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const packageName = npmName.trim()
      if (!packageName || npmInstalling) return
      if (!canInstallNpm) {
        setNpmError(t('The marketplace is not available in this build.'))
        return
      }
      if (!NPM_PACKAGE_RE.test(packageName)) {
        setNpmError(t('Invalid npm package name.'))
        return
      }
      setNpmError('')
      setPendingNpm(packageName)
    },
    [canInstallNpm, npmInstalling, npmName, t]
  )

  const counts = useMemo(() => {
    let plugin = 0
    let skill = 0
    for (const entry of snapshot.entries) {
      if (entry.kind === 'plugin') plugin += 1
      else skill += 1
    }
    return { plugin, skill }
  }, [snapshot.entries])

  const installedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const id of Object.keys(installed)) ids.add(id.toLowerCase())
    for (const id of serverInstalled) ids.add(id.toLowerCase())
    return ids
  }, [installed, serverInstalled])

  const categories = useMemo(
    () => marketplaceCategories(snapshot.entries, kind),
    [snapshot.entries, kind]
  )

  const mineCount = useMemo(
    () =>
      snapshot.entries.filter(
        (entry) => entry.kind === kind && installedIds.has(entry.id.toLowerCase())
      ).length,
    [snapshot.entries, kind, installedIds]
  )

  const visible = useMemo(() => {
    const filtered = filterMarketplaceEntries(snapshot.entries, {
      kind,
      query,
      minStars,
      category,
      sort
    })
    return mineOnly
      ? filtered.filter((entry) => installedIds.has(entry.id.toLowerCase()))
      : filtered
  }, [snapshot.entries, kind, query, minStars, category, sort, mineOnly, installedIds])

  const kindTotal = kind === 'plugin' ? counts.plugin : counts.skill
  const updatedLabel = relativeFromIso(snapshot.generatedAt, language)
  const searchLabel = kind === 'plugin' ? t('Search plugins…') : t('Search skills…')

  const switchKind = (next: MarketplaceKind) => {
    setKind(next)
    setCategory(null)
  }

  const clearFilters = () => {
    setQuery('')
    setMinStars(0)
    setCategory(null)
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
              <button
                type="button"
                data-active={kind === 'plugin'}
                aria-pressed={kind === 'plugin'}
                onClick={() => switchKind('plugin')}
              >
                <Package size={13} />
                {t('Plugins')}
                <span className="marketplace-tab__count">{counts.plugin}</span>
              </button>
              <button
                type="button"
                data-active={kind === 'skill'}
                aria-pressed={kind === 'skill'}
                onClick={() => switchKind('skill')}
              >
                <Sparkles size={13} />
                {t('Skills')}
                <span className="marketplace-tab__count">{counts.skill}</span>
              </button>
            </div>
            <div className="marketplace-top__actions">
              <button
                type="button"
                className="btn btn--sm btn--primary"
                onClick={() => setCreateOpen(true)}
              >
                <Plus size={13} />
                {t('Create')}
              </button>
              <button type="button" className="btn btn--sm" onClick={() => setView('manage')}>
                <Settings2 size={13} />
                {t('Manage')}
              </button>
            </div>
          </div>
          <header className="marketplace-head">
        <div className="marketplace-head__intro">
          <h2 className="marketplace-head__title">{t('Plugins & skills')}</h2>
          <p className="marketplace-head__desc">
            {t('Browse community plugins and skills for Pi, then install them with one command.')}
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

          <label className="marketplace-min-stars">
            <span>{t('Minimum stars')}</span>
            <select
              className="input settings-select marketplace-select"
              value={minStars}
              onChange={(event) => setMinStars(Number(event.target.value))}
            >
              {MIN_STARS_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value === 0 ? t('All') : value >= 1000 ? '1k+' : `${value}+`}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="marketplace-categories" role="group" aria-label={t('Categories')}>
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
        {categories.map((item) => {
          const value = item === '全部' ? null : item
          return (
            <button
              type="button"
              className="pill"
              key={item}
              data-active={category === value}
              aria-pressed={category === value}
              onClick={() => setCategory(value)}
            >
              {item === '全部' ? t('All') : item}
            </button>
          )
        })}
      </div>

      <form className="marketplace-npm" onSubmit={submitNpm}>
        <label className="marketplace-npm__label" htmlFor="marketplace-npm-input">
          {t('Install from npm')}
        </label>
        <div className="marketplace-npm__row">
          <input
            id="marketplace-npm-input"
            className="input marketplace-npm__input"
            value={npmName}
            placeholder={t('npm package name, e.g. pi-web-access')}
            aria-label={t('npm package name, e.g. pi-web-access')}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => {
              setNpmName(event.target.value)
              if (npmError) setNpmError('')
            }}
          />
          <button
            type="submit"
            className="btn btn--sm btn--primary marketplace-npm__button"
            disabled={
              npmInstalling || installingId !== null || !npmName.trim() || !canInstallNpm
            }
            title={canInstallNpm ? undefined : t('The marketplace is not available in this build.')}
          >
            {npmInstalling ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
            {npmInstalling ? t('Installing…') : t('Download and install')}
          </button>
        </div>
        {npmError ? (
          <p className="marketplace-npm__error" role="alert">
            <AlertTriangle size={12} />
            <span>{npmError}</span>
          </p>
        ) : null}
      </form>

      {error && !(status === 'error' && snapshot.entries.length === 0) ? (
        <div className="marketplace-banner" role="alert">
          <AlertTriangle size={14} />
          <span>{truncateOutput(error, 240)}</span>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void (errorFromRefresh ? refresh() : load())}
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
          <button type="button" className="btn btn--sm" onClick={() => void load()}>
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
                ? kind === 'plugin'
                  ? t('No plugins are available yet.')
                  : t('No skills are available yet.')
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
              installBusy={installingId !== null || npmInstalling}
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

      {pendingNpm ? (
        <ConfirmDialog
          title={t('Install {name}?').replace('{name}', pendingNpm)}
          body={t(
            'Third-party plugins and skills run with full system permissions. Only install sources you trust.'
          )}
          confirmLabel="Install"
          onConfirm={() => {
            const packageName = pendingNpm
            setPendingNpm(null)
            void installNpm(packageName)
          }}
          onCancel={() => setPendingNpm(null)}
        />
      ) : null}

      {createOpen ? (
        <CreateResourceDialog onClose={() => setCreateOpen(false)} onCreated={finishCreate} />
      ) : null}
    </div>
  )
}
