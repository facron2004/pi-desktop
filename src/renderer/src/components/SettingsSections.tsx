import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Check,
  FileJson,
  FolderOpen,
  Minimize2,
  RefreshCw,
  Search,
  Server,
  ShieldOff,
  Sparkles,
  Wrench,
  X
} from 'lucide-react'
import type { AuthStatus, McpConfig, McpServerInfo, ModelInfo } from '@shared/types'
import { formatCost, formatTokens } from '../lib/format'
import { useT } from '../lib/i18n'
import { formatPlatformShortcut } from '../lib/shortcuts'
import { useAppStore } from '../store/useAppStore'
import { Switch } from './Switch'

function PageIntro({ title, description }: { title: string; description: string }) {
  return (
    <header className="settings-page-head">
      <h3>{title}</h3>
      <p>{description}</p>
    </header>
  )
}

function SettingsGroup({
  title,
  action,
  children
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="settings-group">
      <div className="settings-group__head">
        <h4>{title}</h4>
        {action ? <div className="settings-group__action">{action}</div> : null}
      </div>
      <div className="settings-fields">{children}</div>
    </section>
  )
}

export interface GeneralSettingsForm {
  piPath: string
  provider: string
  defaultModel: string
  defaultThinking: string
}

interface GeneralSettingsProps {
  form: GeneralSettingsForm
  onChange: (patch: Partial<GeneralSettingsForm>) => void
  auth: AuthStatus | null
  checking: boolean
  onCheck: (providerOverride?: string) => void
  onOpenProject: () => void
  onResetPiPath: () => void
}

const THINKING_LEVELS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

