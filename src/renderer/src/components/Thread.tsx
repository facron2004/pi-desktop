import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Check, Copy, SquareTerminal } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import type { AssistantItem, NoticeItem, ThreadItem, ToolItem, UserItem } from '../lib/thread'
import { formatClock, formatCost, formatTokens } from '../lib/format'
import { AssistantText, NoticeMessage, ThinkingBlock, UserMessage } from './MessageItem'
import { ToolCard } from './ToolCard'

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
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const { copied, copy } = useCopy()

  const turns = useMemo(() => buildTurns(items), [items])

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

  const scrollToBottom = () => {
    const node = scrollRef.current
    if (!node) return
    stickRef.current = true
    setAtBottom(true)
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
  }

  return (
    <div className="thread" ref={scrollRef}>
      <div className="thread__inner">
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
            <section className="turn" key={turn.id}>
              {turn.user ? <UserMessage item={turn.user} onCopy={copy} copied={copied} /> : null}

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
      {assistant.blocks.map((block, index) => {
        if (block.type === 'text') {
          if (!block.text.trim()) return null
          return (
            <AssistantText
              key={index}
              text={block.text}
              streaming={assistant.streaming && index === lastTextIndex}
            />
          )
        }
        if (block.type === 'thinking') {
          return <ThinkingBlock key={index} text={block.text} />
        }
        const tool = toolMap.get(block.id)
        return tool ? <ToolCard key={index} item={tool} /> : null
      })}
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
