import { Database, Gauge } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'
import { formatDuration, formatExactTokens } from '../lib/format'
import type { SessionMetrics } from '../lib/session-metrics'

/**
 * The popover behind the tokens and the cache hit rate: a compact total and
 * token breakdown.
 *
 * Generation is deliberately not here. Speed and first-token delay describe one
 * answer rather than the conversation's running totals, so they live in the
 * card behind the session statistics reading (`GenerationPanel`) and must not
 * be printed twice.
 * Everything is derived by `lib/session-metrics.ts`; this panel only formats
 * what that function handed over.
 */
export function UsagePanel({ metrics }: { metrics: SessionMetrics }) {
  const stats = useAppStore((state) => state.stats)
  const t = useT()
  const hasLiveStats = Boolean(stats?.tokens.total)

  return (
    <div className="usage-panel">
      <div className="usage-panel__rows" role="group" aria-label={t('Token usage')}>
        <div className="usage-panel__row usage-panel__row--strong">
          <span className="usage-panel__title">
            <Database size={14} aria-hidden="true" />
            {t('Token usage')}
          </span>
          <span title={t(hasLiveStats ? 'From the live session' : 'Estimated from the transcript')}>
            <strong>{metrics.totalTokens.toLocaleString()}</strong> tok
          </span>
        </div>
        <div className="usage-panel__row">
          <span>{t('Cache hit rate')}</span>
          <span>{metrics.cacheHitPercent !== null ? `${metrics.cacheHitPercent}%` : '—'}</span>
        </div>
        <div className="usage-panel__row">
          <span>{t('Uncached input')}</span>
          <span>{formatExactTokens(metrics.inputTokens)}</span>
        </div>
        <div className="usage-panel__row">
          <span>{t('Cache read')}</span>
          <span>{formatExactTokens(metrics.cacheReadTokens)}</span>
        </div>
        <div className="usage-panel__row">
          <span>{t('Cache write')}</span>
          <span>{formatExactTokens(metrics.cacheWriteTokens)}</span>
        </div>
        <div className="usage-panel__row">
          <span>{t('Output')}</span>
          <span>{formatExactTokens(metrics.outputTokens)}</span>
        </div>
        {/* A child is its own Pi process, so this reading is not part of the
            token totals above; mixing them would distort the cache hit rate. */}
        {metrics.subagentTaskCount > 0 && (
          <div
            className="usage-panel__row"
            title={t('Tokens spent by subagents, separate from this conversation')}
          >
            <span>{t('Subagents')}</span>
            <span>
              {formatExactTokens(metrics.subagentTokens)}
              {metrics.subagentCost !== null ? ` · $${metrics.subagentCost.toFixed(4)}` : ''}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The session-statistics card behind the turn/step and speed reading.
 *
 * Counts, tool duration and generation timing come from `lib/session-metrics.ts`.
 * Model time, TTFT history and tool durations omitted by Pi are measured by
 * the desktop and retained locally for this session.
 */
export function GenerationPanel({ metrics }: { metrics: SessionMetrics }) {
  const t = useT()
  const countLabel =
    t('turns') === '轮'
      ? `${metrics.turnCount}轮 ${metrics.stepCount}步`
      : `${metrics.turnCount} ${metrics.turnCount === 1 ? t('turn') : t('turns')} · ${metrics.stepCount} ${t('steps')}`

  return (
    <div className="usage-panel">
      <div
        className="usage-panel__rows"
        role="group"
        aria-label={t('Session statistics')}
      >
        <div className="usage-panel__row usage-panel__row--strong">
          <span className="usage-panel__title">
            <Gauge size={14} aria-hidden="true" />
            {t('Session statistics')}
          </span>
          <span>{countLabel}</span>
        </div>
        <div className="usage-panel__row">
          <span>{t('Model time')}</span>
          <span title={t('Measured by this app; earlier history may be unavailable')}>
            {metrics.modelTimeMs !== null ? formatDuration(metrics.modelTimeMs) : t('Not measured yet')}
          </span>
        </div>
        <div className="usage-panel__row">
          <span>{t('Tool execution time')}</span>
          <span title={`${metrics.timedToolCalls}/${metrics.stepCount} ${t('tool calls timed')}`}>
            {metrics.toolTimeMs !== null ? formatDuration(metrics.toolTimeMs) : t('Not measured yet')}
          </span>
        </div>
        <div className="usage-panel__row">
          <span>{t('Average TTFT')}</span>
          <span title={t('Average of recorded runs; earlier history may be unavailable')}>
            {metrics.averageTtftMs !== null ? formatDuration(metrics.averageTtftMs) : t('Not measured yet')}
          </span>
        </div>
        <div className="usage-panel__row">
          <span>{t('Output speed (TPS)')}</span>
          <span>
            {metrics.tps !== null ? `${metrics.tps.toLocaleString()} ${t('tok/s')}` : '—'}
          </span>
        </div>
      </div>
    </div>
  )
}
