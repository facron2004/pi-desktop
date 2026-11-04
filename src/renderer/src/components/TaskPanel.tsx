import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import {
  Check,
  ChevronRight,
  FileDiff,
  GitBranch,
  GitCommitHorizontal
} from 'lucide-react'
import type { InspectorRequest } from '@shared/types'
import { CommitDialog } from './CommitDialog'
import { CommitHistoryDialog } from './CommitHistoryDialog'
import { FileIcon } from './FileIcon'
import { useAppStore } from '../store/useAppStore'
import { collectChanges } from '../lib/changes'
import { relativePath, resolveAgainst } from '../lib/path'
import { extractPlan } from '../lib/plan'
import { subagentCalls, type SubagentTreeTask } from '../lib/subagents'
import {
  buildDeliverableTree,
  summariseDiff,
  type DeliverableNode
} from '../lib/task-panel'
import { readDeliverableOpen, writeDeliverableOpen } from '../lib/view-state'
import { useT } from '../lib/i18n'
import '../styles/task-panel.css'

const STATUS_LABEL = {
  proposed: 'Not run',
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  aborted: 'Stopped'
} as const

/**
 * One section of the rail.
 *
 * The title carries no icon of its own and the caret sits on the right, the way
 * the same section reads in the reference app; the body folds open on a grid
 * row so the content keeps its height while it moves.
 */
