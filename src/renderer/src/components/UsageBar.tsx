import { useMemo } from 'react'
import { useAppStore } from '../store/useAppStore'
import { sessionMetrics } from '../lib/session-metrics'
import { formatTokens } from '../lib/format'
import { useT } from '../lib/i18n'
import { readSessionTiming } from '../lib/session-timing'
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
export function UsageBar() {
  const items = useAppStore((state) => state.items)
  const stats = useAppStore((state) => state.stats)
  const run = useAppStore((state) => state.run)
  const sessionKey = useAppStore((state) => state.activeSessionFile ?? state.draftId)
  const t = useT()

  const metrics = useMemo(
    () => sessionMetrics(items, stats, run, readSessionTiming(sessionKey)),
    [items, stats, run, sessionKey]
  )
  const hasRun =
    items.some((item) => item.kind === 'assistant') || (stats?.tokens.total ?? 0) > 0
  if (!hasRun) return null
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
            <span title={t('Session statistics')}>{countLabel}</span>
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
      <ContextRing />
    </div>
  )
}
