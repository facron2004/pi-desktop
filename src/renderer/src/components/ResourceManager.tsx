import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import type { ManagedPackage, MarketplaceActionResult } from '@shared/marketplace'
import type { McpConfig } from '@shared/types'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useT } from '../lib/i18n'
import { subagentCalls } from '../lib/subagents'
import { useAppStore } from '../store/useAppStore'
import { ConfirmDialog } from './ConfirmDialog'
import { Switch } from './Switch'

const NPM_PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const RESOURCE_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const RESOURCE_NAME_MAX = 64
const RESOURCE_DESCRIPTION_MAX = 1024

export type CreateMode = 'github' | 'npm' | 'custom'
type ManageFilter = 'plugin' | 'skill' | 'mcp' | 'subagent'
type PendingInstall = { mode: 'github' | 'npm'; value: string }
type RemoveTarget =
  | { kind: 'package'; item: ManagedPackage }
  | { kind: 'mcp'; name: string }

interface CreateResourceDialogProps {
  onClose: () => void
  /** The option the create menu picked, so the dialog opens on that tab. */
  initialMode?: CreateMode
  /** `path` is set only for a locally created resource. */
  onCreated: (path?: string) => void
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function shortOutput(output: string, limit = 220): string {
  const text = output.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function failureText(result: MarketplaceActionResult, fallback: string): string {
  return shortOutput(result.output) || fallback
}

/** Accept `owner/repo`, `github.com/owner/repo`, or a full GitHub URL. */
function normaliseGithubRepository(value: string): string | null {
  let text = value.trim()
  if (!text) return null
  if (/^(?:https?:\/\/)?(?:www\.)?github\.com\//i.test(text)) {
    try {
      const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
      const host = url.hostname.toLowerCase()
      if (host !== 'github.com' && host !== 'www.github.com') return null
      const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
      if (parts.length < 2) return null
      text = `${parts[0]}/${parts[1].replace(/\.git$/i, '')}`
    } catch {
      return null
    }
  }
  text = text.replace(/\/+$/, '').replace(/\.git$/i, '')
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text) ? text : null
}

function kindLabel(kind: ManagedPackage['kind'], t: (text: string) => string): string {
  if (kind === 'skill') return t('Skill')
  if (kind === 'plugin') return t('Plugin')
  return t('Package')
}

export function CreateResourceDialog({ onClose, onCreated, initialMode = 'github' }: CreateResourceDialogProps) {
  const t = useT()
  const dialogRef = useRef<HTMLFormElement>(null)
  useDialogFocus(dialogRef, onClose)

  const [mode, setMode] = useState<CreateMode>(initialMode)
  const [githubRepository, setGithubRepository] = useState('')
  const [npmPackage, setNpmPackage] = useState('')
  const [kind, setKind] = useState<'plugin' | 'skill'>('plugin')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingInstall, setPendingInstall] = useState<PendingInstall | null>(null)

  const selectMode = (next: CreateMode) => {
    if (busy) return
    setMode(next)
    setError('')
  }

