import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Clock,
  Ellipsis,
  Folder,
  FolderEdit,
  FolderOpen,
  Loader2,
  Pencil,
  Pin,
  Plus,
  Search,
  Settings,
  Square,
  SquarePen,
  Trash2,
  X
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import type { SessionMeta, SessionSearchHit } from '@shared/types'
import { formatRelativeTime } from '../lib/format'
import { samePath } from '../lib/path'
import { collectProjects, sortProjects, type Project } from '../lib/projects'
import { basename } from '../lib/path'
import { ConfirmDialog } from './ConfirmDialog'
import { Popover } from './Popover'
import { PiLogo } from './PiLogo'
import { useT } from '../lib/i18n'
import {
  MIN_SESSION_SEARCH_LENGTH,
  projectNameForHit,
  snippetParts,
  useSessionSearch
} from '../lib/session-search'
import '../styles/session-search.css'

const MIN_WIDTH = 200
const MAX_WIDTH = 460
const SESSION_PREVIEW_LIMIT = 5

/** True when a conversation matches the filter of the sidebar. */
function matches(session: SessionMeta, needle: string): boolean {
  if (!needle) return true
  return (
    (session.name ?? '').toLowerCase().includes(needle) ||
    session.preview.toLowerCase().includes(needle) ||
    session.cwd.toLowerCase().includes(needle)
  )
}

