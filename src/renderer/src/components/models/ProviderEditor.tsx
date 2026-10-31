import { useEffect, useState } from 'react'
import { ArrowLeft, Check, Eye, EyeOff, LoaderCircle, Wifi } from 'lucide-react'
import type { ProviderApi } from '@shared/providers'
import type { useProviders } from '../../hooks/useProviders'
import { useT } from '../../lib/i18n'
import { ModelList } from './ModelList'

export function ProviderEditor({ controller }: { controller: ReturnType<typeof useProviders> }) {
  const { draft, busy, probe, error, change, patchModel, toggleModel, makeDefault, addModel, removeModel, cancel, fetchModels, test, save } = controller
  const t = useT()
  const [showKey, setShowKey] = useState(false)
  // A revealed key must not stay visible after the editor moves to another provider.
  useEffect(() => { setShowKey(false) }, [draft?.id])
  if (!draft) return null
  const disabled = Boolean(busy)
  const locked = disabled || Boolean(draft.external)
  const canConnect = Boolean(draft.baseUrl && (draft.apiKey.trim() || draft.hasApiKey)) && !draft.external
  const canSave = draft.external
    ? Boolean(draft.selectedModel.trim())
    : draft.models.some(model => model.enabled !== false && model.id.trim())
  return (
    <form className="provider-editor" onSubmit={event => { event.preventDefault(); save() }}>
      <div className="provider-editor__head">
        <button className="btn btn--sm provider-editor__back" type="button" onClick={cancel} aria-label={t('Back')}><ArrowLeft size={14} /></button>
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
          <span className="provider-key">
            <input className="input" type="text" data-masked={showKey ? 'false' : 'true'} required={!draft.hasApiKey && !draft.external} value={draft.apiKey} disabled={locked}
              autoComplete="off" spellCheck={false} placeholder={draft.hasApiKey && !draft.apiKey.trim() ? t('Leave blank to keep the saved key') : 'sk-…'}
              onChange={event => change({ apiKey: event.target.value })} />
            <button className="icon-btn provider-key__toggle" type="button" disabled={locked}
              aria-pressed={showKey} aria-label={t(showKey ? 'Hide API key' : 'Show API key')}
              onMouseDown={event => event.preventDefault()}
              onClick={() => setShowKey(value => !value)}>
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </span>
        </label>
        {!draft.external ? (
          <div className="provider-connection__actions">
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
      <ModelList
        models={draft.models}
        selectedId={draft.selectedModel}
        external={Boolean(draft.external)}
        locked={locked}
        busy={disabled}
        fetching={busy === 'models'}
        canFetch={canConnect}
        onFetch={fetchModels}
        onAdd={addModel}
        onToggle={toggleModel}
        onMakeDefault={makeDefault}
        onRemove={removeModel}
        onPatch={patchModel}
      />
      {error ? <div className="provider-error" role="alert">{error}</div> : null}
      <div className="provider-editor__footer">
        <span className="field__hint">{t('Saves the provider. Only enabled models appear in the picker, and the default model is used for new conversations.')}</span>
        <button className="btn btn--primary" type="submit" disabled={disabled || !canSave}>
          {busy === 'save' ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}{t('Save and use')}
        </button>
      </div>
    </form>
  )
}
