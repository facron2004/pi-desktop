import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ArrowRight, Check, ChevronRight, Clock, Loader2, Network, Square, X } from 'lucide-react'
import { formatDuration, formatRelativeTime, formatTokens } from '../lib/format'
import { useT } from '../lib/i18n'
import {
  assignmentsByWorker,
  countAssignments,
  displayStatusOf,
  filterAssignments,
  filterWorkers,
  isSwarmWorking,
  parseSwarmSnapshots,
  summarizeSwarm,
  swarmAssignments,
  swarmFeed,
  swarmPreview,
  swarmStartedAt,
  swarmWorkers,
  SWARM_STATUS_KEY,
  type SwarmAssignment,
  type SwarmAssignmentFilter,
  type SwarmDisplayStatus,
  type SwarmWorkerFilter,
  type SwarmWorkerState
} from '../lib/swarm'
import { useAppStore } from '../store/useAppStore'
import { ConfirmDialog } from './ConfirmDialog'
import { SubagentAvatar } from './SubagentAvatar'
import { SubagentConversation } from './SubagentConversation'
import '../styles/swarm-panel.css'

type SwarmView = 'overview' | 'workers' | 'dispatches'

const STATUS_LABEL: Record<SwarmDisplayStatus, string> = {
  starting: 'Starting',
  working: 'Working',
  queued: 'Queued',
  idle: 'Idle',
  failed: 'Failed',
  stopped: 'Stopped',
  history: 'Previously active'
}

