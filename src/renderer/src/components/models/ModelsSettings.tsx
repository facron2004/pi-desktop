import { useState } from 'react'
import { Pencil, Plus, Server, Trash2 } from 'lucide-react'
import type { ProviderProfile } from '@shared/providers'
import { useProviders } from '../../hooks/useProviders'
import { useT } from '../../lib/i18n'
import { useAppStore } from '../../store/useAppStore'
import { ConfirmDialog } from '../ConfirmDialog'
import { ProviderEditor } from './ProviderEditor'
import '../../styles/providers.css'

export function ModelsSettings() {
  const controller = useProviders()
  const settings = useAppStore(state => state.settings)
  const t = useT()
  const [pendingRemove, setPendingRemove] = useState<ProviderProfile | null>(null)
  if (controller.draft) return <div className="settings-page provider-settings"><ProviderEditor controller={controller} /></div>
  return (
    <div className="settings-page provider-settings">
      <header className="settings-page-head provider-page-head">
        <div><h3>{t('Model management')}</h3><p>{t('Configure providers, fetch their models, and choose where Pi connects.')}</p></div>
        <button className="btn btn--primary btn--sm" type="button" onClick={() => controller.edit()}><Plus size={13} />{t('Add provider')}</button>
      </header>
      <div className="provider-list" aria-label={t('Providers')}>
        {controller.loading ? <div className="settings-empty" role="status">{t('Loading providers…')}</div> : null}
        {!controller.loading && !controller.providers.length ? <div className="provider-empty">
          <Server size={24} /><h4>{t('Connect your first provider')}</h4>
          <p>{t('Add a Base URL and API key to get started.')}</p>
          <button className="btn" type="button" onClick={() => controller.edit()}><Plus size={13} />{t('Add provider')}</button>
        </div> : null}
        {controller.providers.map(provider => {
          const isDefault = settings.provider === provider.id || settings.model?.startsWith(`${provider.id}/`)
          const stored = Boolean(provider.revision)
          return <article className="provider-card" key={provider.id} data-active={Boolean(isDefault)}>
            <span className="provider-card__icon"><Server size={17} /></span>
            <span className="provider-card__body">
              <span className="provider-card__title">{provider.name}</span>
              <span className="provider-card__url">{provider.baseUrl || t('Managed by Pi')}</span>
            </span>
            <span className="provider-card__actions">
              <button
                className="icon-btn"
                type="button"
                aria-label={t('Edit provider')}
                title={t('Edit provider')}
                onClick={() => controller.edit(provider)}
              >
                <Pencil size={14} />
              </button>
              <button
                className="icon-btn provider-card__delete"
                type="button"
                aria-label={t('Delete provider')}
                title={stored ? t('Delete provider') : t('This provider is managed by Pi')}
                disabled={!stored}
                onClick={() => setPendingRemove(provider)}
              >
                <Trash2 size={14} />
              </button>
            </span>
          </article>
        })}
      </div>
      {controller.error ? <div className="provider-error" role="alert">{controller.error}</div> : null}
      {pendingRemove ? (
        <ConfirmDialog
          title={t('Delete this provider?')}
          body={t('The saved connection is removed. Pi sign-in is left as Pi stored it.')}
          confirmLabel={t('Delete')}
          tone="danger"
          onCancel={() => setPendingRemove(null)}
          onConfirm={() => {
            const provider = pendingRemove
            setPendingRemove(null)
            void controller.remove(provider)
          }}
        />
      ) : null}
    </div>
  )
}
