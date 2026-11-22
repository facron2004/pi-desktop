/**
 * The app's name, drawn as a pixel wordmark in the manner of a terminal (TUI)
 * font: every glyph sits on a 5-column cell and is filled one pixel at a time.
 *
 * It is a drawing rather than text because no pixel font ships with the app —
 * "Pi Desktop" in the system UI font does not read as a terminal. The same
 * drawing is `build/wordmark-pixel.svg`, produced by `scripts/make-wordmark.mjs`
 * from the glyph table below; change that table and copy the path across.
 *
 * The cell grid is 56x8 (`Pi Desktop` at one pixel per column, with the `p`
 * descending into the eighth row), so the aspect ratio is exactly 7:1.
 */
const WORDMARK_WIDTH = 56
const WORDMARK_HEIGHT = 8

/** Horizontal runs of one pixel each, merged per row. */
const WORDMARK_PATH =
  'M0 0h4v1h-4zM0 1h1v1h-1zM4 1h1v1h-1zM0 2h1v1h-1zM4 2h1v1h-1zM0 3h4v1h-4z' +
  'M0 4h1v1h-1zM0 5h1v1h-1zM0 6h1v1h-1z' +
  'M8 0h1v1h-1zM8 2h1v1h-1zM8 3h1v1h-1zM8 4h1v1h-1zM8 5h1v1h-1zM7 6h3v1h-3z' +
  'M15 0h4v1h-4zM15 1h1v1h-1zM19 1h1v1h-1zM15 2h1v1h-1zM19 2h1v1h-1zM15 3h1v1h-1z' +
  'M19 3h1v1h-1zM15 4h1v1h-1zM19 4h1v1h-1zM15 5h1v1h-1zM19 5h1v1h-1zM15 6h4v1h-4z' +
  'M22 2h3v1h-3zM21 3h1v1h-1zM25 3h1v1h-1zM21 4h5v1h-5zM21 5h1v1h-1zM22 6h3v1h-3z' +
  'M28 2h4v1h-4zM27 3h1v1h-1zM28 4h3v1h-3zM31 5h1v1h-1zM27 6h4v1h-4z' +
  'M33 0h1v1h-1zM33 1h1v1h-1zM33 2h1v1h-1zM36 2h1v1h-1zM33 3h1v1h-1zM35 3h1v1h-1z' +
  'M33 4h2v1h-2zM33 5h1v1h-1zM35 5h1v1h-1zM33 6h1v1h-1zM36 6h1v1h-1z' +
  'M41 0h1v1h-1zM41 1h1v1h-1zM40 2h3v1h-3zM41 3h1v1h-1zM41 4h1v1h-1zM41 5h1v1h-1z' +
  'M41 6h2v1h-2z' +
  'M46 2h3v1h-3zM45 3h1v1h-1zM49 3h1v1h-1zM45 4h1v1h-1zM49 4h1v1h-1zM45 5h1v1h-1z' +
  'M49 5h1v1h-1zM46 6h3v1h-3z' +
  'M51 2h4v1h-4zM51 3h1v1h-1zM55 3h1v1h-1zM51 4h1v1h-1zM55 4h1v1h-1zM51 5h4v1h-4z' +
  'M51 6h1v1h-1zM51 7h1v1h-1z'

/** The dot of the `i`, painted in the mark's coral as the one accent. */
const DOT = { x: 8, y: 0 }

export function PiWordmark({
  height = 14,
  accent = true,
  className
}: {
  height?: number
  /** Paint the `i` dot in the logo's coral instead of the text colour. */
  accent?: boolean
  className?: string
}) {
  const width = Math.round((height * WORDMARK_WIDTH) / WORDMARK_HEIGHT)
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${WORDMARK_WIDTH} ${WORDMARK_HEIGHT}`}
      fill="currentColor"
      // Pixel art wants square edges: anti-aliasing would soften every step.
      shapeRendering="crispEdges"
      className={['pi-wordmark', className].filter(Boolean).join(' ')}
      role="img"
      aria-label="Pi Desktop"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d={WORDMARK_PATH} />
      {accent ? (
        <rect
          x={DOT.x}
          y={DOT.y}
          width={1}
          height={1}
          fill="var(--brand-mark-coral)"
        />
      ) : null}
    </svg>
  )
}
