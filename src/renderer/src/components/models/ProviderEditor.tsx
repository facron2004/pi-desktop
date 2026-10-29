import { ArrowLeft, Check, Download, LoaderCircle, Wifi } from 'lucide-react'
import type { ProviderApi } from '@shared/providers'
import type { useProviders } from '../../hooks/useProviders'
import { useT } from '../../lib/i18n'
import { ModelParameters } from './ModelParameters'

export function ProviderEditor({ controller }: { controller: ReturnType<typeof useProviders> }) {
  const { draft, busy, probe, error, change, changeModel, cancel, fetchModels, test, save } = controller
  const t = useT()
  if (!draft) return null
  const disabled = Boolean(busy)
  const locked = disabled || Boolean(draft.external)
  const model = draft.models.find(model => model.id === draft.selectedModel) ?? { id: draft.selectedModel }
  const canConnect = Boolean(draft.baseUrl && (draft.apiKey.trim() || draft.hasApiKey)) && !draft.external
  return (
    <form className="provider-editor" onSubmit={event => { event.preventDefault(); save() }}>
      <div className="provider-editor__head">
        <button className="btn btn--sm" type="button" onClick={cancel}><ArrowLeft size={13} />{t('Providers')}</button>
        <span className="provider-editor__kind">{draft.id ? t('Edit provider') : t('Add provider')}</span>
      </div>
      {draft.external ? <p className="provider-notice">{t('This provider uses Pi-managed authentication. Choose a model here, or add an API-key provider for another endpoint.')}</p> : null}
      <section className="provider-connection" aria-label={t('Provider connection')}>
        <div className="provider-section-head"><h4>{t('Provider connection')}</h4></div>
        <div className="provider-form-grid">
          <label className="field"><span className="field__label">{t('Provider name')}</span>
            <input className="input" required value={draft.name} disabled={locked} placeholder={t('e.g. My API provider')}
              onChange={event => change({ name: event.target.value })} />
          </label>
          <label className="field"><span className="field__label">{t('API format')}</span>
            <select className="input settings-select" value={draft.api} disabled={locked}
              onChange={event => change({ api: event.target.value as ProviderApi })}>
              <option value="openai-completions">OpenAI Chat Completions</option>
              <option value="openai-responses">OpenAI Responses</option>
              <option value="anthropic-messages">Anthropic Messages</option>
              <option value="google-generative-ai">Google Gemini</option>
              {draft.external && !['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].includes(draft.api) ? <option value={draft.api}>{draft.api}</option> : null}
            </select>
          </label>
        </div>
        <label className="field"><span className="field__label">Base URL</span>
          <input className="input" type="url" required={!draft.external} value={draft.baseUrl} disabled={locked}
            placeholder="https://api.example.com/v1" spellCheck={false}
            onChange={event => change({ baseUrl: event.target.value })} />
        </label>
        <label className="field"><span className="provider-field-label">API Key{draft.hasApiKey ? <span className="provider-source">{t('Saved in Pi configuration')}</span> : null}</span>
          <input className="input" type="password" required={!draft.hasApiKey && !draft.external} value={draft.apiKey} disabled={locked}
            autoComplete="off" spellCheck={false} placeholder={draft.hasApiKey ? t('Leave blank to keep the saved key') : 'sk-…'}
            onChange={event => change({ apiKey: event.target.value })} />
        </label>
        {!draft.external ? (
          <div className="provider-connection__actions">
            <button className="btn btn--sm" type="button" disabled={disabled || !canConnect} onClick={fetchModels}>
              {busy === 'models' ? <LoaderCircle size={13} className="spin" /> : <Download size={13} />}{t('Fetch upstream models')}
            </button>
            <button className="btn btn--sm" type="button" disabled={disabled || !canConnect} onClick={test}>
              {busy === 'probe' ? <LoaderCircle size={13} className="spin" /> : <Wifi size={13} />}{t('Test connection')}
            </button>
          </div>
        ) : null}
        {probe ? <div className="provider-probe" data-ok={probe.ok} role="status">
          {probe.ok ? <Check size={13} /> : <Wifi size={13} />}
          <span>{probe.ok ? `${t(probe.stage === 'inference' ? 'Model request succeeded' : 'Model endpoint reachable')} · ${probe.latencyMs} ms` : probe.error}</span>
        </div> : null}
      </section>
      <section className="provider-model-choice">
        <div className="provider-section-head"><h4>{t('Choose a model')}</h4><span className="settings-badge">{draft.models.length}</span></div>
        <label className="field"><span className="field__label">{t('Default model')}</span>
          {draft.models.length ? <select className="input settings-select" disabled={disabled} value={draft.selectedModel}
            onChange={event => change({ selectedModel: event.target.value })}>
            {draft.models.map(model => <option key={model.id} value={model.id}>{model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id}</option>)}
          </select> : <input className="input" required value={draft.selectedModel} disabled={disabled} placeholder={t('Fetch models first, or enter a model ID')}
            onChange={event => change({ selectedModel: event.target.value })} />}
        </label>
      </section>
      {draft.selectedModel ? <ModelParameters model={model} disabled={locked} onChange={changeModel} /> : null}
      {error ? <div className="provider-error" role="alert">{error}</div> : null}
      <div className="provider-editor__footer">
        <span className="field__hint">{t('Saves the provider and makes the selected model the default for new conversations.')}</span>
        <button className="btn btn--primary" type="submit" disabled={disabled || !draft.selectedModel.trim()}>
          {busy === 'save' ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}{t('Save and use')}
        </button>
      </div>
    </form>
  )
}
