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
import { monotonicNow } from '../lib/session-timing'

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
  activity,
  showElapsed = true,
  hideRoutineStatus = false
}: {
  run: RunState
  transport: 'connected' | 'disconnected'
  retry?: RetryState
  onStopRetry?: () => void
  /** The tool call in flight, when there is one. */
  activity?: ToolActivity
  /** Keep the timer here only when no live reply summary shows it above. */
  showElapsed?: boolean
  /** The turn already carries its live summary and tool rows. */
  hideRoutineStatus?: boolean
}) {
  const t = useT()
  const compacting =
    transport === 'connected' &&
    !retry &&
    run.phase !== 'aborting' &&
    run.phase !== 'waiting_approval' &&
    run.phase !== 'retrying'
      ? run.compaction
      : undefined
  const label = compacting
    ? `Compacting context (${compacting.reason})…`
    : statusLabel(run, transport, Boolean(retry), Boolean(activity))
  const waiting = retry && label === 'Retrying'
  const running = Boolean(compacting) || run.phase !== 'idle' || transport === 'disconnected'
  const elapsedSince = compacting?.startedMonotonicAt ?? run.startedMonotonicAt
  const elapsedSinceWall = compacting?.startedAt ?? run.startedAt
  const elapsedStart = elapsedSince ?? elapsedSinceWall

  // The live summary already says the run is working, and tool rows carry
  // their own state. Only an exceptional phase needs another visible notice.
  if (
    hideRoutineStatus &&
    (run.phase === 'working' || run.phase === 'generating' || run.phase === 'tool_running') &&
    transport === 'connected' &&
    !retry &&
    !compacting
  ) {
    return null
  }

  return (
    <div
      className="run-status"
      data-phase={run.phase}
      data-transport={transport}
      data-compacting={Boolean(compacting) || undefined}
      role="status"
    >
      <span className="run-status__icon" aria-hidden="true">
        <StatusIcon
          phase={run.phase}
          transport={transport}
          retrying={Boolean(retry)}
          compacting={Boolean(compacting)}
        />
      </span>
      {/* While a tool is in flight its own label is the sentence: "Running a
          tool" followed by "Running a command" said the same thing twice and
          left the command squeezed into the leftover width. */}
      {!waiting && activity && !compacting ? null : (
        <span className="run-status__label" title={waiting ? retry.errorMessage : undefined}>
          {t(waiting && isRateLimitError(retry.errorMessage) ? 'Rate limit reached' : label)}
        </span>
      )}
      {waiting ? (
        <>
          <RetryProgress retry={retry} />
          {onStopRetry ? (
            <button className="run-status__stop" type="button" onClick={onStopRetry}>
              {t('Stop retrying')}
            </button>
          ) : null}
        </>
      ) : compacting ? null : activity ? (
        <span className="run-status__activity">
          <span className="run-status__activity-label">{t(activity.label)}</span>
          {/* A shell line stays behind the tool row's caret: printing
              `cd … && grep …` here put the command under the answer as if it
              were the newest output. The label already says what is running. */}
          {activity.detail && activity.tone !== 'command' ? (
            <span className="run-status__activity-detail" title={activity.detail}>
              {activity.detail}
            </span>
          ) : null}
        </span>
      ) : null}
      {showElapsed && running && elapsedStart !== undefined ? (
        <Elapsed since={elapsedStart} monotonic={elapsedSince !== undefined} />
      ) : null}
    </div>
  )
})

function StatusIcon({
  phase,
  transport,
  retrying,
  compacting
}: {
  phase: RunState['phase']
  transport: 'connected' | 'disconnected'
  retrying: boolean
  compacting: boolean
}) {
  if (transport === 'disconnected') return <AlertTriangle size={13} />
  if (phase === 'aborting') return <X size={13} />
  if (phase === 'waiting_approval') return <Hand size={13} />
  if (compacting || retrying || phase === 'retrying') return <Loader size={13} className="spin" />
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
function Elapsed({ since, monotonic }: { since: number; monotonic: boolean }) {
  const readNow = monotonic ? monotonicNow : Date.now
  const [now, setNow] = useState(() => readNow())
  useEffect(() => {
    setNow(readNow())
    const timer = window.setInterval(() => setNow(readNow()), 1000)
    return () => window.clearInterval(timer)
  }, [readNow])
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
