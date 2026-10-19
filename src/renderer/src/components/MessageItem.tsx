import { useState } from 'react'
import { Brain, ChevronRight, CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react'
import type { AssistantItem, NoticeItem, ToolItem, UserItem } from '../lib/thread'
import { formatCost, formatTokens } from '../lib/format'
import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'

export function UserMessage({ item }: { item: UserItem }) {
  return (
    <div className="user-msg">
      <div className="user-msg__bubble">
        {item.images.length > 0 ? (
          <div className="user-msg__images">
            {item.images.map((image, index) => (
              <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt="attachment" />
            ))}
          </div>
        ) : null}
        {item.text ? <Markdown>{item.text}</Markdown> : null}
      </div>
    </div>
  )
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (!text.trim()) return null
  return (
    <div className="thinking">
      <button className="thinking__head" onClick={() => setOpen((value) => !value)}>
        <ChevronRight size={13} className="caret" data-open={open} />
        <Brain size={13} />
        <span className="thinking__title">Thinking</span>
      </button>
      {open ? <div className="thinking__body">{text}</div> : null}
    </div>
  )
}

export function AssistantMessage({
  item,
  tools
}: {
  item: AssistantItem
  tools: Map<string, ToolItem>
}) {
  return (
    <div className="assistant">
      <div className="assistant__avatar">π</div>
      <div className="assistant__body">
        {item.blocks.map((block, index) => {
          if (block.type === 'text') {
            if (!block.text.trim()) return null
            return <Markdown key={index}>{block.text}</Markdown>
          }
          if (block.type === 'thinking') {
            return <ThinkingBlock key={index} text={block.text} />
          }
          const tool = tools.get(block.id)
          return tool ? <ToolCard key={index} item={tool} /> : null
        })}

        {item.streaming ? (
          <div className="assistant__footer">
            <span className="spinner" />
            <span>Working…</span>
          </div>
        ) : null}

        {!item.streaming && (item.usage || item.model) ? (
          <div className="assistant__footer">
            {item.model ? <span>{item.model}</span> : null}
            {item.usage ? (
              <>
                <span>{formatTokens(item.usage.totalTokens)} tokens</span>
                {item.usage.cost ? <span>{formatCost(item.usage.cost.total)}</span> : null}
              </>
            ) : null}
            {item.stopReason === 'error' ? (
              <span style={{ color: 'var(--red)' }}>{item.error ?? 'error'}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

const NOTICE_ICONS = {
  info: Info,
  warn: TriangleAlert,
  error: CircleAlert,
  success: CircleCheck
} as const

export function NoticeMessage({ item }: { item: NoticeItem }) {
  const Icon = NOTICE_ICONS[item.level]
  return (
    <div className="notice" data-level={item.level}>
      <Icon size={14} className="notice__icon" />
      <span>{item.text}</span>
    </div>
  )
}
