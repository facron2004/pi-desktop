import { lazy, memo, Suspense, useCallback, useDeferredValue, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { Bot, ChevronRight, FileDiff, GitBranch, GitCommitHorizontal } from 'lucide-react'
import type { InspectorRequest } from '@shared/types'
import { FileIcon } from './FileIcon'
import { useAppStore } from '../store/useAppStore'
import { changedFilePaths } from '../lib/changes'
import { relativePath, resolveAgainst } from '../lib/path'
import { isImageName } from '../lib/files'
import { extractPlan } from '../lib/plan'
import type { SubagentTreeTask } from '../lib/subagents'
import {
  listBackgroundCommands,
  listDeliverables,
  listSubagentTasks,
  summariseDiff,
  type BackgroundCommand,
  type Deliverable
} from '../lib/task-panel'
import { useT } from '../lib/i18n'
import '../styles/task-panel.css'

const CommitDialog = lazy(() =>
  import('./CommitDialog').then((m) => ({ default: m.CommitDialog }))
)
const CommitHistoryDialog = lazy(() =>
  import('./CommitHistoryDialog').then((m) => ({ default: m.CommitHistoryDialog }))
)

/**
 * One section of the rail.
 *
 * The title carries no icon of its own and the caret sits on the right, the way
 * the same section reads in the reference app; the body folds open on a grid
 * row so the content keeps its height while it moves.
 */
const TaskSection = memo(function TaskSection({
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
      <div
        id={contentId}
        className="task-panel__section-body"
        data-open={open || undefined}
        aria-hidden={!open}
      >
        <div className="task-panel__section-inner">
          {subtitle ? <p className="task-panel__section-subtitle">{subtitle}</p> : null}
          <div className="task-panel__section-content">{children}</div>
        </div>
      </div>
    </section>
  )
})

const BackgroundTasksSection = memo(function BackgroundTasksSection({ commands }: {
  commands: readonly BackgroundCommand[]
}) {
  const t = useT()
  const [now, setNow] = useState(Date.now)
  const next = commands.reduce((earliest, { visibleAt }) =>
    visibleAt > now ? Math.min(earliest, visibleAt) : earliest, Infinity
  )
  useEffect(() => {
    if (next === Infinity) return
    const timer = window.setTimeout(() => setNow(Math.max(next, Date.now())), Math.max(0, next - Date.now()))
    return () => window.clearTimeout(timer)
  }, [next])

  const visible = commands.filter(({ visibleAt }) => visibleAt <= now)
  if (!visible.length) return null
  const running = t('Running')
  return (
    <TaskSection title={t('Background tasks')} meta={<span className="task-panel__count">{visible.length}</span>}>
      <ul className="task-panel__list">
        {visible.map(({ id, command, label }) => (
          <li key={id} className="task-panel__task" data-status="running">
            <div className="task-panel__task-line" title={command}>
              <span className="task-panel__task-label">{label}</span>
              <span className="task-panel__dot" role="img" aria-label={running} />
            </div>
          </li>
        ))}
      </ul>
    </TaskSection>
  )
})

const SUBAGENT_STATUS_LABEL: Record<SubagentTreeTask['status'], string> = {
  proposed: 'Not run',
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  aborted: 'Stopped',
  timed_out: 'Timed out'
}

const SubagentTaskRow = memo(function SubagentTaskRow({ task, onOpenTask }: {
  task: SubagentTreeTask
  onOpenTask: (taskId: string) => void
}) {
  const t = useT()
  const label = (task.label?.trim() || task.task).replace(/\s+/g, ' ').trim() || t('Subagent')
  const description = `${label} · ${t(SUBAGENT_STATUS_LABEL[task.status])}`
  return (
    <li className="task-panel__task" data-status={task.status}>
      <button
        type="button"
        className="task-panel__task-line task-panel__task-action"
        title={description}
        aria-label={description}
        onClick={() => onOpenTask(task.id)}
      >
        {/* A child agent wears the same 20px tile a produced file does, tinted
            by its own state: the row is a thing, not a line of text. The tile
            is the only mark it needs — the status is in the tile's colour and
            in the label. */}
        <span className="task-panel__tile task-panel__tile--bot" aria-hidden="true">
          <Bot size={12} />
        </span>
        <span className="task-panel__task-label">{label}</span>
      </button>
    </li>
  )
})

/** One file the run produced, as one row of the deliverables list. */
const DeliverableRow = memo(function DeliverableRow({
  file,
  onOpenFile
}: {
  file: Deliverable
  onOpenFile: (file: Deliverable) => void
}) {
  return (
    <li className="task-panel__tree-node">
      <button
        type="button"
        className="task-panel__file"
        title={file.path}
        onClick={() => onOpenFile(file)}
      >
        <span className="task-panel__tile">
          <FileIcon name={file.name} size={12} />
        </span>
        <span className="task-panel__file-name">{file.name}</span>
        {/* Only a name two files share has to say which one this row is. */}
        {file.dir ? <span className="task-panel__file-dir">{file.dir}/</span> : null}
      </button>
    </li>
  )
})

/**
 * The plan renders from its own deferred view so streaming text does not
 * invalidate the Git, command, subagent or deliverable sections.
 */
const TaskProgressSection = memo(function TaskProgressSection() {
  const t = useT()
  // `extractPlan` caches unchanged checklists by identity and fast-paths prose
  // without checkbox tokens, so subscribing to the derived plan skips renders
  // on streaming text deltas that do not change progress.
  const rawPlan = useAppStore((state) => extractPlan(state.items))
  const plan = useDeferredValue(rawPlan)

  return (
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
              data-active={entry.active || undefined}
            >
              <span className="task-panel__check-mark" aria-hidden="true">
                {index + 1}
              </span>
              <span className="task-panel__check-text">{entry.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="task-panel__empty">{t('No checklist in this conversation yet')}</p>
      )}
    </TaskSection>
  )
})

