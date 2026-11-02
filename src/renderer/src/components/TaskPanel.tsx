import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import {
  Check,
  ChevronRight,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  History,
  Network,
  Package,
  Upload
} from 'lucide-react'
import { CommitDialog } from './CommitDialog'
import { CommitHistoryDialog } from './CommitHistoryDialog'
import { useAppStore } from '../store/useAppStore'
import { collectChanges } from '../lib/changes'
import { relativePath } from '../lib/path'
import { extractPlan } from '../lib/plan'
import { subagentCalls, type SubagentTreeTask } from '../lib/subagents'
import { useT } from '../lib/i18n'

const STATUS_LABEL = {
  proposed: 'Not run',
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  aborted: 'Stopped'
} as const

function TaskSection({
  title,
  icon,
  meta,
  defaultOpen = true,
  children
}: {
  title: string
  icon?: ReactNode
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
          <span className="task-panel__section-title">
            {icon ? <span className="task-panel__section-icon">{icon}</span> : null}
            {title}
          </span>
          <span className="task-panel__section-meta">
            {meta}
            <ChevronRight
              size={12}
              className="task-panel__section-caret"
              data-open={open || undefined}
              aria-hidden="true"
            />
          </span>
        </button>
      </h2>
      <div id={contentId} className="task-panel__section-content" hidden={!open}>
        {children}
      </div>
    </section>
  )
}

function BackgroundTaskRow({ task }: { task: SubagentTreeTask }) {
  const t = useT()
  // Rail label is the task goal/objective — never live activity / tool name.
  const label = task.task
  const tone =
    task.status === 'failed' || task.status === 'aborted'
      ? 'danger'
      : task.status === 'completed'
        ? 'success'
        : task.status === 'running' || task.status === 'queued'
          ? 'active'
          : 'idle'

  return (
    <li className="task-panel__background-row" data-status={task.status} title={task.task}>
      <span
        className="task-panel__dot"
        data-tone={tone}
        aria-label={t(STATUS_LABEL[task.status])}
      />
      <span className="task-panel__background-name">{label}</span>
    </li>
  )
}

