import { useMemo } from 'react'
import { Check, FolderOpen, FolderSearch } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { collectProjects, sortProjects } from '../lib/projects'
import { samePath } from '../lib/path'
import { useT } from '../lib/i18n'
import { BranchMenu } from './BranchMenu'
import { ContextRing } from './ContextRing'
import { Popover } from './Popover'

/**
 * The line under the composer: where the next message runs.
 *
 * It is deliberately quiet 鈥?plain text, no boxes 鈥?because it is read far more
 * often than it is used: the project, the branch and the uncommitted count.
 * How the message runs (effort, model) is inside the box with the message.
 *
 * A new chat does not show it: there is no conversation to describe yet, and
 * the project is already the one the window opened. The branch is the first
 * thing that needs it, so it appears with the first message.
 */
export function SessionBar({ showProject }: { showProject: boolean }) {
  const workspace = useAppStore((state) => state.workspace)
  const git = useAppStore((state) => state.git)
  const settings = useAppStore((state) => state.settings)
  const sessions = useAppStore((state) => state.sessions)
  const pickWorkspace = useAppStore((state) => state.pickWorkspace)
  const switchProject = useAppStore((state) => state.switchProject)
  const t = useT()

  // The active project first, then the ones used most recently, so the menu
  // reads like the sidebar rather than in the order the folders were opened.
  const projects = useMemo(
    () => sortProjects(collectProjects(settings.workspaces, sessions), workspace?.path),
    [settings.workspaces, sessions, workspace?.path]
  )

  const openInspector = () =>
    window.dispatchEvent(new CustomEvent('pi:open-inspector', { detail: { tab: 'changes' } }))

  return (
    <div className="session-bar">
      {showProject ? (
        <Popover
          placement="top"
          align="left"
          width={320}
          className="session-bar__picker"
          renderTrigger={({ open, toggle }) => (
            <button
              type="button"
              className="session-bar__item session-bar__project"
              data-active={open}
              aria-expanded={open}
              aria-label={t('Project')}
              title={workspace ? workspace.path : t('Open a project folder')}
              onClick={toggle}
            >
              <FolderOpen size={13} />
              <span className="session-bar__text">
                {workspace?.name ?? t('Open a project')}
              </span>
            </button>
          )}
        >
          {(close) => (
            <div className="session-bar__projects" role="group" aria-label={t('Projects')}>
              <div className="popover__label">{t('Projects')}</div>
              <div className="session-bar__project-list">
                {projects.map((project) => {
                  const current = Boolean(workspace && samePath(workspace.path, project.path))
                  return (
                    <button
                      key={project.path}
                      type="button"
                      className="popover__item"
                      data-selected={current}
                      aria-pressed={current}
                      title={project.path}
                      onClick={() => {
                        close()
                        if (current) return
                        // Picking a project is deliberate, so it may replace the
                        // running one 鈥?the same door the launcher and Ctrl+1鈥?
                        // use.
                        void switchProject(project.path, { allowWhileRunning: true })
                      }}
                    >
                      <FolderOpen size={14} />
                      <span className="popover__item-text">{project.name}</span>
                      {current ? <Check size={13} className="session-bar__check" /> : null}
                    </button>
                  )
                })}
                {projects.length === 0 ? (
                  <div className="session-bar__empty">{t('No project selected yet.')}</div>
                ) : null}
              </div>
              <div className="session-bar__foot">
                <button
                  type="button"
                  className="popover__item"
                  onClick={() => {
                    close()
                    void pickWorkspace()
                  }}
                >
                  <FolderSearch size={14} />
                  <span className="popover__item-text">{t('Open a folder')}</span>
                </button>
              </div>
            </div>
          )}
        </Popover>
      ) : null}

      <BranchMenu onOpenChanges={openInspector} />

      <ContextRing />

      {showProject && git?.isRepo && git.files.length > 0 ? (
        <button
          type="button"
          className="session-bar__item session-bar__changes"
          title={t('Review the files Pi changed')}
          onClick={openInspector}
        >
          {`${git.files.length} ${t('changed')}`}
        </button>
      ) : null}
    </div>
  )
}
