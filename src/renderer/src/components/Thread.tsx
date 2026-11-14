import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ChevronUp, Database, List, Search, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import type { AssistantItem, ToolItem, UserItem } from '../lib/thread'
import type { Turn } from '../lib/turns'
import { buildTurns, changedTurnsFrom, usageForTurn, userMetadataForTurns } from '../lib/turns'
import { MAX_SEARCH_QUERY_LENGTH } from '@shared/types'
import type { InspectorRequest, ModelInfo } from '@shared/types'
import { collectChanges } from '../lib/changes'
import { formatClock, formatCost, formatExactTokens, formatTokens } from '../lib/format'
import { findMatches, splitSnippet, type SearchableChunk, type SearchHit } from '../lib/search'
import { pairForkTargets } from '../lib/thread'
import { describeTool } from '../lib/tools'
import { modelName } from '../lib/models'
import { scrollBehavior } from '../lib/motion'
import { applyScroll, readScrollMemory, rememberScrollMemory, rememberScrollPosition, scrollTopForTurnTop } from '../lib/scroll-memory'
import { readSessionTiming, userTimingDuration } from '../lib/session-timing'
import { readHistoryFirstVisibleTurn, readProcessOpen, writeHistoryFirstVisibleTurn, writeProcessOpen } from '../lib/view-state'
import { matchesAnyShortcut } from '../lib/shortcuts'
import { SearchContext, useSearchQuery } from '../lib/search-context'
import { NoticeMessage, UserMessage } from './MessageItem'
import { ToolCard, BashCard } from './ToolCard'
import { ProcessTrail } from './ProcessTrail'
import { FileChangeSummary } from './FileChangeSummary'
import { RunStatusRow } from './RunStatusRow'
import { AssistantMessage } from './conversation/AssistantMessage'
import { RunSummary } from './conversation/RunSummary'
import { ErrorNotice, ThreadErrorBanner } from './conversation/ErrorNotice'
import { SessionRail } from './SessionRail'
import { Popover } from './Popover'
import { ErrorBoundary } from './ErrorBoundary'
import { activityOf } from '../lib/activity'
import { useT } from '../lib/i18n'
import { isRateLimitError } from '../lib/provider-error'
import type { RunState } from '../store/useAppStore'
import '../styles/conversation-stream.css'

const VISIBLE_RECENT_TURNS = 3
const MIN_HIDDEN_MESSAGES = 12
const HISTORY_PAGE_TURNS = 20
const SEARCH_INDEX_REFRESH_MS = 120
const MAX_SEARCH_HITS = 50
type SessionTurn = Turn & { user: UserItem }
/** How far from the bottom still counts as "following the output". */
const FOLLOW_RANGE = 80
const EDGE_RANGE = 16
/** Where a chosen turn lands in the reading viewport. */
type TurnJumpAlign = 'center' | 'top'
const searchableChunksByTurn = new WeakMap<Turn, { root?: string; chunks: SearchableChunk[] }>()

type IndexedSearchHit = SearchHit & { turnIndex: number }

interface SearchSnapshot {
  query: string
  sessionKey: string
  root?: string
  turns: Turn[]
  hits: IndexedSearchHit[]
}

interface SearchSource extends Omit<SearchSnapshot, 'hits'> {
  active: boolean
}

function scrollKeyOf(sessionFile: string | undefined): string {
  return sessionFile ?? 'draft'
}

/** The text of a turn that the search bar looks through. */
function searchableChunks(turns: Turn[], root?: string): SearchableChunk[] {
  const chunks: SearchableChunk[] = []
  for (const turn of turns) {
    const cached = searchableChunksByTurn.get(turn)
    if (cached && cached.root === root) {
      for (const chunk of cached.chunks) chunks.push(chunk)
      continue
    }
    const turnChunks: SearchableChunk[] = []
    if (turn.user?.text.trim()) {
      turnChunks.push({
        turnId: turn.id,
        messageId: turn.user.id,
        source: 'You',
        text: turn.user.text
      })
    }
    for (const assistant of turn.assistants) {
      for (const block of assistant.blocks) {
        if (block.type === 'text' && block.text.trim()) {
          turnChunks.push({ turnId: turn.id, messageId: assistant.id, source: 'Pi', text: block.text })
        }
      }
    }
    for (const tool of turn.tools) {
      // The arguments of a tool carry whole files, so only the one-line
      // summary of the call goes into the index. Otherwise every word of
      // every edited file turns into a search hit.
      const label = describeTool(tool.toolName).summary(tool.args ?? {}, root)
      turnChunks.push({
        turnId: turn.id,
        messageId: tool.id,
        source: 'Tool',
        text: `${tool.toolName} ${label}`
      })
    }
    searchableChunksByTurn.set(turn, { root, chunks: turnChunks })
    for (const chunk of turnChunks) chunks.push(chunk)
  }
  return chunks
}

function searchQueryKey(query: string): string {
  return query.trim().toLowerCase()
}

function matchesSearchContext(
  context: Pick<SearchSnapshot, 'query' | 'sessionKey' | 'root'> | null,
  sessionKey: string,
  root: string | undefined,
  query: string
): boolean {
  return context?.sessionKey === sessionKey && context.root === root && context.query === searchQueryKey(query)
}

