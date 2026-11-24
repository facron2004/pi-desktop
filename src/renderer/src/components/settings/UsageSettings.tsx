import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { CircleHelp } from 'lucide-react'
import type { AggregatedUsageStats, DailyUsageStat, ModelUsageStat } from '@shared/types'
import { formatCost, formatTokens, formatUsageTokens } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { useAppStore } from '../../store/useAppStore'
import { Switch } from '../Switch'
import { PageIntro, SettingsGroup, SettingsSelect } from './SettingsShared'

/**
 * A help mark with the app's own bubble. The usage page is read for numbers, and
 * the native title tooltip is both slower and the one chrome the user asked not
 * to see here.
 */
function UsageHint({ text }: { text: string }) {
  const t = useT()
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null)
  const show = (target: HTMLElement) => {
    const rect = target.getBoundingClientRect()
    setTip({
      x: Math.min(Math.max(rect.left + rect.width / 2, 150), window.innerWidth - 150),
      y: rect.bottom + 8
    })
  }
  return (
    <>
      <span
        className="usage-metric__hint"
        role="note"
        aria-label={t('Show how this is calculated')}
        tabIndex={0}
        onMouseEnter={(event) => show(event.currentTarget)}
        onMouseLeave={() => setTip(null)}
        onFocus={(event) => show(event.currentTarget)}
        onBlur={() => setTip(null)}
      >
        <CircleHelp size={11} aria-hidden="true" />
      </span>
      {tip
        ? createPortal(
            <div className="usage-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
              {text}
            </div>,
            document.body
          )
        : null}
    </>
  )
}

/**
 * Ten months of days at 10px squares fill the settings column: the cell is
 * capped at 10px and the grid takes whatever width those columns need. The
 * cells never stretch, so a wider window shows more days instead of bigger
 * blocks.
 */
const HEATMAP_DAYS = 300

/**
 * A round scale for the model chart. The bars are read against the side axis,
 * so its top and ticks have to land on readable token values instead of on the
 * tallest bar's exact count.
 */
function usageAxis(max: number): { max: number; ticks: number[] } {
  const target = max > 0 ? max : 1
  const rough = target / 4
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const residual = rough / magnitude
  const step = Math.max(
    1,
    (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? 2.5 : residual <= 5 ? 5 : 10) *
      magnitude
  )
  const top = Math.ceil(target / step) * step
  const ticks: number[] = []
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(value)
  return { max: top, ticks }
}

