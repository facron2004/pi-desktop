import type { ModelParameter, ParameterSource, ProviderModel } from '@shared/providers'
import { useT } from '../../lib/i18n'

const SOURCE_LABELS: Record<ParameterSource, string> = {
  upstream: 'From upstream', catalog: 'Pi catalog reference', saved: 'Configured', manual: 'Edited manually'
}

export function ModelParameters({ model, disabled, onChange, nested = false }: {
  model: ProviderModel
  disabled: boolean
  onChange: (field: ModelParameter, value: ProviderModel[ModelParameter]) => void
  /** Inside an expanded model row the id and display name are already on the row. */
  nested?: boolean
}) {
  const t = useT()
  const source = (field: ModelParameter) => (
    <span className="provider-source" data-source={model.sources?.[field] ?? 'missing'}>
      {t(model.sources?.[field] ? SOURCE_LABELS[model.sources[field]!] : 'Not supplied')}
    </span>
  )
  const number = (field: 'contextWindow' | 'maxTokens', label: string) => (
    <label className="field">
      <span className="provider-field-label">{t(label)}{source(field)}</span>
      <input className="input" type="number" min="1" step="1" value={model[field] ?? ''}
        disabled={disabled} placeholder={t('Use Pi default')}
        onChange={event => onChange(field, event.target.value === '' ? undefined : Number(event.target.value))} />
    </label>
  )
  return (
    <section className={nested ? 'provider-parameters provider-parameters--nested' : 'provider-parameters'} aria-label={t('Model parameters')}>
      {nested ? null : <div className="provider-section-head"><h4>{t('Model parameters')}</h4></div>}
      {nested ? null : <label className="field">
        <span className="provider-field-label">{t('Display name')}{source('name')}</span>
        <input className="input" value={model.name ?? ''} disabled={disabled} placeholder={model.id}
          onChange={event => onChange('name', event.target.value || undefined)} />
      </label>}
      <div className="provider-form-grid">
        {number('contextWindow', 'Context window (tokens)')}
        {number('maxTokens', 'Maximum output (tokens)')}
        <label className="field">
          <span className="provider-field-label">{t('Reasoning support')}{source('reasoning')}</span>
          <select className="input settings-select" value={model.reasoning === undefined ? '' : String(model.reasoning)} disabled={disabled}
            onChange={event => onChange('reasoning', event.target.value === '' ? undefined : event.target.value === 'true')}>
            <option value="">{t('Use Pi default')}</option>
            <option value="true">{t('Supported')}</option><option value="false">{t('Not supported')}</option>
          </select>
        </label>
        <label className="field">
          <span className="provider-field-label">{t('Input types')}{source('input')}</span>
          <select className="input settings-select" value={model.input ? model.input.includes('image') ? 'image' : 'text' : ''} disabled={disabled}
            onChange={event => onChange('input', event.target.value === '' ? undefined : event.target.value === 'image' ? ['text', 'image'] : ['text'])}>
            <option value="">{t('Use Pi default')}</option>
            <option value="text">{t('Text')}</option><option value="image">{t('Text and images')}</option>
          </select>
        </label>
        <label className="field">
          <span className="provider-field-label">{t('Output types')}{source('output')}</span>
          <select className="input settings-select" value={!model.output ? '' : model.output.includes('image') && model.output.includes('text') ? 'both' : model.output.includes('image') ? 'image' : 'text'} disabled={disabled}
            onChange={event => onChange('output', event.target.value === '' ? undefined : event.target.value === 'both' ? ['text', 'image'] : event.target.value === 'image' ? ['image'] : ['text'])}>
            <option value="">{t('Use Pi default')}</option>
            <option value="text">{t('Text')}</option>
            <option value="image">{t('Images only')}</option>
            <option value="both">{t('Text and images')}</option>
          </select>
        </label>
        <label className="field">
          <span className="provider-field-label">{t('Tool support')}{source('tools')}</span>
          <select className="input settings-select" value={model.tools === undefined ? '' : String(model.tools)} disabled={disabled}
            onChange={event => onChange('tools', event.target.value === '' ? undefined : event.target.value === 'true')}>
            <option value="">{t('Use Pi default')}</option>
            <option value="true">{t('Supported')}</option><option value="false">{t('Not supported')}</option>
          </select>
        </label>
      </div>
      <p className="field__hint">{t('Upstream parameters are filled first. Exact Pi catalog matches are marked as references; missing values use Pi defaults unless you edit them.')}</p>
      <details className="provider-price-details">
        <summary>{t('Pricing (USD / million tokens)')}{source('cost')}</summary>
        <div className="provider-form-grid">
          {(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map(field => (
            <label className="field" key={field}>
              <span className="field__label">{t({ input: 'Input price', output: 'Output price', cacheRead: 'Cache read price', cacheWrite: 'Cache write price' }[field])}</span>
              <input className="input" type="number" min="0" step="any" value={model.cost?.[field] ?? ''} disabled={disabled}
                placeholder={t('Not supplied')}
                onChange={event => {
                  const cost = { ...model.cost }
                  if (event.target.value === '') delete cost[field]
                  else cost[field] = Number(event.target.value)
                  onChange('cost', Object.keys(cost).length ? cost : undefined)
                }} />
            </label>
          ))}
        </div>
        <p className="field__hint">{t('Catalog prices are not copied to custom providers. Only upstream prices or your own values are used.')}</p>
      </details>
    </section>
  )
}
