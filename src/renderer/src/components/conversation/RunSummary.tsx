import { memo } from 'react'
import { CircleAlert, X } from 'lucide-react'
import type { RunState } from '../../store/useAppStore'
import { useT } from '../../lib/i18n'

/** A duration in the run summary's compact form, e.g. "42s" or "3m 12s". */
export function formatElapsed(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/**
 * The one-line record of how a run ended.
 *
 * It is placed at the end of the reply it belongs to, so the result and the
 * effort that produced it are read together.
 */
export const RunSummary = memo(function RunSummary({ run }: { run: RunState }) {
  const t = useT()
  if (!run.settled) return null
  const aborted = run.outcome === 'aborted'
  const failed = run.outcome === 'failed'
  return (
    <div className="run-outcome" data-outcome={run.outcome}>
      {aborted ? <X size={12} aria-hidden="true" /> : null}
      {failed ? <CircleAlert size={12} aria-hidden="true" /> : null}
      <span>
        {t(
          failed
            ? 'Failed'
            : aborted
              ? 'Stopped by you'
              : run.durationMs !== undefined
                ? 'Worked for'
                : 'Finished'
        )}
      </span>
      {run.durationMs !== undefined ? (
        <span className="run-outcome__meta">{formatElapsed(run.durationMs)}</span>
      ) : null}
    </div>
  )
})

/** The name the stream used before the component was extracted. */
export const RunOutcome = RunSummary
