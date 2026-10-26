import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  ExternalLink,
  File as FileIcon,
  Link2,
  MessageSquarePlus,
  Search,
  X
} from 'lucide-react'
import type { FileContent } from '@shared/types'
import { fileTone } from '../lib/files'
import { formatBytes } from '../lib/format'
import { basename, relativePath } from '../lib/path'
import { useAppStore } from '../store/useAppStore'
import { CodeSnippet } from './CodeSnippet'
import { useT } from '../lib/i18n'
import '../styles/file-viewer.css'

/** Apply the new default once, then preserve subsequent manual choices. */
const WRAP_KEY = 'pi-desktop.file-viewer-wrap-v2'

/** A file is not worth tens of thousands of ranges; the count stops here. */
const MAX_MATCHES = 2000

/** Every hit in the file, and the one the reader is on. */
const HIGHLIGHT_ALL = 'pi-file-find'
const HIGHLIGHT_CURRENT = 'pi-file-find-current'

/**
 * The CSS Custom Highlight API paints matches without touching the rendered
 * markup, so syntax highlighting can keep replacing the code underneath.
 * The DOM typings only cover part of the registry, hence the local shape.
 */
interface FileHighlightRegistry {
  set(name: string, highlight: Highlight): void
  delete(name: string): void
}

function highlightRegistry(): FileHighlightRegistry | null {
  if (typeof Highlight !== 'function') return null
  return (CSS as unknown as { highlights?: FileHighlightRegistry }).highlights ?? null
}

function paintHighlights(matches: FileMatch[], current: number): void {
  const registry = highlightRegistry()
  if (!registry) return
  registry.delete(HIGHLIGHT_ALL)
  registry.delete(HIGHLIGHT_CURRENT)
  if (!matches.length) return
  registry.set(HIGHLIGHT_ALL, new Highlight(...matches.map((match) => match.range)))
  registry.set(HIGHLIGHT_CURRENT, new Highlight(matches[Math.min(current, matches.length - 1)].range))
}

function clearHighlights(): void {
  const registry = highlightRegistry()
  registry?.delete(HIGHLIGHT_ALL)
  registry?.delete(HIGHLIGHT_CURRENT)
}

interface FileMatch {
  range: Range
  /** The rendered line the match starts on, for scrolling it into view. */
  line: HTMLElement | null
}

interface TextRun {
  node: Text
  /** Where this text node starts in the flat text of the whole file. */
  start: number
}

/** The text node and offset for a position in the flat text. */
function locateRun(runs: TextRun[], offset: number): { node: Text; offset: number } | null {
  if (!runs.length) return null
  let low = 0
  let high = runs.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (runs[mid].start <= offset) low = mid
    else high = mid - 1
  }
  const run = runs[low]
  const within = offset - run.start
  if (within < 0 || within > run.node.data.length) return null
  return { node: run.node, offset: within }
}

/**
 * Find `value` in the code as one flat string.
 *
 * The highlighted markup splits the text into a token per span, so searching
 * per node would miss a phrase that crosses two tokens. Ranges bridge that.
 */
function collectMatches(host: HTMLElement | null, value: string): FileMatch[] {
  if (!host || !value) return []
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  const runs: TextRun[] = []
  let text = ''
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const run = node as Text
    runs.push({ node: run, start: text.length })
    text += run.data
  }

  const needle = value.toLowerCase()
  const haystack = text.toLowerCase()
  const matches: FileMatch[] = []
  let from = haystack.indexOf(needle)
  while (from !== -1 && matches.length < MAX_MATCHES) {
    const start = locateRun(runs, from)
    const end = locateRun(runs, from + needle.length)
    if (start && end) {
      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
      const container = range.startContainer
      const element = container instanceof HTMLElement ? container : container.parentElement
      matches.push({ range, line: element?.closest<HTMLElement>('.line') ?? null })
    }
    from = haystack.indexOf(needle, from + needle.length)
  }
  return matches
}

/** Read the wrap preference without letting a locked profile break the viewer. */
function readWrap(): boolean {
  try {
    return localStorage.getItem(WRAP_KEY) !== 'false'
  } catch {
    return true
  }
}

interface FileViewerProps {
  file: string
  root?: string
  /** Scroll to this line and mark it, when the file was opened from a diff. */
  line?: number
}

