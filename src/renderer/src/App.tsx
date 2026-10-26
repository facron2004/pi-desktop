import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Download,
  Ellipsis,
  Folder,
  GitBranch,
  GitCompare,
  PanelRight,
  Pencil,
  SquareTerminal,
  RefreshCw,
  TriangleAlert
} from 'lucide-react'
import type { InspectorRequest } from '@shared/types'
import { applyAppearance, useAppStore } from './store/useAppStore'
import { countChangedFiles } from './lib/changes'
import { collectProjects, sortProjects } from './lib/projects'
import { Sidebar } from './components/Sidebar'
import { Thread } from './components/Thread'
import { Composer } from './components/Composer'
import { Welcome } from './components/Welcome'
import { SettingsDialog } from './components/SettingsDialog'
import { AppMenuBar } from './components/AppMenuBar'
import { BranchMenu } from './components/BranchMenu'
import { InspectorPanel } from './components/InspectorPanel'
import { ShortcutsDialog } from './components/ShortcutsDialog'
import { ExtensionDialog } from './components/ExtensionDialog'
import { Launcher, useLauncherActions } from './components/Launcher'
import { TerminalPanel, type TerminalRunRequest } from './components/TerminalPanel'
import { PlanStrip } from './components/PlanStrip'
import { SessionTreeDialog } from './components/SessionTreeDialog'
import { McpDialog } from './components/McpDialog'
import { Popover } from './components/Popover'
import { ConfirmDialog } from './components/ConfirmDialog'
import { useT } from './lib/i18n'

