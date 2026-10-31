import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../lib/i18n'
import { splitLog } from '../../lib/log-output'

export interface LogOutputProps {
  text: string
  /** Lines rendered per page. Defaults to 200. */
  pageSize?: number
  /** Extra class for the `<pre>`, e.g. `tool__error`. */
  className?: string
}

/**
 * A long text rendered as a page of lines.
 *
 * Only the visible page is in the DOM; "Show N more lines" adds the next
 * page. A page is one `<pre>`, so the text stays selectable and copyable —
 * splitting it into one element per line would break copying across lines.
 */
export function LogOutput({ text, pageSize = 200, className }: LogOutputProps) {
  const t = useT()
  const [pages, setPages] = useState(1)
  const previousText = useRef(text)

  // A growing result keeps its opened pages; a different result starts over.
  useEffect(() => {
    if (!text.startsWith(previousText.current)) setPages(1)
    previousText.current = text
  }, [text])

  const page = useMemo(
    () => splitLog(text, Math.max(1, pageSize) * pages),
    [text, pageSize, pages]
  )
  const nextPage = Math.min(pageSize, page.hiddenLines)

  return (
    <div className="log-output">
      <pre className={`tool__pre${className ? ` ${className}` : ''}`}>{page.visibleText}</pre>
      {page.hiddenLines > 0 ? (
        <button
          type="button"
          className="tool__more log-output__more"
          onClick={() => setPages((current) => current + 1)}
        >
          {t('Show')} {nextPage.toLocaleString()} {t('more lines')}
        </button>
      ) : null}
    </div>
  )
}
