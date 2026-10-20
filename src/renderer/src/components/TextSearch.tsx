import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Loader2, Search, X } from 'lucide-react'
import type { TextSearchHit } from '@shared/types'
import { relativePath } from '../lib/path'
import { useT } from '../lib/i18n'
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
  const [status, setStatus] = useState<SearchStatus>('idle')
  const version = useRef(0)
  const trimmed = query.trim()

  useEffect(() => {
    const ticket = ++version.current
    if (!root || !trimmed) {
      setHits([])
      setStatus('idle')
      return
    }
    // The rows of the previous query would be lying under the new one, so they
    // go as soon as the text changes; the debounce decides when to ask.
    setHits([])
    setStatus('searching')
    const timer = window.setTimeout(() => {
      window.pi.fs
        .searchText(trimmed, HIT_LIMIT)
        .then((found) => {
          if (version.current !== ticket) return
          setHits(found)
          setStatus('done')
        })
        .catch(() => {
          if (version.current !== ticket) return
          setHits([])
          setStatus('error')
        })
    }, DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      version.current += 1
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
    return <div className="drawer__empty">{t('Open a project folder to browse its files.')}</div>
  }

  return (
    <div
      className="text-search"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
    >
      <div className="tree__search">
        {status === 'searching' ? <Loader2 size={12} className="spin" /> : <Search size={12} />}
        <input
          value={query}
          autoFocus
          placeholder={t('Search inside the project files')}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <button className="icon-btn" onClick={() => setQuery('')} title={t('Clear')}>
            <X size={12} />
          </button>
        ) : null}
        <button className="icon-btn" onClick={onClose} title={t('Close the text search')}>
          <X size={12} />
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
        {status === 'done' && groups.length === 0 ? (
          <div className="text-search__state">{t('No matches')}</div>
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