/** Reuse hits from untouched turns and scan only the changed suffix. */
function buildSearchSnapshot(
  turns: Turn[],
  query: string,
  root: string | undefined,
  sessionKey: string,
  previous: SearchSnapshot | null
): SearchSnapshot {
  const queryKey = searchQueryKey(query)
  const sameContext = matchesSearchContext(previous, sessionKey, root, query)
  const reusable = sameContext ? previous : null
  if (reusable?.turns === turns) return reusable

  let firstChangedTurn = 0
  if (reusable) {
    const sharedLength = Math.min(turns.length, reusable.turns.length)
    while (firstChangedTurn < sharedLength && turns[firstChangedTurn] === reusable.turns[firstChangedTurn]) {
      firstChangedTurn += 1
    }
  }
  const hits = reusable
    ? reusable.hits.filter((hit) => hit.turnIndex < firstChangedTurn)
    : []

  for (let index = firstChangedTurn; index < turns.length && hits.length < MAX_SEARCH_HITS; index += 1) {
    const turnHits = findMatches(
      searchableChunks([turns[index]], root),
      query,
      MAX_SEARCH_HITS - hits.length
    )
    for (const hit of turnHits) hits.push({ ...hit, turnIndex: index })
  }

  return { query: queryKey, sessionKey, root, turns, hits }
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
  const retry = useAppStore((state) => state.retry)
  const stop = useAppStore((state) => state.stop)
  /**
   * Whether runtime work is open, as opposed to whether Pi has started streaming.
   *
   * A prompt handed to a settled runtime is `queued` before any event
   * arrives, so `isStreaming` alone would hide the row for exactly the moment
   * the reader most wants to know what happened to their message. Manual
   * compaction is also work even though it does not stream an assistant reply.
   */
  const runOpen = isStreaming || Boolean(run.compaction) || (run.phase !== 'idle' && !run.settled)
  const workspace = useAppStore((state) => state.workspace)
  const activeSessionFile = useAppStore((state) => state.activeSessionFile)
  const historyLoading = useAppStore(
    (state) => Boolean(state.activeSessionFile && state.hydratingSessionFile === state.activeSessionFile)
  )
  const draftId = useAppStore((state) => state.draftId)
  const models = useAppStore((state) => state.models)
  const forkTargets = useAppStore((state) => state.forkTargets)
  const forkFrom = useAppStore((state) => state.forkFrom)
  const t = useT()
  const forking = useAppStore((state) => state.forking)
  const error = useAppStore((state) => state.error)
  const dismissError = useAppStore((state) => state.dismissError)
  const shortcutBindings = useAppStore((state) => state.settings.shortcutBindings)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const previousItemsRef = useRef(items)
  // A conversation keeps its own reading position even before Pi has written
  // its first file: draft ids are unique, and a draft becomes a file path
  // when the runtime rekeys it.
  const sessionKey = scrollKeyOf(activeSessionFile ?? draftId)
  const runDurationsMs = useMemo(
    () => readSessionTiming(sessionKey).runDurationsMs,
    [sessionKey, items.length, run.durationMs]
  )
  const previousScrollKeyRef = useRef(sessionKey)
  /** A conversation switch that still has to place the viewport. */
  const pendingRestoreRef = useRef<string | null>(sessionKey)
  if (previousScrollKeyRef.current !== sessionKey) {
    previousScrollKeyRef.current = sessionKey
    pendingRestoreRef.current = sessionKey
  }
  const [atBottom, setAtBottom] = useState(true)
  const [atTop, setAtTop] = useState(true)
  const [scrollDirection, setScrollDirection] = useState<'up' | 'down' | null>(null)
  const previousScrollTopRef = useRef<number | null>(null)
  /** One active-turn measurement per frame, not one per scroll event. */
  const activeSyncFrameRef = useRef(0)
  const [scrolledTurnId, setScrolledTurnId] = useState<string | null>(null)
  const [, setHistoryViewVersion] = useState(0)
  /**
   * A jump that has to wait for the history fold to open. `align` decides what
   * "reached the turn" means: a rail pick reads forward from its own prompt, so
   * the prompt goes to the top; a search hit stays centred around the match.
   */
  const pendingTurnJumpRef = useRef<{ turnId: string; align: TurnJumpAlign } | null>(null)
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
  const userMetadata = userMetadataForTurns(turns)
  const userTimestampCounts = userMetadata.timestampCounts
  const sessionTurnsCacheRef = useRef<{
    sessionKey: string
    turns: Turn[]
    userCount: number
    value: SessionTurn[]
  } | null>(null)
  const cachedSessionTurns = sessionTurnsCacheRef.current
  let sessionTurns: SessionTurn[]
  if (
    !cachedSessionTurns ||
    cachedSessionTurns.sessionKey !== sessionKey ||
    cachedSessionTurns.userCount !== userMetadata.userCount
  ) {
    sessionTurns = turns.filter((turn): turn is SessionTurn => Boolean(turn.user))
  } else if (cachedSessionTurns.turns === turns) {
    sessionTurns = cachedSessionTurns.value
  } else {
    const firstChangedTurn = changedTurnsFrom(turns, cachedSessionTurns.turns)
    sessionTurns = firstChangedTurn !== undefined && firstChangedTurn >= turns.length - 1
      ? cachedSessionTurns.value
      : turns.filter((turn): turn is SessionTurn => Boolean(turn.user))
  }
  sessionTurnsCacheRef.current = {
    sessionKey,
    turns,
    userCount: userMetadata.userCount,
    value: sessionTurns
  }
  // Callbacks that only look a turn up must not change identity on every
  // streamed delta; they read the latest turns through this ref instead.
  const turnsRef = useRef(turns)
  turnsRef.current = turns
  const lastSessionTurn = userMetadata.lastUserTurnIndex >= 0
    ? turns[userMetadata.lastUserTurnIndex] as SessionTurn
    : undefined
  const liveRunSummaryAtTop = Boolean(
    !run.settled &&
      run.startedAt !== undefined &&
      sessionTurns.length > 0
  )
  const lastSessionTurnId = sessionTurns.at(-1)?.id ?? null
  const activeTurnId = atBottom ? lastSessionTurnId : scrolledTurnId
  const syncActiveTurn = useCallback((container: HTMLDivElement) => {
    const visibleTurns = container.querySelectorAll<HTMLElement>('[data-turn][data-session-turn]')
    let activeTurn: HTMLElement | undefined
    const threshold = container.getBoundingClientRect().top + 96
    for (const turn of visibleTurns) {
      if (!activeTurn) activeTurn = turn
      if (turn.getBoundingClientRect().top <= threshold) activeTurn = turn
      else break
    }
    setScrolledTurnId(activeTurn?.dataset.turn ?? null)
  }, [])
  const hiddenTurnCount = Math.max(0, turns.length - VISIBLE_RECENT_TURNS)
  const hiddenMessageCountRef = useRef<{
    sessionKey: string
    firstHiddenTurn: number
    turns: Turn[]
    count: number
  } | null>(null)
  const messagesBeforeTurn = (firstHiddenTurn: number): number => {
    const cached = hiddenMessageCountRef.current
    if (
      cached &&
      cached.sessionKey === sessionKey &&
      cached.firstHiddenTurn === firstHiddenTurn &&
      (cached.turns === turns || firstHiddenTurn === 0 ||
        (changedTurnsFrom(turns, cached.turns) ?? -1) >= firstHiddenTurn)
    ) {
      cached.turns = turns
      return cached.count
    }
    const count = turns
      .slice(0, firstHiddenTurn)
      .reduce((total, turn) => total + Number(Boolean(turn.user)) + turn.assistants.length, 0)
    hiddenMessageCountRef.current = { sessionKey, firstHiddenTurn, turns, count }
    return count
  }
  const savedHistoryStart = readHistoryFirstVisibleTurn(sessionKey)
  let firstVisibleTurn: number
  if (savedHistoryStart === undefined) {
    firstVisibleTurn = messagesBeforeTurn(hiddenTurnCount) >= MIN_HIDDEN_MESSAGES
      ? hiddenTurnCount
      : 0
  } else {
    firstVisibleTurn = Math.min(savedHistoryStart, hiddenTurnCount)
  }
  const historyCollapsed = firstVisibleTurn > 0
  const hiddenMessageCount = historyCollapsed ? messagesBeforeTurn(firstVisibleTurn) : 0
  const visibleTurns = historyCollapsed ? turns.slice(firstVisibleTurn) : turns
  const revealOlderHistory = useCallback(() => {
    if (firstVisibleTurn === 0) return
    writeHistoryFirstVisibleTurn(sessionKey, Math.max(0, firstVisibleTurn - HISTORY_PAGE_TURNS))
    setHistoryViewVersion((version) => version + 1)
  }, [firstVisibleTurn, sessionKey])
  const expandHistory = useCallback(() => {
    writeHistoryFirstVisibleTurn(sessionKey, 0)
    setHistoryViewVersion((version) => version + 1)
  }, [sessionKey])
  const visibleUserCount = firstVisibleTurn > 0
    ? visibleTurns.reduce((count, turn) => count + Number(Boolean(turn.user)), 0)
    : userMetadata.userCount
  let visibleUserOrdinal = firstVisibleTurn > 0
    ? userMetadata.userCount - visibleUserCount
    : 0
  const hasSearchQuery = searchOpen && Boolean(query.trim())
  const searchRoot = workspace?.path
  const latestSearchSourceRef = useRef<SearchSource>({
    turns,
    root: searchRoot,
    sessionKey,
    query,
    active: hasSearchQuery
  })
  latestSearchSourceRef.current = { turns, root: searchRoot, sessionKey, query, active: hasSearchQuery }
  const searchSnapshotRef = useRef<SearchSnapshot | null>(null)
  const scheduledSearchContextRef = useRef<Pick<SearchSnapshot, 'query' | 'sessionKey' | 'root'> | null>(null)
  const searchRefreshTimerRef = useRef<number | null>(null)
  const [searchRefreshVersion, setSearchRefreshVersion] = useState(0)
  const hits: SearchHit[] = useMemo(() => {
    if (!hasSearchQuery) return []
    const previous = searchSnapshotRef.current
    if (previous && matchesSearchContext(previous, sessionKey, searchRoot, query) && previous.turns !== turns) {
      return previous.hits
    }
    const next = buildSearchSnapshot(turns, query, searchRoot, sessionKey, previous)
    searchSnapshotRef.current = next
    return next.hits
  }, [hasSearchQuery, query, sessionKey, searchRoot, turns, searchRefreshVersion])

  useEffect(() => {
    if (!hasSearchQuery) {
      if (searchRefreshTimerRef.current !== null) {
        window.clearTimeout(searchRefreshTimerRef.current)
        searchRefreshTimerRef.current = null
      }
      scheduledSearchContextRef.current = null
      searchSnapshotRef.current = null
      return
    }

    if (
      searchRefreshTimerRef.current !== null &&
      !matchesSearchContext(scheduledSearchContextRef.current, sessionKey, searchRoot, query)
    ) {
      window.clearTimeout(searchRefreshTimerRef.current)
      searchRefreshTimerRef.current = null
      scheduledSearchContextRef.current = null
    }

    const snapshot = searchSnapshotRef.current
    if (snapshot && matchesSearchContext(snapshot, sessionKey, searchRoot, query) && snapshot.turns === turns) {
      if (searchRefreshTimerRef.current !== null) {
        window.clearTimeout(searchRefreshTimerRef.current)
        searchRefreshTimerRef.current = null
        scheduledSearchContextRef.current = null
      }
      return
    }
    if (searchRefreshTimerRef.current !== null) return

    scheduledSearchContextRef.current = { query: searchQueryKey(query), sessionKey, root: searchRoot }
    searchRefreshTimerRef.current = window.setTimeout(() => {
      searchRefreshTimerRef.current = null
      scheduledSearchContextRef.current = null
      const latest = latestSearchSourceRef.current
      if (!latest.active) return
      const previous = searchSnapshotRef.current
      const next = buildSearchSnapshot(latest.turns, latest.query, latest.root, latest.sessionKey, previous)
      if (next === previous) return
      searchSnapshotRef.current = next
      setSearchRefreshVersion((version) => version + 1)
    }, SEARCH_INDEX_REFRESH_MS)
  }, [hasSearchQuery, query, sessionKey, searchRoot, turns])
  useEffect(() => {
    return () => {
      if (searchRefreshTimerRef.current !== null) {
        window.clearTimeout(searchRefreshTimerRef.current)
        searchRefreshTimerRef.current = null
      }
      scheduledSearchContextRef.current = null
    }
  }, [])
  const forkByUserId = useMemo(
    () => pairForkTargets(items, forkTargets),
    [sessionKey, turns.length, forkTargets]
  )

  useEffect(() => {
    if (hits.length === 0) setSearchResultsOpen(false)
  }, [hits.length])

  /**
   * What Pi is doing right now.
   *
   * Derived from the run state and from the tool call that is actually
   * executing — not from the last tool in the list, which may have finished
   * a while ago. This is the fallback when no live turn summary is available.
   */
  const activity = useMemo(() => {
    const last = turns[turns.length - 1]
    if (!last) return undefined
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
    return tool ? activityOf(tool) : undefined
  }, [turns])

  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const itemsChanged = previousItemsRef.current !== items
    previousItemsRef.current = items

    // A conversation switch has priority over following the live edge: put
    // the reader back where they left that conversation, or at the bottom
    // when it is the first visit. If the transcript is still hydrating, the
    // restore waits for the first items instead of anchoring to an empty box.
    const restoreKey = pendingRestoreRef.current
    if (restoreKey) {
      setScrollDirection(null)
      if (items.length === 0) return
      pendingRestoreRef.current = null
      const entry = readScrollMemory(restoreKey)
      if (!entry && historyCollapsed) {
        // A long replayed conversation opens at its tail, not halfway up a
        // collapse control.
        node.scrollTo({ top: 0, behavior: 'instant' })
        const nearBottom = node.scrollHeight - node.clientHeight < FOLLOW_RANGE
        stickRef.current = nearBottom
        setAtBottom(node.scrollHeight - node.clientHeight <= EDGE_RANGE)
        setAtTop(node.scrollTop <= EDGE_RANGE)
        syncActiveTurn(node)
        return
      }
      const restored = applyScroll(node, entry, FOLLOW_RANGE)
      const distanceToBottom = node.scrollHeight - restored.top - node.clientHeight
      stickRef.current = restored.stick
      setAtBottom(distanceToBottom <= EDGE_RANGE)
      setAtTop(restored.top <= EDGE_RANGE)
      node.scrollTo({ top: restored.top, behavior: 'instant' })
      syncActiveTurn(node)
      return
    }

    if (!itemsChanged || !stickRef.current || items.length === 0) return
    node.scrollTo({ top: node.scrollHeight, behavior: 'instant' })
    // While following the live edge the active turn is the last one by
    // definition; measuring every visible turn on every streamed delta is
    // wasted layout work.
  }, [items, historyCollapsed, sessionKey, syncActiveTurn])

  // A reader who scrolls up is reading, not watching: the follow stops and
  // only a click brings it back. The window is generous enough that a
  // half-line of layout does not switch the mode. Every scroll also records
  // the position for the conversation it belongs to.
  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    previousScrollTopRef.current = node.scrollTop
    const scheduleActiveSync = () => {
      if (activeSyncFrameRef.current !== 0) return
      activeSyncFrameRef.current = requestAnimationFrame(() => {
        activeSyncFrameRef.current = 0
        syncActiveTurn(node)
      })
    }
    const onScroll = () => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight
      const previousScrollTop = previousScrollTopRef.current
      if (previousScrollTop !== null && node.scrollTop !== previousScrollTop) {
        setScrollDirection(node.scrollTop < previousScrollTop ? 'up' : 'down')
      }
      previousScrollTopRef.current = node.scrollTop
      stickRef.current = distance < FOLLOW_RANGE
      setAtBottom(distance <= EDGE_RANGE)
      setAtTop(node.scrollTop <= EDGE_RANGE)
      rememberScrollMemory(sessionKey, node, FOLLOW_RANGE)
      // At the live edge the active turn is the last one by definition; the
      // follow itself fires scroll events on every streamed delta, and
      // measuring every mounted turn there would be layout work no reader
      // sees. Off the edge, one measurement per frame is enough.
      if (distance > EDGE_RANGE) scheduleActiveSync()
    }
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      node.removeEventListener('scroll', onScroll)
      if (activeSyncFrameRef.current !== 0) {
        cancelAnimationFrame(activeSyncFrameRef.current)
        activeSyncFrameRef.current = 0
      }
    }
  }, [sessionKey, syncActiveTurn])

  // The composer is a sibling, so growing it reduces the transcript's
  // client height without a scroll event. A reader who is following must
  // stay pinned to the newest row instead of being left behind the box.
  useEffect(() => {
    const node = scrollRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (stickRef.current) node.scrollTop = node.scrollHeight
      setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight <= EDGE_RANGE)
      setAtTop(node.scrollTop <= EDGE_RANGE)
    })
    observer.observe(node)
    const content = node.querySelector('.thread__inner')
    if (content) observer.observe(content)
    return () => observer.disconnect()
  }, [])

  // `Ctrl+F` searches the conversation, the way every other editor does.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return
      if (matchesAnyShortcut(event, 'search-conversation', shortcutBindings)) {
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
  }, [searchOpen, closeSearch, shortcutBindings])

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

  /** A short highlight so the eye lands where the jump put it. */
  const flashTurn = useCallback((node: HTMLElement) => {
    node.classList.remove('turn--flash')
    // Force a reflow so the animation can run again on the same turn.
    void node.offsetWidth
    node.classList.add('turn--flash')
    window.setTimeout(() => node.classList.remove('turn--flash'), 1400)
  }, [])

  /**
   * Put a turn where its reader asked for it. A rail pick reads forward from
   * the prompt it picked, so the prompt becomes the top of the viewport; a
   * search hit stays centred, because the match can sit anywhere in the turn.
   */
  const placeTurn = useCallback((node: HTMLElement, align: TurnJumpAlign) => {
    const container = scrollRef.current
    if (!container) return
    if (align === 'center') {
      node.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
      return
    }
    const stickySearch = container.querySelector<HTMLElement>('.thread-search')
    const turnTop =
      node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
    container.scrollTo({
      top: scrollTopForTurnTop(container, turnTop, stickySearch?.offsetHeight ?? 0),
      behavior: scrollBehavior()
    })
  }, [])

  const jumpToTurn = useCallback(
    (turnId: string, align: TurnJumpAlign = 'center') => {
      const turnIndex = turnsRef.current.findIndex((turn) => turn.id === turnId)
      if (turnIndex < 0) return
      if (turnIndex < firstVisibleTurn) {
        pendingTurnJumpRef.current = { turnId, align }
        expandHistory()
        return
      }
      const node = scrollRef.current?.querySelector<HTMLElement>(`[data-turn="${turnId}"]`)
      if (!node) return
      stickRef.current = false
      setAtBottom(false)
      placeTurn(node, align)
      flashTurn(node)
    },
    [firstVisibleTurn, expandHistory, placeTurn, flashTurn]
  )

  /** A rail tick is a prompt, so its click reads from that prompt downward. */
  const jumpToTurnTop = useCallback(
    (turnId: string) => jumpToTurn(turnId, 'top'),
    [jumpToTurn]
  )

  const jumpToHit = useCallback(
    (hit: SearchHit | undefined) => {
      if (!hit) return
      jumpToTurn(hit.turnId)
    },
    [jumpToTurn]
  )

  useLayoutEffect(() => {
    const jump = pendingTurnJumpRef.current
    if (!jump || firstVisibleTurn > 0) return
    const node = scrollRef.current?.querySelector<HTMLElement>(`[data-turn="${jump.turnId}"]`)
    if (!node) return
    pendingTurnJumpRef.current = null
    stickRef.current = false
    setAtBottom(false)
    placeTurn(node, jump.align)
    flashTurn(node)
  }, [firstVisibleTurn, turns, placeTurn, flashTurn])

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
          pendingTurnJumpRef.current = { turnId: previous.id, align: 'top' }
          expandHistory()
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
  }, [firstVisibleTurn, expandHistory, turns])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return
      if (matchesAnyShortcut(event, 'previous-turn', shortcutBindings)) {
        event.preventDefault()
        jumpTurn(-1)
        return
      }
      if (matchesAnyShortcut(event, 'next-turn', shortcutBindings)) {
        event.preventDefault()
        jumpTurn(1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [jumpTurn, shortcutBindings])

  const scrollToBottom = () => {
    const node = scrollRef.current
    if (!node) return
    stickRef.current = true
    node.scrollTo({ top: node.scrollHeight, behavior: scrollBehavior() })
    rememberScrollPosition(sessionKey, { top: node.scrollHeight, atBottom: true })
  }

  const scrollToTop = () => {
    const node = scrollRef.current
    if (!node) return
    stickRef.current = false
    node.scrollTo({ top: 0, behavior: scrollBehavior() })
    rememberScrollPosition(sessionKey, { top: 0, atBottom: false })
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
      if (hidden) expandHistory()
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
      pendingTurnJumpRef.current = { turnId, align: 'center' }
      expandHistory()
    }
    consumeJump()
  }, [pendingJump, activeSessionFile, expandHistory, items, turns, firstVisibleTurn, workspace?.path, query, consumeJump, showToast])

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

  const jumpTarget =
    atTop && atBottom
      ? null
      : atBottom
        ? 'top'
        : atTop
          ? 'bottom'
          : scrollDirection === 'up'
            ? 'top'
            : scrollDirection === 'down'
              ? 'bottom'
              : null

  return (
    <div className="thread-frame">
    {sessionTurns.length > 1 ? (
      <SessionRail
        key={sessionKey}
        turns={sessionTurns}
        activeTurn={lastSessionTurn!}
        activeTurnId={activeTurnId}
        onSelect={jumpToTurnTop}
      />
    ) : null}
    <div className="thread" ref={scrollRef}>
      {searchOpen ? (
        <div className="thread-search">
          <div className="thread-search__bar">
            <Search size={13} />
            <input
              ref={searchInputRef}
              value={query}
              maxLength={MAX_SEARCH_QUERY_LENGTH}
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

      <div
        className="thread__inner"
        data-history-collapsed={historyCollapsed}
        data-history-loading={historyLoading && items.length === 0 ? 'true' : undefined}
      >
        {historyLoading && items.length === 0 ? (
          <div className="thread__loading" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            {t('Loading conversation history…')}
          </div>
        ) : null}

        {historyCollapsed ? (
          <div className="thread__history">
            <button
              type="button"
              aria-expanded={false}
              aria-label={t(`Up ${hiddenMessageCount} messages`)}
              onClick={revealOlderHistory}
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
            const userOrdinal = turn.user ? visibleUserOrdinal++ : undefined
            const isLastTurn = turnIndex === turns.length - 1
            return (
              <ErrorBoundary key={`${sessionKey}:${turn.id}`} scope="turn">
                <ThreadTurnView
                  turn={turn}
                  threadKey={sessionKey}
                  models={models}
                  t={t}
                  onCopy={copy}
                  userCopied={copied === userId}
                  forkEntryId={userId ? forkByUserId.get(userId) : undefined}
                  onFork={forkFrom}
                  forking={Boolean(userId && forkByUserId.has(userId) && forking)}
                  run={run}
                  runDurationMs={
                    turn.user
                      ? userTimingDuration(
                        runDurationsMs,
                        turn.user.timestamp,
                        userOrdinal,
                        userTimestampCounts.get(turn.user.timestamp) ?? 0
                      )
                      : undefined
                  }
                  isLastTurn={isLastTurn}
                />
              </ErrorBoundary>
            )
          })}
        </SearchContext.Provider>

        {runOpen ? (
          <RunStatusRow
            run={run}
            transport={transport}
            retry={retry}
            onStopRetry={stop}
            activity={activity}
            showElapsed={!liveRunSummaryAtTop}
            hideRoutineStatus={liveRunSummaryAtTop}
          />
        ) : null}

        {error ? <ThreadErrorBanner message={error} onDismiss={dismissError} /> : null}
      </div>

    </div>
      {jumpTarget ? (
        <div className="scroll-jumps">
          <button
            type="button"
            className="scroll-jump"
            onClick={jumpTarget === 'top' ? scrollToTop : scrollToBottom}
            title={t(jumpTarget === 'top' ? 'Scroll to the top' : 'Scroll to the latest')}
            aria-label={t(jumpTarget === 'top' ? 'Scroll to the top' : 'Scroll to the latest')}
          >
            {jumpTarget === 'top' ? <ArrowUp size={15} /> : <ArrowDown size={15} />}
          </button>
        </div>
      ) : null}
    </div>
  )
}

