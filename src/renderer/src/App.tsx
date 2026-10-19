import { useEffect, useState } from 'react'
import { PanelLeft, RefreshCw, X } from 'lucide-react'
import { useAppStore } from './store/useAppStore'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { Thread } from './components/Thread'
import { Composer } from './components/Composer'
import { Welcome } from './components/Welcome'
import { SettingsDialog } from './components/SettingsDialog'

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
  const workspace = useAppStore((state) => state.workspace)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  useEffect(() => {
    const root = document.documentElement
    const platform = useAppStore.getState().info?.platform
    if (platform) root.dataset.platform = platform
  }, [info])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void newChat()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [newChat])

  const title = piState?.sessionName || workspace?.name || 'Pi Desktop'

  return (
    <div className="app" data-sidebar={sidebarOpen ? 'open' : 'collapsed'}>
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
          <span className="titlebar__title">{title}</span>
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

        {status.phase === 'ready' ? <TopBar /> : null}

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
    </div>
  )
}
