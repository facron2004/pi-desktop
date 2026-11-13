import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  Check,
  Code2,
  Copy,
  Download,
  Loader2,
  Maximize2,
  Minimize2,
  Scan,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useT } from '../lib/i18n'
import {
  detectMermaidDiagramType,
  formatMermaidError,
  normalizeMermaidSource,
  prepareMermaidSvgForDownload,
  readMermaidSvgSize,
  type MermaidSvgSize
} from '../lib/mermaid'
import { readMermaidPalette, renderMermaid } from '../lib/mermaid-renderer'
import { useIsDark } from '../lib/theme'
import '../styles/mermaid.css'

interface RenderedDiagram {
  svg: string
  code: string
  isDark: boolean
  themeRevision: number
  size: MermaidSvgSize | null
}

export interface MermaidDiagramProps {
  /** The fence body, without the ```mermaid fence lines. */
  code: string
  /** True while the surrounding Markdown is still growing. */
  streaming?: boolean
}

const MIN_SCALE = 0.2
const MAX_SCALE = 4
const ZOOM_STEP = 1.2
/** Keep in sync with the viewport's `--sp-4` horizontal padding. */
const VIEWPORT_PADDING = 24
const STREAMING_RENDER_DELAY = 300

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}

interface DiagramZoom {
  scale: number
  percent: number
  /** True while the current scale is the automatic fit-to-width scale. */
  atFit: boolean
  dragging: boolean
  pannable: boolean
  canZoomIn: boolean
  canZoomOut: boolean
  fit: () => void
  zoomIn: () => void
  zoomOut: () => void
  reset: () => void
  viewportProps: {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void
  }
}

/**
 * Fit-to-width plus a manual zoom/pan layer.
 *
 * 100% means Mermaid's natural pixel size. Fit-to-width never upscales a small
 * diagram — a 180px mind map at 400% is noise, not information — and a resize
 * keeps the diagram fitted until the reader zooms by hand.
 */
function useDiagramZoom(
  viewportRef: RefObject<HTMLDivElement | null>,
  size: MermaidSvgSize | null
): DiagramZoom {
  const [scale, setScale] = useState(1)
  const scaleRef = useRef(1)
  const autoFitRef = useRef(true)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{
    pointerId: number
    x: number
    y: number
    left: number
    top: number
  } | null>(null)

  const applyScale = useCallback((next: number) => {
    const clamped = clampScale(next)
    scaleRef.current = clamped
    setScale(clamped)
  }, [])

  const [pannable, setPannable] = useState(false)

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const update = () => {
      setPannable(
        viewport.scrollWidth > viewport.clientWidth + 1 ||
          viewport.scrollHeight > viewport.clientHeight + 1
      )
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [scale, size, viewportRef])

  const computeFit = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport || !size) return 1
    // Measure the real padding instead of assuming a spacing token: the
    // viewport scrolls, and an 8px overshoot there is a permanent scrollbar
    // under a diagram that otherwise fits.
    const styles = getComputedStyle(viewport)
    const padding = Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight)
    const available = viewport.clientWidth - (Number.isFinite(padding) ? padding : VIEWPORT_PADDING)
    if (available <= 0 || size.width <= 0) return 1
    return clampScale(Math.min(1, available / size.width))
  }, [size, viewportRef])

  useLayoutEffect(() => {
    const fit = computeFit()
    if (autoFitRef.current) applyScale(fit)
  }, [computeFit, applyScale])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!autoFitRef.current) return
      applyScale(computeFit())
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [applyScale, computeFit, viewportRef])

  const fit = useCallback(() => {
    autoFitRef.current = true
    applyScale(computeFit())
    const viewport = viewportRef.current
    if (viewport) {
      viewport.scrollLeft = 0
      viewport.scrollTop = 0
    }
  }, [applyScale, computeFit, viewportRef])

  /** Zoom around the pointer (or the viewport centre), keeping that point still. */
  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const viewport = viewportRef.current
      const previous = scaleRef.current
      const next = clampScale(previous * factor)
      if (!viewport || Math.abs(next - previous) < 0.0001) {
        applyScale(next)
        return
      }
      const rect = viewport.getBoundingClientRect()
      const x = clientX === undefined ? rect.width / 2 : clientX - rect.left
      const y = clientY === undefined ? rect.height / 2 : clientY - rect.top
      const contentX = (viewport.scrollLeft + x) / previous
      const contentY = (viewport.scrollTop + y) / previous
      autoFitRef.current = false
      applyScale(next)
      requestAnimationFrame(() => {
        viewport.scrollLeft = contentX * next - x
        viewport.scrollTop = contentY * next - y
      })
    },
    [applyScale, viewportRef]
  )

  const zoomIn = useCallback(() => zoomAt(ZOOM_STEP), [zoomAt])
  const zoomOut = useCallback(() => zoomAt(1 / ZOOM_STEP), [zoomAt])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const onWheel = (event: WheelEvent) => {
      // Plain wheel scrolls the container; only the documented Ctrl/Cmd chord
      // zooms, so a reader scrolling the conversation is never surprised.
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY)
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [viewportRef, zoomAt])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      const viewport = viewportRef.current
      if (!viewport) return
      const canPan =
        viewport.scrollWidth > viewport.clientWidth + 1 ||
        viewport.scrollHeight > viewport.clientHeight + 1
      if (!canPan) return
      dragRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: viewport.scrollLeft,
        top: viewport.scrollTop
      }
      viewport.setPointerCapture(event.pointerId)
      setDragging(true)
    },
    [viewportRef]
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      const viewport = viewportRef.current
      if (!drag || !viewport || drag.pointerId !== event.pointerId) return
      viewport.scrollLeft = drag.left - (event.clientX - drag.x)
      viewport.scrollTop = drag.top - (event.clientY - drag.y)
    },
    [viewportRef]
  )

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      dragRef.current = null
      const viewport = viewportRef.current
      if (viewport?.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId)
      setDragging(false)
    },
    [viewportRef]
  )

  const reset = useCallback(() => fit(), [fit])

  return {
    scale,
    percent: Math.round(scale * 100),
    atFit: Math.abs(scale - computeFit()) < 0.005,
    dragging,
    pannable,
    canZoomIn: scale < MAX_SCALE - 0.001,
    canZoomOut: scale > MIN_SCALE + 0.001,
    fit,
    zoomIn,
    zoomOut,
    reset,
    viewportProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp
    }
  }
}

