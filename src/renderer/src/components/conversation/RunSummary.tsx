import { memo, useEffect, useState } from 'react'
import { ChevronDown, CircleAlert, X } from 'lucide-react'
import type { RunState } from '../../store/useAppStore'
import { useAppStore } from '../../store/useAppStore'
import { useT } from '../../lib/i18n'
import { monotonicNow } from '../../lib/session-timing'
import type { AppLanguage } from '@shared/types'

const SLOW_MODEL_RESPONSE_MS = 10_000

/** A duration in the run summary's compact form, e.g. "42s", "3m 12s" or "3分钟 12秒". */
export function formatElapsed(ms: number, language: AppLanguage = 'en'): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (language === 'zh-CN') {
    if (seconds < 60) return `${seconds}秒`
    return `${Math.floor(seconds / 60)}分钟 ${seconds % 60}秒`
  }
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** Whether a run currently has a live summary line at the top of its turn. */
export function isLiveRunSummary(run: RunState): boolean {
  return Boolean(
    !run.settled &&
      (run.startedMonotonicAt !== undefined ||
        run.startedAt !== undefined ||
        run.phase !== 'idle' ||
        Boolean(run.compaction))
  )
}

export interface RunSummaryProps {
  run: RunState
  /** A live turn's summary has no queue, retry or connection notice taking precedence. */
  showWaitStatus?: boolean
  /** Whether the turn has a process that the reader can fold away. */
  foldable?: boolean
  open?: boolean
  onToggle?: () => void
  /** A Goal Mode round started without a user message. */
  continuation?: 'automatic' | 'resumed'
}

/**
 * The elapsed-time line at the top of an assistant reply, live until the run settles.
 *
 * It sits at the top of the assistant block so the reader sees the elapsed
 * time before the answer. The chevron folds tool/thinking process without
 * hiding the answer itself.
 */
export const RunSummary = memo(function RunSummary({
  run,
  showWaitStatus = false,
  foldable = false,
  open = true,
  onToggle,
  continuation
}: RunSummaryProps) {
  const t = useT()
  const language = useAppStore((state) => state.settings.language ?? 'en')
  const startedAt = run.startedMonotonicAt ?? run.startedAt
  const isRunning = isLiveRunSummary(run)
  const readNow = run.startedMonotonicAt !== undefined ? monotonicNow : Date.now
  const describeWait = isRunning && showWaitStatus && !run.compaction
  // A new model turn has its own clock. Reasoning or tool arguments can
  // arrive before visible text, so the first generation block also ends the wait.
  const modelWaitingSince = describeWait && run.phase === 'working' &&
    run.firstTokenAt === undefined && run.messageGenerationStartedAt === undefined
    ? run.modelTurnStartedAt
    : undefined
  const tickClock = isRunning && (startedAt !== undefined || modelWaitingSince !== undefined)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!tickClock) return
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1000)
    return () => window.clearInterval(timer)
  }, [tickClock])
  if (!run.settled && !isRunning) return null
  const aborted = run.outcome === 'aborted'
  const failed = run.outcome === 'failed'
  const canFold = run.settled && foldable && !aborted
  const elapsedMs = isRunning
    ? startedAt !== undefined
      ? Math.max(0, readNow() - startedAt)
      : undefined
    : run.durationMs
  const duration = elapsedMs !== undefined && !aborted
    ? formatElapsed(elapsedMs, language)
    : undefined
  const roundTurns = run.roundTurns ?? run.turns
  const preparing = describeWait && (
    run.phase === 'queued' || (run.phase === 'working' && run.runId !== undefined && roundTurns === 0)
  )
  const modelWaitMs = modelWaitingSince === undefined
    ? 0
    : monotonicNow() - modelWaitingSince
  const liveLabel = modelWaitingSince !== undefined
    ? modelWaitMs >= SLOW_MODEL_RESPONSE_MS
      ? 'Still waiting for model response…'
      : 'Waiting for model response…'
    : preparing ? 'Preparing request…' : 'Working'
  const label = aborted
    ? t('Stopped by you')
    : failed
      ? t('Failed')
      : isRunning
        ? t(liveLabel)
        : continuation
          ? t(continuation === 'resumed' ? 'Resumed goal' : 'Continued automatically')
          : duration !== undefined
            ? t('Worked for')
            : t('Finished')

  return (
    <button
      type="button"
      className="run-outcome"
      data-outcome={run.outcome}
      data-has-duration={duration !== undefined || undefined}
      data-running={isRunning || undefined}
      data-foldable={canFold || undefined}
      data-open={canFold ? open || undefined : undefined}
      disabled={!canFold}
      aria-expanded={canFold ? open : undefined}
      onClick={canFold ? onToggle : undefined}
    >
      {aborted ? <X size={12} aria-hidden="true" /> : null}
      {failed ? <CircleAlert size={12} aria-hidden="true" /> : null}
      <span className="run-outcome__label">
        <span aria-live={isRunning ? 'polite' : undefined}>{label}</span>
        {duration !== undefined ? <span className="run-outcome__meta">{duration}</span> : null}
      </span>
      {canFold ? <ChevronDown size={14} className="run-outcome__chevron" aria-hidden="true" /> : null}
    </button>
  )
})

/** The name the stream used before the component was extracted. */
export const RunOutcome = RunSummary
