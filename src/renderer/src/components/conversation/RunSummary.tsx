import { memo } from 'react'
import { ChevronDown, CircleAlert, X } from 'lucide-react'
import type { RunState } from '../../store/useAppStore'
import { useAppStore } from '../../store/useAppStore'
import { useT } from '../../lib/i18n'
import type { AppLanguage } from '@shared/types'

/** A duration in the run summary's compact form, e.g. "42s", "3m 12s" or "3分12秒". */
export function formatElapsed(ms: number, language: AppLanguage = 'en'): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (language === 'zh-CN') {
    if (seconds < 60) return `${seconds}秒`
    return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
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
 * The one-line record of how a turn ended.
 *
 * It sits at the top of the assistant block, like the reference harness: the
 * reader sees "completed in …" before the answer, and the chevron folds the
 * tool/thinking process without hiding the answer itself.
 */
export const RunSummary = memo(function RunSummary({
  run,
  foldable = false,
  open = true,
  onToggle
}: RunSummaryProps) {
  const t = useT()
  const language = useAppStore((state) => state.settings.language ?? 'en')
  if (!run.settled) return null
  const aborted = run.outcome === 'aborted'
  const failed = run.outcome === 'failed'
  const canFold = foldable && !aborted && !failed
  const duration =
    run.durationMs !== undefined && !aborted && !failed
      ? formatElapsed(run.durationMs, language)
      : undefined
  const label = failed
    ? t('Failed')
    : aborted
      ? t('Stopped by you')
      : duration !== undefined
        ? t('Completed in')
        : t('Finished')

  return (
    <button
      type="button"
      className="run-outcome"
      data-outcome={run.outcome}
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
