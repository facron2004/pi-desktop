import { useMemo, useState } from 'react'
import { FolderOpen, MessageSquare, Pencil, Plus, Search, Settings, Trash2, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { formatRelativeTime } from '../lib/format'

export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const sessions = useAppStore((state) => state.sessions)
  const workspace = useAppStore((state) => state.workspace)
  const activeSessionFile = useAppStore((state) => state.activeSessionFile)
  const status = useAppStore((state) => state.status)
  const pickWorkspace = useAppStore((state) => state.pickWorkspace)
  const selectSession = useAppStore((state) => state.selectSession)
  const newChat = useAppStore((state) => state.newChat)
  const removeWorkspace = useAppStore((state) => state.removeWorkspace)
  const renameSession = useAppStore((state) => state.renameSession)

  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return sessions
    return sessions.filter(
      (session) =>
        session.name?.toLowerCase().includes(needle) ||
        session.preview.toLowerCase().includes(needle) ||
        session.cwd.toLowerCase().includes(needle)
    )
  }, [sessions, query])

  const groups = useMemo(() => {
    const map = new Map<string, { name: string; cwd: string; items: typeof sessions }>()
    for (const session of filtered) {
      const key = session.cwd || 'unknown'
      let group = map.get(key)
      if (!group) {
        group = {
          name: key ? (key.split(/[\\/]/).filter(Boolean).pop() ?? key) : 'Unknown',
          cwd: key,
          items: []
        }
        map.set(key, group)
      }
      group.items.push(session)
    }
    return Array.from(map.values()).sort((a, b) => {
      if (a.cwd === workspace?.path) return -1
      if (b.cwd === workspace?.path) return 1
      return (b.items[0]?.updatedAt ?? 0) - (a.items[0]?.updatedAt ?? 0)
    })
  }, [filtered, workspace?.path])

  const startRename = (file: string, current: string) => {
    setRenaming(file)
    setDraft(current)
  }

  const commitRename = (file: string) => {
    setRenaming(null)
    if (file === activeSessionFile) void renameSession(draft)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__head drag-region">
        <div className="sidebar__brand">
          <span className="sidebar__logo">π</span>
          <span>Pi Desktop</span>
        </div>
      </div>

      <div className="sidebar__body">
        <button className="btn-new-chat" onClick={() => void newChat()}>
          <Plus size={15} />
          New chat
        </button>

        <div className="sidebar__section">
          <div className="sidebar__section-head">
            <span>Project</span>
            <button title="Open a folder" onClick={() => void pickWorkspace()}>
              <FolderOpen size={13} />
            </button>
          </div>

          {workspace ? (
            <div className="workspace" title={workspace.path}>
              <span className="workspace__icon">
                <FolderOpen size={14} />
              </span>
              <span className="workspace__text">
                <span className="workspace__name">{workspace.name}</span>
                <span className="workspace__path">{workspace.path}</span>
              </span>
              <button
                className="icon-btn"
                style={{ width: 22, height: 22 }}
                title="Remove project"
                onClick={() => void removeWorkspace(workspace.id)}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ) : (
            <div className="sidebar__empty">No project selected yet.</div>
          )}
        </div>

        {sessions.length > 0 ? (
          <div className="sidebar__search">
            <Search size={13} />
            <input
              value={query}
              placeholder="Filter conversations"
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <button className="icon-btn" style={{ width: 18, height: 18 }} onClick={() => setQuery('')}>
                <X size={11} />
              </button>
            ) : null}
          </div>
        ) : null}

        {groups.map((group) => (
          <div className="sidebar__section" key={group.cwd}>
            <div className="sidebar__section-head">
              <span>{group.cwd === workspace?.path ? 'Conversations' : group.name}</span>
              <span style={{ textTransform: 'none', letterSpacing: 0 }}>{group.items.length}</span>
            </div>
            <div className="session-list">
              {group.items.map((session) => (
                <div
                  className="session-item"
                  key={session.file}
                  data-active={session.file === activeSessionFile}
                  onClick={() => {
                    if (renaming !== session.file) void selectSession(session)
                  }}
                  title={session.name || session.preview || session.file}
                >
                  <MessageSquare size={13} className="session-item__icon" />
                  <span className="session-item__text">
                    {renaming === session.file ? (
                      <input
                        className="session-item__input"
                        value={draft}
                        autoFocus
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={() => commitRename(session.file)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            commitRename(session.file)
                          }
                          if (event.key === 'Escape') {
                            event.preventDefault()
                            setRenaming(null)
                          }
                        }}
                        onClick={(event) => event.stopPropagation()}
                      />
                    ) : (
                      <>
                        <span className="session-item__title">
                          {session.name || session.preview || 'Untitled session'}
                        </span>
                        <span className="session-item__meta">
                          <span>{formatRelativeTime(session.updatedAt)}</span>
                          {session.messageCount ? <span>· {session.messageCount} msgs</span> : null}
                        </span>
                      </>
                    )}
                  </span>
                  <button
                    className="session-item__rename"
                    title="Rename conversation"
                    onClick={(event) => {
                      event.stopPropagation()
                      startRename(session.file, session.name || session.preview || '')
                    }}
                  >
                    <Pencil size={11} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}

        {sessions.length > 0 && filtered.length === 0 ? (
          <div className="sidebar__section">
            <div className="sidebar__empty">No conversation matches “{query}”.</div>
          </div>
        ) : null}

        {sessions.length === 0 ? (
          <div className="sidebar__section">
            <div className="sidebar__empty">
              No conversations yet. Start one and it will show up here.
            </div>
          </div>
        ) : null}
      </div>

      <div className="sidebar__foot">
        <div className="runtime-chip" data-phase={status.phase}>
          <span className="runtime-chip__dot" />
          <span>
            {status.phase === 'ready'
              ? 'Pi connected'
              : status.phase === 'starting'
                ? 'Starting Pi…'
                : status.phase === 'error'
                  ? 'Pi unavailable'
                  : 'Pi stopped'}
          </span>
        </div>
        <button className="sidebar__foot-btn" onClick={onOpenSettings}>
          <Settings size={14} />
          Settings
        </button>
      </div>
    </aside>
  )
}
