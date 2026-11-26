import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, FolderOpen, Loader2, Search, X } from 'lucide-react'
import { MAX_SEARCH_QUERY_LENGTH } from '@shared/types'
import type { TextSearchHit } from '@shared/types'
import { relativePath } from '../lib/path'
import { useT } from '../lib/i18n'
import { useAppStore } from '../store/useAppStore'
import '../styles/text-search.css'

/** The scan reads files, so the user has to stop typing before it starts. */
const DEBOUNCE_MS = 220
/** The main process caps the walk at the same number of results. */
const HIT_LIMIT = 200

type SearchStatus = 'idle' | 'searching' | 'done' | 'error'

export function TextSearch({
  root,
  onOpenFile,
  onClose
}: {
  /** The project the Files tab is showing. */
  root: string
  onOpenFile: (file: { path: string; line?: number }) => void
  /** Escape leaves the text search and goes back to the tree. */
  onClose: () => void
}) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<TextSearchHit[]>([])
  const [truncated, setTruncated] = useState(false)
  const [status, setStatus] = useState<SearchStatus>('idle')
  const inputRef = useRef<HTMLInputElement>(null)
  const version = useRef(0)
  const trimmed = query.trim()

  useEffect(() => {
    const ticket = ++version.current
    if (!root || !trimmed) {
      setHits([])
      setTruncated(false)
      setStatus('idle')
      return
    }
    // The rows of the previous query would be lying under the new one, so they
    // go as soon as the text changes; the debounce decides when to ask.
    setHits([])
    setTruncated(false)
    setStatus('searching')
    let requestStarted = false
    const timer = window.setTimeout(() => {
      requestStarted = true
      window.pi.fs
        .searchText(trimmed, HIT_LIMIT)
        .then((result) => {
          if (version.current !== ticket) return
          setHits(result.hits)
          setTruncated(result.truncated)
          setStatus('done')
        })
        .catch(() => {
          if (version.current !== ticket) return
          setHits([])
          setTruncated(false)
          setStatus('error')
        })
    }, DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      version.current += 1
      // An empty query advances the main-process search token without walking
      // the project, so a cleared or closed search stops its old disk walk.
      if (requestStarted) void window.pi.fs.searchText('', HIT_LIMIT).catch(() => undefined)
    }
  }, [trimmed, root])

  // The main process sorts the hits by path and then by line, so one pass over
  // the list groups them without changing the order of the files.
  const groups = useMemo(() => {
    const byFile = new Map<string, TextSearchHit[]>()
    for (const hit of hits) {
      const list = byFile.get(hit.path)
      if (list) list.push(hit)
      else byFile.set(hit.path, [hit])
    }
    return [...byFile.entries()]
  }, [hits])

  if (!root) {
    return (
      <div className="drawer__empty">
        <div>{t('Open a project folder to browse its files.')}</div>
        <button
          className="btn btn--sm drawer__empty-action"
          type="button"
          onClick={() => void useAppStore.getState().pickWorkspace()}
        >
          <FolderOpen size={13} />
          {t('Open project')}
        </button>
      </div>
    )
  }

  return (
    <div
      className="text-search"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
          return
        }
        // The hits are one keyboard column: the arrows walk them and the first
        // one hands focus back to the field.
        if (event.altKey || event.ctrlKey || event.metaKey) return
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        const target = event.target
        if (!(target instanceof HTMLElement) || !target.matches('[data-text-search-hit]')) return
        const hits = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-text-search-hit]')]
        const index = hits.indexOf(target)
        if (index < 0) return
        event.preventDefault()
        if (event.key === 'Home') hits[0]?.focus()
        else if (event.key === 'End') hits[hits.length - 1]?.focus()
        else if (event.key === 'ArrowDown') {
          if (index < hits.length - 1) hits[index + 1].focus()
        } else if (index === 0) inputRef.current?.focus()
        else hits[index - 1].focus()
      }}
    >
      <div className="tree__search">
        {status === 'searching' ? <Loader2 size={12} className="spin" /> : <Search size={12} />}
        <input
          ref={inputRef}
          value={query}
          maxLength={MAX_SEARCH_QUERY_LENGTH}
          autoFocus
          aria-label={t('Search inside the project files')}
          placeholder={t('Search inside the project files')}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.altKey || event.ctrlKey || event.metaKey) return
            const firstHit = () =>
              inputRef.current?.closest('.text-search')?.querySelector<HTMLElement>('[data-text-search-hit]')
            if (event.key === 'ArrowDown') {
              const first = firstHit()
              if (first) {
                event.preventDefault()
                first.focus()
              }
              return
            }
            if (event.key === 'Enter') {
              const first = firstHit()
              if (first) {
                event.preventDefault()
                first.click()
              }
            }
          }}
        />
        {query ? (
          <button
            className="icon-btn"
            onClick={() => {
              setQuery('')
              inputRef.current?.focus()
            }}
            title={t('Clear')}
            aria-label={t('Clear')}
          >
            <X size={12} />
          </button>
        ) : null}
        <button
          className="icon-btn"
          onClick={onClose}
          title={t('Back to files')}
          aria-label={t('Back to files')}
        >
          <ArrowLeft size={12} />
        </button>
      </div>

      <div className="text-search__results">
        {status === 'error' ? (
          <div className="text-search__state" data-kind="error">
            {t('The text search failed.')}
          </div>
        ) : null}
        {status === 'searching' ? (
          <div className="text-search__state">{t('Searching…')}</div>
        ) : null}
        {status === 'done' && groups.length === 0 && !truncated ? (
          <div className="text-search__state">{t('No matches')}</div>
        ) : null}
        {status === 'done' && truncated ? (
          <div className="text-search__state">{t('Text search reached a limit; results may be incomplete.')}</div>
        ) : null}
        {groups.map(([path, fileHits]) => {
          const shown = relativePath(root, path)
          return (
            <div className="text-search__file" key={path}>
              <div className="text-search__file-head">
                <span className="text-search__path" title={path}>
                  {shown}
                </span>
                <span className="text-search__count">{fileHits.length}</span>
              </div>
              {fileHits.map((hit) => (
                <button
                  key={`${hit.path}:${hit.line}`}
                  className="text-search__hit"
                  data-text-search-hit
                  title={`${shown}:${hit.line}`}
                  onClick={() => onOpenFile({ path: hit.path, line: hit.line })}
                >
                  <span className="text-search__line">{hit.line}</span>
                  <span className="text-search__preview">{highlight(hit)}</span>
                </button>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** The preview around the match, with the match wrapped in a `mark`. */
function highlight(hit: TextSearchHit): ReactNode {
  // The offsets come from the main process; clamping them keeps a stale hit
  // from slicing the string in the wrong place.
  const start = Math.min(Math.max(hit.matchStart, 0), hit.preview.length)
  const end = Math.min(Math.max(start + hit.matchLength, start), hit.preview.length)
  return (
    <>
      {hit.preview.slice(0, start)}
      {end > start ? <mark>{hit.preview.slice(start, end)}</mark> : null}
      {hit.preview.slice(end)}
    </>
  )
}
