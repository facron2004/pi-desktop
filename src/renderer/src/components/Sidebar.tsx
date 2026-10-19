import { useMemo, useState } from 'react'
import {
  FolderOpen,
  Loader2,
  MessageSquare,
  Pencil,
  Pin,
  Plus,
  Search,
  Settings,
  Trash2,
  X
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import type { SessionMeta } from '@shared/types'
import { formatDayBucket, formatRelativeTime } from '../lib/format'
import { samePath } from '../lib/path'
import { collectProjects, sortProjects, type Project } from '../lib/projects'
import { basename } from '../lib/path'
import { ConfirmDialog } from './ConfirmDialog'

/** A session in the list, or the heading that separates a run of them. */
type GroupEntry =
  | { kind: 'heading'; label: string; key: string }
  | { kind: 'session'; session: SessionMeta; key: string }

/** Split the sessions of a project into buckets by when they happened. */
function groupByDay(sessions: SessionMeta[]): GroupEntry[] {
  const entries: GroupEntry[] = []
  let previous = ''
  for (const session of sessions) {
    const bucket = formatDayBucket(session.updatedAt)
    if (bucket !== previous) {
      entries.push({ kind: 'heading', label: bucket, key: `heading-${bucket}` })
      previous = bucket
    }
    entries.push({ kind: 'session', session, key: session.file })
  }
  return entries
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

export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const sessions = useAppStore((state) => state.sessions)
  const workspace = useAppStore((state) => state.workspace)
  const activeSessionFile = useAppStore((state) => state.activeSessionFile)
  const status = useAppStore((state) => state.status)
  const settings = useAppStore((state) => state.settings)
  const pickWorkspace = useAppStore((state) => state.pickWorkspace)
  const switchProject = useAppStore((state) => state.switchProject)
  const selectSession = useAppStore((state) => state.selectSession)
  const newChat = useAppStore((state) => state.newChat)
  const removeWorkspace = useAppStore((state) => state.removeWorkspace)
  const renameSessionFile = useAppStore((state) => state.renameSessionFile)
  const deleteSession = useAppStore((state) => state.deleteSession)
  const togglePin = useAppStore((state) => state.togglePin)

  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [pendingDelete, setPendingDelete] = useState<SessionMeta | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const needle = query.trim().toLowerCase()

  const projects = useMemo(() => {
    const list = collectProjects(settings.workspaces, sessions)
    if (!needle) return list
    for (const project of list) {
      project.sessions = project.sessions.filter((session) => matches(session, needle))
    }
    return list
  }, [settings.workspaces, sessions, needle])

  const ordered = useMemo(
    () => sortProjects(projects, workspace?.path),
    [projects, workspace?.path]
  )

  const pinned = useMemo(
    () => new Set(settings.pinnedSessions ?? []),
    [settings.pinnedSessions]
  )

  // Without a filter the list shows the conversations of the project that is
  // open. A filter looks everywhere, because a conversation the user cannot
  // find is worth more than a tidy list. Pinned conversations have their own
  // group and are left out of the project they belong to.
  const groups = useMemo(() => {
    const visible = ordered
      .map((project) => ({
        project,
        sessions: project.sessions.filter((session) => !pinned.has(session.file))
      }))
      .filter((group) => group.sessions.length > 0)
    if (needle) return visible
    const active = visible.find((group) => workspace && samePath(workspace.path, group.project.path))
    return active ? [active] : []
  }, [ordered, needle, pinned, workspace?.path])

  // Pinned conversations float to the top, out of the project they belong to.
  const pinnedSessions = useMemo(
    () => sessions.filter((session) => pinned.has(session.file) && matches(session, needle)),
    [sessions, pinned, needle]
  )

  const openProject = async (project: Project) => {
    if (workspace && samePath(workspace.path, project.path)) return
    setBusy(project.path)
    try {
      await switchProject(project.path)
    } finally {
      setBusy(null)
    }
  }

  const startRename = (file: string, current: string) => {
    setRenaming(file)
    setDraft(current)
  }

  const commitRename = (file: string) => {
    setRenaming(null)
    void renameSessionFile(file, draft)
  }

  const renderSessions = (items: SessionMeta[]) =>
    groupByDay(items).map((entry) =>
      entry.kind === 'heading' ? (
        <div className="session-list__heading" key={entry.key}>
          {entry.label}
        </div>
      ) : (
        <SessionRow
          key={entry.key}
          session={entry.session}
          active={entry.session.file === activeSessionFile}
          pinned={pinned.has(entry.session.file)}
          renaming={renaming === entry.session.file}
          draft={draft}
          onSelect={(file) => {
            if (renaming !== file) void selectSession(entry.session)
          }}
          onStartRename={() =>
            startRename(entry.session.file, entry.session.name || entry.session.preview || '')
          }
          onRenameDraft={setDraft}
          onCommitRename={commitRename}
          onCancelRename={() => setRenaming(null)}
          onDelete={() => setPendingDelete(entry.session)}
          onTogglePin={() => void togglePin(entry.session.file)}
        />
      )
    )

  // The pinned group is small, so it does not need the day headings. A
  // pinned conversation can belong to another project, which the row says.
  const renderPinned = (items: SessionMeta[]) =>
    items.map((session) => (
      <SessionRow
        key={session.file}
        session={session}
        active={session.file === activeSessionFile}
        pinned
        renaming={renaming === session.file}
        draft={draft}
        project={session.cwd ? basename(session.cwd) : undefined}
        onSelect={(file) => {
          if (renaming !== file) void selectSession(session)
        }}
        onStartRename={() =>
          startRename(session.file, session.name || session.preview || '')
        }
        onRenameDraft={setDraft}
        onCommitRename={commitRename}
        onCancelRename={() => setRenaming(null)}
        onDelete={() => setPendingDelete(session)}
        onTogglePin={() => void togglePin(session.file)}
      />
    ))

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
            <span>Projects</span>
            <button title="Open a folder" onClick={() => void pickWorkspace()}>
              <FolderOpen size={13} />
            </button>
          </div>

          {ordered.length === 0 ? (
            <div className="sidebar__empty">No project selected yet.</div>
          ) : (
            <div className="project-tree">
              {ordered.map((project) => {
                const active = Boolean(workspace && samePath(workspace.path, project.path))
                const projectId = project.id
                return (
                  <div className="project" key={project.path || 'unknown'} data-active={active}>
                    <div className="project__row">
                      <button
                        className="project__main"
                        title={active ? project.path : `Open ${project.path}`}
                        onClick={() => void openProject(project)}
                      >
                        <span className="project__icon">
                          {busy === project.path ? (
                            <Loader2 size={13} className="spin" />
                          ) : (
                            <FolderOpen size={14} />
                          )}
                        </span>
                        <span className="project__text">
                          <span className="project__name">{project.name}</span>
                          <span className="project__path">{project.path || 'Unknown location'}</span>
                        </span>
                        {project.sessions.length > 0 ? (
                          <span className="project__count">{project.sessions.length}</span>
                        ) : null}
                      </button>
                      {project.registered && projectId ? (
                        <button
                          className="project__remove"
                          title="Remove project"
                          onClick={() => void removeWorkspace(projectId)}
                        >
                          <Trash2 size={12} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
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

        {pinnedSessions.length > 0 ? (
          <div className="sidebar__section">
            <div className="sidebar__section-head">
              <span>Pinned</span>
              <span style={{ textTransform: 'none', letterSpacing: 0 }}>
                {pinnedSessions.length}
              </span>
            </div>
            <div className="session-list">{renderPinned(pinnedSessions)}</div>
          </div>
        ) : null}

        {groups.length > 0 ? (
          <div className="sidebar__section">
            {needle ? (
              groups.map((group) => (
                <div className="session-group" key={group.project.path || 'unknown'}>
                  <div className="session-group__head">
                    <FolderOpen size={11} />
                    <span>{group.project.name}</span>
                    <span className="session-group__count">{group.sessions.length}</span>
                  </div>
                  <div className="session-list">{renderSessions(group.sessions)}</div>
                </div>
              ))
            ) : (
              <div className="session-list">{renderSessions(groups[0].sessions)}</div>
            )}
          </div>
        ) : null}

        {sessions.length > 0 && needle && groups.length === 0 && pinnedSessions.length === 0 ? (
          <div className="sidebar__section">
            <div className="sidebar__empty">No conversation matches “{query}”.</div>
          </div>
        ) : null}

        {sessions.length > 0 && !needle && groups.length === 0 && workspace ? (
          <div className="sidebar__section">
            <div className="sidebar__empty">
              No conversation in this project yet. Start one and it will show up here.
            </div>
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

      {pendingDelete ? (
        <ConfirmDialog
          title="Delete conversation"
          body={`“${pendingDelete.name || pendingDelete.preview || 'Untitled session'}” will be moved to the system trash. This cannot be undone from inside Pi Desktop.`}
          confirmLabel="Delete"
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
  )
}

interface SessionRowProps {
  session: SessionMeta
  active: boolean
  pinned: boolean
  renaming: boolean
  draft: string
  /** The project the conversation belongs to, when it is not the open one. */
  project?: string
  onSelect: (file: string) => void
  onStartRename: () => void
  onRenameDraft: (value: string) => void
  onCommitRename: (file: string) => void
  onCancelRename: () => void
  onDelete: () => void
  onTogglePin: () => void
}

function SessionRow({
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
  onTogglePin
}: SessionRowProps) {
  return (
    <div
      className="session-item"
      data-active={active}
      onClick={() => onSelect(session.file)}
      title={session.name || session.preview || session.file}
    >
      <MessageSquare size={13} className="session-item__icon" />
      <span className="session-item__text">
        {renaming ? (
          <input
            className="session-item__input"
            value={draft}
            autoFocus
            onChange={(event) => onRenameDraft(event.target.value)}
            onBlur={() => onCommitRename(session.file)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onCommitRename(session.file)
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                onCancelRename()
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
              {project ? (
                <span>· {project}</span>
              ) : session.messageCount ? (
                <span>· {session.messageCount} msgs</span>
              ) : null}
            </span>
          </>
        )}
      </span>
      <button
        className="session-item__rename"
        data-on={pinned}
        title={pinned ? 'Unpin conversation' : 'Pin conversation to the top'}
        onClick={(event) => {
          event.stopPropagation()
          onTogglePin()
        }}
      >
        <Pin size={11} />
      </button>
      <button
        className="session-item__rename"
        title="Rename conversation"
        onClick={(event) => {
          event.stopPropagation()
          onStartRename()
        }}
      >
        <Pencil size={11} />
      </button>
      <button
        className="session-item__rename session-item__rename--danger"
        title="Delete conversation"
        onClick={(event) => {
          event.stopPropagation()
          onDelete()
        }}
      >
        <Trash2 size={11} />
      </button>
    </div>
  )
}
