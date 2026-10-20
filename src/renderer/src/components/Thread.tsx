import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, Check, Copy, Search, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import type { AssistantItem, NoticeItem, ThreadItem, ToolItem, UserItem } from '../lib/thread'
import type { ModelInfo } from '@shared/types'
import { formatClock, formatCost, formatTokens } from '../lib/format'
import { findMatches, splitSnippet, type SearchableChunk, type SearchHit } from '../lib/search'
import { pairForkTargets } from '../lib/thread'
import { describeTool } from '../lib/tools'
import { modelName } from '../lib/models'
import { scrollBehavior } from '../lib/motion'
import { SearchContext } from '../lib/search-context'
import { AssistantImage, AssistantText, NoticeMessage, ThinkingBlock, UserMessage } from './MessageItem'
import { ToolCard, BashCard } from './ToolCard'
import { ToolGroup } from './ToolGroup'
import { useT } from '../lib/i18n'

interface Turn {
  id: string
  user?: UserItem
  assistants: AssistantItem[]
  tools: ToolItem[]
  notices: NoticeItem[]
  bash: Extract<ThreadItem, { kind: 'bash' }>[]
}

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
      chunks.push({ turnId: turn.id, source: 'You', text: turn.user.text })
    }
    for (const assistant of turn.assistants) {
      for (const block of assistant.blocks) {
        if (block.type === 'text' && block.text.trim()) {
          chunks.push({ turnId: turn.id, source: 'Pi', text: block.text })
        }
      }
    }
    for (const tool of turn.tools) {
      // The arguments of a tool carry whole files, so only the one-line
      // summary of the call goes into the index. Otherwise every word of
      // every edited file turns into a search hit.
      const label = describeTool(tool.toolName).summary(tool.args ?? {}, root)
      chunks.push({ turnId: turn.id, source: 'Tool', text: `${tool.toolName} ${label}` })
    }
  }
  return chunks
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null)

  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
      window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1600)
    } catch {
      /* clipboard may be unavailable */
    }
  }

  return { copied, copy }
}

