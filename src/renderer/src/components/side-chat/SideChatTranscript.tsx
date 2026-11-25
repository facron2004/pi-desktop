import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Database, Ellipsis, Search, X } from 'lucide-react'
import type { ModelInfo, SideChatPresetKind } from '@shared/types'
import { useAppStore, type RunState } from '../../store/useAppStore'
import { useSessionViewSlice } from '../../lib/conversation-scope'
import type { ToolItem } from '../../lib/thread'
import type { Turn } from '../../lib/turns'
import { buildTurns, usageForTurn, userMetadataForTurns } from '../../lib/turns'
import { formatClock, formatCost, formatExactTokens, formatTokens } from '../../lib/format'
import { findMatches, type SearchableChunk, type SearchHit } from '../../lib/search'
import { describeTool } from '../../lib/tools'
import { modelName } from '../../lib/models'
import { scrollBehavior } from '../../lib/motion'
import {
  applyScroll,
  readScrollMemory,
  rememberScrollMemory,
  rememberScrollPosition
} from '../../lib/scroll-memory'
import { readSessionTiming, userTimingDuration } from '../../lib/session-timing'
import { readProcessOpen, writeProcessOpen } from '../../lib/view-state'
import { matchesAnyShortcut } from '../../lib/shortcuts'
import { SearchContext, useSearchQuery } from '../../lib/search-context'
import { activityOf } from '../../lib/activity'
import { isRateLimitError } from '../../lib/provider-error'
import { useT } from '../../lib/i18n'
import { NoticeMessage, UserMessage } from '../MessageItem'
import { ToolCard, BashCard } from '../ToolCard'
import { ProcessTrail } from '../ProcessTrail'
import { RunStatusRow } from '../RunStatusRow'
import { AssistantMessage } from '../conversation/AssistantMessage'
import { isLiveRunSummary, RunSummary } from '../conversation/RunSummary'
import { ErrorNotice, ThreadErrorBanner } from '../conversation/ErrorNotice'
import { ThreadEnvStoreProvider, useThreadEnv } from '../conversation/ThreadEnvContext'
import { Popover } from '../Popover'
import { ErrorBoundary } from '../ErrorBoundary'
import { SideChatEmptyState } from './SideChatEmptyState'
import { SideChatTurnActions } from './SideChatTurnActions'

const FOLLOW_RANGE = 80
const EDGE_RANGE = 16
const MAX_SEARCH_HITS = 50

