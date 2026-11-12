import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Clock,
  Ellipsis,
  Folder,
  FolderEdit,
  FolderOpen,
  Loader2,
  Pencil,
  Pin,
  Plus,
  Puzzle,
  Search,
  Settings,
  Smile,
  Square,
  SquarePen,
  Trash2,
  X
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store/useAppStore'
import { MAX_SEARCH_QUERY_LENGTH } from '@shared/types'
import type { ProjectIconColor, SessionMeta, SessionSearchHit, Workspace } from '@shared/types'
import { formatDateTime, formatRelativeTime } from '../lib/format'
import { normalisePathKey, samePath } from '../lib/path'
import { collectProjects, sortProjects, type Project } from '../lib/projects'
import { liveConversationRows, streamingProjectPaths, type ConversationRow } from '../lib/live-sessions'
import { basename } from '../lib/path'
import { ConfirmDialog } from './ConfirmDialog'
import { Popover } from './Popover'
import { SidebarTip, SIDEBAR_TIP_ID, useHoverTip, type SidebarTipRow } from './SidebarTip'
import { PiLogo } from './PiLogo'
import { ProjectIconPicker } from './ProjectIconPicker'
import { projectIconColor, projectIconEmoji } from '../lib/project-icons'
import { sessionIndicator, isDotIndicator, type SessionIndicator } from '../lib/session-indicator'
import { needsSessionHydration } from '../lib/session-scope'
import { useT } from '../lib/i18n'
import {
  MIN_SESSION_SEARCH_LENGTH,
  projectNameForHit,
  snippetParts,
  useSessionSearch
} from '../lib/session-search'
import '../styles/session-search.css'
import '../styles/sidebar-tip.css'
import '../styles/sidebar-workspace.css'

