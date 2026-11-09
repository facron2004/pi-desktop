import { memo, useEffect, useState } from 'react'
import { ChevronDown, CircleAlert, X } from 'lucide-react'
import type { RunState } from '../../store/useAppStore'
import { useAppStore } from '../../store/useAppStore'
import { useT } from '../../lib/i18n'
import { monotonicNow } from '../../lib/session-timing'
import type { AppLanguage } from '@shared/types'

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

export interface RunSummaryProps {
  run: RunState
  /** Whether the turn has a process that the reader can fold away. */
  foldable?: boolean
  open?: boolean
  onToggle?: () => void
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
  foldable = false,
  open = true,
  onToggle
}: RunSummaryProps) {
  const t = useT()
  const language = useAppStore((state) => state.settings.language ?? 'en')
  const isRunning = !run.settled && (run.startedMonotonicAt !== undefined || run.startedAt !== undefined)
  const readNow = run.startedMonotonicAt !== undefined ? monotonicNow : Date.now
  const [now, setNow] = useState(() => readNow())
  useEffect(() => {
    setNow(readNow())
    if (!isRunning) return
    const timer = window.setInterval(() => setNow(readNow()), 1000)
    return () => window.clearInterval(timer)
  }, [isRunning, readNow, run.startedAt, run.startedMonotonicAt])
  if (!run.settled && !isRunning) return null
  const aborted = run.outcome === 'aborted'
  const failed = run.outcome === 'failed'
  const canFold = run.settled && foldable && !aborted && !failed
  const elapsedMs = isRunning
    ? Math.max(0, now - (run.startedMonotonicAt ?? run.startedAt ?? now))
    : run.durationMs
  const duration =
    elapsedMs !== undefined && !aborted && !failed
      ? formatElapsed(elapsedMs, language)
      : undefined
  const label = failed
    ? t('Failed')
    : aborted
      ? t('Stopped by you')
      : isRunning
        ? t('Working')
        : duration !== undefined
          ? t('Worked for')
          : t('Finished')

  return (
    <button
      type="button"
      className="run-outcome"
      data-outcome={run.outcome}
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
        {label}
        {duration !== undefined ? <span className="run-outcome__meta">{duration}</span> : null}
      </span>
      {canFold ? <ChevronDown size={14} className="run-outcome__chevron" aria-hidden="true" /> : null}
    </button>
  )
})

/** The name the stream used before the component was extracted. */
export const RunOutcome = RunSummary
