import { useMemo, type ReactNode } from 'react'
import { Bug, Compass, FolderOpen, GitCompare, History, Keyboard } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { formatRelativeTime } from '../lib/format'
import { samePath } from '../lib/path'
import { useT } from '../lib/i18n'
import { formatPlatformShortcut } from '../lib/shortcuts'

export function Welcome({ onPick, children }: { onPick: () => void; children: ReactNode }) {
  const workspace = useAppStore((state) => state.workspace)
  const status = useAppStore((state) => state.status.phase)
  const platform = useAppStore((state) => state.info?.platform)
  const git = useAppStore((state) => state.git)
  const sessions = useAppStore((state) => state.sessions)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const selectSession = useAppStore((state) => state.selectSession)
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer)
  const t = useT()

  const recentSessions = useMemo(() => {
    if (!workspace?.path) return []
    return sessions
      .filter((session) => session.cwd && samePath(session.cwd, workspace.path))
      .slice(0, 3)
  }, [sessions, workspace?.path])

  const dirtyCount = git?.isRepo ? git.files.length : 0

  return (
    <div className="welcome">
      <div className="welcome__inner">
        <div className="welcome__heading">
          <h1 className="welcome__title">{t('What would you like to work on today?')}</h1>
          <p className="welcome__subtitle">
            {workspace
              ? t('Start a new conversation in {project}').replace('{project}', workspace.name)
              : t('Open a project to start a new conversation')}
          </p>
        </div>

        <button className="btn welcome__open" onClick={onPick}>
          <FolderOpen size={16} aria-hidden="true" />
          {t('Open project folder')}
        </button>

        {children}

        {workspace && status === 'ready' ? (
          <div className="welcome__starters">
            {dirtyCount > 0 ? (
              <button
                type="button"
                className="welcome__starter"
                onClick={() =>
                  insertIntoComposer(
                    t(
                      'Review the uncommitted git changes in this repository, point out any bugs or edge cases, and suggest improvements.'
                    ),
                    'replace'
                  )
                }
              >
                <span className="welcome__starter-icon" data-tone="amber">
                  <GitCompare size={14} />
                </span>
                <span className="welcome__starter-body">
                  <span className="welcome__starter-title">{t('Review uncommitted changes')}</span>
                  <span className="welcome__starter-desc">
                    {dirtyCount} {dirtyCount === 1 ? t('changed file') : t('changed files')}
                    {git?.branch ? ` · ${git.branch}` : ''}
                  </span>
                </span>
              </button>
            ) : null}

            <button
              type="button"
              className="welcome__starter"
              onClick={() =>
                insertIntoComposer(
                  t(
                    'Give me a concise overview of this codebase: architecture, key entry points, and how the main modules fit together.'
                  ),
                  'replace'
                )
              }
            >
              <span className="welcome__starter-icon" data-tone="blue">
                <Compass size={14} />
              </span>
              <span className="welcome__starter-body">
                <span className="welcome__starter-title">{t('Explain codebase architecture')}</span>
                <span className="welcome__starter-desc">
                  {t('Key modules, entry points & data flow')}
                </span>
              </span>
            </button>

            <button
              type="button"
              className="welcome__starter"
              onClick={() =>
                insertIntoComposer(
                  t('Run the project typecheck or test suite and fix any issues that come up.'),
                  'replace'
                )
              }
            >
              <span className="welcome__starter-icon" data-tone="violet">
                <Bug size={14} />
              </span>
              <span className="welcome__starter-body">
                <span className="welcome__starter-title">{t('Find & fix issues')}</span>
                <span className="welcome__starter-desc">
                  {t('Run typecheck or tests and resolve errors')}
                </span>
              </span>
            </button>
          </div>
        ) : null}

        {recentSessions.length > 0 ? (
          <div className="welcome__recent">
            <div className="welcome__recent-label">
              <History size={12} />
              <span>{t('Recent in this project')}</span>
            </div>
            <div className="welcome__recent-list">
              {recentSessions.map((session) => (
                <button
                  key={session.file}
                  type="button"
                  className="welcome__recent-item"
                  // The welcome screen only shows while nothing is running, so
                  // opening a conversation here never ends a run.
                  disabled={isStreaming}
                  onClick={() => void selectSession(session)}
                >
                  <span className="welcome__recent-title">
                    {session.name || session.preview || t('Untitled conversation')}
                  </span>
                  <span className="welcome__recent-time">
                    {formatRelativeTime(session.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {status === 'starting' ? (
          <div className="welcome__pending" role="status">
            <span className="spinner" />
            <span>{t('Starting the Pi runtime…')}</span>
          </div>
        ) : null}

        <button
          className="welcome__shortcut"
          onClick={() => window.dispatchEvent(new CustomEvent('pi:open-launcher'))}
        >
          <Keyboard size={16} aria-hidden="true" />
          <span>{formatPlatformShortcut('Ctrl+Shift+P', platform)}</span>
          <span>{t('Open the command palette')}</span>
        </button>
      </div>
    </div>
  )
}
