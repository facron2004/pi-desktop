import { useCallback, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'
import { resolveThinkingLevel } from '../lib/thinking'

/**
 * The reasoning effort card with stepped capsule slider.
 *
 * Compact & refined design:
 * - Centered level title in bold accent color
 * - Clickable model switch subtitle
 * - Stepped capsule slider when the model offers more than one effort
 * - At the highest step streams of light cross the fill
 * - A single effort has nothing to slide: one tick, no track
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
  availableLevels,
  levelsLoading = false,
  onOpenModelList,
  onBusyChange
}: {
  disabled?: boolean
  modelLabel?: string
  availableLevels: string[]
  levelsLoading?: boolean
  onOpenModelList?: () => void
  onBusyChange: (busy: boolean) => void
}) {
  const liveLevel = useAppStore((state) => state.piState?.thinkingLevel)
  const savedLevel = useAppStore((state) => state.settings.thinkingLevel)
  const piState = useAppStore((state) => state.piState)
  const levels = availableLevels
  // A saved level can belong to another model. Never position the slider on a
  // level this model does not offer; fall back to the closest supported one.
  const current = liveLevel || savedLevel ? resolveThinkingLevel(levels, liveLevel, savedLevel) : undefined
  const setThinkingLevel = useAppStore((state) => state.setThinkingLevel)
  const ready = useAppStore((state) => state.status.phase === 'ready')
  const t = useT()

  const trackRef = useRef<HTMLDivElement>(null)
  const isDraggingRef = useRef(false)
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [dragRatio, setDragRatio] = useState<number | null>(null)

  const last = Math.max(0, levels.length - 1)
  const onlyLevel = levels.length === 1 ? levels[0] : undefined
  // A lone level is already the choice. Matching it exactly means the click
  // already happened (or the session restored it); anything else is one click.
  const onlyApplied = Boolean(
    onlyLevel &&
      ((liveLevel && liveLevel.toLowerCase() === onlyLevel.toLowerCase()) ||
        (!piState && savedLevel && savedLevel.toLowerCase() === onlyLevel.toLowerCase()))
  )
  const applyOnly = useCallback(async () => {
    if (!onlyLevel || onlyApplied || busyRef.current || !ready || disabled) return
    busyRef.current = true
    setBusy(true)
    onBusyChange(true)
    try {
      await setThinkingLevel(onlyLevel)
    } finally {
      busyRef.current = false
      setBusy(false)
      onBusyChange(false)
    }
  }, [disabled, onlyApplied, onlyLevel, onBusyChange, ready, setThinkingLevel])
  const hasSelection = current !== undefined || previewIndex !== null
  const currentIndex = current
    ? Math.max(0, levels.findIndex((level) => level === current))
    : Math.floor(last / 2)
  const index = previewIndex ?? currentIndex
  const enabled = ready && !disabled && !busy && levels.length > 1
  const shownLevel = previewIndex === null ? current : levels[previewIndex]
  const label = shownLevel ? t(levelLabel(shownLevel)) : t('Automatic (Pi default)')
  const activeRatio = dragRatio !== null ? dragRatio : last > 0 && hasSelection ? index / last : 0

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
    // A cold chat has not queried the model yet. A live model with no levels
    // has reported that it cannot reason, so distinguish the two states.
    const coldTitle = savedLevel ? t(levelLabel(savedLevel)) : t('Automatic (Pi default)')
    return (
      <div className="effort-card">
        <div className="effort-card__header">
          <div className="effort-card__title" data-off={piState || !savedLevel ? 'true' : undefined}>
            {piState ? t('No reasoning') : coldTitle}
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
        <div className="effort-card__empty-hint">
          {piState
            ? t('This model has no reasoning levels')
            : levelsLoading
              ? t('Loading model reasoning levels…')
              : t('No reasoning levels available for this model.')}
        </div>
      </div>
    )
  }

  const isOff = shownLevel?.toLowerCase() === 'off'
  const singleNeedsClick = Boolean(onlyLevel) && !onlyApplied && ready && !disabled
  const atPeak = hasSelection && index === last && !isOff
  const fillWidth = !hasSelection
    ? '0%'
    : last > 0
      ? activeRatio <= 0.001
        ? '0%'
        : activeRatio >= 0.999
          ? '100%'
          : `calc(12px + (100% - 24px) * ${activeRatio})`
      : '100%'
  const thumbLeft = last > 0 ? `calc(12px + (100% - 24px) * ${hasSelection ? activeRatio : 0.5})` : '50%'

  return (
    <div className="effort-card" data-single={onlyLevel ? 'true' : undefined}>
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

      {onlyLevel ? (
        <button
          type="button"
          className="effort-card__point"
          aria-label={label}
          title={t(levelHint(onlyLevel))}
          disabled={!singleNeedsClick || busy}
          onClick={() => {
            if (singleNeedsClick) void applyOnly()
          }}
        >
          <span className="effort-card__dot" data-filled="false" aria-hidden="true" />
        </button>
      ) : (
        <div
          ref={trackRef}
          className="effort-card__slider"
          data-disabled={enabled ? undefined : 'true'}
          data-dragging={dragRatio !== null ? 'true' : undefined}
          data-peak={atPeak ? 'true' : undefined}
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
            {atPeak ? (
              <span className="effort-card__meteors" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            ) : null}
            {levels.map((lvl, i) => {
              const dotPosition = last > 0 ? `calc(12px + (100% - 24px) * ${i / last})` : '50%'
              const filled = hasSelection && activeRatio > 0.001 && i <= index
              return (
                <span
                  key={lvl}
                  className="effort-card__dot"
                  data-filled={filled ? 'true' : 'false'}
                  style={{ left: dotPosition }}
                  aria-hidden="true"
                />
              )
            })}
          </div>
          <div className="effort-card__thumb" style={{ left: thumbLeft }} aria-hidden="true" />
        </div>
      )}
    </div>
  )
}