const ASSIGNMENT_LABEL: Record<SwarmAssignment['status'], string> = {
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

/** The glyph a task block or a dispatch row wears for its state. */
function AssignmentMark({ status }: { status: SwarmAssignment['status'] }) {
  if (status === 'running') return <Loader2 size={12} className="spin" aria-hidden="true" />
  if (status === 'completed') return <Check size={12} aria-hidden="true" />
  if (status === 'failed' || status === 'timed_out') return <X size={12} aria-hidden="true" />
  return <Clock size={12} aria-hidden="true" />
}

function AssignmentChip({
  assignment,
  onOpen
}: {
  assignment: SwarmAssignment
  onOpen: (assignment: SwarmAssignment, element: HTMLElement) => void
}) {
  const t = useT()
  const label = t(ASSIGNMENT_LABEL[assignment.status])
  return (
    <button
      type="button"
      className="swarm__lane-task"
      data-status={assignment.status}
      title={`${assignment.task} · ${label}`}
      aria-label={`${assignment.task} · ${label}`}
      onClick={(event) => onOpen(assignment, event.currentTarget)}
    >
      <AssignmentMark status={assignment.status} />
    </button>
  )
}

function WorkerRow({
  worker,
  live,
  now,
  expanded,
  stopPending,
  toggleRef,
  onToggle,
  onStop
}: {
  worker: SwarmWorkerState
  live: boolean
  now: number
  expanded: boolean
  stopPending: boolean
  toggleRef: (element: HTMLButtonElement | null) => void
  onToggle: () => void
  onStop: () => void
}) {
  const t = useT()
  const detailId = `swarm-worker-${worker.name}`
  const status = displayStatusOf(worker, live)
  const active = isSwarmWorking(worker)
  const end = status === 'working' || status === 'starting' ? now : worker.finishedAt
  const duration = worker.startedAt === undefined || end === undefined ? undefined : Math.max(0, end - worker.startedAt)
  const preview = swarmPreview(worker)
  const output = worker.status === 'working' && live ? worker.progressText : worker.output
  const busy = live && active

  return (
    <li className="swarm__worker" data-status={status} data-open={expanded || undefined}>
      <div className="swarm__worker-head">
        <button
          ref={toggleRef}
          type="button"
          className="swarm__worker-toggle"
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={onToggle}
        >
          <SubagentAvatar workerName={worker.name} size={22} />
          <span className="swarm__worker-name" title={worker.name}>{worker.name}</span>
          <span className="swarm__badge" data-status={status}>
            {busy ? <Loader2 size={11} className="spin" aria-hidden="true" /> : null}
            {t(STATUS_LABEL[status])}
          </span>
          <ChevronRight size={14} className="swarm__chevron" aria-hidden="true" />
        </button>
        {busy ? (
          <button
            type="button"
            className="swarm__stop"
            title={t('Stop this worker')}
            aria-label={t('Stop {name}').replace('{name}', () => worker.name)}
            disabled={stopPending}
            onClick={onStop}
          >
            <Square size={10} aria-hidden="true" />
            {t('Stop')}
          </button>
        ) : null}
      </div>
      <div className="swarm__worker-body">
        <p className="swarm__worker-task" title={worker.task}>{worker.task || t('No task yet')}</p>
        {!expanded && preview && preview !== worker.task ? (
          <p className="swarm__worker-preview" data-status={status}>{preview}</p>
        ) : null}
        {duration !== undefined || worker.tokens || worker.queued || worker.role || worker.model ? (
          <div className="swarm__worker-meta">
            {worker.role ? <span>{worker.role}</span> : null}
            {worker.model ? <span title={worker.model}>{worker.model.split('/').pop()}</span> : null}
            {duration !== undefined ? <span>{formatDuration(duration)}</span> : null}
            {worker.tokens ? <span>{t('{value} tokens').replace('{value}', formatTokens(worker.tokens))}</span> : null}
            {live && worker.queued ? <span>{t('{count} queued').replace('{count}', String(worker.queued))}</span> : null}
            {worker.recycled && !active ? <span>{t('Context released')}</span> : null}
          </div>
        ) : null}
        <div id={detailId} className="swarm__worker-detail" hidden={!expanded}>
          {expanded ? (
            <>
              {worker.errorMessage ? <p className="swarm__worker-error">{worker.errorMessage}</p> : null}
              {output ? (
                <pre
                  className="swarm__worker-output"
                  tabIndex={0}
                  aria-label={t(busy ? 'Live worker output' : 'Worker report')}
                >{output}</pre>
              ) : !worker.errorMessage ? (
                <p className="swarm__worker-role">{t(busy ? 'Waiting for output…' : 'No output yet')}</p>
              ) : null}
              {!busy && worker.outputTruncated ? <p className="swarm__worker-role">{t('Output truncated')}</p> : null}
            </>
          ) : null}
        </div>
      </div>
    </li>
  )
}

function OverView({
  workers,
  assignments,
  live,
  now,
  language,
  onOpen
}: {
  workers: SwarmWorkerState[]
  assignments: SwarmAssignment[]
  live: boolean
  now: number
  language: 'en' | 'zh-CN'
  onOpen: (assignment: SwarmAssignment, element: HTMLElement) => void
}) {
  const t = useT()
  const summary = summarizeSwarm(workers)
  const counts = countAssignments(assignments)
  const lanes = assignmentsByWorker(assignments)
  // Every current worker gets a lane, even before it was handed anything: the
  // page is where the reader watches the team, not only where the lead's
  // hand-offs are listed.
  const laneNames = [...new Set([...workers.map((worker) => worker.name), ...lanes.keys()])]
  const feed = swarmFeed(workers, assignments, live, 8)
  const startedAt = swarmStartedAt(workers)
  const lastAt = useMemo(() => {
    let latest: number | undefined
    for (const worker of workers) {
      const at = worker.finishedAt ?? (live && isSwarmWorking(worker) ? now : undefined)
      if (at !== undefined && (latest === undefined || at > latest)) latest = at
    }
    for (const assignment of assignments) {
      if (assignment.at !== undefined && (latest === undefined || assignment.at > latest)) latest = assignment.at
    }
    return latest
  }, [workers, assignments, live, now])
  const elapsed = startedAt !== undefined && lastAt !== undefined ? Math.max(0, lastAt - startedAt) : undefined

  return (
    <div className="swarm__view swarm__view--overview">
      <dl className="swarm__kv">
        <div><dt>{t('Workers')}</dt><dd>{summary.total}</dd></div>
        <div><dt>{t('Active tasks')}</dt><dd>{counts.active}</dd></div>
        <div><dt>{t('Queued tasks')}</dt><dd>{counts.queued}</dd></div>
        <div><dt>{t('Tokens')}</dt><dd>{formatTokens(summary.tokens)}</dd></div>
        <div><dt>{t('Elapsed')}</dt><dd>{elapsed === undefined ? '—' : formatDuration(elapsed)}</dd></div>
      </dl>
      {!live ? <p className="swarm__notice">{t('Worker history · no live status')}</p> : null}

      <section className="swarm__section" aria-labelledby="swarm-lanes-title">
        <h3 id="swarm-lanes-title">{t('Workers and their tasks')}</h3>
        {laneNames.length > 0 ? (
          <ul className="swarm__lanes">
            {laneNames.map((name) => {
              const worker = workers.find((entry) => entry.name === name)
              const lane = lanes.get(name) ?? []
              const status = worker ? displayStatusOf(worker, live) : 'history'
              const busy = worker ? isSwarmWorking(worker) : false
              const activity = worker && live ? swarmPreview(worker) : ''
              return (
                <li className="swarm__lane" key={name} data-status={status}>
                  <div className="swarm__lane-head">
                    <SubagentAvatar workerName={name} size={20} />
                    <span className="swarm__lane-name" title={name}>{name}</span>
                    <span className="swarm__badge" data-status={status}>
                      {busy && live ? <Loader2 size={11} className="spin" aria-hidden="true" /> : null}
                      {t(STATUS_LABEL[status])}
                    </span>
                    <span className="swarm__lane-count" title={t('{count} tasks').replace('{count}', String(lane.length))}>
                      {lane.length}
                    </span>
                  </div>
                  {lane.length > 0 ? (
                    <div className="swarm__lane-strip" role="group" aria-label={t('Tasks for {name}').replace('{name}', () => name)}>
                      {lane.slice(-12).map((assignment) => (
                        <AssignmentChip key={assignment.id} assignment={assignment} onOpen={onOpen} />
                      ))}
                    </div>
                  ) : null}
                  {lane.length === 0 || activity ? (
                    <p className="swarm__lane-live" title={activity}>
                      {activity || t('No tasks yet')}
                    </p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="swarm__notice">{workers.length ? t('No tasks yet') : t('No workers in this conversation')}</p>
        )}
      </section>

      <section className="swarm__section" aria-labelledby="swarm-feed-title">
        <h3 id="swarm-feed-title">
          <Activity size={13} aria-hidden="true" />
          {t('Recent activity')}
        </h3>
        {feed.length ? (
          <ul className="swarm__feed">
            {feed.map((event) => (
              <li key={event.id} data-status={event.status}>
                {event.assignment ? (
                  <button
                    type="button"
                    className="swarm__feed-row"
                    onClick={(click) => onOpen(event.assignment!, click.currentTarget)}
                  >
                    <AssignmentMark status={event.assignment.status} />
                    <span className="swarm__feed-name">{event.name}</span>
                    <span className="swarm__feed-text" title={event.task}>{event.task}</span>
                    <time>{event.at === undefined ? '' : formatRelativeTime(event.at, language)}</time>
                  </button>
                ) : (
                  <div className="swarm__feed-row">
                    <Loader2 size={12} className="spin" aria-hidden="true" />
                    <span className="swarm__feed-name">{event.name}</span>
                    <span className="swarm__feed-text" title={event.activity}>{event.activity || event.task}</span>
                    <time>{event.at === undefined ? '' : formatRelativeTime(event.at, language)}</time>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="swarm__notice">{t('No activity yet')}</p>}
      </section>
    </div>
  )
}

function DispatchList({
  assignments,
  live,
  language,
  onOpen
}: {
  assignments: SwarmAssignment[]
  live: boolean
  language: 'en' | 'zh-CN'
  onOpen: (assignment: SwarmAssignment, element: HTMLElement) => void
}) {
  const t = useT()
  const [filter, setFilter] = useState<SwarmAssignmentFilter>('all')
  const counts = countAssignments(assignments)
  const filters: { value: SwarmAssignmentFilter; label: string; count: number }[] = [
    { value: 'all', label: 'All', count: counts.total },
    { value: 'active', label: 'Active', count: counts.active + counts.queued },
    { value: 'done', label: 'Completed', count: counts.completed },
    { value: 'failed', label: 'Failed', count: counts.failed }
  ]
  const rows = filterAssignments(assignments, filter)

  return (
    <div className="swarm__view swarm__view--dispatches">
      <div className="swarm__filters" role="group" aria-label={t('Filter dispatches')}>
        {filters.map((entry) => (
          <button
            key={entry.value}
            type="button"
            className="swarm__filter"
            aria-pressed={filter === entry.value}
            onClick={() => setFilter(entry.value)}
          >
            {t(entry.label)}<span>{entry.count}</span>
          </button>
        ))}
      </div>
      {rows.length ? (
        <ol className="swarm__dispatches">
          {rows.map((assignment) => (
            <li key={assignment.id}>
              <button
                type="button"
                className="swarm__dispatch"
                data-status={assignment.status}
                onClick={(event) => onOpen(assignment, event.currentTarget)}
              >
                <span className="swarm__dispatch-mark"><AssignmentMark status={assignment.status} /></span>
                <span className="swarm__dispatch-copy">
                  <span className="swarm__dispatch-head">
                    <strong>{assignment.worker || t('Lead')}</strong>
                    <span className="swarm__dispatch-status">{t(!live && assignment.status === 'running' ? STATUS_LABEL.history : ASSIGNMENT_LABEL[assignment.status])}</span>
                    {assignment.at !== undefined ? <time>{formatRelativeTime(assignment.at, language)}</time> : null}
                  </span>
                  <span className="swarm__dispatch-task" title={assignment.task}>{assignment.task}</span>
                  {assignment.tokens ? (
                    <span className="swarm__dispatch-meta">{t('{value} tokens').replace('{value}', formatTokens(assignment.tokens))}</span>
                  ) : null}
                </span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
      ) : <p className="swarm__notice">{t('Nothing in this filter')}</p>}
    </div>
  )
}

function WorkerList({
  workers,
  live,
  now,
  stopPending,
  expanded,
  onToggle,
  onStop
}: {
  workers: SwarmWorkerState[]
  live: boolean
  now: number
  stopPending: boolean
  expanded: Set<string>
  onToggle: (name: string) => void
  onStop: (name: string) => void
}) {
  const t = useT()
  const [filter, setFilter] = useState<SwarmWorkerFilter>('all')
  const rowRefs = useRef(new Map<string, HTMLButtonElement | null>())
  const counts = {
    all: workers.length,
    active: filterWorkers(workers, live, 'active').length,
    idle: filterWorkers(workers, live, 'idle').length,
    failed: filterWorkers(workers, live, 'failed').length
  }
  const filters: { value: SwarmWorkerFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'active', label: 'Active' },
    { value: 'idle', label: 'Idle' },
    { value: 'failed', label: 'Failed' }
  ]
  const rows = filterWorkers(workers, live, filter)

  const move = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const names = rows.map((worker) => worker.name)
    const index = names.findIndex((name) => rowRefs.current.get(name) === document.activeElement)
    if (index < 0) return
    event.preventDefault()
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? names.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + names.length) % names.length
    rowRefs.current.get(names[next])?.focus()
  }

  return (
    <div className="swarm__view swarm__view--workers">
      <div className="swarm__filters" role="group" aria-label={t('Filter workers')}>
        {filters.map((entry) => (
          <button
            key={entry.value}
            type="button"
            className="swarm__filter"
            aria-pressed={filter === entry.value}
            onClick={() => setFilter(entry.value)}
          >
            {t(entry.label)}<span>{counts[entry.value]}</span>
          </button>
        ))}
      </div>
      {rows.length ? (
        <ul className="swarm__workers" onKeyDown={move}>
          {rows.map((worker) => (
            <WorkerRow
              key={worker.name}
              worker={worker}
              live={live}
              now={now}
              expanded={expanded.has(worker.name)}
              stopPending={stopPending}
              toggleRef={(element) => rowRefs.current.set(worker.name, element)}
              onToggle={() => onToggle(worker.name)}
              onStop={() => onStop(worker.name)}
            />
          ))}
        </ul>
      ) : <p className="swarm__notice">{t('Nothing in this filter')}</p>}
    </div>
  )
}

function SwarmSession({ sessionKey }: { sessionKey: string | undefined }) {
  const t = useT()
  const language = useAppStore((state) => state.settings.language ?? 'en')
  const swarmMode = useAppStore((state) => state.agentMode === 'swarm')
  const isStreaming = useAppStore((state) => state.isStreaming)
  const setAgentMode = useAppStore((state) => state.setAgentMode)
  const stopSwarmWorker = useAppStore((state) => state.stopSwarmWorker)
  const activeToolsRevision = useAppStore((state) => state.activeToolsRevision)
  const rosterSource = useAppStore((state) => state.uiStatuses.find((entry) => entry.key === SWARM_STATUS_KEY)?.text)
  const live = rosterSource !== undefined
  const snapshot = useMemo(() => {
    const items = useAppStore.getState().items
    return { workers: swarmWorkers(items), assignments: swarmAssignments(items) }
  }, [activeToolsRevision])
  const workers = useMemo(() => live ? parseSwarmSnapshots(rosterSource) : snapshot.workers, [live, rosterSource, snapshot.workers])
  const summary = useMemo(() => summarizeSwarm(workers), [workers])
  const [view, setView] = useState<SwarmView>(() => workers.length || live ? 'overview' : 'dispatches')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const [confirmStopAll, setConfirmStopAll] = useState(false)
  const [stopPending, setStopPending] = useState(false)
  const [now, setNow] = useState(Date.now)
  const working = live && summary.working > 0
  const selected = snapshot.assignments.find((assignment) => assignment.id === selectedId)

  useEffect(() => {
    if (!working) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [working])

  const openAssignment = (assignment: SwarmAssignment, element: HTMLElement) => {
    trigger.current = element
    setSelectedId(assignment.id)
  }

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

  const tabs: { value: SwarmView; label: string; count: number }[] = [
    { value: 'overview', label: 'Overview', count: 0 },
    { value: 'workers', label: 'Workers', count: workers.length },
    { value: 'dispatches', label: 'Dispatches', count: snapshot.assignments.length }
  ]

  return (
    <>
      <div className="swarm" hidden={Boolean(selected)}>
        <header className="swarm__head">
          <div className="swarm__summary">
            <span className="swarm__live" data-live={live || undefined}>
              {t(live ? 'Live' : 'History')}
            </span>
            {live ? (
              <>
                {summary.working > 0 ? <span data-tone="run">{t('{count} working').replace('{count}', String(summary.working))}</span> : null}
                {summary.idle > 0 ? <span>{t('{count} idle').replace('{count}', String(summary.idle))}</span> : null}
                {summary.failed > 0 ? <span data-tone="danger">{t('{count} failed').replace('{count}', String(summary.failed))}</span> : null}
                {summary.stopped > 0 ? <span>{t('{count} stopped').replace('{count}', String(summary.stopped))}</span> : null}
                {summary.tokens > 0 ? <span>{t('{value} tokens').replace('{value}', formatTokens(summary.tokens))}</span> : null}
              </>
            ) : (
              <span>{t('{count} dispatched tasks').replace('{count}', String(snapshot.assignments.length))}</span>
            )}
            <span className="swarm__spacer" />
            {working ? (
              <button
                type="button"
                className="swarm__stop swarm__stop-all"
                disabled={stopPending}
                onClick={() => setConfirmStopAll(true)}
              >
                {t(stopPending ? 'Stopping…' : 'Stop all')}
              </button>
            ) : null}
          </div>
          <div className="swarm__tabs" role="group" aria-label={t('Swarm views')}>
            {tabs.map((entry) => (
              <button
                key={entry.value}
                type="button"
                className="swarm__tab"
                aria-pressed={view === entry.value}
                onClick={() => setView(entry.value)}
              >
                {t(entry.label)}{entry.count > 0 ? <span>{entry.count}</span> : null}
              </button>
            ))}
          </div>
          {!swarmMode ? <p className="swarm__notice">{t('Swarm Mode is off. Workers can finish their current tasks.')}</p> : null}
        </header>
        <div className="swarm__body">
          {view === 'overview' ? (
            <OverView
              workers={workers}
              assignments={snapshot.assignments}
              live={live}
              now={now}
              language={language}
              onOpen={openAssignment}
            />
          ) : view === 'workers' ? (
            <WorkerList
              workers={workers}
              live={live}
              now={now}
              stopPending={stopPending}
              expanded={expanded}
              onToggle={(name) => setExpanded((current) => {
                const next = new Set(current)
                if (next.has(name)) next.delete(name)
                else next.add(name)
                return next
              })}
              onStop={(name) => void stop(name)}
            />
          ) : (
            <DispatchList
              assignments={snapshot.assignments}
              live={live}
              language={language}
              onOpen={openAssignment}
            />
          )}
        </div>
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
          target={{ task: !live && selected.status === 'running' ? { ...selected.result, status: 'dispatched' } : selected.result }}
          onBack={() => {
            setSelectedId(null)
            requestAnimationFrame(() => trigger.current?.focus())
          }}
        />
      ) : null}
    </>
  )
}

/** The current conversation's worker roster, orchestration and dispatch history. */
export const SwarmPanel = memo(function SwarmPanel() {
  const sessionKey = useAppStore((state) => state.activeSessionFile ?? state.draftId)
  return <SwarmSession key={sessionKey} sessionKey={sessionKey} />
})