const MIN_WIDTH = 200
const MAX_WIDTH = 460
const SESSION_PREVIEW_LIMIT = 5
const INITIAL_CONVERSATION_SEARCH_RESULTS = 50
const CONVERSATION_SEARCH_RESULTS_PAGE = 50

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
  onOpenPlugins,
  onOpenScheduledTasks,
  focusSearchSignal,
  width,
  open = true,
  onResize,
  onResizeEnd
}: {
  onOpenSettings: () => void
  onOpenPlugins: () => void
  onOpenScheduledTasks: () => void
  focusSearchSignal: number
  width: number
  open?: boolean
  onResize?: (width: number) => void
  onResizeEnd?: (width: number) => void
}) {
  const sessions = useAppStore((state) => state.sessions)
  const workspace = useAppStore((state) => state.workspace)
  const activeSessionFile = useAppStore((state) => state.activeSessionFile)
  const draftId = useAppStore((state) => state.draftId)
  const status = useAppStore((state) => state.status)
  const liveRows = useAppStore(
    useShallow((state) =>
      liveConversationRows(state.sessions, state.threads, state.workspace?.path)
    )
  )
  const settings = useAppStore((state) => state.settings)
  // A folded project hides the running mark of its conversations. Track each
  // running thread by its own working directory so drafts, pinned and archived
  // conversations still mark their project.
  const runningProjectPaths = useAppStore(
    useShallow((state) =>
      streamingProjectPaths(state.sessions, state.threads, state.draftId, state.workspace?.path)
    )
  )
  const archivedFiles = useMemo(
    () => new Set(settings.archivedSessions ?? []),
    [settings.archivedSessions]
  )
  const openProjectDialog = useAppStore((state) => state.openProjectDialog)
  const pendingProject = useAppStore((state) => state.pendingProject)
  const selectSession = useAppStore((state) => state.selectSession)
  const deskPage = useAppStore((state) => state.deskPage)
  const stop = useAppStore((state) => state.stop)
  const stopSession = useAppStore((state) => state.stopSession)
  const newChat = useAppStore((state) => state.newChat)
  const removeWorkspace = useAppStore((state) => state.removeWorkspace)
  const renameSessionFile = useAppStore((state) => state.renameSessionFile)
  const deleteSession = useAppStore((state) => state.deleteSession)
  const archiveSession = useAppStore((state) => state.archiveSession)
  const togglePin = useAppStore((state) => state.togglePin)
  const openSearchHit = useAppStore((state) => state.openSearchHit)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const switchProject = useAppStore((state) => state.switchProject)
  const t = useT()

  const [query, setQuery] = useState('')
  const [conversationSearchWindow, setConversationSearchWindow] = useState({
    needle: '',
    count: INITIAL_CONVERSATION_SEARCH_RESULTS
  })
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set())
  const [expandedLists, setExpandedLists] = useState<Set<string>>(() => new Set())
  const [searchOpen, setSearchOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchTriggerRef = useRef<HTMLButtonElement>(null)
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
  // One card serves the whole project list: only one row can be hovered.
  const projectTip = useHoverTip<SidebarTipRow[]>()

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

  const trimmedQuery = query.trim()
  const searchNeedle = trimmedQuery.toLowerCase()
  const needle = searchOpen ? '' : searchNeedle

  // The input filters titles and projects at once; full text is a different,
  // slower question, so it is asked separately and debounced.
  const contentSearch = useSessionSearch(trimmedQuery, sessions.length > 0)
  // Archived conversations are hidden from every list, including full-text hits.
  const contentHits = contentSearch.hits.filter((hit) => !archivedFiles.has(hit.file))
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

  // The list the reader sees is the conversations on disk plus the ones the
  // store already holds but disk does not cover yet — a prompt still on its
  // way to Pi, or a conversation waiting behind another run in the same
  // folder. Those are missing from `sessions` for exactly the window in which
  // the reader is looking for them.
  const diskRows = useMemo(
    () => sessions.map((session) => ({ ...session, onDisk: true })),
    [sessions]
  )
  const listed = useMemo(
    () => [...liveRows, ...diskRows].filter((session) => !archivedFiles.has(session.file)),
    [liveRows, diskRows, archivedFiles]
  )

  const projects = useMemo(() => {
    const list = collectProjects(
      settings.workspaces,
      listed,
      settings.hiddenProjects,
      settings.projectOrder
    )
    if (!needle) return list
    for (const project of list) {
      project.sessions = project.sessions.filter((session) => matches(session, needle))
    }
    return list
  }, [settings.workspaces, settings.hiddenProjects, settings.projectOrder, listed, needle])

  // Folders first seen through a session become rows without being registered.
  // Give each one a place in the order now, so opening it later cannot move it
  // into the registered block.
  useEffect(() => {
    const order = settings.projectOrder ?? []
    if (projects.length === 0) return
    const known = new Set(order.map((path) => normalisePathKey(path)))
    const missing = projects
      .filter((project) => project.path && !known.has(normalisePathKey(project.path)))
      .map((project) => project.path)
    if (missing.length > 0) void updateSettings({ projectOrder: [...order, ...missing] })
  }, [projects, settings.projectOrder, updateSettings])

  const ordered = useMemo(() => sortProjects(projects), [projects])
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null)
  const [draggingPath, setDraggingPath] = useState<string | null>(null)
  const [dropLineTop, setDropLineTop] = useState<number | null>(null)
  const dragPath = useRef<string | null>(null)
  const suppressClick = useRef(false)
  const orderRef = useRef<Project<ConversationRow>[] | null>(null)
  const shown = useMemo(() => {
    if (!orderOverride) return ordered
    const byKey = new Map(ordered.map((project) => [normalisePathKey(project.path), project]))
    const next: Project<ConversationRow>[] = []
    for (const key of orderOverride) {
      const project = byKey.get(key)
      if (project) next.push(project)
    }
    for (const project of ordered) {
      if (!next.some((item) => samePath(item.path, project.path))) next.push(project)
    }
    return next
  }, [ordered, orderOverride])
  // Pointer handlers live for the duration of a drag; they must read the list
  // as it is now, not the one captured when the press started.
  const shownRef = useRef(shown)
  useEffect(() => {
    shownRef.current = shown
  }, [shown])

  const pinned = useMemo(
    () => new Set(settings.pinnedSessions ?? []),
    [settings.pinnedSessions]
  )

  const runningProjectKeys = useMemo(
    () => new Set(runningProjectPaths),
    [runningProjectPaths]
  )

  // Pinned conversations have their own group; every other conversation lives
  // beneath its project, even when another project is active.
  const groups = useMemo(
    () => shown
      .map((project) => ({
        project,
        sessions: project.sessions.filter((session) => !pinned.has(session.file))
      }))
      .filter((group) => !needle || group.sessions.length > 0),
    [shown, needle, pinned]
  )

  // Pinned conversations float to the top, out of the project they belong to.
  const pinnedSessions = useMemo(
    () => listed.filter((session) => pinned.has(session.file) && matches(session, needle)),
    [listed, pinned, needle]
  )

  const projectlessSessions = useMemo(
    () => listed.filter((session) => !session.cwd && !pinned.has(session.file) && matches(session, needle)),
    [listed, pinned, needle]
  )

  const projectSearchResults = useMemo(
    () => shown.filter((project) => !searchNeedle || `${project.name}\n${project.path}`.toLowerCase().includes(searchNeedle)),
    [shown, searchNeedle]
  )
  const conversationSearchCount = conversationSearchWindow.needle === searchNeedle
    ? conversationSearchWindow.count
    : INITIAL_CONVERSATION_SEARCH_RESULTS
  const conversationSearchMatches = useMemo(() => {
    const results: ConversationRow[] = []
    let liveIndex = 0
    let diskIndex = 0

    // Both inputs are newest-first, and liveRows excludes sessions already on
    // disk. Cache the merged matches so expanding a page does not rescan them.
    while (liveIndex < liveRows.length || diskIndex < diskRows.length) {
      const live = liveRows[liveIndex]
      const disk = diskRows[diskIndex]
      const session = !disk || (live && live.updatedAt >= disk.updatedAt) ? live : disk
      if (!session) break
      if (session === live) liveIndex += 1
      else diskIndex += 1

      if (archivedFiles.has(session.file) || !matches(session, searchNeedle)) continue
      results.push(session)
    }

    return results
  }, [liveRows, diskRows, archivedFiles, searchNeedle])
  const conversationSearchResults = conversationSearchMatches.slice(0, conversationSearchCount)

  const persistOrder = async (next: Project<ConversationRow>[]) => {
    const current = (await window.pi.settings.get()).workspaces
    const byKey = new Map(current.map((item) => [normalisePathKey(item.path), item]))
    const rebuilt: Workspace[] = []
    for (const project of next) {
      const known = byKey.get(normalisePathKey(project.path))
      if (known) rebuilt.push(known)
      else if (project.path) {
        rebuilt.push({
          id: crypto.randomUUID(),
          path: project.path,
          name: project.name,
          lastOpenedAt: 0
        })
      }
    }
    for (const item of current) {
      if (!rebuilt.some((entry) => entry.id === item.id)) rebuilt.push(item)
    }
    await updateSettings({
      workspaces: rebuilt,
      projectOrder: next.map((project) => project.path)
    })
  }

  /** Move a project one row up or down from its action menu. */
  const moveProject = (project: Project<ConversationRow>, delta: number) => {
    const list = shownRef.current
    const from = list.findIndex((item) => samePath(item.path, project.path))
    const to = from + delta
    if (from < 0 || to < 0 || to >= list.length) return
    const next = list.slice()
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    setOrderOverride(next.map((entry) => normalisePathKey(entry.path)))
    void persistOrder(next).finally(() => setOrderOverride(null))
  }

  // The icon belongs to the project, not to the conversation list, so it is
  // stored with the workspace. A folder that is not registered yet has
  // nowhere to keep it.
  const setProjectIcon = async (
    project: Project<ConversationRow>,
    icon: string | undefined,
    iconColor: ProjectIconColor
  ) => {
    if (!project.id) return
    const workspaces = (await window.pi.settings.get()).workspaces
    const updated = workspaces.map((item) =>
      item.id === project.id ? { ...item, icon: icon || undefined, iconColor } : item
    )
    await updateSettings({ workspaces: updated })
    if (workspace?.id === project.id) {
      useAppStore.setState({ workspace: { ...workspace, icon: icon || undefined, iconColor } })
    }
  }

  // Dragging starts as soon as the pointer travels a few pixels. The row is a
  // button, so a plain click still folds the list; only a real move starts the
  // drag and suppresses the click that follows.
  const onProjectPointerDown = (
    project: Project<ConversationRow>,
    event: React.PointerEvent<HTMLButtonElement>
  ) => {
    if (event.button !== 0 || needle) return
    // Renaming happens in an input inside the row; selecting its text is not a
    // drag.
    if ((event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return

    const handle = event.currentTarget
    const pointerId = event.pointerId
    try {
      handle.setPointerCapture(pointerId)
    } catch {
      /* pointer capture is best-effort */
    }
    const startX = event.clientX
    const startY = event.clientY
    const tree = event.currentTarget.closest<HTMLElement>('.project-tree')
    const scroller = document.getElementById('sidebar-content')
    let pointerX = startX
    let pointerY = startY
    let started = false
    let frame = 0

    const listWithoutDragged = (): Project<ConversationRow>[] => {
      const dragging = dragPath.current
      if (!dragging) return shownRef.current
      return shownRef.current.filter((item) => !samePath(item.path, dragging))
    }

    // The line is measured against the tree rather than the scroller, so the
    // same number works while the list scrolls under the pointer.
    const placeDrop = () => {
      const dragging = dragPath.current
      if (!dragging || !tree) return
      const items = listWithoutDragged()
      const treeTop = tree.getBoundingClientRect().top
      const rows = Array.from(tree.children).filter(
        (node): node is HTMLElement =>
          node instanceof HTMLElement && node.classList.contains('project')
      )
      let insertAt = items.length
      let lineTop: number | null = null

      for (const row of rows) {
        const path = row.dataset.path
        if (!path || samePath(path, dragging)) continue
        const head = row.querySelector<HTMLElement>('.project__row') ?? row
        const box = head.getBoundingClientRect()
        if (pointerY < box.top + box.height / 2) {
          const index = items.findIndex((item) => samePath(item.path, path))
          if (index >= 0) insertAt = index
          lineTop = box.top - treeTop
          break
        }
      }
      if (lineTop === null) {
        const lastProject = [...rows]
          .reverse()
          .find((row) => Boolean(row.dataset.path) && !samePath(row.dataset.path!, dragging))
        // The drop lands after the whole project block, conversations included,
        // so the indicator belongs below the block rather than under its header.
        lineTop = lastProject ? lastProject.getBoundingClientRect().bottom - treeTop : 0
      }

      const dragged = shownRef.current.find((item) => samePath(item.path, dragging))
      if (!dragged) return
      const next = items.slice()
      next.splice(insertAt, 0, dragged)
      orderRef.current = next
      setDropLineTop(lineTop)
    }

    const scrollWhileDragging = () => {
      if (!started || !dragPath.current) return
      if (scroller) {
        const box = scroller.getBoundingClientRect()
        if (pointerX >= box.left && pointerX <= box.right) {
          const edge = 44
          const distance =
            pointerY < box.top + edge
              ? pointerY - (box.top + edge)
              : pointerY > box.bottom - edge
                ? pointerY - (box.bottom - edge)
                : 0
          if (distance !== 0) {
            const before = scroller.scrollTop
            const delta = Math.max(-18, Math.min(18, distance / 2))
            scroller.scrollTop = before + delta
            if (scroller.scrollTop !== before) placeDrop()
          }
        }
      }
      frame = window.requestAnimationFrame(scrollWhileDragging)
    }

    const move = (moveEvent: PointerEvent) => {
      pointerX = moveEvent.clientX
      pointerY = moveEvent.clientY
      if (!started) {
        if (Math.hypot(pointerX - startX, pointerY - startY) < 4) return
        started = true
        dragPath.current = project.path
        orderRef.current = shownRef.current
        suppressClick.current = true
        setDraggingPath(project.path)
        document.body.classList.add('is-project-dragging')
        frame = window.requestAnimationFrame(scrollWhileDragging)
      }
      placeDrop()
    }

    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      handle.removeEventListener('lostpointercapture', lost)
      try {
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      } catch {
        /* pointer capture may already be gone */
      }
      if (frame) window.cancelAnimationFrame(frame)
      document.body.classList.remove('is-project-dragging')
      const next = orderRef.current
      const wasDragging = started
      dragPath.current = null
      orderRef.current = null
      setDraggingPath(null)
      setDropLineTop(null)
      if (wasDragging) {
        // The click that follows pointerup would otherwise fold the row.
        window.setTimeout(() => {
          suppressClick.current = false
        }, 0)
      }
      if (!commit || !wasDragging || !next) return
      const before = shownRef.current.map((item) => normalisePathKey(item.path)).join('\n')
      const after = next.map((item) => normalisePathKey(item.path)).join('\n')
      if (before === after) return
      setOrderOverride(next.map((item) => normalisePathKey(item.path)))
      void persistOrder(next).finally(() => setOrderOverride(null))
    }
    const up = () => finish(true)
    const cancel = () => finish(false)
    const lost = () => finish(false)

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    handle.addEventListener('lostpointercapture', lost)
  }

  const openProject = async (project: Project<ConversationRow>) => {
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

  const renderSessions = (items: ConversationRow[], showProject = false) =>
    items.map((session) => (
      <SessionRowItem
        key={session.file}
        session={session}
        active={session.file === (activeSessionFile ?? draftId)}
        pinned={pinned.has(session.file)}
        renaming={renaming === session.file}
        draft={draft}
        project={showProject && session.cwd ? basename(session.cwd) : undefined}
        onSelect={(file) => {
          if (renaming === file) return
          // The row on screen is the same conversation whether it is a draft
          // or a file, so a draft row must not re-open on every click.
          if (file === (activeSessionFile ?? draftId)) {
            const state = useAppStore.getState()
            const cached = state.threads[file]
            const canRetryHistory = session.onDisk === true &&
              state.hydratingSessionFile !== file &&
              needsSessionHydration(
                session.messageCount,
                cached?.version,
                cached?.items.length ?? 0,
                cached?.isStreaming ?? false
              )
            if (!canRetryHistory) return
          }
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
        onArchive={() => void archiveSession(session.file)}
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

  const closeSearch = (restoreFocus = false) => {
    setSearchOpen(false)
    setQuery('')
    setSearchFocused(false)
    setRecentsOpen(false)
    setRecentIndex(-1)
    if (restoreFocus) {
      window.requestAnimationFrame(() => searchTriggerRef.current?.focus())
    }
  }

  // A hit opens the conversation and asks the thread to scroll to the message
  // it belongs to; the query comes along so the words stay marked.
  const openContentHit = (hit: SessionSearchHit) => {
    closeSearch()
    void openSearchHit(hit, trimmedQuery)
  }

  const openProjectResult = (project: Project<ConversationRow>) => {
    closeSearch()
    void switchProject(project.path, { allowWhileRunning: true })
  }

  const openConversationResult = (session: ConversationRow) => {
    closeSearch()
    void selectSession(session)
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

  const searchHost = searchOpen && typeof document !== 'undefined'
    ? document.querySelector<HTMLElement>('.main__body')
    : null

  return (
    <>
    <aside
      className="sidebar"
      inert={open && !searchOpen ? undefined : true}
      aria-hidden={open && !searchOpen ? undefined : true}
    >
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
            ref={searchTriggerRef}
            className="sidebar__head-btn"
            aria-label={t('Search projects and conversations')}
            title={t('Search projects and conversations')}
            aria-expanded={searchOpen}
            aria-controls="conversation-search-dialog"
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

      <div className="sidebar__plugin-entry">
        <button
          type="button"
          className="sidebar__foot-btn"
          onClick={onOpenPlugins}
          data-active={deskPage === 'marketplace' || undefined}
          aria-current={deskPage === 'marketplace' ? 'page' : undefined}
          title={t('Plugins & skills')}
        >
          <Puzzle size={15} strokeWidth={1.6} />
          <span>{t('Plugins & skills')}</span>
        </button>
      </div>

      <div className="sidebar__scheduled-entry">
        <button
          type="button"
          className="sidebar__foot-btn"
          onClick={onOpenScheduledTasks}
          data-active={deskPage === 'scheduled' || undefined}
          aria-current={deskPage === 'scheduled' ? 'page' : undefined}
          title={t('Scheduled tasks')}
        >
          <Clock size={15} strokeWidth={1.6} />
          <span>{t('Scheduled tasks')}</span>
        </button>
      </div>

      <div className="sidebar__body" id="sidebar-content">
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
              {dropLineTop !== null ? (
                <div
                  className="project-drop-line"
                  style={{ top: dropLineTop }}
                  aria-hidden="true"
                />
              ) : null}
              {groups.map(({ project, sessions: projectSessions }) => {
                const projectId = project.id
                const projectIndex = shown.findIndex((item) => samePath(item.path, project.path))
                const active = Boolean(workspace && samePath(workspace.path, project.path))
                const expanded = Boolean(needle) || !collapsedProjects.has(project.path)
                const showAll = Boolean(needle) || expandedLists.has(project.path)
                const visibleCount = showAll
                  ? projectSessions.length
                  : Math.max(
                      SESSION_PREVIEW_LIMIT,
                      projectSessions.findIndex((session) => session.file === activeSessionFile) + 1
                    )
                const iconTone = projectIconColor(project.iconColor)
                const emoji = projectIconEmoji(project.icon)
                const runningCollapsed =
                  !expanded && runningProjectKeys.has(normalisePathKey(project.path))
                // Built once per row: the card is the same for the pointer and
                // for the keyboard.
                const projectTipRows: SidebarTipRow[] = [
                  {
                    label: t('Created'),
                    value: formatDateTime(project.createdAt, settings.language) || '—'
                  },
                  { label: t('Conversations'), value: String(projectSessions.length) },
                  { label: t('Path'), value: project.path, path: true }
                ]
                return (
                  <div
                    className="project"
                    key={project.path || 'unknown'}
                    data-path={project.path}
                    data-active={active}
                    data-dragging={draggingPath != null && samePath(draggingPath, project.path)}
                    data-expanded={expanded}
                    data-running={runningCollapsed ? 'true' : undefined}
                    data-pending={
                      pendingProject?.path != null
                        ? samePath(pendingProject.path, project.path)
                        : undefined
                    }
                  >
                    <div className="project__row">
                      {projectTip.tip ? (
                        <SidebarTip
                          anchor={projectTip.tip.anchor}
                          title={project.name}
                          rows={projectTip.tip.payload}
                        />
                      ) : null}
                      <button
                        className="project__main"
                        type="button"
                        // The card carries what the row cannot: when the folder
                        // joined the list, how many conversations live in it,
                        // and where it is.
                        aria-describedby={projectTip.tip ? SIDEBAR_TIP_ID : undefined}
                        onMouseEnter={projectTip.enter(projectTipRows)}
                        onMouseLeave={projectTip.leave}
                        onFocus={projectTip.enter(projectTipRows)}
                        onBlur={projectTip.leave}
                        aria-expanded={expanded}
                        onPointerDown={(event) => onProjectPointerDown(project, event)}
                        onClick={() => {
                          if (suppressClick.current) {
                            suppressClick.current = false
                            return
                          }
                          void openProject(project)
                        }}
                      >
                        <span className="project__icon" data-icon-color={iconTone}>
                          {emoji ? (
                            <span className="project__emoji">{emoji}</span>
                          ) : expanded && projectSessions.length > 0 ? (
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

                      {/* The icon is a control of its own: clicking it opens the
                          picker instead of folding the list, so the row keeps
                          its "only expands" meaning. */}
                      {project.registered && projectId ? (
                        <div className="project__icon-wrap">
                          <Popover
                            placement="bottom"
                            align="left"
                            className="project-icon-popover"
                            renderTrigger={({ open, toggle }) => (
                              <button
                                type="button"
                                className="project__icon-control"
                                data-project={projectId}
                                aria-label={t('Change project icon')}
                                title={t('Change project icon')}
                                data-active={open}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  toggle(event)
                                }}
                              />
                            )}
                          >
                            {() => (
                              <ProjectIconPicker
                                icon={emoji}
                                color={iconTone}
                                onPick={(next, colour) => {
                                  void setProjectIcon(project, next, colour)
                                }}
                                onReset={() => {
                                  void setProjectIcon(project, undefined, 'neutral')
                                }}
                              />
                            )}
                          </Popover>
                        </div>
                      ) : null}

                      <div className="project__actions">
                        <div className="project__buttons">
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
                                  <>
                                    <button
                                      className="popover__item"
                                      type="button"
                                      role="menuitem"
                                      onClick={() => {
                                        close()
                                        // The picker hangs off the icon, so the
                                        // menu hands the click to it.
                                        requestAnimationFrame(() => {
                                          document
                                            .querySelector<HTMLButtonElement>(
                                              `.project__icon-control[data-project="${CSS.escape(projectId)}"]`
                                            )
                                            ?.click()
                                        })
                                      }}
                                    >
                                      <Smile size={13} />
                                      <span>{t('Change project icon')}</span>
                                    </button>
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
                                  </>
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
                                className="popover__item"
                                type="button"
                                role="menuitem"
                                disabled={Boolean(needle) || projectIndex <= 0}
                                onClick={() => {
                                  close()
                                  moveProject(project, -1)
                                }}
                              >
                                <ArrowUp size={13} />
                                <span>{t('Move up')}</span>
                              </button>
                              <button
                                className="popover__item"
                                type="button"
                                role="menuitem"
                                disabled={Boolean(needle) || projectIndex < 0 || projectIndex >= shown.length - 1}
                                onClick={() => {
                                  close()
                                  moveProject(project, 1)
                                }}
                              >
                                <ArrowDown size={13} />
                                <span>{t('Move down')}</span>
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

        {projectlessSessions.length > 0 ? (
          <div className="sidebar__section">
            <div className="sidebar__section-head">
              <span>{t('Chats')}</span>
            </div>
            <div className="session-list">{renderSessions(projectlessSessions)}</div>
          </div>
        ) : null}

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
    {searchHost ? createPortal(
      <div
        className="search-dialog-layer"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeSearch(true)
        }}
      >
        <section
          className="modal search-dialog"
          id="conversation-search-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t('Search projects and conversations')}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <header className="search-dialog__head">
            <h2>{t('Search projects and conversations')}</h2>
            <button
              type="button"
              className="icon-btn"
              aria-label={t('Close')}
              title={t('Close')}
              onClick={() => closeSearch(true)}
            >
              <X size={15} />
            </button>
          </header>

          <div className="search-dialog__input">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchInputRef}
              value={query}
              maxLength={MAX_SEARCH_QUERY_LENGTH}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={recentsVisible}
              aria-controls={recentsVisible
                ? 'session-search-recents conversation-search-results'
                : 'conversation-search-results'}
              aria-activedescendant={
                recentsVisible && recentIndex >= 0
                  ? `session-search-recent-${recentIndex}`
                  : undefined
              }
              aria-label={t('Search projects and conversations')}
              placeholder={t('Search projects and conversations')}
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
                    closeSearch(true)
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
                if (event.key === 'Enter' && recentIndex >= 0) {
                  event.preventDefault()
                  pickRecent(recents[recentIndex])
                }
              }}
            />
            {query ? (
              <button
                type="button"
                className="icon-btn"
                onClick={() => {
                  setQuery('')
                  searchInputRef.current?.focus()
                }}
                title={t('Clear the filter')}
                aria-label={t('Clear the filter')}
              >
                <X size={12} />
              </button>
            ) : null}
          </div>

          <div className="search-dialog__results" id="conversation-search-results">
            {recentsVisible ? (
              <div className="session-search__recents">
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
                      <Clock size={12} />
                      <span className="session-search__recent-text">{entry}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {projectSearchResults.length > 0 ? (
              <section className="search-dialog__section" aria-label={t('Projects')}>
                <div className="search-dialog__section-head">
                  <span>{t('Projects')}</span>
                  <span className="session-search__count">{projectSearchResults.length}</span>
                </div>
                {projectSearchResults.map((project) => (
                  <button
                    key={normalisePathKey(project.path)}
                    type="button"
                    className="search-dialog__result"
                    onClick={() => openProjectResult(project)}
                    title={project.path}
                  >
                    <FolderOpen size={16} aria-hidden="true" />
                    <span className="search-dialog__result-copy">
                      <span className="search-dialog__result-title">{project.name}</span>
                      <span className="search-dialog__result-meta">{project.path}</span>
                    </span>
                    <span className="search-dialog__result-hint">{t('Open project')}</span>
                  </button>
                ))}
              </section>
            ) : null}

            {conversationSearchMatches.length > 0 ? (
              <section className="search-dialog__section" aria-label={t('Search conversations')}>
                <div className="search-dialog__section-head">
                  <span>{t('Search conversations')}</span>
                  <span className="session-search__count">{conversationSearchMatches.length}</span>
                </div>
                {conversationSearchResults.map((session) => (
                  <button
                    key={session.file}
                    type="button"
                    className="search-dialog__result"
                    onClick={() => openConversationResult(session)}
                    title={session.name || session.preview || session.file}
                  >
                    <SquarePen size={15} aria-hidden="true" />
                    <span className="search-dialog__result-copy">
                      <span className="search-dialog__result-title">
                        {session.name || session.preview || t('Untitled session')}
                      </span>
                      <span className="search-dialog__result-meta">
                        {session.cwd ? basename(session.cwd) : t('Chats without a project')}
                        {' · '}
                        {formatRelativeTime(session.updatedAt, settings.language)}
                      </span>
                    </span>
                  </button>
                ))}
                {conversationSearchResults.length < conversationSearchMatches.length ? (
                  <button
                    type="button"
                    className="search-dialog__more"
                    onClick={() => setConversationSearchWindow((current) => ({
                      needle: searchNeedle,
                      count: (
                        current.needle === searchNeedle
                          ? current.count
                          : INITIAL_CONVERSATION_SEARCH_RESULTS
                      ) + CONVERSATION_SEARCH_RESULTS_PAGE
                    }))}
                  >
                    {t('Show more')}
                  </button>
                ) : null}
              </section>
            ) : null}

            {showContentSearch ? (
              <section className="search-dialog__section session-search" aria-label={t('Matches in conversations')}>
                <div className="search-dialog__section-head">
                  <span>{t('Matches in conversations')}</span>
                  {contentHits.length > 0 ? (
                    <span className="session-search__count">{contentHits.length}</span>
                  ) : null}
                </div>
                {contentSearch.status === 'searching' ? (
                  <div className="session-search__state">{t('Searching…')}</div>
                ) : contentHits.length > 0 ? (
                  <div className="search-dialog__text-hits">{renderContentHits(contentHits)}</div>
                ) : (
                  <div className="session-search__state">{t('No matches in conversation text')}</div>
                )}
              </section>
            ) : null}

            {projectSearchResults.length === 0 &&
            conversationSearchMatches.length === 0 &&
            !showContentSearch ? (
              <div className="search-dialog__empty">
                {needle ? t('No project or conversation matches') : t('No projects or conversations yet')}
              </div>
            ) : null}
          </div>
        </section>
      </div>,
      searchHost
    ) : null}
    </>
  )
}

interface SessionRowProps {
  session: ConversationRow
  active: boolean
  running: boolean
  /** The one mark the row carries. */
  indicator: SessionIndicator
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
  onArchive: () => void
  onStop: () => void
  onTogglePin: () => void
}

const SessionRow = memo(function SessionRow({
  session,
  active,
  running,
  indicator,
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
  onArchive,
  onStop,
  onTogglePin
}: SessionRowProps) {
  const t = useT()
  const mainRef = useRef<HTMLButtonElement>(null)
  const language = useAppStore((state) => state.settings.language ?? 'en')
  const tip = useHoverTip<SidebarTipRow[]>()
  const focusMenuItem = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return
    requestAnimationFrame(() => {
      if (button.isConnected) button.focus()
    })
  }, [])
  const title = session.name || session.preview || t('Untitled session')
  // What the row cannot say in one line: when the conversation was started,
  // where its file lives, and how it is doing right now.
  const tipRows = useCallback((): SidebarTipRow[] => {
    const status =
      indicator === 'needs-input'
        ? t('Waiting for your answer')
        : indicator === 'error'
          ? t('The last run failed')
          : indicator === 'unread'
            ? t('Unread')
            : running
              ? t('Running')
              : t('Idle')
    return [
      { label: t('Created'), value: formatDateTime(session.createdAt, language) || '—' },
      { label: t('Path'), value: session.file, path: true },
      { label: t('Status'), value: status },
      // A conversation pinned out of its project is the only row whose project
      // is not obvious from its surroundings, so only that one names it.
      ...(project ? [{ label: t('Project'), value: project }] : [])
    ]
  }, [indicator, language, project, running, session.createdAt, session.file, t])
  return (
    <div
      className="session-item"
      data-active={active}
      data-session-file={session.file}
      data-indicator={indicator}
      // A conversation Pi has not written to disk yet: it is the one being
      // worked on, and it has no file to rename, delete or pin.
      data-live={session.onDisk ? undefined : 'true'}
    >
      {tip.tip ? <SidebarTip anchor={tip.tip.anchor} title={title} rows={tip.tip.payload} /> : null}
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
          // The card replaces the native tooltip, which could only carry the
          // name the row already shows.
          aria-describedby={tip.tip ? SIDEBAR_TIP_ID : undefined}
          onMouseEnter={tip.enter(tipRows())}
          onMouseLeave={tip.leave}
          onFocus={tip.enter(tipRows())}
          onBlur={tip.leave}
          aria-current={active ? 'page' : undefined}
          aria-busy={running ? true : undefined}
        >
          {running ? (
            <span className="session-item__status" role="status" aria-label={t('running')}>
              <Loader2 size={12} strokeWidth={1.5} className="spin" />
            </span>
          ) : isDotIndicator(indicator) ? (
            <span
              className="session-item__dot"
              data-tone={indicator}
              role="status"
              aria-label={
                indicator === 'error' ? t('The last run failed') : t('Unread')
              }
            />
          ) : null}
          <span className="session-item__title">{title}</span>
        </button>
      )}
      {indicator === 'needs-input' ? (
        <span className="session-item__badge" aria-label={t('Waiting for your answer')}>
          {t('Needs input')}
        </span>
      ) : null}
      {pinned ? (
        <span className="session-item__activity" aria-label={t('Pinned')}>
          <Pin size={11} />
        </span>
      ) : null}
      {!renaming ? (
        <div className="session-item__actions">
          <Popover
            align="right"
            width={208}
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
                {/* Pinning, renaming and deleting all address a JSONL file.
                    A conversation Pi has not written yet has none, so its menu
                    offers only what its own process can answer. */}
                {session.onDisk ? (
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
                ) : null}
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
                {session.onDisk ? (
                  <button
                    type="button"
                    className="popover__item"
                    role="menuitem"
                    onClick={() => {
                      close()
                      onArchive()
                    }}
                  >
                    <Archive size={12} />
                    {t('Archive conversation')}
                  </button>
                ) : null}
                {session.onDisk ? (
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
                ) : null}
              </div>
            )}
          </Popover>
        </div>
      ) : null}
    </div>
  )
})

const SessionRowItem = memo(function SessionRowItem({
  session,
  active,
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
  onArchive,
  onStop,
  onTogglePin
}: Omit<SessionRowProps, 'running' | 'indicator'>) {
  const isStreaming = useAppStore(
    useCallback((state) => Boolean(state.threads[session.file]?.isStreaming), [session.file])
  )
  const notice = useAppStore(
    useCallback((state) => state.threads[session.file]?.notice, [session.file])
  )
  const needsInput = useAppStore(
    useCallback((state) => Boolean(state.threads[session.file]?.uiRequest), [session.file])
  )
  const indicator = sessionIndicator({
    isStreaming,
    notice,
    needsInput
  })

  return (
    <SessionRow
      session={session}
      active={active}
      running={isStreaming}
      indicator={indicator}
      pinned={pinned}
      renaming={renaming}
      draft={draft}
      project={project}
      onSelect={onSelect}
      onStartRename={onStartRename}
      onRenameDraft={onRenameDraft}
      onCommitRename={onCommitRename}
      onCancelRename={onCancelRename}
      onDelete={onDelete}
      onArchive={onArchive}
      onStop={onStop}
      onTogglePin={onTogglePin}
    />
  )
})
