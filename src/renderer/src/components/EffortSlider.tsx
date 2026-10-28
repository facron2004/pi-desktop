import { useCallback, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'

/**
 * The reasoning effort card with stepped capsule slider.
 *
 * Compact & refined design:
 * - Centered level title in bold accent color
 * - Clickable model switch subtitle
 * - Stepped capsule slider with accent fill, tick dots, and round white thumb
 * - Smooth dragging with pointer capture, discrete step snapping on release
 */

const LEVEL_LABELS: Record<string, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Xhigh',
  max: 'Max'
}

const LEVEL_HINTS: Record<string, string> = {
  off: 'No reasoning',
  minimal: 'Fastest, shortest reasoning',
  low: 'Fast, light reasoning',
  medium: 'Balanced speed and depth',
  high: 'Thorough reasoning',
  xhigh: 'Deepest reasoning',
  max: 'Maximum reasoning effort'
}

function levelLabel(level: string): string {
  return LEVEL_LABELS[level.toLowerCase()] ?? level.charAt(0).toUpperCase() + level.slice(1)
}

function levelHint(level: string): string {
  return LEVEL_HINTS[level.toLowerCase()] ?? 'Pi decides the effort'
}

export function EffortSlider({
  disabled = false,
  modelLabel,
  onOpenModelList,
  onBusyChange
}: {
  disabled?: boolean
  modelLabel?: string
  onOpenModelList?: () => void
  onBusyChange: (busy: boolean) => void
}) {
  const levels = useAppStore((state) => state.thinkingLevels)
  const current = useAppStore((state) => state.piState?.thinkingLevel)
  const setThinkingLevel = useAppStore((state) => state.setThinkingLevel)
  const ready = useAppStore((state) => state.status.phase === 'ready')
  const t = useT()

  const trackRef = useRef<HTMLDivElement>(null)
  const isDraggingRef = useRef(false)
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [dragRatio, setDragRatio] = useState<number | null>(null)

  const currentIndex = Math.max(0, levels.findIndex((level) => level === current))
  const index = previewIndex ?? currentIndex
  const last = levels.length - 1
  const enabled = ready && !disabled && !busy && levels.length > 1
  const shownLevel = previewIndex === null ? current : levels[previewIndex]
  const label = shownLevel ? t(levelLabel(shownLevel)) : t('Thinking')

  const activeRatio = dragRatio !== null ? dragRatio : last > 0 ? index / last : 0

  const commit = useCallback(
    async (next: number) => {
      if (!enabled || busyRef.current) {
        setPreviewIndex(null)
        setDragRatio(null)
        return
      }
      const clamped = Math.max(0, Math.min(last, next))
      const level = levels[clamped]
      if (!level || level === current) {
        setPreviewIndex(null)
        setDragRatio(null)
        return
      }
      busyRef.current = true
      setBusy(true)
      onBusyChange(true)
      try {
        await setThinkingLevel(level)
      } finally {
        busyRef.current = false
        setBusy(false)
        setPreviewIndex(null)
        setDragRatio(null)
        onBusyChange(false)
      }
    },
    [current, enabled, last, levels, onBusyChange, setThinkingLevel]
  )

  const fromPointer = (clientX: number): { ratio: number; index: number } => {
    const track = trackRef.current
    if (!track || last < 1) return { ratio: 0, index: 0 }
    const box = track.getBoundingClientRect()
    const thumbRadius = 12
    const availableWidth = box.width - thumbRadius * 2
    if (availableWidth <= 0) return { ratio: 0, index: 0 }
    const relX = clientX - box.left - thumbRadius
    const ratio = Math.max(0, Math.min(1, relX / availableWidth))
    const stepIndex = Math.round(ratio * last)
    return { ratio, index: stepIndex }
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!enabled) return
    event.preventDefault()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    isDraggingRef.current = true
    const { ratio, index: nextIndex } = fromPointer(event.clientX)
    setDragRatio(ratio)
    setPreviewIndex(nextIndex)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    const { ratio, index: nextIndex } = fromPointer(event.clientX)
    setDragRatio(ratio)
    setPreviewIndex(nextIndex)
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return
    isDraggingRef.current = false
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // Ignore
    }
    const { index: nextIndex } = fromPointer(event.clientX)
    setDragRatio(null)
    setPreviewIndex(nextIndex)
    void commit(nextIndex)
  }

  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return
    isDraggingRef.current = false
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // Ignore
    }
    setDragRatio(null)
    setPreviewIndex(null)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const key = event.key
    let next: number | undefined
    if (key === 'ArrowRight' || key === 'ArrowUp') {
      next = index + 1
    } else if (key === 'ArrowLeft' || key === 'ArrowDown') {
      next = index - 1
    } else if (key === 'Home') {
      next = 0
    } else if (key === 'End') {
      next = last
    }
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    if (!enabled) return
    const clamped = Math.max(0, Math.min(last, next))
    setDragRatio(null)
    setPreviewIndex(clamped)
    void commit(clamped)
  }

  if (levels.length === 0) {
    return (
      <div className="effort-card">
        <div className="effort-card__header">
          <div className="effort-card__title" style={{ color: 'var(--text-tertiary)' }}>
            {t('No reasoning')}
          </div>
          <button
            type="button"
            className="effort-card__model-btn"
            onClick={onOpenModelList}
            disabled={disabled}
            title={`${t('Select model')}: ${modelLabel ?? ''}`}
          >
            <span className="effort-card__model-name">{modelLabel || t('Select model')}</span>
            <ChevronRight size={12} className="effort-card__model-chevron" />
          </button>
        </div>
        <div className="effort-card__slider" data-disabled="true">
          <div className="effort-card__track">
            <div className="effort-card__fill" style={{ width: '0%' }} />
          </div>
        </div>
        <div className="effort-card__empty-hint">{t('This model has no reasoning levels')}</div>
      </div>
    )
  }

  const isOff = shownLevel?.toLowerCase() === 'off'

  const fillWidth =
    last > 0
      ? activeRatio <= 0.001
        ? '0%'
        : activeRatio >= 0.999
          ? '100%'
          : `calc(12px + (100% - 24px) * ${activeRatio})`
      : '100%'

  const thumbLeft = last > 0 ? `calc(12px + (100% - 24px) * ${activeRatio})` : '50%'

  return (
    <div className="effort-card">
      <div className="effort-card__header">
        <div className="effort-card__title" data-off={isOff ? 'true' : undefined}>
          {label}
        </div>
        <button
          type="button"
          className="effort-card__model-btn"
          onClick={onOpenModelList}
          disabled={disabled}
          title={`${t('Select model')}: ${modelLabel ?? ''}`}
        >
          <span className="effort-card__model-name">{modelLabel || t('Select model')}</span>
          <ChevronRight size={12} className="effort-card__model-chevron" />
        </button>
      </div>

      <div
        ref={trackRef}
        className="effort-card__slider"
        data-disabled={enabled ? undefined : 'true'}
        data-dragging={dragRatio !== null ? 'true' : undefined}
        role="slider"
        tabIndex={enabled ? 0 : -1}
        aria-label={t('Reasoning effort')}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, last)}
        aria-valuenow={index}
        aria-valuetext={label}
        aria-disabled={!enabled}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onKeyDown={handleKeyDown}
        title={shownLevel ? t(levelHint(shownLevel)) : undefined}
      >
        <div className="effort-card__track">
          <div className="effort-card__fill" style={{ width: fillWidth }} />
          {levels.map((lvl, i) => {
            const isFilled = activeRatio > 0.001 && i <= (previewIndex ?? currentIndex)
            const dotPosition = last > 0 ? `calc(12px + (100% - 24px) * ${i / last})` : '50%'
            return (
              <span
                key={lvl}
                className="effort-card__dot"
                data-filled={isFilled ? 'true' : 'false'}
                style={{ left: dotPosition }}
                aria-hidden="true"
              />
            )
          })}
        </div>
        <div className="effort-card__thumb" style={{ left: thumbLeft }} aria-hidden="true" />
      </div>
    </div>
  )
}
