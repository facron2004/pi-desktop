import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
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
  Pencil,
  TriangleAlert
} from 'lucide-react'
import type { InspectorRequest } from '@shared/types'
import { applyAppearance, useAppStore } from './store/useAppStore'
import { collectProjects, sortProjects } from './lib/projects'
import { Sidebar } from './components/Sidebar'
import { Thread } from './components/Thread'
import { Composer } from './components/Composer'
import { Welcome } from './components/Welcome'
import { SettingsDialog, type SettingsPage } from './components/SettingsDialog'
import { AppMenuBar } from './components/AppMenuBar'
import { AppUpdateDialog } from './components/AppUpdateDialog'
import { BrowserView } from './components/BrowserView'
import { ImageViewer } from './components/ImageViewer'
import { ImageGeneration } from './components/ImageGeneration'
import { TaskPanel } from './components/TaskPanel'
import { SubagentPanel, type SubagentSelection } from './components/SubagentPanel'
import { TitleSubagents } from './components/TitleSubagents'
import { ToolPanel, type ToolPanelView } from './components/ToolPanel'
import { ShortcutsDialog } from './components/ShortcutsDialog'
import { ExtensionDialog } from './components/ExtensionDialog'
import { Launcher, useLauncherActions } from './components/Launcher'
import type { TerminalRunRequest } from './components/TerminalPanel'
import { GoalBar } from './components/GoalBar'
import { SessionTreeDialog } from './components/SessionTreeDialog'
import { McpDialog } from './components/McpDialog'
import { FeatureLoading } from './components/FeatureLoading'
import { EditProjectDialog } from './components/EditProjectDialog'
import { Popover } from './components/Popover'
import { matchesAnyShortcut, type ShortcutId } from './lib/shortcuts'
import { activeConversationTitle } from './lib/live-sessions'
import { openingLabel, useT } from './lib/i18n'
import { dismissStartupScreen } from './lib/startup-screen'

const InspectorPanel = lazy(() => import('./components/InspectorPanel').then((m) => ({ default: m.InspectorPanel })))
const TerminalPanel = lazy(() => import('./components/TerminalPanel').then((m) => ({ default: m.TerminalPanel })))
const ScheduledTasksDialog = lazy(() => import('./components/ScheduledTasksDialog').then((m) => ({ default: m.ScheduledTasksDialog })))
const Marketplace = lazy(() => import('./components/Marketplace').then((m) => ({ default: m.Marketplace })))