export function FileViewer({ file, root, line }: FileViewerProps) {
  const t = useT()
  const [content, setContent] = useState<FileContent | null>(null)
  const [copied, setCopied] = useState<'file' | 'path' | null>(null)
  const [error, setError] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [count, setCount] = useState(0)
  const [active, setActive] = useState(0)
  const [jump, setJump] = useState('')
  const [wrap, setWrap] = useState(readWrap)
  const [selectedRange, setSelectedRange] = useState<{
    start: number
    end: number
    anchor: number
  } | null>(null)
  const selectedRangeRef = useRef<{ start: number; end: number; anchor: number } | null>(null)
  selectedRangeRef.current = selectedRange
  const codeRef = useRef<HTMLElement | null>(null)
  const lineRef = useRef(line)
  const findInputRef = useRef<HTMLInputElement>(null)
  const findOpenerRef = useRef<HTMLElement | null>(null)
  const findOpenRef = useRef(false)
  const queryRef = useRef('')
  const matchesRef = useRef<FileMatch[]>([])
  const activeRef = useRef(0)
  const markTimerRef = useRef<number | undefined>(undefined)
  const markedRef = useRef<HTMLElement | null>(null)
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer)
  const showToast = useAppStore((state) => state.showToast)
  lineRef.current = line

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setError(false)
    window.pi.fs
      .read(file)
      .then((result) => {
        if (cancelled) return
        if (!result) {
          setError(true)
          return
        }
        setContent(result)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [file])

  // A new file is a new reading context: find, jump and any highlight belong
  // to the old one and must not point into the new code.
  useEffect(() => {
    findOpenRef.current = false
    queryRef.current = ''
    matchesRef.current = []
    activeRef.current = 0
    setFindOpen(false)
    setQuery('')
    setCount(0)
    setActive(0)
    setJump('')
    setSelectedRange(null)
    clearHighlights()
  }, [file])

  useEffect(() => {
    try {
      localStorage.setItem(WRAP_KEY, wrap ? 'true' : 'false')
    } catch {
      // A full quota or a locked profile; wrapping still works for this run.
    }
  }, [wrap])

  useEffect(
    () => () => {
      clearHighlights()
      window.clearTimeout(markTimerRef.current)
      markedRef.current?.removeAttribute('data-marked')
    },
    []
  )

  /** Bring a line into view and flash it, the way opening from a diff does. */
  const markLine = useCallback((target: HTMLElement) => {
    markedRef.current?.removeAttribute('data-marked')
    target.setAttribute('data-marked', 'true')
    markedRef.current = target
    window.clearTimeout(markTimerRef.current)
    markTimerRef.current = window.setTimeout(() => {
      if (markedRef.current === target) {
        target.removeAttribute('data-marked')
        markedRef.current = null
      }
    }, 2400)
  }, [])

  const revealLine = useCallback(
    (wanted: number) => {
      if (!wanted || wanted < 1) return
      const lines = codeRef.current?.querySelectorAll<HTMLElement>('.line')
      const target = lines?.[wanted - 1]
      if (!target) return
      target.scrollIntoView({ block: 'center' })
      markLine(target)
    },
    [markLine]
  )

  const scrollToMatch = useCallback((match: FileMatch | undefined) => {
    match?.line?.scrollIntoView({ block: 'center' })
  }, [])

  /** Recompute after the code is rendered again, keeping the current hit. */
  const refreshFind = useCallback(() => {
    const matches = collectMatches(codeRef.current, queryRef.current)
    matchesRef.current = matches
    const next = matches.length ? Math.min(activeRef.current, matches.length - 1) : 0
    activeRef.current = next
    setCount(matches.length)
    setActive(next)
    paintHighlights(matches, next)
    scrollToMatch(matches[next])
  }, [scrollToMatch])

  const step = useCallback(
    (delta: number) => {
      const matches = matchesRef.current
      if (!matches.length) return
      const next = (activeRef.current + delta + matches.length) % matches.length
      activeRef.current = next
      setActive(next)
      paintHighlights(matches, next)
      scrollToMatch(matches[next])
    },
    [scrollToMatch]
  )

  const closeFind = useCallback(() => {
    findOpenRef.current = false
    queryRef.current = ''
    matchesRef.current = []
    activeRef.current = 0
    setFindOpen(false)
    setQuery('')
    setCount(0)
    setActive(0)
    clearHighlights()
    const opener = findOpenerRef.current
    findOpenerRef.current = null
    if (opener?.isConnected) opener.focus()
    else codeRef.current?.focus()
  }, [])

  const openFind = useCallback(() => {
    if (!findOpenRef.current) {
      findOpenerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : codeRef.current
      findOpenRef.current = true
      setFindOpen(true)
    }
    window.requestAnimationFrame(() => {
      findInputRef.current?.focus()
      findInputRef.current?.select()
    })
  }, [])

  const paintSelectedLines = useCallback(
    (range: { start: number; end: number } | null = selectedRangeRef.current) => {
      const lines = codeRef.current?.querySelectorAll<HTMLElement>('.line')
      if (!lines) return
      lines.forEach((node, index) => {
        const lineNumber = index + 1
        if (range && lineNumber >= range.start && lineNumber <= range.end) {
          node.setAttribute('data-selected', 'true')
        } else {
          node.removeAttribute('data-selected')
        }
      })
    },
    []
  )

  useEffect(() => {
    paintSelectedLines(selectedRange)
  }, [selectedRange, paintSelectedLines])

  // The code is highlighted asynchronously, so the lines the find bar points
  // at are replaced once more after the first render.
  const handleReady = useCallback(() => {
    if (lineRef.current) revealLine(lineRef.current)
    if (findOpenRef.current) refreshFind()
    paintSelectedLines(selectedRangeRef.current)
  }, [revealLine, refreshFind, paintSelectedLines])

  // The find bar searches as it is typed, and the first hit is scrolled to.
  useEffect(() => {
    if (!findOpen) {
      matchesRef.current = []
      activeRef.current = 0
      setCount(0)
      setActive(0)
      clearHighlights()
      return
    }
    const matches = collectMatches(codeRef.current, query)
    matchesRef.current = matches
    activeRef.current = 0
    setCount(matches.length)
    setActive(0)
    paintHighlights(matches, 0)
    scrollToMatch(matches[0])
  }, [findOpen, query, scrollToMatch])

  // Opening a different line of the same file changes no code, so the snippet
  // does not report itself ready again.
  useEffect(() => {
    if (line) revealLine(line)
  }, [line, revealLine])

  const handleHost = useCallback((node: HTMLElement | null) => {
    codeRef.current = node
    // The code is the reading surface: focusable, so Ctrl+F and the arrow keys
    // work right after clicking the text instead of the toolbar.
    if (node) node.tabIndex = 0
  }, [])

  const handleCodeClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (window.getSelection()?.toString()) return
    const target = event.target instanceof HTMLElement ? event.target : null
    const lineNode = target?.closest<HTMLElement>('.line')
    if (!lineNode || !codeRef.current) return
    const rect = lineNode.getBoundingClientRect()
    // Only clicks on the line-number gutter select lines so normal code selection is untouched.
    if (event.clientX - rect.left > 48) return
    const lines = Array.from(codeRef.current.querySelectorAll<HTMLElement>('.line'))
    const lineNumber = lines.indexOf(lineNode) + 1
    if (lineNumber < 1) return
    event.preventDefault()
    setSelectedRange((current) => {
      if (event.shiftKey && current) {
        return {
          start: Math.min(current.anchor, lineNumber),
          end: Math.max(current.anchor, lineNumber),
          anchor: current.anchor
        }
      }
      if (current && current.start === lineNumber && current.end === lineNumber) {
        return null
      }
      return { start: lineNumber, end: lineNumber, anchor: lineNumber }
    })
  }, [])
  const copy = async (what: 'file' | 'path') => {
    if (!content) return
    const text = what === 'file' ? content.content : relativePath(root ?? '', content.path)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      window.setTimeout(() => setCopied((current) => (current === what ? null : current)), 1600)
    } catch {
      showToast(t('The clipboard is not available'), 'error')
    }
  }

  const applyJump = useCallback(() => {
    const wanted = Number.parseInt(jump, 10)
    if (!Number.isFinite(wanted) || wanted < 1) return
    const lines = codeRef.current?.querySelectorAll<HTMLElement>('.line')
    if (!lines?.length) return
    revealLine(Math.min(wanted, lines.length))
  }, [jump, revealLine])

  /**
   * `Ctrl+F` means this file while the viewer has the keyboard. Stopping the
   * event keeps the conversation-level search from opening behind it.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      event.stopPropagation()
      openFind()
      return
    }
    if (event.key === 'Escape' && findOpenRef.current) {
      event.preventDefault()
      event.stopPropagation()
      closeFind()
    }
  }

  if (error) {
    return <div className="drawer__empty">{t('That file could not be read.')}</div>
  }
  if (!content) {
    return (
      <div className="drawer__empty">
        <span className="spinner" />
      </div>
    )
  }

  const lineCount = content.content ? content.content.split('\n').length : 0

  return (
    <div className="viewer" data-wrap={wrap ? 'true' : 'false'} onKeyDown={onKeyDown}>
      <div className="viewer__bar">
        <span className="viewer__crumb">
          <span className="viewer__crumb-root">{root ? basename(root) : ''}</span>
          <span className="viewer__crumb-path" title={content.path}>
            <span className="tree__icon" data-tone={fileTone(content.path.split(/[\\/]/).pop() ?? '')}>
              <FileIcon size={14} />
            </span>
            <span className="viewer__crumb-text">{relativePath(root ?? '', content.path)}</span>
          </span>
        </span>
        {content.truncated ? <span className="change__badge">{t('truncated')}</span> : null}
        {line ? <span className="change__badge">{t('line')} {line}</span> : null}
        <span className="viewer__meta">
          {lineCount} {lineCount === 1 ? t('line') : t('lines')}
          {content.size ? ` · ${formatBytes(content.size)}` : ''}
        </span>
        <div className="viewer__actions">
          <button
            className="ghost-btn"
            data-active={findOpen ? 'true' : 'false'}
            onClick={openFind}
            title={t('Search the file')}
            aria-label={t('Search the file')}
            aria-expanded={findOpen}
          >
            <Search size={14} />
          </button>
          <input
            className="fv-jump"
            value={jump}
            placeholder={t('Line #')}
            aria-label={t('Go to line')}
            title={t('Go to line')}
            inputMode="numeric"
            spellCheck={false}
            onChange={(event) => setJump(event.target.value.replace(/[^\d]/g, ''))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                applyJump()
              }
            }}
          />
          <button
            className="ghost-btn"
            data-active={wrap ? 'true' : 'false'}
            onClick={() => setWrap((value) => !value)}
            title={t('Wrap long lines')}
            aria-pressed={wrap}
          >
            {t('Wrap')}
          </button>
          <button
            className="ghost-btn"
            onClick={() => void copy('file')}
            title={t('Copy the file')}
            aria-label={t('Copy the file')}
          >
            {copied === 'file' ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button
            className="ghost-btn"
            onClick={() => void copy('path')}
            title={t('Copy the path of the file')}
            aria-label={t('Copy the path of the file')}
          >
            {copied === 'path' ? <Check size={14} /> : <Link2 size={14} />}
          </button>
          {selectedRange ? (
            <button
              className="ghost-btn fv-range-btn"
              data-active="true"
              title={t('Insert selected lines into composer')}
              aria-label={t('Insert selected lines into composer')}
              onClick={() => {
                const rel = relativePath(root ?? '', content.path).replace(/\\/g, '/')
                const suffix =
                  selectedRange.start === selectedRange.end
                    ? `#L${selectedRange.start}`
                    : `#L${selectedRange.start}-L${selectedRange.end}`
                insertIntoComposer(`@${rel}${suffix} `)
              }}
            >
              <MessageSquarePlus size={13} />
              <span>
                {selectedRange.start === selectedRange.end
                  ? `L${selectedRange.start}`
                  : `L${selectedRange.start}–L${selectedRange.end}`}
              </span>
            </button>
          ) : null}
          <button
            className="ghost-btn"
            title={t('Ask Pi about this file')}
            aria-label={t('Ask Pi about this file')}
            onClick={() => {
              const rel = relativePath(root ?? '', content.path).replace(/\\/g, '/')
              if (selectedRange) {
                const suffix =
                  selectedRange.start === selectedRange.end
                    ? `#L${selectedRange.start}`
                    : `#L${selectedRange.start}-L${selectedRange.end}`
                insertIntoComposer(`@${rel}${suffix} `)
                return
              }
              insertIntoComposer(t('Take a look at {file} and tell me').replace('{file}', rel))
            }}
          >
            <MessageSquarePlus size={14} />
          </button>
          <button
            className="ghost-btn"
            title={t('Reveal in the file manager')}
            aria-label={t('Reveal in the file manager')}
            onClick={() => void window.pi.fs.reveal(content.path)}
          >
            <ExternalLink size={14} />
          </button>
        </div>
      </div>

      {findOpen ? (
        <div className="fv-find">
          <Search size={12} className="fv-find__icon" />
          <input
            ref={findInputRef}
            className="fv-find__input"
            value={query}
            placeholder={t('Search the file')}
            aria-label={t('Search the file')}
            spellCheck={false}
            onChange={(event) => {
              queryRef.current = event.target.value
              setQuery(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                step(event.shiftKey ? -1 : 1)
              }
            }}
          />
          <span className="fv-find__count" role="status" aria-live="polite">
            {query
              ? count
                ? `${active + 1} ${t('of')} ${count}`
                : t('No matches')
              : ''}
          </span>
          <button
            className="icon-btn"
            disabled={!count}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => step(-1)}
            title={t('Go to the previous search hit')}
            aria-label={t('Go to the previous search hit')}
          >
            <ArrowUp size={12} />
          </button>
          <button
            className="icon-btn"
            disabled={!count}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => step(1)}
            title={t('Go to the next search hit')}
            aria-label={t('Go to the next search hit')}
          >
            <ArrowDown size={12} />
          </button>
          <button
            className="icon-btn"
            onClick={closeFind}
            title={t('Close search')}
            aria-label={t('Close search')}
          >
            <X size={12} />
          </button>
        </div>
      ) : null}

      <div className="viewer__code-wrap" onClick={handleCodeClick}>
        <CodeSnippet
          code={content.content}
          language={content.language}
          className="viewer__code"
          onHost={handleHost}
          onReady={handleReady}
        />
      </div>
    </div>
  )
}
