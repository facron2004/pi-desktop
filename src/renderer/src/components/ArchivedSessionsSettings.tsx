import { useMemo } from 'react'
import { Archive, ArchiveRestore } from 'lucide-react'
import { formatRelativeTime } from '../lib/format'
import { useT } from '../lib/i18n'
import { basename, normalisePathKey } from '../lib/path'
import { useAppStore } from '../store/useAppStore'
import '../styles/archived-settings.css'

/**
 * Settings → Archived conversations.
 *
 * Archiving is a view preference: the session file stays on disk and only
 * leaves the sidebar. This page lists the archived files and is the one place
 * where they can be brought back.
 */
export function ArchivedSessionsSettings() {
  const settings = useAppStore((state) => state.settings)
  const sessions = useAppStore((state) => state.sessions)
  const restoreSession = useAppStore((state) => state.restoreSession)
  const t = useT()

  const rows = useMemo(() => {
    const archived = new Set(settings.archivedSessions ?? [])
    return sessions
      .filter((session) => archived.has(session.file))
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }, [settings.archivedSessions, sessions])

  const projectLabel = (cwd: string): string => {
    if (!cwd) return t('Chats without a project')
    const key = normalisePathKey(cwd)
    const known = settings.workspaces.find((workspace) => normalisePathKey(workspace.path) === key)
    return known?.name || basename(cwd)
  }

  return (
    <div className="settings-page">
      <header className="settings-page-head">
        <h3>{t('Archived conversations')}</h3>
        <p>{t('Archived conversations leave the sidebar and stay on disk. Restore one to bring it back.')}</p>
      </header>

      <section className="settings-group">
        <div className="settings-group__head">
          <h4>{t('Archived')}</h4>
          <span className="settings-badge">{rows.length}</span>
        </div>

        {rows.length === 0 ? (
          <div className="settings-empty">{t('No archived conversations.')}</div>
        ) : (
          <div className="settings-card-list">
            {rows.map((session) => (
              <div className="settings-card archived-session-row" key={session.file}>
                <div className="settings-card__main">
                  <div className="settings-card__title-row">
                    <Archive size={13} aria-hidden="true" />
                    <span
                      className="settings-card__title"
                      title={session.name || session.preview || t('Untitled session')}
                    >
                      {session.name || session.preview || t('Untitled session')}
                    </span>
                  </div>
                  <span className="settings-card__meta">
                    <span title={session.cwd || undefined}>{projectLabel(session.cwd)}</span>
                    <span>{formatRelativeTime(session.updatedAt, settings.language)}</span>
                    <span>
                      {session.messageCount} {t('msgs')}
                    </span>
                  </span>
                </div>
                <div className="settings-card__actions">
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => void restoreSession(session.file)}
                  >
                    <ArchiveRestore size={13} />
                    {t('Restore')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
