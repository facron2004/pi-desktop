import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  Download,
  Ellipsis,
  FolderTree,
  GitBranch,
  ListTodo,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  Pencil
} from 'lucide-react'
import type { InspectorRequest } from '@shared/types'
import { applyAppearance, useAppStore } from './store/useAppStore'
import { collectProjects, sortProjects } from './lib/projects'
import { Sidebar } from './components/Sidebar'
import { Thread } from './components/Thread'
import { Composer } from './components/Composer'
import { AppToast } from './components/AppToast'
import { UpdateResultDialog } from './components/UpdateResultDialog'
import { HoverTip } from './components/HoverTip'
import { Welcome } from './components/Welcome'
import type { SettingsPage } from './components/SettingsDialog'
import { AppMenuBar } from './components/AppMenuBar'
import { TaskPanel } from './components/TaskPanel'
import { ToolPanel, type ToolPanelView } from './components/ToolPanel'
import type { LauncherShell } from './components/Launcher'
import type { TerminalRunRequest } from './components/TerminalPanel'
import { FeatureLoading } from './components/FeatureLoading'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Popover } from './components/Popover'
import {
  appUpdateInstall,
  availableAppUpdate,
  noteAppUpdateCheck,
  notePiCliUpdate,
  restoreDownloadedAppUpdate,
  restorePersistedAppUpdate,
  startAppUpdateDownload,
  subscribeAvailableAppUpdate
} from './lib/app-update'
import { matchesAnyShortcut, type ShortcutId } from './lib/shortcuts'
import { isEditingField } from './lib/editing-field'
import { activeConversationTitle } from './lib/live-sessions'
import { OPEN_SIDE_CHAT_EVENT, type SideChatOpenRequest } from './lib/side-chat-context'
import { useT } from './lib/i18n'
import { dismissStartupScreen } from './lib/startup-screen'
import { toggleTaskRail } from './lib/task-rail'
import './styles/side-chat.css'

const InspectorPanel = lazy(() => import('./components/InspectorPanel').then((m) => ({ default: m.InspectorPanel })))
const TerminalPanel = lazy(() => import('./components/TerminalPanel').then((m) => ({ default: m.TerminalPanel })))
const SideChatPanel = lazy(() => import('./components/side-chat/SideChatPanel').then((m) => ({ default: m.SideChatPanel })))
const ScheduledTasksDialog = lazy(() => import('./components/ScheduledTasksDialog').then((m) => ({ default: m.ScheduledTasksDialog })))
const Marketplace = lazy(() => import('./components/Marketplace').then((m) => ({ default: m.Marketplace })))
const SettingsDialog = lazy(() => import('./components/SettingsDialog').then((m) => ({ default: m.SettingsDialog })))
const BrowserView = lazy(() => import('./components/BrowserView').then((m) => ({ default: m.BrowserView })))
const ImageViewer = lazy(() => import('./components/ImageViewer').then((m) => ({ default: m.ImageViewer })))
const SubagentPanel = lazy(() => import('./components/SubagentPanel').then((m) => ({ default: m.SubagentPanel })))
const SwarmPanel = lazy(() => import('./components/SwarmPanel').then((m) => ({ default: m.SwarmPanel })))
const ShortcutsDialog = lazy(() => import('./components/ShortcutsDialog').then((m) => ({ default: m.ShortcutsDialog })))
const ExtensionDialog = lazy(() => import('./components/ExtensionDialog').then((m) => ({ default: m.ExtensionDialog })))
const LauncherDialog = lazy(() => import('./components/Launcher').then((m) => ({ default: m.LauncherDialog })))
const SessionTreeDialog = lazy(() => import('./components/SessionTreeDialog').then((m) => ({ default: m.SessionTreeDialog })))
const McpDialog = lazy(() => import('./components/McpDialog').then((m) => ({ default: m.McpDialog })))
const EditProjectDialog = lazy(() => import('./components/EditProjectDialog').then((m) => ({ default: m.EditProjectDialog })))

import type { SubagentSelection } from './components/SubagentPanel'

/** Matches the closing animation in global.css; the panel stays mounted that long. */
const INSPECTOR_EXIT_MS = 200
const AUTOMATIC_UPDATE_INTERVAL_MS = 12 * 60 * 60 * 1000

function hasAnyStreamingThread(threads: Record<string, { isStreaming: boolean }>): boolean {
  for (const key in threads) {
    if (threads[key].isStreaming) return true
  }
  return false
}

