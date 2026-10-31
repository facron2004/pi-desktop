import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, Download, LoaderCircle, Plus } from 'lucide-react'
import type { ModelParameter, ProviderModel } from '@shared/providers'
import type { EditorModel } from '../../hooks/useProviders'
import { useT } from '../../lib/i18n'
import { Switch } from '../Switch'
import { ModelParameters } from './ModelParameters'

export function ModelList({ models, selectedId, external, locked, busy, fetching, canFetch, onFetch, onAdd, onToggle, onMakeDefault, onRemove, onPatch }: {
  models: EditorModel[]
  selectedId: string
  external: boolean
  locked: boolean
  busy: boolean
  fetching: boolean
  canFetch: boolean
  onFetch: () => void
  onAdd: (clientKey: string) => void
  onToggle: (clientKey: string) => void
  onMakeDefault: (clientKey: string) => void
  onRemove: (clientKey: string) => void
  onPatch: (clientKey: string, patch: Partial<ProviderModel>, manual?: ModelParameter[]) => void
}) {
  const t = useT()
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const focusKey = useRef<string | null>(null)
  useEffect(() => {
    const key = focusKey.current
    if (!key) return
    focusKey.current = null
    document.getElementById(`provider-model-${key}`)?.focus()
  }, [models])

  const add = () => {
    const clientKey = crypto.randomUUID()
    focusKey.current = clientKey
    setOpen(current => new Set(current).add(clientKey))
    onAdd(clientKey)
  }

  return (
    <section className="provider-models" aria-label={t('Model configuration')}>
      <div className="provider-section-head">
        <h4>{t('Model configuration')}</h4>
        {external ? null : (
          <div className="provider-models__actions">
            <button className="btn btn--sm" type="button" disabled={busy || !canFetch} onClick={onFetch}>
              {fetching ? <LoaderCircle size={13} className="spin" /> : <Download size={13} />}{t('Fetch model list')}
            </button>
            <button className="btn btn--sm" type="button" disabled={busy} onClick={add}>
              <Plus size={13} />{t('Add manually')}
            </button>
          </div>
        )}
      </div>
      <p className="field__hint">{t(external
        ? 'This catalog is managed by Pi. Choose the model to use; the arrow shows its configuration.'
        : 'Fetched models include the configuration returned upstream. The switch controls whether a model appears in the picker; the arrow opens that configuration.')}</p>
      {models.length ? (
        <div className="provider-models__list" role="list">
          <div className="provider-models__columns" aria-hidden="true">
            <span />
            <span>{t('Model ID')}</span>
            <span>{t('Display name')}</span>
            <span />
          </div>
          {models.map(model => {
            const expanded = open.has(model.clientKey)
            const enabled = model.enabled !== false
            const isDefault = Boolean(model.id) && model.id === selectedId && (external || enabled)
            const detailsId = `provider-model-config-${model.clientKey}`
            return (
              <div className="provider-models__item" role="listitem" key={model.clientKey} data-open={expanded} data-enabled={external || enabled}>
                <div className="provider-models__row">
                  <button
                    className="icon-btn provider-models__expand"
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={detailsId}
                    aria-label={`${t(expanded ? 'Hide model configuration' : 'Show model configuration')}: ${model.id || t('New model')}`}
                    onClick={() => setOpen(current => {
                      const next = new Set(current)
                      if (next.has(model.clientKey)) next.delete(model.clientKey)
                      else next.add(model.clientKey)
                      return next
                    })}
                  >
                    <ChevronRight size={14} />
                  </button>
                  <div className="provider-models__fields">
                    <input
                      id={`provider-model-${model.clientKey}`}
                      className="input"
                      value={model.id}
                      disabled={locked}
                      spellCheck={false}
                      autoComplete="off"
                      aria-label={t('Model ID')}
                      placeholder={t('e.g. deepseek-v4-pro')}
                      onChange={event => onPatch(model.clientKey, { id: event.target.value })}
                    />
                    <div className="provider-models__name">
                      <input
                        className="input"
                        value={model.name ?? ''}
                        disabled={locked}
                        spellCheck={false}
                        autoComplete="off"
                        aria-label={t('Display name')}
                        placeholder={model.id || t('Display name')}
                        onChange={event => onPatch(model.clientKey, { name: event.target.value || undefined }, ['name'])}
                      />
                    </div>
                  </div>
                  {external ? (
                    <button
                      className="icon-btn provider-models__choose"
                      type="button"
                      aria-pressed={isDefault}
                      aria-label={t('Use this model')}
                      title={t('Use this model')}
                      disabled={busy || !model.id.trim()}
                      onClick={() => onMakeDefault(model.clientKey)}
                    >
                      <Check size={14} />
                    </button>
                  ) : (
                    <Switch
                      checked={enabled}
                      disabled={busy}
                      label={`${t(enabled ? 'Disable this model in the picker' : 'Enable this model in the picker')}: ${model.id || t('New model')}`}
                      onChange={() => onToggle(model.clientKey)}
                    />
                  )}
                </div>
                {expanded ? (
                  <div className="provider-models__details" id={detailsId}>
                    <ModelParameters
                      nested
                      model={model}
                      disabled={locked}
                      onChange={(field, value) => onPatch(model.clientKey, { [field]: value }, [field])}
                    />
                    {external ? null : (
                      <div className="provider-models__detail-actions">
                        {model.id.trim() && enabled && !isDefault ? (
                          <button className="btn btn--sm" type="button" disabled={busy} onClick={() => onMakeDefault(model.clientKey)}>
                            {t('Use as default')}
                          </button>
                        ) : null}
                        <button className="btn btn--sm" type="button" disabled={busy} onClick={() => onRemove(model.clientKey)}>
                          {t('Remove model')}
                        </button>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : <p className="field__hint">{t(external ? 'No models yet.' : 'Fetch the list or add a model manually.')}</p>}
    </section>
  )
}
