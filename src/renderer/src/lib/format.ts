import type { AppLanguage } from '@shared/types'

export function formatTokens(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`
  return String(value)
}

/** An exact count for a usage breakdown, e.g. "4,354,048 tok". */
export function formatExactTokens(value: number | undefined | null): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toLocaleString()} tok`
    : '—'
}
/**
 * The usage page's measure: one decimal at every scale, so the readings in
 * the overview row line up as a column of digits.
 */
export function formatUsageTokens(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(Math.round(value))
}

export function formatCost(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '—'
  if (value === 0) return '$0.00'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

/**
 * The clock beside a message. Today stays a short time; older messages carry
 * their date, so reopening an old transcript cannot make it read as if it
 * happened now. The year appears only once the message is from an earlier
 * year, which keeps the common case short. `now` is injectable for tests so a
 * calendar-day boundary does not depend on when the suite happens to run.
 */
export function formatClock(timestamp: number | undefined, now: Date = new Date()): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const time = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  })
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (isToday) return time
  const sameYear = date.getFullYear() === now.getFullYear()
  const day = date.toLocaleDateString(undefined, {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric'
  })
  return `${day} ${time}`
}

/**
 * A whole moment — date and time — for a card that answers "when".
 *
 * The conversation list already says how long ago something happened, but a
 * hover card is where a reader asks exactly when, and "3 months ago" cannot
 * answer that. The year only appears when it is not the current one, so the
 * common case stays short.
 */
export function formatDateTime(timestamp: number | undefined, language: AppLanguage = 'en'): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleString(language === 'zh-CN' ? 'zh-CN' : undefined, {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function formatRelativeTime(timestamp: number | undefined, language: AppLanguage = 'en'): string {
  if (!timestamp) return ''
  const delta = Date.now() - timestamp
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return language === 'zh-CN' ? '刚刚' : 'just now'
  if (minutes < 60) return language === 'zh-CN' ? `${minutes} 分钟前` : `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return language === 'zh-CN' ? `${hours} 小时前` : `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return language === 'zh-CN' ? `${days} 天前` : `${days}d ago`
  return new Date(timestamp).toLocaleDateString(language === 'zh-CN' ? 'zh-CN' : undefined, {
    month: 'short',
    day: 'numeric'
  })
}

/** A coarse bucket for grouping conversations by when they happened. */
export function formatDayBucket(timestamp: number | undefined, language: AppLanguage = 'en'): string {
  if (!timestamp) return 'Earlier'
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86_400_000
  const age = startOfToday - new Date(timestamp).getTime()
  if (age < day) return 'Today'
  if (age < day * 2) return 'Yesterday'
  if (age < day * 7) return 'Earlier this week'
  if (age < day * 30) return 'Earlier this month'
  return new Date(timestamp).toLocaleDateString(language === 'zh-CN' ? 'zh-CN' : undefined, {
    month: 'short',
    year: 'numeric'
  })
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

/** A file size, short enough for a tree. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1000_000) return `${Math.round(bytes / 1000)} kB`
  return `${(bytes / 1000_000).toFixed(1)} MB`
}