/** Dense Codex-style task rail projected from the current thread and Git state. */
export function TaskPanel() {
  const t = useT()
  const items = useAppStore((state) => state.items)
  const git = useAppStore((state) => state.git)
  const workspacePath = useAppStore((state) => state.workspace?.path)
  const workspaceName = useAppStore((state) => state.workspace?.name)
  const refreshGit = useAppStore((state) => state.refreshGit)
  const pushGit = useAppStore((state) => state.pushGit)
  const showToast = useAppStore((state) => state.showToast)
  const plan = useMemo(() => extractPlan(items), [items])
  const changes = useMemo(() => collectChanges(items), [items])
  const backgroundTasks = useMemo(
    () => subagentCalls(items).flatMap((call) => call.tasks),
    [items]
  )
  const artifacts = useMemo(
    () =>
      changes.map((change) => ({
        ...change,
        displayPath: relativePath(workspacePath ?? '', change.path).replace(/\\/g, '/')
      })),
    [changes, workspacePath]
  )
  const [refreshing, setRefreshing] = useState(false)
  const [pushing, setPushing] = useState(false)
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

  const push = async () => {
    setPushing(true)
    try {
      await pushGit()
    } catch {
      showToast(t('Could not push branch'), 'error')
    } finally {
      setPushing(false)
    }
  }

  const branchLabel = git?.isRepo
    ? git.branch ?? `${t('Detached')} · ${git.head?.slice(0, 7) ?? ''}`
    : git?.isRepo === false
      ? t('No Git repository')
      : refreshing
        ? t('Reading Git status')
        : t('Git status is unavailable')

  const diffStats = useMemo(() => {
    if (!git?.isRepo || !git.files.length) return null
    let added = 0
    let removed = 0
    let hasLineStats = false
    for (const file of git.files) {
      if (typeof file.added === 'number' || typeof file.removed === 'number') {
        hasLineStats = true
        added += file.added ?? 0
        removed += file.removed ?? 0
      }
    }
    return hasLineStats ? { added, removed } : { files: git.files.length }
  }, [git])

  const changeMeta =
    diffStats && 'added' in diffStats ? (
      <span className="task-panel__diff-stats" aria-label={t('Changes')}>
        <span className="task-panel__diff-add">+{diffStats.added}</span>
        <span className="task-panel__diff-del">-{diffStats.removed}</span>
      </span>
    ) : diffStats && 'files' in diffStats ? (
      <span className="task-panel__count">{diffStats.files}</span>
    ) : undefined

  return (
    <div className="task-panel">
      <div className="task-panel__scroll">
        <TaskSection
          title={t('Changes')}
          icon={<History size={12} strokeWidth={1.55} aria-hidden="true" />}
          meta={changeMeta}
        >
          <div className="task-panel__action-list">
            <div className="task-panel__action-row task-panel__action-row--env" title={branchLabel}>
              <span className="task-panel__action-main" aria-label={t('Environment info')}>
                <GitBranch size={13} strokeWidth={1.55} aria-hidden="true" />
                <span className="task-panel__action-label">{branchLabel}</span>
              </span>
            </div>
            <div className="task-panel__action-row">
              <button
                type="button"
                className="task-panel__action-main"
                disabled={!git?.isRepo || Boolean(git?.clean)}
                onClick={() => setCommitOpen(true)}
              >
                <GitCommitHorizontal size={13} strokeWidth={1.55} aria-hidden="true" />
                <span className="task-panel__action-label">{t('Commit or Push')}</span>
              </button>
              <button
                type="button"
                className="task-panel__action-sub"
                disabled={!git?.isRepo || pushing}
                onClick={() => void push()}
                title={t('Push')}
                aria-label={t('Push')}
              >
                <Upload size={12} strokeWidth={1.55} />
              </button>
            </div>
            <button type="button" className="task-panel__action-row" onClick={() => setHistoryOpen(true)}>
              <Network size={13} strokeWidth={1.55} aria-hidden="true" />
              <span className="task-panel__action-label">{t('Change graph')}</span>
            </button>
          </div>
        </TaskSection>

        {backgroundTasks.length > 0 ? (
          <TaskSection title={t('Background tasks')}>
            <ul className="task-panel__background-list">
              {backgroundTasks.map((task) => (
                <BackgroundTaskRow key={task.id} task={task} />
              ))}
            </ul>
          </TaskSection>
        ) : null}

        <TaskSection
          title={t('Progress')}
          meta={plan ? <span className="task-panel__count">{plan.done}/{plan.total}</span> : undefined}
        >
          {plan ? (
            <ul className="task-panel__checklist">
              {plan.entries.map((entry, index) => (
                <li
                  key={`${index}-${entry.text}`}
                  className="task-panel__check-row"
                  data-done={entry.done || undefined}
                >
                  <span className="task-panel__check-mark" aria-hidden="true">
                    {entry.done ? <Check size={9} strokeWidth={1.75} /> : null}
                  </span>
                  <span className="task-panel__check-text">{entry.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="task-panel__inline-empty">{t('No checklist in this conversation yet')}</p>
          )}
        </TaskSection>

        <TaskSection
          title={t('Deliverables')}
          icon={<Package size={12} strokeWidth={1.55} aria-hidden="true" />}
          meta={
            artifacts.length > 0 ? (
              <span className="task-panel__count">{artifacts.length}</span>
            ) : undefined
          }
        >
          {artifacts.length > 0 ? (
            <>
              {workspaceName ? <div className="task-panel__artifact-group">{workspaceName}</div> : null}
              <ul className="task-panel__artifacts">
                {artifacts.map((artifact) => (
                  <li key={artifact.path} className="task-panel__artifact" title={artifact.path}>
                    <FileText size={13} strokeWidth={1.55} aria-hidden="true" />
                    <span className="task-panel__file-path">{artifact.displayPath}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="task-panel__inline-empty">{t('No task artifacts in this conversation yet')}</p>
          )}
        </TaskSection>
      </div>
      {commitOpen ? <CommitDialog onClose={() => setCommitOpen(false)} /> : null}
      {historyOpen ? <CommitHistoryDialog onClose={() => setHistoryOpen(false)} /> : null}
    </div>
  )
}
