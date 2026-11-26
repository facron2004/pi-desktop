import type { ReactNode } from 'react'
import { CircleAlert, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { openingLabel, useT } from '../lib/i18n'
import { ProjectSelector } from './ProjectSelector'
import { PiLogo } from './PiLogo'
import { CwdWaitDetail } from './RunStatusRow'

/**
 * A new chat: project & branch selectors above the composer.
 *
 * There is deliberately no "open project folder" holding screen. A start with
 * no usable project is a projectless chat, so the composer is always here to
 * type into; picking a project is an option, not a prerequisite.
 */
export function Welcome({ children }: { children?: ReactNode }) {
  const workspace = useAppStore((state) => state.workspace)
  const noProject = useAppStore((state) => state.settings.activeWorkspaceId == null)
  const status = useAppStore((state) => state.status.phase)
  const cwdWait = useAppStore((state) => state.cwdWait)
  const error = useAppStore((state) => state.error)
  const dismissError = useAppStore((state) => state.dismissError)
  const bootstrap = useAppStore((state) => state.bootstrap)
  const t = useT()
  const greeting = workspace
    ? t('What would you like to do in {project} today?')
    : t('What would you like to do with Pi today?')
  const projectAt = workspace ? greeting.indexOf('{project}') : -1

  return (
    <div className="welcome">
      <div className="welcome__inner">
        {cwdWait ? (
          <div className="welcome__pending" role="status">
            <span className="spinner" />
            <CwdWaitDetail cwdWait={cwdWait} />
          </div>
        ) : status === 'starting' ? (
          <div className="welcome__pending" role="status">
            <span className="spinner" />
            <span>{openingLabel(workspace, t)}</span>
          </div>
        ) : null}

        {error ? (
          <div className="thread-error-banner welcome__error" role="alert">
            <div className="thread-error-banner__content">
              <CircleAlert size={16} className="thread-error-banner__icon" />
              <span className="thread-error-banner__text">{t(error)}</span>
            </div>
            <div className="thread-error-banner__actions">
              <button type="button" className="btn btn--sm" onClick={() => void bootstrap()}>
                {t('Try again')}
              </button>
              <button
                className="icon-btn thread-error-banner__dismiss"
                onClick={dismissError}
                aria-label={t('Dismiss')}
                title={t('Dismiss')}
              >
                <X size={14} />
              </button>
            </div>
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

        {children ? <div className="welcome__composer">{children}</div> : null}
      </div>
    </div>
  )
}
