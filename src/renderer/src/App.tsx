import { useEffect, useState } from 'react'
import { PanelLeft, Pencil, RefreshCw, X } from 'lucide-react'
import { useAppStore } from './store/useAppStore'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { Thread } from './components/Thread'
import { Composer } from './components/Composer'
import { Welcome } from './components/Welcome'
import { SettingsDialog } from './components/SettingsDialog'
import { ChangesPanel } from './components/ChangesPanel'

export default function App() {
  const bootstrap = useAppStore((state) => state.bootstrap)
  const info = useAppStore((state) => state.info)
  const items = useAppStore((state) => state.items)
  const status = useAppStore((state) => state.status)
  const piState = useAppStore((state) => state.piState)
  const error = useAppStore((state) => state.error)
  const toast = useAppStore((state) => state.toast)
  const dismissError = useAppStore((state) => state.dismissError)
  const pickWorkspace = useAppStore((state) => state.pickWorkspace)
  const newChat = useAppStore((state) => state.newChat)
  const openWorkspace = useAppStore((state) => state.openWorkspace)
  const renameSession = useAppStore((state) => state.renameSession)
  const workspace = useAppStore((state) => state.workspace)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [changesOpen, setChangesOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')

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
      window as unknown as { __piDesktopDev?: { openChanges?: boolean } }
    ).__piDesktopDev
    if (dev?.openChanges) setChangesOpen(true)
  }, [])

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
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [newChat])

  const title = piState?.sessionName || workspace?.name || 'Pi Desktop'

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
              title="Restart the Pi runtime"
              onClick={() => {
                if (workspace) void openWorkspace(workspace)
              }}
            >
              <RefreshCw size={14} />
            </button>
          </div>
        </div>

        {status.phase === 'ready' ? <TopBar onOpenChanges={() => setChangesOpen(true)} /> : null}

        {items.length === 0 ? (
          <Welcome onPick={() => void pickWorkspace()} />
        ) : (
          <Thread />
        )}

        <Composer />

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

        {toast ? <div className="toast">{toast}</div> : null}
      </main>

      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
      {changesOpen ? <ChangesPanel onClose={() => setChangesOpen(false)} /> : null}
    </div>
  )
}
