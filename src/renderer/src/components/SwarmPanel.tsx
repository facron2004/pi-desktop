import { memo, useEffect, useMemo, useState } from 'react'
import { ChevronRight, Loader2, Network, Square } from 'lucide-react'
import { formatDuration, formatTokens } from '../lib/format'
import { useT } from '../lib/i18n'
import { isDelegationTool } from '../lib/subagents'
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
import { SubagentOverview } from './SubagentPanel'
import '../styles/swarm-panel.css'

const STATUS_LABEL: Record<SwarmWorkerState['status'], string> = {
  starting: 'Starting',
  working: 'Working',
  idle: 'Idle',
  failed: 'Failed',
  stopped: 'Stopped'
}

function StatusMark({ status }: { status: SwarmWorkerState['status'] }) {
  if (status === 'working' || status === 'starting') {
    return <Loader2 size={12} className="swarm__status-icon spin" aria-hidden="true" />
  }
  const tone = status === 'failed' ? 'danger' : status === 'stopped' ? 'stopped' : 'idle'
  return <span className="swarm__status-dot" data-tone={tone} aria-hidden="true" />
}

function durationOf(worker: SwarmWorkerState, now: number): number {
  if (worker.startedAt === undefined) return 0
  if (worker.status === 'working' || worker.status === 'starting') {
    return Math.max(0, now - worker.startedAt)
  }
  return Math.max(0, (worker.finishedAt ?? worker.startedAt) - worker.startedAt)
}

function WorkerCard({ worker, now, expanded, onToggle, onStop }: {
  worker: SwarmWorkerState
  now: number
  expanded: boolean
  onToggle: () => void
  onStop: () => void
}) {
  const t = useT()
  const working = isSwarmWorking(worker)
  const preview = swarmPreview(worker)
  return (
    <div
      className="swarm__worker"
      data-open={expanded || undefined}
      data-status={worker.status}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onToggle()
        }
      }}
    >
      <div className="swarm__worker-head">
        <StatusMark status={worker.status} />
        <span className="swarm__worker-name">{worker.name}</span>
        <span className="swarm__badge" data-status={worker.status}>{t(STATUS_LABEL[worker.status])}</span>
      </div>
      {worker.role ? <div className="swarm__worker-role">{worker.role}</div> : null}
      <div className="swarm__worker-task" title={worker.task || undefined}>
        {worker.task || t('No task yet')}
      </div>
      {preview && preview !== worker.task ? (
        <div className="swarm__worker-preview" data-live={working || undefined}>{preview}</div>
      ) : null}
      <div className="swarm__worker-meta">
        <span>{formatDuration(durationOf(worker, now))}</span>
        {worker.tokens ? <span>{formatTokens(worker.tokens)}</span> : null}
        {worker.recycled && !working ? <span className="swarm__worker-note">{t('Context released')}</span> : null}
        <span className="swarm__worker-spacer" />
        {working ? (
          <button
            type="button"
            className="swarm__stop"
            title={t('Stop this worker')}
            aria-label={t('Stop this worker')}
            onClick={(event) => {
              event.stopPropagation()
              onStop()
            }}
          >
            <Square size={9} fill="currentColor" strokeWidth={0} />
            {t('Stop')}
          </button>
        ) : null}
        <ChevronRight size={12} className="swarm__chevron" aria-hidden="true" />
      </div>
      {expanded ? (
        <div className="swarm__worker-detail">
          {worker.errorMessage ? (
            <div className="swarm__worker-error">{worker.errorMessage}</div>
          ) : null}
          <pre className="swarm__worker-output">
            {worker.output || worker.progressText || t('No output yet')}
          </pre>
          {worker.outputTruncated ? (
            <div className="swarm__worker-note">{t('Output truncated')}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function WorkerRoster({ workers }: { workers: SwarmWorkerState[] }) {
  const t = useT()
  const stopSwarmWorker = useAppStore((state) => state.stopSwarmWorker)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)

  const summary = useMemo(() => summarizeSwarm(workers), [workers])
  const working = summary.working > 0

  useEffect(() => {
    if (!working) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [working])

  return (
    <>
      <div className="swarm__bar">
        <span className="swarm__bar-title">
          <Network size={13} aria-hidden="true" />
          {t('Workers')}
          <span className="swarm__count">{summary.total}</span>
        </span>
        <span className="swarm__bar-stat">{t('{count} working').replace('{count}', String(summary.working))}</span>
        {summary.idle > 0 ? (
          <span className="swarm__bar-stat">{t('{count} idle').replace('{count}', String(summary.idle))}</span>
        ) : null}
        {summary.failed > 0 ? (
          <span className="swarm__bar-stat" data-tone="danger">
            {t('{count} failed').replace('{count}', String(summary.failed))}
          </span>
        ) : null}
        {summary.tokens > 0 ? <span className="swarm__bar-stat">{formatTokens(summary.tokens)}</span> : null}
        <span className="swarm__worker-spacer" />
        {working ? (
          <button
            type="button"
            className="swarm__stop-all"
            onClick={() => {
              for (const worker of workers) {
                if (isSwarmWorking(worker)) void stopSwarmWorker(worker.name)
              }
            }}
          >
            {t('Stop all')}
          </button>
        ) : null}
      </div>
      <div className="swarm__grid">
        {workers.map((worker) => (
          <WorkerCard
            key={worker.name}
            worker={worker}
            now={now}
            expanded={expanded === worker.name}
            onToggle={() => setExpanded(expanded === worker.name ? null : worker.name)}
            onStop={() => void stopSwarmWorker(worker.name)}
          />
        ))}
      </div>
    </>
  )
}

/** The current conversation's worker roster and dispatched tasks. */
export const SwarmPanel = memo(function SwarmPanel({ onOpenTask }: { onOpenTask: (taskId: string) => void }) {
  const t = useT()
  const sessionKey = useAppStore((state) => state.activeSessionFile ?? state.draftId)
  const swarmMode = useAppStore((state) => state.agentMode === 'swarm')
  const activeToolsRevision = useAppStore((state) => state.activeToolsRevision)
  const rosterSource = useAppStore((state) => state.uiStatuses.find((entry) => entry.key === SWARM_STATUS_KEY)?.text)
  const workers = useMemo(
    () => rosterSource === undefined ? swarmWorkers(useAppStore.getState().items) : parseSwarmSnapshots(rosterSource),
    [rosterSource, activeToolsRevision]
  )
  const hasDispatches = useMemo(
    () => useAppStore.getState().items.some((item) => item.kind === 'tool' && isDelegationTool(item.toolName)),
    [activeToolsRevision]
  )

  if (!workers.length && !hasDispatches) {
    return (
      <div className="swarm swarm--empty">
        <Network size={20} aria-hidden="true" />
        <span>{t(swarmMode ? 'No tasks have been delegated in this conversation yet.' : 'No workers in this conversation')}</span>
        {!swarmMode ? <span className="swarm__empty-hint">
          {t('Enter Swarm Mode and ask for a team; workers appear here while they work.')}
        </span> : null}
      </div>
    )
  }

  return (
    <div className="swarm">
      {workers.length > 0 ? <WorkerRoster key={sessionKey} workers={workers} /> : null}
      {sessionKey && hasDispatches ? (
        <SubagentOverview sessionKey={sessionKey} onSelectTask={({ taskId }) => onOpenTask(taskId)} />
      ) : null}
    </div>
  )
})
