import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, Check, Copy, Search, SquareTerminal, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import type { AssistantItem, NoticeItem, ThreadItem, ToolItem, UserItem } from '../lib/thread'
import { formatClock, formatCost, formatTokens } from '../lib/format'
import { findMatches, splitSnippet, type SearchableChunk, type SearchHit } from '../lib/search'
import { pairForkTargets } from '../lib/thread'
import { SearchContext } from '../lib/search-context'
import { AssistantText, NoticeMessage, ThinkingBlock, UserMessage } from './MessageItem'
import { ToolCard } from './ToolCard'
import { ToolGroup } from './ToolGroup'

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
function searchableChunks(turns: Turn[]): SearchableChunk[] {
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
      chunks.push({ turnId: turn.id, source: 'Tool', text: `${tool.toolName} ${summarise(tool.args)}` })
    }
  }
  return chunks
}

/** A short, single-line summary of a tool call's arguments. */
function summarise(args: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    parts.push(`${key}: ${text}`)
    if (parts.length >= 3) break
  }
  return parts.join(' · ')
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
  const forkTargets = useAppStore((state) => state.forkTargets)
  const forkFrom = useAppStore((state) => state.forkFrom)
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
  const chunks = useMemo(() => searchableChunks(turns), [turns])
  const hits: SearchHit[] = useMemo(() => findMatches(chunks, query), [chunks, query])
  const forkByUserId = useMemo(() => pairForkTargets(items, forkTargets), [items, forkTargets])

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
    node.scrollIntoView({ block: 'center', behavior: 'smooth' })
    node.classList.remove('turn--flash')
    // Force a reflow so the animation can run again on the same turn.
    void node.offsetWidth
    node.classList.add('turn--flash')
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
    container.scrollTo({ top: entry.offset - 8, behavior: 'smooth' })
    entry.turn.classList.remove('turn--flash')
    // Force a reflow so the animation can run again on the same turn.
    void entry.turn.offsetWidth
    entry.turn.classList.add('turn--flash')
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
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
              placeholder="Search this conversation"
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
                  ? `${hitIndex + 1} of ${hits.length}`
                  : 'no results'
                : ''}
            </span>
            <button
              className="icon-btn"
              title="Close search"
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
                    {turn.assistants.map((assistant) => (
                      <AssistantBlocks
                        key={assistant.id}
                        assistant={assistant}
                        toolMap={toolMap}
                        isLast={assistant.id === lastAssistant?.id}
                      />
                    ))}

                    {turn.bash.map((item) => (
                      <div className="tool" data-tone="exec" key={item.id}>
                        <div className="tool__head">
                          <span className="tool__icon">
                            <SquareTerminal size={12} />
                          </span>
                          <span className="tool__name">bash</span>
                          <span className="tool__summary">{item.command}</span>
                        </div>
                      </div>
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
                        <span>Working…</span>
                      </div>
                    ) : null}

                    {!isStreaming && assistantText ? (
                      <div className="assistant__actions">
                        <button
                          className="ghost-btn"
                          onClick={() => copy(turn.id, assistantText)}
                          title="Copy the assistant's answer"
                        >
                          {copied === turn.id ? <Check size={12} /> : <Copy size={12} />}
                          {copied === turn.id ? 'Copied' : 'Copy'}
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
                <span>Thinking…</span>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {!atBottom ? (
        <div className="scroll-bottom-wrap">
          <button className="scroll-bottom" onClick={scrollToBottom} title="Scroll to the latest">
            <ArrowDown size={15} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

function AssistantBlocks({
  assistant,
  toolMap,
  isLast
}: {
  assistant: AssistantItem
  toolMap: Map<string, ToolItem>
  isLast: boolean
}) {
  const lastTextIndex = assistant.blocks.reduce(
    (found, block, index) => (block.type === 'text' ? index : found),
    -1
  )

  return (
    <>
      {renderBlocks(assistant, toolMap, lastTextIndex)}
      {isLast && !assistant.streaming && (assistant.usage || assistant.model) ? (
        <div className="assistant__footer">
          {assistant.model ? <span>{assistant.model}</span> : null}
          {assistant.usage ? (
            <>
              <span>{formatTokens(assistant.usage.totalTokens)} tokens</span>
              {assistant.usage.cost ? <span>{formatCost(assistant.usage.cost.total)}</span> : null}
            </>
          ) : null}
          {assistant.stopReason === 'error' ? (
            <span style={{ color: 'var(--red)' }}>{assistant.error ?? 'error'}</span>
          ) : null}
          <span>{formatClock(assistant.timestamp)}</span>
        </div>
      ) : null}
    </>
  )
}

/**
 * Render the blocks of one assistant message.
 *
 * Calls of the same tool that follow each other are folded into a single
 * card, so a run of reads reads as one line instead of a dozen.
 */
function renderBlocks(
  assistant: AssistantItem,
  toolMap: Map<string, ToolItem>,
  lastTextIndex: number
): ReactNode[] {
  const blocks = assistant.blocks
  const nodes: ReactNode[] = []
  let index = 0

  while (index < blocks.length) {
    const block = blocks[index]
    if (block.type === 'text') {
      if (block.text.trim()) {
        nodes.push(
          <AssistantText
            key={index}
            text={block.text}
            streaming={assistant.streaming && index === lastTextIndex}
          />
        )
      }
      index += 1
      continue
    }
    if (block.type === 'thinking') {
      nodes.push(<ThinkingBlock key={index} text={block.text} />)
      index += 1
      continue
    }

    const tool = toolMap.get(block.id)
    if (!tool) {
      index += 1
      continue
    }

    const run = [tool]
    let next = index + 1
    while (next < blocks.length) {
      const candidate = blocks[next]
      if (candidate.type !== 'toolCall') break
      const item = toolMap.get(candidate.id)
      if (!item || item.toolName !== tool.toolName) break
      run.push(item)
      next += 1
    }

    if (run.length > 1) {
      nodes.push(<ToolGroup key={`group-${index}`} items={run} />)
    } else {
      nodes.push(<ToolCard key={index} item={tool} />)
    }
    index = next
  }

  return nodes
}
