import { memo, useEffect, useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  Check,
  CircleDot,
  Clock,
  Hand,
  Loader,
  X
} from 'lucide-react'
import type { RunState } from '../store/useAppStore'
import { useT } from '../lib/i18n'

/**
 * The line that says what the agent is doing.
 *
 * The words come from the run state, which is derived from the events that
 * actually arrived — never from a guess about what the model is thinking.
 * "Working" covers waiting for the model; `tool_running` means at least one
 * tool call is executing right now.
 */
export const RunStatusRow = memo(function RunStatusRow({
  run,
  transport,
  retry,
  activity
}: {
  run: RunState
  transport: 'connected' | 'disconnected'
  retry?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage?: string }
  /** The tool call in flight, when there is one. */
  activity?: string
}) {
  const t = useT()
  const label = statusLabel(run, transport, Boolean(retry), Boolean(activity))
  const running = run.phase !== 'idle' || transport === 'disconnected'

  return (
    <div className="run-status" data-phase={run.phase} data-transport={transport}>
      <span className="run-status__icon" aria-hidden="true">
        <StatusIcon phase={run.phase} transport={transport} retrying={Boolean(retry)} />
      </span>
      <span className="run-status__label">{t(label)}</span>
      {activity ? <span className="run-status__activity">{activity}</span> : null}
      {running && run.startedAt !== undefined ? <Elapsed since={run.startedAt} /> : null}
    </div>
  )
})

function StatusIcon({
  phase,
  transport,
  retrying
}: {
  phase: RunState['phase']
  transport: 'connected' | 'disconnected'
  retrying: boolean
}) {
  if (transport === 'disconnected') return <AlertTriangle size={13} />
  if (retrying || phase === 'retrying') return <Loader size={13} className="spin" />
  if (phase === 'waiting_approval') return <Hand size={13} />
  if (phase === 'queued') return <Clock size={13} />
  if (phase === 'tool_running') return <CircleDot size={13} className="pulse" />
  if (phase === 'aborting') return <X size={13} />
  if (phase === 'idle') return <Check size={13} />
  return <Loader size={13} className="spin" />
}

/** The words for a state, in one place so they cannot drift between views. */
export function statusLabel(
  run: RunState,
  transport: 'connected' | 'disconnected',
  retrying: boolean,
  hasActivity: boolean
): string {
  if (transport === 'disconnected') return 'Lost connection to Pi'
  if (retrying || run.phase === 'retrying') return 'Retrying'
  switch (run.phase) {
    case 'waiting_approval':
      // Not "thinking": the agent is blocked on a dialog and cannot move
      // until it is answered, so the line says exactly that.
      return 'Waiting for your answer'
    case 'queued':
      return 'Queued'
    case 'tool_running':
      return hasActivity ? 'Running a tool' : 'Running tools'
    case 'generating':
      return 'Writing a reply…'
    case 'aborting':
      return 'Stopping…'
    case 'working':
      return 'Working…'
    case 'idle':
      return run.outcome === 'aborted' ? 'Stopped' : 'Done'
    default:
      return 'Working…'
  }
}

/** A counter that ticks once a second while a run is open. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  if (seconds < 60) return <span className="run-status__elapsed">{seconds}s</span>
  return (
    <span className="run-status__elapsed">
      {Math.floor(seconds / 60)}m {seconds % 60}s
    </span>
  )
}

/**
 * The "there is new content below" affordance.
 *
 * The thread hides it while the reader is at the bottom and shows it as
 * soon as they scroll away from a growing conversation.
 */
export const NewContentHint = memo(function NewContentHint({
  label,
  onClick
}: {
  label: string
  onClick: () => void
}) {
  return (
    <button className="new-content" onClick={onClick} type="button">
      <ArrowDown size={13} />
      <span>{label}</span>
    </button>
  )
})

/** The one-line record of how a run ended. */
export const RunOutcome = memo(function RunOutcome({ run }: { run: RunState }) {
  const t = useT()
  if (!run.settled) return null
  const aborted = run.outcome === 'aborted'
  return (
    <div className="run-outcome" data-outcome={run.outcome}>
      <span className="run-outcome__icon" aria-hidden="true">
        {aborted ? <X size={12} /> : <Check size={12} />}
      </span>
      <span>{t(aborted ? 'Stopped by you' : 'Finished')}</span>
      {run.turns > 1 ? (
        <span className="run-outcome__meta">
          {run.turns} {run.turns === 1 ? 'turn' : 'turns'}
        </span>
      ) : null}
      {run.durationMs !== undefined ? (
        <span className="run-outcome__meta">{formatElapsed(run.durationMs)}</span>
      ) : null}
    </div>
  )
})

function formatElapsed(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
