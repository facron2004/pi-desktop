import { memo, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowRight, ChevronRight, Loader2, Network, Square } from 'lucide-react'
import { formatDuration, formatRelativeTime, formatTokens } from '../lib/format'
import { useT } from '../lib/i18n'
import {
  displayStatusOf,
  filterWorkers,
  isSwarmWorking,
  parseSwarmSnapshots,
  summarizeSwarm,
  swarmAssignments,
  swarmRosterLine,
  swarmSituation,
  swarmSpawnPending,
  swarmWorkers,
  rosterForPage,
  SWARM_STATUS_KEY,
  type SwarmAssignment,
  type SwarmDisplayStatus,
  type SwarmRosterLine,
  type SwarmWorkerFilter,
  type SwarmWorkerState
} from '../lib/swarm'
import { useAppStore } from '../store/useAppStore'
import { ConfirmDialog } from './ConfirmDialog'
import { SubagentAvatar } from './SubagentAvatar'
import { SubagentConversation } from './SubagentConversation'
import '../styles/swarm-panel.css'

const NARROW_PANEL = 480

const STATUS_LABEL: Record<SwarmDisplayStatus, string> = {
  starting: 'Starting',
  working: 'Working',
  queued: 'Queued',
  idle: 'Idle',
  failed: 'Failed',
  stopped: 'Stopped',
  history: 'Snapshot'
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

function rosterText(line: SwarmRosterLine, t: (text: string) => string): string {
  if (line.kind === 'tool') return t('Running {tool}').replace('{tool}', () => line.tool)
  if (line.kind === 'activity') return t(line.text)
  if (line.kind === 'error') return line.text
  if (line.kind === 'last') return t('Last: {task}').replace('{task}', () => line.text)
  return ''
}

function turnsFor(name: string, assignments: readonly SwarmAssignment[]): SwarmAssignment[] {
  const key = name.trim().toLowerCase()
  return assignments.filter((assignment) => assignment.worker.trim().toLowerCase() === key)
}

function WorkerRow({
  worker,
  live,
  now,
  selected,
  stopPending,
  toggleRef,
  onSelect,
  onStop
}: {
  worker: SwarmWorkerState
  live: boolean
  now: number
  selected: boolean
  stopPending: boolean
  toggleRef: (element: HTMLButtonElement | null) => void
  onSelect: () => void
  onStop: () => void
}) {
  const t = useT()
  const status = displayStatusOf(worker, live)
  const busy = live && isSwarmWorking(worker)
  const end = status === 'working' || status === 'starting' ? now : worker.finishedAt
  const duration = worker.startedAt === undefined || end === undefined ? undefined : Math.max(0, end - worker.startedAt)
  const line = rosterText(swarmRosterLine(worker, live), t)

  return (
    <li className="swarm__worker" data-status={status} data-selected={selected || undefined}>
      <button
        ref={toggleRef}
        type="button"
        className="swarm__worker-toggle"
        aria-pressed={selected}
        aria-controls="swarm-worker-detail"
        onClick={onSelect}
      >
        <span className="swarm__mark" data-status={status} />
        <span className="swarm__avatar">
          <SubagentAvatar workerName={worker.name} size={22} />
        </span>
        <span className="swarm__identity">
          <span className="swarm__worker-name" title={worker.name}>{worker.name}</span>
          {worker.role ? <span className="swarm__worker-role" title={worker.role}>{worker.role}</span> : null}
        </span>
        <span className="swarm__worker-status">
          <span className="swarm__badge" data-status={status}>
            {busy ? <Loader2 size={11} className="spin" aria-hidden="true" /> : null}
            {t(STATUS_LABEL[status])}
          </span>
          {duration !== undefined ? <span className="swarm__duration">{formatDuration(duration)}</span> : null}
          {live && worker.queued ? (
            <span className="swarm__queue">{t('{count} queued').replace('{count}', String(worker.queued))}</span>
          ) : null}
        </span>
        <span className="swarm__worker-line" data-status={status === 'failed' ? 'failed' : undefined} title={line}>
          {line || t('No task yet')}
        </span>
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
    </li>
  )
}

function OutputBlock({ text, label }: { text: string; label: string }) {
  const ref = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const node = ref.current
    if (!node || !stick.current) return
    node.scrollTop = node.scrollHeight
  }, [text])
  return (
    <pre
      ref={ref}
      className="swarm__worker-output"
      tabIndex={0}
      aria-label={label}
      onScroll={(event) => {
        const node = event.currentTarget
        stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
      }}
    >{text}</pre>
  )
}

