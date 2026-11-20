import { memo, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { highlightCode, readHighlightedCodeSync } from '../lib/highlight'
import { useIsDark } from '../lib/theme'

/**
 * A block of source code with syntax highlighting and line numbers.
 *
 * The grammar is loaded on demand, so the plain text is shown first and
 * replaced once the highlighter is ready. Without a grammar the lines are
 * wrapped by hand, so the numbering still works.
 */
export const CodeSnippet = memo(function CodeSnippet({
  code,
  language,
  className = '',
  onHost,
  onReady
}: {
  code: string
  /** The grammar to highlight with. Without one the code stays plain. */
  language?: string
  className?: string
  /** Receives the element that holds the code, for scrolling to a line. */
  onHost?: (node: HTMLElement | null) => void
  /** Runs once the code is in the DOM, highlighted or not. */
  onReady?: () => void
}) {
  const isDark = useIsDark()
  const langKey = language?.trim() || ''
  const shouldHighlight = Boolean(code && langKey && langKey.toLowerCase() !== 'text')
  const syncHtml = shouldHighlight ? readHighlightedCodeSync(code, langKey, isDark) : null

  // The rendered code belongs to the text it was made from, so a new text
  // never shows the highlighting of the old one.
  const [rendered, setRendered] = useState<{
    code: string
    language: string
    isDark: boolean
    html: string
  } | null>(null)
  const html =
    syncHtml ??
    (rendered &&
    rendered.code === code &&
    rendered.language === langKey &&
    rendered.isDark === isDark
      ? rendered.html
      : null)
  const plainLines = useMemo(() => (html ? [] : code.split('\n')), [code, html])

  useEffect(() => {
    if (!shouldHighlight || readHighlightedCodeSync(code, langKey, isDark) !== null) return
    let cancelled = false
    highlightCode(code, langKey, isDark)
      .then((markup) => {
        if (!cancelled) setRendered({ code, language: langKey, isDark, html: markup })
      })
      .catch(() => {
        if (!cancelled) setRendered(null)
      })
    return () => {
      cancelled = true
    }
  }, [code, langKey, isDark, shouldHighlight])

  useLayoutEffect(() => {
    onReady?.()
  }, [code, html, onReady])

  if (html) {
    return (
      <div
        className={`snippet shiki-host ${className}`.trim()}
        ref={onHost}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }

  return (
    <pre className={`snippet snippet--plain ${className}`.trim()} ref={onHost}>
      {plainLines.map((text, index) => (
        // The same element is reused for the next block of code, so the line
        // itself is the stable part of the key and the index only keeps two
        // identical lines apart.
        <span className="line" key={`${text}-${index}`}>
          {text}
          {'\n'}
        </span>
      ))}
    </pre>
  )
})
