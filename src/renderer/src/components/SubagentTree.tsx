import { useEffect, useMemo, useState } from 'react'
import { Bot, ChevronRight, Loader2 } from 'lucide-react'
import type { SessionMeta } from '@shared/types'
import type { SessionThread } from '../store/useAppStore'
import { subagentCalls, type SubagentCall, type SubagentTreeTask } from '../lib/subagents'
import { formatDuration, formatTokens } from '../lib/format'
import { useT } from '../lib/i18n'
import { readProcessOpen, writeProcessOpen } from '../lib/view-state'
import '../styles/subagent-tree.css'

const STATUS_LABEL = {
  proposed: 'Not run',
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  aborted: 'Stopped'
} as const

/** The catalog's status column: a loader for work in flight, a quiet dot otherwise. */
function StatusMark({ status, className }: { status: SubagentTreeTask['status'] | 'idle'; className?: string }) {
  if (status === 'running') {
    return <Loader2 size={12} className={`subagent-tree__status-icon spin${className ? ` ${className}` : ''}`} aria-hidden="true" />
  }
  const tone = status === 'completed' ? 'success' : status === 'failed' ? 'danger' : 'idle'
  return <span className={`subagent-tree__dot${className ? ` ${className}` : ''}`} data-tone={tone} aria-hidden="true" />
}

function isActive(task: SubagentTreeTask): boolean {
  return task.status === 'running' || task.status === 'queued'
}

function durationOf(task: SubagentTreeTask, now: number): number | undefined {
  return task.startedAt === undefined ? undefined : Math.max(0, (task.finishedAt ?? now) - task.startedAt)
}

/** All loaded conversations stay visible here while their child tasks run in the background. */
export function SubagentTree({ sessions, threads, onSelect, onOpenTask, showEmpty = false }: {
  sessions: readonly SessionMeta[]
  threads: Readonly<Record<string, SessionThread>>
  onSelect: (session: SessionMeta) => void
  onOpenTask?: (task: SubagentTreeTask, session: SessionMeta) => void
  showEmpty?: boolean
}) {
  const t = useT()
  const branches = useMemo(() => sessions.flatMap((session) => {
    const calls = subagentCalls(threads[session.file]?.items ?? [])
    return calls.length ? [{ session, calls }] : []
  }), [sessions, threads])
  const running = branches.reduce((total, branch) =>
    total + branch.calls.reduce((count, call) => count + call.tasks.filter(isActive).length, 0), 0)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  if (!branches.length) {
    return showEmpty ? (
      <div className="subagent-tree subagent-tree--empty">
        <Bot size={20} aria-hidden="true" />
        <span>{t('No subagent activity yet')}</span>
        <span className="subagent-tree__empty-hint">
          {t('Subagent calls appear here while they run.')}
        </span>
      </div>
    ) : null
  }

  return (
    <section className="subagent-tree" aria-label={t('Subagents')}>
      <div className="subagent-tree__heading">
        <Bot size={13} aria-hidden="true" />
        <span>{t('Subagents')}</span>
        {running ? <span className="subagent-tree__count" title={t('Active')}>{running}</span> : null}
      </div>
      <div className="subagent-tree__list" role="tree" aria-label={t('Subagents')}>
        {branches.map(({ session, calls }) => (
          <ConversationBranch
            key={session.file}
            session={session}
            calls={calls}
            now={now}
            onSelect={onSelect}
            onOpenTask={onOpenTask}
          />
        ))}
      </div>
    </section>
  )
}

function ConversationBranch({ session, calls, now, onSelect, onOpenTask }: {
  session: SessionMeta
  calls: SubagentCall[]
  now: number
  onSelect: (session: SessionMeta) => void
  onOpenTask?: (task: SubagentTreeTask, session: SessionMeta) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(() => readProcessOpen(session.file, 'subagent-tree') ?? true)
  const tasks = calls.flatMap((call) => call.tasks)
  const completed = tasks.filter((task) => ['completed', 'failed', 'aborted'].includes(task.status)).length
  const active = tasks.some(isActive)
  const totals = tasks.reduce(
    (acc, task) => ({
      tokens: acc.tokens + (task.tokens ?? 0),
      duration: acc.duration + (durationOf(task, now) ?? 0)
    }),
    { tokens: 0, duration: 0 }
  )
  const name = session.name || session.preview || t('New chat')
  const branchStatus = active ? 'running' : tasks.length > 0 && completed === tasks.length ? 'completed' : 'idle'

  return (
    <div className="subagent-tree__branch" data-session-file={session.file}>
      <div className="subagent-tree__conversation" role="treeitem" aria-expanded={open}>
        <button
          type="button"
          className="subagent-tree__toggle"
          aria-label={t(open ? 'Collapse subagents' : 'Expand subagents')}
          onClick={() => {
            const next = !open
            writeProcessOpen(session.file, 'subagent-tree', next)
            setOpen(next)
          }}
        >
          <ChevronRight size={12} />
        </button>
        <span className="subagent-tree__status" data-status={branchStatus}>
          <StatusMark status={branchStatus} />
        </span>
        <button className="subagent-tree__conversation-name" title={name} onClick={() => onSelect(session)}>
          {name}
        </button>
        <span className="subagent-tree__total">{completed}/{tasks.length}</span>
        <span className="subagent-tree__metrics">
          <span className="subagent-tree__metric-token">{totals.tokens ? formatTokens(totals.tokens) : ''}</span>
          <span className="subagent-tree__metric-duration">{totals.duration ? formatDuration(totals.duration) : ''}</span>
        </span>
      </div>
      {open ? (
        <ul className="subagent-tree__tasks" role="group">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              now={now}
              onOpen={() => onOpenTask?.(task, session)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function TaskRow({ task, now, onOpen }: { task: SubagentTreeTask; now: number; onOpen: () => void }) {
  const t = useT()
  const status = t(STATUS_LABEL[task.status])
  const duration = durationOf(task, now)
  const activity = task.activity ? `${t(task.activity)}${task.toolName ? ` · ${task.toolName}` : ''}` : undefined
  return (
    <li className="subagent-tree__task" data-status={task.status} role="treeitem">
      <button type="button" className="subagent-tree__task-row" title={task.task} onClick={onOpen} aria-label={`${status}: ${task.task}`}>
        <span className="subagent-tree__disclosure-space" aria-hidden="true" />
        <span className="subagent-tree__status" data-status={task.status}>
          <StatusMark status={task.status} />
        </span>
        <span className="subagent-tree__task-copy">
          <span className="subagent-tree__task-name">{task.task}</span>
          {activity ? <span className="subagent-tree__summary">{activity}</span> : null}
        </span>
        <span className="subagent-tree__metrics">
          <span className="subagent-tree__metric-token">{task.tokens ? formatTokens(task.tokens) : ''}</span>
          <span className="subagent-tree__metric-duration">{duration !== undefined ? formatDuration(duration) : ''}</span>
        </span>
      </button>
    </li>
  )
}