interface ThreadTurnViewProps {
  turn: Turn
  threadKey: string
  models: ModelInfo[]
  t: (text: string) => string
  onCopy: (id: string, text: string) => void
  userCopied: boolean
  forkEntryId?: string
  onFork: (entryId: string) => void
  forking: boolean
  run: RunState
  runDurationMs?: number
  /** The turn that is last in the conversation, where a run summary belongs. */
  isLastTurn: boolean
}

function sameReferences<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

/**
 * The elapsed time of a finished turn that has no live client sample.
 *
 * A conversation reopened from disk has no run state, and older client timing
 * records were dropped when they moved to a monotonic clock. Pi still records
 * a timestamp on every message and the generation duration on each answer, so
 * the end of the final answer can be reconstructed from the transcript: the
 * summary then says "Worked for 32m 3s" instead of only "Finished".
 */
function turnElapsedMs(turn: Turn): number | undefined {
  const start = turn.user?.timestamp
  if (start === undefined) return undefined
  let end = start
  for (const assistant of turn.assistants) {
    const finished = assistant.timestamp + (assistant.durationMs ?? 0)
    if (finished > end) end = finished
  }
  for (const tool of turn.tools) {
    const finished = tool.finishedAt ?? tool.timestamp
    if (finished > end) end = finished
  }
  return end > start ? end - start : undefined
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
  if (previous.isLastTurn !== next.isLastTurn) return false
  if (next.isLastTurn && previous.run !== next.run) return false

  return (
    sameTurnContent(previous.turn, next.turn) &&
    previous.threadKey === next.threadKey &&
    previous.models === next.models &&
    previous.t === next.t &&
    previous.onCopy === next.onCopy &&
    previous.userCopied === next.userCopied &&
    previous.forkEntryId === next.forkEntryId &&
    previous.onFork === next.onFork &&
    previous.forking === next.forking &&
    previous.runDurationMs === next.runDurationMs
  )
}

