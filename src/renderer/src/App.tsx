import { useEffect, useRef, useState } from 'react'
import { FileDown, Keyboard, PanelLeft, Pencil, RefreshCw, X } from 'lucide-react'
import { useAppStore } from './store/useAppStore'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { Thread } from './components/Thread'
import { Composer } from './components/Composer'
import { Welcome } from './components/Welcome'
import { SettingsDialog } from './components/SettingsDialog'
import { InspectorPanel } from './components/InspectorPanel'
import { ShortcutsDialog } from './components/ShortcutsDialog'
import { ExtensionDialog } from './components/ExtensionDialog'

export default function App() {
  const bootstrap = useAppStore((state) => state.bootstrap)
  const info = useAppStore((state) => state.info)
  const items = useAppStore((state) => state.items)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const status = useAppStore((state) => state.status)
  const piState = useAppStore((state) => state.piState)
  const error = useAppStore((state) => state.error)
  const toast = useAppStore((state) => state.toast)
  const dismissError = useAppStore((state) => state.dismissError)
  const pickWorkspace = useAppStore((state) => state.pickWorkspace)
  const newChat = useAppStore((state) => state.newChat)
  const openWorkspace = useAppStore((state) => state.openWorkspace)
  const renameSession = useAppStore((state) => state.renameSession)
  const exportSession = useAppStore((state) => state.exportSession)
  const workspace = useAppStore((state) => state.workspace)
  const uiStatuses = useAppStore((state) => state.uiStatuses)
  const uiWidgets = useAppStore((state) => state.uiWidgets)
  const uiTitle = useAppStore((state) => state.uiTitle)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [changesOpen, setChangesOpen] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<'changes' | 'files'>('changes')
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const exportedRef = useRef(false)

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  useEffect(() => {
    const root = document.documentElement
    const platform = useAppStore.getState().info?.platform
    if (platform) root.dataset.platform = platform
  }, [info])

  // Development aid: open the changes drawer for screenshots.
  useEffect(() => {
    const dev = (
      window as unknown as { __piDesktopDev?: { openChanges?: boolean; openFiles?: boolean } }
    ).__piDesktopDev
    if (dev?.openFiles) {
      setInspectorTab('files')
      setChangesOpen(true)
      return
    }
    if (dev?.openChanges) setChangesOpen(true)
  }, [])

  // Development aid: exercise the export path once the session has content.
  useEffect(() => {
    const dev = (
      window as unknown as { __piDesktopDev?: { export?: boolean } }
    ).__piDesktopDev
    if (!dev?.export || exportedRef.current) return
    if (items.length === 0 || isStreaming) return
    exportedRef.current = true
    void exportSession()
  }, [items.length, isStreaming, exportSession])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void newChat()
        return
      }
      if (mod && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        setSidebarOpen((value) => !value)
        return
      }
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        window.dispatchEvent(new CustomEvent('pi:focus-composer'))
        return
      }
      if (mod && event.key === '/') {
        event.preventDefault()
        setShortcutsOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    const onShowShortcuts = () => setShortcutsOpen(true)
    window.addEventListener('pi:show-shortcuts', onShowShortcuts)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pi:show-shortcuts', onShowShortcuts)
    }
  }, [newChat])

  const title = piState?.sessionName || workspace?.name || 'Pi Desktop'

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
    >
      {sidebarOpen ? <Sidebar onOpenSettings={() => setSettingsOpen(true)} /> : null}

      <main className="main">
        <div className="titlebar drag-region">
          <button
            className="icon-btn no-drag"
            title="Toggle sidebar"
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
              <button
                className="icon-btn no-drag"
                title="Rename this conversation"
                onClick={() => {
                  setDraft(piState?.sessionName ?? '')
                  setRenaming(true)
                }}
              >
                <Pencil size={12} />
              </button>
            </>
          )}
          <span className="titlebar__spacer" />
          <div className="titlebar__actions no-drag">
            <button
              className="icon-btn"
              title="Keyboard shortcuts"
              onClick={() => setShortcutsOpen(true)}
            >
              <Keyboard size={14} />
            </button>
            <button
              className="icon-btn"
              title="Export this conversation as HTML"
              disabled={status.phase !== 'ready' || items.length === 0}
              onClick={() => void exportSession()}
            >
              <FileDown size={14} />
            </button>
            <button
              className="icon-btn"
              title="Restart the Pi runtime"
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
              setChangesOpen(true)
            }}
            onOpenFiles={() => {
              setInspectorTab('files')
              setChangesOpen(true)
            }}
          />
        ) : null}

        {items.length === 0 ? (
          <Welcome onPick={() => void pickWorkspace()} />
        ) : (
          <Thread />
        )}

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

        <Composer />

        {widgetsBelow.map((widget) => (
          <div className="widget widget--below" key={widget.key}>
            {widget.lines.map((line, index) => (
              <span key={index}>{line}</span>
            ))}
          </div>
        ))}

        {error ? (
          <div className="modal-layer" style={{ alignItems: 'flex-end' }} onMouseDown={dismissError}>
            <div
              className="notice"
              data-level="error"
              style={{ marginBottom: 20, maxWidth: 640 }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <span style={{ flex: 1 }}>{error}</span>
              <button className="icon-btn" onClick={dismissError}>
                <X size={13} />
              </button>
            </div>
          </div>
        ) : null}

        {toast ? (
          <div className="toast" data-level={toast.level}>
            {toast.text}
          </div>
        ) : null}
      </main>

      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
      {shortcutsOpen ? <ShortcutsDialog onClose={() => setShortcutsOpen(false)} /> : null}
      <ExtensionDialog />
      {changesOpen ? (
        <InspectorPanel
          initialTab={inspectorTab}
          onClose={() => setChangesOpen(false)}
        />
      ) : null}
    </div>
  )
}