export default function App() {
  const bootstrap = useAppStore((state) => state.bootstrap)
  const info = useAppStore((state) => state.info)
  const hasItems = useAppStore((state) => state.items.length > 0)
  const historyLoading = useAppStore(
    (state) => Boolean(state.activeSessionFile && state.hydratingSessionFile === state.activeSessionFile)
  )
  const showThread = hasItems || historyLoading
  const isStreaming = useAppStore((state) => state.isStreaming)
  const status = useAppStore((state) => state.status)
  const sessionName = useAppStore((state) => state.piState?.sessionName)
  const projectDialog = useAppStore((state) => state.projectDialog)
  const openProjectDialog = useAppStore((state) => state.openProjectDialog)
  const closeProjectDialog = useAppStore((state) => state.closeProjectDialog)
  const newChat = useAppStore((state) => state.newChat)
  const openWorkspace = useAppStore((state) => state.openWorkspace)
  const renameSession = useAppStore((state) => state.renameSession)
  const exportSession = useAppStore((state) => state.exportSession)
  const exportSessionMarkdown = useAppStore((state) => state.exportSessionMarkdown)
  const workspace = useAppStore((state) => state.workspace)
  const uiWidgets = useAppStore((state) => state.uiWidgets)
  const uiTitle = useAppStore((state) => state.uiTitle)
  const savedDrawerWidth = useAppStore((state) => state.settings.drawerWidth)
  const savedSidebarWidth = useAppStore((state) => state.settings.sidebarWidth)
  const automaticUpdates = useAppStore((state) => state.settings.automaticUpdates)
  const language = useAppStore((state) => state.settings.language)
  const shortcutBindings = useAppStore((state) => state.settings.shortcutBindings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const activeSessionFile = useAppStore((state) => state.activeSessionFile)
  const draftId = useAppStore((state) => state.draftId)
  const switchProject = useAppStore((state) => state.switchProject)
  const isCompacting = useAppStore((state) => Boolean(state.run.compaction))
  const cycleModel = useAppStore((state) => state.cycleModel)
  const cycleThinkingLevel = useAppStore((state) => state.cycleThinkingLevel)
  const compact = useAppStore((state) => state.compact)
  const showToast = useAppStore((state) => state.showToast)
  const threadsMetaVersion = useAppStore((state) => state.threadsMetaVersion)
  const anySessionStreaming = useMemo(
    () => hasAnyStreamingThread(useAppStore.getState().threads),
    [threadsMetaVersion]
  )
  const setSideChatOpen = useAppStore((state) => state.setSideChatOpen)
  const ensureSideChatForActiveMain = useAppStore((state) => state.ensureSideChatForActiveMain)
  const hasActiveUiRequest = useAppStore((state) =>
    Boolean(
      state.uiRequest ||
        (state.sideChatOpen &&
          state.sideSessionKey &&
          state.threads[state.sideSessionKey]?.uiRequest)
    )
  )
  const t = useT()

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [bootstrapComplete, setBootstrapComplete] = useState(false)
  // The dialog has several doors now — the launcher and the settings button
  // can ask for a page — so the page it should open on is shell state, not a
  // prop the caller forgets.
  const [settingsPage, setSettingsPage] = useState<SettingsPage>('general')
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarSearchSignal, setSidebarSearchSignal] = useState(0)
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [sessionTreeOpen, setSessionTreeOpen] = useState(false)
  const [mcpOpen, setMcpOpen] = useState(false)
  const [extensionDialogMounted, setExtensionDialogMounted] = useState(false)
  // The sidebar icon and the automatic download both read this; the shared
  // module owns the reading, this is only the renderer's subscription to it.
  const [availableUpdate, setAvailableUpdate] = useState(() => availableAppUpdate())
  const deskPage = useAppStore((state) => state.deskPage)
  const setDeskPage = useAppStore((state) => state.setDeskPage)
  // Keep requests in order until the terminal accepts or rejects the write.
  const [terminalRequests, setTerminalRequests] = useState<TerminalRunRequest[]>([])
  const terminalSeqRef = useRef(0)
  const finishTerminalRequest = useCallback((seq: number) => {
    setTerminalRequests((pending) => pending[0]?.seq === seq ? pending.slice(1) : pending)
  }, [])
  // A URL the Browser page was asked to load. `seq` makes the same link twice
  // two loads instead of one the page already shows.
  const [browserUrl, setBrowserUrl] = useState<{ url: string; seq: number } | null>(null)
  const browserSeqRef = useRef(0)
  // The picture the Images page was asked to show. `seq` makes asking for the
  // same picture twice select it again even if the reader moved away.
  const [imageRequest, setImageRequest] = useState<{ path: string; seq: number } | null>(null)
  const imageSeqRef = useRef(0)
  // A contextual open request for Side Chat (`Ask Side Chat`, `/side`, presets).
  const [sideChatRequest, setSideChatRequest] = useState<SideChatOpenRequest | null>(null)
  const sideChatSeqRef = useRef(0)
  /** Last automatic update check; the effect below re-runs when a run settles. */
  const lastAutomaticUpdateCheck = useRef(0)
  /** The bundled CLI has its own clock: the app release switch must not gate it. */
  const lastPiCliCheck = useRef(0)
  const [changesOpen, setChangesOpen] = useState(false)
  // A click leaves the pointer on the corner control; the arrow stays hidden
  // until the pointer leaves and comes back.
  const [panelToggleHoverMuted, setPanelToggleHoverMuted] = useState(false)
  // Independent of Tools: a status card column beside the conversation.
  const [taskRailOpen, setTaskRailOpen] = useState(true)
  // When the docked ToolPanel narrows the main stage below 760px, auto-fold
  // the task rail to protect the main reading column unless the user re-opens
  // it as a floating card during that narrow state.
  const [narrowTaskOverride, setNarrowTaskOverride] = useState<boolean | null>(null)
  const [taskPanelMounted, setTaskPanelMounted] = useState(true)
  const taskPanelCloseTimer = useRef<number | null>(null)
  // The Files page's tree aside. The panel header owns its toggle, so the
  // control stays put whether the tree is open or folded away.
  const [fileTreeOpen, setFileTreeOpen] = useState(true)
  // Keep the panel mounted after its first open. Collapsing it only hides the
  // column: the tabs, the browser page and the terminal stay alive underneath,
  // and opening the panel again shows the same pages. Unmounting here is what
  // used to throw the browser away.
  const [panelMounted, setPanelMounted] = useState(false)
  const [panelClosing, setPanelClosing] = useState(false)
  const [panelConcealed, setPanelConcealed] = useState(false)
  // A maximized tool panel covers the conversation; the covered surface is
  // inert until the panel is restored or closed.
  const [panelMaximized, setPanelMaximized] = useState(false)
  const panelCloseTimer = useRef<number | null>(null)
  /** The corner door into the tools panel; a deliberate close returns the keyboard here. */
  const panelToggleRef = useRef<HTMLButtonElement | null>(null)
  // The panel opens on its home page; its pages are a choice made per visit,
  // not a mode that follows the conversation around.
  const [panelView, setPanelView] = useState<ToolPanelView>('start')
  /**
   * The panel's tools are tabs. Side chat, the terminal and the browser are
   * live pages: once opened they stay mounted while another tab is in front,
   * and collapsing the panel does not throw them away either.
   */
  const [sideChatMounted, setSideChatMounted] = useState(false)
  const [terminalMounted, setTerminalMounted] = useState(false)
  const [browserMounted, setBrowserMounted] = useState(false)
  const inspectorTab: 'changes' | 'files' | 'review' =
    panelView === 'files' ? 'files' : panelView === 'review' ? 'review' : 'changes'
  const [inspectorFile, setInspectorFile] = useState<{ path: string; line?: number } | null>(null)
  const [subagentSelection, setSubagentSelection] = useState<SubagentSelection | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const exportedRef = useRef(false)
  const devCommitOpenedRef = useRef(false)
  // Null while the panel is being dragged; the stored width takes over again
  // once the drag ends.
  const [draggedWidth, setDraggedWidth] = useState<number | null>(null)
  const drawerWidth = draggedWidth ?? savedDrawerWidth ?? 520
  const [draggedSidebar, setDraggedSidebar] = useState<number | null>(null)
  const sidebarWidth = draggedSidebar ?? savedSidebarWidth ?? 240
  const [windowWidth, setWindowWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 1280
  )

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    // Owned by its own effect: the update check below re-runs whenever a run
    // starts or stops, and a restore is a startup read, not a per-run one.
    void restorePersistedAppUpdate()
    // The installer a previous run downloaded stays on disk; putting it back
    // is what makes the icon say "restart to install" before any check answers.
    void restoreDownloadedAppUpdate()
  }, [])

  useEffect(() => subscribeAvailableAppUpdate(setAvailableUpdate), [])

  useEffect(() => {
    // Automatic checking is the reader's choice. With it off, only the manual
    // entries (Help → Check for updates, About settings) reach the network.
    if (automaticUpdates !== true) return
    // A running conversation is left alone.
    if (anySessionStreaming) return

    let running = false
    const checkForUpdates = async () => {
      if (running) return
      running = true
      lastAutomaticUpdateCheck.current = Date.now()
      try {
        const result = await window.pi.app.checkUpdate()
        // The reading belongs to the module, not to this effect: a check that
        // answers after a dependency changed still described the app as it is,
        // and throwing it away is how a startup check could report nothing.
        noteAppUpdateCheck(result)
      } catch {
        // Transient update errors are retried on the next scheduled check.
      } finally {
        running = false
      }
    }

    // `anySessionStreaming` is a dependency so the check never races a run in
    // progress, but a finished turn flipping it back must not fire a network
    // check of its own. The interval owns the schedule.
    if (Date.now() - lastAutomaticUpdateCheck.current >= AUTOMATIC_UPDATE_INTERVAL_MS) {
      void checkForUpdates()
    }
    const interval = window.setInterval(
      () => void checkForUpdates(),
      AUTOMATIC_UPDATE_INTERVAL_MS
    )
    return () => {
      window.clearInterval(interval)
    }
  }, [anySessionStreaming, automaticUpdates])

  // The bundled CLI is the agent this app drives, so its version is checked on
  // its own schedule: the switch above decides whether app releases are
  // fetched, not whether the agent is current. Only a development checkout can
  // replace it — a packaged build carries one CLI released with the app.
  useEffect(() => {
    if (info?.isPackaged !== false || info.pi.source !== 'bundled') return
    // Replacing the CLI under a running agent would swap the binary mid-run.
    if (anySessionStreaming) return

    let active = true
    let running = false
    const checkPiCli = async () => {
      if (running) return
      running = true
      lastPiCliCheck.current = Date.now()
      try {
        const status = await window.pi.app.checkPiCliUpdate()
        // Same rule as above: the reading is the module's. The effect is torn
        // down and rebuilt while `info` and the settings arrive at startup, and
        // an answer that lands in that window must still reach the About page.
        notePiCliUpdate(status)
        if (!active || automaticUpdates !== true || !status.hasUpdate) return
        // Upgrading writes into the CLI's own folder, so it follows the same
        // switch that lets the app fetch a release in the background.
        const upgraded = await window.pi.app.upgradePiCli()
        if (active && upgraded.success) showToast(t('Upgrade completed'))
      } catch {
        // The next scheduled check tries again.
      } finally {
        running = false
      }
    }

    if (Date.now() - lastPiCliCheck.current >= AUTOMATIC_UPDATE_INTERVAL_MS) {
      void checkPiCli()
    }
    const interval = window.setInterval(() => void checkPiCli(), AUTOMATIC_UPDATE_INTERVAL_MS)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [anySessionStreaming, automaticUpdates, info?.isPackaged, info?.pi.source, showToast, t])

  // Fetch the release a check found, in the background. The ring on the
  // sidebar icon is the progress; the click that installs is the reader's.
  useEffect(() => {
    if (automaticUpdates !== true || info?.appUpdateSupported !== true) return
    if (!availableUpdate) return
    // A ready or running download is already what a click would install.
    if (appUpdateInstall()?.version === availableUpdate.latest) return
    let active = true
    void startAppUpdateDownload(availableUpdate.latest, {
      supported: true,
      ...(availableUpdate.bytes ? { bytes: availableUpdate.bytes } : {})
    }).then((result) => {
      if (!active) return
      if (result.success) {
        showToast(t('Update downloaded. Restart from the icon beside Settings.'))
        return
      }
      // A dismissed release has no card to carry the failure, and nothing
      // retries on its own: say so once, and the sidebar control stays as the
      // retry.
      showToast(result.error ? t(result.error) : t('Update failed. Please try again.'), 'error')
    })
    return () => {
      active = false
    }
  }, [automaticUpdates, info?.appUpdateSupported, availableUpdate, showToast, t])

  useEffect(() => {
    if (changesOpen) {
      if (panelCloseTimer.current !== null) {
        window.clearTimeout(panelCloseTimer.current)
        panelCloseTimer.current = null
      }
      setPanelMounted(true)
      setPanelClosing(false)
      setPanelConcealed(false)
      return
    }
    if (!panelMounted) return
    setPanelClosing(true)
    panelCloseTimer.current = window.setTimeout(() => {
      panelCloseTimer.current = null
      setPanelClosing(false)
      // Hide, don't unmount. The tabs and the pages they hold (the browser
      // especially) are the reader's, and folding the panel is not closing them.
      setPanelConcealed(true)
    }, INSPECTOR_EXIT_MS)
    return () => {
      if (panelCloseTimer.current !== null) {
        window.clearTimeout(panelCloseTimer.current)
        panelCloseTimer.current = null
      }
    }
  }, [changesOpen, panelMounted])

  // The panel is a conversation surface: its pages read the project and the
  // session on screen. A desk page owns the whole content row, so the panel is
  // closed when one opens — otherwise it would stay as a drawer whose only
  // toggle is not drawn there.
  useEffect(() => {
    if (deskPage) setChangesOpen(false)
  }, [deskPage])

  // Mount a live page on its first visit and keep it afterwards. A tab switch
  // or folding the panel must not reload the browser, kill the shells, or reset
  // Side Chat state.
  useEffect(() => {
    if (panelView === 'side-chat') setSideChatMounted(true)
    if (panelView === 'terminal') setTerminalMounted(true)
    if (panelView === 'browser') setBrowserMounted(true)
  }, [panelView])

  const sideChatActive = Boolean(!deskPage && changesOpen && !panelConcealed && panelView === 'side-chat')

  useEffect(() => {
    setSideChatOpen(sideChatActive)
  }, [sideChatActive, setSideChatOpen])

  useEffect(() => {
    if (!sideChatActive) return
    void ensureSideChatForActiveMain()
  }, [sideChatActive, activeSessionFile, draftId, ensureSideChatForActiveMain])

  // The panel is a column of the grid; it only floats over the conversation
  // when the window is too narrow to give it a column of its own.
  const neededWidth = (sidebarOpen ? sidebarWidth : 0) + drawerWidth + 480
  const inspectorOverlay = windowWidth < neededWidth
  // When the docked right ToolPanel narrows the main stage below 760px,
  // auto-fold `.task-rail` so the main conversation keeps a readable column;
  // restore the user's preference when space returns or the panel closes.
  const mainAvailableWidth =
    windowWidth - (sidebarOpen ? sidebarWidth : 0) - (changesOpen && !inspectorOverlay ? drawerWidth : 0)
  const narrowMainStage = Boolean(
    !deskPage && changesOpen && !inspectorOverlay && mainAvailableWidth < 760
  )
  const effectiveTaskRailOpen = narrowMainStage ? (narrowTaskOverride ?? false) : taskRailOpen

  useEffect(() => {
    if (!narrowMainStage) setNarrowTaskOverride(null)
  }, [narrowMainStage])

  useEffect(() => {
    if (effectiveTaskRailOpen) {
      if (taskPanelCloseTimer.current !== null) {
        window.clearTimeout(taskPanelCloseTimer.current)
        taskPanelCloseTimer.current = null
      }
      setTaskPanelMounted(true)
      return
    }
    taskPanelCloseTimer.current = window.setTimeout(() => {
      taskPanelCloseTimer.current = null
      setTaskPanelMounted(false)
    }, INSPECTOR_EXIT_MS)
    return () => {
      if (taskPanelCloseTimer.current !== null) {
        window.clearTimeout(taskPanelCloseTimer.current)
        taskPanelCloseTimer.current = null
      }
    }
  }, [effectiveTaskRailOpen])

  useEffect(() => {
    if (hasActiveUiRequest) setExtensionDialogMounted(true)
  }, [hasActiveUiRequest])

  const toggleSidebar = useCallback(() => setSidebarOpen((value) => !value), [])
  const toggleTaskPanel = useCallback(() => {
    // A narrow-stage press is also the reader's preference: syncing the base
    // value keeps the rail where they just put it when the panel closes and the
    // stage widens again. See `lib/task-rail.ts`.
    const next = toggleTaskRail({
      narrow: narrowMainStage,
      narrowOverride: narrowTaskOverride,
      base: taskRailOpen
    })
    setNarrowTaskOverride(next.narrowOverride)
    setTaskRailOpen(next.base)
  }, [narrowMainStage, narrowTaskOverride, taskRailOpen])
  const handleNewChat = useCallback(() => void newChat(), [newChat])
  const handleNewProject = useCallback(
    () => openProjectDialog({ mode: 'create' }),
    [openProjectDialog]
  )
  const handleExportConversation = useCallback(() => void exportSession(), [exportSession])
  const handleExportMarkdown = useCallback(() => void exportSessionMarkdown(), [exportSessionMarkdown])
  const handleOpenSessionTree = useCallback(() => setSessionTreeOpen(true), [])
  const handleCompact = useCallback(() => void compact(), [compact])
  const handleOpenLauncher = useCallback(() => setLauncherOpen(true), [])
  const openSettings = useCallback((page: SettingsPage = 'general') => {
    setSettingsPage(page)
    setSettingsOpen(true)
  }, [])
  const openShortcuts = useCallback(() => setShortcutsOpen(true), [])
  const openAbout = useCallback(() => openSettings('about'), [openSettings])
  /**
   * The conversation search belongs to `Thread`, which owns the query and the
   * hits. The menu asks for it through the same keyboard door the chord uses,
   * so there is still one implementation of "search this conversation".
   */
  const searchConversation = useCallback(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
  }, [])
  const closeChanges = useCallback(() => {
    // A close the reader aimed at (the panel's own X, Escape, its last page, the
    // chord that opened it) removes the control that held the keyboard, and the
    // next Tab then starts at the top of the app. The corner toggle is the
    // panel's door in both directions, so focus comes back to it. A close driven
    // from elsewhere — a conversation switch, a desk page — keeps the focus
    // where the reader put it, and a floating panel is a dialog whose own hook
    // already returns focus to the control that opened it.
    const active = document.activeElement
    const fromPanel = active instanceof HTMLElement && Boolean(active.closest('.tool-panel'))
    setChangesOpen(false)
    if (fromPanel && !inspectorOverlay) {
      requestAnimationFrame(() => panelToggleRef.current?.focus())
    }
  }, [inspectorOverlay])
  /**
   * Open one tool of the side panel.
   *
   * `files` is not a view of its own any more: the panel's menu has it, and a
   * request for a changed file lands in the changes tool, so the file viewer
   * still has a panel to be drawn in.
   */
  const openInspector = useCallback((view: ToolPanelView) => {
    setDeskPage(null)
    setPanelView(view)
    setInspectorFile(null)
    setChangesOpen(true)
  }, [setDeskPage])
  const openChanges = useCallback(() => openInspector('changes'), [openInspector])
  const openFiles = useCallback(() => openInspector('files'), [openInspector])
  const openBrowser = useCallback(() => openInspector('browser'), [openInspector])
  const openSwarm = useCallback(() => openInspector('swarm'), [openInspector])
  const openSideChat = useCallback(
    (request?: Omit<SideChatOpenRequest, 'seq'> & { seq?: number }) => {
      setDeskPage(null)
      setSideChatMounted(true)
      setPanelView('side-chat')
      setChangesOpen(true)
      if (request) {
        sideChatSeqRef.current += 1
        setSideChatRequest({
          ...request,
          seq: sideChatSeqRef.current
        })
      }
    },
    [setDeskPage]
  )
  const toggleSideChat = useCallback(() => {
    setDeskPage(null)
    if (changesOpen && !panelConcealed && panelView === 'side-chat') {
      // Closing from inside the side chat removes the control that held the
      // keyboard: `closeChanges` hands it back to the panel's corner toggle.
      closeChanges()
      return
    }
    openSideChat({ mode: 'open', focus: true })
  }, [changesOpen, closeChanges, openSideChat, panelConcealed, panelView, setDeskPage])
  /**
   * One child's transcript, opened on the Subagents page of the side panel.
   * The title badge and the task rail share this door, so neither keeps a
   * second copy of the selection rules.
   */
  const openSubagentTask = useCallback((taskId: string) => {
    setDeskPage(null)
    setSubagentSelection({ sessionKey: activeSessionFile ?? draftId ?? '', taskId })
    setPanelView('subagents')
    setChangesOpen(true)
  }, [activeSessionFile, draftId, setDeskPage])
  /** The whole subagent catalog, without a child selected. */
  const openSubagentPanel = useCallback(() => {
    setDeskPage(null)
    setSubagentSelection(null)
    setPanelView('subagents')
    setChangesOpen(true)
  }, [setDeskPage])
  /** `Ctrl+\`` and the title bar: show the terminal, or close it if it is up. */
  const toggleTerminal = useCallback(() => {
    setDeskPage(null)
    if (changesOpen && panelView === 'terminal') {
      // Focus is in the shell, which is about to go: hand the keyboard back to
      // the panel's corner toggle instead of dropping it on <body>.
      closeChanges()
      return
    }
    setPanelView('terminal')
    setChangesOpen(true)
  }, [changesOpen, closeChanges, panelView, setDeskPage])
  const openGeneralSettings = useCallback(() => openSettings(), [openSettings])
  const toggleMarketplace = useCallback(
    () => setDeskPage(useAppStore.getState().deskPage === 'marketplace' ? null : 'marketplace'),
    [setDeskPage]
  )
  const toggleScheduledTasks = useCallback(
    () => setDeskPage(useAppStore.getState().deskPage === 'scheduled' ? null : 'scheduled'),
    [setDeskPage]
  )
  const openMarketplace = useCallback(() => setDeskPage('marketplace'), [setDeskPage])
  const closeLauncher = useCallback(() => setLauncherOpen(false), [])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), [])
  const closeSessionTree = useCallback(() => setSessionTreeOpen(false), [])
  const closeMcp = useCallback(() => setMcpOpen(false), [])
  const handlePanelViewChange = useCallback((view: ToolPanelView) => {
    setPanelView(view)
    // The Files page keeps the open file while the reader visits
    // another page; its tree is the way back to the same preview.
    if (view !== 'files') setInspectorFile(null)
  }, [])
  const handlePanelResizeEnd = useCallback(
    (width: number) => {
      setDraggedWidth(null)
      void updateSettings({ drawerWidth: width })
    },
    [updateSettings]
  )
  const toggleFileTree = useCallback(() => setFileTreeOpen((open) => !open), [])
  const handleSidebarResizeEnd = useCallback(
    (nextWidth: number) => {
      setDraggedSidebar(null)
      void updateSettings({ sidebarWidth: nextWidth })
    },
    [updateSettings]
  )
  const togglePanelFromCorner = useCallback(() => {
    if (changesOpen) setChangesOpen(false)
    else openInspector('start')
  }, [changesOpen, openInspector])
  const filesPanelAction = useMemo(
    () => (
      <button
        type="button"
        className="tool-panel__action"
        aria-label={fileTreeOpen ? t('Hide file tree') : t('Show file tree')}
        title={fileTreeOpen ? t('Hide file tree') : t('Show file tree')}
        aria-pressed={fileTreeOpen}
        data-active={fileTreeOpen || undefined}
        onClick={toggleFileTree}
      >
        <FolderTree size={16} strokeWidth={1.7} />
      </button>
    ),
    [fileTreeOpen, t, toggleFileTree]
  )
  const launcherShell = useMemo<LauncherShell>(
    () => ({
      sidebarOpen,
      toggleSidebar,
      openSettings,
      openShortcuts,
      openMarketplace
    }),
    [sidebarOpen, toggleSidebar, openSettings, openShortcuts, openMarketplace]
  )

  // The sidebar lists disk sessions plus live threads, so a chat Pi has not
  // flushed yet still has a name there. The title bar must resolve the same
  // row, or it falls back to the project name while the sidebar shows the
  // conversation's first prompt.
  const conversationTitle = useAppStore((state) =>
    activeConversationTitle(state.sessions, state.threads, state.activeSessionFile ?? state.draftId)
  )
  const title = sessionName || conversationTitle || workspace?.name || 'Pi Desktop'

  const canRename = Boolean(hasItems || activeSessionFile || sessionName)

  const startRename = useCallback(() => {
    setDraft(sessionName || conversationTitle || '')
    setRenaming(true)
  }, [sessionName, conversationTitle])

  const handleSaveRename = useCallback(() => {
    setRenaming(false)
    const trimmed = draft.trim()
    const currentName = sessionName || conversationTitle || ''
    if (trimmed && trimmed !== currentName) {
      void renameSession(trimmed)
    }
  }, [draft, sessionName, conversationTitle, renameSession])

  useEffect(() => {
    let active = true
    void bootstrap().finally(() => {
      if (active) setBootstrapComplete(true)
    })
    return () => {
      active = false
    }
  }, [bootstrap])

  useEffect(() => {
    if (!bootstrapComplete) return
    window.pi.app.startupReady()
    const frame = window.requestAnimationFrame(dismissStartupScreen)
    return () => window.cancelAnimationFrame(frame)
  }, [bootstrapComplete])

  // Chromium can fail to find the platform emoji font through a broken
  // registry entry (this Windows image has Segoe UI Emoji registered with an
  // empty path). The main process hands us the font bytes; registering them
  // through the FontFace API makes every emoji in the UI draw instead of a
  // tofu box, without bundling a copyrighted system font.
  useEffect(() => {
    let cancelled = false
    void window.pi.app
      .emojiFont()
      .then(async (data) => {
        if (!data || cancelled) return
        try {
          const face = new FontFace('Pi Desktop Emoji', new Uint8Array(data).buffer)
          await face.load()
          if (!cancelled) document.fonts.add(face)
        } catch {
          /* The CSS fallback stack still works when the OS has no emoji font. */
        }
      })
      .catch(() => {
        /* The bridge is optional for this visual enhancement. */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      const { settings, info } = useAppStore.getState()
      if ((info?.forcedTheme ?? settings.theme) === 'system') {
        applyAppearance(settings, info?.forcedTheme)
      }
    }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.lang = language
    const platform = useAppStore.getState().info?.platform
    if (platform) root.dataset.platform = platform
  }, [info, language])

  // Development aid: open the changes drawer for screenshots.
  useEffect(() => {
    const dev = (
      window as unknown as {
        __piDesktopDev?: {
          openChanges?: boolean
          openFiles?: boolean
          openFile?: string
          session?: string
          settings?: boolean
          openTerminal?: boolean
          openSideChat?: boolean
        }
      }
    ).__piDesktopDev
    if (dev?.openSideChat) openSideChat({ mode: 'open' })
    if (dev?.openTerminal) openInspector('terminal')
    if (dev?.settings) {
      setSettingsOpen(true)
      return
    }
    if (dev?.openFile) {
      setPanelView('files')
      setChangesOpen(true)
      return
    }
    if (dev?.openFiles) {
      setPanelView('files')
      setChangesOpen(true)
      return
    }
    if (dev?.openChanges) {
      setPanelView('changes')
      setChangesOpen(true)
    }
  }, [openInspector, openSideChat])

  useEffect(() => {
    const dev = (window as unknown as { __piDesktopDev?: { commit?: boolean } }).__piDesktopDev
    if (!dev?.commit || !workspace || devCommitOpenedRef.current) return
    devCommitOpenedRef.current = true
    setPanelView('changes')
    setChangesOpen(true)
    useAppStore.getState().requestCommit()
  }, [workspace])

  // Development aid: resume a specific session so screenshots can show a
  // conversation that already has content.
  useEffect(() => {
    const dev = (window as unknown as { __piDesktopDev?: { session?: string } }).__piDesktopDev
    if (!dev?.session || !workspace) return
    void openWorkspace(workspace, dev.session, 'screenshot-resume')
  }, [workspace, openWorkspace])

  // Development aid: exercise the export path once the session has content.
  useEffect(() => {
    const dev = (
      window as unknown as { __piDesktopDev?: { export?: boolean } }
    ).__piDesktopDev
    if (!dev?.export || exportedRef.current) return
    if (!hasItems || isStreaming) return
    exportedRef.current = true
    void exportSession()
  }, [hasItems, isStreaming, exportSession])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey
      const matches = (id: ShortcutId) =>
        matchesAnyShortcut(event, id, shortcutBindings)
      const launcherToggle = launcherOpen && matches('command-palette')
      if (document.querySelector('[aria-modal="true"]') && !launcherToggle) {
        // The chord that opened a layer closes it again, from anywhere inside
        // it: a modal used to swallow every chord but the launcher's, so
        // `Ctrl+,` could open Settings and never close it.
        if (shortcutsOpen && matches('shortcut-list')) {
          event.preventDefault()
          closeShortcuts()
          return
        }
        if (sessionTreeOpen && matches('session-tree')) {
          event.preventDefault()
          closeSessionTree()
          return
        }
        if (settingsOpen && matches('open-settings')) {
          event.preventDefault()
          closeSettings()
          return
        }
        return
      }
      // The palette has the keyboard while it is open — only the chord that
      // closes it again stays alive.
      if (launcherOpen && !launcherToggle) return
      // A single-line field owns the keyboard for shortcuts that change the
      // view: `Ctrl+N` in a project rename used to start a new chat and throw
      // the typed name away. A task prompt is the same story. Chords that open
      // a layer (the palette, settings, the shortcut list, the session tree)
      // still work, and the composer is the one textarea whose chords are part
      // of writing a prompt.
      if (
        isEditingField(document.activeElement) &&
        !matches('command-palette') &&
        !matches('open-settings') &&
        !matches('shortcut-list') &&
        !matches('session-tree') &&
        // The terminal is a field to every other chord, but its own toggle has
        // to keep working from inside it: opening it moves the keyboard there,
        // and without this the only way back out was the pointer.
        !matches('toggle-terminal')
      ) return
      if (matches('new-chat')) {
        event.preventDefault()
        void newChat()
        return
      }
      if (matches('toggle-sidebar')) {
        event.preventDefault()
        toggleSidebar()
        return
      }
      // The conversation search had one door — a button in the sidebar head —
      // so a collapsed sidebar (or a reader without a pointer) could not reach
      // it. This chord opens the sidebar and asks it for the dialog.
      if (matches('search-chats')) {
        event.preventDefault()
        setSidebarOpen(true)
        setSidebarSearchSignal((value) => value + 1)
        return
      }
      if (matches('focus-composer')) {
        event.preventDefault()
        window.dispatchEvent(new CustomEvent('pi:focus-composer'))
        return
      }
      // `Ctrl+,` is the conventional chord for preferences across editors.
      if (matches('open-settings')) {
        event.preventDefault()
        openSettings()
        return
      }
      // `Ctrl+Shift+L` toggles Side Chat alongside the conversation.
      if (matches('toggle-side-chat')) {
        event.preventDefault()
        toggleSideChat()
        return
      }
      // `Ctrl+\`` is the terminal, in every editor that has one: the side
      // panel opens on it, or closes when it is already showing.
      if (matches('toggle-terminal')) {
        event.preventDefault()
        toggleTerminal()
        return
      }
      if (matches('shortcut-list')) {
        event.preventDefault()
        setShortcutsOpen((value) => !value)
        return
      }
      // `Ctrl+Shift+P` opens the launcher, where everything the app can do
      // is one search away.
      if (matches('command-palette')) {
        event.preventDefault()
        setLauncherOpen((value) => !value)
        return
      }
      // `Ctrl+Shift+T` shows the branches of the conversation.
      if (matches('session-tree')) {
        event.preventDefault()
        setSessionTreeOpen((value) => !value)
        return
      }
      // `Ctrl+P` and `Ctrl+T` walk through the models and the reasoning
      // levels, scoped to Side Chat when focus is inside the side surface.
      if (matches('next-model')) {
        event.preventDefault()
        const inSide = Boolean(
          document.activeElement?.closest('[data-conversation-surface="side"]')
        )
        void cycleModel(1, inSide ? useAppStore.getState().sideSessionKey : undefined)
        return
      }
      if (matches('next-thinking')) {
        event.preventDefault()
        const inSide = Boolean(
          document.activeElement?.closest('[data-conversation-surface="side"]')
        )
        void cycleThinkingLevel(1, inSide ? useAppStore.getState().sideSessionKey : undefined)
        return
      }
      // `Ctrl+1` … `Ctrl+9` jump to the n-th project of the sidebar.
      if (mod && !event.shiftKey && !event.altKey && /^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1
        const { sessions, settings: storeSettings } = useAppStore.getState()
        const projects = sortProjects(
          collectProjects(
            storeSettings.workspaces,
            sessions,
            storeSettings.hiddenProjects,
            storeSettings.projectOrder
          )
        )
        const target = projects[index]
        if (!target) return
        event.preventDefault()
        void switchProject(target.path, { allowWhileRunning: true })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    const onShowShortcuts = () => setShortcutsOpen(true)
    window.addEventListener('pi:show-shortcuts', onShowShortcuts)
    const onRenameSession = () => startRename()
    window.addEventListener('pi:rename-session', onRenameSession)
    // The command palette and the thread can ask for one tool of the panel.
    const onOpenInspector = (event: Event) => {
      const request = (event as CustomEvent<InspectorRequest>).detail
      // A desk page owns the content row; opening a conversation tool has to
      // leave it first, or the panel would be drawn over an unrelated page.
      setDeskPage(null)
      if (request?.tab === 'side-chat') {
        openSideChat({ mode: 'open', focus: true })
        return
      }
      if (request?.tab === 'browser') {
        // A link the reader chose to open inside the app: switch the panel to
        // its Browser page and hand that page the URL to load.
        if (request.url) {
          browserSeqRef.current += 1
          setBrowserUrl({ url: request.url, seq: browserSeqRef.current })
        }
        setPanelView('browser')
        setChangesOpen(true)
        return
      }
      if (request?.tab === 'images') {
        // A deliverable picture goes to the renderer, not the Files viewer.
        if (request.image) {
          imageSeqRef.current += 1
          setImageRequest({ path: request.image, seq: imageSeqRef.current })
        }
        setPanelView('images')
        setChangesOpen(true)
        return
      }
      setPanelView(request?.tab === 'files' ? 'files' : 'changes')
      // A request without a file means the changes list; keeping the previous
      // preview would leave the panel showing that file instead of the list.
      setInspectorFile(request?.file ? { path: request.file, line: request.line } : null)
      setChangesOpen(true)
    }
    window.addEventListener('pi:open-inspector', onOpenInspector)
    // Contextual doors, slash command `/side`, and the launcher can open Side Chat.
    const onOpenSideChat = (event: Event) => {
      const detail = (event as CustomEvent<SideChatOpenRequest | undefined>).detail
      if (detail?.mode === 'toggle' && !detail.reference && !detail.preset && !detail.prompt) {
        toggleSideChat()
        return
      }
      openSideChat(detail ?? { mode: 'open', focus: true })
    }
    window.addEventListener(OPEN_SIDE_CHAT_EVENT, onOpenSideChat)
    // The command palette and the shortcuts dialog can open the drawer too.
    // The command palette and the shortcuts dialog can open the terminal too.
    const onToggleTerminal = () => toggleTerminal()
    window.addEventListener('pi:toggle-terminal', onToggleTerminal)
    // A card in the transcript can hand a command to the drawer: the drawer is
    // mounted here, so the card announces the command instead of calling it.
    const onTerminalRun = (event: Event) => {
      const command = (event as CustomEvent<{ command?: string }>).detail?.command
      if (typeof command !== 'string' || !command.trim()) return
      setDeskPage(null)
      terminalSeqRef.current += 1
      const request = {
        command,
        cwd: useAppStore.getState().workspace?.path ?? '',
        seq: terminalSeqRef.current
      }
      setTerminalRequests((pending) => [...pending, request])
      setPanelView('terminal')
      setChangesOpen(true)
    }
    window.addEventListener('pi:terminal-run', onTerminalRun)
    // The launcher and the `/tree` command ask for the branch dialog.
    const onOpenSessionTree = () => setSessionTreeOpen(true)
    window.addEventListener('pi:open-session-tree', onOpenSessionTree)
    const onOpenLauncher = () => setLauncherOpen(true)
    window.addEventListener('pi:open-launcher', onOpenLauncher)
    // The composer's add menu leads to the app's settings, which the shell owns.
    const onOpenSettingsEvent = () => openSettings()
    window.addEventListener('pi:open-settings', onOpenSettingsEvent)
    // The launcher and the `/mcp` command ask for the server list.
    const onOpenMcp = () => setMcpOpen(true)
    window.addEventListener('pi:open-mcp', onOpenMcp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pi:show-shortcuts', onShowShortcuts)
      window.removeEventListener('pi:rename-session', onRenameSession)
      window.removeEventListener('pi:open-inspector', onOpenInspector)
      window.removeEventListener(OPEN_SIDE_CHAT_EVENT, onOpenSideChat)
      window.removeEventListener('pi:toggle-terminal', onToggleTerminal)
      window.removeEventListener('pi:terminal-run', onTerminalRun)
      window.removeEventListener('pi:open-session-tree', onOpenSessionTree)
      window.removeEventListener('pi:open-launcher', onOpenLauncher)
      window.removeEventListener('pi:open-settings', onOpenSettingsEvent)
      window.removeEventListener('pi:open-mcp', onOpenMcp)
    }
  }, [
    newChat,
    toggleSidebar,
    openSettings,
    shortcutBindings,
    switchProject,
    launcherOpen,
    cycleModel,
    cycleThinkingLevel,
    startRename,
    toggleTerminal,
    openSideChat,
    toggleSideChat,
    setDeskPage,
    shortcutsOpen,
    sessionTreeOpen,
    settingsOpen,
    closeShortcuts,
    closeSessionTree,
    closeSettings
  ])

  // An extension can rename the session window through `setTitle`.
  useEffect(() => {
    document.title = uiTitle ? `${uiTitle} — Pi Desktop` : 'Pi Desktop'
  }, [uiTitle])

  const widgetsAbove = uiWidgets.filter((widget) => widget.placement === 'aboveEditor')
  const widgetsBelow = uiWidgets.filter((widget) => widget.placement === 'belowEditor')

  return (
    <div
      className="app"
      data-sidebar={sidebarOpen ? 'open' : 'collapsed'}
      data-drawer={panelMounted && !panelConcealed ? 'open' : 'closed'}
      data-inspector={inspectorOverlay ? 'overlay' : 'docked'}
      data-empty={showThread ? 'false' : 'true'}
      style={
        {
          '--drawer-w': `${drawerWidth}px`,
          '--sidebar-w': `${sidebarWidth}px`,
          '--sidebar-track': sidebarOpen ? `${sidebarWidth}px` : '0px'
        } as React.CSSProperties
      }
    >
      <AppMenuBar
        sidebarOpen={sidebarOpen}
        taskRailOpen={effectiveTaskRailOpen}
        hasItems={hasItems}
        canCompact={hasItems && status.phase === 'ready' && !isCompacting}
        onToggleSidebar={toggleSidebar}
        onToggleTaskPanel={toggleTaskPanel}
        onNewChat={handleNewChat}
        onNewProject={handleNewProject}
        onExportConversation={handleExportConversation}
        onExportMarkdown={handleExportMarkdown}
        onOpenChanges={openChanges}
        onOpenFiles={openFiles}
        onOpenBrowser={openBrowser}
        onOpenSubagents={openSubagentPanel}
        onToggleSideChat={toggleSideChat}
        onToggleTerminal={toggleTerminal}
        onOpenSessionTree={handleOpenSessionTree}
        onSearchConversation={searchConversation}
        onCompact={handleCompact}
        onOpenSettings={openSettings}
        onOpenShortcuts={openShortcuts}
        onOpenLauncher={handleOpenLauncher}
        onOpenAbout={openAbout}
      />

      {/* A crash in one region must not blank the window: each shell region has
          its own boundary, so the rest of the app stays usable and the failure
          is a row with a Retry, not a dead screen. */}
      <ErrorBoundary scope="Sidebar" inline>
        <Sidebar
          onOpenSettings={openGeneralSettings}
          onOpenPlugins={toggleMarketplace}
          onOpenScheduledTasks={toggleScheduledTasks}
          focusSearchSignal={sidebarSearchSignal}
          width={sidebarWidth}
          open={sidebarOpen}
          onResize={setDraggedSidebar}
          onResizeEnd={handleSidebarResizeEnd}
        />
      </ErrorBoundary>

      <main className="main">
        <div className="titlebar drag-region">
          <div className="titlebar__identity">
            {deskPage ? null : !showThread ? null : renaming ? (
              <input
                className="titlebar__rename no-drag"
                value={draft}
                autoFocus
                onFocus={(event) => event.currentTarget.select()}
                aria-label={t('Rename this conversation')}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={handleSaveRename}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    handleSaveRename()
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setRenaming(false)
                  }
                }}
              />
            ) : canRename ? (
              <button
                type="button"
                className="titlebar__title titlebar__title--editable no-drag"
                onClick={startRename}
                title={`${title} (${t('Click to rename')})`}
                aria-label={`${title} (${t('Click to rename')})`}
              >
                <span className="titlebar__title-text">{title}</span>
              </button>
            ) : (
              <span className="titlebar__title" title={title}>{title}</span>
            )}
            {/* The project and the branch are not repeated here. SessionBar
                already carries both — with a project menu that can switch and a
                BranchMenu that can act — so a second copy in the header was two
                things to keep in sync and had no room to say what it was. The
                header keeps the conversation's name and the app's actions. */}
          </div>
          <div className="titlebar__actions no-drag">
            {/* The side chat is a page of the tool panel, so the toolbar owns
                its door. A second button up here was a control for a panel
                whose own strip already lists it — and it put a chat action in
                the row that only carries the window's own controls. */}
            {!deskPage && hasItems ? (
              <button
                type="button"
                className="icon-btn"
                aria-label={effectiveTaskRailOpen ? t('Hide task status') : t('Show task status')}
                title={effectiveTaskRailOpen ? t('Hide task status') : t('Show task status')}
                aria-pressed={effectiveTaskRailOpen}
                onClick={toggleTaskPanel}
              >
                <ListTodo size={16} strokeWidth={1.6} aria-hidden="true" />
              </button>
            ) : null}
            {!deskPage && hasItems ? (
              <Popover
                align="right"
                width={220}
                renderTrigger={({ open, toggle }) => (
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label={t('More actions')}
                    title={t('More actions')}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    onClick={toggle}
                  >
                    <Ellipsis size={17} strokeWidth={1.6} />
                  </button>
                )}
              >
                {(close) => (
                  <div role="menu" aria-label={t('More actions')}>
                    <button
                      className="popover__item"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        close()
                        startRename()
                      }}
                    >
                      <Pencil size={15} />
                      {t('Rename conversation')}
                    </button>
                    <button
                      className="popover__item"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        close()
                        void exportSession()
                      }}
                    >
                      <Download size={15} />
                      {t('Export this conversation as HTML')}
                    </button>
                    <button
                      className="popover__item"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        close()
                        setSessionTreeOpen(true)
                      }}
                    >
                      <GitBranch size={15} />
                      {t('Session tree')}
                    </button>
                  </div>
                  )}
                </Popover>
              ) : null}
            </div>
        </div>

        {/* Everything below the header shares one container: the drawer
            margin lives here, so this element measures the width the
            conversation actually has to read in. */}
        <div className="main__stage">
          <div
            className="main__body"
            inert={panelMaximized || undefined}
            aria-hidden={panelMaximized || undefined}
          >
          {deskPage ? (
            <div className="desk-page">
              <Suspense fallback={<FeatureLoading />}>
                {deskPage === 'marketplace' ? (
                  <Marketplace />
                ) : (
                  <ScheduledTasksDialog />
                )}
              </Suspense>
            </div>
          ) : (
            <>
              <ErrorBoundary scope="Conversation" inline>
                {!showThread ? <Welcome /> : <Thread />}
              </ErrorBoundary>

              {widgetsAbove.map((widget) => (
                <div className="widget" key={widget.key}>
                  {widget.lines.map((line, index) => (
                    // An extension republishes the whole line list, so a line
                    // keeps its identity across a growing widget by its text; the
                    // index only disambiguates two identical lines.
                    <span key={`${line}-${index}`}>{line}</span>
                  ))}
                </div>
              ))}

              <ErrorBoundary scope="Composer" inline>
                <Composer onOpenSwarm={openSwarm} />
              </ErrorBoundary>

              {widgetsBelow.map((widget) => (
                <div className="widget widget--below" key={widget.key}>
                  {widget.lines.map((line, index) => (
                    <span key={`${line}-${index}`}>{line}</span>
                  ))}
                </div>
              ))}
            </>
          )}
          </div>
          {!deskPage && hasItems ? (
            <aside
              className="task-rail"
              data-open={effectiveTaskRailOpen || undefined}
              aria-hidden={!effectiveTaskRailOpen || panelMaximized || undefined}
              inert={!effectiveTaskRailOpen || panelMaximized || undefined}
              aria-label={t('Task status')}
            >
              <div className="task-rail__body">
                {taskPanelMounted ? (
                  <ErrorBoundary scope="Task status" inline>
                    <TaskPanel onOpenTask={openSubagentTask} />
                  </ErrorBoundary>
                ) : null}
              </div>
            </aside>
          ) : null}
        </div>
      </main>

      {panelMounted ? (
        <>
          {inspectorOverlay && !panelConcealed ? (
            <button
              className="inspector-scrim"
              data-closing={panelClosing || undefined}
              tabIndex={-1}
              aria-label={t('Close the inspector')}
              onClick={closeChanges}
            />
          ) : null}
          <ErrorBoundary scope="Tool panel" inline>
          <ToolPanel
            view={panelView}
            onViewChange={handlePanelViewChange}
            onMaximizedChange={setPanelMaximized}
            onViewClosed={(closed) => {
              if (closed === 'side-chat') setSideChatMounted(false)
              if (closed === 'browser') setBrowserMounted(false)
              if (closed === 'terminal') {
                setTerminalMounted(false)
                setTerminalRequests([])
              }
            }}
            concealed={panelConcealed}
            className={[inspectorOverlay ? 'tool-panel--overlay' : '', panelClosing ? 'tool-panel--closing' : '']
              .filter(Boolean)
              .join(' ')}
            overlay={inspectorOverlay}
            width={drawerWidth}
            onClose={closeChanges}
            onResize={setDraggedWidth}
            onResizeEnd={handlePanelResizeEnd}
            actions={panelView === 'files' ? filesPanelAction : null}
          >
            <Suspense fallback={<FeatureLoading />}>
              {panelView === 'side-chat' || panelView === 'terminal' || panelView === 'browser' ? null : panelView === 'images' ? (
                <ImageViewer request={imageRequest} />
              ) : panelView === 'subagents' ? (
                <SubagentPanel selected={subagentSelection} onSelectTask={setSubagentSelection} />
              ) : panelView === 'swarm' ? (
                <SwarmPanel />
              ) : panelView === 'files' || panelView === 'changes' || panelView === 'review' ? (
                <InspectorPanel
                  embedded
                  overlay={false}
                  initialTab={inspectorTab}
                  file={inspectorFile}
                  onOpenFile={setInspectorFile}
                  onClose={closeChanges}
                  fileTreeOpen={fileTreeOpen}
                />
              ) : null}
            </Suspense>
            {sideChatMounted ? (
              <div
                className="tool-panel__side-chat"
                data-active={panelView === 'side-chat' || undefined}
              >
                <Suspense fallback={<FeatureLoading />}>
                  <SideChatPanel
                    active={sideChatActive}
                    request={sideChatRequest}
                    onClose={closeChanges}
                  />
                </Suspense>
              </div>
            ) : null}
            {browserMounted ? (
              <div
                className="tool-panel__browser"
                data-active={panelView === 'browser' || undefined}
              >
                <Suspense fallback={<FeatureLoading />}>
                  <BrowserView request={browserUrl} />
                </Suspense>
              </div>
            ) : null}
            {terminalMounted ? (
              <div
                className="tool-panel__terminal"
                data-active={panelView === 'terminal' || undefined}
              >
                <Suspense fallback={<FeatureLoading />}>
                  <TerminalPanel
                    embedded
                    request={terminalRequests[0]}
                    onRequestHandled={finishTerminalRequest}
                    onClose={closeChanges}
                  />
                </Suspense>
              </div>
            ) : null}
          </ToolPanel>
          </ErrorBoundary>
        </>
      ) : null}
      {/* One toggle for the side panel, pinned to the corner of the content
          row. It used to live in whichever header was nearest — the main
          title bar while the panel was gone, the panel's own head while it was
          up — so opening and closing moved the icon, and the panel's enter/exit
          animation slid and faded it on the way. As a child of the shell it
          keeps the same pixels in every state and the animation cannot reach
          it; the panel reserves the corner it sits in.

          A desk page owns the whole content row, so the toggle is not drawn
          there: its header already carries its own actions in that corner, and
          a tools-panel button over the plugins or schedule page would be a
          control for a surface that is not on screen. */}
      {deskPage ? null : (
        <div
          className="shell__panel-toggle"
          data-hover-muted={panelToggleHoverMuted || undefined}
          onMouseLeave={() => setPanelToggleHoverMuted(false)}
        >
          <button
            ref={panelToggleRef}
            className="icon-btn shell__panel-toggle__btn"
            type="button"
            data-active={changesOpen}
            aria-label={t(changesOpen ? 'Hide tools panel' : 'Show tools panel')}
            title={t(changesOpen ? 'Hide tools panel' : 'Show tools panel')}
            aria-expanded={changesOpen}
            onClick={(event) => {
              if (event.detail > 0) setPanelToggleHoverMuted(true)
              togglePanelFromCorner()
            }}
          >
            <span className="shell__panel-toggle__icon" aria-hidden="true">
              {/* The plain outline is always drawn. The arrow-carrying
                  glyphs are stacked over it and only fade in under the
                  pointer, so the corner stays quiet at rest. */}
              <PanelRight className="shell__panel-toggle__glyph" size={16} strokeWidth={1.7} />
              <PanelRightOpen className="shell__panel-toggle__glyph shell__panel-toggle__glyph--closed" size={16} strokeWidth={1.7} />
              <PanelRightClose className="shell__panel-toggle__glyph shell__panel-toggle__glyph--open" size={16} strokeWidth={1.7} />
            </span>
          </button>
        </div>
      )}
      {settingsOpen ? (
        <Suspense fallback={null}>
          <SettingsDialog
            initialPage={settingsPage}
            onClose={closeSettings}
          />
        </Suspense>
      ) : null}
      {shortcutsOpen ? (
        <Suspense fallback={null}>
          <ShortcutsDialog onClose={closeShortcuts} />
        </Suspense>
      ) : null}
      {launcherOpen ? (
        <Suspense fallback={null}>
          <LauncherDialog shell={launcherShell} onClose={closeLauncher} />
        </Suspense>
      ) : null}
      {sessionTreeOpen ? (
        <Suspense fallback={null}>
          <SessionTreeDialog onClose={closeSessionTree} />
        </Suspense>
      ) : null}
      {mcpOpen ? (
        <Suspense fallback={null}>
          <McpDialog onClose={closeMcp} />
        </Suspense>
      ) : null}
      {projectDialog?.open ? (
        <Suspense fallback={null}>
          <EditProjectDialog
            mode={projectDialog.mode}
            project={projectDialog.project}
            onClose={closeProjectDialog}
          />
        </Suspense>
      ) : null}
      {hasActiveUiRequest || extensionDialogMounted ? (
        <Suspense fallback={null}>
          <ExtensionDialog />
        </Suspense>
      ) : null}
      <UpdateResultDialog />
      <HoverTip />
      <AppToast />
    </div>
  )
}
