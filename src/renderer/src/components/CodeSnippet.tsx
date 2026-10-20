import { useEffect, useLayoutEffect, useState } from 'react'
import { highlightCode } from '../lib/highlight'
import { useIsDark } from '../lib/theme'

/**
 * A block of source code with syntax highlighting and line numbers.
 *
 * The grammar is loaded on demand, so the plain text is shown first and
 * replaced once the highlighter is ready. Without a grammar the lines are
 * wrapped by hand, so the numbering still works.
 */
export function CodeSnippet({
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
  // The rendered code belongs to the text it was made from, so a new text
  // never shows the highlighting of the old one.
  const [rendered, setRendered] = useState<{
    code: string
    language: string
    isDark: boolean
    html: string
  } | null>(null)
  const html =
    rendered &&
    rendered.code === code &&
    rendered.language === (language ?? '') &&
    rendered.isDark === isDark
      ? rendered.html
      : null

  useEffect(() => {
    if (!code || !language) return
    let cancelled = false
    highlightCode(code, language, isDark)
      .then((markup) => {
        if (!cancelled) setRendered({ code, language: language ?? '', isDark, html: markup })
      })
      .catch(() => {
        if (!cancelled) setRendered(null)
      })
    return () => {
      cancelled = true
    }
  }, [code, language, isDark])

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
      {code.split('\n').map((text, index) => (
        <span className="line" key={index}>
          {text}
          {'\n'}
        </span>
      ))}
    </pre>
  )
}