function formatContextWindow(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return null
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

export function GeneralSettings({
  form,
  onChange,
  auth,
  checking,
  onCheck,
  onOpenProject,
  onResetPiPath
}: GeneralSettingsProps) {
  const models = useAppStore((state) => state.models)
  const language = useAppStore((state) => state.settings.language)
  const platform = useAppStore((state) => state.info?.platform)
  const t = useT()
  const selectedModel = models.find(
    (model) =>
      form.defaultModel === model.id || form.defaultModel === `${model.provider}/${model.id}`
  )
  const selectedModelValue = selectedModel
    ? `${selectedModel.provider}/${selectedModel.id}`
    : form.defaultModel

  return (
    <div className="settings-page">
      <PageIntro
        title={t('General')}
        description={t('Configure Pi Desktop defaults and the Pi connection.')}
      />

      <SettingsGroup title={t('Projects')}>
        <div className="field">
          <div className="field__row">
            <button className="btn" onClick={onOpenProject}>
              <FolderOpen size={13} />
              {t('Open a folder')}
            </button>
            <span className="field__hint" style={{ flex: 1 }}>
              {formatPlatformShortcut(
                t('Every folder you open is listed in the sidebar, and you can jump to it with Ctrl 1 … 9.'),
                platform
              )}
            </span>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('Pi CLI')}>
        <div className="field">
          <label className="field__label" htmlFor="pi-path">
            {t('Pi CLI path')}
          </label>
          <div className="field__row">
            <input
              id="pi-path"
              className="input"
              value={form.piPath}
              placeholder={t('Leave empty to use the bundled Pi')}
              onChange={(event) => onChange({ piPath: event.target.value })}
            />
            <button className="btn" onClick={onResetPiPath}>
              {t('Reset')}
            </button>
          </div>
          <span className="field__hint">
            {t('Point this at a `pi` executable or at the CLI script of a checkout. When empty, Pi Desktop uses the copy bundled with the app.')}
          </span>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('Agent defaults')}>
        <div className="field">
          <label className="field__label" htmlFor="default-model">
            {t('Default model')}
          </label>
          {models.length > 0 ? (
            <select
              id="default-model"
              className="input settings-select"
              value={selectedModelValue}
              onChange={(event) => onChange({ defaultModel: event.target.value })}
            >
              <option value="">{t('Automatic (Pi default)')}</option>
              {form.defaultModel && !selectedModel ? (
                <option value={form.defaultModel}>
                  {t('Saved model')}: {form.defaultModel}
                </option>
              ) : null}
              {models.map((model) => (
                <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
                  {model.name || model.id} · {model.provider}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="default-model"
              className="input"
              value={form.defaultModel}
              placeholder={t('Automatic (Pi default)')}
              onChange={(event) => onChange({ defaultModel: event.target.value })}
            />
          )}
          <span className="field__hint">
            {models.length > 0
              ? t('Choose the model Pi should start with. Select Automatic to use Pi’s configured default.')
              : t('Open a project to load Pi’s model list, or enter a model ID such as provider/model.')}
          </span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="default-thinking">
            {t('Default reasoning effort')}
          </label>
          <select
            id="default-thinking"
            className="input settings-select"
            value={form.defaultThinking}
            onChange={(event) => onChange({ defaultThinking: event.target.value })}
          >
            {THINKING_LEVELS.map((level) => (
              <option key={level || 'automatic'} value={level}>
                {level ? t(level[0].toUpperCase() + level.slice(1)) : t('Automatic (Pi default)')}
              </option>
            ))}
          </select>
          <span className="field__hint">
            {t('Used the next time the Pi runtime starts. The open conversation is not changed.')}
          </span>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('Provider credentials')}>
        <div className="field">
          <label className="field__label" htmlFor="provider-name">
            {t('Provider name')}
          </label>
          <div className="field__row">
            <input
              id="provider-name"
              className="input"
              value={form.provider}
              placeholder={t('e.g. anthropic')}
              onChange={(event) => onChange({ provider: event.target.value })}
            />
            <button className="btn" onClick={() => onCheck()} disabled={checking}>
              {checking ? <span className="spinner" /> : <Check size={13} />}
              {t('Check')}
            </button>
          </div>
          {auth ? (
            <span className="field__hint" style={{ color: auth.ready ? 'var(--green)' : 'var(--red)' }}>
              {auth.ready
                ? language === 'zh-CN'
                  ? `${auth.provider} 已就绪。`
                  : `${auth.provider} is ready to use.`
                : language === 'zh-CN'
                  ? `${auth.provider ?? '供应商'} 尚未就绪${auth.detail ? `：${auth.detail}` : '。'}`
                  : `${auth.provider ?? 'provider'} is not ready${auth.detail ? `: ${auth.detail}` : '.'}`}
            </span>
          ) : (
            <span className="field__hint">
              {t('Runs pi auth check to confirm the provider can be used.')}
            </span>
          )}
        </div>
      </SettingsGroup>
    </div>
  )
}

export function ModelsSettings({
  form,
  onChange,
  auth,
  checking,
  onCheck
}: {
  form: GeneralSettingsForm
  onChange: (patch: Partial<GeneralSettingsForm>) => void
  auth: AuthStatus | null
  checking: boolean
  onCheck: (providerOverride?: string) => void
}) {
  const models = useAppStore((state) => state.models)
  const currentModel = useAppStore((state) => state.piState?.model)
  const currentLevel = useAppStore((state) => state.piState?.thinkingLevel)
  const thinkingLevels = useAppStore((state) => state.thinkingLevels)
  const ready = useAppStore((state) => state.status.phase === 'ready')
  const setModel = useAppStore((state) => state.setModel)
  const setThinkingLevel = useAppStore((state) => state.setThinkingLevel)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const showToast = useAppStore((state) => state.showToast)
  const language = useAppStore((state) => state.settings.language)
  const t = useT()

  const [query, setQuery] = useState('')
  const [providerFilter, setProviderFilter] = useState('')

  const providers = useMemo(() => {
    const set = new Set<string>()
    for (const model of models) {
      if (model.provider) set.add(model.provider)
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [models])

  const quickProviders = providers.length > 0 ? providers : ['anthropic', 'openai', 'google', 'deepseek']

  const selectedModel = models.find(
    (model) =>
      form.defaultModel === model.id || form.defaultModel === `${model.provider}/${model.id}`
  )
  const selectedModelValue = selectedModel
    ? `${selectedModel.provider}/${selectedModel.id}`
    : form.defaultModel

  const filteredModels = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return models.filter((model) => {
      if (providerFilter && model.provider !== providerFilter) return false
      if (!needle) return true
      return (
        (model.name ?? '').toLowerCase().includes(needle) ||
        model.id.toLowerCase().includes(needle) ||
        model.provider.toLowerCase().includes(needle)
      )
    })
  }, [models, query, providerFilter])

  const applyDefaultModel = (model: ModelInfo) => {
    const value = `${model.provider}/${model.id}`
    onChange({ defaultModel: value })
    void updateSettings({ model: value })
    showToast(t('Default model updated'))
  }

  return (
    <div className="settings-page">
      <PageIntro
        title={t('Model management')}
        description={t('Manage default models, provider credentials, and available models.')}
      />

      {ready && models.length > 0 ? (
        <SettingsGroup title={t('Current session model')}>
          <div className="field">
            <label className="field__label" htmlFor="session-active-model">
              {t('Active model')}
            </label>
            <select
              id="session-active-model"
              className="input settings-select"
              value={currentModel ? `${currentModel.provider}/${currentModel.id}` : ''}
              onChange={(event) => {
                const target = models.find(
                  (m) => `${m.provider}/${m.id}` === event.target.value
                )
                if (target) void setModel(target)
              }}
            >
              {models.map((model) => (
                <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
                  {model.name || model.id} · {model.provider}
                </option>
              ))}
            </select>
          </div>

          {thinkingLevels.length > 0 ? (
            <div className="field">
              <span className="field__label">{t('Active reasoning effort')}</span>
              <div className="segmented" role="group" aria-label={t('Active reasoning effort')}>
                {thinkingLevels.map((level) => (
                  <button
                    key={level}
                    type="button"
                    data-active={currentLevel === level}
                    aria-pressed={currentLevel === level}
                    onClick={() => void setThinkingLevel(level)}
                  >
                    {t(level[0].toUpperCase() + level.slice(1))}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </SettingsGroup>
      ) : null}

      <SettingsGroup title={t('Agent defaults')}>
        <div className="field">
          <label className="field__label" htmlFor="models-default-model">
            {t('Default model')}
          </label>
          {models.length > 0 ? (
            <select
              id="models-default-model"
              className="input settings-select"
              value={selectedModelValue}
              onChange={(event) => onChange({ defaultModel: event.target.value })}
            >
              <option value="">{t('Automatic (Pi default)')}</option>
              {form.defaultModel && !selectedModel ? (
                <option value={form.defaultModel}>
                  {t('Saved model')}: {form.defaultModel}
                </option>
              ) : null}
              {models.map((model) => (
                <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
                  {model.name || model.id} · {model.provider}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="models-default-model"
              className="input"
              value={form.defaultModel}
              placeholder={t('Automatic (Pi default)')}
              onChange={(event) => onChange({ defaultModel: event.target.value })}
            />
          )}
          <span className="field__hint">
            {models.length > 0
              ? t('Choose the model Pi should start with. Select Automatic to use Pi’s configured default.')
              : t('Open a project to load Pi’s model list, or enter a model ID such as provider/model.')}
          </span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="models-default-thinking">
            {t('Default reasoning effort')}
          </label>
          <select
            id="models-default-thinking"
            className="input settings-select"
            value={form.defaultThinking}
            onChange={(event) => onChange({ defaultThinking: event.target.value })}
          >
            {THINKING_LEVELS.map((level) => (
              <option key={level || 'automatic'} value={level}>
                {level ? t(level[0].toUpperCase() + level.slice(1)) : t('Automatic (Pi default)')}
              </option>
            ))}
          </select>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('Provider credentials')}>
        <div className="field">
          <div className="settings-pills">
            {quickProviders.map((item) => (
              <button
                key={item}
                type="button"
                className="pill"
                data-active={form.provider.trim() === item}
                onClick={() => {
                  onChange({ provider: item })
                  onCheck(item)
                }}
              >
                {item}
              </button>
            ))}
          </div>
          <div className="field__row">
            <input
              id="models-provider-name"
              className="input"
              value={form.provider}
              aria-label={t('Provider name')}
              placeholder={t('e.g. anthropic')}
              onChange={(event) => onChange({ provider: event.target.value })}
            />
            <button className="btn" onClick={() => onCheck()} disabled={checking}>
              {checking ? <span className="spinner" /> : <Check size={13} />}
              {t('Check')}
            </button>
          </div>
          {auth ? (
            <span className="field__hint" style={{ color: auth.ready ? 'var(--green)' : 'var(--red)' }}>
              {auth.ready
                ? language === 'zh-CN'
                  ? `${auth.provider} 已就绪。`
                  : `${auth.provider} is ready to use.`
                : language === 'zh-CN'
                  ? `${auth.provider ?? '供应商'} 尚未就绪${auth.detail ? `：${auth.detail}` : '。'}`
                  : `${auth.provider ?? 'provider'} is not ready${auth.detail ? `: ${auth.detail}` : '.'}`}
            </span>
          ) : (
            <span className="field__hint">
              {t('Runs pi auth check to confirm the provider can be used.')}
            </span>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup
        title={t('Available models')}
        action={
          models.length > 0 ? (
            <span className="settings-badge">{filteredModels.length} / {models.length}</span>
          ) : null
        }
      >
        {models.length === 0 ? (
          <div className="settings-empty">{t('Open a project to load available models from Pi.')}</div>
        ) : (
          <>
            <div className="settings-filter-bar">
              <div className="settings-search">
                <Search size={13} />
                <input
                  value={query}
                  placeholder={t('Search models by name, ID, or provider…')}
                  aria-label={t('Filter models')}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query ? (
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setQuery('')}
                    aria-label={t('Clear the filter')}
                  >
                    <X size={12} />
                  </button>
                ) : null}
              </div>
              {providers.length > 1 ? (
                <div className="settings-pills">
                  <button
                    type="button"
                    className="pill"
                    data-active={!providerFilter}
                    onClick={() => setProviderFilter('')}
                  >
                    {t('All providers')}
                  </button>
                  {providers.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className="pill"
                      data-active={providerFilter === item}
                      onClick={() => setProviderFilter(item === providerFilter ? '' : item)}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            {filteredModels.length === 0 ? (
              <div className="settings-empty">
                {t('No model matches')} “{query}”
              </div>
            ) : (
              <div className="settings-card-list">
                {filteredModels.map((model) => {
                  const fullId = `${model.provider}/${model.id}`
                  const isCurrent =
                    currentModel?.id === model.id && currentModel?.provider === model.provider
                  const isDefault =
                    selectedModelValue === fullId || form.defaultModel === model.id
                  const ctx = formatContextWindow(model.contextWindow)
                  const acceptsImg = Array.isArray(model.input) && model.input.includes('image')

                  return (
                    <div
                      key={fullId}
                      className="settings-card"
                      data-active={isCurrent || undefined}
                    >
                      <div className="settings-card__main">
                        <div className="settings-card__title-row">
                          <span className="settings-card__title">{model.name || model.id}</span>
                          <span className="settings-tag">{model.provider}</span>
                          {ctx ? <span className="settings-tag">{ctx} {t('ctx')}</span> : null}
                          {model.reasoning ? (
                            <span className="settings-tag" data-tone="accent">
                              {t('Reasoning')}
                            </span>
                          ) : null}
                          {acceptsImg ? (
                            <span className="settings-tag">{t('Images')}</span>
                          ) : null}
                        </div>
                        <span className="settings-card__sub">{fullId}</span>
                      </div>
                      <div className="settings-card__actions">
                        {ready ? (
                          <button
                            type="button"
                            className={isCurrent ? 'btn btn--sm btn--primary' : 'btn btn--sm'}
                            disabled={isCurrent}
                            onClick={() => void setModel(model)}
                          >
                            {isCurrent ? t('Current') : t('Use now')}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={isDefault}
                          onClick={() => applyDefaultModel(model)}
                        >
                          {isDefault ? t('Default') : t('Set default')}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </SettingsGroup>
    </div>
  )
}

export function AppearanceSettings() {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const t = useT()

  return (
    <div className="settings-page">
      <PageIntro
        title={t('Appearance')}
        description={t('Choose how Pi Desktop looks and how code changes are shown.')}
      />

      <SettingsGroup title={t('Language')}>
        <div className="segmented" role="group" aria-label={t('Language')}>
          {([
            { label: 'English', value: 'en' },
            { label: '简体中文', value: 'zh-CN' }
          ] as const).map((option) => (
            <button
              key={option.value}
              aria-pressed={(settings.language ?? 'en') === option.value}
              data-active={(settings.language ?? 'en') === option.value}
              onClick={() => void updateSettings({ language: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('Theme')}>
        <div className="segmented" role="group" aria-label={t('Theme')}>
          {(['dark', 'light', 'system'] as const).map((theme) => (
            <button
              key={theme}
              aria-pressed={settings.theme === theme}
              data-active={settings.theme === theme}
              onClick={() => void updateSettings({ theme })}
            >
              {t(theme[0].toUpperCase() + theme.slice(1))}
            </button>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('Text size')}>
        <div className="segmented settings-text-size" role="group" aria-label={t('Text size')}>
          {[
            { label: 'Small', value: 0.92 },
            { label: 'Default', value: 1 },
            { label: 'Large', value: 1.1 },
            { label: 'XL', value: 1.22 }
          ].map((option) => (
            <button
              key={option.label}
              data-size={option.label.toLowerCase()}
              aria-pressed={Math.abs((settings.fontScale ?? 1) - option.value) < 0.01}
              data-active={Math.abs((settings.fontScale ?? 1) - option.value) < 0.01}
              onClick={() => void updateSettings({ fontScale: option.value })}
            >
              {t(option.label)}
            </button>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('Diff layout')}>
        <div className="segmented" role="group" aria-label={t('Diff layout')}>
          <button
            aria-pressed={!settings.diffSplit}
            data-active={!settings.diffSplit}
            onClick={() => void updateSettings({ diffSplit: false })}
          >
            {t('Unified')}
          </button>
          <button
            aria-pressed={settings.diffSplit === true}
            data-active={settings.diffSplit === true}
            onClick={() => void updateSettings({ diffSplit: true })}
          >
            {t('Side by side')}
          </button>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('Notifications')}>
        <div className="field">
          <div className="field__row settings-switch-row">
            <Switch
              checked={settings.desktopNotifications !== false}
              onChange={(value) => void updateSettings({ desktopNotifications: value })}
              label={t('Desktop notifications')}
            />
            <span className="field__hint">
              {t('Notify when Pi finishes a turn or needs confirmation while the window is in the background.')}
            </span>
          </div>
        </div>
      </SettingsGroup>
    </div>
  )
}

export function UsageSettings() {
  const stats = useAppStore((state) => state.stats)
  const piState = useAppStore((state) => state.piState)
  const sessions = useAppStore((state) => state.sessions)
  const settings = useAppStore((state) => state.settings)
  const ready = useAppStore((state) => state.status.phase === 'ready')
  const refreshState = useAppStore((state) => state.refreshState)
  const compact = useAppStore((state) => state.compact)
  const setAutoCompaction = useAppStore((state) => state.setAutoCompaction)
  const setAutoRetry = useAppStore((state) => state.setAutoRetry)
  const t = useT()

  const [refreshing, setRefreshing] = useState(false)
  const [compacting, setCompacting] = useState(false)

  const context = stats?.contextUsage
  const tokens = stats?.tokens
  const percent = context?.percent ?? 0
  const level = percent >= 80 ? 'high' : percent >= 50 ? 'mid' : 'low'

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await refreshState()
    } finally {
      setRefreshing(false)
    }
  }

  const handleCompact = async () => {
    setCompacting(true)
    try {
      await compact()
    } finally {
      setCompacting(false)
    }
  }

  return (
    <div className="settings-page">
      <PageIntro
        title={t('Usage')}
        description={t('View token consumption, context window status, and session activity.')}
      />

      <SettingsGroup
        title={t('Context window')}
        action={
          <div className="settings-inline-actions">
            <button
              type="button"
              className="btn btn--sm"
              disabled={!ready || refreshing}
              onClick={() => void handleRefresh()}
            >
              <RefreshCw size={12} className={refreshing ? 'spin' : undefined} />
              {t('Refresh')}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              disabled={!ready || compacting}
              onClick={() => void handleCompact()}
            >
              <Minimize2 size={12} />
              {compacting ? t('Compacting…') : t('Compact now')}
            </button>
          </div>
        }
      >
        <div className="settings-context-card">
          <div className="ctx__headline">
            <span className="ctx__big">{formatTokens(context?.tokens)}</span>
            <span className="ctx__muted">
              {' '}
              {t('of')} {formatTokens(context?.contextWindow)}
            </span>
            {context?.percent !== null && context?.percent !== undefined ? (
              <span className="ctx__muted"> · {Math.round(context.percent)}%</span>
            ) : null}
          </div>
          <span className="ctx__bar">
            <span
              className="ctx__fill"
              data-level={level}
              style={{ width: `${Math.min(100, percent)}%` }}
            />
          </span>
          {!context ? (
            <span className="field__hint">{t('Waiting for Pi statistics')}</span>
          ) : null}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('Token consumption & cost')}>
        <div className="settings-metrics">
          <div className="settings-metric">
            <span className="settings-metric__label">{t('Input')}</span>
            <span className="settings-metric__value">{formatTokens(tokens?.input)}</span>
          </div>
          <div className="settings-metric">
            <span className="settings-metric__label">{t('Output')}</span>
            <span className="settings-metric__value">{formatTokens(tokens?.output)}</span>
          </div>
          <div className="settings-metric">
            <span className="settings-metric__label">{t('Cache read')}</span>
            <span className="settings-metric__value">{formatTokens(tokens?.cacheRead)}</span>
          </div>
          <div className="settings-metric">
            <span className="settings-metric__label">{t('Cache write')}</span>
            <span className="settings-metric__value">{formatTokens(tokens?.cacheWrite)}</span>
          </div>
          <div className="settings-metric">
            <span className="settings-metric__label">{t('Total')}</span>
            <span className="settings-metric__value">{formatTokens(tokens?.total)}</span>
          </div>
          <div className="settings-metric">
            <span className="settings-metric__label">{t('Cost')}</span>
            <span className="settings-metric__value">{formatCost(stats?.cost)}</span>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('Session & workspace activity')}>
        <div className="settings-metrics">
          <div className="settings-metric">
            <span className="settings-metric__label">{t('Prompts')}</span>
            <span className="settings-metric__value">{stats?.userMessages ?? '—'}</span>
          </div>
          <div className="settings-metric">
            <span className="settings-metric__label">{t('Replies')}</span>
            <span className="settings-metric__value">{stats?.assistantMessages ?? '—'}</span>
          </div>
          <div className="settings-metric">
            <span className="settings-metric__label">{t('Tool calls')}</span>
            <span className="settings-metric__value">{stats?.toolCalls ?? '—'}</span>
          </div>
          <div className="settings-metric">
            <span className="settings-metric__label">{t('Saved conversations')}</span>
            <span className="settings-metric__value">{sessions.length}</span>
          </div>
          <div className="settings-metric">
            <span className="settings-metric__label">{t('Projects')}</span>
            <span className="settings-metric__value">{settings.workspaces.length}</span>
          </div>
          <div className="settings-metric">
            <span className="settings-metric__label">{t('Pinned')}</span>
            <span className="settings-metric__value">{(settings.pinnedSessions ?? []).length}</span>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('Automation & context policy')}>
        <div className="field">
          <div className="field__row settings-switch-row">
            <Switch
              checked={piState?.autoCompactionEnabled !== false}
              onChange={(value) => void setAutoCompaction(value)}
              label={t('Compact automatically')}
            />
            <span className="field__hint">{t('when the context window fills up')}</span>
          </div>
        </div>
        <div className="field">
          <div className="field__row settings-switch-row">
            <Switch
              checked={piState?.autoRetryEnabled !== false}
              onChange={(value) => void setAutoRetry(value)}
              label={t('Retry automatically')}
            />
            <span className="field__hint">{t('on transient provider errors')}</span>
          </div>
        </div>
      </SettingsGroup>
    </div>
  )
}

export function PluginsSettings({ onClose }: { onClose?: () => void }) {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const commands = useAppStore((state) => state.commands)
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer)
  const t = useT()

  const [mcpConfig, setMcpConfig] = useState<McpConfig | null>(null)
  const [mcpState, setMcpState] = useState<'loading' | 'error' | 'ready'>('loading')
  const [filterKind, setFilterKind] = useState<'all' | 'extension' | 'skill'>('all')
  const [query, setQuery] = useState('')

  const loadMcp = useCallback(async () => {
    setMcpState('loading')
    try {
      setMcpConfig(await window.pi.mcp.read())
      setMcpState('ready')
    } catch {
      setMcpState('error')
    }
  }, [])

  useEffect(() => {
    void loadMcp()
  }, [loadMcp, settings.trustProject])

  const extensionCommands = useMemo(
    () => commands.filter((cmd) => cmd.source === 'extension' || cmd.source === 'skill'),
    [commands]
  )

  const filteredCommands = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return extensionCommands.filter((cmd) => {
      if (filterKind !== 'all' && cmd.source !== filterKind) return false
      if (!needle) return true
      return (
        cmd.name.toLowerCase().includes(needle) ||
        (cmd.description ?? '').toLowerCase().includes(needle)
      )
    })
  }, [extensionCommands, filterKind, query])

  const servers = mcpConfig?.servers ?? []
  const enabledServers = servers.filter((s) => s.enabled).length

  return (
    <div className="settings-page">
      <PageIntro
        title={t('Plugins')}
        description={t('Manage MCP servers, project extensions, and loaded skills or plugin commands.')}
      />

      <SettingsGroup title={t('Project resources')}>
        <div className="field">
          <div className="field__row settings-switch-row">
            <Switch
              checked={settings.trustProject !== false}
              onChange={(value) => void updateSettings({ trustProject: value })}
              label={t('Trust project-local extensions and settings')}
            />
            <span className="field__hint">
              {t('Allow project-local .pi/extensions, .pi/skills and .pi/settings.json to load in all workspaces. Turn this off for untrusted code.')}
            </span>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title={t('MCP servers')}
        action={
          <div className="settings-inline-actions">
            {mcpState === 'ready' ? (
              <span className="settings-badge">
                {enabledServers}/{servers.length} {t('enabled')}
              </span>
            ) : null}
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void loadMcp()}
              disabled={mcpState === 'loading'}
            >
              <RefreshCw size={12} className={mcpState === 'loading' ? 'spin' : undefined} />
              {t('Refresh')}
            </button>
          </div>
        }
      >
        {mcpState === 'loading' ? (
          <div className="settings-empty">
            <RefreshCw size={13} className="spin" /> {t('Reading the MCP configuration…')}
          </div>
        ) : mcpState === 'error' || !mcpConfig ? (
          <div className="settings-empty">
            <AlertTriangle size={13} /> {t('Could not read the MCP configuration.')}
          </div>
        ) : (
          <>
            <div className="mcp__files">
              <div className="mcp__file" data-missing={!mcpConfig.userExists || undefined}>
                <FileJson size={12} />
                <span className="mcp__file-scope">{t('User configuration')}</span>
                <span className="mcp__file-path" title={mcpConfig.userPath}>
                  {mcpConfig.userPath}
                </span>
                {!mcpConfig.userExists ? (
                  <span className="mcp__file-badge">{t('not found')}</span>
                ) : null}
              </div>
              <div className="mcp__file" data-missing={!mcpConfig.projectExists || undefined}>
                <FileJson size={12} />
                <span className="mcp__file-scope">{t('Project configuration')}</span>
                <span className="mcp__file-path" title={mcpConfig.projectPath}>
                  {mcpConfig.projectPath || '—'}
                </span>
                {!mcpConfig.projectExists ? (
                  <span className="mcp__file-badge">{t('not found')}</span>
                ) : null}
              </div>
            </div>

            {mcpConfig.projectIgnored ? (
              <p className="mcp__trust">
                <ShieldOff size={12} />
                {t('The project MCP configuration is ignored while project trust is off.')}
              </p>
            ) : null}

            {mcpConfig.errors.map((err) => (
              <p className="mcp__error" key={err}>
                <AlertTriangle size={12} />
                {err}
              </p>
            ))}

            {servers.length === 0 ? (
              <div className="settings-empty">
                {t('No MCP servers are configured.')}{' '}
                {t('Add servers with “pi mcp add …” or edit the JSON files above.')}
              </div>
            ) : (
              <div className="settings-card-list">
                {servers.map((server) => (
                  <McpPluginCard key={server.name} server={server} />
                ))}
              </div>
            )}
          </>
        )}
      </SettingsGroup>

      <SettingsGroup
        title={t('Extensions & skills')}
        action={<span className="settings-badge">{extensionCommands.length}</span>}
      >
        {extensionCommands.length === 0 ? (
          <div className="settings-empty">
            {t('No plugins or skills loaded in the current session.')}
          </div>
        ) : (
          <>
            <div className="settings-filter-bar">
              <div className="segmented" role="group" aria-label={t('Extensions & skills')}>
                <button
                  type="button"
                  data-active={filterKind === 'all'}
                  aria-pressed={filterKind === 'all'}
                  onClick={() => setFilterKind('all')}
                >
                  {t('All')}
                </button>
                <button
                  type="button"
                  data-active={filterKind === 'extension'}
                  aria-pressed={filterKind === 'extension'}
                  onClick={() => setFilterKind('extension')}
                >
                  {t('Plugins')}
                </button>
                <button
                  type="button"
                  data-active={filterKind === 'skill'}
                  aria-pressed={filterKind === 'skill'}
                  onClick={() => setFilterKind('skill')}
                >
                  {t('Skills')}
                </button>
              </div>
              <div className="settings-search">
                <Search size={13} />
                <input
                  value={query}
                  placeholder={t('Filter plugins or skills…')}
                  aria-label={t('Filter plugins or skills…')}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query ? (
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setQuery('')}
                    aria-label={t('Clear the filter')}
                  >
                    <X size={12} />
                  </button>
                ) : null}
              </div>
            </div>

            {filteredCommands.length === 0 ? (
              <div className="settings-empty">
                {t('No command matches')} “{query}”
              </div>
            ) : (
              <div className="settings-card-list">
                {filteredCommands.map((cmd) => (
                  <div key={`${cmd.source}:${cmd.name}`} className="settings-card">
                    <div className="settings-card__main">
                      <div className="settings-card__title-row">
                        {cmd.source === 'skill' ? <Sparkles size={13} /> : <Wrench size={13} />}
                        <span className="settings-card__title">/{cmd.name}</span>
                        <span
                          className="settings-tag"
                          data-tone={cmd.source === 'extension' ? 'accent' : undefined}
                        >
                          {cmd.source === 'extension' ? t('Plugin') : t('Skill')}
                        </span>
                        {cmd.sourceInfo?.scope ? (
                          <span className="settings-tag">{cmd.sourceInfo.scope}</span>
                        ) : null}
                      </div>
                      {cmd.description ? (
                        <span className="settings-card__sub">{cmd.description}</span>
                      ) : null}
                    </div>
                    <div className="settings-card__actions">
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => {
                          insertIntoComposer(`/${cmd.name} `, 'replace')
                          onClose?.()
                        }}
                      >
                        {t('Use in chat')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </SettingsGroup>
    </div>
  )
}

function McpPluginCard({ server }: { server: McpServerInfo }) {
  const t = useT()
  const commandLine = [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
  const meta = [
    server.timeout ? `${t('timeout')} ${server.timeout}s` : null,
    server.envKeys.length > 0 ? `${t('env')}: ${server.envKeys.join(', ')}` : null,
    server.headerKeys.length > 0 ? `${t('headers')}: ${server.headerKeys.join(', ')}` : null
  ].filter((part): part is string => Boolean(part))

  return (
    <div className="settings-card" data-disabled={!server.enabled || undefined}>
      <div className="settings-card__main">
        <div className="settings-card__title-row">
          <Server size={13} />
          <span className="settings-card__title">{server.name}</span>
          <span className="settings-tag">
            {server.scope === 'both'
              ? t('project override')
              : server.scope === 'project'
                ? t('project')
                : t('user')}
          </span>
          <span className="settings-tag">
            {server.transport === 'unknown' ? t('unknown') : server.transport}
          </span>
          <span className="settings-tag" data-tone={server.enabled ? 'accent' : undefined}>
            {server.enabled ? t('enabled') : t('disabled')}
          </span>
        </div>
        {server.description ? <span className="settings-card__sub">{server.description}</span> : null}
        <span className="settings-card__code">
          {server.transport === 'http' && server.url ? server.url : commandLine || '—'}
        </span>
        {meta.length > 0 ? <span className="settings-card__sub">{meta.join(' · ')}</span> : null}
      </div>
    </div>
  )
}

type PanelWidth = 'sidebarWidth' | 'drawerWidth' | 'terminalHeight'

/** The sidebar and inspector defaults; the terminal derives its default from the window height. */
const PANEL_DEFAULTS: Record<'sidebarWidth' | 'drawerWidth', number> = {
  sidebarWidth: 240,
  drawerWidth: 440
}

const PANEL_ROWS: { key: PanelWidth; label: string }[] = [
  { key: 'sidebarWidth', label: 'Sidebar' },
  { key: 'drawerWidth', label: 'Inspector' },
  { key: 'terminalHeight', label: 'Terminal' }
]

export function PanelsSettings() {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const t = useT()

  const resetWidth = (key: PanelWidth) => {
    if (key === 'sidebarWidth') void updateSettings({ sidebarWidth: PANEL_DEFAULTS.sidebarWidth })
    else if (key === 'drawerWidth') void updateSettings({ drawerWidth: PANEL_DEFAULTS.drawerWidth })
    else void updateSettings({ terminalHeight: undefined })
  }

  return (
    <div className="settings-page">
      <PageIntro
        title={t('Panels')}
        description={t('Put the surrounding panels back to their default size, and choose how diffs are shown.')}
      />

      <SettingsGroup title={t('Panel widths')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {PANEL_ROWS.map((row) => {
            const value = settings[row.key]
            return (
              <div className="field" key={row.key}>
                <div className="field__row">
                  <span className="field__label">{t(row.label)}</span>
                  <span
                    className="field__hint"
                    style={{ flex: 1, fontVariantNumeric: 'tabular-nums' }}
                  >
                    {typeof value === 'number' ? `${value} px` : t('Default')}
                  </span>
                  <button className="btn btn--sm" onClick={() => resetWidth(row.key)}>
                    {t('Reset')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
        <span className="field__hint">
          {t('You can also drag the edge of a panel to resize it.')}
        </span>
      </SettingsGroup>

      <SettingsGroup title={t('Diff layout')}>
        <div className="segmented" role="group" aria-label={t('Diff layout')}>
          <button
            aria-pressed={!settings.diffSplit}
            data-active={!settings.diffSplit}
            onClick={() => void updateSettings({ diffSplit: false })}
          >
            {t('Unified')}
          </button>
          <button
            aria-pressed={settings.diffSplit === true}
            data-active={settings.diffSplit === true}
            onClick={() => void updateSettings({ diffSplit: true })}
          >
            {t('Side by side')}
          </button>
        </div>
      </SettingsGroup>
    </div>
  )
}

export function PersonalizationSettings({
  value,
  onChange
}: {
  value: string
  onChange: (value: string) => void
}) {
  const t = useT()

  return (
    <div className="settings-page">
      <PageIntro
        title={t('Personalization')}
        description={t('Add instructions that Pi should follow across your workspaces.')}
      />

      <SettingsGroup title={t('Custom instructions')}>
        <div className="field">
          <label className="field__label" htmlFor="custom-instructions">
            {t('Instructions for Pi')}
          </label>
          <textarea
            id="custom-instructions"
            className="input settings-textarea"
            value={value}
            placeholder={t('For example, describe your preferred language, style, or workflow.')}
            onChange={(event) => onChange(event.target.value)}
          />
          <span className="field__hint">
            {t('Appended to Pi’s system prompt when the runtime starts. Project AGENTS.md files continue to provide project-specific context.')}
          </span>
        </div>
      </SettingsGroup>
    </div>
  )
}

export function ProjectSafetySettings() {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const t = useT()

  return (
    <div className="settings-page">
      <PageIntro
        title={t('Project safety')}
        description={t('Control whether Pi loads configuration and extensions from local workspaces.')}
      />

      <SettingsGroup title={t('Project resources')}>
        <div className="field">
          <div className="field__row settings-switch-row">
            <Switch
              checked={settings.trustProject !== false}
              onChange={(value) => void updateSettings({ trustProject: value })}
              label={t('Trust project-local extensions and settings')}
            />
            <span className="field__hint">
              {t('Allow project-local .pi/extensions, .pi/skills and .pi/settings.json to load in all workspaces. Turn this off for untrusted code.')}
              <br />
              {t('Saved immediately. Restart Pi Desktop to apply this to the Pi runtime. MCP configuration uses this setting the next time it is read.')}
            </span>
          </div>
        </div>
      </SettingsGroup>
    </div>
  )
}

export function AboutSettings() {
  const info = useAppStore((state) => state.info)
  const t = useT()

  return (
    <div className="settings-page">
      <PageIntro
        title={t('About')}
        description={t('Pi Desktop and runtime versions for diagnostics.')}
      />

      <SettingsGroup title={t('Environment')}>
        <div className="kv settings-environment">
          <span className="kv__key">{t('Application version')}</span>
          <span className="kv__value">{info?.version ?? '—'}</span>
          <span className="kv__key">{t('Pi CLI')}</span>
          <span className="kv__value">{info?.pi.display ?? '—'}</span>
          <span className="kv__key">{t('Pi version')}</span>
          <span className="kv__value">{info?.pi.version ?? '—'}</span>
          <span className="kv__key">{t('Session folder')}</span>
          <span className="kv__value">{info?.sessionRoot ?? '—'}</span>
          <span className="kv__key">{t('Operating system')}</span>
          <span className="kv__value">{info?.platform ?? '—'}</span>
          <span className="kv__key">{t('Electron')}</span>
          <span className="kv__value">{info?.electron ?? '—'}</span>
          <span className="kv__key">{t('Node')}</span>
          <span className="kv__value">{info?.node ?? '—'}</span>
        </div>
      </SettingsGroup>
    </div>
  )
}