function isFocusInsideSideSurface(): boolean {
  const active = document.activeElement
  return Boolean(active instanceof Element && active.closest('[data-conversation-surface="side"]'))
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

function sideSearchableChunks(turns: Turn[], root?: string): SearchableChunk[] {
  const chunks: SearchableChunk[] = []
  for (const turn of turns) {
    if (turn.user?.text.trim()) {
      chunks.push({
        turnId: turn.id,
        messageId: turn.user.id,
        source: 'You',
        text: turn.user.text
      })
    }
    for (const assistant of turn.assistants) {
      for (const block of assistant.blocks) {
        if (block.type === 'text' && block.text.trim()) {
          chunks.push({
            turnId: turn.id,
            messageId: assistant.id,
            source: 'Pi',
            text: block.text
          })
        }
      }
    }
    for (const tool of turn.tools) {
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

function turnElapsedMs(turn: Turn): number | undefined {
  const start = turn.roundBreak?.timestamp ?? turn.user?.timestamp
  if (start !== undefined) {
    let end = start
    for (const assistant of turn.assistants) {
      const finished = assistant.timestamp + (assistant.durationMs ?? 0)
      if (finished > end) end = finished
    }
    for (const tool of turn.tools) {
      const finished = tool.finishedAt ?? tool.timestamp
      if (finished > end) end = finished
    }
    if (end > start) return end - start
  }
  let worked = 0
  for (const assistant of turn.assistants) {
    if (typeof assistant.durationMs === 'number' && assistant.durationMs > 0) worked += assistant.durationMs
  }
  for (const tool of turn.tools) {
    if (typeof tool.durationMs === 'number' && tool.durationMs > 0) worked += tool.durationMs
  }
  return worked > 0 ? worked : undefined
}

export interface SideChatTranscriptProps {
  sideSessionKey?: string
  onRunPreset: (preset: SideChatPresetKind, options?: { autoSend?: boolean }) => void
}

export const SideChatTranscript = memo(function SideChatTranscript({
  sideSessionKey,
  onRunPreset
}: SideChatTranscriptProps) {
  const t = useT()
  const slice = useSessionViewSlice(sideSessionKey)
  const {
    items,
    isStreaming,
    run,
    transport,
    retry,
    error,
    cwdWait,
    models: sliceModels,
    hydrating,
    submitSeq,
    clientKey
  } = slice
  const mainModels = useAppStore((state) => state.models)
  const models = sliceModels.length > 0 ? sliceModels : mainModels
  const workspacePath = useAppStore((state) => state.workspace?.path)
  const shortcutBindings = useAppStore((state) => state.settings.shortcutBindings)
  const stopSideChat = useAppStore((state) => state.stopSideChat)
  const dismissSessionError = useAppStore((state) => state.dismissSessionError)
  const mainRunOpen = useAppStore(
    (state) =>
      state.isStreaming ||
      Boolean(state.run.compaction) ||
      (state.run.phase !== 'idle' && !state.run.settled)
  )

  const resolvedKey = sideSessionKey ?? slice.sessionKey
  const scrollKey = resolvedKey || 'draft:side'
  const scrollKeyRef = useRef(scrollKey)
  scrollKeyRef.current = scrollKey

  const runOpen =
    isStreaming || Boolean(run.compaction) || (run.phase !== 'idle' && !run.settled)
  const isStreamingRef = useRef(isStreaming || runOpen)
  isStreamingRef.current = isStreaming || runOpen

  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const previousScrollTopRef = useRef<number | null>(null)
  const previousSubmitSeqRef = useRef(submitSeq)
  const previousClientKeyRef = useRef(clientKey)
  const pendingRestoreRef = useRef<string | null>(scrollKey)

  if (previousClientKeyRef.current !== clientKey) {
    previousClientKeyRef.current = clientKey
    pendingRestoreRef.current = scrollKey
    previousSubmitSeqRef.current = submitSeq
  }

  const [atBottom, setAtBottom] = useState(true)
  const [atTop, setAtTop] = useState(true)
  const { copied, copy } = useCopy()

  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const deferredSearchQuery = useDeferredValue(searchOpen ? query : '')
  const [hitIndex, setHitIndex] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setQuery('')
  }, [])

  useEffect(() => {
    setQuery('')
    setHitIndex(0)
  }, [resolvedKey])

  const turns = useMemo(() => buildTurns(items), [items])
  const userMetadata = userMetadataForTurns(turns)
  const userTimestampCounts = userMetadata.timestampCounts
  const settledDurationKey = run.settled ? run.durationMs : undefined
  const runDurationsMs = useMemo(
    () => readSessionTiming(scrollKey).runDurationsMs,
    [scrollKey, run.settled, settledDurationKey, items]
  )

  const hits = useMemo<SearchHit[]>(() => {
    const trimmed = deferredSearchQuery.trim()
    if (!trimmed) return []
    return findMatches(sideSearchableChunks(turns, workspacePath), trimmed, MAX_SEARCH_HITS)
  }, [deferredSearchQuery, turns, workspacePath])

  useEffect(() => {
    setHitIndex(0)
  }, [deferredSearchQuery])

  const flashTurn = useCallback((node: HTMLElement) => {
    node.classList.remove('turn--flash')
    void node.offsetWidth
    node.classList.add('turn--flash')
    window.setTimeout(() => node.classList.remove('turn--flash'), 1400)
  }, [])

  const jumpToTurn = useCallback(
    (turnId: string) => {
      const node = scrollRef.current?.querySelector<HTMLElement>(`[data-turn="${turnId}"]`)
      if (!node) return
      stickRef.current = false
      setAtBottom(false)
      node.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
      flashTurn(node)
    },
    [flashTurn]
  )

  const stepHit = useCallback(
    (delta: number) => {
      if (hits.length === 0) return
      const next = (hitIndex + delta + hits.length) % hits.length
      setHitIndex(next)
      const hit = hits[next]
      if (hit) jumpToTurn(hit.turnId)
    },
    [hits, hitIndex, jumpToTurn]
  )

  const jumpTurn = useCallback(
    (direction: -1 | 1) => {
      const container = scrollRef.current
      if (!container) return
      const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-turn]'))
      if (nodes.length === 0) return
      const containerTop = container.getBoundingClientRect().top
      const scrollTop = container.scrollTop
      const offsets = nodes.map((turn) => ({
        turn,
        offset: turn.getBoundingClientRect().top - containerTop + scrollTop
      }))
      const entry =
        direction === -1
          ? [...offsets].reverse().find((item) => item.offset < scrollTop - 8)
          : offsets.find((item) => item.offset > scrollTop + 8)
      if (!entry) return
      stickRef.current = false
      container.scrollTo({ top: entry.offset - 8, behavior: scrollBehavior() })
      flashTurn(entry.turn)
    },
    [flashTurn]
  )

  // Focus-scoped search (`Ctrl+F`) and turn walking (`Alt+↑` / `Alt+↓`).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return
      if (!isFocusInsideSideSurface()) return
      if (matchesAnyShortcut(event, 'search-conversation', shortcutBindings)) {
        event.preventDefault()
        setSearchOpen(true)
        requestAnimationFrame(() => searchInputRef.current?.focus())
        return
      }
      if (event.key === 'Escape' && searchOpen) {
        event.preventDefault()
        closeSearch()
        return
      }
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
  }, [closeSearch, jumpTurn, searchOpen, shortcutBindings])

  // Restore or follow scroll position per Side Chat conversation key.
  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node) return
    if (pendingRestoreRef.current === scrollKey) {
      if (hydrating && items.length === 0) return
      pendingRestoreRef.current = null
      const saved = readScrollMemory(scrollKey)
      const restored = applyScroll(node, saved, FOLLOW_RANGE)
      node.scrollTo({ top: restored.top, behavior: 'instant' })
      stickRef.current = restored.stick
      previousScrollTopRef.current = node.scrollTop
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight
      setAtBottom(distance <= EDGE_RANGE)
      setAtTop(node.scrollTop <= EDGE_RANGE)
      return
    }

    const userSubmitted = submitSeq !== previousSubmitSeqRef.current
    previousSubmitSeqRef.current = submitSeq
    if (userSubmitted) {
      stickRef.current = true
    }
    if (!stickRef.current) return
    node.scrollTo({ top: node.scrollHeight, behavior: 'instant' })
    previousScrollTopRef.current = node.scrollTop
    setAtBottom(true)
    setAtTop(node.scrollTop <= EDGE_RANGE)
    rememberScrollMemory(scrollKey, node, FOLLOW_RANGE)
  }, [hydrating, items, run.settled, runOpen, scrollKey, submitSeq])

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    previousScrollTopRef.current = node.scrollTop
    const onScroll = () => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight
      const previousScrollTop = previousScrollTopRef.current
      const scrolledUp = previousScrollTop !== null && node.scrollTop < previousScrollTop
      previousScrollTopRef.current = node.scrollTop
      stickRef.current = distance < FOLLOW_RANGE || (stickRef.current && !scrolledUp)
      setAtBottom(distance <= EDGE_RANGE)
      setAtTop(node.scrollTop <= EDGE_RANGE)
      rememberScrollMemory(scrollKey, node, FOLLOW_RANGE)
    }
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => node.removeEventListener('scroll', onScroll)
  }, [scrollKey])

  useEffect(() => {
    const node = scrollRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    let previousClientHeight = node.clientHeight
    const observer = new ResizeObserver(() => {
      const clientHeight = node.clientHeight
      const shrank = clientHeight < previousClientHeight
      previousClientHeight = clientHeight
      const distance = node.scrollHeight - node.scrollTop - clientHeight
      if (stickRef.current && (shrank || isStreamingRef.current) && distance > 1) {
        node.scrollTo({ top: node.scrollHeight, behavior: 'instant' })
        previousScrollTopRef.current = node.scrollTop
        rememberScrollMemory(scrollKeyRef.current, node, FOLLOW_RANGE)
      }
      setAtBottom(node.scrollHeight - node.scrollTop - clientHeight <= EDGE_RANGE)
      setAtTop(node.scrollTop <= EDGE_RANGE)
    })
    observer.observe(node)
    const content = node.querySelector('.side-chat__inner')
    if (content) observer.observe(content)
    return () => observer.disconnect()
  }, [])

  const scrollToBottom = () => {
    const node = scrollRef.current
    if (!node) return
    stickRef.current = true
    node.scrollTo({ top: node.scrollHeight, behavior: scrollBehavior() })
    rememberScrollPosition(scrollKey, { top: node.scrollHeight, atBottom: true })
  }

  const scrollToTop = () => {
    const node = scrollRef.current
    if (!node) return
    stickRef.current = false
    node.scrollTo({ top: 0, behavior: scrollBehavior() })
    rememberScrollPosition(scrollKey, { top: 0, atBottom: false })
  }

  const activity = useMemo(() => {
    const last = turns[turns.length - 1]
    if (!last) return undefined
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
  const liveRunSummaryAtTop = isLiveRunSummary(run)
  const jumpTarget = !atBottom && turns.length > 0 ? 'bottom' : !atTop && turns.length > 2 ? 'top' : null
  let visibleUserOrdinal = 0

  return (
    <div className="side-chat__viewport">
      {searchOpen ? (
        <div className="thread-search side-chat__search" role="search">
          <Search size={13} className="thread-search__icon" aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="text"
            className="thread-search__input"
            value={query}
            placeholder={t('Find in side chat…')}
            aria-label={t('Find in side chat…')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter') {
                event.preventDefault()
                stepHit(event.shiftKey ? -1 : 1)
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                closeSearch()
              }
            }}
          />
          {query.trim() ? (
            <span className="thread-search__count">
              {hits.length > 0 ? `${hitIndex + 1}/${hits.length}` : '0'}
            </span>
          ) : null}
          <button
            type="button"
            className="icon-btn"
            disabled={hits.length === 0}
            aria-label={t('Previous match')}
            title={t('Previous match')}
            onClick={() => stepHit(-1)}
          >
            <ChevronUp size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn"
            disabled={hits.length === 0}
            aria-label={t('Next match')}
            title={t('Next match')}
            onClick={() => stepHit(1)}
          >
            <ChevronDown size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('Close')}
            title={t('Close')}
            onClick={closeSearch}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <div ref={scrollRef} className="side-chat__scroll">
        <div className="side-chat__inner">
          <ThreadEnvStoreProvider
            surface="side"
            threadKey={scrollKey}
            workspacePath={workspacePath}
          >
            <SearchContext.Provider value={deferredSearchQuery}>
              {turns.length === 0 && !runOpen ? (
                hydrating ? (
                  <div className="side-chat__loading" role="status">
                    {t('Loading side chat…')}
                  </div>
                ) : (
                  <SideChatEmptyState onSelectPreset={onRunPreset} />
                )
              ) : (
                turns.map((turn, index) => {
                  const isLastTurn = index === turns.length - 1
                  const userOrdinal = turn.user ? visibleUserOrdinal++ : undefined
                  const runDurationMs = turn.user
                    ? userTimingDuration(
                        runDurationsMs,
                        turn.user.timestamp,
                        userOrdinal,
                        userTimestampCounts.get(turn.user.timestamp) ?? 0
                      )
                    : undefined
                  return (
                    <ErrorBoundary key={turn.id} inline scope="side chat turn">
                      <SideChatTurnView
                        turn={turn}
                        threadKey={scrollKey}
                        sideSessionKey={resolvedKey}
                        models={models}
                        t={t}
                        onCopy={copy}
                        userCopied={Boolean(turn.user && copied === turn.user.id)}
                        run={run}
                        runDurationMs={runDurationMs}
                        isLastTurn={isLastTurn}
                        mainRunOpen={mainRunOpen}
                        showWaitStatus={
                          isLastTurn && transport === 'connected' && !retry && !cwdWait
                        }
                        statusRow={
                          isLastTurn && runOpen ? (
                            <RunStatusRow
                              run={run}
                              transport={transport}
                              retry={retry}
                              onStopRetry={() => void stopSideChat()}
                              activity={activity}
                              cwdWait={cwdWait}
                              showElapsed={!liveRunSummaryAtTop}
                              hideRoutineStatus={liveRunSummaryAtTop}
                            />
                          ) : undefined
                        }
                      />
                    </ErrorBoundary>
                  )
                })
              )}
            </SearchContext.Provider>
          </ThreadEnvStoreProvider>

          {turns.length === 0 && runOpen ? (
            <RunStatusRow
              run={run}
              transport={transport}
              retry={retry}
              onStopRetry={() => void stopSideChat()}
              activity={activity}
              cwdWait={cwdWait}
              showElapsed={!liveRunSummaryAtTop}
              hideRoutineStatus={liveRunSummaryAtTop}
            />
          ) : null}

          {error ? (
            <ThreadErrorBanner
              message={error}
              onDismiss={() => dismissSessionError(resolvedKey)}
            />
          ) : null}
        </div>
      </div>

      {jumpTarget ? (
        <div className="scroll-jumps side-chat__jumps">
          <button
            type="button"
            className="scroll-jump"
            data-running={runOpen || undefined}
            onClick={jumpTarget === 'top' ? scrollToTop : scrollToBottom}
            title={t(jumpTarget === 'top' ? 'Scroll to the top' : 'Scroll to the latest')}
            aria-label={t(
              jumpTarget === 'top' ? 'Scroll to the top' : 'Scroll to the latest'
            )}
          >
            {runOpen ? (
              <Ellipsis className="scroll-jump__activity" size={15} aria-hidden="true" />
            ) : null}
            {jumpTarget === 'top' ? (
              <ArrowUp className="scroll-jump__arrow" size={15} aria-hidden="true" />
            ) : (
              <ArrowDown className="scroll-jump__arrow" size={15} aria-hidden="true" />
            )}
          </button>
        </div>
      ) : null}
    </div>
  )
})

