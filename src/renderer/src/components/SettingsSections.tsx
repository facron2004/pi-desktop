import type { ReactNode } from 'react'
import { Check, FolderOpen } from 'lucide-react'
import type { AuthStatus } from '@shared/types'
import { useT } from '../lib/i18n'
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

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-group">
      <h4>{title}</h4>
      <div className="settings-fields">{children}</div>
    </section>
  )
}

interface GeneralSettingsForm {
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
  onCheck: () => void
  onOpenProject: () => void
  onResetPiPath: () => void
}

const THINKING_LEVELS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

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
              {t('Every folder you open is listed in the sidebar, and you can jump to it with Ctrl 1 … 9.')}
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
                <option value={form.defaultModel}>{t('Saved model')}: {form.defaultModel}</option>
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
            <button className="btn" onClick={onCheck} disabled={checking}>
              {checking ? <span className="spinner" /> : <Check size={13} />}
              {t('Check')}
            </button>
          </div>
          {auth ? (
            <span className="field__hint" style={{ color: auth.ready ? 'var(--green)' : 'var(--red)' }}>
              {auth.ready
                ? (language === 'zh-CN'
                    ? `${auth.provider} 已就绪。`
                    : `${auth.provider} is ready to use.`)
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
        <div className="segmented">
          {([
            { label: 'English', value: 'en' },
            { label: '简体中文', value: 'zh-CN' }
          ] as const).map((option) => (
            <button
              key={option.value}
              data-active={(settings.language ?? 'en') === option.value}
              onClick={() => void updateSettings({ language: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('Theme')}>
        <div className="segmented">
          {(['dark', 'light', 'system'] as const).map((theme) => (
            <button
              key={theme}
              data-active={settings.theme === theme}
              onClick={() => void updateSettings({ theme })}
            >
              {t(theme[0].toUpperCase() + theme.slice(1))}
            </button>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('Text size')}>
        <div className="segmented">
          {[
            { label: 'Small', value: 0.92 },
            { label: 'Default', value: 1 },
            { label: 'Large', value: 1.1 },
            { label: 'XL', value: 1.22 }
          ].map((option) => (
            <button
              key={option.label}
              data-active={Math.abs((settings.fontScale ?? 1) - option.value) < 0.01}
              onClick={() => void updateSettings({ fontScale: option.value })}
            >
              {t(option.label)}
            </button>
          ))}
        </div>
      </SettingsGroup>
    </div>
  )
}

type PanelWidth = 'sidebarWidth' | 'drawerWidth' | 'terminalHeight'

/**
 * The sizes the app falls back to when no width is stored: the sidebar and the
 * inspector are resolved in App, the terminal keeps its own copy.
 *
 * Resetting writes those numbers instead of deleting the stored value. The
 * terminal drawer tracks its height locally and only follows a numeric
 * setting, so a cleared value would leave an open drawer at its old size until
 * it was reopened; writing the default is the one behaviour that resizes every
 * panel straight away, and it keeps the stored value equal to the fallback.
 */
const PANEL_DEFAULTS: Record<PanelWidth, number> = {
  sidebarWidth: 272,
  drawerWidth: 420,
  terminalHeight: 280
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
    // Spelled out per field so the patch stays a typed partial of AppSettings.
    if (key === 'sidebarWidth') void updateSettings({ sidebarWidth: PANEL_DEFAULTS.sidebarWidth })
    else if (key === 'drawerWidth') void updateSettings({ drawerWidth: PANEL_DEFAULTS.drawerWidth })
    else void updateSettings({ terminalHeight: PANEL_DEFAULTS.terminalHeight })
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
        <div className="segmented">
          <button
            data-active={!settings.diffSplit}
            onClick={() => void updateSettings({ diffSplit: false })}
          >
            {t('Unified')}
          </button>
          <button
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
