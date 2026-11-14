import { useEffect, useMemo, useState } from 'react'
import { Bot, ChevronRight, Loader2, PanelRightOpen } from 'lucide-react'
import { Popover } from './Popover'
import { useAppStore } from '../store/useAppStore'
import {
  subagentPreview,
  subagentTasks,
  summarizeSubagents,
  type SubagentTreeTask
} from '../lib/subagents'
import { formatDuration, formatTokens } from '../lib/format'
import { useT } from '../lib/i18n'
import '../styles/title-subagents.css'

const STATUS_LABEL: Record<SubagentTreeTask['status'], string> = {
  proposed: 'Not run',
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  aborted: 'Stopped',
  timed_out: 'Timed out'
}

function durationOf(task: SubagentTreeTask, now: number): number | undefined {
  return task.startedAt === undefined
    ? undefined
    : Math.max(0, (task.finishedAt ?? now) - task.startedAt)
}

function StatusMark({ status }: { status: SubagentTreeTask['status'] }) {
  if (status === 'running') {
    return <Loader2 size={12} className="spin" aria-hidden="true" />
  }
  const tone = status === 'completed'
    ? 'success'
    : status === 'failed' || status === 'timed_out'
      ? 'danger'
      : 'idle'
  return <span className="title-subagents__dot" data-tone={tone} aria-hidden="true" />
}

/** One row: status, what the child is doing or said, and its metrics. */
function TaskRow({ task, now, onOpen }: {
  task: SubagentTreeTask
  now: number
  onOpen: () => void
}) {
  const t = useT()
  const preview = subagentPreview(task)
  const duration = durationOf(task, now)
  const label = task.label || task.task
  const state = t(STATUS_LABEL[task.status])
  return (
    <button
      type="button"
      className="title-subagents__row"
      data-status={task.status}
      title={task.task}
      aria-label={`${state}: ${label} — ${t('Open this conversation in the side panel')}`}
      onClick={onOpen}
    >
      <span className="title-subagents__status" data-status={task.status}>
        <StatusMark status={task.status} />
      </span>
      <span className="title-subagents__body">
        <span className="title-subagents__line">
          <span className="title-subagents__name">{label}</span>
          <span className="title-subagents__state">{state}</span>
        </span>
        {preview ? <span className="title-subagents__preview">{preview}</span> : null}
        {duration !== undefined || task.tokens || task.model ? (
          <span className="title-subagents__metrics">
            {duration !== undefined ? <span>{formatDuration(duration)}</span> : null}
            {task.tokens ? (
              <span>{t('{value} tokens').replace('{value}', formatTokens(task.tokens))}</span>
            ) : null}
            {task.model ? (
              <span className="title-subagents__model" title={task.model}>{task.model}</span>
            ) : null}
          </span>
        ) : null}
      </span>
      <ChevronRight size={14} className="title-subagents__chevron" aria-hidden="true" />
    </button>
  )
}

/**
 * The conversation's subagents, worn beside its title.
 *
 * It is a projection of the active thread: the same `subagentCalls` the task
 * rail and the Subagents page read. The badge only appears when this
 * conversation actually delegated work; clicking it opens a live list of
 * statuses and content, and a row opens that child's transcript in the right
 * side panel.
 */
export function TitleSubagents({ onOpenTask, onOpenAll }: {
  onOpenTask: (taskId: string) => void
  onOpenAll: () => void
}) {
  const t = useT()
  const items = useAppStore((state) => state.items)
  const tasks = useMemo(() => subagentTasks(items), [items])
  const summary = useMemo(() => summarizeSubagents(tasks), [tasks])
  const [now, setNow] = useState(Date.now)
  // A running child's duration has to keep moving while the popover is open.
  useEffect(() => {
    if (!summary.active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [summary.active])

  if (!tasks.length) return null

  const badgeLabel = t('{count} subagents').replace('{count}', String(summary.total))
  const headMeta = summary.active
    ? t('{active} of {total} running')
        .replace('{active}', String(summary.active))
        .replace('{total}', String(summary.total))
    : t('{total} tasks').replace('{total}', String(summary.total))

  return (
    <Popover
      placement="bottom"
      align="left"
      width={340}
      className="title-subagents-popover"
      renderTrigger={({ open, toggle }) => (
        <button
          type="button"
          className="title-subagents__trigger no-drag"
          data-open={open || undefined}
          data-running={summary.active > 0 || undefined}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={`${badgeLabel} — ${t('View subagent status and conversations')}`}
          title={t('View subagent status and conversations')}
          onClick={toggle}
        >
          {summary.active > 0
            ? <Loader2 size={13} className="spin" aria-hidden="true" />
            : <Bot size={13} aria-hidden="true" />}
          <span className="title-subagents__count">{summary.total}</span>
          <span className="title-subagents__label">{t('Subagents')}</span>
        </button>
      )}
    >
      {(close) => (
        <div className="title-subagents__panel" role="dialog" aria-label={t('Subagents')}>
          <div className="title-subagents__head">
            <span className="title-subagents__head-title">{t('Subagents')}</span>
            <span className="title-subagents__head-meta">{headMeta}</span>
          </div>
          <div className="title-subagents__list">
            {tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                now={now}
                onOpen={() => {
                  close()
                  onOpenTask(task.id)
                }}
              />
            ))}
          </div>
          <button
            type="button"
            className="title-subagents__all"
            onClick={() => {
              close()
              onOpenAll()
            }}
          >
            <PanelRightOpen size={14} aria-hidden="true" />
            <span>{t('Open all in the side panel')}</span>
          </button>
        </div>
      )}
    </Popover>
  )
}