export function Thread() {
  const items = useAppStore((state) => state.items)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const workspace = useAppStore((state) => state.workspace)
  const models = useAppStore((state) => state.models)
  const forkTargets = useAppStore((state) => state.forkTargets)
  const forkFrom = useAppStore((state) => state.forkFrom)
  const t = useT()
  const forking = useAppStore((state) => state.forking)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const { copied, copy } = useCopy()

  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hitIndex, setHitIndex] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const turns = useMemo(() => buildTurns(items), [items])
  const hasSearchQuery = searchOpen && Boolean(query.trim())
  const chunks = useMemo(
    () => (hasSearchQuery ? searchableChunks(turns, workspace?.path) : []),
    [hasSearchQuery, turns, workspace?.path]
  )
  const hits: SearchHit[] = useMemo(() => findMatches(chunks, query), [chunks, query])
  const forkByUserId = useMemo(() => pairForkTargets(items, forkTargets), [items, forkTargets])

  /**
   * What Pi is doing right now.
   *
   * The reader may have scrolled up, so the footer says what the agent is
   * working on as well.
   */
  const activity = useMemo(() => {
    const last = turns[turns.length - 1]
    if (!last) return ''
    let tool: ToolItem | undefined
    for (let index = last.tools.length - 1; index >= 0; index -= 1) {
      if (last.tools[index].status === 'running') {
        tool = last.tools[index]
        break
      }
    }
    if (!tool) tool = last.tools[last.tools.length - 1]
    if (!tool) return ''
    const descriptor = describeTool(tool.toolName)
    const summary = descriptor.summary(tool.args ?? {}, workspace?.path)
    return summary ? `${descriptor.label} ${summary}` : descriptor.label
  }, [turns, workspace?.path])

  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node || !stickRef.current) return
    node.scrollTop = node.scrollHeight
  }, [items])

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const onScroll = () => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight
      stickRef.current = distance < 120
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
        setSearchOpen(false)
        setQuery('')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [searchOpen])

  useEffect(() => {
    setHitIndex(0)
  }, [query])

  // Development aid: open the search bar with a query for screenshots.
  useEffect(() => {
    const dev = (window as unknown as { __piDesktopDev?: { search?: string } }).__piDesktopDev
    if (!dev?.search) return
    setSearchOpen(true)
    setQuery(dev.search)
  }, [])

  const jumpToHit = useCallback((hit: SearchHit | undefined) => {
    if (!hit) return
    const node = scrollRef.current?.querySelector<HTMLElement>(`[data-turn="${hit.turnId}"]`)
    if (!node) return
    stickRef.current = false
    node.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
    node.classList.remove('turn--flash')
    // Force a reflow so the animation can run again on the same turn.
    void node.offsetWidth
    node.classList.add('turn--flash')
    window.setTimeout(() => node.classList.remove('turn--flash'), 1400)
  }, [])

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
    const turns = Array.from(container.querySelectorAll<HTMLElement>('[data-turn]'))
    if (turns.length === 0) return

    const containerTop = container.getBoundingClientRect().top
    const scrollTop = container.scrollTop
    const offsets = turns.map((turn) => {
      const rect = turn.getBoundingClientRect()
      return { turn, offset: rect.top - containerTop + scrollTop }
    })

    const entry =
      direction === -1
        ? [...offsets].reverse().find((item) => item.offset < scrollTop - 8)
        : offsets.find((item) => item.offset > scrollTop + 8)
    if (!entry) return

    stickRef.current = false
    container.scrollTo({ top: entry.offset - 8, behavior: scrollBehavior() })
    entry.turn.classList.remove('turn--flash')
    // Force a reflow so the animation can run again on the same turn.
    void entry.turn.offsetWidth
    entry.turn.classList.add('turn--flash')
    window.setTimeout(() => entry.turn.classList.remove('turn--flash'), 1400)
  }, [])

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
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  stepHit(event.shiftKey ? -1 : 1)
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setSearchOpen(false)
                  setQuery('')
                }
              }}
            />
            <span className="thread-search__count">
              {query.trim()
                ? hits.length
                  ? `${hitIndex + 1} ${t('of')} ${hits.length}`
                  : t('no results')
                : ''}
            </span>
            <button
              className="icon-btn"
              title={t('Close search')}
              onClick={() => {
                setSearchOpen(false)
                setQuery('')
              }}
            >
              <X size={13} />
            </button>
          </div>

          {hits.length > 0 ? (
            <div className="thread-search__results">
              {hits.slice(0, 6).map((hit, index) => {
                const [before, match, after] = splitSnippet(hit.snippet, query)
                return (
                  <button
                    key={hit.key}
                    className="thread-search__hit"
                    data-active={index === hitIndex}
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

      <div className="thread__inner">
        <SearchContext.Provider value={query}>
          {turns.map((turn) => {
          const toolMap = new Map(turn.tools.map((tool) => [tool.toolCallId, tool]))
          const referenced = new Set<string>()
          for (const assistant of turn.assistants) {
            for (const block of assistant.blocks) {
              if (block.type === 'toolCall') referenced.add(block.id)
            }
          }
          const orphanTools = turn.tools.filter((tool) => !referenced.has(tool.toolCallId))
          const lastAssistant = turn.assistants[turn.assistants.length - 1]

          // When the current run started, for the elapsed counter. The
          // prompt is the honest start of the turn.
          const runStartedAt = turn.user?.timestamp ?? lastAssistant?.timestamp

          const assistantText = turn.assistants
            .flatMap((assistant) =>
              assistant.blocks
                .filter((block) => block.type === 'text')
                .map((block) => (block.type === 'text' ? block.text : ''))
            )
            .join('\n\n')
            .trim()

          return (
            <section className="turn" key={turn.id} data-turn={turn.id}>
              {turn.user ? (
                <UserMessage
                  item={turn.user}
                  onCopy={copy}
                  copied={copied}
                  forkEntryId={forkByUserId.get(turn.user.id)}
                  onFork={forkFrom}
                  forking={forking}
                />
              ) : null}

              {turn.assistants.length > 0 || turn.notices.length > 0 || turn.bash.length > 0 ? (
                <div className="assistant">
                  <div className="assistant__avatar">π</div>
                  <div className="assistant__body">
                    {renderTurn(turn, toolMap, models, t)}

                    {turn.bash.map((item) => (
                      <BashCard key={item.id} item={item} />
                    ))}

                    {orphanTools.map((tool) => (
                      <ToolCard key={tool.id} item={tool} />
                    ))}

                    {turn.notices.map((notice) => (
                      <NoticeMessage key={notice.id} item={notice} />
                    ))}

                    {isStreaming && turn === turns[turns.length - 1] ? (
                      <div className="assistant__footer">
                        <span className="spinner" />
                        <span>{t('Working…')}</span>
                        {activity ? <span className="assistant__activity">{activity}</span> : null}
                        {runStartedAt ? <Elapsed since={runStartedAt} /> : null}
                      </div>
                    ) : null}

                    {!isStreaming && assistantText ? (
                      <div className="assistant__actions">
                        <button
                          className="ghost-btn"
                          onClick={() => copy(turn.id, assistantText)}
                          title={t("Copy the assistant's answer")}
                        >
                          {copied === turn.id ? <Check size={12} /> : <Copy size={12} />}
                          {copied === turn.id ? t('Copied') : t('Copy')}
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </section>
          )
          })}
        </SearchContext.Provider>

        {isStreaming && items.length === 0 ? (
          <div className="assistant">
            <div className="assistant__avatar">π</div>
            <div className="assistant__body">
              <div className="assistant__footer">
                <span className="spinner" />
                <span>{t('Thinking…')}</span>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {!atBottom ? (
        <div className="scroll-bottom-wrap">
          <button className="scroll-bottom" onClick={scrollToBottom} title={t('Scroll to the latest')}>
            <ArrowDown size={15} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** A counter that ticks once a second while the agent is working. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  const t = useT()

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const seconds = Math.max(0, Math.round((now - since) / 1000))
  if (seconds < 60) return <span>{seconds}{t('seconds-short')}</span>
  return <span>{Math.floor(seconds / 60)}{t('minutes-short')} {seconds % 60}{t('seconds-short')}</span>
}

/**
 * Render a whole turn.
 *
 * The blocks of every reply in the turn are laid out in one sequence, so
 * calls of the same tool that follow each other are folded into a single
 * card. The agent usually reads one file after the other, and each of those
 * is a reply of its own — grouping inside a reply would not catch them.
 */
function renderTurn(
  turn: Turn,
  toolMap: Map<string, ToolItem>,
  models: ModelInfo[],
  t: (text: string) => string
): ReactNode[] {
  const nodes: ReactNode[] = []
  let group: ToolItem[] = []
  let lastAssistant: AssistantItem | undefined

  const flush = () => {
    if (!group.length) return
    if (group.length > 1) {
      nodes.push(<ToolGroup key={`group-${group[0].id}`} items={group} />)
    } else {
      nodes.push(<ToolCard key={group[0].id} item={group[0]} />)
    }
    group = []
  }

  for (const assistant of turn.assistants) {
    lastAssistant = assistant
    const lastTextIndex = assistant.blocks.reduce(
      (found, block, index) => (block.type === 'text' ? index : found),
      -1
    )

    assistant.blocks.forEach((block, index) => {
      if (block.type === 'text') {
        if (!block.text.trim()) return
        flush()
        nodes.push(
          <AssistantText
            key={`${assistant.id}-${index}`}
            text={block.text}
            streaming={assistant.streaming && index === lastTextIndex}
          />
        )
        return
      }
      if (block.type === 'thinking') {
        flush()
        nodes.push(
          <ThinkingBlock
            key={`${assistant.id}-${index}`}
            text={block.text}
            streaming={assistant.streaming}
          />
        )
        return
      }
      if (block.type === 'image') {
        flush()
        nodes.push(
          <AssistantImage
            key={`${assistant.id}-${index}`}
            data={block.data}
            mimeType={block.mimeType}
          />
        )
        return
      }
      const tool = toolMap.get(block.id)
      if (!tool) return
      if (group.length && group[0].toolName !== tool.toolName) flush()
      group.push(tool)
    })
  }
  flush()

  if (lastAssistant && !lastAssistant.streaming && (lastAssistant.usage || lastAssistant.model)) {
    nodes.push(
      <div className="assistant__footer" key="turn-footer">
        {lastAssistant.model ? <span>{modelName(models, lastAssistant.model)}</span> : null}
        {lastAssistant.usage ? (
          <>
            <span>{formatTokens(lastAssistant.usage.totalTokens)} {t('tokens')}</span>
            {lastAssistant.usage.cost ? (
              <span>{formatCost(lastAssistant.usage.cost.total)}</span>
            ) : null}
          </>
        ) : null}
        {lastAssistant.stopReason === 'error' ? (
          <span style={{ color: 'var(--red)' }}>{lastAssistant.error ?? t('error')}</span>
        ) : null}
        <span>{formatClock(lastAssistant.timestamp)}</span>
      </div>
    )
  }

  return nodes
}
