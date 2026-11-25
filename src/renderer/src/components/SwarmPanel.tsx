import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowRight, ChevronRight, Loader2, Network, Square } from 'lucide-react'
import { formatDuration, formatTokens } from '../lib/format'
import { useT } from '../lib/i18n'
import { subagentCallOf, type SubagentTreeTask } from '../lib/subagents'
import {
  isSwarmWorking,
  parseSwarmSnapshots,
  summarizeSwarm,
  swarmPreview,
  swarmWorkers,
  SWARM_STATUS_KEY,
  type SwarmWorkerState
} from '../lib/swarm'
import { useAppStore } from '../store/useAppStore'
import { ConfirmDialog } from './ConfirmDialog'
import { SubagentAvatar } from './SubagentAvatar'
import { SubagentConversation } from './SubagentConversation'
import '../styles/swarm-panel.css'

const STATUS_LABEL = {
  starting: 'Starting',
  working: 'Working',
  idle: 'Idle',
  failed: 'Failed',
  stopped: 'Stopped',
  queued: 'Queued',
  history: 'Previously active'
} as const

const ASSIGNMENT_STATUS: Record<SubagentTreeTask['status'], string> = {
  proposed: 'Not run',
  queued: 'Queued',
  running: 'Running',
  dispatched: 'Dispatched',
  completed: 'Completed',
  failed: 'Failed',
  aborted: 'Stopped',
  timed_out: 'Timed out'
}

function focusComposer() {
  window.dispatchEvent(new Event('pi:focus-composer'))
}

function WorkerCard({ worker, live, now, expanded, stopPending, onToggle, onStop }: {
  worker: SwarmWorkerState
  live: boolean
  now: number
  expanded: boolean
  stopPending: boolean
  onToggle: () => void
  onStop: () => void
}) {
  const t = useT()
  const detailId = useId()
  const toggle = useRef<HTMLButtonElement>(null)
  const active = isSwarmWorking(worker)
  const working = live && active
  const status = active && !live ? 'history' : worker.status === 'idle' && active ? 'queued' : worker.status
  const end = status === 'working' || status === 'starting' ? now : worker.finishedAt
  const duration = worker.startedAt === undefined || end === undefined ? undefined : Math.max(0, end - worker.startedAt)
  const preview = swarmPreview(worker)
  const output = working ? worker.progressText : worker.output

  return (
    <li className="swarm__worker" data-open={expanded || undefined} data-status={status}>
      <div className="swarm__worker-head">
        <button
          ref={toggle}
          type="button"
          className="swarm__worker-toggle"
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={onToggle}
        >
          <SubagentAvatar workerName={worker.name} size={22} />
          <span className="swarm__worker-name" title={worker.name}>{worker.name}</span>
          <span className="swarm__badge" data-status={status}>
            {working ? <Loader2 size={11} className="spin" aria-hidden="true" /> : null}
            {t(STATUS_LABEL[status])}
          </span>
          <ChevronRight size={14} className="swarm__chevron" aria-hidden="true" />
        </button>
        {working ? (
          <button
            type="button"
            className="swarm__stop"
            title={t('Stop this worker')}
            aria-label={t('Stop {name}').replace('{name}', () => worker.name)}
            disabled={stopPending}
            onClick={() => {
              toggle.current?.focus()
              onStop()
            }}
          >
            <Square size={10} aria-hidden="true" />
            {t('Stop')}
          </button>
        ) : null}
      </div>
      <div className="swarm__worker-body">
        <div className="swarm__worker-task" title={worker.task}>{worker.task || t('No task yet')}</div>
        {!expanded && preview && preview !== worker.task ? (
          <div className="swarm__worker-preview" data-status={status}>{preview}</div>
        ) : null}
        {duration !== undefined || worker.tokens || worker.queued || worker.recycled ? (
          <div className="swarm__worker-meta">
            {duration !== undefined ? <span>{formatDuration(duration)}</span> : null}
            {worker.tokens ? <span>{t('{value} tokens').replace('{value}', formatTokens(worker.tokens))}</span> : null}
            {live && worker.queued ? <span>{t('{count} queued').replace('{count}', String(worker.queued))}</span> : null}
            {worker.recycled && !active ? <span>{t('Context released')}</span> : null}
          </div>
        ) : null}
        <div id={detailId} className="swarm__worker-detail" hidden={!expanded}>
          {expanded ? (
            <>
              {worker.role ? <p className="swarm__worker-role">{worker.role}</p> : null}
              {worker.errorMessage ? <p className="swarm__worker-error">{worker.errorMessage}</p> : null}
              {output ? (
                <pre className="swarm__worker-output" tabIndex={0} aria-label={t(working ? 'Live worker output' : 'Worker report')}>{output}</pre>
              ) : !worker.errorMessage ? (
                <p className="swarm__worker-role">{t(working ? 'Waiting for output…' : 'No output yet')}</p>
              ) : null}
              {!working && worker.outputTruncated ? <p className="swarm__worker-role">{t('Output truncated')}</p> : null}
            </>
          ) : null}
        </div>
      </div>
    </li>
  )
}

