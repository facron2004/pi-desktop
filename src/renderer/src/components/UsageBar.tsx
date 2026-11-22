import { Database, Gauge } from 'lucide-react'
import { memo, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { sessionMetrics } from '../lib/session-metrics'
import { formatTokens } from '../lib/format'
import { useT } from '../lib/i18n'
import { monotonicNow, readSessionTiming } from '../lib/session-timing'
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
 * Every value is derived by `lib/session-metrics.ts`; nothing here is stored.
 */
export const UsageBar = memo(function UsageBar() {
  // Text deltas do not change usage. Recompute on new items, completed
  // answers or run/stat changes instead of walking the transcript each frame.
  const itemCount = useAppStore((state) => state.items.length)
  const historyTruncated = useAppStore((state) => state.historyTruncated === true)
  const lastCompletedAssistant = useAppStore((state) =>
    state.items.findLast((item) => item.kind === 'assistant' && !item.streaming)
  )
  const hasAssistant = useAppStore((state) =>
    state.items.findLast((item) => item.kind === 'assistant') !== undefined
  )
  const stats = useAppStore((state) => state.stats)
  const run = useAppStore((state) => state.run)
  const sessionKey = useAppStore((state) => state.activeSessionFile ?? state.draftId)
  const t = useT()
  const [, setTimingTick] = useState(0)

  // Keep the live model-time reading moving only while this answer is really
  // open. A stale start left on a settled/idle run must not turn into hours of
  // "model time" on a reopened conversation.
  const liveModelClock = run.modelTurnStartedAt !== undefined && !run.settled && run.phase !== 'idle'
  useEffect(() => {
    if (!liveModelClock) return
    const timer = window.setInterval(() => setTimingTick((tick) => tick + 1), 1000)
    return () => window.clearInterval(timer)
  }, [liveModelClock, run.modelTurnStartedAt])

  const metrics = useMemo(
    () => sessionMetrics(
      useAppStore.getState().items,
      stats,
      { ...run, modelTurnStartedAt: undefined },
      readSessionTiming(sessionKey),
      { historyTruncated }
    ),
    [itemCount, lastCompletedAssistant, stats, run.phase, run.settled, run.turns, run.durationMs, sessionKey, historyTruncated]
  )
  const liveModelTimeMs = !liveModelClock
    ? 0
    : Math.max(0, monotonicNow() - run.modelTurnStartedAt!)
  const displayMetrics = liveModelTimeMs > 0
    ? { ...metrics, modelTimeMs: (metrics.modelTimeMs ?? 0) + liveModelTimeMs }
    : metrics
  const hasRun =
    hasAssistant || (stats?.tokens.total ?? 0) > 0
  if (!hasRun) return null
  const countLabel =
    t('turns') === '轮'
      ? `${displayMetrics.turnCount}轮 ${displayMetrics.stepCount}步`
      : `${displayMetrics.turnCount} ${displayMetrics.turnCount === 1 ? t('turn') : t('turns')} · ${displayMetrics.stepCount} ${t('steps')}`

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
              {displayMetrics.tps !== null ? (
                <>
                  <strong>{displayMetrics.tps.toLocaleString()}</strong> {t('tok/s')}
                </>
              ) : (
                <strong>—</strong>
              )}
            </span>
          </button>
        )}
      >
        {() => <GenerationPanel metrics={displayMetrics} />}
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
              <strong>{formatTokens(displayMetrics.totalTokens)}</strong>
            </span>
            <span className="usage-bar__item" title={t('Cache hit rate')}>
              <span className="usage-bar__label">{t('Cache hit rate')}</span>
              <strong>
                {displayMetrics.cacheHitPercent !== null ? `${displayMetrics.cacheHitPercent}%` : '—'}
              </strong>
            </span>
          </button>
        )}
      >
        {() => <UsagePanel metrics={displayMetrics} />}
      </Popover>

      {/* The ring owns the window reading, including its percentage label. */}
      <ContextRing />
    </div>
  )
})
