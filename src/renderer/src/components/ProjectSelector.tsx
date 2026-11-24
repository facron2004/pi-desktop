import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Folder, MessageSquare, Plus, Search, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { collectProjects, sortProjects } from '../lib/projects'
import { basename, normalisePathKey, samePath } from '../lib/path'
import { useT } from '../lib/i18n'
import { Popover } from './Popover'

export const ProjectSelector = memo(function ProjectSelector({
  placement = 'bottom',
  align = 'left',
  variant = 'chip'
}: {
  placement?: 'top' | 'bottom' | 'right'
  align?: 'left' | 'right'
  /** `inline` is the project name inside the welcome sentence. */
  variant?: 'chip' | 'inline'
}) {
  const workspace = useAppStore((state) => state.workspace)
  const noProject = useAppStore((state) => !state.workspace && state.settings.activeWorkspaceId === null)
  const workspaces = useAppStore((state) => state.settings.workspaces)
  const hiddenProjects = useAppStore((state) => state.settings.hiddenProjects)
  const projectOrder = useAppStore((state) => state.settings.projectOrder)
  const sessions = useAppStore((state) => state.sessions)
  const switchProject = useAppStore((state) => state.switchProject)
  const openProjectDialog = useAppStore((state) => state.openProjectDialog)
  const t = useT()

  const [searchQuery, setSearchQuery] = useState('')
  // The filter field takes focus when the menu opens, so the menu has to be
  // drivable from it: Popover refuses to move a highlight while an input has
  // focus, and a menu whose arrows and Enter do nothing is not a menu.
  const [highlighted, setHighlighted] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  // Deduplicate strictly by canonical path key so no duplicate projects can ever appear.
  const projects = useMemo(() => {
    const raw = collectProjects(workspaces, sessions, hiddenProjects, projectOrder)
    const sorted = sortProjects(raw, workspace?.path)
    const seen = new Set<string>()
    return sorted.filter((p) => {
      const key = normalisePathKey(p.path)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [workspaces, sessions, hiddenProjects, projectOrder, workspace?.path])

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
      : noProject
        ? t('Work without a project')
        : t('Select project')

  // A new query is a new list: start again at the top and keep the highlighted
  // row in view when the arrows walk past the fold.
  useEffect(() => {
    setHighlighted(0)
  }, [searchQuery])

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-highlighted="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])

  return (
    <Popover
      placement={placement}
      align={align}
      width={232}
      className="project-menu-popover"
      renderTrigger={({ open, toggle, close }) =>
        variant === 'inline' ? (
          <button
            type="button"
            className="welcome__project"
            data-active={open}
            aria-expanded={open}
            aria-haspopup="menu"
            aria-label={t('Projects')}
            onClick={(e) => {
              if (!open) setSearchQuery('')
              toggle(e)
            }}
            title={workspace?.path ?? displayName}
          >
            {displayName}
          </button>
        ) : (
          // The chip is a container, not one button: the glyph and the name are
          // separate targets. A button inside a button is not valid markup.
          <div
            className="session-bar__item project-chip"
            data-active={open}
          >
            {workspace ? (
              // The folder doubles as the way out: hovering the chip (or
              // opening the menu) turns it into an X, and the X drops back to
              // working without a project. One hover, one click — no trip
              // through the menu for the common "stop using this folder".
              <button
                type="button"
                className="project-chip__glyph"
                aria-label={t('Stop using this project')}
                title={t('Stop using this project')}
                onClick={() => {
                  close()
                  void switchProject(null, { allowWhileRunning: true })
                }}
              >
                <Folder size={11} className="project-chip__icon project-chip__folder" />
                <X size={11} className="project-chip__icon project-chip__remove" />
              </button>
            ) : (
              <span className="project-chip__glyph project-chip__glyph--static" aria-hidden="true">
                {noProject ? (
                  <MessageSquare size={11} className="project-chip__icon" />
                ) : (
                  <Folder size={11} className="project-chip__icon" />
                )}
              </span>
            )}
            <button
              type="button"
              className="project-chip__label"
              aria-expanded={open}
              aria-haspopup="menu"
              onClick={(e) => {
                if (!open) setSearchQuery('')
                toggle(e)
              }}
              title={workspace?.path ?? displayName}
            >
              <span className="project-chip__name">{displayName}</span>
            </button>
          </div>
        )
      }
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
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                const count = filteredProjects.length
                if (!count) return
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  event.stopPropagation()
                  setHighlighted((current) => {
                    const next = event.key === 'ArrowDown' ? current + 1 : current - 1
                    return (next + count) % count
                  })
                  return
                }
                if (event.key !== 'Enter') return
                const picked = filteredProjects[Math.min(highlighted, count - 1)]
                if (!picked) return
                event.preventDefault()
                event.stopPropagation()
                close()
                if (!(workspace && samePath(workspace.path, picked.path))) {
                  void switchProject(picked.path, { allowWhileRunning: true })
                }
              }}
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
          <div className="project-menu__list" ref={listRef}>
            {filteredProjects.map((p, index) => {
              const isCurrent = Boolean(workspace && samePath(workspace.path, p.path))
              return (
                <button
                  key={p.path}
                  className="project-menu__row"
                  data-active={isCurrent || undefined}
                  data-highlighted={index === highlighted || undefined}
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
              onClick={() => {
                close()
                openProjectDialog({ mode: 'create' })
              }}
            >
              <Plus size={13} strokeWidth={1.8} />
              <span>{t('New project')}</span>
            </button>
            <button
              type="button"
              className="project-menu__row"
              data-active={noProject || undefined}
              role="menuitemradio"
              aria-checked={noProject}
              onClick={() => {
                close()
                if (!noProject) void switchProject(null, { allowWhileRunning: true })
              }}
            >
              <MessageSquare size={13} strokeWidth={1.5} className="project-menu__icon" />
              <span className="project-menu__name">{t('Work without a project')}</span>
              {noProject ? <Check size={13} strokeWidth={1.8} className="project-menu__check" /> : null}
            </button>
          </div>
        </div>
      )}
    </Popover>
  )
})
