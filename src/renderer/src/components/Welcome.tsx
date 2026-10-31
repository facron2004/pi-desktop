import type { ReactNode } from 'react'
import { CircleAlert, FolderOpen, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { openingLabel, useT } from '../lib/i18n'
import { ProjectSelector } from './ProjectSelector'
import { PiLogo } from './PiLogo'

/**
 * A new chat: project & branch selectors above the composer.
 */
export function Welcome({ onPick, children }: { onPick: () => void; children: ReactNode }) {
  const workspace = useAppStore((state) => state.workspace)
  const noProject = useAppStore((state) => state.settings.activeWorkspaceId === null)
  const status = useAppStore((state) => state.status.phase)
  const error = useAppStore((state) => state.error)
  const dismissError = useAppStore((state) => state.dismissError)
  const t = useT()
  const greeting = workspace
    ? t('What would you like to do in {project} today?')
    : t('What would you like to do with Pi today?')
  const projectAt = workspace ? greeting.indexOf('{project}') : -1

  return (
    <div className="welcome">
      <div className="welcome__inner">
        {status === 'starting' ? (
          <div className="welcome__pending" role="status">
            <span className="spinner" />
            <span>{openingLabel(workspace, t)}</span>
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

        {!workspace && !noProject ? (
          <div className="welcome__top-selectors">
            <ProjectSelector placement="bottom" align="left" />
          </div>
        ) : null}

        <div className="welcome__hero">
          <PiLogo size={56} />
          <div className="welcome__greeting" role="heading" aria-level={1}>
            {projectAt >= 0 ? (
              <>
                {greeting.slice(0, projectAt)}
                <ProjectSelector variant="inline" placement="bottom" align="left" />
                {greeting.slice(projectAt + '{project}'.length)}
              </>
            ) : (
              greeting
            )}
          </div>
        </div>

        {workspace || noProject ? (
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