export const TaskPanel = memo(function TaskPanel({ onOpenTask }: {
  onOpenTask: (taskId: string) => void
}) {
  const t = useT()
  const activeToolsRevision = useAppStore((state) => state.activeToolsRevision)
  const git = useAppStore((state) => state.git)
  const workspacePath = useAppStore((state) => state.workspace?.path)
  const refreshGit = useAppStore((state) => state.refreshGit)
  const toolItems = useMemo(
    () => useAppStore.getState().items.filter((item) => item.kind === 'tool'),
    [activeToolsRevision]
  )
  const backgroundCommands = useMemo(() => listBackgroundCommands(toolItems), [toolItems])
  const subagents = useMemo(() => listSubagentTasks(toolItems), [toolItems])
  const deliverables = useMemo(() => {
    const files = changedFilePaths(toolItems).map((change) => {
      const relative = relativePath(workspacePath ?? '', change.path).replace(/\\/g, '/')
      return {
        path: relative,
        target: relative === change.path ? change.path : resolveAgainst(workspacePath, change.path)
      }
    })
    return listDeliverables(files)
  }, [toolItems, workspacePath])
  const diff = useMemo(() => summariseDiff(git), [git])

  const [refreshing, setRefreshing] = useState(false)
  const [commitOpen, setCommitOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

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

  // A clean working tree has nothing to count. A lone 0 next to "Changes"
  // reads as a pending change rather than as "no changes at all".
  const hasChanges = Boolean(
    diff && (diff.files > 0 || diff.added > 0 || diff.removed > 0)
  )
  const changeMeta = hasChanges && diff ? (
    diff.hasLineStats ? (
      <span className="task-panel__diff" aria-label={t('Changes')}>
        <span className="task-panel__diff-add">+{diff.added}</span>
        <span className="task-panel__diff-del">-{diff.removed}</span>
      </span>
    ) : (
      <span className="task-panel__count">{diff.files}</span>
    )
  ) : null

  const openChanges = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent<InspectorRequest>('pi:open-inspector', { detail: { tab: 'changes' } })
    )
  }, [])

  const openFile = useCallback((file: Deliverable) => {
    const target = file.target ?? file.path
    // A picture is not worth reading as text: the Images page draws it. The
    // request carries the path so the viewer selects this picture instead of
    // silently showing the first one it scanned.
    const detail: InspectorRequest = isImageName(file.name)
      ? { tab: 'images', image: target }
      : { tab: 'files', file: target }
    window.dispatchEvent(new CustomEvent<InspectorRequest>('pi:open-inspector', { detail }))
  }, [])

  return (
    <div className="task-panel">
      <div className="task-panel__scroll">
        <TaskSection title={t('Environment info')} subtitle={branchLabel}>
          {git?.isRepo ? (
            <div className="task-panel__rows">
              <button
                type="button"
                className="task-panel__row"
                onClick={openChanges}
              >
                <FileDiff size={16} strokeWidth={1.5} className="task-panel__row-icon" aria-hidden="true" />
                <span className="task-panel__row-label">{t('Changes')}</span>
                {changeMeta}
              </button>
              <button
                type="button"
                className="task-panel__row"
                disabled={Boolean(git.clean)}
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
          ) : null}
        </TaskSection>

        <BackgroundTasksSection commands={backgroundCommands} />

        {subagents.length > 0 ? (
          <TaskSection
            title={t('Subagents')}
            meta={<span className="task-panel__count">{subagents.length}</span>}
          >
            <ul className="task-panel__list">
              {subagents.map((task) => (
                <SubagentTaskRow key={task.id} task={task} onOpenTask={onOpenTask} />
              ))}
            </ul>
          </TaskSection>
        ) : null}

        <TaskProgressSection />

        <TaskSection title={t('Deliverables')}>
          {deliverables.length > 0 ? (
            <ul className="task-panel__tree">
              {deliverables.map((file) => (
                <DeliverableRow key={file.path} file={file} onOpenFile={openFile} />
              ))}
            </ul>
          ) : (
            <p className="task-panel__empty">{t('No task artifacts in this conversation yet')}</p>
          )}
        </TaskSection>
      </div>
      {commitOpen ? (
        <Suspense fallback={null}>
          <CommitDialog onClose={() => setCommitOpen(false)} />
        </Suspense>
      ) : null}
      {historyOpen ? (
        <Suspense fallback={null}>
          <CommitHistoryDialog onClose={() => setHistoryOpen(false)} />
        </Suspense>
      ) : null}
    </div>
  )
})
