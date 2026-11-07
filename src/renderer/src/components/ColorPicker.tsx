import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { X } from 'lucide-react'
import { useT } from '../lib/i18n'
import { Popover } from './Popover'

const SWATCHES = [
  '#FFFFFF',
  '#F2F4F8',
  '#8A8F98',
  '#0D0F13',
  '#D97757',
  '#4C9AFF',
  '#4ADE80',
  '#EAB308'
]

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value))
}

/** `#abc`, `abc`, `#aabbcc` and `aabbcc` all become `#AABBCC`; else null. */
function normalizeHex(input: string): string | null {
  let text = input.trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(text)) {
    text = text
      .split('')
      .map((char) => char + char)
      .join('')
  }
  if (!/^[0-9a-f]{6}$/i.test(text)) return null
  return `#${text.toUpperCase()}`
}

function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const value = normalizeHex(hex) ?? '#000000'
  const r = parseInt(value.slice(1, 3), 16) / 255
  const g = parseInt(value.slice(3, 5), 16) / 255
  const b = parseInt(value.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let h = 0
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max }
}

function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const channel = (part: number) =>
    Math.round((part + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(r)}${channel(g)}${channel(b)}`.toUpperCase()
}

/**
 * The app's colour picker: a saturation/value square, a hue rail and a hex
 * field. The native `<input type="color">` popup belongs to Chromium and
 * cannot be themed, so this replaces it.
 */
export function ColorPicker({
  value,
  onChange,
  onDone
}: {
  value: string
  onChange: (hex: string) => void
  onDone: () => void
}) {
  const t = useT()
  const [hsv, setHsv] = useState(() => hexToHsv(value))
  const [hexDraft, setHexDraft] = useState<string | null>(null)
  const svRef = useRef<HTMLDivElement>(null)
  const interacting = useRef(false)
  const latestHex = useRef(normalizeHex(value) ?? '#000000')
  const lastEmitted = useRef(latestHex.current)
  const emitTimer = useRef<number | null>(null)
  const pendingHex = useRef<string | null>(null)

  useEffect(() => {
    const next = normalizeHex(value)
    if (!next || interacting.current || next === lastEmitted.current) return
    lastEmitted.current = next
    latestHex.current = next
    setHsv(hexToHsv(next))
  }, [value])

  useEffect(
    () => () => {
      if (emitTimer.current !== null) window.clearTimeout(emitTimer.current)
    },
    []
  )

  // The page repaints on every token of a drag, so settings are written on a
  // short throttle; the final position is flushed immediately.
  const emit = (hex: string, immediate = false) => {
    latestHex.current = hex
    lastEmitted.current = hex
    pendingHex.current = hex
    if (immediate) {
      if (emitTimer.current !== null) {
        window.clearTimeout(emitTimer.current)
        emitTimer.current = null
      }
      pendingHex.current = null
      onChange(hex)
      return
    }
    if (emitTimer.current !== null) return
    emitTimer.current = window.setTimeout(() => {
      emitTimer.current = null
      const next = pendingHex.current
      pendingHex.current = null
      if (next) onChange(next)
    }, 120)
  }

  const currentHex = hsvToHex(hsv.h, hsv.s, hsv.v)

  const setFromPoint = (clientX: number, clientY: number) => {
    const rect = svRef.current?.getBoundingClientRect()
    if (!rect) return
    const s = clamp((clientX - rect.left) / rect.width)
    const v = 1 - clamp((clientY - rect.top) / rect.height)
    const next = { h: hsv.h, s, v }
    setHsv(next)
    emit(hsvToHex(next.h, next.s, next.v))
  }

  const onSvPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    interacting.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    setFromPoint(event.clientX, event.clientY)
  }

  const onSvPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interacting.current) return
    setFromPoint(event.clientX, event.clientY)
  }

  const endSvDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interacting.current) return
    interacting.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    emit(latestHex.current, true)
  }

  const setFromHue = (hue: number) => {
    const next = { ...hsv, h: hue }
    setHsv(next)
    emit(hsvToHex(next.h, next.s, next.v))
  }

  const setFromHex = (text: string) => {
    setHexDraft(text)
    const next = normalizeHex(text)
    if (!next) return
    setHsv(hexToHsv(next))
    emit(next, true)
  }

  const pickSwatch = (swatch: string) => {
    const next = normalizeHex(swatch)
    if (!next) return
    setHexDraft(null)
    setHsv(hexToHsv(next))
    emit(next, true)
  }

  return (
    <div className="color-picker">
      <div
        ref={svRef}
        className="color-picker__sv"
        style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
        role="application"
        aria-label={t('Saturation and brightness')}
        tabIndex={0}
        onPointerDown={onSvPointerDown}
        onPointerMove={onSvPointerMove}
        onPointerUp={endSvDrag}
        onPointerCancel={endSvDrag}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 0.1 : 0.02
          let s = hsv.s
          let v = hsv.v
          if (event.key === 'ArrowLeft') s = clamp(s - step)
          else if (event.key === 'ArrowRight') s = clamp(s + step)
          else if (event.key === 'ArrowUp') v = clamp(v + step)
          else if (event.key === 'ArrowDown') v = clamp(v - step)
          else return
          event.preventDefault()
          const next = { h: hsv.h, s, v }
          setHsv(next)
          emit(hsvToHex(next.h, next.s, next.v), true)
        }}
      >
        <span
          className="color-picker__handle"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
        />
      </div>

      <input
        type="range"
        className="color-picker__hue"
        min={0}
        max={359}
        step={1}
        value={Math.round(hsv.h)}
        style={{ '--color-picker-thumb': currentHex } as CSSProperties}
        aria-label={t('Hue')}
        onChange={(event) => setFromHue(Number(event.target.value))}
        onPointerUp={() => emit(latestHex.current, true)}
      />

      <div className="color-picker__swatches">
        {SWATCHES.map((swatch) => (
          <button
            key={swatch}
            type="button"
            className="color-picker__swatch"
            style={{ backgroundColor: swatch }}
            title={swatch}
            aria-label={swatch}
            onClick={() => pickSwatch(swatch)}
          />
        ))}
      </div>

      <div className="color-picker__footer">
        <span className="color-picker__preview" style={{ backgroundColor: currentHex }} />
        <input
          className="color-picker__hex"
          value={hexDraft ?? currentHex}
          aria-label={t('Hex color')}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => setFromHex(event.target.value)}
          onBlur={() => setHexDraft(null)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.blur()
            }
          }}
        />
        <button
          type="button"
          className="icon-btn color-picker__close"
          aria-label={t('Close')}
          title={t('Close')}
          onClick={onDone}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

/** The swatch pill that opens the picker, with the current colour on it. */
export function ColorField({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (hex: string) => void
}) {
  const hex = normalizeHex(value) ?? '#000000'
  return (
    <Popover
      align="right"
      width={268}
      className="color-picker__popover"
      renderTrigger={({ open, toggle }) => (
        <button
          type="button"
          className="appearance-swatch-pill"
          title={label}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={toggle}
        >
          <span className="appearance-swatch-dot" style={{ backgroundColor: value }} />
          <span className="appearance-swatch-hex">{hex}</span>
        </button>
      )}
    >
      {(close) => <ColorPicker value={hex} onChange={onChange} onDone={close} />}
    </Popover>
  )
}
