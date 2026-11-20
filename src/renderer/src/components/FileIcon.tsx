import { fileTone, type FileTone } from '../lib/files'

/** The shortest name a language has, worn inside its tile. */
const MARKS: Partial<Record<FileTone, string>> = {
  ts: 'TS',
  js: 'JS',
  json: '{}',
  style: '#',
  markdown: 'MD',
  shell: '>_'
}

/**
 * The mark a file carries wherever it is listed.
 *
 * A code file wears its language's monogram in a tinted tile, a picture wears
 * a picture, and everything else is a plain sheet. The tile is the same shape
 * everywhere, so a row of files reads by language first and by name second.
 */
export function FileIcon({
  name,
  size = 15,
  className
}: {
  name: string
  size?: number
  className?: string
}) {
  const tone = fileTone(name)
  const mark = MARKS[tone]
  return (
    <span
      className={`tree__icon file-icon${className ? ` ${className}` : ''}`}
      data-tone={tone}
      aria-hidden="true"
    >
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
        {tone === 'image' ? (
          <>
            <rect x="1.7" y="1.7" width="12.6" height="12.6" rx="3.2" fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeOpacity="0.5" />
            <circle cx="10.6" cy="5.6" r="1.15" fill="currentColor" />
            <path
              d="m3.8 11.6 3.1-3.7 2.2 2.3 1.3-1.4 1.9 2.4"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : mark ? (
          <>
            <rect x="1.7" y="1.7" width="12.6" height="12.6" rx="3.2" fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeOpacity="0.5" />
            <text
              x="8"
              y="10.6"
              textAnchor="middle"
              fontSize={mark.length > 1 ? 7 : 8.4}
              letterSpacing="-0.35"
              fill="currentColor"
              className="file-icon__mark"
            >
              {mark}
            </text>
          </>
        ) : (
          <>
            <path d="M4.1 1.9h5L12.2 5v9.1H4.1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            <path d="M9 1.9V5.1h3.2" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </>
        )}
      </svg>
    </span>
  )
}
