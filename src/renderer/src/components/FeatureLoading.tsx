import { useT } from '../lib/i18n'
import '../styles/feature-loading.css'

/** Keep the surrounding page and controls usable while an optional feature loads. */
export function FeatureLoading() {
  const t = useT()
  return (
    <div className="feature-loading" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{t('Loading…')}</span>
    </div>
  )
}
