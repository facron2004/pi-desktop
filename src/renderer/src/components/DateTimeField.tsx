import { useEffect, useMemo, useState } from 'react'
import { Calendar, ChevronLeft, ChevronRight, Clock } from 'lucide-react'
import { Popover } from './Popover'
import { useT } from '../lib/i18n'
import { useAppStore } from '../store/useAppStore'

/**
 * Date and time for a scheduled task.
 *
 * The value stays in the same local `YYYY-MM-DDTHH:mm` / `HH:mm` shape the
 * form already stores. The control is ours so the picker is not the operating
 * system's calendar.
 */
export function DateTimeField({
  mode,
  value,
  onChange
}: {
  mode: 'datetime' | 'time'
  value: string
  onChange: (value: string) => void
}) {
  const t = useT()
  const language = useAppStore((state) => state.settings.language ?? 'en')
  const locale = language === 'zh-CN' ? 'zh-CN' : 'en'
  const mondayFirst = locale === 'zh-CN'
  const selected = mode === 'datetime' ? parseDateTime(value) : parseTimeOn(value)
  const [cursor, setCursor] = useState(() => new Date(selected.getFullYear(), selected.getMonth(), 1))
  const monthKey = mode === 'datetime' ? value.slice(0, 7) : ''

  useEffect(() => {
    if (!monthKey) return
    const [year, month] = monthKey.split('-').map(Number)
    setCursor(new Date(year || 1970, (month || 1) - 1, 1))
  }, [monthKey])

  const days = useMemo(
    () => monthDays(cursor.getFullYear(), cursor.getMonth(), mondayFirst),
    [cursor, mondayFirst]
  )
  const weekdayLabels = useMemo(() => {
    const start = mondayFirst ? new Date(2024, 0, 1) : new Date(2023, 11, 31)
    return Array.from({ length: 7 }, (_, index) => {
      const day = new Date(start)
      day.setDate(start.getDate() + index)
      return new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(day)
    })
  }, [locale, mondayFirst])
  const monthLabel = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(cursor)
  const shown = mode === 'datetime'
    ? new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(selected)
    : formatClock(selected.getHours(), selected.getMinutes())

  const commit = (next: Date) => {
    onChange(mode === 'datetime' ? formatDateTime(next) : formatClock(next.getHours(), next.getMinutes()))
  }
  const pickDay = (day: Date) => {
    const next = new Date(selected)
    next.setFullYear(day.getFullYear(), day.getMonth(), day.getDate())
    commit(next)
    setCursor(new Date(day.getFullYear(), day.getMonth(), 1))
  }
  const pickTime = (hours: number, minutes: number) => {
    const next = new Date(selected)
    next.setHours(hours, minutes, 0, 0)
    commit(next)
  }
  const pickNow = () => {
    const now = new Date()
    if (mode === 'datetime') {
      commit(now)
      setCursor(new Date(now.getFullYear(), now.getMonth(), 1))
    } else {
      pickTime(now.getHours(), now.getMinutes())
    }
  }

  return (
    <Popover
      placement="bottom"
      align="left"
      width={mode === 'datetime' ? 400 : 232}
      className="datetime-field__popover"
      renderTrigger={({ open, toggle }) => (
        <button
          type="button"
          className="input datetime-field__trigger"
          data-open={open || undefined}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={toggle}
        >
          <span className="datetime-field__trigger-value">{shown}</span>
          {mode === 'datetime' ? <Calendar size={15} /> : <Clock size={15} />}
        </button>
      )}
    >
      {(close) => (
        <div className="datetime-field" data-mode={mode}>
          {mode === 'datetime' ? (
            <div className="datetime-field__calendar">
              <div className="datetime-field__month">
                <strong>{monthLabel}</strong>
                <div className="datetime-field__month-nav">
                  <button type="button" className="icon-btn" aria-label={t('Previous month')} title={t('Previous month')} onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>
                    <ChevronLeft size={15} />
                  </button>
                  <button type="button" className="icon-btn" aria-label={t('Next month')} title={t('Next month')} onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>
                    <ChevronRight size={15} />
                  </button>
                </div>
              </div>
              <div className="datetime-field__week">
                {weekdayLabels.map((label, index) => <span key={index}>{label}</span>)}
              </div>
              <div className="datetime-field__days">
                {days.map((day) => {
                  const outside = day.getMonth() !== cursor.getMonth()
                  const same = sameDay(day, selected)
                  const today = sameDay(day, new Date())
                  return (
                    <button
                      key={day.toISOString()}
                      type="button"
                      className="datetime-field__day"
                      data-outside={outside || undefined}
                      data-selected={same || undefined}
                      data-today={today || undefined}
                      onClick={() => pickDay(day)}
                    >
                      <span>{day.getDate()}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ) : null}
          <div className="datetime-field__time">
            <div className="datetime-field__readout">
              {formatClock(selected.getHours(), selected.getMinutes())}
            </div>
            <div className="datetime-field__wheel-head">
              <span>{t('Hour')}</span>
              <span>{t('Minute')}</span>
            </div>
            <div className="datetime-field__wheels">
              <span className="datetime-field__band" aria-hidden="true" />
              <TimeWheel
                count={24}
                selected={selected.getHours()}
                onPick={(hour) => pickTime(hour, selected.getMinutes())}
              />
              <TimeWheel
                count={60}
                selected={selected.getMinutes()}
                onPick={(minute) => pickTime(selected.getHours(), minute)}
              />
            </div>
            <div className="datetime-field__foot">
              <button type="button" className="datetime-field__now" onClick={pickNow}>
                {t('Now')}
              </button>
              <button type="button" className="btn btn--primary btn--sm" onClick={close}>
                {t('Confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </Popover>
  )
}

function TimeWheel({
  count,
  selected,
  onPick
}: {
  count: number
  selected: number
  onPick: (value: number) => void
}) {
  return (
    <div className="datetime-field__wheel">
      <div
        className="datetime-field__list"
        ref={(node) => {
          if (!node) return
          const active = node.querySelector<HTMLElement>('[data-selected="true"]')
          if (!active) return
          node.scrollTop = active.offsetTop - node.clientHeight / 2 + active.offsetHeight / 2
        }}
      >
        {Array.from({ length: count }, (_, value) => (
          <button
            key={value}
            type="button"
            data-selected={value === selected || undefined}
            onClick={() => onPick(value)}
          >
            {pad(value)}
          </button>
        ))}
      </div>
    </div>
  )
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function parseDateTime(value: string): Date {
  const [date, time] = value.split('T')
  const [year, month, day] = (date ?? '').split('-').map(Number)
  const [hour, minute] = (time ?? '00:00').split(':').map(Number)
  return new Date(year || 1970, (month || 1) - 1, day || 1, hour || 0, minute || 0, 0, 0)
}

function parseTimeOn(value: string): Date {
  const [hour, minute] = value.split(':').map(Number)
  const date = new Date()
  date.setHours(hour || 0, minute || 0, 0, 0)
  return date
}

function formatDateTime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${formatClock(date.getHours(), date.getMinutes())}`
}

function formatClock(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`
}

function sameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate()
}

function monthDays(year: number, month: number, mondayFirst: boolean): Date[] {
  const first = new Date(year, month, 1)
  const offset = mondayFirst ? (first.getDay() + 6) % 7 : first.getDay()
  const start = new Date(year, month, 1 - offset)
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start)
    day.setDate(start.getDate() + index)
    return day
  })
}