function SwarmSession({ sessionKey }: { sessionKey: string | undefined }) {
  const t = useT()
  const swarmMode = useAppStore((state) => state.agentMode === 'swarm')
  const isStreaming = useAppStore((state) => state.isStreaming)
  const setAgentMode = useAppStore((state) => state.setAgentMode)
  const stopSwarmWorker = useAppStore((state) => state.stopSwarmWorker)
  const activeToolsRevision = useAppStore((state) => state.activeToolsRevision)
  const rosterSource = useAppStore((state) => state.uiStatuses.find((entry) => entry.key === SWARM_STATUS_KEY)?.text)
  const live = rosterSource !== undefined
  const snapshot = useMemo(() => {
    const items = useAppStore.getState().items
    return {
      workers: swarmWorkers(items),
      assignments: items.flatMap((item) =>
        item.kind === 'tool' && (item.toolName === 'swarm_task' || item.toolName === 'swarm_message')
          ? subagentCallOf(item).tasks : []
      ).reverse()
    }
  }, [activeToolsRevision])
  const workers = useMemo(() => live ? parseSwarmSnapshots(rosterSource) : snapshot.workers, [live, rosterSource, snapshot.workers])
  const summary = useMemo(() => summarizeSwarm(workers), [workers])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const assignmentTrigger = useRef<HTMLButtonElement | null>(null)
  const [confirmStopAll, setConfirmStopAll] = useState(false)
  const [stopPending, setStopPending] = useState(false)
  const [now, setNow] = useState(Date.now)
  const working = live && summary.working > 0
  const selected = snapshot.assignments.find((task) => task.id === selectedId)

  useEffect(() => {
    if (!working) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [working])

  async function stop(name: string) {
    if (!live || stopPending) return
    setStopPending(true)
    try {
      await stopSwarmWorker(name, sessionKey)
    } finally {
      setStopPending(false)
    }
  }

  if (!workers.length && !snapshot.assignments.length) {
    return (
      <div className="swarm swarm--empty">
        <Network size={24} aria-hidden="true" />
        <h2>{t('No workers in this conversation')}</h2>
        <p>{t(swarmMode
          ? 'Describe the work in the composer. The lead can create workers and assign tasks.'
          : 'Turn on Swarm Mode to let the lead create a team for this conversation.')}</p>
        <button
          type="button"
          className="btn"
          disabled={!swarmMode && isStreaming}
          onClick={() => {
            if (!swarmMode) void setAgentMode('swarm')
            focusComposer()
          }}
        >
          {t(swarmMode ? 'Describe the work' : 'Use Swarm Mode')}
          <ArrowRight size={14} aria-hidden="true" />
        </button>
      </div>
    )
  }

  return (
    <>
      <div className="swarm" hidden={Boolean(selected)}>
        {workers.length > 0 ? (
          <section aria-label={t('Workers')}>
            <div className="swarm__bar">
              <h2>{t('Workers')} <span>{summary.total}</span></h2>
              {working ? (
                <button type="button" className="swarm__stop swarm__stop-all" disabled={stopPending} onClick={() => setConfirmStopAll(true)}>
                  {t(stopPending ? 'Stopping…' : 'Stop all')}
                </button>
              ) : null}
            </div>
            {live ? (
              <>
                <div className="swarm__stats">
                  {summary.working > 0 ? <span>{t('{count} working').replace('{count}', String(summary.working))}</span> : null}
                  {summary.idle > 0 ? <span>{t('{count} idle').replace('{count}', String(summary.idle))}</span> : null}
                  {summary.failed > 0 ? <span data-tone="danger">{t('{count} failed').replace('{count}', String(summary.failed))}</span> : null}
                  {summary.stopped > 0 ? <span>{t('{count} stopped').replace('{count}', String(summary.stopped))}</span> : null}
                  {summary.tokens > 0 ? <span>{t('{value} tokens').replace('{value}', formatTokens(summary.tokens))}</span> : null}
                </div>
                {!swarmMode ? <p className="swarm__notice">{t('Swarm Mode is off. Workers can finish their current tasks.')}</p> : null}
              </>
            ) : <p className="swarm__notice">{t('Worker history · no live status')}</p>}
            <ul className="swarm__grid">
              {workers.map((worker) => (
                <WorkerCard
                  key={worker.name}
                  worker={worker}
                  live={live}
                  now={now}
                  expanded={expanded === worker.name}
                  stopPending={stopPending}
                  onToggle={() => setExpanded((current) => current === worker.name ? null : worker.name)}
                  onStop={() => void stop(worker.name)}
                />
              ))}
            </ul>
          </section>
        ) : (
          <p className="swarm__notice">{t('No workers in this conversation')}</p>
        )}

        {snapshot.assignments.length ? (
          <details className="swarm__history">
            <summary>{t('Dispatch history')} <span>{snapshot.assignments.length}</span></summary>
            <ul>
              {snapshot.assignments.map((task) => (
                <li key={task.id}>
                  <button type="button" className="swarm__assignment" onClick={(event) => {
                    assignmentTrigger.current = event.currentTarget
                    setSelectedId(task.id)
                  }}>
                    <SubagentAvatar task={task} />
                    <span className="swarm__assignment-copy">
                      <strong>{task.label || task.task}</strong>
                      <span>{task.task}</span>
                    </span>
                    <span>{t(!live && task.status === 'running' ? STATUS_LABEL.history : ASSIGNMENT_STATUS[task.status])}</span>
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {confirmStopAll && working ? (
          <ConfirmDialog
            title={t('Stop all active workers?')}
            body={t('Their current and queued tasks will be cancelled. Reports already returned remain available.')}
            confirmLabel="Stop all"
            tone="danger"
            onCancel={() => setConfirmStopAll(false)}
            onConfirm={() => {
              setConfirmStopAll(false)
              void stop('*')
            }}
          />
        ) : null}
      </div>
      {selected ? (
        <SubagentConversation
          target={{ task: !live && selected.status === 'running' ? { ...selected, status: 'dispatched' } : selected }}
          onBack={() => {
            setSelectedId(null)
            requestAnimationFrame(() => assignmentTrigger.current?.focus())
          }}
        />
      ) : null}
    </>
  )
}

/** The current conversation's worker roster and dispatched tasks. */
export const SwarmPanel = memo(function SwarmPanel() {
  const sessionKey = useAppStore((state) => state.activeSessionFile ?? state.draftId)
  return <SwarmSession key={sessionKey} sessionKey={sessionKey} />
})