export default function App() {
  const bootstrap = useAppStore((state) => state.bootstrap)
  const info = useAppStore((state) => state.info)
  const hasItems = useAppStore((state) => state.items.length > 0)
  const changedFileCount = useAppStore((state) => countChangedFiles(state.items))
  const git = useAppStore((state) => state.git)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const status = useAppStore((state) => state.status)
  const sessionName = useAppStore((state) => state.piState?.sessionName)
  const pickWorkspace = useAppStore((state) => state.pickWorkspace)
  const newChat = useAppStore((state) => state.newChat)
  const openWorkspace = useAppStore((state) => state.openWorkspace)
  const renameSession = useAppStore((state) => state.renameSession)
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
  const stop = useAppStore((state) => state.stop)
  const selectSession = useAppStore((state) => state.selectSession)
  const retry = useAppStore((state) => state.retry)
  const abortRetry = useAppStore((state) => state.abortRetry)
  const run = useAppStore((state) => state.run)
  const transport = useAppStore((state) => state.transport)
  const cycleModel = useAppStore((state) => state.cycleModel)
  const cycleThinkingLevel = useAppStore((state) => state.cycleThinkingLevel)
  const compact = useAppStore((state) => state.compact)
  const t = useT()

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarSearchSignal] = useState(0)
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [sessionTreeOpen, setSessionTreeOpen] = useState(false)
  const [mcpOpen, setMcpOpen] = useState(false)
  /**
   * A conversation the reader picked while Pi is still working. Opening it
   * would end the run, so the stop is asked for rather than taken — the click
   * itself must never interrupt the agent.
   */
  const [switchRequest, setSwitchRequest] = useState<{ file: string; title: string } | null>(null)
  // A command headed for the drawer. `seq` makes the same command twice two
  // requests instead of one the drawer already ran.
  const [terminalRequest, setTerminalRequest] = useState<TerminalRunRequest | null>(null)
  const terminalSeqRef = useRef(0)
  const [changesOpen, setChangesOpen] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<'changes' | 'files' | 'review'>('changes')
  const [inspectorFile, setInspectorFile] = useState<{ path: string; line?: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const exportedRef = useRef(false)
  // Null while the panel is being dragged; the stored width takes over again
  // once the drag ends.
  const [draggedWidth, setDraggedWidth] = useState<number | null>(null)
  const drawerWidth = draggedWidth ?? settings.drawerWidth ?? 420
  const [draggedSidebar, setDraggedSidebar] = useState<number | null>(null)
  const sidebarWidth = draggedSidebar ?? settings.sidebarWidth ?? 240
  const mainRef = useRef<HTMLElement>(null)
  const [mainWidth, setMainWidth] = useState(0)
  const inspectorOverlay = mainWidth < drawerWidth + 480

  // Sidebar resizing changes the space available without resizing the window.
  useLayoutEffect(() => {
    const main = mainRef.current
    if (!main) return
    setMainWidth(main.clientWidth)
    const observer = new ResizeObserver(([entry]) => setMainWidth(entry.contentRect.width))
    observer.observe(main)
    return () => observer.disconnect()
  }, [])

  const toggleSidebar = useCallback(() => setSidebarOpen((value) => !value), [])
  const openSettings = useCallback(() => setSettingsOpen(true), [])
  const openShortcuts = useCallback(() => setShortcutsOpen(true), [])
  const openInspector = useCallback((tab: 'changes' | 'files' | 'review') => {
    setInspectorTab(tab)
    setInspectorFile(null)
    setChangesOpen(true)
  }, [])
  const gitChangeCount =
    git?.isRepo && git.files.length > 0 ? git.files.length : changedFileCount
  const launcherActions = useLauncherActions({
    sidebarOpen,
    toggleSidebar,
    openSettings,
    openShortcuts
  })

  const startRename = useCallback(() => {
    setDraft(sessionName ?? '')
    setRenaming(true)
  }, [sessionName])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

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
      const mod = event.ctrlKey || event.metaKey
      const launcherToggle =
        launcherOpen && mod && event.shiftKey && event.key.toLowerCase() === 'p'
      if (document.querySelector('[aria-modal="true"]') && !launcherToggle) return
      // The palette has the keyboard while it is open — only the chord that
      // closes it again stays alive.
      if (launcherOpen && !launcherToggle) return
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
      // `Ctrl+Shift+T` shows the branches of the conversation.
      if (mod && event.shiftKey && event.key.toLowerCase() === 't') {
        event.preventDefault()
        setSessionTreeOpen((value) => !value)
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
        const projects = sortProjects(collectProjects(settings.workspaces, sessions))
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
    // A card in the transcript can hand a command to the drawer: the drawer is
    // mounted here, so the card announces the command instead of calling it.
    const onTerminalRun = (event: Event) => {
      const command = (event as CustomEvent<{ command?: string }>).detail?.command
      if (typeof command !== 'string' || !command.trim()) return
      terminalSeqRef.current += 1
      setTerminalRequest({ command, seq: terminalSeqRef.current })
      setTerminalOpen(true)
    }
    window.addEventListener('pi:terminal-run', onTerminalRun)
    // The launcher and the `/tree` command ask for the branch dialog.
    const onOpenSessionTree = () => setSessionTreeOpen(true)
    window.addEventListener('pi:open-session-tree', onOpenSessionTree)
    const onOpenLauncher = () => setLauncherOpen(true)
    window.addEventListener('pi:open-launcher', onOpenLauncher)
    // The launcher and the `/mcp` command ask for the server list.
    const onOpenMcp = () => setMcpOpen(true)
    window.addEventListener('pi:open-mcp', onOpenMcp)
    // The sidebar found a conversation the reader wants while a run is going.
    // Only this component may end that run, so the sidebar asks here.
    const onConfirmSwitchSession = (event: Event) => {
      const detail = (event as CustomEvent<{ file?: string; title?: string }>).detail
      if (!detail?.file) return
      setSwitchRequest({ file: detail.file, title: detail.title ?? '' })
    }
    window.addEventListener('pi:confirm-switch-session', onConfirmSwitchSession)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pi:show-shortcuts', onShowShortcuts)
      window.removeEventListener('pi:rename-session', onRenameSession)
      window.removeEventListener('pi:open-inspector', onOpenInspector)
      window.removeEventListener('pi:toggle-terminal', onToggleTerminal)
      window.removeEventListener('pi:terminal-run', onTerminalRun)
      window.removeEventListener('pi:open-session-tree', onOpenSessionTree)
      window.removeEventListener('pi:open-launcher', onOpenLauncher)
      window.removeEventListener('pi:open-mcp', onOpenMcp)
      window.removeEventListener('pi:confirm-switch-session', onConfirmSwitchSession)
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

  // The handed-over command is a one-shot. Once the drawer is closed, the
  // request is dropped so reopening it later does not replay the command.
  useEffect(() => {
    if (!terminalOpen) setTerminalRequest(null)
  }, [terminalOpen])

  // The title of a conversation is its name, and the first line of it when
  // it was never named. The project is shown next to it, so two conversations
  // of the same project do not look alike.
  const activeSession = useMemo(
    () => sessions.find((session) => session.file === activeSessionFile),
    [sessions, activeSessionFile]
  )
  const title =
    sessionName ||
    activeSession?.name ||
    activeSession?.preview ||
    workspace?.name ||
    'Pi Desktop'
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
      data-inspector={inspectorOverlay ? 'overlay' : 'docked'}
      data-empty={hasItems ? 'false' : 'true'}
      style={
        {
          '--drawer-w': `${drawerWidth}px`,
          '--sidebar-w': `${sidebarWidth}px`
        } as React.CSSProperties
      }
    >
      <AppMenuBar
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
        onNewChat={() => void newChat()}
        onOpenProject={() => void pickWorkspace()}
        onOpenChanges={() => openInspector('changes')}
        onOpenFiles={() => openInspector('files')}
        onCompact={() => void compact()}
        canCompact={hasItems && status.phase === 'ready'}
        onToggleTerminal={() => setTerminalOpen((value) => !value)}
        onOpenSettings={openSettings}
        onOpenShortcuts={openShortcuts}
        onOpenLauncher={() => setLauncherOpen(true)}
      />

      {sidebarOpen ? (
        <Sidebar
          onOpenSettings={() => setSettingsOpen(true)}
          focusSearchSignal={sidebarSearchSignal}
          width={sidebarWidth}
          onResize={setDraggedSidebar}
          onResizeEnd={(width) => {
            setDraggedSidebar(null)
            void updateSettings({ sidebarWidth: width })
          }}
        />
      ) : null}

      <main ref={mainRef} className="main">
        <div className="titlebar drag-region">
          <div className="titlebar__identity">
            {renaming ? (
              <input
                className="titlebar__rename no-drag"
                value={draft}
                autoFocus
                aria-label={t('Rename this conversation')}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => {
                  setRenaming(false)
                  void renameSession(draft)
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return
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
              <span className="titlebar__title" title={title}>{title}</span>
            )}
            <div className="titlebar__context">
              {workspace ? (
                <span className="titlebar__project" title={workspace.path}>
                  <Folder size={13} />
                  <span>{workspace.name}</span>
                </span>
              ) : null}
              {workspace && git?.isRepo ? (
                <span className="titlebar__separator" aria-hidden="true">/</span>
              ) : null}
              <BranchMenu onOpenChanges={() => openInspector('changes')} />
            </div>
          </div>
          <div className="titlebar__actions no-drag">
            <button
              className="titlebar__action"
              data-action="changes"
              aria-label={t('Git changes')}
              title={`${t('Git changes')}${gitChangeCount > 0 ? ` · ${gitChangeCount}` : ''}`}
              aria-expanded={changesOpen && inspectorTab !== 'files'}
              data-active={changesOpen && inspectorTab !== 'files'}
              onClick={() => {
                if (changesOpen && inspectorTab !== 'files') {
                  setChangesOpen(false)
                } else {
                  openInspector('changes')
                }
              }}
            >
              <GitCompare size={16} strokeWidth={1.7} />
              {gitChangeCount > 0 ? (
                <span className="titlebar__badge">{gitChangeCount}</span>
              ) : null}
            </button>
            <button
              className="titlebar__action"
              data-action="files"
              aria-label={t('Files')}
              title={t('Files')}
              aria-expanded={changesOpen && inspectorTab === 'files'}
              data-active={changesOpen && inspectorTab === 'files'}
              onClick={() => {
                if (changesOpen && inspectorTab === 'files') {
                  setChangesOpen(false)
                } else {
                  openInspector('files')
                }
              }}
            >
              <PanelRight size={16} strokeWidth={1.7} />
            </button>
            <button
              className="titlebar__action"
              data-action="terminal"
              aria-label={t('Open or close the terminal')}
              title={t('Terminal')}
              aria-expanded={terminalOpen}
              data-active={terminalOpen}
              onClick={() => setTerminalOpen((value) => !value)}
            >
              <SquareTerminal size={16} strokeWidth={1.7} />
            </button>
            {hasItems ? (
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
        <div className="main__body">
          {!hasItems ? (
            <Welcome onPick={() => void pickWorkspace()}>
              <Composer />
            </Welcome>
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

          {/* The transport is not the run: Pi can still be working behind a
              broken channel, so this says what is known rather than declaring
              the run failed. */}
          {transport === 'disconnected' && status.phase !== 'ready' ? (
            <div className="retry-wrap">
              <div className="retry" data-kind="transport" role="status">
                <TriangleAlert size={13} />
                <span className="retry__text">{t('Lost connection to Pi')}</span>
                {run.phase !== 'idle' ? (
                  <span className="retry__note">{t('The run may still be going')}</span>
                ) : null}
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
                // An extension republishes the whole line list, so a line
                // keeps its identity across a growing widget by its text; the
                // index only disambiguates two identical lines.
                <span key={`${line}-${index}`}>{line}</span>
              ))}
            </div>
          ))}

          <PlanStrip />

          {hasItems ? <Composer /> : null}

          {widgetsBelow.map((widget) => (
            <div className="widget widget--below" key={widget.key}>
              {widget.lines.map((line, index) => (
                <span key={`${line}-${index}`}>{line}</span>
              ))}
            </div>
          ))}
          {terminalOpen ? (
            <TerminalPanel
              request={terminalRequest}
              onClose={() => setTerminalOpen(false)}
            />
          ) : null}
        </div>
      </main>

      {changesOpen ? (
        <>
          {inspectorOverlay ? (
            <button
              className="inspector-scrim"
              tabIndex={-1}
              aria-label={t('Close the inspector')}
              onClick={() => setChangesOpen(false)}
            />
          ) : null}
          <InspectorPanel
            overlay={inspectorOverlay}
            initialTab={inspectorTab}
            onTabChange={setInspectorTab}
            file={inspectorFile}
            onOpenFile={setInspectorFile}
            onClose={() => setChangesOpen(false)}
            onResize={setDraggedWidth}
            onResizeEnd={(width) => {
              setDraggedWidth(null)
              void updateSettings({ drawerWidth: width })
            }}
          />
        </>
      ) : null}
      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
      {shortcutsOpen ? <ShortcutsDialog onClose={() => setShortcutsOpen(false)} /> : null}
      {launcherOpen ? (
        <Launcher actions={launcherActions} onClose={() => setLauncherOpen(false)} />
      ) : null}
      {sessionTreeOpen ? (
        <SessionTreeDialog onClose={() => setSessionTreeOpen(false)} />
      ) : null}
      {mcpOpen ? <McpDialog onClose={() => setMcpOpen(false)} /> : null}
      {switchRequest ? (
        <ConfirmDialog
          title={t('Stop the current run?')}
          body={
            settings.language === 'zh-CN'
              ? `Pi 正在运行。打开“${switchRequest.title}”需要先停止这次运行。`
              : `Pi is working on this conversation. Opening “${switchRequest.title}” means stopping the current run.`
          }
          confirmLabel={t('Stop and open')}
          tone="danger"
          onCancel={() => setSwitchRequest(null)}
          onConfirm={() => {
            const target = switchRequest
            setSwitchRequest(null)
            void (async () => {
              await stop()
              const session = sessions.find((entry) => entry.file === target.file)
              if (session) await selectSession(session)
            })()
          }}
        />
      ) : null}
      <ExtensionDialog />
    </div>
  )
}
