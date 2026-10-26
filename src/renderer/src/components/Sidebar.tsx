import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bell,
  ChevronDown,
  Clock,
  Ellipsis,
  Folder,
  FolderOpen,
  Loader2,
  Pencil,
  Pin,
  Plus,
  Search,
  Settings,
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
  onResize,
  onResizeEnd
}: {
  onOpenSettings: () => void
  focusSearchSignal: number
  width: number
  onResize?: (width: number) => void
  onResizeEnd?: (width: number) => void
}) {
  const sessions = useAppStore((state) => state.sessions)
  const workspace = useAppStore((state) => state.workspace)
  const activeSessionFile = useAppStore((state) => state.activeSessionFile)
  const status = useAppStore((state) => state.status)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const error = useAppStore((state) => state.error)
  const toast = useAppStore((state) => state.toast)
  const settings = useAppStore((state) => state.settings)
  const pickWorkspace = useAppStore((state) => state.pickWorkspace)
  const pendingProject = useAppStore((state) => state.pendingProject)
  const selectSession = useAppStore((state) => state.selectSession)
  const newChat = useAppStore((state) => state.newChat)
  const removeWorkspace = useAppStore((state) => state.removeWorkspace)
  const renameSessionFile = useAppStore((state) => state.renameSessionFile)
  const deleteSession = useAppStore((state) => state.deleteSession)
  const togglePin = useAppStore((state) => state.togglePin)
  const openSearchHit = useAppStore((state) => state.openSearchHit)
  const t = useT()

  const [query, setQuery] = useState('')
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set())
  const [expandedLists, setExpandedLists] = useState<Set<string>>(() => new Set())
  const [searchOpen, setSearchOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [pendingDelete, setPendingDelete] = useState<SessionMeta | null>(null)
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
    const list = collectProjects(settings.workspaces, sessions)
    if (!needle) return list
    for (const project of list) {
      project.sessions = project.sessions.filter((session) => matches(session, needle))
    }
    return list
  }, [settings.workspaces, sessions, needle])

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
        running={session.file === activeSessionFile && isStreaming}
        pinned={pinned.has(session.file)}
        renaming={renaming === session.file}
        draft={draft}
        project={showProject && session.cwd ? basename(session.cwd) : undefined}
        onSelect={(file) => {
          if (renaming === file) return
          // Opening another conversation replaces the one Pi is running in.
          // Stopping is the user's decision, not a side effect of a click.
          if (isStreaming && file !== activeSessionFile) {
            window.dispatchEvent(
              new CustomEvent('pi:confirm-switch-session', {
                detail: { file, title: session.name || session.preview || t('Untitled session') }
              })
            )
            return
          }
          void selectSession(session)
        }}
        onStartRename={() =>
          startRename(session.file, session.name || session.preview || '')
        }
        onRenameDraft={setDraft}
        onCommitRename={commitRename}
        onCancelRename={() => setRenaming(null)}
        onDelete={() => setPendingDelete(session)}
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
      const project = projectNameForHit(hit)
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
    <aside className="sidebar">
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
        <Popover
          className="sidebar__menu"
          renderTrigger={({ open, toggle }) => (
            <button
              className="sidebar__brand no-drag"
              aria-label={t('Application menu')}
              aria-expanded={open}
              onClick={toggle}
            >
              <span>Pi Desktop</span>
              <ChevronDown size={12} strokeWidth={1.5} />
            </button>
          )}
        >
          {(close) => (
            <>
              <button
                className="popover__item"
                onClick={() => {
                  close()
                  onOpenSettings()
                }}
              >
                <Settings size={15} />
                {t('Settings')}
              </button>
              <button
                className="popover__item"
                onClick={() => {
                  close()
                  void pickWorkspace()
                }}
              >
                <FolderOpen size={15} />
                {t('Open a folder')}
              </button>
            </>
          )}
        </Popover>
        <div className="sidebar__head-actions no-drag">
          <Popover
            align="right"
            className="sidebar__notifications"
            renderTrigger={({ open, toggle }) => (
              <button
                className="sidebar__head-btn"
                aria-label={t('Notifications')}
                title={t('Notifications')}
                aria-expanded={open}
                data-unread={Boolean(error || toast)}
                onClick={toggle}
              >
                <Bell size={16} strokeWidth={1.5} />
              </button>
            )}
          >
            {() => (
              <>
                <div className="popover__label">{t('Notifications')}</div>
                <div className="runtime-chip" data-phase={status.phase}>
                  <span className="runtime-chip__dot" />
                  <span>
                    {status.phase === 'ready'
                      ? t('Pi connected')
                      : status.phase === 'starting'
                        ? t('Starting Pi…')
                        : status.phase === 'error'
                          ? t('Pi unavailable')
                          : t('Pi stopped')}
                  </span>
                </div>
                <div className="sidebar__notice">
                  {error || toast?.text || t('No new notifications')}
                </div>
              </>
            )}
          </Popover>
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
          disabled={status.phase !== 'ready'}
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

        <div className="sidebar__section sidebar__projects">
          <div className="sidebar__section-head">
            <span>{t('Projects')}</span>
            <button
              aria-label={t('Open a folder')}
              title={t('Open a folder')}
              onClick={() => void pickWorkspace()}
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
                      pendingProject
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
                          <span className="project__name">{project.name}</span>
                        </span>
                        <span className="project__caret">
                          <ChevronDown size={13} strokeWidth={1.8} />
                        </span>
                      </button>
                      {project.registered && projectId ? (
                        <button
                          className="project__remove"
                          aria-label={t('Remove project')}
                          title={t('Remove project')}
                          onClick={() => void removeWorkspace(projectId)}
                        >
                          <Trash2 size={12} />
                        </button>
                      ) : null}
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
          <span className="session-item__title">{title}</span>
        </button>
      )}
      {running || pinned ? (
        <span
          className="session-item__activity"
          role={running ? 'status' : undefined}
          aria-label={running ? t('running') : t('Pinned')}
        >
          {running ? (
            <Loader2 size={12} strokeWidth={1.5} className="spin" />
          ) : (
            <Pin size={11} />
          )}
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
