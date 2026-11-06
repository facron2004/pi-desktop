import { useMemo } from 'react'
import { useAppStore } from '../store/useAppStore'
import { sessionMetrics } from '../lib/session-metrics'
import { formatTokens } from '../lib/format'
import { useT } from '../lib/i18n'
import { ContextRing } from './ContextRing'
import { Popover } from './Popover'
import { UsagePanel } from './UsagePanel'
import '../styles/usage-bar.css'

/**
 * The compact reading centred under the composer after a run: the context
 * ring, then the conversation's tokens, cache hit rate and generation speed.
 *
 * The ring opens the context panel (Pi's own `get_session_stats` readings);
 * everything else is one button that opens the usage detail popover. Every
 * value is derived by `lib/session-metrics.ts` — nothing here is stored.
 */
export function UsageBar() {
  const items = useAppStore((state) => state.items)
  const stats = useAppStore((state) => state.stats)
  const run = useAppStore((state) => state.run)
  const t = useT()

  const metrics = useMemo(() => sessionMetrics(items, stats, run), [items, stats, run])
  const hasRun =
    items.some((item) => item.kind === 'assistant') || (stats?.tokens.total ?? 0) > 0
  if (!hasRun) return null

  return (
    <div className="usage-bar" aria-label={t('Usage')}>
      <ContextRing />
      <Popover
        placement="top"
        align="left"
        width={300}
        className="usage-popover"
        renderTrigger={({ open, toggle }) => (
          <button
            type="button"
            className="usage-bar__summary"
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
              <strong>{metrics.cacheHitPercent !== null ? `${metrics.cacheHitPercent}%` : '—'}</strong>
            </span>
            <span className="usage-bar__item" title={t('Output tokens per second')}>
              <span className="usage-bar__label">{t('TPS')}</span>
              <strong>{metrics.tps !== null ? `${metrics.tps} tok/s` : '—'}</strong>
            </span>
            <span className="usage-bar__item" title={t('Time to first token')}>
              <span className="usage-bar__label">{t('TTFT')}</span>
              <strong>{metrics.ttftMs !== null ? `${metrics.ttftMs}ms` : '—'}</strong>
            </span>
          </button>
        )}
      >
        {() => <UsagePanel metrics={metrics} />}
      </Popover>
    </div>
  )
}
