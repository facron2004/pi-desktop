import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ChevronDown, ChevronRight, ChevronUp, CircleAlert, Info, List, Search, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import type { AssistantItem, NoticeItem, ThreadItem, ToolItem, UserItem } from '../lib/thread'
import type { InspectorRequest, ModelInfo } from '@shared/types'
import { collectChanges } from '../lib/changes'
import { diffStats } from '../lib/diff-fold'
import { formatClock, formatCost, formatTokens } from '../lib/format'
import { findMatches, splitSnippet, type SearchableChunk, type SearchHit } from '../lib/search'
import { pairForkTargets } from '../lib/thread'
import { describeTool } from '../lib/tools'
import { summarizeTool } from '../lib/tool-renderers'
import { modelName } from '../lib/models'
import { scrollBehavior } from '../lib/motion'
import { SearchContext } from '../lib/search-context'
import { AssistantImage, AssistantText, NoticeMessage, ThinkingBlock, UserMessage } from './MessageItem'
import { ToolCard, BashCard } from './ToolCard'
import { ProcessTrail } from './ProcessTrail'
import { FileChangeSummary } from './FileChangeSummary'
import { RunOutcome, RunStatusRow } from './RunStatusRow'
import { useT } from '../lib/i18n'
import { isRateLimitError } from '../lib/provider-error'
import type { RunState } from '../store/useAppStore'
import '../styles/conversation-stream.css'

interface Turn {
  id: string
  user?: UserItem
  assistants: AssistantItem[]
  tools: ToolItem[]
  notices: NoticeItem[]
  bash: Extract<ThreadItem, { kind: 'bash' }>[]
}

const VISIBLE_RECENT_TURNS = 3
const MIN_HIDDEN_MESSAGES = 12
/** How far from the bottom still counts as "following the output". */
const FOLLOW_RANGE = 80

/** Group the flat item list into turns: a user message and everything it produced. */
function buildTurns(items: ThreadItem[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null

  for (const item of items) {
    if (item.kind === 'user') {
      current = { id: item.id, user: item, assistants: [], tools: [], notices: [], bash: [] }
      turns.push(current)
      continue
    }
    if (!current) {
      current = { id: `turn-${item.id}`, assistants: [], tools: [], notices: [], bash: [] }
      turns.push(current)
    }
    if (item.kind === 'assistant') current.assistants.push(item)
    else if (item.kind === 'tool') current.tools.push(item)
    else if (item.kind === 'notice') current.notices.push(item)
    else if (item.kind === 'bash') current.bash.push(item)
  }

  return turns
}

/** The text of a turn that the search bar looks through. */
function searchableChunks(turns: Turn[], root?: string): SearchableChunk[] {
  const chunks: SearchableChunk[] = []
  for (const turn of turns) {
    if (turn.user?.text.trim()) {
      chunks.push({ turnId: turn.id, messageId: turn.user.id, source: 'You', text: turn.user.text })
    }
    for (const assistant of turn.assistants) {
      for (const block of assistant.blocks) {
        if (block.type === 'text' && block.text.trim()) {
          chunks.push({ turnId: turn.id, messageId: assistant.id, source: 'Pi', text: block.text })
        }
      }
    }
    for (const tool of turn.tools) {
      // The arguments of a tool carry whole files, so only the one-line
      // summary of the call goes into the index. Otherwise every word of
      // every edited file turns into a search hit.
      const label = describeTool(tool.toolName).summary(tool.args ?? {}, root)
      chunks.push({
        turnId: turn.id,
        messageId: tool.id,
        source: 'Tool',
        text: `${tool.toolName} ${label}`
      })
    }
  }
  return chunks
}

function searchTextForMessage(item: UserItem | AssistantItem): string {
  if (item.kind === 'user') return item.text
  return item.blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

function normalizeSearchText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null)

  const copy = useCallback(async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
      window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1600)
    } catch {
      /* clipboard may be unavailable */
    }
  }, [])

  return { copied, copy }
}