  const createResource = async () => {
    const trimmedName = name.trim()
    const trimmedDescription = description.trim()
    if (!trimmedName) {
      setError(t('Enter a name.'))
      return
    }
    if (!RESOURCE_NAME_RE.test(trimmedName)) {
      setError(t('Use 2–64 lowercase letters, numbers, or hyphens for the name.'))
      return
    }
    if (!trimmedDescription) {
      setError(t('Enter a description.'))
      return
    }
    if (trimmedDescription.length > RESOURCE_DESCRIPTION_MAX) {
      setError(t('Description is too long.'))
      return
    }
    const createFn = window.pi?.marketplace?.createResource
    if (typeof createFn !== 'function') {
      setError(t('The marketplace is not available in this build.'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await createFn({
        kind,
        name: trimmedName,
        description: trimmedDescription
      })
      if (result.ok) onCreated(result.path)
      else setError(failureText(result, t('Create failed')))
    } catch (cause) {
      setError(shortOutput(messageOf(cause)) || t('Create failed'))
    } finally {
      setBusy(false)
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    setError('')
    if (mode === 'custom') {
      void createResource()
      return
    }
    const marketplace = window.pi?.marketplace
    if (mode === 'github') {
      const repository = normaliseGithubRepository(githubRepository)
      if (!repository) {
        setError(t('Enter a GitHub repository as owner/repo or a GitHub URL.'))
        return
      }
      if (typeof marketplace?.installGitRepository !== 'function') {
        setError(t('The marketplace is not available in this build.'))
        return
      }
      setPendingInstall({ mode: 'github', value: repository })
      return
    }
    const packageName = npmPackage.trim()
    if (!NPM_PACKAGE_RE.test(packageName)) {
      setError(t('Invalid npm package name.'))
      return
    }
    if (typeof marketplace?.installNpm !== 'function') {
      setError(t('The marketplace is not available in this build.'))
      return
    }
    setPendingInstall({ mode: 'npm', value: packageName })
  }

  const runPendingInstall = async (target: PendingInstall) => {
    setPendingInstall(null)
    const marketplace = window.pi?.marketplace
    const installFn =
      target.mode === 'github' ? marketplace?.installGitRepository : marketplace?.installNpm
    if (typeof installFn !== 'function') {
      setError(t('The marketplace is not available in this build.'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await installFn(target.value)
      if (result.ok) onCreated()
      else setError(failureText(result, t('Install failed')))
    } catch (cause) {
      setError(shortOutput(messageOf(cause)) || t('Install failed'))
    } finally {
      setBusy(false)
    }
  }

  const busyLabel = mode === 'custom' ? t('Creating…') : t('Installing…')

  return (
    <>
      <div className="modal-layer" onMouseDown={busy ? undefined : onClose}>
        <form
          ref={dialogRef}
          className="modal marketplace-create"
          role="dialog"
          aria-modal="true"
          aria-labelledby="marketplace-create-title"
          tabIndex={-1}
          onSubmit={submit}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="modal__head">
            <h2 id="marketplace-create-title" className="modal__title">
              {t('Create plugin or skill')}
            </h2>
            <button
              type="button"
              className="icon-btn modal__close"
              aria-label={t('Close')}
              disabled={busy}
              onClick={onClose}
            >
              <X size={15} />
            </button>
          </div>

          <div className="modal__body marketplace-create__body">
            <div className="segmented marketplace-create__tabs" role="group" aria-label={t('Create plugin or skill')}>
              <button
                type="button"
                data-active={mode === 'github'}
                aria-pressed={mode === 'github'}
                disabled={busy}
                onClick={() => selectMode('github')}
              >
                {t('GitHub repository')}
              </button>
              <button
                type="button"
                data-active={mode === 'npm'}
                aria-pressed={mode === 'npm'}
                disabled={busy}
                onClick={() => selectMode('npm')}
              >
                {t('npm package')}
              </button>
              <button
                type="button"
                data-active={mode === 'custom'}
                aria-pressed={mode === 'custom'}
                disabled={busy}
                onClick={() => selectMode('custom')}
              >
                {t('Create your own')}
              </button>
            </div>

            {mode === 'github' ? (
              <label className="marketplace-create__field">
                <span className="marketplace-create__label">{t('GitHub repository')}</span>
                <input
                  className="input"
                  value={githubRepository}
                  autoFocus
                  spellCheck={false}
                  placeholder={t('owner/repo or https://github.com/owner/repo')}
                  onChange={(event) => {
                    setGithubRepository(event.target.value)
                    if (error) setError('')
                  }}
                />
              </label>
            ) : mode === 'npm' ? (
              <label className="marketplace-create__field">
                <span className="marketplace-create__label">{t('npm package')}</span>
                <input
                  className="input"
                  value={npmPackage}
                  autoFocus
                  spellCheck={false}
                  placeholder={t('npm package name, e.g. pi-web-access')}
                  onChange={(event) => {
                    setNpmPackage(event.target.value)
                    if (error) setError('')
                  }}
                />
              </label>
            ) : (
              <>
                <div className="marketplace-create__field">
                  <span className="marketplace-create__label">{t('Type')}</span>
                  <div className="segmented segmented--tight marketplace-create__kind" role="group" aria-label={t('Type')}>
                    <button
                      type="button"
                      data-active={kind === 'plugin'}
                      aria-pressed={kind === 'plugin'}
                      disabled={busy}
                      onClick={() => setKind('plugin')}
                    >
                      {t('Plugin')}
                    </button>
                    <button
                      type="button"
                      data-active={kind === 'skill'}
                      aria-pressed={kind === 'skill'}
                      disabled={busy}
                      onClick={() => setKind('skill')}
                    >
                      {t('Skill')}
                    </button>
                  </div>
                </div>
                <label className="marketplace-create__field">
                  <span className="marketplace-create__label">{t('Name')}</span>
                  <input
                    className="input"
                    value={name}
                    maxLength={RESOURCE_NAME_MAX}
                    autoFocus
                    placeholder={t('Name')}
                    onChange={(event) => {
                      setName(event.target.value)
                      if (error) setError('')
                    }}
                  />
                </label>
                <label className="marketplace-create__field">
                  <span className="marketplace-create__label">{t('Description')}</span>
                  <textarea
                    className="input marketplace-create__textarea"
                    value={description}
                    maxLength={RESOURCE_DESCRIPTION_MAX}
                    rows={4}
                    placeholder={t('Description')}
                    onChange={(event) => {
                      setDescription(event.target.value)
                      if (error) setError('')
                    }}
                  />
                </label>
              </>
            )}

            {error ? (
              <p className="marketplace-create__error" role="alert">
                <AlertTriangle size={13} />
                <span>{error}</span>
              </p>
            ) : null}
          </div>

          <div className="modal__foot">
            <button type="button" className="btn" disabled={busy} onClick={onClose}>
              {t('Cancel')}
            </button>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? <Loader2 size={13} className="spin" /> : mode === 'custom' ? <Plus size={13} /> : <Package size={13} />}
              {busy ? busyLabel : mode === 'custom' ? t('Create') : t('Install')}
            </button>
          </div>
        </form>
      </div>

      {pendingInstall ? (
        <ConfirmDialog
          title={t('Install {name}?').replace('{name}', pendingInstall.value)}
          body={t(
            'Third-party plugins and skills run with full system permissions. Only install sources you trust.'
          )}
          confirmLabel="Install"
          onConfirm={() => void runPendingInstall(pendingInstall)}
          onCancel={() => setPendingInstall(null)}
        />
      ) : null}
    </>
  )
}

export function ResourceManager({ onBack }: { onBack: () => void }) {
  const t = useT()
  const [packages, setPackages] = useState<ManagedPackage[]>([])
  const [mcpConfig, setMcpConfig] = useState<McpConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [packagesError, setPackagesError] = useState('')
  const [mcpError, setMcpError] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null)
  const [filter, setFilter] = useState<ManageFilter>('plugin')
  const settings = useAppStore((state) => state.settings)
  const items = useAppStore((state) => state.items)

  const load = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial') => {
      if (mode === 'refresh') setRefreshing(true)
      else setLoading(true)
      setPackagesError('')
      setMcpError('')
      const managedFn = window.pi?.marketplace?.managed
      const readFn = window.pi?.mcp?.read
      const [packagesResult, mcpResult] = await Promise.allSettled([
        // An older preload has no package manager; that is an empty list, not
        // a red error banner over a page that still has MCP servers to show.
        typeof managedFn === 'function' ? managedFn() : Promise.resolve([] as ManagedPackage[]),
        typeof readFn === 'function'
          ? readFn()
          : Promise.reject(new Error(t('The MCP configuration is not available in this build.')))
      ])
      if (packagesResult.status === 'fulfilled') setPackages(packagesResult.value)
      else {
        setPackages([])
        setPackagesError(messageOf(packagesResult.reason))
      }
      if (mcpResult.status === 'fulfilled') setMcpConfig(mcpResult.value)
      else {
        setMcpConfig(null)
        setMcpError(messageOf(mcpResult.reason))
      }
      setLoading(false)
      setRefreshing(false)
    },
    [t]
  )

  useEffect(() => {
    void load()
  }, [load])

  const clearRowError = (key: string) => {
    setRowErrors((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const putRowError = (key: string, message: string) => {
    setRowErrors((prev) => ({ ...prev, [key]: message }))
  }

  const changePackage = async (item: ManagedPackage, enabled: boolean) => {
    const key = `package:${item.id}`
    const setEnabledFn = window.pi?.marketplace?.setPackageEnabled
    if (typeof setEnabledFn !== 'function') {
      putRowError(key, t('The marketplace is not available in this build.'))
      return
    }
    setBusyKey(key)
    clearRowError(key)
    try {
      const result = await setEnabledFn(item.id, enabled)
      if (result.ok) {
        setPackages((prev) =>
          prev.map((candidate) => (candidate.id === item.id ? { ...candidate, enabled } : candidate))
        )
      } else {
        putRowError(key, failureText(result, t('Could not update the package.')))
      }
    } catch (cause) {
      putRowError(key, shortOutput(messageOf(cause)) || t('Could not update the package.'))
    } finally {
      setBusyKey(null)
    }
  }

  const changeMcp = async (server: McpConfig['servers'][number], enabled: boolean) => {
    const key = `mcp:${server.name}`
    const setEnabledFn = window.pi?.mcp?.setEnabled
    if (typeof setEnabledFn !== 'function') {
      putRowError(key, t('The MCP configuration is not available in this build.'))
      return
    }
    setBusyKey(key)
    clearRowError(key)
    try {
      const result = await setEnabledFn(server.name, enabled)
      if (result.ok) {
        setMcpConfig((prev) =>
          prev
            ? {
                ...prev,
                servers: prev.servers.map((candidate) =>
                  candidate.name === server.name ? { ...candidate, enabled } : candidate
                )
              }
            : prev
        )
      } else {
        putRowError(key, failureText(result, t('Could not update the MCP server.')))
      }
    } catch (cause) {
      putRowError(key, shortOutput(messageOf(cause)) || t('Could not update the MCP server.'))
    } finally {
      setBusyKey(null)
    }
  }

  const removePackageRow = async (item: ManagedPackage) => {
    const key = `package:${item.id}`
    const removeFn = window.pi?.marketplace?.removePackage
    if (typeof removeFn !== 'function') {
      putRowError(key, t('The marketplace is not available in this build.'))
      return
    }
    setBusyKey(key)
    clearRowError(key)
    try {
      const result = await removeFn(item.id)
      if (result.ok) setPackages((prev) => prev.filter((candidate) => candidate.id !== item.id))
      else putRowError(key, failureText(result, t('Could not remove the package.')))
    } catch (cause) {
      putRowError(key, shortOutput(messageOf(cause)) || t('Could not remove the package.'))
    } finally {
      setBusyKey(null)
    }
  }

  const removeMcpRow = async (name: string) => {
    const key = `mcp:${name}`
    const removeFn = window.pi?.mcp?.remove
    if (typeof removeFn !== 'function') {
      putRowError(key, t('The MCP configuration is not available in this build.'))
      return
    }
    setBusyKey(key)
    clearRowError(key)
    try {
      const result = await removeFn(name)
      if (result.ok) {
        setMcpConfig((prev) =>
          prev ? { ...prev, servers: prev.servers.filter((server) => server.name !== name) } : prev
        )
      } else {
        putRowError(key, failureText(result, t('Could not remove the MCP server.')))
      }
    } catch (cause) {
      putRowError(key, shortOutput(messageOf(cause)) || t('Could not remove the MCP server.'))
    } finally {
      setBusyKey(null)
    }
  }

  const confirmRemove = () => {
    const target = removeTarget
    setRemoveTarget(null)
    if (!target) return
    if (target.kind === 'package') void removePackageRow(target.item)
    else void removeMcpRow(target.name)
  }

  const servers = mcpConfig?.servers ?? []
  const pluginPackages = useMemo(
    () => packages.filter((item) => item.kind !== 'skill'),
    [packages]
  )
  const skillPackages = useMemo(
    () => packages.filter((item) => item.kind === 'skill'),
    [packages]
  )
  const subagentTasks = useMemo(
    () => subagentCalls(items).flatMap((call) => call.tasks),
    [items]
  )
  const packageRows = filter === 'skill' ? skillPackages : pluginPackages

  return (
    <div className="marketplace-manage">
      <div className="marketplace-manage__top">
        <button type="button" className="btn btn--sm" onClick={onBack}>
          <ArrowLeft size={13} />
          {t('Back to marketplace')}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={loading || refreshing}
          onClick={() => void load('refresh')}
        >
          <RefreshCw size={13} className={refreshing ? 'spin' : undefined} />
          {refreshing ? t('Refreshing…') : t('Refresh')}
        </button>
      </div>

      <header className="marketplace-manage__head">
        <h2>{t('Manage plugins & skills')}</h2>
        <p>{t('Enable, disable, or remove installed packages and MCP servers.')}</p>
      </header>

      <div className="segmented marketplace-manage__filters" role="group" aria-label={t('Resource types')}>
        <button
          type="button"
          data-active={filter === 'plugin'}
          aria-pressed={filter === 'plugin'}
          onClick={() => setFilter('plugin')}
        >
          <Package size={13} />
          {t('Plugins')}
          <span className="marketplace-tab__count">{pluginPackages.length}</span>
        </button>
        <button
          type="button"
          data-active={filter === 'skill'}
          aria-pressed={filter === 'skill'}
          onClick={() => setFilter('skill')}
        >
          <Sparkles size={13} />
          {t('Skills')}
          <span className="marketplace-tab__count">{skillPackages.length}</span>
        </button>
        <button
          type="button"
          data-active={filter === 'mcp'}
          aria-pressed={filter === 'mcp'}
          onClick={() => setFilter('mcp')}
        >
          <Server size={13} />
          {t('MCP')}
          <span className="marketplace-tab__count">{servers.length}</span>
        </button>
        <button
          type="button"
          data-active={filter === 'subagent'}
          aria-pressed={filter === 'subagent'}
          onClick={() => setFilter('subagent')}
        >
          <Bot size={13} />
          {t('Subagent')}
          <span className="marketplace-tab__count">{subagentTasks.length}</span>
        </button>
      </div>

      {loading ? (
        <div className="marketplace-manage__loading">
          <Loader2 size={16} className="spin" />
          {t('Loading…')}
        </div>
      ) : (
        <>
          {packagesError ? (
            <div className="marketplace-banner" role="alert">
              <AlertTriangle size={14} />
              <span>{shortOutput(packagesError, 240)}</span>
              <button type="button" className="btn btn--sm" onClick={() => void load('refresh')}>
                {t('Retry')}
              </button>
            </div>
          ) : null}

          {filter === 'plugin' || filter === 'skill' ? (
          <section className="marketplace-manage__section">
            <div className="marketplace-manage__section-head">
              <h3>{filter === 'skill' ? t('Installed skills') : t('Installed plugins')}</h3>
              <span className="settings-badge">{packageRows.length}</span>
            </div>
            {packageRows.length === 0 ? (
              <div className="settings-empty">
                {filter === 'skill' ? t('No skills are installed.') : t('No plugins are installed.')}
              </div>
            ) : (
              <div className="settings-card-list">
                {packageRows.map((item) => {
                  const key = `package:${item.id}`
                  const busy = busyKey === key
                  return (
                    <div
                      className="settings-card marketplace-manage__row"
                      data-busy={busy || undefined}
                      key={item.id}
                    >
                      <div className="settings-card__main">
                        <div className="settings-card__title-row">
                          {item.kind === 'skill' ? <Sparkles size={13} /> : <Package size={13} />}
                          <span className="settings-card__title">{item.name}</span>
                          <span className="settings-tag">{kindLabel(item.kind, t)}</span>
                          <span className="settings-tag">
                            {item.scope === 'project' ? t('project') : t('user')}
                          </span>
                        </div>
                        <span className="marketplace-manage__source" title={item.source}>
                          {item.source}
                        </span>
                        {rowErrors[key] ? (
                          <span className="marketplace-manage__row-error">{rowErrors[key]}</span>
                        ) : null}
                      </div>
                      <div className="settings-card__actions">
                        <Switch
                          checked={item.enabled}
                          onChange={(value) => void changePackage(item, value)}
                          label={`${item.name}: ${item.enabled ? t('enabled') : t('disabled')}`}
                          disabled={busyKey !== null}
                        />
                        <button
                          type="button"
                          className="icon-btn marketplace-manage__delete"
                          title={t('Remove')}
                          aria-label={t('Remove')}
                          disabled={busyKey !== null}
                          onClick={() => setRemoveTarget({ kind: 'package', item })}
                        >
                          {busy ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
          ) : null}

          {mcpError ? (
            <div className="marketplace-banner" role="alert">
              <AlertTriangle size={14} />
              <span>{shortOutput(mcpError, 240)}</span>
              <button type="button" className="btn btn--sm" onClick={() => void load('refresh')}>
                {t('Retry')}
              </button>
            </div>
          ) : null}
          {mcpConfig?.errors.length ? (
            <div className="marketplace-banner" role="alert">
              <AlertTriangle size={14} />
              <span>{mcpConfig.errors.map((message) => shortOutput(message, 240)).join(' · ')}</span>
            </div>
          ) : null}

          {filter === 'mcp' ? (
          <section className="marketplace-manage__section">
            <div className="marketplace-manage__section-head">
              <h3>{t('MCP servers')}</h3>
              <span className="settings-badge">{servers.length}</span>
            </div>
            {servers.length === 0 ? (
              <div className="settings-empty">{t('No MCP servers are configured.')}</div>
            ) : (
              <div className="settings-card-list">
                {servers.map((server) => {
                  const key = `mcp:${server.name}`
                  const busy = busyKey === key
                  const serverSource =
                    server.url ||
                    [server.command, ...(server.args ?? [])].filter(Boolean).join(' ') ||
                    '—'
                  return (
                    <div
                      className="settings-card marketplace-manage__row"
                      data-busy={busy || undefined}
                      key={server.name}
                    >
                      <div className="settings-card__main">
                        <div className="settings-card__title-row">
                          <Server size={13} />
                          <span className="settings-card__title">{server.name}</span>
                          <span className="settings-tag">
                            {server.transport === 'unknown' ? t('unknown') : server.transport}
                          </span>
                          <span className="settings-tag">
                            {server.scope === 'both'
                              ? t('project override')
                              : server.scope === 'project'
                                ? t('project')
                                : t('user')}
                          </span>
                        </div>
                        {server.description ? (
                          <span className="marketplace-manage__desc">{server.description}</span>
                        ) : null}
                        <span className="marketplace-manage__source" title={serverSource}>
                          {serverSource}
                        </span>
                        {rowErrors[key] ? (
                          <span className="marketplace-manage__row-error">{rowErrors[key]}</span>
                        ) : null}
                      </div>
                      <div className="settings-card__actions">
                        <Switch
                          checked={server.enabled}
                          onChange={(value) => void changeMcp(server, value)}
                          label={`${server.name}: ${server.enabled ? t('enabled') : t('disabled')}`}
                          disabled={busyKey !== null}
                        />
                        <button
                          type="button"
                          className="icon-btn marketplace-manage__delete"
                          title={t('Remove')}
                          aria-label={t('Remove')}
                          disabled={busyKey !== null}
                          onClick={() => setRemoveTarget({ kind: 'mcp', name: server.name })}
                        >
                          {busy ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
          ) : null}

          {filter === 'subagent' ? (
          <section className="marketplace-manage__section">
            <div className="marketplace-manage__section-head">
              <h3>{t('Subagent')}</h3>
              <span className="settings-badge">{subagentTasks.length}</span>
            </div>
            <div className="settings-card-list">
              <div className="settings-card marketplace-manage__row">
                <div className="settings-card__main">
                  <div className="settings-card__title-row">
                    <Bot size={13} />
                    <span className="settings-card__title">{t('Subagent tool')}</span>
                    <span className="settings-tag" data-tone="accent">{t('built-in')}</span>
                  </div>
                  <span className="marketplace-manage__source">
                    {t('Built-in delegation tool available in every conversation.')}
                  </span>
                </div>
              </div>
              <div className="settings-card marketplace-manage__row">
                <div className="settings-card__main">
                  <div className="settings-card__title-row">
                    <Package size={13} />
                    <span className="settings-card__title">{t('Default subagent model')}</span>
                  </div>
                  <span className="marketplace-manage__source">
                    {settings.subagentModel
                      ? `${settings.subagentProvider ? `${settings.subagentProvider}/` : ''}${settings.subagentModel}`
                      : t('Follow the conversation')}
                  </span>
                </div>
              </div>
              <div className="settings-card marketplace-manage__row">
                <div className="settings-card__main">
                  <div className="settings-card__title-row">
                    <Bot size={13} />
                    <span className="settings-card__title">{t('Subagent reasoning effort')}</span>
                  </div>
                  <span className="marketplace-manage__source">
                    {settings.subagentThinking || t('Follow the conversation')}
                  </span>
                </div>
              </div>
              {subagentTasks.length > 0 ? (
                subagentTasks.map((task) => (
                  <div className="settings-card marketplace-manage__row" key={task.id}>
                    <div className="settings-card__main">
                      <div className="settings-card__title-row">
                        <Bot size={13} />
                        <span className="settings-card__title">{task.task}</span>
                        <span className="settings-tag">{task.status}</span>
                      </div>
                      {task.cwd ? (
                        <span className="marketplace-manage__source" title={task.cwd}>{task.cwd}</span>
                      ) : null}
                    </div>
                  </div>
                ))
              ) : (
                <div className="settings-empty">{t('No subagent activity yet')}</div>
              )}
            </div>
          </section>
          ) : null}
        </>
      )}

      {removeTarget ? (
        <ConfirmDialog
          title={t('Remove {name}?').replace(
            '{name}',
            removeTarget.kind === 'package' ? removeTarget.item.name : removeTarget.name
          )}
          body={t('This removes it from the Pi configuration. This cannot be undone.')}
          confirmLabel="Remove"
          tone="danger"
          onConfirm={confirmRemove}
          onCancel={() => setRemoveTarget(null)}
        />
      ) : null}
    </div>
  )
}
