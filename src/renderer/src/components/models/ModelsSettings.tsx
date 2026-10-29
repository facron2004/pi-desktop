import { ChevronRight, Plus, Server } from 'lucide-react'
import { useProviders } from '../../hooks/useProviders'
import { useT } from '../../lib/i18n'
import { useAppStore } from '../../store/useAppStore'
import { ProviderEditor } from './ProviderEditor'
import '../../styles/providers.css'

export function ModelsSettings() {
  const controller = useProviders()
  const settings = useAppStore(state => state.settings)
  const updateSettings = useAppStore(state => state.updateSettings)
  const t = useT()
  if (controller.draft) return <div className="settings-page provider-settings"><ProviderEditor controller={controller} /></div>
  return (
    <div className="settings-page provider-settings">
      <header className="settings-page-head provider-page-head">
        <div><h3>{t('Model management')}</h3><p>{t('Configure providers, fetch their models, and choose where Pi connects.')}</p></div>
        <button className="btn btn--primary btn--sm" onClick={() => controller.edit()}><Plus size={13} />{t('Add provider')}</button>
      </header>
      <div className="provider-list" aria-label={t('Providers')}>
        {controller.loading ? <div className="settings-empty" role="status">{t('Loading providers…')}</div> : null}
        {!controller.loading && !controller.providers.length ? <div className="provider-empty">
          <Server size={24} /><h4>{t('Connect your first provider')}</h4>
          <p>{t('Add a Base URL and API key to get started.')}</p>
          <button className="btn" onClick={() => controller.edit()}><Plus size={13} />{t('Add provider')}</button>
        </div> : null}
        {controller.providers.map(provider => {
          const isDefault = settings.provider === provider.id || settings.model?.startsWith(`${provider.id}/`)
          return <button type="button" className="provider-card" key={provider.id} data-active={Boolean(isDefault)} onClick={() => controller.edit(provider)}>
            <span className="provider-card__icon"><Server size={17} /></span>
            <span className="provider-card__body">
              <span className="provider-card__title">{provider.name}{isDefault ? <span className="settings-tag" data-tone="accent">{t('Default')}</span> : null}</span>
              <span className="provider-card__url">{provider.baseUrl || t('Managed by Pi')}</span>
              <span className="provider-card__meta">{provider.models.length} {t('Models')}<span>·</span>{provider.external ? t('Pi sign-in / extension') : provider.api.replace('openai-completions', 'OpenAI Chat').replace('openai-responses', 'OpenAI Responses')}</span>
            </span>
            <ChevronRight size={15} className="provider-card__chevron" />
          </button>
        })}
      </div>
      {controller.error ? <div className="provider-error" role="alert">{controller.error}</div> : null}
      <div className="provider-default-thinking">
        <label htmlFor="provider-default-thinking">{t('Default reasoning effort')}</label>
        <select id="provider-default-thinking" className="input settings-select" value={settings.thinkingLevel ?? ''}
          onChange={event => void updateSettings({ thinkingLevel: event.target.value || undefined })}>
          <option value="">{t('Automatic (Pi default)')}</option>
          {['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(level => <option key={level} value={level}>{t(level[0].toUpperCase() + level.slice(1))}</option>)}
        </select>
      </div>
    </div>
  )
}
