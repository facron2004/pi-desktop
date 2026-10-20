import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CopyPlus,
  FileDown,
  Keyboard,
  PanelLeft,
  Pencil,
  RefreshCw,
  SquareTerminal
} from 'lucide-react'
import type { InspectorRequest } from '@shared/types'
import { useAppStore } from './store/useAppStore'
import { collectProjects, sortProjects } from './lib/projects'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { Thread } from './components/Thread'
import { Composer } from './components/Composer'
import { Welcome } from './components/Welcome'
import { SettingsDialog } from './components/SettingsDialog'
import { InspectorPanel } from './components/InspectorPanel'
import { ShortcutsDialog } from './components/ShortcutsDialog'
import { ExtensionDialog } from './components/ExtensionDialog'
import { Launcher, useLauncherActions } from './components/Launcher'
import { TerminalPanel } from './components/TerminalPanel'
import { PlanStrip } from './components/PlanStrip'
import { useT } from './lib/i18n'

export default function App() {
  const bootstrap = useAppStore((state) => state.bootstrap)
  const info = useAppStore((state) => state.info)
  const hasItems = useAppStore((state) => state.items.length > 0)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const status = useAppStore((state) => state.status)
  const piState = useAppStore((state) => state.piState)
  const pickWorkspace = useAppStore((state) => state.pickWorkspace)
  const newChat = useAppStore((state) => state.newChat)
  const openWorkspace = useAppStore((state) => state.openWorkspace)
  const renameSession = useAppStore((state) => state.renameSession)
  const duplicateSession = useAppStore((state) => state.duplicateSession)
  const exportSession = useAppStore((state) => state.exportSession)
  const workspace = useAppStore((state) => state.workspace)
  const uiStatuses = useAppStore((state) => state.uiStatuses)
  const uiWidgets = useAppStore((state) => state.uiWidgets)
  const uiTitle = useAppStore((state) => state.uiTitle)
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const sessions = useAppStore((state) => state.sessions)
  const activeSessionFile = useAppStore((state) => state.activeSessionFile)
  const switchProject = useAppStore((state) => state.switchProject)
  const retry = useAppStore((state) => state.retry)
  const abortRetry = useAppStore((state) => state.abortRetry)
  const cycleModel = useAppStore((state) => state.cycleModel)
  const cycleThinkingLevel = useAppStore((state) => state.cycleThinkingLevel)
  const t = useT()

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [changesOpen, setChangesOpen] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<'changes' | 'files'>('changes')
  const [inspectorFile, setInspectorFile] = useState<{ path: string; line?: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const exportedRef = useRef(false)
  // Null while the panel is being dragged; the stored width takes over again
  // once the drag ends.
  const [draggedWidth, setDraggedWidth] = useState<number | null>(null)
  const drawerWidth = draggedWidth ?? settings.drawerWidth ?? 420
  const [draggedSidebar, setDraggedSidebar] = useState<number | null>(null)
  const sidebarWidth = draggedSidebar ?? settings.sidebarWidth ?? 272

  const toggleSidebar = useCallback(() => setSidebarOpen((value) => !value), [])
  const openSettings = useCallback(() => setSettingsOpen(true), [])
  const openShortcuts = useCallback(() => setShortcutsOpen(true), [])
  const launcherActions = useLauncherActions({
    sidebarOpen,
    toggleSidebar,
    openSettings,
    openShortcuts
  })

  const startRename = useCallback(() => {
    setDraft(piState?.sessionName ?? '')
    setRenaming(true)
  }, [piState?.sessionName])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

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
    if (dev?.openTerminal) setTerminalOpen(true)
    if (dev?.commit) {
      setInspectorTab('changes')
      setChangesOpen(true)
      useAppStore.getState().requestCommit()
    }
    if (dev?.settings) {
      setSettingsOpen(true)
      return
    }
    if (dev?.openFile) {
      setInspectorTab('files')
      setChangesOpen(true)
      return
    }
    if (dev?.openFiles) {
      setInspectorTab('files')
      setChangesOpen(true)
      return
    }
    if (dev?.openChanges) setChangesOpen(true)
  }, [])

  // Development aid: resume a specific session so screenshots can show a
  // conversation that already has content.
  useEffect(() => {
    const dev = (window as unknown as { __piDesktopDev?: { session?: string } }).__piDesktopDev
    if (!dev?.session || !workspace) return
    void openWorkspace(workspace, dev.session)
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
      if (document.querySelector('[aria-modal="true"]')) return
      const mod = event.ctrlKey || event.metaKey
      // The palette has the keyboard while it is open — only the chord that
      // closes it again stays alive.
      if (launcherOpen && !(mod && event.shiftKey && event.key.toLowerCase() === 'p')) return
      if (mod && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void newChat()
        return
      }
      if (mod && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        toggleSidebar()
        return
      }
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        window.dispatchEvent(new CustomEvent('pi:focus-composer'))
        return
      }
      // `Ctrl+\`` is the terminal drawer, in every editor that has one.
      if (mod && !event.shiftKey && (event.key === '`' || event.code === 'Backquote')) {
        event.preventDefault()
        setTerminalOpen((value) => !value)
        return
      }
      if (mod && event.key === '/') {
        event.preventDefault()
        setShortcutsOpen((value) => !value)
        return
      }
      // `Ctrl+Shift+P` opens the launcher, where everything the app can do
      // is one search away.
      if (mod && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setLauncherOpen((value) => !value)
        return
      }
      // `Ctrl+P` and `Ctrl+T` walk through the models and the reasoning
      // levels, the way they do in Pi's own terminal.
      if (mod && !event.shiftKey && !event.altKey) {
        if (event.key.toLowerCase() === 'p') {
          event.preventDefault()
          void cycleModel(1)
          return
        }
        if (event.key.toLowerCase() === 't') {
          event.preventDefault()
          void cycleThinkingLevel(1)
          return
        }
      }
      // `Ctrl+1` … `Ctrl+9` jump to the n-th project of the sidebar.
      if (mod && !event.shiftKey && !event.altKey && /^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1
        const projects = sortProjects(
          collectProjects(settings.workspaces, sessions),
          workspace?.path
        )
        const target = projects[index]
        if (!target) return
        event.preventDefault()
        void switchProject(target.path)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    const onShowShortcuts = () => setShortcutsOpen(true)
    window.addEventListener('pi:show-shortcuts', onShowShortcuts)
    const onRenameSession = () => startRename()
    window.addEventListener('pi:rename-session', onRenameSession)
    // The command palette and the thread can ask for the inspector.
    const onOpenInspector = (event: Event) => {
      const request = (event as CustomEvent<InspectorRequest>).detail
      setInspectorTab(request?.tab === 'files' ? 'files' : 'changes')
      if (request?.file) setInspectorFile({ path: request.file, line: request.line })
      setChangesOpen(true)
    }
    window.addEventListener('pi:open-inspector', onOpenInspector)
    // The command palette and the shortcuts dialog can open the drawer too.
    const onToggleTerminal = () => setTerminalOpen((value) => !value)
    window.addEventListener('pi:toggle-terminal', onToggleTerminal)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pi:show-shortcuts', onShowShortcuts)
      window.removeEventListener('pi:rename-session', onRenameSession)
      window.removeEventListener('pi:open-inspector', onOpenInspector)
      window.removeEventListener('pi:toggle-terminal', onToggleTerminal)
    }
  }, [
    newChat,
    toggleSidebar,
    settings.workspaces,
    sessions,
    workspace?.path,
    switchProject,
    launcherOpen,
    cycleModel,
    cycleThinkingLevel,
    startRename
  ])

  // The title of a conversation is its name, and the first line of it when
  // it was never named. The project is shown next to it, so two conversations
  // of the same project do not look alike.
  const activeSession = useMemo(
    () => sessions.find((session) => session.file === activeSessionFile),
    [sessions, activeSessionFile]
  )
  const title =
    piState?.sessionName ||
    activeSession?.name ||
    activeSession?.preview ||
    workspace?.name ||
    'Pi Desktop'
  const showProject = Boolean(workspace && title !== workspace.name)

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
      data-drawer={changesOpen ? 'open' : 'closed'}
      style={
        {
          '--drawer-w': `${drawerWidth}px`,
          '--sidebar-w': `${sidebarWidth}px`
        } as React.CSSProperties
      }
    >
      {sidebarOpen ? (
        <Sidebar
          onOpenSettings={() => setSettingsOpen(true)}
          onResize={setDraggedSidebar}
          onResizeEnd={(width) => {
            setDraggedSidebar(null)
            void updateSettings({ sidebarWidth: width })
          }}
        />
      ) : null}

      <main className="main">
        <div className="titlebar drag-region">
          <button
            className="icon-btn no-drag"
            title={t('Toggle sidebar')}
            onClick={() => setSidebarOpen((value) => !value)}
          >
            <PanelLeft size={15} />
          </button>
          {renaming ? (
            <input
              className="titlebar__rename"
              value={draft}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => {
                setRenaming(false)
                void renameSession(draft)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  setRenaming(false)
                  void renameSession(draft)
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setRenaming(false)
                }
              }}
            />
          ) : (
            <>
              <span className="titlebar__title">{title}</span>
              {showProject && workspace ? (
                <span className="titlebar__project" title={workspace.path}>
                  {workspace.name}
                </span>
              ) : null}
              <button
                className="icon-btn no-drag"
                title={t('Rename this conversation')}
                onClick={startRename}
              >
                <Pencil size={12} />
              </button>
            </>
          )}
          <span className="titlebar__spacer" />
          <div className="titlebar__actions no-drag">
            <button
              className="icon-btn"
              title={t('Open or close the terminal')}
              data-active={terminalOpen}
              onClick={() => setTerminalOpen((value) => !value)}
            >
              <SquareTerminal size={14} />
            </button>
            <button
              className="icon-btn"
              title={t('Keyboard shortcuts')}
              onClick={() => setShortcutsOpen(true)}
            >
              <Keyboard size={14} />
            </button>
            <button
              className="icon-btn"
              title={t('Duplicate this conversation')}
              disabled={status.phase !== 'ready' || !hasItems}
              onClick={() => void duplicateSession()}
            >
              <CopyPlus size={14} />
            </button>
            <button
              className="icon-btn"
              title={t('Export this conversation as HTML')}
              disabled={status.phase !== 'ready' || !hasItems}
              onClick={() => void exportSession()}
            >
              <FileDown size={14} />
            </button>
            <button
              className="icon-btn"
              title={t('Restart the Pi runtime')}
              onClick={() => {
                if (workspace) void openWorkspace(workspace)
              }}
            >
              <RefreshCw size={14} />
            </button>
          </div>
        </div>

        {status.phase === 'ready' ? (
          <TopBar
            onOpenChanges={() => {
              setInspectorTab('changes')
              setInspectorFile(null)
              setChangesOpen(true)
            }}
            onOpenFiles={() => {
              setInspectorTab('files')
              setInspectorFile(null)
              setChangesOpen(true)
            }}
          />
        ) : null}

        {!hasItems ? (
          <Welcome onPick={() => void pickWorkspace()} />
        ) : (
          <Thread />
        )}

        {retry ? (
          <div className="retry-wrap">
            <div className="retry" role="status">
              <RefreshCw size={13} className="spin" />
              <span className="retry__text">
                {t('Pi is retrying')}
                {retry.maxAttempts
                  ? ` (${t('attempt')} ${retry.attempt} ${t('of')} ${retry.maxAttempts})`
                  : ` (${t('attempt')} ${retry.attempt})`}
                {retry.errorMessage ? ` — ${retry.errorMessage}` : ''}
              </span>
              <button className="ghost-btn" onClick={() => void abortRetry()}>
                {t('Stop retrying')}
              </button>
            </div>
          </div>
        ) : null}

        {uiStatuses.length > 0 ? (
          <div className="status-strip">
            {uiStatuses.map((entry) => (
              <span className="status-strip__item" key={entry.key}>
                <span className="status-strip__dot" />
                {entry.text}
              </span>
            ))}
          </div>
        ) : null}

        {widgetsAbove.map((widget) => (
          <div className="widget" key={widget.key}>
            {widget.lines.map((line, index) => (
              <span key={index}>{line}</span>
            ))}
          </div>
        ))}

        <PlanStrip />

        {terminalOpen ? <TerminalPanel onClose={() => setTerminalOpen(false)} /> : null}

        <Composer />

        {widgetsBelow.map((widget) => (
          <div className="widget widget--below" key={widget.key}>
            {widget.lines.map((line, index) => (
              <span key={index}>{line}</span>
            ))}
          </div>
        ))}
      </main>

      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
      {shortcutsOpen ? <ShortcutsDialog onClose={() => setShortcutsOpen(false)} /> : null}
      {launcherOpen ? (
        <Launcher actions={launcherActions} onClose={() => setLauncherOpen(false)} />
      ) : null}
      <ExtensionDialog />
      {changesOpen ? (
        <InspectorPanel
          initialTab={inspectorTab}
          file={inspectorFile}
          onOpenFile={setInspectorFile}
          onClose={() => setChangesOpen(false)}
          onResize={setDraggedWidth}
          onResizeEnd={(width) => {
            setDraggedWidth(null)
            void updateSettings({ drawerWidth: width })
          }}
        />
      ) : null}
    </div>
  )
}