function WorkerDetail({
  worker,
  assignments,
  live,
  now,
  language,
  stopPending,
  backRef,
  onBack,
  onStop,
  onOpen
}: {
  worker: SwarmWorkerState
  assignments: SwarmAssignment[]
  live: boolean
  now: number
  language: 'en' | 'zh-CN'
  stopPending: boolean
  backRef: (element: HTMLButtonElement | null) => void
  onBack: () => void
  onStop: () => void
  onOpen: (assignment: SwarmAssignment, element: HTMLElement) => void
}) {
  const t = useT()
  const status = displayStatusOf(worker, live)
  const busy = live && isSwarmWorking(worker)
  const end = status === 'working' || status === 'starting' ? now : worker.finishedAt
  const duration = worker.startedAt === undefined || end === undefined ? undefined : Math.max(0, end - worker.startedAt)
  const line = swarmRosterLine(worker, live)
  const action = rosterText(line, t)
  const output = worker.status === 'working' && live ? worker.progressText : worker.output
  const turns = turnsFor(worker.name, assignments)
  const model = worker.model?.split('/').pop()

  const leave = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    onBack()
  }

  return (
    <section
      id="swarm-worker-detail"
      className="swarm__detail"
      aria-labelledby="swarm-detail-name"
      onKeyDown={leave}
    >
      <header className="swarm__detail-head">
        <button ref={backRef} type="button" className="swarm__back" onClick={onBack}>
          {t('Back')}
        </button>
        <h3 id="swarm-detail-name">{worker.name}</h3>
        <span className="swarm__badge" data-status={status}>{t(STATUS_LABEL[status])}</span>
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
      </header>
      {worker.role ? <p className="swarm__detail-role">{worker.role}</p> : null}
      <dl className="swarm__detail-action">
        <div>
          <dt>{t('Action')}</dt>
          <dd data-status={line.kind === 'error' ? 'failed' : undefined}>{action || t('No task yet')}</dd>
        </div>
      </dl>
      {worker.errorMessage ? <p className="swarm__worker-error">{worker.errorMessage}</p> : null}
      {duration !== undefined || worker.turns || worker.tokens || model || (live && worker.queued) ? (
        <p className="swarm__detail-meta">
          {duration !== undefined ? <span>{formatDuration(duration)}</span> : null}
          {worker.turns ? <span>{t('{count} turns').replace('{count}', String(worker.turns))}</span> : null}
          {worker.tokens ? <span>{t('{value} tokens').replace('{value}', formatTokens(worker.tokens))}</span> : null}
          {model ? <span title={worker.model}>{model}</span> : null}
          {live && worker.queued ? <span>{t('{count} queued').replace('{count}', String(worker.queued))}</span> : null}
        </p>
      ) : null}
      {worker.recycled && !busy ? (
        <p className="swarm__detail-role">{t('The process was released. The next task starts it again.')}</p>
      ) : null}
      {output ? (
        <OutputBlock text={output} label={t(busy ? 'Live worker output' : 'Worker report')} />
      ) : !worker.errorMessage ? (
        <p className="swarm__detail-role">{t(busy ? 'Waiting for output…' : 'No output yet')}</p>
      ) : null}
      {!busy && worker.outputTruncated ? <p className="swarm__detail-role">{t('Output truncated')}</p> : null}
      <h4>{t('Tasks for {name}').replace('{name}', () => worker.name)}</h4>
      {turns.length ? (
        <ul className="swarm__turns">
          {turns.map((assignment) => (
            <li key={assignment.id}>
              <button
                type="button"
                className="swarm__turn"
                data-status={assignment.status}
                onClick={(event) => onOpen(assignment, event.currentTarget)}
              >
                <span className="swarm__turn-copy">
                  <strong>{assignment.task}</strong>
                  <span>
                    {t(!live && assignment.status === 'running' ? STATUS_LABEL.history : ASSIGNMENT_LABEL[assignment.status])}
                    {assignment.at !== undefined ? ` · ${formatRelativeTime(assignment.at, language)}` : ''}
                  </span>
                </span>
                <span className="swarm__turn-open">{t('View this turn')}</span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="swarm__detail-role">{t('No tasks yet')}</p>}
    </section>
  )
}

function SwarmSession({ sessionKey }: { sessionKey: string | undefined }) {
  const t = useT()
  const titleId = useId()
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
    return {
      workers: swarmWorkers(items),
      assignments: swarmAssignments(items),
      spawning: swarmSpawnPending(items)
    }
  }, [activeToolsRevision])
  const workers = useMemo(
    () => rosterForPage(
      parseSwarmSnapshots(rosterSource),
      snapshot.workers,
      snapshot.assignments,
      live
    ),
    [live, rosterSource, snapshot.workers, snapshot.assignments]
  )
  const summary = useMemo(() => summarizeSwarm(workers), [workers])
  const situation = swarmSituation(summary, live, swarmMode)
  const [filter, setFilter] = useState<SwarmWorkerFilter>('all')
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [narrow, setNarrow] = useState(false)
  const trigger = useRef<HTMLElement | null>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement | null>())
  const backRef = useRef<HTMLButtonElement | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [confirmStopAll, setConfirmStopAll] = useState(false)
  const [stopPending, setStopPending] = useState(false)
  const [now, setNow] = useState(Date.now)
  const working = live && summary.working > 0
  const selectedWorker = workers.find((worker) => worker.name === selectedName) ?? null
  const selected = snapshot.assignments.find((assignment) => assignment.id === selectedId)
  const rows = filterWorkers(workers, live, filter)
  const counts = {
    all: workers.length,
    active: filterWorkers(workers, live, 'active').length,
    idle: filterWorkers(workers, live, 'idle').length,
    failed: filterWorkers(workers, live, 'failed').length
  }
  const filters: { value: SwarmWorkerFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'active', label: 'At work' },
    { value: 'idle', label: 'Idle' },
    { value: 'failed', label: 'Failed' }
  ]

  useEffect(() => {
    if (!working) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [working])

  useEffect(() => {
    const node = rootRef.current
    if (!node) return
    const measure = () => setNarrow(node.clientWidth < NARROW_PANEL)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (selectedName && !workers.some((worker) => worker.name === selectedName)) setSelectedName(null)
  }, [workers, selectedName])

  function selectWorker(name: string) {
    setSelectedName((current) => {
      const next = current === name ? null : name
      if (next && narrow) requestAnimationFrame(() => backRef.current?.focus())
      return next
    })
  }

  function closeDetail() {
    const name = selectedName
    setSelectedName(null)
    requestAnimationFrame(() => {
      if (name) rowRefs.current.get(name)?.focus()
    })
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

  const move = (event: KeyboardEvent<HTMLUListElement>) => {
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

  if (!workers.length && !snapshot.assignments.length) {
    return (
      <div className="swarm swarm--empty">
        <Network size={24} aria-hidden="true" />
        <h2>{t(snapshot.spawning ? 'Creating workers…' : 'No workers in this conversation')}</h2>
        {snapshot.spawning ? (
          <p>{t('The lead is creating the team. Workers will show up here.')}</p>
        ) : (
          <>
            <ol className="swarm__steps">
              <li data-done={swarmMode || undefined}>{t('Turn on Swarm Mode')}</li>
              <li>{t('Describe the goal in the composer')}</li>
              <li>{t('Workers appear here. Up to 8 stay on for later turns.')}</li>
            </ol>
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
          </>
        )}
      </div>
    )
  }

  const situationText = situation.count === undefined
    ? t(situation.key)
    : t(situation.key).replace('{count}', String(situation.count))

  return (
    <>
      <div
        ref={rootRef}
        className="swarm"
        data-selected={selectedWorker ? true : undefined}
        data-narrow={narrow || undefined}
        hidden={Boolean(selected)}
      >
        <header className="swarm__head">
          <div className="swarm__summary">
            <p className="swarm__situation" id={titleId}>{situationText}</p>
            {summary.tokens > 0 ? (
              <span className="swarm__situation-tokens">{t('{value} tokens').replace('{value}', formatTokens(summary.tokens))}</span>
            ) : null}
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
          {live && !swarmMode && summary.working === 0 ? (
            <p className="swarm__notice">{t('Swarm Mode is off. Workers can finish their current tasks.')}</p>
          ) : null}
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
        </header>
        <div className="swarm__stage">
          <div className="swarm__roster">
            {rows.length ? (
              <ul className="swarm__workers" aria-labelledby={titleId} onKeyDown={move}>
                {rows.map((worker) => (
                  <WorkerRow
                    key={worker.name}
                    worker={worker}
                    live={live}
                    now={now}
                    selected={selectedName === worker.name}
                    stopPending={stopPending}
                    toggleRef={(element) => rowRefs.current.set(worker.name, element)}
                    onSelect={() => selectWorker(worker.name)}
                    onStop={() => void stop(worker.name)}
                  />
                ))}
              </ul>
            ) : <p className="swarm__notice">{t('Nothing in this filter')}</p>}
          </div>
          {selectedWorker ? (
            <WorkerDetail
              worker={selectedWorker}
              assignments={snapshot.assignments}
              live={live}
              now={now}
              language={language}
              stopPending={stopPending}
              backRef={(element) => { backRef.current = element }}
              onBack={closeDetail}
              onStop={() => void stop(selectedWorker.name)}
              onOpen={(assignment, element) => {
                trigger.current = element
                setSelectedId(assignment.id)
              }}
            />
          ) : null}
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

/** The current conversation's worker roster and the selected worker's turn. */
export const SwarmPanel = memo(function SwarmPanel() {
  const sessionKey = useAppStore((state) => state.activeSessionFile ?? state.draftId)
  return <SwarmSession key={sessionKey} sessionKey={sessionKey} />
})
