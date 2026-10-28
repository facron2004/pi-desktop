import { useMemo, useState } from 'react'
import { Check, Folder, Plus, Search, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { collectProjects, sortProjects } from '../lib/projects'
import { basename, normalisePathKey, samePath } from '../lib/path'
import { useT } from '../lib/i18n'
import { Popover } from './Popover'

export function ProjectSelector({
  placement = 'bottom',
  align = 'left'
}: {
  placement?: 'top' | 'bottom' | 'right'
  align?: 'left' | 'right'
}) {
  const workspace = useAppStore((state) => state.workspace)
  const workspaces = useAppStore((state) => state.settings.workspaces)
  const sessions = useAppStore((state) => state.sessions)
  const switchProject = useAppStore((state) => state.switchProject)
  const pickWorkspace = useAppStore((state) => state.pickWorkspace)
  const t = useT()

  const [searchQuery, setSearchQuery] = useState('')

  // Deduplicate strictly by canonical path key so no duplicate projects can ever appear.
  const projects = useMemo(() => {
    const raw = collectProjects(workspaces, sessions)
    const sorted = sortProjects(raw, workspace?.path)
    const seen = new Set<string>()
    return sorted.filter((p) => {
      const key = normalisePathKey(p.path)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [workspaces, sessions, workspace?.path])

  const filteredProjects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return projects
    return projects.filter((p) => {
      const name = basename(p.name).toLowerCase()
      return name.includes(q)
    })
  }, [projects, searchQuery])

  const displayName = workspace?.name
    ? basename(workspace.name)
    : workspace?.path
      ? basename(workspace.path)
      : t('Select project')

  return (
    <Popover
      placement={placement}
      align={align}
      width={232}
      className="project-menu-popover"
      renderTrigger={({ open, toggle }) => (
        <button
          className="session-bar__item project-chip"
          data-active={open}
          aria-expanded={open}
          onClick={(e) => {
            if (!open) setSearchQuery('')
            toggle(e)
          }}
          title={workspace?.path ?? t('Select project')}
        >
          <Folder size={11} className="project-chip__icon" />
          <span className="project-chip__name">{displayName}</span>
        </button>
      )}
    >
      {(close) => (
        <div className="project-menu" role="menu">
          {/* Top Search Bar */}
          <div className="project-menu__search">
            <Search size={13} className="project-menu__search-icon" />
            <input
              type="text"
              className="project-menu__search-input"
              placeholder={t('Search projects')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoFocus
            />
            {searchQuery ? (
              <button
                type="button"
                className="project-menu__search-clear"
                onClick={() => setSearchQuery('')}
                aria-label="Clear"
              >
                <X size={11} />
              </button>
            ) : null}
          </div>

          <div className="project-menu__divider" />

          {/* Project List */}
          <div className="project-menu__list">
            {filteredProjects.map((p) => {
              const isCurrent = Boolean(workspace && samePath(workspace.path, p.path))
              return (
                <button
                  key={p.path}
                  className="project-menu__row"
                  data-active={isCurrent || undefined}
                  role="menuitem"
                  title={p.path}
                  onClick={async () => {
                    close()
                    if (!isCurrent) {
                      await switchProject(p.path, { allowWhileRunning: true })
                    }
                  }}
                >
                  <Folder size={13} strokeWidth={1.5} className="project-menu__icon" />
                  <span className="project-menu__name">{basename(p.name)}</span>
                  {isCurrent ? (
                    <Check size={13} strokeWidth={1.8} className="project-menu__check" />
                  ) : null}
                </button>
              )
            })}
            {filteredProjects.length === 0 ? (
              <div className="project-menu__empty">{t('No matching projects')}</div>
            ) : null}
          </div>

          <div className="project-menu__divider" />

          {/* Bottom Actions */}
          <div className="project-menu__actions">
            <button
              className="project-menu__action-btn project-menu__action-btn--primary"
              type="button"
              onClick={async () => {
                close()
                await pickWorkspace()
              }}
            >
              <Plus size={13} strokeWidth={1.8} />
              <span>{t('New project')}</span>
            </button>
          </div>
        </div>
      )}
    </Popover>
  )
}