function TaskSection({
  title,
  subtitle,
  meta,
  defaultOpen = true,
  children
}: {
  title: string
  subtitle?: ReactNode
  meta?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const contentId = useId()
  const [open, setOpen] = useState(defaultOpen)

  return (
    <section className="task-panel__section" data-open={open || undefined}>
      <h2 className="task-panel__section-head">
        <button
          type="button"
          className="task-panel__section-toggle"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="task-panel__section-title">{title}</span>
          <span className="task-panel__section-meta">
            {meta}
            <ChevronRight
              size={14}
              className="task-panel__section-caret"
              data-open={open || undefined}
              aria-hidden="true"
            />
          </span>
        </button>
      </h2>
      {subtitle ? <p className="task-panel__section-subtitle">{subtitle}</p> : null}
      <div
        id={contentId}
        className="task-panel__section-body"
        data-open={open || undefined}
        aria-hidden={!open}
      >
        <div className="task-panel__section-inner">
          <div className="task-panel__section-content">{children}</div>
        </div>
      </div>
    </section>
  )
}

/** The status leads the task label so it stays visible when the goal is long. */
function BackgroundTaskRow({ task }: { task: SubagentTreeTask }) {
  const t = useT()
  // The label is the task goal — never the live activity or the tool name.
  const tone =
    task.status === 'failed' || task.status === 'aborted'
      ? 'danger'
      : task.status === 'completed'
        ? 'success'
        : task.status === 'running' || task.status === 'queued'
          ? 'active'
          : 'idle'

  return (
    <li className="task-panel__task" data-status={task.status} title={task.task}>
      <span
        className="task-panel__dot"
        data-tone={tone}
        aria-label={t(STATUS_LABEL[task.status])}
      />
      <span className="task-panel__task-name">{task.task}</span>
    </li>
  )
}

/** A folder of the deliverables tree, or one file in it. */
function DeliverableRow({
  node,
  depth,
  isOpen,
  onToggle,
  onOpenFile
}: {
  node: DeliverableNode
  depth: number
  isOpen: (path: string) => boolean
  onToggle: (path: string) => void
  onOpenFile: (node: Extract<DeliverableNode, { kind: 'file' }>) => void
}) {
  // A file is a deliverable, and the reader scans deliverables: every file row
  // keeps the one column, whatever folder it sits under. Only a folder header
  // steps in with the depth, because that is the row whose job is structure.
  const indent = { paddingLeft: `${node.kind === 'file' ? 4 : 4 + depth * 14}px` }

  if (node.kind === 'folder') {
    const open = isOpen(node.path)
    return (
      <li className="task-panel__tree-node">
        <button
          type="button"
          className="task-panel__folder"
          style={indent}
          aria-expanded={open}
          onClick={() => onToggle(node.path)}
        >
          {/* The tile a file's mark sits in is always there, empty for a
              folder: it is what keeps a folder's name on the same column as a
              file's name at the same depth. Only the indent moves the column. */}
          <span className="task-panel__tile" aria-hidden="true" />
          <span className="task-panel__folder-name">{node.name}</span>
          <ChevronRight
            size={14}
            className="task-panel__folder-caret"
            data-open={open || undefined}
            aria-hidden="true"
          />
        </button>
        {open ? (
          <ul className="task-panel__tree">
            {node.children.map((child) => (
              <DeliverableRow
                key={child.path}
                node={child}
                depth={depth + 1}
                isOpen={isOpen}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
              />
            ))}
          </ul>
        ) : null}
      </li>
    )
  }

  return (
    <li className="task-panel__tree-node">
      <button
        type="button"
        className="task-panel__file"
        style={indent}
        title={node.path}
        onClick={() => onOpenFile(node)}
      >
        <span className="task-panel__tile task-panel__tile--file">
          <FileIcon name={node.name} size={12} />
        </span>
        <span className="task-panel__file-name">{node.name}</span>
        {/* Which folder this file came from: the row no longer says it with an
            indent, so it says it here, in the room the name left behind. */}
        {node.dir ? <span className="task-panel__file-dir">{node.dir}/</span> : null}
      </button>
    </li>
  )
}

/**
 * The task rail: what the folder looks like from the outside, what is running
 * in the background, how far the plan has come and what the run produced.
 *
 * Every part of it is a projection of the thread and the Git state, so the
 * rail has no state of its own beyond which folders are open.
 */
export function TaskPanel() {
  const t = useT()
  const items = useAppStore((state) => state.items)
  const git = useAppStore((state) => state.git)
  const workspacePath = useAppStore((state) => state.workspace?.path)
  const activeSessionFile = useAppStore((state) => state.activeSessionFile)
  const draftId = useAppStore((state) => state.draftId)
  const refreshGit = useAppStore((state) => state.refreshGit)

  const threadKey = activeSessionFile ?? draftId ?? ''
  const plan = useMemo(() => extractPlan(items), [items])
  const backgroundTasks = useMemo(
    () => subagentCalls(items).flatMap((call) => call.tasks),
    [items]
  )
  const deliverables = useMemo(() => {
    const files = collectChanges(items).map((change) => {
      const relative = relativePath(workspacePath ?? '', change.path).replace(/\\/g, '/')
      return {
        path: relative,
        target: relative === change.path ? change.path : resolveAgainst(workspacePath, change.path)
      }
    })
    return buildDeliverableTree(files)
  }, [items, workspacePath])
  const diff = useMemo(() => summariseDiff(git), [git])

  const [refreshing, setRefreshing] = useState(false)
  const [commitOpen, setCommitOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [folders, setFolders] = useState<Record<string, boolean>>({})

  const readGitStatus = useCallback(async () => {
    setRefreshing(true)
    try {
      await refreshGit()
    } finally {
      setRefreshing(false)
    }
  }, [refreshGit])

  useEffect(() => {
    void readGitStatus()
  }, [readGitStatus, workspacePath])

  const branchLabel = git?.isRepo
    ? git.branch ?? `${t('Detached')} · ${git.head?.slice(0, 7) ?? ''}`
    : git?.isRepo === false
      ? t('No Git repository')
      : refreshing
        ? t('Reading Git status')
        : t('Git status is unavailable')

  const changeMeta = diff ? (
    diff.hasLineStats ? (
      <span className="task-panel__diff" aria-label={t('Changes')}>
        <span className="task-panel__diff-add">+{diff.added}</span>
        <span className="task-panel__diff-del">-{diff.removed}</span>
      </span>
    ) : (
      <span className="task-panel__count">{diff.files}</span>
    )
  ) : null

  const openChanges = () => {
    window.dispatchEvent(
      new CustomEvent<InspectorRequest>('pi:open-inspector', { detail: { tab: 'changes' } })
    )
  }

  const openFile = (node: Extract<DeliverableNode, { kind: 'file' }>) => {
    const target = node.target ?? node.path
    window.dispatchEvent(
      new CustomEvent<InspectorRequest>('pi:open-inspector', {
        detail: { tab: 'files', file: target }
      })
    )
  }

  const isOpen = useCallback(
    (path: string) => folders[`${threadKey}\u0000${path}`] ?? readDeliverableOpen(threadKey, path) ?? true,
    [folders, threadKey]
  )

  const toggleFolder = useCallback(
    (path: string) => {
      const next = !isOpen(path)
      setFolders((previous) => ({ ...previous, [`${threadKey}\u0000${path}`]: next }))
      writeDeliverableOpen(threadKey, path, next)
    },
    [isOpen, threadKey]
  )

  return (
    <div className="task-panel">
      <div className="task-panel__scroll">
        <TaskSection title={t('Environment info')} subtitle={branchLabel}>
          <div className="task-panel__rows">
            <button
              type="button"
              className="task-panel__row"
              onClick={openChanges}
              disabled={!git?.isRepo}
            >
              <FileDiff size={16} strokeWidth={1.5} className="task-panel__row-icon" aria-hidden="true" />
              <span className="task-panel__row-label">{t('Changes')}</span>
              {changeMeta}
            </button>
            <button
              type="button"
              className="task-panel__row"
              disabled={!git?.isRepo || Boolean(git?.clean)}
              onClick={() => setCommitOpen(true)}
            >
              <GitCommitHorizontal
                size={16}
                strokeWidth={1.5}
                className="task-panel__row-icon"
                aria-hidden="true"
              />
              <span className="task-panel__row-label">{t('Commit or Push')}</span>
            </button>
            <button type="button" className="task-panel__row" onClick={() => setHistoryOpen(true)}>
              <GitBranch
                size={16}
                strokeWidth={1.5}
                className="task-panel__row-icon"
                aria-hidden="true"
              />
              <span className="task-panel__row-label">{t('Change graph')}</span>
            </button>
          </div>
        </TaskSection>

        {backgroundTasks.length > 0 ? (
          <TaskSection title={t('Background tasks')}>
            <ul className="task-panel__list">
              {backgroundTasks.map((task) => (
                <BackgroundTaskRow key={task.id} task={task} />
              ))}
            </ul>
          </TaskSection>
        ) : null}

        <TaskSection
          title={t('Progress')}
          meta={
            plan ? <span className="task-panel__count">{plan.done}/{plan.total}</span> : undefined
          }
        >
          {plan ? (
            <ul className="task-panel__list">
              {plan.entries.map((entry, index) => (
                <li
                  key={`${index}-${entry.text}`}
                  className="task-panel__check"
                  data-done={entry.done || undefined}
                >
                  <span className="task-panel__check-mark" aria-hidden="true">
                    {entry.done ? <Check size={11} strokeWidth={2} /> : null}
                  </span>
                  <span className="task-panel__check-text">{entry.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="task-panel__empty">{t('No checklist in this conversation yet')}</p>
          )}
        </TaskSection>

        <TaskSection title={t('Deliverables')}>
          {deliverables.length > 0 ? (
            <ul className="task-panel__tree">
              {deliverables.map((node) => (
                <DeliverableRow
                  key={node.path}
                  node={node}
                  depth={0}
                  isOpen={isOpen}
                  onToggle={toggleFolder}
                  onOpenFile={openFile}
                />
              ))}
            </ul>
          ) : (
            <p className="task-panel__empty">{t('No task artifacts in this conversation yet')}</p>
          )}
        </TaskSection>
      </div>
      {commitOpen ? <CommitDialog onClose={() => setCommitOpen(false)} /> : null}
      {historyOpen ? <CommitHistoryDialog onClose={() => setHistoryOpen(false)} /> : null}
    </div>
  )
}
