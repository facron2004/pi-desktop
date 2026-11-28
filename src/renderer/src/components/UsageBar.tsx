import { Database, Gauge } from 'lucide-react'
import { memo, useMemo, useRef } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useSessionViewSlice } from '../lib/conversation-scope'
import { sessionMetrics } from '../lib/session-metrics'
import { formatTokens } from '../lib/format'
import { useT } from '../lib/i18n'
import { readSessionTiming } from '../lib/session-timing'
import { usageReadingsVisible } from '../lib/usage-line'
import { ContextRing } from './ContextRing'
import { Popover } from './Popover'
import { GenerationPanel, UsagePanel } from './UsagePanel'
import '../styles/usage-bar.css'

/**
 * The compact reading centred under the composer after a run: turn/step counts
 * and generation speed, then token usage and cache hit rate, then context.
 *
 * Session statistics and usage are separate controls because they describe
 * different scopes. Their order follows the status line in the reference UI.
 *
 * It is a report, not a live readout: while a run is open — a prompt the reader
 * interjected is still part of that run — only the context ring stays, and the
 * readings appear when the turn settles (`lib/usage-line.ts`).
 *
 * Every value is derived by `lib/session-metrics.ts`; nothing here is stored.
 */
export const UsageBar = memo(function UsageBar({
  sessionKey: explicitSessionKey
}: {
  sessionKey?: string
} = {}) {
  // Text deltas do not change usage. Recompute on new items, completed
  // answers or run/stat changes instead of walking the transcript each frame.
  const slice = useSessionViewSlice(explicitSessionKey)
  const items = slice.items
  const itemsRef = useRef(items)
  itemsRef.current = items
  const itemCount = items.length
  const historyTruncated = useAppStore((state) =>
    explicitSessionKey
      ? state.threads[explicitSessionKey]?.historyTruncated === true
      : state.historyTruncated === true
  )
  const lastCompletedAssistant = useMemo(
    () => items.findLast((item) => item.kind === 'assistant' && !item.streaming),
    [items]
  )
  const hasAssistant = useMemo(
    () => items.findLast((item) => item.kind === 'assistant') !== undefined,
    [items]
  )
  const stats = slice.stats
  const run = slice.run
  const sessionKey = explicitSessionKey ?? slice.sessionKey
  const t = useT()

  const metrics = useMemo(
    () =>
      sessionMetrics(
        itemsRef.current,
        stats,
        // A start left on a settled or idle run must not be read as live model
        // time: the line only prints finished runs, so it prints their clocks.
        { ...run, modelTurnStartedAt: undefined },
        readSessionTiming(sessionKey),
        { historyTruncated }
      ),
    [itemCount, lastCompletedAssistant, stats, run.phase, run.settled, run.turns, run.durationMs, sessionKey, historyTruncated]
  )
  const hasRun =
    hasAssistant || (stats?.tokens.total ?? 0) > 0
  if (!hasRun) return null
  // A run that is still going has no report to print: the numbers would tick
  // under a turn that is not finished. The ring is not a report — it is the
  // live reading of how full the window is — so it stays on its own line.
  if (!usageReadingsVisible(run, slice.isStreaming)) {
    return (
      <div className="usage-bar" role="group" aria-label={t('Usage')}>
        <ContextRing sessionKey={sessionKey} />
      </div>
    )
  }
  const countLabel =
    t('turns') === '轮'
      ? `${metrics.turnCount}轮 ${metrics.stepCount}步`
      : `${metrics.turnCount} ${metrics.turnCount === 1 ? t('turn') : t('turns')} · ${metrics.stepCount} ${t('steps')}`

  return (
    <div className="usage-bar" role="group" aria-label={t('Usage')}>
      <Popover
        placement="top"
        align="left"
        width={280}
        className="usage-popover"
        renderTrigger={({ open, toggle }) => (
          <button
            type="button"
            className="usage-bar__control usage-bar__generation"
            data-active={open || undefined}
            aria-expanded={open}
            aria-label={t('Session statistics')}
            title={t('Session statistics')}
            onClick={toggle}
          >
            <span className="usage-bar__item" title={t('Session statistics')}>
              <Gauge className="usage-bar__icon" size={12} aria-hidden="true" />
              {countLabel}
            </span>
            <span aria-hidden="true">·</span>
            <span title={t('Output tokens per second')}>
              {metrics.tps !== null ? (
                <>
                  <strong>{metrics.tps.toLocaleString()}</strong> {t('tok/s')}
                </>
              ) : (
                <strong>—</strong>
              )}
            </span>
          </button>
        )}
      >
        {() => <GenerationPanel metrics={metrics} />}
      </Popover>

      <Popover
        placement="top"
        align="right"
        width={340}
        className="usage-popover"
        renderTrigger={({ open, toggle }) => (
          <button
            type="button"
            className="usage-bar__control usage-bar__summary"
            data-active={open || undefined}
            aria-expanded={open}
            aria-label={t('Usage details')}
            title={t('Usage details')}
            onClick={toggle}
          >
            <span className="usage-bar__item" title={t('Tokens used in this conversation')}>
              <Database className="usage-bar__icon" size={12} aria-hidden="true" />
              <span className="usage-bar__label">{t('Tokens')}</span>
              <strong>{formatTokens(metrics.totalTokens)}</strong>
            </span>
            <span className="usage-bar__item" title={t('Cache hit rate')}>
              <span className="usage-bar__label">{t('Cache hit rate')}</span>
              <strong>
                {metrics.cacheHitPercent !== null ? `${metrics.cacheHitPercent}%` : '—'}
              </strong>
            </span>
          </button>
        )}
      >
        {() => <UsagePanel metrics={metrics} />}
      </Popover>

      {/* The ring owns the window reading, including its percentage label. */}
      <ContextRing sessionKey={sessionKey} />
    </div>
  )
})
