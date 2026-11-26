import { useCallback, useMemo, useState } from 'react'
import { Archive, ArchiveRestore, ChevronDown } from 'lucide-react'
import {
  readCollapsedArchiveGroups,
  toggleCollapsedArchiveGroup,
  writeCollapsedArchiveGroups
} from '../lib/archive-fold'
import { formatRelativeTime } from '../lib/format'
import { useT } from '../lib/i18n'
import { normalisePathKey } from '../lib/path'
import { groupArchivedByProject } from '../lib/sidebar-view'
import { useAppStore } from '../store/useAppStore'
import '../styles/archived-settings.css'

/**
 * Settings → Archived conversations.
 *
 * Archiving is a view preference: the session file stays on disk and only
 * leaves the sidebar. This page lists the archived files and is the one place
 * where they can be brought back.
 *
 * The list is grouped by the project a conversation belongs to — an archived
 * row is exactly the one whose folder is not obvious from its surroundings —
 * and every group folds under its own heading. The open/closed set is a view
 * preference in localStorage, like the memory page's groups.
 */
export function ArchivedSessionsSettings() {
  const settings = useAppStore((state) => state.settings)
  const sessions = useAppStore((state) => state.sessions)
  const restoreSession = useAppStore((state) => state.restoreSession)
  const t = useT()
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsedArchiveGroups())

  const rows = useMemo(() => {
    const archived = new Set(settings.archivedSessions ?? [])
    return sessions.filter((session) => archived.has(session.file))
  }, [settings.archivedSessions, sessions])

  const projectName = useCallback(
    (path: string): string | undefined => {
      const key = normalisePathKey(path)
      return settings.workspaces.find((workspace) => normalisePathKey(workspace.path) === key)?.name
    },
    [settings.workspaces]
  )

  // The groups follow the sidebar's project order, and archived chats that never
  // had a folder close the list — the same shape the sidebar's archived section
  // uses, so the two places read alike.
  const groups = useMemo(
    () =>
      groupArchivedByProject(rows, {
        projectName,
        projectlessName: t('Chats without a project'),
        order: settings.projectOrder
      }),
    [rows, projectName, settings.projectOrder, t]
  )

  const toggle = (key: string) => {
    setCollapsed((current) => {
      const next = toggleCollapsedArchiveGroup(current, key)
      writeCollapsedArchiveGroups(next)
      return next
    })
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
            {groups.map((group) => {
              const open = !collapsed.has(group.key)
              return (
                <div className="archived-group" key={group.key || 'projectless'}>
                  <button
                    type="button"
                    className="archived-group__head"
                    aria-expanded={open}
                    onClick={() => toggle(group.key)}
                  >
                    <ChevronDown
                      className="archived-group__caret"
                      data-open={open ? 'true' : undefined}
                      size={14}
                      aria-hidden="true"
                    />
                    <span className="archived-group__name" title={group.key ? group.name : undefined}>
                      {group.name}
                    </span>
                    <span className="archived-group__count">{group.sessions.length}</span>
                  </button>

                  {open ? (
                    <div className="archived-group__rows">
                      {group.sessions.map((session) => (
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
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
