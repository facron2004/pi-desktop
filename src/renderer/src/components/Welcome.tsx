import type { ReactNode } from 'react'
import { CircleAlert, FolderOpen, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'
import { ProjectSelector } from './ProjectSelector'

/**
 * A new chat: project & branch selectors above the composer.
 */
export function Welcome({ onPick, children }: { onPick: () => void; children: ReactNode }) {
  const workspace = useAppStore((state) => state.workspace)
  const status = useAppStore((state) => state.status.phase)
  const error = useAppStore((state) => state.error)
  const dismissError = useAppStore((state) => state.dismissError)
  const t = useT()

  return (
    <div className="welcome">
      <div className="welcome__inner">
        {status === 'starting' ? (
          <div className="welcome__pending" role="status">
            <span className="spinner" />
            <span>{t('Starting the Pi runtime…')}</span>
          </div>
        ) : null}

        {error ? (
          <div className="thread-error-banner welcome__error" role="alert">
            <div className="thread-error-banner__content">
              <CircleAlert size={16} className="thread-error-banner__icon" />
              <span className="thread-error-banner__text">{error}</span>
            </div>
            <button
              className="icon-btn thread-error-banner__dismiss"
              onClick={dismissError}
              aria-label={t('Dismiss')}
              title={t('Dismiss')}
            >
              <X size={14} />
            </button>
          </div>
        ) : null}

        {!workspace ? (
          <div className="welcome__top-selectors">
            <ProjectSelector placement="bottom" align="left" />
          </div>
        ) : null}

        {workspace ? (
          <div className="welcome__composer">{children}</div>
        ) : (
          <div className="welcome__composer">
            <button className="btn welcome__open" onClick={onPick}>
              <FolderOpen size={16} aria-hidden="true" />
              {t('Open project folder')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
