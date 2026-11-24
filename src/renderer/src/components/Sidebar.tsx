import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Clock,
  Download,
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
import { useAppStore } from '../store/useAppStore'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { archiveSessionKey } from '@shared/session-archive'
import { MAX_SEARCH_QUERY_LENGTH } from '@shared/types'
import type { AppLanguage, ProjectIconColor, SessionMeta, SessionSearchHit, Workspace } from '@shared/types'
import { formatBytes, formatDateTime, formatRelativeTime } from '../lib/format'
import { normalisePathKey, samePath } from '../lib/path'
import { collectProjects, sortProjects, type Project } from '../lib/projects'
import { filterByArchive, flatSessions, groupArchivedByProject, projectDepths, sortByMode } from '../lib/sidebar-view'
import {
  readCollapsedSidebarSections,
  sidebarSectionExpanded,
  toggleCollapsedSidebarSection,
  writeCollapsedSidebarSections
} from '../lib/sidebar-fold'
import { liveConversationRows, type ConversationRow } from '../lib/live-sessions'
import { basename } from '../lib/path'
import { ConfirmDialog } from './ConfirmDialog'
import { Popover } from './Popover'
import { SidebarTip, SIDEBAR_TIP_ID, useHoverTip, type SidebarTipRow } from './SidebarTip'
import { shouldShowUpdateNotice } from '@shared/update-notice'
import { PiLogo } from './PiLogo'
import { PiWordmark } from './PiWordmark'
import { projectIconColor, projectIconEmoji } from '../lib/project-icons'
import {
  appUpdateInstall,
  applyAppUpdate,
  availableAppUpdate,
  startAppUpdateDownload,
  subscribeAppUpdateInstall,
  subscribeAvailableAppUpdate,
  type AppUpdateInstall,
  type AvailableAppUpdate
} from '../lib/app-update'

/** A lighter funnel for the project view menu; lucide's list-filter reads too heavy at 14px. */
function ViewFilterIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 3.5h11l-4.2 5v3.7l-2.6 1.3V8.5l-4.2-5Z"
        fill="currentColor"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

const ProjectIconPicker = lazy(() =>
  import('./ProjectIconPicker').then((m) => ({ default: m.ProjectIconPicker }))
)
import {
  projectIndicator,
  sessionIndicator,
  isDotIndicator,
  type SessionIndicator,
  type SessionIndicatorInput
} from '../lib/session-indicator'
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
/** The update ring: radius 10 inside a 24-unit viewBox. */
const UPDATE_RING_CIRCUMFERENCE = 2 * Math.PI * 10
const SESSION_PREVIEW_LIMIT = 5
const SESSION_PAGE_SIZE = 50
const INITIAL_CONVERSATION_SEARCH_RESULTS = 50
const CONVERSATION_SEARCH_RESULTS_PAGE = 50
const INITIAL_CONTENT_SEARCH_RESULTS = 50
const CONTENT_SEARCH_RESULTS_PAGE = 50

interface AttentionSummary {
  attentionKeys: Set<string>
  projectIndicators: Map<string, SessionIndicator>
}

function buildAttentionSignature(
  sessions: readonly SessionMeta[],
  threads: Readonly<
    Record<
      string,
      {
        isStreaming: boolean
        notice?: 'error' | 'unread'
        uiRequest?: unknown
        uiRequests?: readonly unknown[]
        status: { cwd?: string }
      }
    >
  >,
  workspacePath: string | undefined,
  sessionNotices: Readonly<Record<string, 'error' | 'unread'>>
): string {
  const cwdByFile = new Map<string, string>()
  for (const session of sessions) {
    if (session.cwd) cwdByFile.set(normalisePathKey(session.file), session.cwd)
  }
  const rows: string[] = []
  const seen = new Set<string>()
  for (const [key, thread] of Object.entries(threads)) {
    const needsInput = Boolean(thread.uiRequest || thread.uiRequests?.length)
    const indicator = sessionIndicator({
      isStreaming: thread.isStreaming,
      notice: thread.notice,
      needsInput
    })
    if (indicator === 'idle') continue
    seen.add(key)
    const cwd =
      thread.status.cwd ||
      cwdByFile.get(normalisePathKey(key)) ||
      (key.startsWith('draft:') ? workspacePath : undefined)
    const cwdKey = cwd ? normalisePathKey(cwd) : ''
    rows.push(`${key}\u0000${indicator}\u0000${cwdKey}`)
  }
  // A mark that outlived its thread (the app restarted before the reader
  // opened the conversation) still has to reach the row and its project.
  for (const [file, notice] of Object.entries(sessionNotices)) {
    if (seen.has(file)) continue
    const cwd = cwdByFile.get(normalisePathKey(file))
    rows.push(`${file}\u0000${notice}\u0000${cwd ? normalisePathKey(cwd) : ''}`)
  }
  if (rows.length === 0) return ''
  rows.sort()
  return rows.join('\u0001')
}

function parseAttentionSignature(signature: string): AttentionSummary {
  const attentionKeys = new Set<string>()
  const byCwd = new Map<string, SessionIndicatorInput[]>()
  if (!signature) {
    return { attentionKeys, projectIndicators: new Map() }
  }
  for (const row of signature.split('\u0001')) {
    const [key, indicatorRaw, cwdKey] = row.split('\u0000')
    if (!key) continue
    attentionKeys.add(key)
    if (!cwdKey) continue
    const input: SessionIndicatorInput = {
      isStreaming: indicatorRaw === 'running',
      notice:
        indicatorRaw === 'error' || indicatorRaw === 'unread' ? indicatorRaw : undefined,
      needsInput: indicatorRaw === 'needs-input'
    }
    const list = byCwd.get(cwdKey)
    if (list) list.push(input)
    else byCwd.set(cwdKey, [input])
  }
  const projectIndicators = new Map<string, SessionIndicator>()
  for (const [cwdKey, inputs] of byCwd) {
    projectIndicators.set(cwdKey, projectIndicator(inputs))
  }
  return { attentionKeys, projectIndicators }
}

/** True when a conversation matches the filter of the sidebar. */
function matches(session: SessionMeta, needle: string): boolean {
  if (!needle) return true
  return (
    (session.name ?? '').toLowerCase().includes(needle) ||
    session.preview.toLowerCase().includes(needle) ||
    session.cwd.toLowerCase().includes(needle)
  )
}