interface SideChatTurnViewProps {
  turn: Turn
  threadKey: string
  sideSessionKey?: string
  models: ModelInfo[]
  t: (text: string) => string
  onCopy: (id: string, text: string) => void
  userCopied: boolean
  run: RunState
  runDurationMs?: number
  isLastTurn: boolean
  mainRunOpen: boolean
  showWaitStatus: boolean
  statusRow?: ReactNode
}

const SideChatTurnView = memo(function SideChatTurnView({
  turn,
  threadKey,
  sideSessionKey,
  models,
  t,
  onCopy,
  userCopied,
  run,
  runDurationMs,
  isLastTurn,
  mainRunOpen,
  showWaitStatus,
  statusRow
}: SideChatTurnViewProps) {
  const toolMap = useMemo(
    () => new Map(turn.tools.map((tool) => [tool.toolCallId, tool])),
    [turn.tools]
  )
  const orphanTools = useMemo(() => {
    const referenced = new Set<string>()
    for (const assistant of turn.assistants) {
      for (const block of assistant.blocks) {
        if (block.type === 'toolCall') referenced.add(block.id)
      }
    }
    return turn.tools.filter((tool) => !referenced.has(tool.toolCallId))
  }, [turn.assistants, turn.tools])

  const lastAssistant = turn.assistants.at(-1)
  const turnUsage = usageForTurn(turn)
  const incompleteCost = turn.assistants.some((assistant) => !assistant.usage?.cost)
  const liveOutcome = isLastTurn && isLiveRunSummary(run)
  const recordedOutcome =
    lastAssistant?.stopReason === 'stop'
      ? 'completed'
      : lastAssistant?.stopReason === 'error'
        ? 'failed'
        : lastAssistant?.stopReason === 'aborted'
          ? 'aborted'
          : undefined
  const settledDurationMs = runDurationMs ?? turnElapsedMs(turn)
  const outcome: RunState | undefined = liveOutcome
    ? run
    : isLastTurn && run.settled && run.outcome
      ? { ...run, durationMs: run.durationMs ?? settledDurationMs }
      : settledDurationMs !== undefined || recordedOutcome
        ? {
            ...run,
            compaction: undefined,
            phase: 'idle',
            settled: true,
            outcome: recordedOutcome ?? 'completed',
            durationMs: settledDurationMs
          }
        : undefined
  const replySettled = Boolean(
    lastAssistant && !lastAssistant.streaming && (!isLastTurn || run.settled)
  )
  const liveTail = isLastTurn && !run.settled
  const { autoFoldProcess } = useThreadEnv()
  const processId = `turn-${turn.id}`
  const [manualProcessOpen, setManualProcessOpen] = useState(() =>
    readProcessOpen(threadKey, processId)
  )
  useEffect(() => {
    setManualProcessOpen(readProcessOpen(threadKey, processId))
  }, [threadKey, processId])
  const query = useSearchQuery().trim().toLowerCase()
  const searchMatch =
    Boolean(query) && findMatches(sideSearchableChunks([turn]), query, 1).length > 0
  const failed = outcome?.outcome === 'failed'
  const hasToolGroups = turn.tools.length > 0
  const hasThinking = turn.assistants.some((assistant) =>
    assistant.blocks.some(
      (block) => block.type === 'thinking' && !block.redacted && block.text.trim()
    )
  )
  const processOpen =
    searchMatch ||
    (manualProcessOpen ?? (!autoFoldProcess || (!failed && (hasToolGroups || hasThinking))))
  const toggleProcess = () => {
    const next = !processOpen
    setManualProcessOpen(next)
    writeProcessOpen(threadKey, processId, next)
  }
  const processVisible =
    liveTail || !outcome || outcome.outcome === 'aborted' || processOpen

  const assistantErrorText =
    lastAssistant?.stopReason === 'error' &&
    !(
      isLastTurn &&
      (run.outcome === 'aborted' || (!run.settled && isRateLimitError(lastAssistant.error)))
    )
      ? lastAssistant.error?.trim()
      : undefined
  const failureNotice =
    failed && !assistantErrorText
      ? turn.notices.findLast(
          (notice) =>
            notice.level === 'error' &&
            notice.status !== 'compacting' &&
            notice.status !== 'retrying' &&
            notice.text.trim()
        )
      : undefined
  const processNotices = useMemo(
    () =>
      turn.notices.filter((notice) => {
        if (notice === failureNotice || !notice.text.trim()) return false
        if (
          notice.status === 'compacting' ||
          (!liveTail && notice.status === 'retrying')
        ) {
          return false
        }
        return !(
          assistantErrorText &&
          notice.level === 'error' &&
          notice.text.includes(assistantErrorText)
        )
      }),
    [turn.notices, failureNotice, liveTail, assistantErrorText]
  )
  const hasProcess = turn.tools.length > 0 || processNotices.length > 0 || hasThinking
  const turnHasOutput =
    turn.bash.length > 0 ||
    turn.tools.length > 0 ||
    turn.assistants.some((assistant) => assistant.blocks.length > 0)

  const failureDetails = failureNotice ? (
    <NoticeMessage item={failureNotice} />
  ) : assistantErrorText ? (
    <ErrorNotice
      title={lastAssistant?.error}
      message={
        isRateLimitError(assistantErrorText)
          ? t('Model rate limit reached. Try again later.')
          : assistantErrorText
      }
    />
  ) : failed ? (
    <ErrorNotice
      message={t(
        hasProcess
          ? 'This run failed. See the execution record for details.'
          : 'This run failed.'
      )}
    />
  ) : null

  return (
    <section
      className="turn side-chat__turn"
      data-turn={turn.id}
      data-live={liveTail ? 'true' : undefined}
    >
      {turn.user ? (
        <UserMessage
          item={turn.user}
          onCopy={onCopy}
          copied={userCopied ? turn.user.id : null}
        />
      ) : null}

      {turn.assistants.length > 0 ||
      turn.tools.length > 0 ||
      turn.notices.length > 0 ||
      turn.bash.length > 0 ||
      liveOutcome ||
      Boolean(statusRow) ? (
        <div className="assistant">
          <div className="assistant__body">
            {outcome ? (
              <RunSummary
                run={outcome}
                showWaitStatus={showWaitStatus && !turnHasOutput}
                foldable={hasProcess}
                open={processOpen}
                onToggle={toggleProcess}
              />
            ) : null}
            {failed ? failureDetails : null}
            <AssistantMessage
              turn={turn}
              toolMap={toolMap}
              liveTail={liveTail}
              processOpen={processVisible}
            />

            {turn.bash.map((item) => (
              <BashCard key={item.id} item={item} />
            ))}

            {orphanTools.length > 0 && processVisible ? (
              <ProcessTrail key="process-orphans" tools={orphanTools} live={liveTail}>
                {orphanTools.map((tool) => (
                  <ToolCard key={tool.id} item={tool} presentation="link" />
                ))}
              </ProcessTrail>
            ) : null}

            {processVisible
              ? processNotices.map((notice) => (
                  <NoticeMessage key={notice.id} item={notice} />
                ))
              : null}

            {!failed ? failureDetails : null}

            {statusRow}

            {replySettled && lastAssistant && lastAssistant.stopReason !== 'error' ? (
              <div className="assistant__response-actions side-chat__response-actions">
                <SideChatTurnActions
                  turn={turn}
                  sideSessionKey={sideSessionKey}
                  mainRunOpen={mainRunOpen}
                />
                <div className="assistant__footer side-chat__turn-meta">
                  {lastAssistant.model ? (
                    <span>{modelName(models, lastAssistant.model)}</span>
                  ) : null}
                  {turnUsage ? (
                    <Popover
                      placement="top"
                      align="right"
                      width={300}
                      className="usage-popover"
                      renderTrigger={({ open, toggle }) => (
                        <button
                          type="button"
                          className="assistant__usage"
                          data-active={open || undefined}
                          aria-expanded={open}
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
                        const hitBase =
                          (usage?.input ?? 0) +
                          (usage?.cacheRead ?? 0) +
                          (usage?.cacheWrite ?? 0)
                        const cacheHit =
                          hitBase > 0
                            ? `${(((usage?.cacheRead ?? 0) / hitBase) * 100).toFixed(1)}%`
                            : null
                        const model = lastAssistant.model
                          ? modelName(models, lastAssistant.model)
                          : ''
                        return (
                          <div className="usage-popover__body">
                            <div className="usage-panel">
                              <div
                                className="usage-panel__rows"
                                role="group"
                                aria-label={t('Turn usage')}
                              >
                                <div className="usage-panel__row usage-panel__row--strong">
                                  <span className="usage-panel__title">
                                    <Database size={14} aria-hidden="true" />
                                    {t('Turn usage')}
                                  </span>
                                  <span>
                                    <strong>
                                      {usage?.totalTokens.toLocaleString() ?? '—'}
                                    </strong>{' '}
                                    tok
                                  </span>
                                </div>
                                {model ? (
                                  <div className="usage-panel__row">
                                    <span>{t('Provider / model')}</span>
                                    <span className="usage-panel__route" title={model}>
                                      {model}
                                    </span>
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
})
