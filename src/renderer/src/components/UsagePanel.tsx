import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'
import { formatCost, formatTokens } from '../lib/format'
import type { SessionMetrics } from '../lib/session-metrics'

/**
 * The detail popover behind the usage line: the token split, the cache hit
 * rate with its formula, and the generation readings with where they come
 * from. Everything is derived by `lib/session-metrics.ts`; this panel only
 * formats what that function handed over.
 */
export function UsagePanel({ metrics }: { metrics: SessionMetrics }) {
  const stats = useAppStore((state) => state.stats)
  const t = useT()

  return (
    <div className="usage-panel">
      <div className="usage-panel__section">
        <div className="popover__label">{t('Usage details')}</div>
        <div className="usage-panel__rows">
          <div className="usage-panel__row usage-panel__row--strong">
            <span>{t('Total tokens')}</span>
            <span>{formatTokens(metrics.totalTokens)}</span>
          </div>
          <div className="usage-panel__row">
            <span>{t('Input')}</span>
            <span>{formatTokens(stats?.tokens.input)}</span>
          </div>
          <div className="usage-panel__row">
            <span>{t('Output')}</span>
            <span>{formatTokens(stats?.tokens.output)}</span>
          </div>
          <div className="usage-panel__row">
            <span>{t('Cache read')}</span>
            <span>{formatTokens(stats?.tokens.cacheRead)}</span>
          </div>
          <div className="usage-panel__row">
            <span>{t('Cache write')}</span>
            <span>{formatTokens(stats?.tokens.cacheWrite)}</span>
          </div>
          <div className="usage-panel__row">
            <span>{t('Cost')}</span>
            <span>{formatCost(stats?.cost)}</span>
          </div>
        </div>
      </div>

      <div className="usage-panel__section">
        <div className="popover__label">{t('Cache hit rate')}</div>
        <div className="usage-panel__headline">
          <strong>{metrics.cacheHitPercent !== null ? `${metrics.cacheHitPercent}%` : '—'}</strong>
          <span className="usage-panel__hint">{t('Cache hits divided by all prompt tokens, cached and new.')}</span>
        </div>
      </div>

      <div className="usage-panel__section">
        <div className="popover__label">{t('Generation')}</div>
        <div className="usage-panel__rows">
          <div className="usage-panel__row">
            <span title={t('Output tokens per second')}>{t('TPS')}</span>
            <span>
              {metrics.tps !== null ? (
                <>
                  <strong>{metrics.tps}</strong> {t('tok/s')}
                </>
              ) : (
                <span className="usage-panel__none" title={t('Timing is recorded while a run is live in this session')}>
                  —
                </span>
              )}
            </span>
          </div>
          <div className="usage-panel__row">
            <span title={t('Time to first token')}>{t('TTFT')}</span>
            <span>
              {metrics.ttftMs !== null ? (
                <>
                  <strong>{metrics.ttftMs}</strong> ms
                </>
              ) : (
                <span className="usage-panel__none" title={t('Timing is recorded while a run is live in this session')}>
                  —
                </span>
              )}
            </span>
          </div>
        </div>
        <p className="usage-panel__hint">
          {metrics.tps !== null
            ? t('Measured from the first to the last token of the newest answer.')
            : t('Timing is recorded while a run is live in this session')}
        </p>
      </div>

      <div className="usage-panel__section">
        <div className="popover__label">{t('Messages')}</div>
        <div className="usage-panel__rows">
          <div className="usage-panel__row">
            <span>{t('Prompts')}</span>
            <span>{stats?.userMessages ?? '—'}</span>
          </div>
          <div className="usage-panel__row">
            <span>{t('Replies')}</span>
            <span>{stats?.assistantMessages ?? '—'}</span>
          </div>
          <div className="usage-panel__row">
            <span>{t('Tool calls')}</span>
            <span>{stats?.toolCalls ?? '—'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