export function Sidebar({
  onOpenSettings,
  focusSearchSignal,
  width,
  open = true,
  onResize,
  onResizeEnd
}: {
  onOpenSettings: () => void
  focusSearchSignal: number
  width: number
  open?: boolean
  onResize?: (width: number) => void
  onResizeEnd?: (width: number) => void
}) {
  const sessions = useAppStore((state) => state.sessions)
  const workspace = useAppStore((state) => state.workspace)
  const activeSessionFile = useAppStore((state) => state.activeSessionFile)
  const status = useAppStore((state) => state.status)
  const threads = useAppStore((state) => state.threads)
  const settings = useAppStore((state) => state.settings)
  const openProjectDialog = useAppStore((state) => state.openProjectDialog)
  const pendingProject = useAppStore((state) => state.pendingProject)
  const selectSession = useAppStore((state) => state.selectSession)
  const stop = useAppStore((state) => state.stop)
  const stopSession = useAppStore((state) => state.stopSession)
  const newChat = useAppStore((state) => state.newChat)
  const removeWorkspace = useAppStore((state) => state.removeWorkspace)
  const renameSessionFile = useAppStore((state) => state.renameSessionFile)
  const deleteSession = useAppStore((state) => state.deleteSession)
  const togglePin = useAppStore((state) => state.togglePin)
  const openSearchHit = useAppStore((state) => state.openSearchHit)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const switchProject = useAppStore((state) => state.switchProject)
  const t = useT()

  const [query, setQuery] = useState('')
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set())
  const [expandedLists, setExpandedLists] = useState<Set<string>>(() => new Set())
  const [searchOpen, setSearchOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null)
  const [projectDraft, setProjectDraft] = useState('')
  const [pendingDelete, setPendingDelete] = useState<SessionMeta | null>(null)
  const [pendingRemove, setPendingRemove] = useState<{ id?: string; path: string; name: string } | null>(null)
  const [searchFocused, setSearchFocused] = useState(false)
  const [recentsOpen, setRecentsOpen] = useState(false)
  const [recentIndex, setRecentIndex] = useState(-1)
  const blurTimer = useRef<number | undefined>(undefined)
  const recentsRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  useEffect(() => {
    if (focusSearchSignal > 0) setSearchOpen(true)
  }, [focusSearchSignal])

  // The blur is delayed so a click on a recent search lands before the list
  // disappears; the timer must not outlive the sidebar.
  useEffect(
    () => () => {
      if (blurTimer.current) window.clearTimeout(blurTimer.current)
    },
    []
  )

  // Drag the right edge to make the sidebar wider or narrower.
  const widthRef = useRef(0)
  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!onResize) return
      event.preventDefault()
      const handle = event.currentTarget
      const panel = handle.parentElement
      const startX = event.clientX
      const startWidth = panel?.getBoundingClientRect().width ?? width
      widthRef.current = startWidth

      const move = (moveEvent: PointerEvent) => {
        const width = Math.max(
          MIN_WIDTH,
          Math.min(MAX_WIDTH, startWidth + (moveEvent.clientX - startX))
        )
        widthRef.current = width
        onResize(width)
      }
      const up = () => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', up)
        document.body.classList.remove('is-resizing')
        onResizeEnd?.(widthRef.current)
      }

      handle.setPointerCapture(event.pointerId)
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
      document.body.classList.add('is-resizing')
    },
    [onResize, onResizeEnd, width]
  )

  const resizeWithKeyboard = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!onResize) return

      let nextWidth: number
      switch (event.key) {
        case 'ArrowLeft':
          nextWidth = width - 16
          break
        case 'ArrowRight':
          nextWidth = width + 16
          break
        case 'Home':
          nextWidth = MIN_WIDTH
          break
        case 'End':
          nextWidth = MAX_WIDTH
          break
        default:
          return
      }

      event.preventDefault()
      widthRef.current = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, nextWidth))
      onResize(widthRef.current)
    },
    [onResize, width]
  )

  const finishKeyboardResize = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        widthRef.current > 0 &&
        ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
      ) {
        onResizeEnd?.(widthRef.current)
      }
    },
    [onResizeEnd]
  )

  const needle = query.trim().toLowerCase()

  // The input filters titles and projects at once; full text is a different,
  // slower question, so it is asked separately and debounced.
  const trimmedQuery = query.trim()
  const contentSearch = useSessionSearch(trimmedQuery, sessions.length > 0)
  const contentHits = contentSearch.hits
  const showContentSearch =
    sessions.length > 0 &&
    trimmedQuery.length >= MIN_SESSION_SEARCH_LENGTH &&
    contentSearch.status !== 'idle'

  // A query that found something is worth offering again. The list shows only
  // while the reader is in the field and has not started a real search.
  const recents = contentSearch.history
  const recentsVisible =
    searchFocused &&
    recentsOpen &&
    trimmedQuery.length === 0 &&
    recents.length > 0

  useEffect(() => {
    if (!recentsVisible || recentIndex < 0) return
    recentsRef.current
      ?.querySelector<HTMLElement>(`[data-recent-index="${recentIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [recentIndex, recentsVisible])

  const focusSearch = () => {
    if (blurTimer.current) window.clearTimeout(blurTimer.current)
    setSearchFocused(true)
    setRecentsOpen(true)
  }

  const leaveSearch = () => {
    if (blurTimer.current) window.clearTimeout(blurTimer.current)
    blurTimer.current = window.setTimeout(() => {
      setSearchFocused(false)
      setRecentIndex(-1)
    }, 120)
  }

  const pickRecent = (value: string) => {
    setQuery(value)
    setRecentIndex(-1)
  }

  const clearRecents = () => {
    contentSearch.clearHistory()
    setRecentIndex(-1)
  }

  const projects = useMemo(() => {
    const list = collectProjects(settings.workspaces, sessions, settings.hiddenProjects)
    if (!needle) return list
    for (const project of list) {
      project.sessions = project.sessions.filter((session) => matches(session, needle))
    }
    return list
  }, [settings.workspaces, settings.hiddenProjects, sessions, needle])

  const ordered = useMemo(() => sortProjects(projects), [projects])

  const pinned = useMemo(
    () => new Set(settings.pinnedSessions ?? []),
    [settings.pinnedSessions]
  )

  // Pinned conversations have their own group; every other conversation lives
  // beneath its project, even when another project is active.
  const groups = useMemo(
    () => ordered
      .map((project) => ({
        project,
        sessions: project.sessions.filter((session) => !pinned.has(session.file))
      }))
      .filter((group) => !needle || group.sessions.length > 0),
    [ordered, needle, pinned]
  )

  // Pinned conversations float to the top, out of the project they belong to.
  const pinnedSessions = useMemo(
    () => sessions.filter((session) => pinned.has(session.file) && matches(session, needle)),
    [sessions, pinned, needle]
  )

  const projectlessSessions = useMemo(
    () => sessions.filter((session) => !session.cwd && !pinned.has(session.file) && matches(session, needle)),
    [sessions, pinned, needle]
  )

  const openProject = async (project: Project) => {
    // A project row is a folder: it opens and closes the list of its
    // conversations. It never changes what Pi is running, so a conversation
    // in another project cannot be interrupted by looking at this one.
    setCollapsedProjects((current) => {
      const next = new Set(current)
      if (next.has(project.path)) next.delete(project.path)
      else next.add(project.path)
      return next
    })
  }

  const startRename = (file: string, current: string) => {
    setRenaming(file)
    setDraft(current)
  }

  const commitRename = (file: string) => {
    setRenaming(null)
    void renameSessionFile(file, draft)
  }

  const renderSessions = (items: SessionMeta[], showProject = false) =>
    items.map((session) => (
      <SessionRow
        key={session.file}
        session={session}
        active={session.file === activeSessionFile}
        running={Boolean(threads[session.file]?.isStreaming)}
        pinned={pinned.has(session.file)}
        renaming={renaming === session.file}
        draft={draft}
        project={showProject && session.cwd ? basename(session.cwd) : undefined}
        onSelect={(file) => {
          if (renaming === file) return
          if (file === activeSessionFile) return
          // Opening a conversation only changes the view. The one that is
          // running keeps its process.
          void selectSession(session)
        }}
        onStartRename={() =>
          startRename(session.file, session.name || session.preview || '')
        }
        onRenameDraft={setDraft}
        onCommitRename={commitRename}
        onCancelRename={() => setRenaming(null)}
        onDelete={() => setPendingDelete(session)}
        onStop={() => {
          if (session.file === activeSessionFile) void stop()
          else void stopSession(session.file)
        }}
        onTogglePin={() => {
          void togglePin(session.file).then(() => {
            requestAnimationFrame(() => {
              document.querySelector<HTMLButtonElement>(
                `.session-item[data-session-file="${CSS.escape(session.file)}"] .session-item__main`
              )?.focus()
            })
          })
        }}
      />
    ))

  // A hit opens the conversation and asks the thread to scroll to the message
  // it belongs to; the query comes along so the words stay marked.
  const openContentHit = (hit: SessionSearchHit) => {
    void openSearchHit(hit, trimmedQuery)
  }

  // A conversation can appear more than once — one row per matching message —
  // so the key pairs the file with the message index.
  const renderContentHits = (items: SessionSearchHit[]) =>
    items.map((hit) => {
      const parts = snippetParts(hit)
      const project = hit.cwd ? projectNameForHit(hit) : t('Chats without a project')
      return (
        <div
          key={`${hit.file}:${hit.messageIndex}`}
          className="session-search__hit"
          data-active={hit.file === activeSessionFile}
          role="button"
          tabIndex={0}
          title={hit.name || hit.preview || hit.file}
          onClick={() => openContentHit(hit)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            openContentHit(hit)
          }}
        >
          <span className="session-search__top">
            <span className="session-search__title">
              {hit.name || hit.preview || t('Untitled session')}
            </span>
            <span className="session-search__role" data-role={hit.role}>
              {hit.role === 'user' ? t('You') : t('Pi')}
            </span>
          </span>
          <span className="session-search__snippet">
            {parts.before}
            {parts.match ? <mark>{parts.match}</mark> : null}
            {parts.after}
          </span>
          <span className="session-search__meta">
            <span className="session-search__project">{project || t('Unknown location')}</span>
            <span className="session-search__time">
              {formatRelativeTime(hit.updatedAt, settings.language)}
            </span>
          </span>
        </div>
      )
    })

  return (
    <aside className="sidebar" inert={open ? undefined : true} aria-hidden={open ? undefined : true}>
      <div
        className="sidebar__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('Resize the sidebar')}
        aria-controls="sidebar-content"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={Math.round(width)}
        tabIndex={onResize ? 0 : -1}
        onPointerDown={startResize}
        onKeyDown={resizeWithKeyboard}
        onKeyUp={finishKeyboardResize}
      />
      <div className="sidebar__head drag-region">
        <div className="sidebar__brand no-drag" title="Pi Desktop">
          <PiLogo size={16} />
          <span>Pi Desktop</span>
        </div>
        <div className="sidebar__head-actions no-drag">
          <button
            className="sidebar__head-btn"
            aria-label={t('Filter conversations')}
            title={t('Filter conversations')}
            aria-expanded={searchOpen}
            aria-controls="sidebar-search"
            onClick={() => {
              setSearchOpen((open) => !open)
              setQuery('')
            }}
          >
            <Search size={16} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      <div className="sidebar__new-chat">
        <button
          className="btn-new-chat"
          disabled={status.phase === 'error' || (!workspace && status.phase === 'stopped')}
          onClick={() => void newChat()}
        >
          <span className="sidebar__compose-icon">
            <SquarePen size={14} strokeWidth={1.6} />
          </span>
          {t('New chat')}
        </button>
      </div>

      <div className="sidebar__body" id="sidebar-content">
        {searchOpen ? (
          <>
            <div className="sidebar__search" id="sidebar-search">
              <Search size={13} />
              <input
                ref={searchInputRef}
                value={query}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={recentsVisible}
                aria-controls={recentsVisible ? 'session-search-recents' : undefined}
                aria-activedescendant={
                  recentsVisible && recentIndex >= 0
                    ? `session-search-recent-${recentIndex}`
                    : undefined
                }
                aria-label={t('Filter conversations')}
                placeholder={t('Filter conversations')}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setRecentIndex(-1)
                }}
                onFocus={focusSearch}
                onBlur={leaveSearch}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    if (recentsVisible) {
                      setRecentsOpen(false)
                      setRecentIndex(-1)
                    } else {
                      setSearchOpen(false)
                      setQuery('')
                      document.querySelector<HTMLButtonElement>('.sidebar__head-btn[aria-controls="sidebar-search"]')?.focus()
                    }
                    return
                  }
                  if (!recentsVisible) return
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    setRecentIndex((current) => (current + 1) % recents.length)
                    return
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    setRecentIndex((current) => (current <= 0 ? recents.length - 1 : current - 1))
                    return
                  }
                  if (event.key === 'Enter') {
                    if (recentIndex < 0) return
                    event.preventDefault()
                    pickRecent(recents[recentIndex])
                    return
                  }
                }}
              />
              {query ? (
                <button
                  className="icon-btn"
                  onClick={() => {
                    setQuery('')
                    searchInputRef.current?.focus()
                  }}
                  title={t('Clear the filter')}
                  aria-label={t('Clear the filter')}
                >
                  <X size={11} />
                </button>
              ) : null}
            </div>

            {recentsVisible ? (
              <div
                className="session-search__recents"
              >
                <div className="session-search__recents-head">
                  <span>{t('Recent searches')}</span>
                  <button onMouseDown={(event) => event.preventDefault()} onClick={clearRecents}>
                    {t('Clear')}
                  </button>
                </div>
                <div
                  className="session-search__recents-list"
                  id="session-search-recents"
                  role="listbox"
                  aria-label={t('Recent searches')}
                  ref={recentsRef}
                >
                  {recents.map((entry, index) => (
                    <button
                      key={entry.toLowerCase()}
                      id={`session-search-recent-${index}`}
                      className="session-search__recent"
                      role="option"
                      aria-selected={index === recentIndex}
                      tabIndex={-1}
                      data-recent-index={index}
                      data-active={index === recentIndex || undefined}
                      title={entry}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => pickRecent(entry)}
                    >
                      <Clock size={11} />
                      <span className="session-search__recent-text">{entry}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {showContentSearch ? (
          <div className="sidebar__section session-search">
            <div className="sidebar__section-head">
              <span>{t('Matches in conversations')}</span>
              {contentHits.length > 0 ? (
                <span className="session-search__count">{contentHits.length}</span>
              ) : null}
            </div>
            {contentSearch.status === 'searching' ? (
              <div className="session-search__state">{t('Searching…')}</div>
            ) : contentHits.length > 0 ? (
              <div className="session-list">{renderContentHits(contentHits)}</div>
            ) : (
              <div className="session-search__state">
                {t('No matches in conversation text')}
              </div>
            )}
          </div>
        ) : null}

        {pinnedSessions.length > 0 ? (
          <div className="sidebar__section">
            <div className="sidebar__section-head">
              <span>{t('Pinned')}</span>
            </div>
            <div className="session-list">{renderSessions(pinnedSessions, true)}</div>
          </div>
        ) : null}

        {projectlessSessions.length > 0 ? (
          <div className="sidebar__section">
            <div className="sidebar__section-head">
              <span>{t('Chats without a project')}</span>
            </div>
            <div className="session-list">{renderSessions(projectlessSessions)}</div>
          </div>
        ) : null}

        <div className="sidebar__section sidebar__projects">
          <div className="sidebar__section-head">
            <span>{t('Projects')}</span>
            <button
              aria-label={t('New project')}
              title={t('New project')}
              onClick={() => openProjectDialog({ mode: 'create' })}
            >
              <Plus size={15} strokeWidth={1.5} />
            </button>
          </div>

          {ordered.length === 0 ? (
            <div className="sidebar__empty">{t('No project selected yet.')}</div>
          ) : (
            <div className="project-tree">
              {groups.map(({ project, sessions: projectSessions }) => {
                const projectId = project.id
                const active = Boolean(workspace && samePath(workspace.path, project.path))
                const expanded = Boolean(needle) || !collapsedProjects.has(project.path)
                const showAll = Boolean(needle) || expandedLists.has(project.path)
                const visibleCount = showAll
                  ? projectSessions.length
                  : Math.max(
                      SESSION_PREVIEW_LIMIT,
                      projectSessions.findIndex((session) => session.file === activeSessionFile) + 1
                    )
                return (
                  <div
                    className="project"
                    key={project.path || 'unknown'}
                    data-active={active}
                    data-expanded={expanded}
                    data-pending={
                      pendingProject?.path != null
                        ? samePath(pendingProject.path, project.path)
                        : undefined
                    }
                  >
                    <div className="project__row">
                      <button
                        className="project__main"
                        type="button"
                        title={project.path}
                        aria-expanded={expanded}
                        onClick={() => void openProject(project)}
                      >
                        <span className="project__icon">
                          {expanded && projectSessions.length > 0 ? (
                            <FolderOpen size={16} strokeWidth={1.5} />
                          ) : (
                            <Folder size={15} strokeWidth={1.5} />
                          )}
                        </span>
                        <span className="project__text">
                          {renamingProjectId === projectId ? (
                            <input
                              className="project__rename-input"
                              autoFocus
                              value={projectDraft}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setProjectDraft(e.target.value)}
                              onKeyDown={async (e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  const trimmed = projectDraft.trim()
                                  if (trimmed && projectId) {
                                    const workspaces = (await window.pi.settings.get()).workspaces
                                    const updated = workspaces.map((w) =>
                                      w.id === projectId ? { ...w, name: trimmed } : w
                                    )
                                    await updateSettings({ workspaces: updated })
                                    if (workspace?.id === projectId) {
                                      useAppStore.setState({ workspace: { ...workspace, name: trimmed } })
                                    }
                                  }
                                  setRenamingProjectId(null)
                                } else if (e.key === 'Escape') {
                                  setRenamingProjectId(null)
                                }
                              }}
                              onBlur={async () => {
                                const trimmed = projectDraft.trim()
                                if (trimmed && projectId && trimmed !== project.name) {
                                  const workspaces = (await window.pi.settings.get()).workspaces
                                  const updated = workspaces.map((w) =>
                                    w.id === projectId ? { ...w, name: trimmed } : w
                                  )
                                  await updateSettings({ workspaces: updated })
                                  if (workspace?.id === projectId) {
                                    useAppStore.setState({ workspace: { ...workspace, name: trimmed } })
                                  }
                                }
                                setRenamingProjectId(null)
                              }}
                            />
                          ) : (
                            <span className="project__name">{project.name}</span>
                          )}
                        </span>
                      </button>

                      <div className="project__actions">
                        <Popover
                          placement="bottom"
                          align="right"
                          className="project-actions-menu"
                          renderTrigger={({ open, toggle }) => (
                            <button
                              className="icon-btn project__action-btn"
                              aria-label={t('Project actions')}
                              title={t('Project actions')}
                              data-active={open}
                              onClick={(e) => {
                                e.stopPropagation()
                                toggle(e)
                              }}
                            >
                              <Ellipsis size={13} />
                            </button>
                          )}
                        >
                          {(close) => (
                            <div className="project-action-menu" role="menu">
                              {project.registered && projectId ? (
                                <button
                                  className="popover__item"
                                  type="button"
                                  role="menuitem"
                                  onClick={() => {
                                    close()
                                    setProjectDraft(project.name)
                                    setRenamingProjectId(projectId)
                                  }}
                                >
                                  <Pencil size={13} />
                                  <span>{t('Rename')}</span>
                                </button>
                              ) : null}
                              <button
                                className="popover__item"
                                type="button"
                                role="menuitem"
                                onClick={async () => {
                                  close()
                                  if (!workspace || !samePath(workspace.path, project.path)) {
                                    await switchProject(project.path, { allowWhileRunning: true })
                                  }
                                  void window.pi.shell.openInExplorer(project.path)
                                }}
                              >
                                <FolderOpen size={13} />
                                <span>{t('Open project')}</span>
                              </button>
                              <button
                                className="popover__item"
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  close()
                                  openProjectDialog({ mode: 'edit', project })
                                }}
                              >
                                <FolderEdit size={13} />
                                <span>{t('Edit project')}</span>
                              </button>
                              <div className="popover__divider" />
                              <button
                                className="popover__item popover__item--danger"
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  close()
                                  setPendingRemove({ id: projectId, path: project.path, name: project.name })
                                }}
                              >
                                <Trash2 size={13} />
                                <span>{t('Remove project')}</span>
                              </button>
                            </div>
                          )}
                        </Popover>

                        <button
                          className="icon-btn project__action-btn project__action-btn--new-chat"
                          aria-label={t('New chat in this project')}
                          title={t('New chat in this project')}
                          onClick={async (e) => {
                            e.stopPropagation()
                            if (!workspace || !samePath(workspace.path, project.path)) {
                              await switchProject(project.path, { allowWhileRunning: true })
                            }
                            await newChat()
                          }}
                        >
                          <SquarePen size={13} strokeWidth={1.6} />
                        </button>
                      </div>
                    </div>
                    {expanded ? (
                      <div className="session-list">
                        {renderSessions(projectSessions.slice(0, visibleCount))}
                        {!needle &&
                        projectSessions.length > SESSION_PREVIEW_LIMIT &&
                        (showAll || projectSessions.length > visibleCount) ? (
                          <button
                            className="project__show-more"
                            aria-expanded={showAll}
                            onClick={() => setExpandedLists((current) => {
                              const next = new Set(current)
                              if (next.has(project.path)) next.delete(project.path)
                              else next.add(project.path)
                              return next
                            })}
                          >
                            {showAll ? t('Show less') : t('Show more')}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {sessions.length > 0 &&
        needle &&
        groups.length === 0 &&
        pinnedSessions.length === 0 &&
        // The text search has its own empty state.
        !showContentSearch ? (
          <div className="sidebar__section">
            <div className="sidebar__empty">{t('No conversation matches')} “{query}”.</div>
          </div>
        ) : null}
      </div>

      <div className="sidebar__foot">
        <button
          type="button"
          className="sidebar__foot-btn"
          onClick={onOpenSettings}
          title={t('Settings')}
        >
          <Settings size={15} strokeWidth={1.6} />
          <span>{t('Settings')}</span>
        </button>
      </div>

      {pendingRemove ? (
        <ConfirmDialog
          title={t('Remove project')}
          body={
            settings.language === 'zh-CN'
              ? `要从列表中移除“${pendingRemove.name}”吗？文件夹和已有对话都会保留，只是不再显示在项目列表里。`
              : `Remove “${pendingRemove.name}” from the list? The folder and its conversations stay on disk.`
          }
          confirmLabel="Remove project"
          tone="danger"
          onCancel={() => setPendingRemove(null)}
          onConfirm={() => {
            const target = pendingRemove
            setPendingRemove(null)
            void removeWorkspace({ id: target.id, path: target.path })
          }}
        />
      ) : null}
      {pendingDelete ? (
        <ConfirmDialog
          title={t('Delete conversation')}
          body={
            settings.language === 'zh-CN'
              ? `“${pendingDelete.name || pendingDelete.preview || '未命名会话'}”将移至系统回收站。此操作无法在 Pi Desktop 中撤销。`
              : `“${pendingDelete.name || pendingDelete.preview || 'Untitled session'}” will be moved to the system trash. This cannot be undone from inside Pi Desktop.`
          }
          confirmLabel={t('Delete')}
          tone="danger"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const target = pendingDelete
            setPendingDelete(null)
            void deleteSession(target.file)
          }}
        />
      ) : null}
    </aside>
  )
}

interface SessionRowProps {
  session: SessionMeta
  active: boolean
  running: boolean
  pinned: boolean
  renaming: boolean
  draft: string
  /** The project the conversation belongs to, when it is pinned. */
  project?: string
  onSelect: (file: string) => void
  onStartRename: () => void
  onRenameDraft: (value: string) => void
  onCommitRename: (file: string) => void
  onCancelRename: () => void
  onDelete: () => void
  onStop: () => void
  onTogglePin: () => void
}

function SessionRow({
  session,
  active,
  running,
  pinned,
  renaming,
  draft,
  project,
  onSelect,
  onStartRename,
  onRenameDraft,
  onCommitRename,
  onCancelRename,
  onDelete,
  onStop,
  onTogglePin
}: SessionRowProps) {
  const t = useT()
  const mainRef = useRef<HTMLButtonElement>(null)
  const focusMenuItem = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return
    requestAnimationFrame(() => {
      if (button.isConnected) button.focus()
    })
  }, [])
  const title = session.name || session.preview || t('Untitled session')
  return (
    <div
      className="session-item"
      data-active={active}
      data-session-file={session.file}
    >
      {renaming ? (
        <input
          className="session-item__input"
          value={draft}
          aria-label={t('Rename conversation')}
          autoFocus
          onChange={(event) => onRenameDraft(event.target.value)}
          onBlur={() => onCommitRename(session.file)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onCommitRename(session.file)
              requestAnimationFrame(() => mainRef.current?.focus())
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              onCancelRename()
              requestAnimationFrame(() => mainRef.current?.focus())
            }
          }}
        />
      ) : (
        <button
          ref={mainRef}
          type="button"
          className="session-item__main"
          onClick={() => onSelect(session.file)}
          title={project ? `${project} · ${title}` : title}
          aria-current={active ? 'page' : undefined}
        >
          {running ? (
            <span className="session-item__status" role="status" aria-label={t('running')}>
              <Loader2 size={12} strokeWidth={1.5} className="spin" />
            </span>
          ) : null}
          <span className="session-item__title">{title}</span>
        </button>
      )}
      {pinned ? (
        <span className="session-item__activity" aria-label={t('Pinned')}>
          <Pin size={11} />
        </span>
      ) : null}
      {!renaming ? (
        <div className="session-item__actions">
          <Popover
            align="right"
            width={188}
            className="session-actions-menu"
            renderTrigger={({ open, toggle }) => (
              <button
                type="button"
                className="session-item__more"
                aria-label={t('More actions')}
                title={t('More actions')}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={toggle}
              >
                <Ellipsis size={14} strokeWidth={1.5} />
              </button>
            )}
          >
            {(close) => (
              <div role="menu" aria-label={t('More actions')}>
                <button
                  ref={focusMenuItem}
                  type="button"
                  className="popover__item"
                  role="menuitem"
                  onClick={() => {
                    close()
                    onTogglePin()
                  }}
                >
                  <Pin size={12} />
                  {pinned ? t('Unpin conversation') : t('Pin conversation to the top')}
                </button>
                {running ? (
                  <button
                    type="button"
                    className="popover__item"
                    role="menuitem"
                    onClick={() => {
                      close()
                      onStop()
                    }}
                  >
                    <Square size={12} />
                    {t('Stop this conversation')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="popover__item"
                  role="menuitem"
                  onClick={() => {
                    close()
                    onStartRename()
                  }}
                >
                  <Pencil size={12} />
                  {t('Rename conversation')}
                </button>
                <button
                  type="button"
                  className="popover__item popover__item--danger"
                  role="menuitem"
                  onClick={() => {
                    close()
                    onDelete()
                  }}
                >
                  <Trash2 size={12} />
                  {t('Delete conversation')}
                </button>
              </div>
            )}
          </Popover>
        </div>
      ) : null}
    </div>
  )
}