/** Matches the closing animation in global.css; the panel stays mounted that long. */
const INSPECTOR_EXIT_MS = 200
const AUTOMATIC_UPDATE_INTERVAL_MS = 12 * 60 * 60 * 1000

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
  const workspace = useAppStore((state) => state.workspace)
  const uiWidgets = useAppStore((state) => state.uiWidgets)
  const uiTitle = useAppStore((state) => state.uiTitle)
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const sessions = useAppStore((state) => state.sessions)
  const activeSessionFile = useAppStore((state) => state.activeSessionFile)
  const draftId = useAppStore((state) => state.draftId)
  const switchProject = useAppStore((state) => state.switchProject)
  const hasActiveRun = useAppStore((state) => state.run.phase !== 'idle')
  const isCompacting = useAppStore((state) => Boolean(state.run.compaction))
  const transport = useAppStore((state) => state.transport)
  const cycleModel = useAppStore((state) => state.cycleModel)
  const cycleThinkingLevel = useAppStore((state) => state.cycleThinkingLevel)
  const compact = useAppStore((state) => state.compact)
  const showToast = useAppStore((state) => state.showToast)
  const anySessionStreaming = useAppStore((state) =>
    Object.values(state.threads).some((thread) => thread.isStreaming)
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
  const [sidebarSearchSignal] = useState(0)
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [sessionTreeOpen, setSessionTreeOpen] = useState(false)
  const [mcpOpen, setMcpOpen] = useState(false)
  const deskPage = useAppStore((state) => state.deskPage)
  const setDeskPage = useAppStore((state) => state.setDeskPage)
  // A command headed for the drawer. `seq` makes the same command twice two
  // requests instead of one the drawer already ran.
  const [terminalRequest, setTerminalRequest] = useState<TerminalRunRequest | null>(null)
  const terminalSeqRef = useRef(0)
  /** Last automatic update check; the effect below re-runs when a run settles. */
  const lastAutomaticUpdateCheck = useRef(0)
  const [changesOpen, setChangesOpen] = useState(false)
  // Independent of Tools: a status card column beside the conversation.
  const [taskRailOpen, setTaskRailOpen] = useState(true)
  // The Files page's tree aside. The panel header owns its toggle, so the
  // control stays put whether the tree is open or folded away.
  const [fileTreeOpen, setFileTreeOpen] = useState(true)
  // Keep the panel mounted for the closing animation; `changesOpen` alone
  // unmounts it on the same frame and the exit would never be seen.
  const [panelMounted, setPanelMounted] = useState(false)
  const [panelClosing, setPanelClosing] = useState(false)
  const panelCloseTimer = useRef<number | null>(null)
  const [panelView, setPanelView] = useState<ToolPanelView>('changes')
  /**
   * The panel's tools are tabs; the terminal is the one tab whose content is a
   * live process. Once it has been opened it stays mounted while another tab
   * is in front, so switching tabs does not kill the shells.
   */
  const [terminalMounted, setTerminalMounted] = useState(false)
  const inspectorTab: 'changes' | 'files' =
    panelView === 'files' ? 'files' : 'changes'
  const [inspectorFile, setInspectorFile] = useState<{ path: string; line?: number } | null>(null)
  const [subagentSelection, setSubagentSelection] = useState<SubagentSelection | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const exportedRef = useRef(false)
  // Null while the panel is being dragged; the stored width takes over again
  // once the drag ends.
  const [draggedWidth, setDraggedWidth] = useState<number | null>(null)
  const drawerWidth = draggedWidth ?? settings.drawerWidth ?? 520
  const [draggedSidebar, setDraggedSidebar] = useState<number | null>(null)
  const sidebarWidth = draggedSidebar ?? settings.sidebarWidth ?? 240
  const [windowWidth, setWindowWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 1280
  )

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    // Do not replace the built-in service while any conversation is using it.
    if (
      settings.automaticUpdates !== true ||
      info?.isPackaged !== false ||
      anySessionStreaming ||
      info?.pi.source !== 'bundled'
    ) return

    let active = true
    let running = false
    const checkAndDownload = async () => {
      if (running) return
      running = true
      lastAutomaticUpdateCheck.current = Date.now()
      try {
        const result = await window.pi.app.checkUpdate()
        if (!active) return
        let downloaded = false
        if (active && result.piCli.hasUpdate) {
          const serviceUpdate = await window.pi.app.upgradePiCli()
          downloaded = downloaded || serviceUpdate.success
        }
        if (active && downloaded) showToast(t('Update downloaded. Restart Pi Desktop to apply.'))
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
      void checkAndDownload()
    }
    const interval = window.setInterval(
      () => void checkAndDownload(),
      AUTOMATIC_UPDATE_INTERVAL_MS
    )
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [anySessionStreaming, info?.pi.source, settings.automaticUpdates, showToast, t])

  useEffect(() => {
    if (changesOpen) {
      if (panelCloseTimer.current !== null) {
        window.clearTimeout(panelCloseTimer.current)
        panelCloseTimer.current = null
      }
      setPanelMounted(true)
      setPanelClosing(false)
      return
    }
    if (!panelMounted) return
    setPanelClosing(true)
    panelCloseTimer.current = window.setTimeout(() => {
      panelCloseTimer.current = null
      setPanelMounted(false)
      setPanelClosing(false)
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

  // Mount the terminal on its first visit and keep it alive afterwards, so a
  // tab switch does not throw away the shells it is running. Closing the whole
  // panel ends them, exactly like closing the drawer used to.
  useEffect(() => {
    if (panelMounted && panelView === 'terminal') setTerminalMounted(true)
  }, [panelMounted, panelView])

  useEffect(() => {
    if (!changesOpen && !panelMounted) setTerminalMounted(false)
  }, [changesOpen, panelMounted])

  // The panel is a column of the grid; it only floats over the conversation
  // when the window is too narrow to give it a column of its own.
  const neededWidth = (sidebarOpen ? sidebarWidth : 0) + drawerWidth + 480
  const inspectorOverlay = windowWidth < neededWidth

  const toggleSidebar = useCallback(() => setSidebarOpen((value) => !value), [])
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
      setChangesOpen(false)
      return
    }
    setPanelView('terminal')
    setChangesOpen(true)
  }, [changesOpen, panelView, setDeskPage])
  const launcherActions = useLauncherActions({
    sidebarOpen,
    toggleSidebar,
    openSettings,
    openShortcuts,
    openMarketplace: () => setDeskPage('marketplace')
  })

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
    root.lang = settings.language
    const platform = useAppStore.getState().info?.platform
    if (platform) root.dataset.platform = platform
  }, [info, settings.language])

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
          commit?: boolean
        }
      }
    ).__piDesktopDev
    if (dev?.openTerminal) openInspector('terminal')
    if (dev?.commit) {
      setPanelView('changes')
      setChangesOpen(true)
      useAppStore.getState().requestCommit()
    }
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
  }, [openInspector])

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
        matchesAnyShortcut(event, id, settings.shortcutBindings)
      const launcherToggle = launcherOpen && matches('command-palette')
      if (document.querySelector('[aria-modal="true"]') && !launcherToggle) return
      // The palette has the keyboard while it is open — only the chord that
      // closes it again stays alive.
      if (launcherOpen && !launcherToggle) return
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
      // levels, the way they do in Pi's own terminal.
      if (matches('next-model')) {
        event.preventDefault()
        void cycleModel(1)
        return
      }
      if (matches('next-thinking')) {
        event.preventDefault()
        void cycleThinkingLevel(1)
        return
      }
      // `Ctrl+1` … `Ctrl+9` jump to the n-th project of the sidebar.
      if (mod && !event.shiftKey && !event.altKey && /^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1
        const projects = sortProjects(
          collectProjects(
            settings.workspaces,
            sessions,
            settings.hiddenProjects,
            settings.projectOrder
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
      setPanelView(request?.tab === 'files' ? 'files' : 'changes')
      // A request without a file means the changes list; keeping the previous
      // preview would leave the panel showing that file instead of the list.
      setInspectorFile(request?.file ? { path: request.file, line: request.line } : null)
      setChangesOpen(true)
    }
    window.addEventListener('pi:open-inspector', onOpenInspector)
    // A tool-panel page can ask for a sibling page (the image generator sends
    // the reader to the Images page without knowing the panel's state).
    const onOpenToolPage = (event: Event) => {
      const view = (event as CustomEvent<{ view?: ToolPanelView }>).detail?.view
      if (!view || view === 'start') return
      setDeskPage(null)
      setPanelView(view)
      setInspectorFile(null)
      setChangesOpen(true)
    }
    window.addEventListener('pi:open-tool-page', onOpenToolPage)
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
      setTerminalRequest({ command, seq: terminalSeqRef.current })
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
      window.removeEventListener('pi:open-tool-page', onOpenToolPage)
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
    settings.workspaces,
    settings.hiddenProjects,
    settings.projectOrder,
    settings.shortcutBindings,
    sessions,
    workspace?.path,
    switchProject,
    launcherOpen,
    cycleModel,
    cycleThinkingLevel,
    startRename,
    toggleTerminal,
    setDeskPage
  ])

  // The handed-over command is a one-shot. Once the terminal is no longer the
  // panel's tool, the request is dropped so coming back to it later does not
  // replay the command.
  useEffect(() => {
    if (!changesOpen || panelView !== 'terminal') setTerminalRequest(null)
  }, [changesOpen, panelView])

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
      data-drawer={panelMounted ? 'open' : 'closed'}
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
        taskRailOpen={taskRailOpen}
        hasItems={hasItems}
        canCompact={hasItems && status.phase === 'ready' && !isCompacting}
        onToggleSidebar={toggleSidebar}
        onToggleTaskPanel={() => setTaskRailOpen((open) => !open)}
        onNewChat={() => void newChat()}
        onNewProject={() => openProjectDialog({ mode: 'create' })}
        onExportConversation={() => void exportSession()}
        onOpenChanges={openChanges}
        onOpenFiles={openFiles}
        onOpenBrowser={() => openInspector('browser')}
        onOpenSubagents={openSubagentPanel}
        onToggleTerminal={toggleTerminal}
        onOpenSessionTree={() => setSessionTreeOpen(true)}
        onSearchConversation={searchConversation}
        onCompact={() => void compact()}
        onOpenSettings={openSettings}
        onOpenShortcuts={openShortcuts}
        onOpenLauncher={() => setLauncherOpen(true)}
        onOpenAbout={openAbout}
      />

      <Sidebar
        onOpenSettings={() => openSettings()}
        onOpenPlugins={() =>
          setDeskPage(deskPage === 'marketplace' ? null : 'marketplace')
        }
        onOpenScheduledTasks={() =>
          setDeskPage(deskPage === 'scheduled' ? null : 'scheduled')
        }
        focusSearchSignal={sidebarSearchSignal}
        width={sidebarWidth}
        open={sidebarOpen}
        onResize={setDraggedSidebar}
        onResizeEnd={(width) => {
          setDraggedSidebar(null)
          void updateSettings({ sidebarWidth: width })
        }}
      />

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
            {/* A conversation that delegated work wears its subagents beside
                the name. The badge is a projection of the active thread, so it
                appears and disappears with the subagent calls themselves. */}
            {!deskPage && hasItems ? (
              <TitleSubagents onOpenTask={openSubagentTask} onOpenAll={openSubagentPanel} />
            ) : null}
            {/* The project and the branch are not repeated here. SessionBar
                already carries both — with a project menu that can switch and a
                BranchMenu that can act — so a second copy in the header was two
                things to keep in sync and had no room to say what it was. The
                header keeps the conversation's name and the app's actions. */}
          </div>
          <div className="titlebar__actions no-drag">
            {!deskPage && hasItems ? (
              <button
                type="button"
                className="icon-btn"
                aria-label={taskRailOpen ? t('Hide task status') : t('Show task status')}
                title={taskRailOpen ? t('Hide task status') : t('Show task status')}
                aria-pressed={taskRailOpen}
                onClick={() => setTaskRailOpen((open) => !open)}
              >
                <ListTodo size={16} strokeWidth={1.6} />
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
          <div className="main__body">
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
              {!showThread ? (
                <Welcome>
                  <Composer />
                </Welcome>
              ) : (
                <Thread />
              )}

              {/* A project switch keeps the previous transcript up. This is the
                  handoff, not a failure — the connection was not lost. */}
              {status.phase === 'starting' && hasItems ? (
                <div className="retry-wrap">
                  <div className="retry" data-kind="handoff" role="status">
                    <span className="spinner" aria-hidden="true" />
                    <span className="retry__text">{openingLabel(workspace, t)}</span>
                  </div>
                </div>
              ) : null}

              {/* The transport is not the run: Pi can still be working behind a
                  broken channel, so this says what is known rather than declaring
                  the run failed. "starting" is a switch in progress. */}
              {transport === 'disconnected' && status.phase !== 'ready' && status.phase !== 'starting' ? (
                <div className="retry-wrap">
                  <div className="retry" data-kind="transport" role="status">
                    <TriangleAlert size={13} />
                    <span className="retry__text">{t('Lost connection to Pi')}</span>
                    {hasActiveRun ? (
                      <span className="retry__note">{t('The run may still be going')}</span>
                    ) : null}
                  </div>
                </div>
              ) : null}

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

              <GoalBar key={activeSessionFile ?? draftId ?? 'draft'} />

              {hasItems ? <Composer /> : null}

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
              data-open={taskRailOpen || undefined}
              aria-hidden={!taskRailOpen || undefined}
              inert={!taskRailOpen || undefined}
              aria-label={t('Task status')}
            >
              <div className="task-rail__body">
                <TaskPanel />
              </div>
            </aside>
          ) : null}
        </div>
      </main>

      {panelMounted ? (
        <>
          {inspectorOverlay ? (
            <button
              className="inspector-scrim"
              data-closing={panelClosing || undefined}
              tabIndex={-1}
              aria-label={t('Close the inspector')}
              onClick={() => setChangesOpen(false)}
            />
          ) : null}
          <ToolPanel
            view={panelView}
            onViewChange={(view) => {
              setPanelView(view)
              // The Files page keeps the open file while the reader visits
              // another page; its tree is the way back to the same preview.
              if (view !== 'files') setInspectorFile(null)
            }}
            className={[inspectorOverlay ? 'tool-panel--overlay' : '', panelClosing ? 'tool-panel--closing' : '']
              .filter(Boolean)
              .join(' ')}
            overlay={inspectorOverlay}
            width={drawerWidth}
            onClose={() => setChangesOpen(false)}
            onResize={setDraggedWidth}
            onResizeEnd={(width) => {
              setDraggedWidth(null)
              void updateSettings({ drawerWidth: width })
            }}
            actions={
              panelView === 'files' ? (
                <button
                  type="button"
                  className="tool-panel__action"
                  aria-label={fileTreeOpen ? t('Hide file tree') : t('Show file tree')}
                  title={fileTreeOpen ? t('Hide file tree') : t('Show file tree')}
                  aria-pressed={fileTreeOpen}
                  data-active={fileTreeOpen || undefined}
                  onClick={() => setFileTreeOpen((open) => !open)}
                >
                  <FolderTree size={18} />
                </button>
              ) : null
            }
          >
            <Suspense fallback={<FeatureLoading />}>
              {panelView === 'terminal' ? null : panelView === 'browser' ? (
                <BrowserView />
              ) : panelView === 'images' ? (
                <ImageViewer />
              ) : panelView === 'imagegen' ? (
                <ImageGeneration />
              ) : panelView === 'subagents' ? (
                <SubagentPanel selected={subagentSelection} onSelectTask={setSubagentSelection} />
              ) : panelView === 'files' || panelView === 'changes' ? (
                <InspectorPanel
                  embedded
                  overlay={false}
                  initialTab={inspectorTab}
                  file={inspectorFile}
                  onOpenFile={setInspectorFile}
                  onClose={() => setChangesOpen(false)}
                  fileTreeOpen={fileTreeOpen}
                />
              ) : null}
            </Suspense>
            {terminalMounted ? (
              <div
                className="tool-panel__terminal"
                data-active={panelView === 'terminal' || undefined}
              >
                <Suspense fallback={<FeatureLoading />}>
                  <TerminalPanel
                    embedded
                    request={panelView === 'terminal' ? terminalRequest : null}
                    onClose={() => setChangesOpen(false)}
                  />
                </Suspense>
              </div>
            ) : null}
          </ToolPanel>
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
        <div className="shell__panel-toggle">
          <button
            className="icon-btn"
            type="button"
            aria-label={t(changesOpen ? 'Hide tools panel' : 'Show tools panel')}
            title={t(changesOpen ? 'Hide tools panel' : 'Show tools panel')}
            aria-expanded={changesOpen}
            onClick={() => (changesOpen ? setChangesOpen(false) : openInspector(panelView))}
          >
            <PanelRight size={16} strokeWidth={1.7} />
          </button>
        </div>
      )}
      {settingsOpen ? (
        <SettingsDialog
          initialPage={settingsPage}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      {shortcutsOpen ? <ShortcutsDialog onClose={() => setShortcutsOpen(false)} /> : null}
      {launcherOpen ? (
        <Launcher actions={launcherActions} onClose={() => setLauncherOpen(false)} />
      ) : null}
      {sessionTreeOpen ? (
        <SessionTreeDialog onClose={() => setSessionTreeOpen(false)} />
      ) : null}
      {mcpOpen ? <McpDialog onClose={() => setMcpOpen(false)} /> : null}
      {projectDialog?.open ? (
        <EditProjectDialog
          mode={projectDialog.mode}
          project={projectDialog.project}
          onClose={closeProjectDialog}
        />
      ) : null}
      <ExtensionDialog />
      <AppUpdateDialog />
    </div>
  )
}