interface DiagramToolbarProps {
  label: string
  busy: boolean
  zoom: DiagramZoom
  showSource: boolean
  fullscreen: boolean
  canInteract: boolean
  copied: boolean
  onToggleSource: () => void
  onToggleFullscreen: () => void
  onCopy: () => void
  onDownload: () => void
}

function DiagramToolbar({
  label,
  busy,
  zoom,
  showSource,
  fullscreen,
  canInteract,
  copied,
  onToggleSource,
  onToggleFullscreen,
  onCopy,
  onDownload
}: DiagramToolbarProps) {
  const t = useT()
  return (
    <div className="mermaid-diagram__bar" data-busy={busy ? 'true' : undefined}>
      <span className="mermaid-diagram__label" title={label}>
        {busy ? <Loader2 size={11} className="spin" aria-hidden="true" /> : null}
        <span className="mermaid-diagram__type">{label}</span>
      </span>
      <span className="mermaid-diagram__tools" role="toolbar" aria-label={label}>
        <button
          type="button"
          className="mermaid-diagram__tool"
          onClick={zoom.zoomOut}
          disabled={!canInteract || !zoom.canZoomOut}
          title={t('Zoom out')}
          aria-label={t('Zoom out')}
        >
          <ZoomOut size={13} aria-hidden="true" />
        </button>
        <span className="mermaid-diagram__zoom" aria-live="polite">
          {zoom.percent}%
        </span>
        <button
          type="button"
          className="mermaid-diagram__tool"
          onClick={zoom.zoomIn}
          disabled={!canInteract || !zoom.canZoomIn}
          title={t('Zoom in')}
          aria-label={t('Zoom in')}
        >
          <ZoomIn size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="mermaid-diagram__tool"
          onClick={zoom.fit}
          disabled={!canInteract}
          title={t('Fit diagram to width')}
          aria-label={t('Fit diagram to width')}
        >
          <Scan size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="mermaid-diagram__tool"
          onClick={onToggleFullscreen}
          disabled={!canInteract && !fullscreen}
          title={fullscreen ? t('Exit fullscreen') : t('Enter fullscreen')}
          aria-label={fullscreen ? t('Exit fullscreen') : t('Enter fullscreen')}
        >
          {fullscreen ? <Minimize2 size={13} aria-hidden="true" /> : <Maximize2 size={13} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="mermaid-diagram__tool"
          data-active={showSource ? 'true' : undefined}
          onClick={onToggleSource}
          title={showSource ? t('Hide diagram source') : t('Show diagram source')}
          aria-label={showSource ? t('Hide diagram source') : t('Show diagram source')}
          aria-pressed={showSource}
        >
          <Code2 size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="mermaid-diagram__tool"
          onClick={onCopy}
          title={copied ? t('Copied') : t('Copy diagram source')}
          aria-label={copied ? t('Copied') : t('Copy diagram source')}
        >
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="mermaid-diagram__tool"
          onClick={onDownload}
          disabled={!canInteract}
          title={t('Download SVG')}
          aria-label={t('Download SVG')}
        >
          <Download size={13} aria-hidden="true" />
        </button>
      </span>
    </div>
  )
}

function MermaidErrorPanel({ message, code }: { message: string; code: string }) {
  const t = useT()
  return (
    <div className="mermaid-diagram__error" role="alert">
      <div className="mermaid-diagram__error-head">
        <AlertTriangle size={13} aria-hidden="true" />
        <span>{t('Could not render diagram')}</span>
      </div>
      <pre className="mermaid-diagram__error-message">{message}</pre>
      <div className="mermaid-diagram__error-source">
        <span className="mermaid-diagram__error-source-label">{t('Diagram source')}</span>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    </div>
  )
}

interface DiagramSurfaceProps {
  code: string
  svg: string | null
  size: MermaidSvgSize | null
  label: string
  error: string | null
  streaming: boolean
  rendering: boolean
  fullscreen: boolean
  showSource: boolean
  copied: boolean
  onToggleSource: () => void
  onToggleFullscreen: () => void
  onCopy: () => void
  onDownload: () => void
}

function DiagramSurface({
  code,
  svg,
  size,
  label,
  error,
  streaming,
  rendering,
  fullscreen,
  showSource,
  copied,
  onToggleSource,
  onToggleFullscreen,
  onCopy,
  onDownload
}: DiagramSurfaceProps) {
  const t = useT()
  const viewportRef = useRef<HTMLDivElement>(null)
  const zoom = useDiagramZoom(viewportRef, size)
  const canInteract = Boolean(svg && size && !error)

  let body
  if (showSource) {
    body = (
      <pre className="mermaid-diagram__source" tabIndex={0} aria-label={t('Diagram source')}>
        <code>{code}</code>
      </pre>
    )
  } else if (error) {
    body = <MermaidErrorPanel message={error} code={code} />
  } else if (svg && size) {
    body = (
      <div
        ref={viewportRef}
        className="mermaid-diagram__viewport"
        data-fit={zoom.atFit ? 'true' : undefined}
        data-dragging={zoom.dragging ? 'true' : undefined}
        data-pannable={zoom.pannable ? 'true' : undefined}
        role="group"
        aria-label={label}
        tabIndex={0}
        onDoubleClick={zoom.reset}
        {...zoom.viewportProps}
      >
        <div
          className="mermaid-diagram__stage"
          style={{
            width: `${Math.max(1, Math.round(size.width * zoom.scale))}px`,
            height: `${Math.max(1, Math.round(size.height * zoom.scale))}px`
          }}
        >
          <div
            className="mermaid-diagram__graph"
            style={{
              width: `${size.width}px`,
              height: `${size.height}px`,
              transform: `scale(${zoom.scale})`
            }}
            // Mermaid sanitises its own output with DOMPurify at
            // `securityLevel: 'strict'`; this is the library's documented
            // render path, not arbitrary HTML.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>
    )
  } else if (svg) {
    // A viewBox-only SVG (an older diagram type) still scrolls naturally.
    body = (
      <div
        ref={viewportRef}
        className="mermaid-diagram__viewport"
        role="group"
        aria-label={label}
        tabIndex={0}
        onDoubleClick={zoom.reset}
        {...zoom.viewportProps}
      >
        <div className="mermaid-diagram__graph" dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
    )
  } else {
    body = (
      <div className="mermaid-diagram__status" role="status" aria-live="polite">
        <Loader2 size={13} className="spin" aria-hidden="true" />
        <span>{t('Rendering diagram…')}</span>
      </div>
    )
  }

  return (
    <>
      <DiagramToolbar
        label={label}
        busy={rendering}
        zoom={zoom}
        showSource={showSource}
        fullscreen={fullscreen}
        canInteract={canInteract}
        copied={copied}
        onToggleSource={onToggleSource}
        onToggleFullscreen={onToggleFullscreen}
        onCopy={onCopy}
        onDownload={onDownload}
      />
      {body}
      {streaming && rendering && svg && !showSource && !error ? (
        <span className="mermaid-diagram__streaming-note" role="status">
          {t('Rendering diagram…')}
        </span>
      ) : null}
    </>
  )
}

/** Render a ```mermaid fence as an interactive SVG diagram. */
export function MermaidDiagram({ code, streaming = false }: MermaidDiagramProps) {
  const isDark = useIsDark()
  const t = useT()
  const normalized = normalizeMermaidSource(code)
  const diagramType = detectMermaidDiagramType(normalized)
  const label = diagramType ? t(diagramType.label) : t('Diagram')

  const [rendered, setRendered] = useState<RenderedDiagram | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rendering, setRendering] = useState(false)
  const [showSource, setShowSource] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [themeRevision, setThemeRevision] = useState(0)
  const lastGoodRef = useRef<RenderedDiagram | null>(null)
  const copyTimerRef = useRef<number | undefined>(undefined)
  const fullscreenRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  // `useIsDark` follows the theme switch. Accent and custom background changes
  // are inline custom properties on the same element, so the diagram watches
  // those attributes too and re-colours without a reload.
  useEffect(() => {
    let frame = 0
    const observer = new MutationObserver(() => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setThemeRevision((value) => value + 1)
      })
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-tone', 'style']
    })
    return () => {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  const closeFullscreen = useCallback(() => setFullscreen(false), [])
  useDialogFocus(fullscreenRef, closeFullscreen, { enabled: fullscreen, initialFocus: 'dialog' })

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!normalized) {
      setRendering(false)
      setError(streaming ? null : formatMermaidError(new Error('The diagram is empty.')))
      return
    }
    if (
      lastGoodRef.current?.code === normalized &&
      lastGoodRef.current.isDark === isDark &&
      lastGoodRef.current.themeRevision === themeRevision
    ) {
      setRendering(false)
      setError(null)
      return
    }

    let cancelled = false
    setRendering(true)
    setError(null)
    const timer = window.setTimeout(
      () => {
        renderMermaid(normalized, { isDark })
          .then((result) => {
            if (cancelled) return
            const next: RenderedDiagram = {
              svg: result.svg,
              code: normalized,
              isDark,
              themeRevision,
              size: readMermaidSvgSize(result.svg)
            }
            lastGoodRef.current = next
            setRendered(next)
            setError(null)
          })
          .catch((reason: unknown) => {
            if (cancelled) return
            // While the fence is still growing, an incomplete statement is
            // normal: keep the last complete picture and stay quiet. Once the
            // stream settles, the reader gets the real error and the source.
            if (!streaming) setError(formatMermaidError(reason))
          })
          .finally(() => {
            if (!cancelled) setRendering(false)
          })
      },
      streaming ? STREAMING_RENDER_DELAY : 0
    )

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [normalized, streaming, isDark, themeRevision])

  const copySource = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(normalized)
      setCopied(true)
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard may be unavailable */
    }
  }, [normalized])

  const downloadSvg = useCallback(() => {
    if (!rendered || !lastGoodRef.current) return
    const background = readMermaidPalette(isDark).background
    const svg = prepareMermaidSvgForDownload(rendered.svg, background)
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `mermaid-${diagramType?.id ?? 'diagram'}.svg`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [diagramType?.id, isDark, rendered])

  const toggleSource = useCallback(() => setShowSource((value) => !value), [])
  const toggleFullscreen = useCallback(() => setFullscreen((value) => !value), [])

  const surfaceProps = {
    code: normalized,
    label,
    streaming,
    showSource,
    copied,
    onToggleSource: toggleSource,
    onCopy: () => void copySource(),
    onDownload: downloadSvg
  }

  return (
    <>
      <div
        className="mermaid-diagram"
        data-streaming={streaming ? 'true' : undefined}
        aria-busy={rendering}
        aria-hidden={fullscreen || undefined}
      >
        <DiagramSurface
          {...surfaceProps}
          svg={rendered?.svg ?? null}
          size={rendered?.size ?? null}
          error={error}
          rendering={rendering}
          fullscreen={false}
          onToggleFullscreen={toggleFullscreen}
        />
      </div>
      {fullscreen
        ? createPortal(
            <div
              className="mermaid-layer"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) closeFullscreen()
              }}
            >
              <div
                ref={fullscreenRef}
                className="mermaid-diagram mermaid-diagram--fullscreen"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
              >
                <span id={titleId} className="mermaid-diagram__dialog-title">
                  {label}
                </span>
                <button
                  type="button"
                  className="mermaid-diagram__dialog-close"
                  onClick={closeFullscreen}
                  title={t('Close')}
                  aria-label={t('Close')}
                >
                  <X size={16} aria-hidden="true" />
                </button>
                <DiagramSurface
                  {...surfaceProps}
                  svg={rendered?.svg ?? null}
                  size={rendered?.size ?? null}
                  error={error}
                  rendering={rendering}
                  fullscreen
                  onToggleFullscreen={toggleFullscreen}
                />
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
