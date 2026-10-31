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
import type { RetryState, RunState } from '../store/useAppStore'
import type { ToolActivity } from '../lib/activity'
import { useT } from '../lib/i18n'
import { isRateLimitError } from '../lib/provider-error'

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
  onStopRetry,
  activity
}: {
  run: RunState
  transport: 'connected' | 'disconnected'
  retry?: RetryState
  onStopRetry?: () => void
  /** The tool call in flight, when there is one. */
  activity?: ToolActivity
}) {
  const t = useT()
  const label = statusLabel(run, transport, Boolean(retry), Boolean(activity))
  const waiting = retry && label === 'Retrying'
  const running = run.phase !== 'idle' || transport === 'disconnected'

  return (
    <div className="run-status" data-phase={run.phase} data-transport={transport} role="status">
      <span className="run-status__icon" aria-hidden="true">
        <StatusIcon phase={run.phase} transport={transport} retrying={Boolean(retry)} />
      </span>
      <span className="run-status__label" title={waiting ? retry.errorMessage : undefined}>
        {t(waiting && isRateLimitError(retry.errorMessage) ? 'Rate limit reached' : label)}
      </span>
      {waiting ? (
        <>
          <RetryProgress retry={retry} />
          {onStopRetry ? (
            <button className="run-status__stop" type="button" onClick={onStopRetry}>
              {t('Stop retrying')}
            </button>
          ) : null}
        </>
      ) : activity ? (
        <span className="run-status__activity">
          <span className="run-status__activity-label">{t(activity.label)}</span>
          {activity.detail ? (
            <span className="run-status__activity-detail">{activity.detail}</span>
          ) : null}
        </span>
      ) : null}
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
  if (phase === 'aborting') return <X size={13} />
  if (phase === 'waiting_approval') return <Hand size={13} />
  if (retrying || phase === 'retrying') return <Loader size={13} className="spin" />
  if (phase === 'queued') return <Clock size={13} />
  if (phase === 'tool_running') return <CircleDot size={13} className="pulse" />
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
  if (run.phase === 'aborting') return 'Stopping…'
  if (run.phase === 'waiting_approval') return 'Waiting for your answer'
  if (retrying || run.phase === 'retrying') return 'Retrying'
  switch (run.phase) {
    case 'queued':
      return 'Queued'
    case 'tool_running':
      return hasActivity ? 'Running a tool' : 'Running tools'
    case 'generating':
      return 'Writing a reply…'
    case 'working':
      return 'Working…'
    case 'idle':
      return run.outcome === 'aborted'
        ? 'Stopped'
        : run.outcome === 'failed'
          ? 'Failed'
          : 'Done'
    default:
      return 'Working…'
  }
}

function RetryProgress({ retry }: { retry: RetryState }) {
  const t = useT()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [retry.retryAt])
  const seconds = Math.max(0, Math.ceil((retry.retryAt - now) / 1000))
  return (
    <span className="run-status__retry" title={retry.errorMessage} aria-live="off">
      <span>
        {seconds > 0 ? `${t('Retry in')} ${seconds}${t('seconds-short')}` : t('Waiting for retry…')}
      </span>
      <span className="run-status__attempt">
        {t('attempt')} {retry.attempt}{retry.maxAttempts > 0 ? ` / ${retry.maxAttempts}` : ''}
      </span>
    </span>
  )
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

/** The one-line record of how a run ended lives in the conversation leaf set. */
export { RunSummary as RunOutcome } from './conversation/RunSummary'
