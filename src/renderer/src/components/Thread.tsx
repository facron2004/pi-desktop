import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { SquareTerminal } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import type { ThreadItem, ToolItem } from '../lib/thread'
import { AssistantMessage, NoticeMessage, UserMessage } from './MessageItem'
import { ToolCard } from './ToolCard'

export function Thread() {
  const items = useAppStore((state) => state.items)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  const toolMap = useMemo(() => {
    const map = new Map<string, ToolItem>()
    for (const item of items) {
      if (item.kind === 'tool') map.set(item.toolCallId, item)
    }
    return map
  }, [items])

  const referenced = useMemo(() => {
    const ids = new Set<string>()
    for (const item of items) {
      if (item.kind !== 'assistant') continue
      for (const block of item.blocks) {
        if (block.type === 'toolCall') ids.add(block.id)
      }
    }
    return ids
  }, [items])

  const orphans = useMemo(
    () =>
      items.filter(
        (item) => item.kind === 'tool' && !referenced.has(item.toolCallId)
      ) as Extract<ThreadItem, { kind: 'tool' }>[],
    [items, referenced]
  )

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
    }
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => node.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div className="thread" ref={scrollRef}>
      <div className="thread__inner">
        {items.map((item) => {
          switch (item.kind) {
            case 'user':
              return <UserMessage key={item.id} item={item} />
            case 'assistant':
              return <AssistantMessage key={item.id} item={item} tools={toolMap} />
            case 'notice':
              return <NoticeMessage key={item.id} item={item} />
            case 'bash':
              return (
                <div className="tool" data-tone="exec" key={item.id}>
                  <div className="tool__head">
                    <span className="tool__icon">
                      <SquareTerminal size={12} />
                    </span>
                    <span className="tool__name">bash</span>
                    <span className="tool__summary">{item.command}</span>
                  </div>
                </div>
              )
            default:
              return null
          }
        })}

        {orphans.map((tool) => (
          <ToolCard key={tool.id} item={tool} />
        ))}

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
    </div>
  )
}