const ThreadTurnView = memo(function ThreadTurnView({
  turn,
  threadKey,
  models,
  t,
  onCopy,
  userCopied,
  forkEntryId,
  onFork,
  forking,
  run,
  runDurationMs,
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
  const turnUsage = usageForTurn(turn)
  const incompleteTokenUsage = turn.assistants.some((assistant) => !assistant.usage)
  const incompleteCost = turn.assistants.some((assistant) => !assistant.usage?.cost)
  const liveOutcome = Boolean(
    isLastTurn &&
      !run.settled &&
      run.startedAt !== undefined
  )
  const recordedOutcome = lastAssistant?.stopReason === 'stop'
    ? 'completed'
    : lastAssistant?.stopReason === 'error'
      ? 'failed'
      : lastAssistant?.stopReason === 'aborted'
        ? 'aborted'
        : undefined
  // A live run carries its own monotonic duration. Once it has settled — or
  // when the turn comes from a reopened session — fall back to the duration
  // the transcript itself can prove.
  const settledDurationMs = runDurationMs ?? turnElapsedMs(turn)
  const outcome: RunState | undefined =
    liveOutcome
      ? run
      : isLastTurn && run.settled && run.outcome
        ? { ...run, durationMs: run.durationMs ?? settledDurationMs }
        : settledDurationMs !== undefined || recordedOutcome
          ? {
              ...run,
              phase: 'idle',
              settled: true,
              outcome: recordedOutcome ?? 'completed',
              durationMs: settledDurationMs
            }
          : undefined
  const replySettled = lastAssistant && !lastAssistant.streaming && (!isLastTurn || run.settled)
  // The tail stays open only while this turn is the one still being written.
  // A finished turn, including every earlier stretch of a long run, folds.
  const liveTail = isLastTurn && !run.settled
  const autoFoldProcess = useAppStore((state) => state.settings.autoFoldProcess !== false)
  const processId = `turn-${turn.id}`
  const [manualProcessOpen, setManualProcessOpen] = useState(() => readProcessOpen(threadKey, processId))
  const query = useSearchQuery().trim().toLowerCase()
  const searchMatch = Boolean(query) && findMatches(searchableChunks([turn]), query, 1).length > 0
  const processOpen = searchMatch || (manualProcessOpen ?? !autoFoldProcess)
  const toggleProcess = () => {
    const next = !processOpen
    setManualProcessOpen(next)
    writeProcessOpen(threadKey, processId, next)
  }
  const hasProcess = useMemo(
    () =>
      turn.tools.length > 0 ||
      // Retry, compaction and other stream notices are part of the process,
      // not part of the answer. They fold with the tools so a settled turn does
      // not leave a stack of "retry succeeded" lines outside the fold.
      turn.notices.length > 0 ||
      turn.assistants.some((assistant) =>
        assistant.blocks.some((block) => block.type === 'thinking')
      ),
    [turn.tools, turn.notices, turn.assistants]
  )
  // A completed turn follows the reader's fold setting; a live, failed or
  // stopped turn must keep its process visible, because hiding it there would
  // hide the only evidence of what happened.
  const processVisible =
    liveTail || !outcome || outcome.outcome !== 'completed' || processOpen
  // The closing card is not painted while the run is live, so there is no
  // reason to build every file diff on every streamed pixel.
  const turnChanges = useMemo(
    () => (liveTail ? [] : collectChanges(turn.tools)),
    [liveTail, turn.tools]
  )

  return (
    <section className="turn" data-turn={turn.id} data-session-turn={turn.user ? '' : undefined}>
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

      {turn.assistants.length > 0 ||
      turn.tools.length > 0 ||
      turn.notices.length > 0 ||
      turn.bash.length > 0 ||
      liveOutcome ? (
        <div className="assistant">
          <div className="assistant__body">
            {outcome ? (
              <RunSummary
                run={outcome}
                foldable={hasProcess}
                open={processOpen}
                onToggle={toggleProcess}
              />
            ) : null}
            <AssistantMessage
              turn={turn}
              toolMap={toolMap}
              liveTail={liveTail}
              processOpen={processVisible}
              processExpanded={Boolean(outcome?.settled && processOpen)}
            />

            {turn.bash.map((item) => (
              <BashCard key={item.id} item={item} />
            ))}

            {orphanTools.length > 0 && processVisible ? (
              <ProcessTrail
                key="process-orphans"
                tools={orphanTools}
                thoughts={0}
                searchText=""
                defaultOpen={Boolean(outcome?.settled && processOpen)}
                live={liveTail && orphanTools.some((tool) => tool.status === 'running')}
              >
                {orphanTools.map((tool) => (
                  <ToolCard key={tool.id} item={tool} presentation="link" />
                ))}
              </ProcessTrail>
            ) : null}

            {processVisible
              ? turn.notices
                  .filter((notice) => notice.status !== 'compacting')
                  .map((notice) => <NoticeMessage key={notice.id} item={notice} />)
              : null}
            {turnChanges.length > 0 && !liveTail ? (
              <FileChangeSummary
                changes={turnChanges}
                onReview={() =>
                  window.dispatchEvent(
                    new CustomEvent<InspectorRequest>('pi:open-inspector', {
                      detail: { tab: 'changes' }
                    })
                  )
                }
              />
            ) : null}

            {lastAssistant?.stopReason === 'error' &&
            !(isLastTurn && (run.outcome === 'aborted' || (!run.settled && isRateLimitError(lastAssistant.error)))) ? (
              <ErrorNotice
                title={lastAssistant.error}
                message={
                  isRateLimitError(lastAssistant.error)
                    ? t('Rate limit reached. This conversation is paused until the limit resets — it was not discarded.')
                    : (lastAssistant.error ?? t('error'))
                }
              />
            ) : null}

            {replySettled &&
            lastAssistant &&
            lastAssistant.stopReason !== 'error' &&
            (lastAssistant.model || turnUsage || incompleteTokenUsage) ? (
              <div className="assistant__response-actions">
                <div className="assistant__footer">
                  {lastAssistant.model ? <span>{modelName(models, lastAssistant.model)}</span> : null}
                  {turnUsage ? (
                    <Popover
                      trigger="hover"
                      placement="top"
                      align="left"
                      width={340}
                      className="usage-popover"
                      renderTrigger={({ toggle }) => (
                        <button
                          type="button"
                          className="assistant__usage"
                          onClick={toggle}
                          aria-label={t('Turn usage')}
                        >
                          {formatTokens(turnUsage.totalTokens)} {t('tokens')}
                        </button>
                      )}
                    >
                      {() => {
                        const usage = turnUsage
                        const cost = usage?.cost?.total
                        // Cache reads are measured against every prompt token:
                        // fresh input, cache reads and cache writes — the same
                        // base session-metrics.ts uses for the session reading.
                        const hitBase =
                          (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0)
                        const cacheHit = hitBase > 0
                          ? `${(((usage?.cacheRead ?? 0) / hitBase) * 100).toFixed(1)}%`
                          : null
                        const model = lastAssistant.model
                          ? modelName(models, lastAssistant.model)
                          : ''
                        return (
                          <div className="usage-popover__body">
                            <div className="usage-panel">
                              <div className="usage-panel__rows" role="group" aria-label={t('Turn usage')}>
                                <div className="usage-panel__row usage-panel__row--strong">
                                  <span className="usage-panel__title">
                                    <Database size={14} aria-hidden="true" />
                                    {t('Turn usage')}
                                  </span>
                                  <span>
                                    <strong>{usage?.totalTokens.toLocaleString() ?? '—'}</strong> tok
                                  </span>
                                </div>
                                {model ? (
                                  <div className="usage-panel__row">
                                    <span>{t('Provider / model')}</span>
                                    <span className="usage-panel__route" title={model}>{model}</span>
                                  </div>
                                ) : null}
                                {cacheHit ? (
                                  <div className="usage-panel__row">
                                    <span>{t('Cache hit')}</span>
                                    <span>{cacheHit}</span>
                                  </div>
                                ) : null}
                                <div className="usage-panel__row">
                                  <span>{t('Uncached input')}</span>
                                  <span>{formatExactTokens(usage?.input)}</span>
                                </div>
                                <div className="usage-panel__row">
                                  <span>{t('Cache read')}</span>
                                  <span>{formatExactTokens(usage?.cacheRead)}</span>
                                </div>
                                {usage?.cacheWrite ? (
                                  <div className="usage-panel__row">
                                    <span>{t('Cache write')}</span>
                                    <span>{formatExactTokens(usage.cacheWrite)}</span>
                                  </div>
                                ) : null}
                                <div className="usage-panel__row">
                                  <span>{t('Output')}</span>
                                  <span>{formatExactTokens(usage?.output)}</span>
                                </div>
                                {cost ? (
                                  <div className="usage-panel__row">
                                    <span>{t('Cost')}</span>
                                    <span>{formatCost(cost)}</span>
                                  </div>
                                ) : incompleteCost ? (
                                  <div
                                    className="usage-panel__row"
                                    title={t('Not all model requests reported cost.')}
                                  >
                                    <span>{t('Cost')}</span>
                                    <span>—</span>
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        )
                      }}
                    </Popover>
                  ) : incompleteTokenUsage ? (
                    <span
                      className="assistant__usage"
                      title={t('Not all model requests reported token usage.')}
                    >
                      — {t('tokens')}
                    </span>
                  ) : null}
                  <span>{formatClock(lastAssistant.timestamp)}</span>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  )
}, equalThreadTurnViewProps)