export const Sidebar = memo(function Sidebar({
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
  const statusPhase = useAppStore((state) => state.status.phase)
  const threadsMetaVersion = useAppStore((state) => state.threadsMetaVersion)
  const sessionNotices = useAppStore((state) => state.sessionNotices)
  const liveRows = useMemo(
    () => liveConversationRows(sessions, useAppStore.getState().threads, workspace?.path),
    [sessions, threadsMetaVersion, workspace?.path]
  )
  const archivedSessions = useAppStore((state) => state.settings.archivedSessions)
  const workspacesSetting = useAppStore((state) => state.settings.workspaces)
  const hiddenProjects = useAppStore((state) => state.settings.hiddenProjects)
  const projectOrder = useAppStore((state) => state.settings.projectOrder)
  const sidebarGroupBy = useAppStore((state) => state.settings.sidebarGroupBy ?? 'workspace')
  const sidebarSortBy = useAppStore((state) => state.settings.sidebarSortBy ?? 'manual')
  const sidebarArchiveFilter = useAppStore((state) => state.settings.sidebarArchiveFilter ?? 'hidden')
  const pinnedSessionsSetting = useAppStore((state) => state.settings.pinnedSessions)
  const language = useAppStore((state) => state.settings.language ?? 'en')
  // Both readings live in the shared module, so a folded-away sidebar, a
  // restarted app and the settings page all describe the same release. The
  // initial value is read from the module, not assumed empty: the startup
  // restore may already have answered.
  const [appUpdate, setAppUpdate] = useState<AvailableAppUpdate | null>(() => availableAppUpdate())
  const [install, setInstall] = useState<AppUpdateInstall | null>(() => appUpdateInstall())
  const updateSupported = useAppStore((state) => state.info?.appUpdateSupported !== false)
  const showToast = useAppStore((state) => state.showToast)
  // The card is anchored by hand rather than through `useHoverTip`: its rows
  // change while the download runs, and the card must show the live percent.
  const [updateTipAnchor, setUpdateTipAnchor] = useState<HTMLElement | null>(null)
  // A folded project draws one mark for all of its chats. An expanded project
  // keeps the dot for an answer, a failure or a waiting dialog the reader has
  // not opened, because its conversation row can sit below the fold. Track the
  // non-idle thread states via `threadsMetaVersion` so streaming deltas never
  // scan threads or re-render the sidebar.
  const attentionSignature = useMemo(
    () =>
      buildAttentionSignature(
        sessions,
        useAppStore.getState().threads,
        workspace?.path,
        sessionNotices
      ),
    [sessions, threadsMetaVersion, workspace?.path, sessionNotices]
  )
  const archivedFiles = useMemo(
    () => new Set((archivedSessions ?? []).map(archiveSessionKey)),
    [archivedSessions]
  )
  const searchScope = useMemo(
    () => ({ archiveFilter: sidebarArchiveFilter, archivedFiles }),
    [sidebarArchiveFilter, archivedFiles]
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
  const restoreSession = useAppStore((state) => state.restoreSession)
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
  const [contentHitWindow, setContentHitWindow] = useState({
    query: '',
    count: INITIAL_CONVERSATION_SEARCH_RESULTS
  })
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set())
  // Archived groups fold the same way a project row does, one fold per folder.
  const [collapsedArchiveGroups, setCollapsedArchiveGroups] = useState<Set<string>>(() => new Set())
  // The section head folds its own list. The key follows the view, so folding
  // the single list does not fold the project list as well.
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() =>
    readCollapsedSidebarSections()
  )
  const [expandedLimits, setExpandedLimits] = useState<Record<string, number>>({})
  const [searchOpen, setSearchOpen] = useState(false)
  const searchDialogRef = useRef<HTMLElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchTriggerRef = useRef<HTMLButtonElement>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const renamingRef = useRef(renaming)
  renamingRef.current = renaming
  const draftRef = useRef(draft)
  draftRef.current = draft
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null)
  // Renaming a project unmounts its input, so the row has to take focus back
  // or a keyboard user is dropped onto <body>.
  const projectRowRefs = useRef(new Map<string, HTMLButtonElement | null>())
  const [projectDraft, setProjectDraft] = useState('')
  const [pendingDelete, setPendingDelete] = useState<SessionMeta | null>(null)
  const [pendingRemove, setPendingRemove] = useState<{ id?: string; path: string; name: string } | null>(null)
  const [searchFocused, setSearchFocused] = useState(false)
  const [recentsOpen, setRecentsOpen] = useState(false)
  const [recentIndex, setRecentIndex] = useState(-1)
  const blurTimer = useRef<number | undefined>(undefined)
  const recentsRef = useRef<HTMLDivElement | null>(null)
  // One card serves the whole project list: only one row can be hovered.
  const projectTip = useHoverTip<{ path: string; title: string; rows: SidebarTipRow[] }>()

  useEffect(() => subscribeAvailableAppUpdate(setAppUpdate), [])
  useEffect(() => subscribeAppUpdateInstall(setInstall), [])

  // A record from another release is not this icon's business: the two can
  // disagree for a moment while a check replaces one with the other. Only a
  // build that can install has a download at all — a portable or development
  // build never fetches an installer, so a record left in the data folder by
  // some other launch is not something this icon can act on.
  const currentInstall =
    updateSupported && install && appUpdate && install.version === appUpdate.latest ? install : null
  // Only a build that can install may offer "restart and install": a portable
  // or development build must not promise a restart it cannot perform.
  const updateReady = currentInstall?.stage === 'ready'
  const updateFailed = currentInstall?.stage === 'error'
  const updateDownloading = currentInstall?.stage === 'downloading'
  const updateInstalling = currentInstall?.stage === 'installing'
  const updateBusy = updateDownloading || updateInstalling
  const updatePercent = currentInstall
    ? Math.min(100, Math.max(0, Math.round(currentInstall.percent)))
    : 0
  // The final progress event follows installer verification and can precede the IPC response.
  const showUpdateRing = !currentInstall || (updateDownloading && updatePercent < 100)
  // Before the download starts the size comes from the release check; while it
  // runs the progress events carry the exact asset size.
  const updateInstallerBytes = currentInstall?.totalBytes ?? appUpdate?.bytes
  // Codex's `dismissed_version`: a release the reader waved away stops being
  // announced, and the control comes back on its own for anything newer. A
  // download in flight or an installer waiting to be used is never hidden —
  // a half-finished update the reader cannot see is worse than the notice.
  const dismissedUpdateVersion = useAppStore((state) => state.settings.dismissedUpdateVersion)
  const showUpdateControl = shouldShowUpdateNotice({
    latest: appUpdate?.latest,
    dismissedVersion: dismissedUpdateVersion,
    busy: updateBusy,
    ready: updateReady,
    failed: currentInstall?.stage === 'error'
  })

  const startAppUpdate = async () => {
    if (!appUpdate || updateBusy) return
    if (updateReady) {
      const result = await applyAppUpdate()
      if (result && !result.success) {
        showToast(result.error ? t(result.error) : t('Update failed. Please try again.'), 'error')
      }
      return
    }
    const result = await startAppUpdateDownload(appUpdate.latest, {
      supported: updateSupported,
      ...(appUpdate.bytes ? { bytes: appUpdate.bytes } : {})
    })
    if (!result.success) {
      showToast(result.error ? t(result.error) : t('Update failed. Please try again.'), 'error')
    }
  }

  // What the ring cannot say: the installer size and the current phase.
  // Nothing else belongs in this card — except the one thing a build without an
  // installer of its own has to explain, because its click leaves the app.
  const getUpdateTip = () => {
    if (!appUpdate) return { title: '', rows: [] as SidebarTipRow[] }
    const manual = !updateSupported
    const status = updateFailed
      ? t('Update failed')
      : updateReady
        ? t('Ready to restart')
        : updateInstalling
          ? t('Restarting to install the update…')
          : updateDownloading
            ? `${t('Downloading…')} ${updatePercent}%`
            : manual
              ? t('Open download page')
              : t('Download update')
    const rows: SidebarTipRow[] = []
    if (updateInstallerBytes) {
      rows.push({ label: t('Installer size'), value: formatBytes(updateInstallerBytes) })
    }
    rows.push({ label: t('Status'), value: status })
    if (manual && !updateBusy) {
      rows.push({
        label: t('Note'),
        value: t('Development and portable builds install from the release page; the installed app updates itself.')
      })
    }
    return { title: `v${appUpdate.latest}`, rows }
  }
  const updateTipContent = updateTipAnchor && appUpdate ? getUpdateTip() : null

  useEffect(() => {
    if (!updateTipAnchor) return
    const clear = () => setUpdateTipAnchor(null)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clear()
    }
    const onVisibility = () => {
      if (document.hidden) clear()
    }
    window.addEventListener('blur', clear)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('visibilitychange', onVisibility)
    document.documentElement.addEventListener('mouseleave', clear)
    return () => {
      window.removeEventListener('blur', clear)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('visibilitychange', onVisibility)
      document.documentElement.removeEventListener('mouseleave', clear)
    }
  }, [updateTipAnchor])

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
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', finish)
        handle.removeEventListener('pointercancel', finish)
        handle.removeEventListener('lostpointercapture', finish)
        document.body.classList.remove('is-resizing')
        onResizeEnd?.(widthRef.current)
      }

      handle.setPointerCapture(event.pointerId)
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', finish)
      // A cancelled pointer (window blur, touch interruption, capture lost)
      // must end the drag too, or the resize cursor stays on the whole app.
      handle.addEventListener('pointercancel', finish)
      handle.addEventListener('lostpointercapture', finish)
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
  const contentSearch = useSessionSearch(trimmedQuery, searchOpen && sessions.length > 0, searchScope)
  const contentHits = contentSearch.hits
  const contentHitLimit =
    contentHitWindow.query === trimmedQuery
      ? contentHitWindow.count
      : INITIAL_CONTENT_SEARCH_RESULTS
  const visibleContentHits = useMemo(
    () => contentHits.slice(0, contentHitLimit),
    [contentHits, contentHitLimit]
  )
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
  const { live: listedLiveRows, disk: listedDiskRows } = useMemo(
    () => ({
      live: filterByArchive(liveRows, archivedFiles, sidebarArchiveFilter),
      disk: filterByArchive(diskRows, archivedFiles, sidebarArchiveFilter)
    }),
    [liveRows, diskRows, archivedFiles, sidebarArchiveFilter]
  )
  const listed = useMemo(() => [...listedLiveRows, ...listedDiskRows], [listedLiveRows, listedDiskRows])

  const projects = useMemo(() => {
    const list = collectProjects(
      workspacesSetting,
      listed,
      hiddenProjects,
      projectOrder
    )
    if (!needle) return list
    for (const project of list) {
      project.sessions = project.sessions.filter((session) => matches(session, needle))
    }
    return list
  }, [workspacesSetting, hiddenProjects, projectOrder, listed, needle])

  // Folders first seen through a session become rows without being registered.
  // Give each one a place in the order now, so opening it later cannot move it
  // into the registered block.
  useEffect(() => {
    const order = projectOrder ?? []
    if (projects.length === 0) return
    const known = new Set(order.map((path) => normalisePathKey(path)))
    const missing = projects
      .filter((project) => project.path && !known.has(normalisePathKey(project.path)))
      .map((project) => project.path)
    if (missing.length > 0) void updateSettings({ projectOrder: [...order, ...missing] }, { projectOrder: order })
  }, [projects, projectOrder, updateSettings])

  const ordered = useMemo(
    () => sortByMode(sortProjects(projects), sidebarSortBy),
    [projects, sidebarSortBy]
  )
  // Tree grouping indents a project by the number of workspace folders that
  // contain it; the flat list has no project rows at all.
  const projectDepthsById = useMemo(
    () => (sidebarGroupBy === 'tree' ? projectDepths(ordered) : new Map<string, number>()),
    [ordered, sidebarGroupBy]
  )
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null)
  // A drag from manual mode must not keep reordering the newest-first view.
  useEffect(() => setOrderOverride(null), [sidebarSortBy])
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
    () => new Set(pinnedSessionsSetting ?? []),
    [pinnedSessionsSetting]
  )

  const { attentionKeys, projectIndicators } = useMemo(
    () => parseAttentionSignature(attentionSignature),
    [attentionSignature]
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

  // Single list: every non-pinned conversation, from projects and from chats
  // without one, in one newest-first column with no project rows in between.
  // Archived conversations are the exception: they leave the column and come
  // back below it, grouped by the project they came from (see `archivedGroups`),
  // because a row from another folder has nothing around it to say so.
  const flatList = useMemo(() => {
    if (sidebarGroupBy !== 'flat') return []
    const rows = listed.filter(
      (session) => !pinned.has(session.file) && matches(session, needle)
    )
    return flatSessions(
      sidebarArchiveFilter === 'hidden'
        ? rows
        : rows.filter((session) => !archivedFiles.has(archiveSessionKey(session.file)))
    )
  }, [sidebarGroupBy, listed, pinned, needle, sidebarArchiveFilter, archivedFiles])

  // Archived conversations leave the flat column and come back under their own
  // project, because a row's folder is not visible in a list that has no project
  // rows at all. Tree mode groups by project already, so this is flat mode only.
  const archivedGroups = useMemo(() => {
    if (sidebarGroupBy !== 'flat') return []
    const archivedRows = listed.filter(
      (session) =>
        !pinned.has(session.file) &&
        matches(session, needle) &&
        archivedFiles.has(archiveSessionKey(session.file))
    )
    if (archivedRows.length === 0) return []
    const nameByKey = new Map(
      ordered.map((project) => [normalisePathKey(project.path), project.name])
    )
    return groupArchivedByProject(archivedRows, {
      projectName: (path) => nameByKey.get(normalisePathKey(path)),
      projectlessName: t('No project'),
      order: ordered.map((project) => project.path)
    })
  }, [sidebarGroupBy, listed, pinned, needle, archivedFiles, ordered, t])

  const projectSearchResults = useMemo(
    () => {
      if (!searchOpen) return []
      return shown.filter(
        (project) => !searchNeedle || `${project.name}\n${project.path}`.toLowerCase().includes(searchNeedle)
      )
    },
    [searchOpen, shown, searchNeedle]
  )
  const conversationSearchCount = conversationSearchWindow.needle === searchNeedle
    ? conversationSearchWindow.count
    : INITIAL_CONVERSATION_SEARCH_RESULTS
  const conversationSearchMatches = useMemo(() => {
    if (!searchOpen) return []
    const results: ConversationRow[] = []
    let liveIndex = 0
    let diskIndex = 0

    // Both inputs are newest-first, and liveRows excludes sessions already on
    // disk. Cache the merged matches so expanding a page does not rescan them.
    while (liveIndex < listedLiveRows.length || diskIndex < listedDiskRows.length) {
      const live = listedLiveRows[liveIndex]
      const disk = listedDiskRows[diskIndex]
      const session = !disk || (live && live.updatedAt >= disk.updatedAt) ? live : disk
      if (!session) break
      if (session === live) liveIndex += 1
      else diskIndex += 1

      if (!matches(session, searchNeedle)) continue
      results.push(session)
    }

    return results
  }, [searchOpen, listedLiveRows, listedDiskRows, searchNeedle])
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
    }, { workspaces: current, projectOrder })
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
    await updateSettings({ workspaces: updated }, { workspaces })
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
    if (event.button !== 0 || needle || sidebarSortBy !== 'manual') return
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

  // An archived group's head is the same control one level down: it folds the
  // conversations of one folder, and never opens or stops anything.
  const toggleArchiveGroup = useCallback((key: string) => {
    setCollapsedArchiveGroups((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const toggleSidebarSection = useCallback((key: string) => {
    setCollapsedSections((current) => {
      const next = toggleCollapsedSidebarSection(current, key)
      writeCollapsedSidebarSections(next)
      return next
    })
  }, [])

  const startRename = useCallback((file: string, current: string) => {
    setRenaming(file)
    setDraft(current)
  }, [])

  const handleSelectSession = useCallback((session: ConversationRow) => {
    const file = session.file
    if (renamingRef.current === file) return
    // The row on screen is the same conversation whether it is a draft
    // or a file, so a draft row must not re-open on every click.
    const state = useAppStore.getState()
    const currentActive = state.activeSessionFile ?? state.draftId
    if (file === currentActive) {
      const cached = state.threads[file]
      const canRetryHistory = state.hydratingSessionFile !== file && needsSessionHydration(file, cached)
      if (!canRetryHistory) return
    }
    // Opening a conversation only changes the view. The one that is
    // running keeps its process.
    void selectSession(session)
  }, [selectSession])

  const handleStartRename = useCallback((session: ConversationRow) => {
    startRename(session.file, session.name || session.preview || '')
  }, [startRename])

  const handleCommitRename = useCallback((file: string) => {
    setRenaming(null)
    void renameSessionFile(file, draftRef.current)
  }, [renameSessionFile])

  const handleCancelRename = useCallback(() => {
    setRenaming(null)
  }, [])

  const handleDeleteSession = useCallback((session: ConversationRow) => {
    setPendingDelete(session)
  }, [])

  const handleToggleArchiveSession = useCallback((file: string, archived: boolean) => {
    if (!archived) {
      void archiveSession(file)
      return
    }
    const key = archiveSessionKey(file)
    const saved = useAppStore.getState().settings.archivedSessions?.find((entry) => archiveSessionKey(entry) === key)
    if (saved) void restoreSession(saved)
  }, [archiveSession, restoreSession])

  const handleStopSession = useCallback((file: string) => {
    const state = useAppStore.getState()
    if (file === state.activeSessionFile) void stop()
    else void stopSession(file)
  }, [stop, stopSession])

  const handleTogglePinSession = useCallback((file: string) => {
    void togglePin(file).then(() => {
      requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>(
          `.session-item[data-session-file="${CSS.escape(file)}"] .session-item__main`
        )?.focus()
      })
    })
  }, [togglePin])

  // A section head folds only when it labels conversations — the single list,
  // and the conversations with no project. The project rows are the tree itself
  // and stay open. Each conversation head keeps its own fold.
  const chatsListExpanded = sidebarSectionExpanded(collapsedSections, 'chats', Boolean(needle))
  const chatsExpanded = sidebarSectionExpanded(
    collapsedSections,
    'chats-without-project',
    Boolean(needle)
  )

  const renderSessions = (items: ConversationRow[], showProject = false) =>
    items.map((session) => (
      <SessionRowItem
        key={session.file}
        session={session}
        active={session.file === (activeSessionFile ?? draftId)}
        pinned={pinned.has(session.file)}
        archived={archivedFiles.has(archiveSessionKey(session.file))}
        renaming={renaming === session.file}
        draft={renaming === session.file ? draft : ''}
        project={showProject && session.cwd ? basename(session.cwd) : undefined}
        language={language}
        onSelect={handleSelectSession}
        onStartRename={handleStartRename}
        onRenameDraft={setDraft}
        onCommitRename={handleCommitRename}
        onCancelRename={handleCancelRename}
        onDelete={handleDeleteSession}
        onToggleArchive={handleToggleArchiveSession}
        onStop={handleStopSession}
        onTogglePin={handleTogglePinSession}
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

  useDialogFocus(searchDialogRef, () => closeSearch(true), {
    enabled: searchOpen,
    closeOnEscape: false
  })

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
              {formatRelativeTime(hit.updatedAt, language)}
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
          <PiWordmark height={14} />
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
          disabled={!workspace && (statusPhase === 'error' || statusPhase === 'stopped')}
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

        <div
          className="sidebar__section sidebar__projects"
          data-collapsed={
            sidebarGroupBy === 'flat' && !chatsListExpanded ? 'true' : undefined
          }
        >
          <div className="sidebar__section-head" data-fold={sidebarGroupBy === 'flat' ? 'true' : undefined}>
            <span className="sidebar__section-title">
              {t(sidebarGroupBy === 'flat' ? 'Chats' : 'Projects')}
            </span>
            {/* Only a head that labels conversations folds: the project rows are
                the tree itself, and folding them away would hide the list the
                reader came for. The caret sits at the right end of the head. */}
            {sidebarGroupBy === 'flat' ? (
              <button
                type="button"
                className="sidebar__section-toggle"
                aria-expanded={chatsListExpanded}
                aria-label={t(chatsListExpanded ? 'Collapse conversations' : 'Expand conversations')}
                title={t(chatsListExpanded ? 'Collapse' : 'Expand')}
                onClick={() => toggleSidebarSection('chats')}
              >
                <ChevronRight size={12} aria-hidden="true" className="sidebar__section-caret" />
              </button>
            ) : null}
            <div className="sidebar__section-actions no-drag">
              <Popover
                placement="bottom"
                align="right"
                className="sidebar-view-menu"
                renderTrigger={({ open, toggle }) => (
                  <button
                    className="sidebar__section-action"
                    aria-label={t('View options')}
                    title={t('View options')}
                    aria-expanded={open}
                    data-active={open}
                    onClick={(event) => toggle(event)}
                  >
                    <ViewFilterIcon size={14} />
                  </button>
                )}
              >
                {(close) => {
                  const radio = (label: string, active: boolean, onSelect: () => void) => (
                    <button
                      key={label}
                      type="button"
                      className="popover__item"
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => { close(); onSelect() }}
                    >
                      <span className="popover__item-text">{t(label)}</span>
                      {active ? <Check size={13} /> : null}
                    </button>
                  )
                  return (
                    <div className="view-option-menu" role="menu" aria-label={t('View options')}>
                      <div className="popover__label">{t('Group by')}</div>
                      {radio('By workspace', sidebarGroupBy === 'workspace', () => {
                        void updateSettings({ sidebarGroupBy: 'workspace' })
                      })}
                      {radio('By workspace tree', sidebarGroupBy === 'tree', () => {
                        void updateSettings({ sidebarGroupBy: 'tree' })
                      })}
                      {radio('Single list', sidebarGroupBy === 'flat', () => {
                        void updateSettings({ sidebarGroupBy: 'flat' })
                      })}
                      <div className="popover__divider" role="separator" />
                      <div className="popover__label">{t('Sort by')}</div>
                      {radio('Manual order', sidebarSortBy === 'manual', () => {
                        void updateSettings({ sidebarSortBy: 'manual' })
                      })}
                      {radio('Recently updated', sidebarSortBy === 'updated', () => {
                        void updateSettings({ sidebarSortBy: 'updated' })
                      })}
                      <div className="popover__divider" role="separator" />
                      <div className="popover__label">{t('Filter sessions')}</div>
                      {radio('Hide archived', sidebarArchiveFilter === 'hidden', () => {
                        void updateSettings({ sidebarArchiveFilter: 'hidden' })
                      })}
                      {radio('All conversations (show archived)', sidebarArchiveFilter === 'all', () => {
                        void updateSettings({ sidebarArchiveFilter: 'all' })
                      })}
                      {radio('Archived only', sidebarArchiveFilter === 'archived', () => {
                        void updateSettings({ sidebarArchiveFilter: 'archived' })
                      })}
                    </div>
                  )
                }}
              </Popover>
              {sidebarGroupBy === 'flat' ? null : (
                <button
                  className="sidebar__section-action"
                  aria-label={t('New project')}
                  title={t('New project')}
                  onClick={() => openProjectDialog({ mode: 'create' })}
                >
                  <Plus size={15} strokeWidth={1.5} />
                </button>
              )}
            </div>
          </div>

          {sidebarGroupBy === 'flat' ? (
            flatList.length === 0 && archivedGroups.length === 0 ? (
              <div className="sidebar__empty">
                {t(
                  sidebarArchiveFilter === 'archived'
                    ? 'No archived conversations.'
                    : 'No conversations yet.'
                )}
              </div>
            ) : (
              <>
                {flatList.length > 0 ? (
                  <div className="session-list">{renderSessions(flatList)}</div>
                ) : null}
                {archivedGroups.length > 0 ? (
                  <div className="sidebar__section sidebar__archived">
                    {/* In 'all' mode the column above holds current work, so the
                        block needs a name; in 'archived' mode every row here is
                        archived and each group speaks for itself. */}
                    {sidebarArchiveFilter === 'all' ? (
                      <div className="sidebar__section-head">
                        <span>{t('Archived')}</span>
                      </div>
                    ) : null}
                    {archivedGroups.map((group) => {
                      // A search opens every group: a hit inside a folded group
                      // would be invisible, which is the one thing a search must
                      // not do. Otherwise the reader's fold is remembered.
                      const groupExpanded =
                        Boolean(needle) || !collapsedArchiveGroups.has(group.key)
                      return (
                        <div
                          className="sidebar__archive-group"
                          key={group.key || 'projectless'}
                          data-expanded={groupExpanded}
                        >
                          <button
                            type="button"
                            className="sidebar__archive-group-head"
                            aria-expanded={groupExpanded}
                            title={group.key || undefined}
                            onClick={() => toggleArchiveGroup(group.key)}
                          >
                            <Archive size={11} strokeWidth={2} aria-hidden="true" />
                            <span className="sidebar__archive-group-name">{group.name}</span>
                            <span className="sidebar__archive-group-count">
                              {group.sessions.length}
                            </span>
                            <ChevronRight
                              size={12}
                              aria-hidden="true"
                              className="sidebar__archive-group-caret"
                            />
                          </button>
                          {groupExpanded ? (
                            <div className="session-list">{renderSessions(group.sessions)}</div>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </>
            )
          ) : ordered.length === 0 ? (
            <div className="sidebar__empty">{t('No project selected yet.')}</div>
          ) : (
            <div className="project-tree">
              {projectTip.tip ? (
                <SidebarTip
                  anchor={projectTip.tip.anchor}
                  title={projectTip.tip.payload.title}
                  rows={projectTip.tip.payload.rows}
                  onDismiss={projectTip.dismiss}
                />
              ) : null}
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
                const expandedLimit = needle
                  ? projectSessions.length
                  : expandedLimits[project.path] ?? SESSION_PREVIEW_LIMIT
                const allVisible = Boolean(needle) || expandedLimit >= projectSessions.length
                const activeKey = activeSessionFile ?? draftId
                const visibleSessions =
                  allVisible || projectSessions.length <= expandedLimit
                    ? projectSessions
                    : [
                        ...projectSessions.slice(0, expandedLimit),
                        ...projectSessions
                          .slice(expandedLimit)
                          .filter(
                            (session) =>
                              session.file === activeKey || attentionKeys.has(session.file)
                          )
                      ]
                const iconTone = projectIconColor(project.iconColor)
                const emoji = projectIconEmoji(project.icon)
                const projectMark = projectIndicators.get(normalisePathKey(project.path)) ?? 'idle'
                // A folded project speaks for all of its chats. An open one
                // still keeps the dot for a failure, a waiting dialog or an
                // answer the reader has not opened: its conversation row can
                // sit below the fold. Running stays on the child's spinner.
                const projectRowIndicator: SessionIndicator =
                  expanded && projectMark === 'running' ? 'idle' : projectMark
                const runningCollapsed = projectRowIndicator === 'running'
                // Built only if hovered long enough to show the card.
                const getProjectTip = () => ({
                  path: project.path,
                  title: project.name,
                  rows: [
                    {
                      label: t('Created'),
                      value: formatDateTime(project.createdAt, language) || '—'
                    },
                    { label: t('Conversations'), value: String(projectSessions.length) },
                    { label: t('Path'), value: project.path, path: true }
                  ]
                })
                return (
                  <div
                    className="project"
                    key={project.path || 'unknown'}
                    data-path={project.path}
                    data-depth={projectDepthsById.get(normalisePathKey(project.path)) ?? 0}
                    data-active={active}
                    data-dragging={draggingPath != null && samePath(draggingPath, project.path)}
                    data-expanded={expanded}
                    data-running={runningCollapsed ? 'true' : undefined}
                    data-indicator={projectRowIndicator !== 'idle' ? projectRowIndicator : undefined}
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
                        ref={(element) => {
                          if (!projectId) return
                          if (element) projectRowRefs.current.set(projectId, element)
                          else projectRowRefs.current.delete(projectId)
                        }}
                        // The card carries what the row cannot: when the folder
                        // joined the list, how many conversations live in it,
                        // and where it is.
                        aria-describedby={
                          projectTip.tip?.payload.path === project.path ? SIDEBAR_TIP_ID : undefined
                        }
                        onMouseEnter={projectTip.enter(getProjectTip)}
                        onMouseLeave={projectTip.leave}
                        onFocus={projectTip.enter(getProjectTip)}
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
                                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  const trimmed = projectDraft.trim()
                                  if (trimmed && projectId) {
                                    const workspaces = (await window.pi.settings.get()).workspaces
                                    const updated = workspaces.map((w) =>
                                      w.id === projectId ? { ...w, name: trimmed } : w
                                    )
                                    await updateSettings({ workspaces: updated }, { workspaces })
                                    if (workspace?.id === projectId) {
                                      useAppStore.setState({ workspace: { ...workspace, name: trimmed } })
                                    }
                                  }
                                  setRenamingProjectId(null)
                                  if (projectId) requestAnimationFrame(() => projectRowRefs.current.get(projectId)?.focus())
                                } else if (e.key === 'Escape') {
                                  setRenamingProjectId(null)
                                  if (projectId) requestAnimationFrame(() => projectRowRefs.current.get(projectId)?.focus())
                                }
                              }}
                              onBlur={async () => {
                                const trimmed = projectDraft.trim()
                                if (trimmed && projectId && trimmed !== project.name) {
                                  const workspaces = (await window.pi.settings.get()).workspaces
                                  const updated = workspaces.map((w) =>
                                    w.id === projectId ? { ...w, name: trimmed } : w
                                  )
                                  await updateSettings({ workspaces: updated }, { workspaces })
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
                              <Suspense fallback={null}>
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
                              </Suspense>
                            )}
                          </Popover>
                        </div>
                      ) : null}

                      <div className="project__actions">
                        {projectRowIndicator !== 'idle' ? (
                          <span
                            className="project__indicator"
                            data-indicator={projectRowIndicator}
                            role="status"
                            aria-label={
                              projectRowIndicator === 'needs-input'
                                ? t('Waiting for your answer')
                                : projectRowIndicator === 'error'
                                  ? t('The last run failed')
                                  : projectRowIndicator === 'unread'
                                    ? t('Unread')
                                    : t('Running')
                            }
                            title={
                              projectRowIndicator === 'needs-input'
                                ? t('Waiting for your answer')
                                : projectRowIndicator === 'error'
                                  ? t('The last run failed')
                                  : projectRowIndicator === 'unread'
                                    ? t('Unread')
                                    : t('Running')
                            }
                          />
                        ) : null}
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
                                disabled={Boolean(needle) || sidebarSortBy !== 'manual' || projectIndex <= 0}
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
                                disabled={Boolean(needle) || sidebarSortBy !== 'manual' || projectIndex < 0 || projectIndex >= shown.length - 1}
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
                        {renderSessions(visibleSessions)}
                        {!needle &&
                        projectSessions.length > SESSION_PREVIEW_LIMIT &&
                        (allVisible || visibleSessions.length < projectSessions.length) ? (
                          <button
                            className="project__show-more"
                            aria-expanded={allVisible}
                            onClick={() => setExpandedLimits((current) => {
                              const currentLimit = current[project.path] ?? SESSION_PREVIEW_LIMIT
                              if (currentLimit >= projectSessions.length) {
                                const next = { ...current }
                                delete next[project.path]
                                return next
                              }
                              return {
                                ...current,
                                [project.path]: Math.min(
                                  projectSessions.length,
                                  currentLimit + SESSION_PAGE_SIZE
                                )
                              }
                            })}
                          >
                            {allVisible ? t('Show less') : t('Show more')}
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

        {sidebarGroupBy !== 'flat' && projectlessSessions.length > 0 ? (
          <div
            className="sidebar__section sidebar__chats"
            data-collapsed={chatsExpanded ? undefined : 'true'}
          >
            <div className="sidebar__section-head" data-fold="true">
              <span className="sidebar__section-title">{t('Chats')}</span>
              <button
                type="button"
                className="sidebar__section-toggle"
                aria-expanded={chatsExpanded}
                aria-label={t(chatsExpanded ? 'Collapse conversations' : 'Expand conversations')}
                title={t(chatsExpanded ? 'Collapse' : 'Expand')}
                onClick={() => toggleSidebarSection('chats-without-project')}
              >
                <ChevronRight size={12} aria-hidden="true" className="sidebar__section-caret" />
              </button>
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
        <div className="sidebar__foot-row">
          <button
            type="button"
            className="sidebar__foot-btn"
            onClick={onOpenSettings}
            title={t('Settings')}
          >
            <Settings size={15} strokeWidth={1.6} />
            <span>{t('Settings')}</span>
          </button>
          {appUpdate && showUpdateControl ? (
            <button
              type="button"
              className="sidebar__update-btn"
              data-state={updateFailed ? 'error' : updateReady ? 'ready' : updateBusy ? currentInstall?.stage ?? 'downloading' : 'idle'}
              aria-label={t(
                updateReady
                  ? 'Restart and install'
                  : !updateSupported
                    ? 'Open download page'
                    : updateInstalling
                      ? 'Restarting to install the update…'
                      : updateDownloading
                        ? 'Downloading update…'
                        : 'Download update'
              )}
              aria-describedby={updateTipAnchor ? SIDEBAR_TIP_ID : undefined}
              aria-disabled={updateBusy || undefined}
              onMouseEnter={(event) => setUpdateTipAnchor(event.currentTarget)}
              onMouseLeave={() => setUpdateTipAnchor(null)}
              onFocus={(event) => setUpdateTipAnchor(event.currentTarget)}
              onBlur={() => setUpdateTipAnchor(null)}
              onClick={() => void startAppUpdate()}
            >
              <span className="sidebar__update-mark" aria-hidden="true">
                {showUpdateRing ? (
                  <svg className="sidebar__update-ring" viewBox="0 0 24 24">
                    <circle className="sidebar__update-ring-track" cx="12" cy="12" r="10" />
                    <circle
                      className="sidebar__update-ring-fill"
                      cx="12"
                      cy="12"
                      r="10"
                      strokeDasharray={UPDATE_RING_CIRCUMFERENCE}
                      strokeDashoffset={UPDATE_RING_CIRCUMFERENCE * (1 - updatePercent / 100)}
                    />
                  </svg>
                ) : null}
                <Download size={11} strokeWidth={2} />
              </span>
            </button>
          ) : null}
        </div>
      </div>

      {updateTipAnchor && updateTipContent ? (
        <SidebarTip
          anchor={updateTipAnchor}
          title={updateTipContent.title}
          rows={updateTipContent.rows}
          onDismiss={() => setUpdateTipAnchor(null)}
        />
      ) : null}

      {pendingRemove ? (
        <ConfirmDialog
          title={t('Remove project')}
          body={
            language === 'zh-CN'
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
            language === 'zh-CN'
              ? `“${pendingDelete.name || pendingDelete.preview || '未命名会话'}”的会话文件将被永久删除，无法恢复。`
              : `The session file for “${pendingDelete.name || pendingDelete.preview || 'Untitled session'}” will be permanently deleted. This cannot be undone.`
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
          ref={searchDialogRef}
          className="modal search-dialog"
          id="conversation-search-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t('Search projects and conversations')}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            // Escape has to work from a result row or the close button too,
            // not only from the input (which handles its own key first).
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            closeSearch(true)
          }}
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
                // A composing IME uses Escape to cancel the candidate and Enter
                // to commit it; neither should close the dialog or pick a row.
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
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
                        {formatRelativeTime(session.updatedAt, language)}
                      </span>
                    </span>
                    <SearchResultIndicator sessionKey={session.file} />
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
                  <>
                    <div className="search-dialog__text-hits">
                      {renderContentHits(visibleContentHits)}
                    </div>
                    {visibleContentHits.length < contentHits.length ? (
                      <button
                        type="button"
                        className="search-dialog__more"
                        onClick={() =>
                          setContentHitWindow((current) => ({
                            query: trimmedQuery,
                            count:
                              (current.query === trimmedQuery
                                ? current.count
                                : INITIAL_CONTENT_SEARCH_RESULTS) + CONTENT_SEARCH_RESULTS_PAGE
                          }))
                        }
                      >
                        {t('Show more')}
                      </button>
                    ) : null}
                  </>
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
})

interface SessionRowProps {
  session: ConversationRow
  active: boolean
  running: boolean
  /** The one mark the row carries. */
  indicator: SessionIndicator
  pinned: boolean
  archived: boolean
  renaming: boolean
  draft: string
  /** The project the conversation belongs to, when it is pinned. */
  project?: string
  language: AppLanguage
  onSelect: (session: ConversationRow) => void
  onStartRename: (session: ConversationRow) => void
  onRenameDraft: (value: string) => void
  onCommitRename: (file: string) => void
  onCancelRename: () => void
  onDelete: (session: ConversationRow) => void
  onToggleArchive: (file: string, archived: boolean) => void
  onStop: (file: string) => void
  onTogglePin: (file: string) => void
}

const SessionRow = memo(function SessionRow({
  session,
  active,
  running,
  indicator,
  pinned,
  archived,
  renaming,
  draft,
  project,
  language,
  onSelect,
  onStartRename,
  onRenameDraft,
  onCommitRename,
  onCancelRename,
  onDelete,
  onToggleArchive,
  onStop,
  onTogglePin
}: SessionRowProps) {
  const t = useT()
  const mainRef = useRef<HTMLButtonElement>(null)
  const tip = useHoverTip<SidebarTipRow[]>()
  const focusMenuItem = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return
    requestAnimationFrame(() => {
      if (button.isConnected) button.focus()
    })
  }, [])
  const title = session.name || session.preview || t('Untitled session')
  // What the row cannot say in one line: when the conversation was started,
  // which project folder it belongs to, and how it is doing right now.
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
      // The folder the agent runs in, never the JSONL file Pi keeps under its
      // own session storage: the path answers "where does this work live", not
      // "where is the transcript cached".
      { label: t('Path'), value: session.cwd || t('No project'), path: true },
      { label: t('Status'), value: status },
      // A conversation pinned out of its project is the only row whose project
      // is not obvious from its surroundings, so only that one names it.
      ...(project ? [{ label: t('Project'), value: project }] : [])
    ]
  }, [indicator, language, project, running, session.createdAt, session.cwd, t])
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
      {tip.tip ? (
        <SidebarTip
          anchor={tip.tip.anchor}
          title={title}
          rows={tip.tip.payload}
          onDismiss={tip.dismiss}
        />
      ) : null}
      {renaming ? (
        <input
          className="session-item__input"
          value={draft}
          aria-label={t('Rename conversation')}
          autoFocus
          onChange={(event) => onRenameDraft(event.target.value)}
          onBlur={() => onCommitRename(session.file)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
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
          onClick={() => onSelect(session)}
          // The card replaces the native tooltip, which could only carry the
          // name the row already shows.
          aria-describedby={tip.tip ? SIDEBAR_TIP_ID : undefined}
          onMouseEnter={tip.enter(tipRows)}
          onMouseLeave={tip.leave}
          onFocus={tip.enter(tipRows)}
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
          {running ? (
            <button
              type="button"
              className="session-item__stop"
              aria-label={t('Stop the run')}
              title={t('Stop the run')}
              onClick={() => onStop(session.file)}
            >
              <Square size={9} strokeWidth={2.4} fill="currentColor" />
            </button>
          ) : null}
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
                      onTogglePin(session.file)
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
                      onStop(session.file)
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
                    onStartRename(session)
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
                      onToggleArchive(session.file, archived)
                    }}
                  >
                    {archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
                    {t(archived ? 'Restore' : 'Archive conversation')}
                  </button>
                ) : null}
                {session.onDisk ? (
                  <button
                    type="button"
                    className="popover__item popover__item--danger"
                    role="menuitem"
                    onClick={() => {
                      close()
                      onDelete(session)
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
  archived,
  renaming,
  draft,
  project,
  language,
  onSelect,
  onStartRename,
  onRenameDraft,
  onCommitRename,
  onCancelRename,
  onDelete,
  onToggleArchive,
  onStop,
  onTogglePin
}: Omit<SessionRowProps, 'running' | 'indicator'>) {
  const indicatorKey = useAppStore(
    useCallback(
      (state) => {
        const thread = state.threads[session.file]
        if (!thread) {
          const persisted = state.sessionNotices[session.file] ?? ''
          return `0|${persisted}|0`
        }
        const streaming = thread.isStreaming ? '1' : '0'
        const notice = thread.notice ?? state.sessionNotices[session.file] ?? ''
        const needsInput = thread.uiRequest || thread.uiRequests?.length ? '1' : '0'
        return `${streaming}|${notice}|${needsInput}`
      },
      [session.file]
    )
  )
  const [streamingFlag, noticeRaw, needsInputFlag] = indicatorKey.split('|')
  const isStreaming = streamingFlag === '1'
  const notice = noticeRaw === 'error' || noticeRaw === 'unread' ? noticeRaw : undefined
  const needsInput = needsInputFlag === '1'
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
      archived={archived}
      renaming={renaming}
      draft={draft}
      project={project}
      language={language}
      onSelect={onSelect}
      onStartRename={onStartRename}
      onRenameDraft={onRenameDraft}
      onCommitRename={onCommitRename}
      onCancelRename={onCancelRename}
      onDelete={onDelete}
      onToggleArchive={onToggleArchive}
      onStop={onStop}
      onTogglePin={onTogglePin}
    />
  )
})

const SearchResultIndicator = memo(function SearchResultIndicator({
  sessionKey
}: {
  sessionKey: string
}) {
  const t = useT()
  const indicator = useAppStore(
    useCallback(
      (state) => {
        const thread = state.threads[sessionKey]
        return sessionIndicator({
          isStreaming: thread?.isStreaming ?? false,
          notice: thread?.notice ?? state.sessionNotices[sessionKey],
          needsInput: Boolean(thread?.uiRequest || thread?.uiRequests?.length)
        })
      },
      [sessionKey]
    )
  )
  if (indicator === 'idle') return null
  if (indicator === 'needs-input') {
    return (
      <span
        className="session-item__badge search-dialog__badge"
        aria-label={t('Waiting for your answer')}
      >
        {t('Needs input')}
      </span>
    )
  }
  if (indicator === 'running') {
    return (
      <span className="search-dialog__status" role="status" aria-label={t('Running')}>
        <Loader2 size={12} strokeWidth={1.6} className="spin" aria-hidden="true" />
      </span>
    )
  }
  return (
    <span
      className="search-dialog__dot"
      data-tone={indicator}
      role="status"
      aria-label={indicator === 'error' ? t('The last run failed') : t('Unread')}
    />
  )
})
