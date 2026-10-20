import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionMeta, SessionSearchHit } from '@shared/types'
import { basename } from './path'

/** A query shorter than this searches titles only; the text scan is heavier. */
export const MIN_SESSION_SEARCH_LENGTH = 2

/** How long the user has to stop typing before the files are read. */
const DEBOUNCE_MS = 220

/** The sidebar keeps a short list; the main process caps the scan to match. */
export const MAX_SESSION_HITS = 30

/** Characters of context shown around a hit, and characters before it. */
const SNIPPET_MAX = 100
const SNIPPET_LEAD = 32

/** The last few searches that found something, so they can be picked again. */
const HISTORY_KEY = 'pi-desktop.session-search.history'
const HISTORY_LIMIT = 8

export interface SessionSearchState {
  status: 'idle' | 'searching' | 'done'
  hits: SessionSearchHit[]
}

/** A finished scan, remembered together with the query that produced it. */
interface SearchResult {
  query: string
  status: 'done' | 'failed'
  hits: SessionSearchHit[]
}

export interface SessionSearch extends SessionSearchState {
  /** Queries that found something in a conversation, newest first. */
  history: string[]
  clearHistory: () => void
}

const IDLE: SessionSearchState = { status: 'idle', hits: [] }
const SEARCHING: SessionSearchState = { status: 'searching', hits: [] }

/** Queries remembered from earlier runs. Unreadable storage is just empty. */
export function readRecentSearches(): string[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .slice(0, HISTORY_LIMIT)
  } catch {
    return []
  }
}

function writeRecentSearches(entries: string[]): void {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(entries))
  } catch {
    // A full or disabled storage must not break the search.
  }
}

/** Put one query at the front, without a second copy that differs in case. */
export function rememberSearch(query: string, history: readonly string[]): string[] {
  const trimmed = query.trim()
  if (!trimmed) return [...history]
  const key = trimmed.toLowerCase()
  return [trimmed, ...history.filter((entry) => entry.toLowerCase() !== key)].slice(0, HISTORY_LIMIT)
}

/**
 * Ask the main process for conversations whose messages contain the query.
 *
 * The result is stored with its query instead of with the current one, so a
 * render that happens before the debounce fires can never show the hits of
 * the query the user just replaced. The sequence number does the same for
 * answers that arrive out of order.
 */
export function useSessionSearch(query: string, enabled = true): SessionSearch {
  const [result, setResult] = useState<SearchResult>({ query: '', status: 'done', hits: [] })
  const [history, setHistory] = useState<string[]>(() => readRecentSearches())
  const sequence = useRef(0)
  const recorded = useRef('')
  const trimmed = query.trim()
  const active = enabled && trimmed.length >= MIN_SESSION_SEARCH_LENGTH

  useEffect(() => {
    if (!enabled || trimmed.length < MIN_SESSION_SEARCH_LENGTH) {
      sequence.current += 1
      return
    }

    const ticket = ++sequence.current
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const hits = await window.pi.sessions.search(trimmed, MAX_SESSION_HITS)
          if (sequence.current !== ticket) return
          setResult({ query: trimmed, status: 'done', hits: hits.slice(0, MAX_SESSION_HITS) })
        } catch {
          // A failed scan is not worth an error in the sidebar — the title
          // filter below still works, so the section just stays out of the way.
          if (sequence.current !== ticket) return
          setResult({ query: trimmed, status: 'failed', hits: [] })
        }
      })()
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      // Anything still in flight for this query is stale once it is cleaned up.
      sequence.current += 1
    }
  }, [trimmed, enabled])

  // Only a search that found something is worth offering again; a query with
  // no hits is one the reader probably did not mean to keep.
  useEffect(() => {
    if (result.status !== 'done' || result.hits.length === 0 || !result.query) return
    const key = result.query.toLowerCase()
    if (recorded.current === key) return
    recorded.current = key
    setHistory((previous) => rememberSearch(result.query, previous))
  }, [result])

  // Keep the stored copy in step, so a reopened window offers the same list.
  useEffect(() => {
    writeRecentSearches(history)
  }, [history])

  const clearHistory = useCallback(() => {
    recorded.current = ''
    setHistory([])
  }, [])

  let state: SessionSearchState = IDLE
  if (active) {
    if (result.query !== trimmed) state = SEARCHING
    else if (result.status === 'failed') state = IDLE
    else state = { status: 'done', hits: result.hits }
  }
  return { ...state, history, clearHistory }
}

/** The store opens a conversation by its metadata, so a hit becomes one. */
export function sessionMetaForHit(hit: SessionSearchHit): SessionMeta {
  return {
    id: hit.sessionId,
    file: hit.file,
    cwd: hit.cwd,
    name: hit.name,
    preview: hit.preview,
    updatedAt: hit.updatedAt,
    messageCount: 0
  }
}

/** The folder a hit belongs to, as the sidebar shows projects. */
export function projectNameForHit(hit: SessionSearchHit): string {
  return hit.cwd ? basename(hit.cwd) : ''
}

export interface SnippetParts {
  before: string
  match: string
  after: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Cut a snippet down to one readable line around the match.
 *
 * The main process already trimmed the message, but it does not know how wide
 * the sidebar is. Whitespace is replaced one character at a time so the match
 * offsets still point at the right place after the normalisation.
 */
export function snippetParts(hit: SessionSearchHit): SnippetParts {
  const source = hit.snippet.replace(/\s/g, ' ')
  const start = clamp(Math.trunc(hit.matchStart), 0, source.length)
  const end = clamp(start + Math.max(0, Math.trunc(hit.matchLength)), start, source.length)

  const from = clamp(start - SNIPPET_LEAD, 0, source.length)
  let to = Math.min(source.length, from + SNIPPET_MAX)
  // A match longer than the window keeps its own length; the ellipsis of the
  // row then stands in for the rest.
  if (end > to) to = Math.min(source.length, end)

  return {
    before: (from > 0 ? '…' : '') + source.slice(from, start),
    match: source.slice(start, Math.min(end, to)),
    after: source.slice(Math.min(end, to), to) + (to < source.length ? '…' : '')
  }
}