export function Thread() {
  const items = useAppStore((state) => state.items)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const run = useAppStore((state) => state.run)
  const transport = useAppStore((state) => state.transport)
  /**
   * Whether a run is open, as opposed to whether Pi has started streaming.
   *
   * A prompt handed to a settled runtime is `queued` before any event
   * arrives, so `isStreaming` alone would hide the row for exactly the moment
   * the reader most wants to know what happened to their message.
   */
  const runOpen = isStreaming || (run.phase !== 'idle' && !run.settled)
  const workspace = useAppStore((state) => state.workspace)
  const activeSessionFile = useAppStore((state) => state.activeSessionFile)
  const models = useAppStore((state) => state.models)
  const forkTargets = useAppStore((state) => state.forkTargets)
  const forkFrom = useAppStore((state) => state.forkFrom)
  const t = useT()
  const forking = useAppStore((state) => state.forking)
  const error = useAppStore((state) => state.error)
  const dismissError = useAppStore((state) => state.dismissError)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const previousItemsRef = useRef(items)
  const initialScrollRef = useRef({ sessionFile: activeSessionFile, done: false })
  if (initialScrollRef.current.sessionFile !== activeSessionFile) {
    initialScrollRef.current = { sessionFile: activeSessionFile, done: false }
  }
  const [atBottom, setAtBottom] = useState(true)
  const [expandedHistorySession, setExpandedHistorySession] = useState<string | null>(null)
  const pendingTurnJumpRef = useRef<string | null>(null)
  const { copied, copy } = useCopy()

  const [searchOpen, setSearchOpen] = useState(false)
  const [searchResultsOpen, setSearchResultsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hitIndex, setHitIndex] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const jumpHitIndexRef = useRef<number | null>(null)
  const pendingJumpTargetRef = useRef<{ turnId: string; query: string } | null>(null)

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchResultsOpen(false)
    setQuery('')
  }, [])

  const turns = useMemo(() => buildTurns(items), [items])
  const historySessionKey = activeSessionFile ?? ''
  const historyExpanded = expandedHistorySession === historySessionKey
  const hiddenTurnCount = Math.max(0, turns.length - VISIBLE_RECENT_TURNS)
  const hiddenMessageCount = useMemo(
    () =>
      turns
        .slice(0, hiddenTurnCount)
        .reduce((count, turn) => count + Number(Boolean(turn.user)) + turn.assistants.length, 0),
    [hiddenTurnCount, turns]
  )
  const historyCollapsed = !historyExpanded && hiddenMessageCount >= MIN_HIDDEN_MESSAGES
  const firstVisibleTurn = historyCollapsed ? hiddenTurnCount : 0
  const visibleTurns = historyCollapsed ? turns.slice(firstVisibleTurn) : turns
  const hasSearchQuery = searchOpen && Boolean(query.trim())
  const chunks = useMemo(
    () => (hasSearchQuery ? searchableChunks(turns, workspace?.path) : []),
    [hasSearchQuery, turns, workspace?.path]
  )
  const hits: SearchHit[] = useMemo(() => findMatches(chunks, query), [chunks, query])
  const forkByUserId = useMemo(() => pairForkTargets(items, forkTargets), [items, forkTargets])

  useEffect(() => {
    if (hits.length === 0) setSearchResultsOpen(false)
  }, [hits.length])

  /**
   * What Pi is doing right now.
   *
   * Derived from the run state and from the tool call that is actually
   * executing — not from the last tool in the list, which may have finished
   * a while ago. The reader may have scrolled up, so the footer says what
   * the agent is working on as well.
   */
  const activity = useMemo(() => {
    const last = turns[turns.length - 1]
    if (!last) return ''
    // A running tool is the one that is executing; a proposed one has not
    // started, so it is not what the agent is doing this second.
    let tool: ToolItem | undefined
    for (let index = last.tools.length - 1; index >= 0; index -= 1) {
      if (last.tools[index].status === 'running') {
        tool = last.tools[index]
        break
      }
    }
    if (!tool) {
      for (let index = last.tools.length - 1; index >= 0; index -= 1) {
        if (last.tools[index].status === 'proposed') {
          tool = last.tools[index]
          break
        }
      }
    }
    if (!tool) return ''
    const summary = summarizeTool(tool)
    return summary.detail ? `${summary.label} ${summary.detail}` : summary.label
  }, [turns])

  useLayoutEffect(() => {
    const node = scrollRef.current
    const itemsChanged = previousItemsRef.current !== items
    previousItemsRef.current = items
    if (!node || (!itemsChanged && initialScrollRef.current.done) || !stickRef.current || items.length === 0) return
    if (!initialScrollRef.current.done) {
      initialScrollRef.current.done = true
      if (historyCollapsed) {
        node.scrollTo({ top: 0, behavior: 'instant' })
        const nearBottom = node.scrollHeight - node.clientHeight < FOLLOW_RANGE
        stickRef.current = nearBottom
        setAtBottom(nearBottom)
        return
      }
    }
    node.scrollTo({ top: node.scrollHeight, behavior: 'instant' })
  }, [items, historyCollapsed])

  // A reader who scrolls up is reading, not watching: the follow stops and
  // only a click brings it back. The window is generous enough that a
  // half-line of layout does not switch the mode.
  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const onScroll = () => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight
      stickRef.current = distance < FOLLOW_RANGE
      setAtBottom(stickRef.current)
    }
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => node.removeEventListener('scroll', onScroll)
  }, [])

  // `Ctrl+F` searches the conversation, the way every other editor does.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setSearchOpen(true)
        requestAnimationFrame(() => searchInputRef.current?.focus())
        return
      }
      if (event.key === 'Escape' && searchOpen) {
        event.preventDefault()
        closeSearch()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [searchOpen, closeSearch])

  useEffect(() => {
    const jumpHitIndex = jumpHitIndexRef.current
    jumpHitIndexRef.current = null
    setHitIndex(jumpHitIndex ?? 0)
  }, [query])

  // Development aid: open the search bar with a query for screenshots.
  useEffect(() => {
    const dev = (window as unknown as { __piDesktopDev?: { search?: string } }).__piDesktopDev
    if (!dev?.search) return
    setSearchOpen(true)
    setQuery(dev.search)
  }, [])

  const jumpToTurn = useCallback(
    (turnId: string) => {
      const turnIndex = turns.findIndex((turn) => turn.id === turnId)
      if (turnIndex < 0) return
      if (turnIndex < firstVisibleTurn) {
        pendingTurnJumpRef.current = turnId
        setExpandedHistorySession(historySessionKey)
        return
      }
      const node = scrollRef.current?.querySelector<HTMLElement>(`[data-turn="${turnId}"]`)
      if (!node) return
      stickRef.current = false
      node.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
      node.classList.remove('turn--flash')
      // Force a reflow so the animation can run again on the same turn.
      void node.offsetWidth
      node.classList.add('turn--flash')
      window.setTimeout(() => node.classList.remove('turn--flash'), 1400)
    },
    [firstVisibleTurn, historySessionKey, turns]
  )

  const jumpToHit = useCallback(
    (hit: SearchHit | undefined) => {
      if (!hit) return
      jumpToTurn(hit.turnId)
    },
    [jumpToTurn]
  )

  useLayoutEffect(() => {
    const turnId = pendingTurnJumpRef.current
    if (!turnId || firstVisibleTurn > 0) return
    const node = scrollRef.current?.querySelector<HTMLElement>(`[data-turn="${turnId}"]`)
    if (!node) return
    pendingTurnJumpRef.current = null
    stickRef.current = false
    setAtBottom(false)
    node.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
    node.classList.remove('turn--flash')
    // Force a reflow so the animation can run again on the same turn.
    void node.offsetWidth
    node.classList.add('turn--flash')
    window.setTimeout(() => node.classList.remove('turn--flash'), 1400)
  }, [firstVisibleTurn, turns])

  const stepHit = useCallback(
    (delta: number) => {
      if (hits.length === 0) return
      const next = (hitIndex + delta + hits.length) % hits.length
      setHitIndex(next)
      jumpToHit(hits[next])
    },
    [hits, hitIndex, jumpToHit]
  )

  // `Alt+↑` / `Alt+↓` walk through the turns, which is faster than scrolling
  // a long conversation by hand.
  const jumpTurn = useCallback((direction: -1 | 1) => {
    const container = scrollRef.current
    if (!container) return
    const visibleTurnNodes = Array.from(container.querySelectorAll<HTMLElement>('[data-turn]'))
    if (visibleTurnNodes.length === 0) return

    const containerTop = container.getBoundingClientRect().top
    const scrollTop = container.scrollTop
    const offsets = visibleTurnNodes.map((turn) => {
      const rect = turn.getBoundingClientRect()
      return { turn, offset: rect.top - containerTop + scrollTop }
    })

    const entry =
      direction === -1
        ? [...offsets].reverse().find((item) => item.offset < scrollTop - 8)
        : offsets.find((item) => item.offset > scrollTop + 8)
    if (!entry) {
      if (direction === -1 && firstVisibleTurn > 0) {
        const previous = turns[firstVisibleTurn - 1]
        if (previous) {
          pendingTurnJumpRef.current = previous.id
          setExpandedHistorySession(historySessionKey)
        }
      }
      return
    }

    stickRef.current = false
    container.scrollTo({ top: entry.offset - 8, behavior: scrollBehavior() })
    entry.turn.classList.remove('turn--flash')
    // Force a reflow so the animation can run again on the same turn.
    void entry.turn.offsetWidth
    entry.turn.classList.add('turn--flash')
    window.setTimeout(() => entry.turn.classList.remove('turn--flash'), 1400)
  }, [firstVisibleTurn, historySessionKey, turns])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return
      if (!event.altKey) return
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        jumpTurn(-1)
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        jumpTurn(1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [jumpTurn])

  const scrollToBottom = () => {
    const node = scrollRef.current
    if (!node) return
    stickRef.current = true
    setAtBottom(true)
    node.scrollTo({ top: node.scrollHeight, behavior: scrollBehavior() })
  }

  // A conversation-search hit from the sidebar asks for a message, and the
  // thread is the only thing that knows where that message is on screen. The
  // request is cleared once the turn has been reached either way, so a hit
  // that no longer exists cannot keep the thread from scrolling again.
  const pendingJump = useAppStore((state) => state.pendingJump)
  const consumeJump = useAppStore((state) => state.consumeJump)
  const showToast = useAppStore((state) => state.showToast)

  // A query belongs to the conversation it was typed in. Clearing it here
  // keeps a jump highlight from following the reader into the next one; the
  // jump effect below sets it again when the hit lands.
  const previousSession = useRef(activeSessionFile)
  useEffect(() => {
    if (previousSession.current === activeSessionFile) return
    previousSession.current = activeSessionFile
    setQuery('')
    setSearchResultsOpen(false)
    pendingTurnJumpRef.current = null
    pendingJumpTargetRef.current = null
  }, [activeSessionFile])

  useEffect(() => {
    if (!pendingJump || pendingJump.file !== activeSessionFile) return
    if (items.length === 0) return

    const conversation = items.filter(
      (item): item is UserItem | AssistantItem => item.kind === 'user' || item.kind === 'assistant'
    )
    const snippet = normalizeSearchText(pendingJump.snippet)
    const target = conversation.find(
      (item) =>
        item.kind === pendingJump.role &&
        normalizeSearchText(searchTextForMessage(item)).includes(snippet)
    )
    // Session files keep every branch, but the thread only displays the active
    // one. Match the hit's surrounding text so an ordinal from another branch
    // cannot send the reader to an unrelated message with the same query.
    const turnId = target
      ? turns.find(
          (turn) =>
            turn.user?.id === target.id ||
            turn.assistants.some((assistant) => assistant.id === target.id)
        )?.id
      : undefined
    if (!turnId && pendingJump.query.trim()) {
      showToast("This search result isn't visible in the current conversation.")
    }

    const turnIndex = turnId ? turns.findIndex((turn) => turn.id === turnId) : -1
    const hidden = turnIndex >= 0 && turnIndex < firstVisibleTurn
    const node = turnId && !hidden
      ? scrollRef.current?.querySelector<HTMLElement>(`[data-turn="${turnId}"]`)
      : null
    // The words of the hit stay marked and the search bar opens on them, so
    // it is obvious why this turn was picked and the reader can walk the rest
    // of the hits from here.
    if (pendingJump.query.trim()) {
      const localHits = findMatches(searchableChunks(turns, workspace?.path), pendingJump.query)
      const targetHitIndex = target
        ? localHits.findIndex((hit) => hit.messageId === target.id)
        : -1
      if (query === pendingJump.query) {
        jumpHitIndexRef.current = null
        setHitIndex(Math.max(0, targetHitIndex))
      } else {
        jumpHitIndexRef.current = targetHitIndex >= 0 ? targetHitIndex : null
      }
      pendingJumpTargetRef.current = turnId
        ? { turnId, query: pendingJump.query }
        : null
      if (hidden) setExpandedHistorySession(historySessionKey)
      setQuery(pendingJump.query)
      setSearchResultsOpen(false)
      setSearchOpen(true)
    } else if (node) {
      stickRef.current = false
      setAtBottom(false)
      node.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
      node.classList.remove('turn--flash')
      // Force a reflow so the animation runs again when the same turn is
      // picked twice in a row.
      void node.offsetWidth
      node.classList.add('turn--flash')
      window.setTimeout(() => node.classList.remove('turn--flash'), 1600)
    } else if (turnId && hidden) {
      pendingTurnJumpRef.current = turnId
      setExpandedHistorySession(historySessionKey)
    }
    consumeJump()
  }, [pendingJump, activeSessionFile, historySessionKey, items, turns, firstVisibleTurn, workspace?.path, query, consumeJump, showToast])

  useEffect(() => {
    const target = pendingJumpTargetRef.current
    if (!target || (target.query && (!searchOpen || query !== target.query))) return

    const node = scrollRef.current?.querySelector<HTMLElement>(`[data-turn="${target.turnId}"]`)
    pendingJumpTargetRef.current = null
    if (!node) return

    stickRef.current = false
    setAtBottom(false)
    node.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
    node.classList.remove('turn--flash')
    // Force a reflow so the animation runs again after the search bar opens.
    void node.offsetWidth
    node.classList.add('turn--flash')
    window.setTimeout(() => node.classList.remove('turn--flash'), 1600)
  }, [pendingJump, query, searchOpen, turns, firstVisibleTurn])

  return (
    <div className="thread" ref={scrollRef}>
      {searchOpen ? (
        <div className="thread-search">
          <div className="thread-search__bar">
            <Search size={13} />
            <input
              ref={searchInputRef}
              value={query}
              placeholder={t('Search this conversation')}
              aria-label={t('Search this conversation')}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  stepHit(event.shiftKey ? -1 : 1)
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  closeSearch()
                }
              }}
            />
            <span
              className="thread-search__count"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {query.trim()
                ? hits.length
                  ? `${hitIndex + 1} ${t('of')} ${hits.length}`
                  : t('no results')
                : ''}
            </span>
            <button
              className="icon-btn thread-search__previous"
              title={t('Previous match (Shift+Enter)')}
              aria-label={t('Previous match (Shift+Enter)')}
              disabled={hits.length === 0}
              onClick={() => stepHit(-1)}
            >
              <ChevronUp size={14} />
            </button>
            <button
              className="icon-btn thread-search__next"
              title={t('Next match (Enter)')}
              aria-label={t('Next match (Enter)')}
              disabled={hits.length === 0}
              onClick={() => stepHit(1)}
            >
              <ChevronDown size={14} />
            </button>
            <button
              className="icon-btn thread-search__toggle"
              title={t(searchResultsOpen ? 'Hide search results' : 'Show search results')}
              aria-label={t(searchResultsOpen ? 'Hide search results' : 'Show search results')}
              aria-expanded={searchResultsOpen}
              aria-controls="thread-search-results"
              disabled={hits.length === 0}
              onClick={() => setSearchResultsOpen((open) => !open)}
            >
              <List size={14} />
            </button>
            <button
              className="icon-btn"
              title={t('Close search')}
              aria-label={t('Close search')}
              onClick={closeSearch}
            >
              <X size={13} />
            </button>
          </div>

          {searchResultsOpen && hits.length > 0 ? (
            <div className="thread-search__results" id="thread-search-results">
              {hits.slice(0, 6).map((hit, index) => {
                const [before, match, after] = splitSnippet(hit.snippet, query)
                return (
                  <button
                    key={hit.key}
                    className="thread-search__hit"
                    data-active={index === hitIndex}
                    aria-current={index === hitIndex ? 'location' : undefined}
                    onClick={() => {
                      setHitIndex(index)
                      jumpToHit(hit)
                    }}
                  >
                    <span className="thread-search__source">{hit.source}</span>
                    <span className="thread-search__snippet">
                      {before}
                      <mark>{match}</mark>
                      {after}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="thread__inner" data-history-collapsed={historyCollapsed}>
        {historyCollapsed ? (
          <div className="thread__history">
            <button
              type="button"
              aria-expanded={false}
              aria-label={t(`Up ${hiddenMessageCount} messages`)}
              onClick={() => setExpandedHistorySession(historySessionKey)}
            >
              <span>{t(`Up ${hiddenMessageCount} messages`)}</span>
              <ChevronRight size={15} strokeWidth={1.6} />
            </button>
          </div>
        ) : null}
        <SearchContext.Provider value={query}>
          {visibleTurns.map((turn, index) => {
            const turnIndex = firstVisibleTurn + index
            const userId = turn.user?.id
            const isLastTurn = turnIndex === turns.length - 1
            return (
              <ThreadTurnView
                key={turn.id}
                turn={turn}
                models={models}
                t={t}
                onCopy={copy}
                userCopied={copied === userId}
                forkEntryId={userId ? forkByUserId.get(userId) : undefined}
                onFork={forkFrom}
                forking={Boolean(userId && forkByUserId.has(userId) && forking)}
                run={run}
                isLastTurn={isLastTurn}
              />
            )
          })}
        </SearchContext.Provider>

        {runOpen ? (
          <RunStatusRow run={run} transport={transport} activity={activity || undefined} />
        ) : null}

        {error ? (
          <div className="thread-error-banner" role="alert">
            <div className="thread-error-banner__content">
              <CircleAlert size={16} className="thread-error-banner__icon" />
              <span className="thread-error-banner__text">{error}</span>
            </div>
            <button
              className="icon-btn thread-error-banner__dismiss"
              onClick={dismissError}
              aria-label={t('Dismiss')}
              title={t('Dismiss')}
            >
              <X size={14} />
            </button>
          </div>
        ) : null}
      </div>

      {!atBottom ? (
        <div className="scroll-bottom-wrap">
          <button
            className="scroll-bottom"
            onClick={scrollToBottom}
            title={t('Scroll to the latest')}
            aria-label={t('Scroll to the latest')}
          >
            <ArrowDown size={15} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

interface ThreadTurnViewProps {
  turn: Turn
  models: ModelInfo[]
  t: (text: string) => string
  onCopy: (id: string, text: string) => void
  userCopied: boolean
  forkEntryId?: string
  onFork: (entryId: string) => void
  forking: boolean
  run: RunState
  /** The turn that is last in the conversation, where a run summary belongs. */
  isLastTurn: boolean
}

function sameReferences<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function sameTurnContent(left: Turn, right: Turn): boolean {
  return (
    left.id === right.id &&
    left.user === right.user &&
    sameReferences(left.assistants, right.assistants) &&
    sameReferences(left.tools, right.tools) &&
    sameReferences(left.notices, right.notices) &&
    sameReferences(left.bash, right.bash)
  )
}

function equalThreadTurnViewProps(
  previous: ThreadTurnViewProps,
  next: ThreadTurnViewProps
): boolean {
  return (
    sameTurnContent(previous.turn, next.turn) &&
    previous.models === next.models &&
    previous.t === next.t &&
    previous.onCopy === next.onCopy &&
    previous.userCopied === next.userCopied &&
    previous.forkEntryId === next.forkEntryId &&
    previous.onFork === next.onFork &&
    previous.forking === next.forking &&
    previous.run === next.run &&
    previous.isLastTurn === next.isLastTurn
  )
}

const ThreadTurnView = memo(function ThreadTurnView({
  turn,
  models,
  t,
  onCopy,
  userCopied,
  forkEntryId,
  onFork,
  forking,
  run,
  isLastTurn
}: ThreadTurnViewProps) {
  const toolMap = new Map(turn.tools.map((tool) => [tool.toolCallId, tool]))
  const referenced = new Set<string>()
  for (const assistant of turn.assistants) {
    for (const block of assistant.blocks) {
      if (block.type === 'toolCall') referenced.add(block.id)
    }
  }
  // A tool the model called is already on screen through its assistant
  // block; a tool whose call was never seen (a resumed run) is drawn on its
  // own, at the position it was created in.
  const orphanTools = turn.tools.filter((tool) => !referenced.has(tool.toolCallId))
  const lastAssistant = turn.assistants.at(-1)
  const hasFinalReply = lastAssistant?.stopReason !== 'error' &&
    lastAssistant?.blocks.some((block) => block.type === 'text' && block.text.trim()) &&
    !lastAssistant.blocks.some((block) => block.type === 'toolCall')
  const outcome = isLastTurn && run.settled && run.outcome ? run : undefined
  const replyOutcome = outcome?.outcome === 'completed' && hasFinalReply ? outcome : undefined
  const replySettled = lastAssistant && !lastAssistant.streaming && (!isLastTurn || run.settled)
  // The tail stays open only while this turn is the one still being written.
  // A finished turn, including every earlier stretch of a long run, folds.
  const liveTail = isLastTurn && !run.settled
  const turnChanges = useMemo(() => collectChanges(turn.tools), [turn.tools])
  const turnDiffTotals = useMemo(() => {
    let added = 0
    let removed = 0
    for (const change of turnChanges) {
      for (const block of change.diffs) {
        const stats = diffStats(block)
        added += stats.added
        removed += stats.removed
      }
      if (change.kind === 'write' && change.diffs.length === 0 && change.content) {
        added += change.content.split('\n').length
      }
    }
    return { added, removed }
  }, [turnChanges])

  return (
    <section className="turn" data-turn={turn.id}>
      {turn.user ? (
        <UserMessage
          item={turn.user}
          onCopy={onCopy}
          copied={userCopied ? turn.user.id : null}
          forkEntryId={forkEntryId}
          onFork={onFork}
          forking={forking}
        />
      ) : null}

      {turn.assistants.length > 0 || turn.tools.length > 0 || turn.notices.length > 0 || turn.bash.length > 0 ? (
        <div className="assistant">
          <div className="assistant__body">
            {renderTurn(turn, toolMap, replyOutcome, liveTail)}

            {turn.bash.map((item) => (
              <BashCard key={item.id} item={item} />
            ))}

            {orphanTools.length > 0 ? (
              <ProcessTrail
                key="process-orphans"
                tools={orphanTools}
                thoughts={0}
                searchText=""
                live={liveTail && orphanTools.some((tool) => tool.status === 'running')}
              >
                {orphanTools.map((tool) => (
                  <ToolCard key={tool.id} item={tool} presentation="link" />
                ))}
              </ProcessTrail>
            ) : null}

            {turn.notices.map((notice) => (
              <NoticeMessage key={notice.id} item={notice} />
            ))}

            {turnChanges.length > 0 ? (
              <FileChangeSummary
                changes={turnChanges}
                added={turnDiffTotals.added}
                removed={turnDiffTotals.removed}
                onReview={() =>
                  window.dispatchEvent(
                    new CustomEvent<InspectorRequest>('pi:open-inspector', {
                      detail: { tab: 'changes' }
                    })
                  )
                }
              />
            ) : null}

            {outcome && !replyOutcome ? <RunOutcome run={outcome} /> : null}

            {lastAssistant?.stopReason === 'error' &&
            !(isLastTurn && !run.settled && isRateLimitError(lastAssistant.error)) ? (
              <div className="notice" data-level="error" role="alert" title={lastAssistant.error}>
                <CircleAlert size={14} className="notice__icon" />
                <span>
                  {isRateLimitError(lastAssistant.error)
                    ? t('Rate limit reached. This conversation is paused until the limit resets — it was not discarded.')
                    : (lastAssistant.error ?? t('error'))}
                </span>
              </div>
            ) : null}

            {replySettled && (lastAssistant.model || lastAssistant.usage) ? (
              <div className="assistant__response-actions">
                <details className="assistant__details">
                  <summary title={t('Response details')} aria-label={t('Response details')}>
                    <Info size={14} />
                  </summary>
                  <div className="assistant__footer">
                    {lastAssistant.model ? <span>{modelName(models, lastAssistant.model)}</span> : null}
                    {lastAssistant.usage ? (
                      <>
                        <span>{formatTokens(lastAssistant.usage.totalTokens)} {t('tokens')}</span>
                        {lastAssistant.usage.cost ? <span>{formatCost(lastAssistant.usage.cost.total)}</span> : null}
                      </>
                    ) : null}
                    <span>{formatClock(lastAssistant.timestamp)}</span>
                  </div>
                </details>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  )
}, equalThreadTurnViewProps)

interface ProcessBuffer {
  key: string
  tools: ToolItem[]
  thoughts: number
  searchText: string
  children: ReactNode[]
}

type TurnSegment = { kind: 'node'; node: ReactNode } | { kind: 'process'; buffer: ProcessBuffer }

/**
 * Render a whole turn.
 *
 * Spoken text keeps the column. Thinking and tool calls between two stretches
 * of text are one process: open and indented while it is the live tail,
 * collapsed to a single indented line once that stretch has finished. Tools
 * stay grouped inside it until text, thinking or an image interrupts them,
 * even when they span several assistant messages.
 */
function renderTurn(
  turn: Turn,
  toolMap: Map<string, ToolItem>,
  replyOutcome: RunState | undefined,
  liveTail: boolean
): ReactNode[] {
  const segments: TurnSegment[] = []
  let group: ToolItem[] = []
  let trace: ProcessBuffer | null = null
  const lastAssistant = turn.assistants.at(-1)
  let outcomeShown = false

  const ensureProcess = (key: string) => {
    if (!trace) {
      trace = { key, tools: [], thoughts: 0, searchText: '', children: [] }
    }
  }

  const flushTools = () => {
    if (!group.length) return
    const items = group
    group = []
    ensureProcess(`process-${items[0].id}`)
    if (!trace) return
    trace.tools.push(...items)
    // The fold already names the batch. Each call is a link, not another
    // "Activity" row wrapped around a card.
    for (const item of items) {
      trace.children.push(<ToolCard key={item.id} item={item} presentation="link" />)
    }
  }

  const flushProcess = () => {
    flushTools()
    if (!trace || trace.children.length === 0) {
      trace = null
      return
    }
    segments.push({ kind: 'process', buffer: trace })
    trace = null
  }

  for (const assistant of turn.assistants) {
    const lastTextIndex = assistant.blocks.reduce(
      (found, block, index) => (block.type === 'text' ? index : found),
      -1
    )

    assistant.blocks.forEach((block, index) => {
      if (block.type === 'text') {
        if (!block.text.trim()) return
        flushProcess()
        if (replyOutcome && assistant === lastAssistant && !outcomeShown) {
          segments.push({ kind: 'node', node: <RunOutcome key="run-outcome" run={replyOutcome} /> })
          outcomeShown = true
        }
        segments.push({
          kind: 'node',
          node: (
            <AssistantText
              key={`${assistant.id}-${index}`}
              text={block.text}
              streaming={assistant.streaming && index === lastTextIndex}
            />
          )
        })
        return
      }
      if (block.type === 'thinking') {
        if (!block.text.trim()) return
        flushTools()
        ensureProcess(`process-${assistant.id}-${index}`)
        if (!trace) return
        trace.thoughts += 1
        trace.searchText += `\n${block.text}`
        trace.children.push(
          <ThinkingBlock
            key={`${assistant.id}-${index}`}
            text={block.text}
            streaming={assistant.streaming && index === assistant.blocks.length - 1}
          />
        )
        return
      }
      if (block.type === 'image') {
        flushProcess()
        segments.push({
          kind: 'node',
          node: (
            <AssistantImage
              key={`${assistant.id}-${index}`}
              data={block.data}
              mimeType={block.mimeType}
            />
          )
        })
        return
      }
      const tool = toolMap.get(block.id)
      if (!tool) return
      group.push(tool)
    })
  }
  flushProcess()

  return segments.map((segment, index) => {
    if (segment.kind === 'node') return segment.node
    const { buffer } = segment
    return (
      <ProcessTrail
        key={buffer.key}
        tools={buffer.tools}
        thoughts={buffer.thoughts}
        searchText={buffer.searchText}
        live={
          liveTail &&
          (index === segments.length - 1 || buffer.tools.some((tool) => tool.status === 'running'))
        }
      >
        {buffer.children}
      </ProcessTrail>
    )
  })
}