export function UsageSettings() {
  const settings = useAppStore((state) => state.settings)
  const piState = useAppStore((state) => state.piState)
  const setAutoCompaction = useAppStore((state) => state.setAutoCompaction)
  const setAutoRetry = useAppStore((state) => state.setAutoRetry)
  const t = useT()

  const [usageStats, setUsageStats] = useState<AggregatedUsageStats | null>(null)
  const [selectedPeriod, setSelectedPeriod] = useState<'today' | 'week' | 'month' | 'allTime'>('today')
  const [hoveredDay, setHoveredDay] = useState<{
    day: DailyUsageStat
    dateLabel: string
    x: number
    y: number
  } | null>(null)
  // The bar chart's own bubble, anchored above the hovered bar. The native
  // title tooltip is exactly the system chrome this page must not show.
  const [hoveredModel, setHoveredModel] = useState<{
    stat: ModelUsageStat
    share: number
    series: number
    x: number
    y: number
  } | null>(null)

  const loadStats = useCallback(async () => {
    try {
      const res = await window.pi.sessions.usageStats()
      setUsageStats(res)
    } catch (err) {
      console.error('Failed to load usage stats:', err)
    }
  }, [settings.externalChatFolder])

  useEffect(() => {
    void loadStats()
  }, [loadStats])

  const periods: Array<{ key: 'today' | 'week' | 'month' | 'allTime'; title: string }> = [
    { key: 'today', title: t('Period Day') },
    { key: 'week', title: t('Period Week') },
    { key: 'month', title: t('Period Month') },
    { key: 'allTime', title: t('Period All') }
  ]

  const activeData = usageStats ? usageStats[selectedPeriod] : null
  const activeTokens = activeData?.tokens
  const activeMsgs = activeData?.messageCount ?? 0
  const activeRequests = activeMsgs
  const activeCacheRead = activeTokens?.cacheRead ?? 0
  const cacheHitRate = (cacheRead: number | undefined, input: number | undefined): number => {
    const denominator = (cacheRead ?? 0) + (input ?? 0)
    return denominator > 0 ? Math.round(((cacheRead ?? 0) / denominator) * 1000) / 10 : 0
  }
  const activeCacheHitRate = cacheHitRate(activeTokens?.cacheRead, activeTokens?.input)
  const heatmap = useMemo(() => {
    const locale = settings.language === 'zh-CN' ? 'zh-CN' : 'en'
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (HEATMAP_DAYS - 1))
    const leadingDays = (start.getDay() + 6) % 7
    const weekCount = Math.ceil((leadingDays + HEATMAP_DAYS) / 7)
    const gridStart = new Date(start)
    gridStart.setDate(gridStart.getDate() - leadingDays)
    const usageByDate = new Map(
      (usageStats?.heatmapDays ?? usageStats?.recentDays ?? []).map((day) => [day.date, day])
    )
    const dateKey = (date: Date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    const cells: Array<{
      date: Date
      day: NonNullable<typeof usageStats>['recentDays'][number]
      week: number
      weekday: number
      level: number
    }> = []
    const monthLabels: Array<{ week: number; label: string; fullLabel: string }> = []
    const monthFormatter = new Intl.DateTimeFormat(locale, { month: 'short' })
    const fullDateFormatter = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
    const weekdayFormatter = new Intl.DateTimeFormat(locale, { weekday: 'short' })
    let rangeTokens = 0
    let activeDays = 0

    for (let week = 0; week < weekCount; week++) {
      for (let weekday = 0; weekday < 7; weekday++) {
        const date = new Date(gridStart)
        date.setDate(gridStart.getDate() + week * 7 + weekday)
        if (date < start || date > today) continue
        const key = dateKey(date)
        const day = usageByDate.get(key) ?? {
          date: key,
          totalTokens: 0,
          conversationsCount: 0,
          messageCount: 0
        }
        rangeTokens += day.totalTokens
        if (day.totalTokens > 0) activeDays += 1
        if (date.getDate() === 1) {
          monthLabels.push({
            week,
            label: monthFormatter.format(date),
            fullLabel: new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(date)
          })
        }
        cells.push({ date, day, week, weekday, level: 0 })
      }
    }

    const maxTokens = Math.max(0, ...cells.map((cell) => cell.day.totalTokens))
    for (const cell of cells) {
      cell.level = cell.day.totalTokens === 0 || maxTokens === 0
        ? 0
        : Math.max(1, Math.ceil((cell.day.totalTokens / maxTokens) * 4))
    }

    const weekdays = Array.from({ length: 7 }, (_, day) => {
      const date = new Date(2024, 0, 1 + day)
      return weekdayFormatter.format(date)
    })

    return { cells, monthLabels, weekdays, weekCount, rangeTokens, activeDays, fullDateFormatter, locale }
  }, [settings.language, usageStats])

  // Two rows of four: what the period cost and how much it moved, then the
  // token split underneath it. The real-token reading is the one to look at,
  // so it is the only cell carrying an emphasis.
  const overviewMetrics: Array<{
    key: string
    label: string
    value: string
    hint?: string
    emphasis?: boolean
  }> = [
    { key: 'cost', label: t('Total cost'), value: formatCost(activeTokens?.cost) },
    { key: 'requests', label: t('Total requests'), value: String(activeRequests) },
    {
      key: 'tokens',
      label: t('Real tokens'),
      value: formatUsageTokens(activeTokens?.totalTokens),
      hint: t('Every token billed in this period: input, output and cache reads and writes.'),
      emphasis: true
    },
    {
      key: 'hit-rate',
      label: t('Cache hit rate'),
      value: `${activeCacheHitRate.toFixed(1)}%`,
      hint: t('Cache hits divided by all prompt tokens, cached and new.')
    },
    { key: 'input', label: t('New input'), value: formatUsageTokens(activeTokens?.input) },
    { key: 'output', label: t('Output'), value: formatUsageTokens(activeTokens?.output) },
    {
      key: 'cache-write',
      label: t('Cache write'),
      value: formatUsageTokens(activeTokens?.cacheWrite),
      hint: t('Tokens written into the prompt cache.')
    },
    { key: 'cache-hit', label: t('Cache hit'), value: formatUsageTokens(activeCacheRead) }
  ]

  // The bars scale against a round axis, so the side ticks are readable and
  // the tallest bar still answers "roughly how much" without a printed number.
  const modelPeak = Math.max(1, ...(usageStats?.byModel ?? []).map((model) => model.totalTokens))
  const modelAxis = usageAxis(modelPeak)
  // The share is the share of every token ever billed.
  const modelTotal = usageStats?.allTime.tokens.totalTokens || 1

  return (
    <div className="settings-page">
      <PageIntro
        title={t('Usage')}
        description={t('Global token consumption statistics and conversation activity across time horizons.')}
      />

      <SettingsGroup title={t('Usage heatmap')}>
        <div
          className="usage-heatmap"
          style={{ '--usage-week-count': heatmap.weekCount } as CSSProperties}
        >
          <div className="usage-heatmap__summary">
            <span>{t('Past 10 months')}</span>
            <span>
              {heatmap.activeDays} {t('Active days')} · {formatTokens(heatmap.rangeTokens)} {t('Total tokens')}
            </span>
          </div>
          <div className="usage-heatmap__viewport">
            <div className="usage-heatmap__layout">
              <div className="usage-heatmap__weekdays" aria-hidden="true">
                <span />
                {heatmap.weekdays.map((day, index) => (
                  <span key={index}>{index === 0 || index === 2 || index === 4 ? day : ''}</span>
                ))}
              </div>
              <div className="usage-heatmap__calendar">
                <div
                  className="usage-heatmap__months"
                  aria-hidden="true"
                >
                  {heatmap.monthLabels.map(({ week, label, fullLabel }) => (
                    <span key={`${week}-${label}`} style={{ gridColumn: week + 1 }} title={fullLabel}>
                      {label}
                    </span>
                  ))}
                </div>
                <div
                  className="usage-heatmap__cells"
                  // A grid needs row children and a 2-D keyboard model; this is
                  // a picture of the year, so it is announced as one summary and
                  // the hover tooltip stays the per-day reading.
                  role="img"
                  aria-label={`${t('Usage heatmap')}: ${heatmap.activeDays} ${t('Active days')} · ${formatTokens(heatmap.rangeTokens)} ${t('Total tokens')}`}
                >
                  {heatmap.cells.map(({ date, day, week, weekday, level }) => {
                    const dateLabel = heatmap.fullDateFormatter.format(date)
                    const description = `${dateLabel} · ${t('Total tokens')}: ${day.totalTokens.toLocaleString(heatmap.locale)} · ${t('Cache hit rate')}: ${cacheHitRate(day.cacheRead, day.input).toFixed(1)}%`
                    return (
                      <span
                        key={day.date}
                        className="usage-heatmap__cell"
                        data-level={level}
                        aria-label={description}
                        style={{ gridColumn: week + 1, gridRow: weekday + 1 }}
                        onMouseEnter={(event) => {
                          const rect = event.currentTarget.getBoundingClientRect()
                          setHoveredDay({
                            day,
                            dateLabel,
                            x: Math.min(rect.right + 10, window.innerWidth - 200),
                            y: Math.min(rect.top + rect.height / 2, window.innerHeight - 96)
                          })
                        }}
                        onMouseLeave={() => setHoveredDay(null)}
                      />
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
          <div className="usage-heatmap__legend" aria-label={t('Usage intensity')}>
            <span>{t('Less')}</span>
            {[0, 1, 2, 3, 4].map((level) => (
              <span key={level} className="usage-heatmap__cell" data-level={level} aria-hidden="true" />
            ))}
            <span>{t('More')}</span>
          </div>
        </div>
      </SettingsGroup>

      {/* Compact overview: one period selector, eight readings in two rows. */}
      <SettingsGroup
        title={t('Token usage overview')}
        action={
          <SettingsSelect
            label={t('Period')}
            value={selectedPeriod}
            options={periods.map(({ key, title }) => ({ value: key, label: title }))}
            onChange={(value) => setSelectedPeriod(value as typeof selectedPeriod)}
            menuWidth={180}
            className="usage-period-select"
          />
        }
      >
        <div className="usage-overview">
          {overviewMetrics.map((metric) => (
            <div
              key={metric.key}
              className="usage-overview__metric"
              data-emphasis={metric.emphasis ? 'true' : undefined}
            >
              <span className="usage-overview__label">
                <span className="usage-overview__label-text">{metric.label}</span>
                {metric.hint ? <UsageHint text={metric.hint} /> : null}
              </span>
              <span className="usage-overview__value">{metric.value}</span>
            </div>
          ))}
        </div>
      </SettingsGroup>

      {/* Model distribution: a column per model, read against the round scale
          on the left instead of a number printed on every bar. Share, turns
          and cost still ride along on the column's tooltip. */}
      {usageStats && usageStats.byModel.length > 0 && (
        <SettingsGroup title={t('Model distribution')}>
          <div className="usage-model-chart">
            <div className="usage-model-chart__plot">
              <div className="usage-model-chart__yaxis" aria-hidden="true">
                {modelAxis.ticks.map((tick) => (
                  <span
                    key={tick}
                    className="usage-model-chart__tick"
                    style={{ bottom: `${(tick / modelAxis.max) * 100}%` }}
                  >
                    {formatUsageTokens(tick)}
                  </span>
                ))}
              </div>
              <div className="usage-model-chart__area">
                <div className="usage-model-chart__grid" aria-hidden="true">
                  {modelAxis.ticks
                    .filter((tick) => tick > 0)
                    .map((tick) => (
                      <span key={tick} style={{ bottom: `${(tick / modelAxis.max) * 100}%` }} />
                    ))}
                </div>
                <div className="usage-model-chart__columns">
                  {usageStats.byModel.map((m, index) => {
                    const share = Math.min(100, (m.totalTokens / modelTotal) * 100)
                    return (
                      <div
                        key={m.model}
                        className="usage-model-chart__column"
                        onMouseEnter={(event) => {
                          const bar = event.currentTarget.querySelector<HTMLElement>(
                            '.usage-model-chart__bar'
                          )
                          const anchor = (bar ?? event.currentTarget).getBoundingClientRect()
                          setHoveredModel({
                            stat: m,
                            share,
                            series: index % 6,
                            x: Math.min(
                              Math.max(anchor.left + anchor.width / 2, 150),
                              window.innerWidth - 150
                            ),
                            // The bubble hangs above the bar; the floor keeps a tall
                            // bar from pushing it past the top of the window.
                            y: Math.max(124, anchor.top - 10)
                          })
                        }}
                        onMouseLeave={() => setHoveredModel(null)}
                      >
                        <div className="usage-model-chart__bar-area">
                          <div
                            className="usage-model-chart__bar"
                            data-series={index % 6}
                            style={{
                              height: `${Math.max(
                                4,
                                Math.round((m.totalTokens / modelAxis.max) * 100)
                              )}%`
                            }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
            <div className="usage-model-chart__xlabels">
              {usageStats.byModel.map((m) => (
                <span key={m.model} className="usage-model-chart__xlabel">
                  {m.model.split('/').pop() ?? m.model}
                </span>
              ))}
            </div>
          </div>
        </SettingsGroup>
      )}

      {/* Recent 7 Days Trend */}
      {usageStats && usageStats.recentDays.some((d) => d.totalTokens > 0 || d.conversationsCount > 0) && (
        <SettingsGroup title={t('Recent daily trend')}>
          <table className="usage-days-table">
            <thead>
              <tr>
                <th>{t('Date')}</th>
                <th>{t('Token consumption')}</th>
                <th>{t('Active conversations')}</th>
                <th>{t('Message turns')}</th>
              </tr>
            </thead>
            <tbody>
              {/* Newest day first. The reader opens this block to see what the
                  last day cost, so that row must not sit under six older ones;
                  `recentDays` itself stays in time order, because it is a series
                  (and the heatmap reads it as one) — only the table reverses. */}
              {[...usageStats.recentDays].reverse().map((d) => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  <td>{formatTokens(d.totalTokens)}</td>
                  <td>{d.conversationsCount}</td>
                  <td>{d.messageCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SettingsGroup>
      )}

      {/* Automation & context policy */}
      <SettingsGroup title={t('Automation & context policy')}>
        <div className="field">
          <div className="field__row settings-switch-row">
            <Switch
              checked={piState?.autoCompactionEnabled !== false}
              onChange={(value) => void setAutoCompaction(value)}
              label={t('Compact automatically')}
            />
            <span className="field__hint">{t('when the context window fills up')}</span>
          </div>
        </div>
        <div className="field">
          <div className="field__row settings-switch-row">
            <Switch
              checked={piState?.autoRetryEnabled !== false}
              onChange={(value) => void setAutoRetry(value)}
              label={t('Retry automatically')}
            />
            <span className="field__hint">{t('on transient provider errors')}</span>
          </div>
        </div>
      </SettingsGroup>

      {hoveredDay
        ? createPortal(
            <div
              className="usage-heatmap-tooltip"
              role="tooltip"
              style={{ left: hoveredDay.x, top: hoveredDay.y }}
            >
              <div className="usage-heatmap-tooltip__date">{hoveredDay.dateLabel}</div>
              <div className="usage-heatmap-tooltip__row">
                <span>{t('Total tokens')}</span>
                <strong>{formatUsageTokens(hoveredDay.day.totalTokens)}</strong>
              </div>
              <div className="usage-heatmap-tooltip__row">
                <span>{t('Cache hit rate')}</span>
                <strong>{cacheHitRate(hoveredDay.day.cacheRead, hoveredDay.day.input).toFixed(1)}%</strong>
              </div>
            </div>,
            document.body
          )
        : null}

      {hoveredModel
        ? createPortal(
            <div
              className="usage-model-tooltip"
              role="tooltip"
              style={{ left: hoveredModel.x, top: hoveredModel.y }}
            >
              <div className="usage-model-tooltip__head">
                <span
                  className="usage-model-tooltip__swatch"
                  data-series={hoveredModel.series}
                  aria-hidden="true"
                />
                <span className="usage-model-tooltip__name">{hoveredModel.stat.model}</span>
              </div>
              <div className="usage-model-tooltip__row">
                <span>{t('Total tokens')}</span>
                <strong>{formatUsageTokens(hoveredModel.stat.totalTokens)}</strong>
              </div>
              <div className="usage-model-tooltip__row">
                <span>{t('Share')}</span>
                <strong>{hoveredModel.share.toFixed(1)}%</strong>
              </div>
              <div className="usage-model-tooltip__row">
                <span>{t('Turns')}</span>
                <strong>{hoveredModel.stat.messageCount}</strong>
              </div>
              {hoveredModel.stat.cost > 0 ? (
                <div className="usage-model-tooltip__row">
                  <span>{t('Cost')}</span>
                  <strong>{formatCost(hoveredModel.stat.cost)}</strong>
                </div>
              ) : null}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

