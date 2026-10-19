import { useEffect, useState } from 'react'
import {
  Brain,
  Check,
  ChevronRight,
  Copy,
  CircleAlert,
  CircleCheck,
  GitBranch,
  Info,
  TriangleAlert
} from 'lucide-react'
import type { NoticeItem, UserItem } from '../lib/thread'
import { formatClock } from '../lib/format'
import { Markdown } from './Markdown'

export function UserMessage({
  item,
  onCopy,
  copied,
  forkEntryId,
  onFork,
  forking
}: {
  item: UserItem
  onCopy: (id: string, text: string) => void
  copied: string | null
  /** The Pi entry id this prompt can be forked from, when it can. */
  forkEntryId?: string
  onFork?: (entryId: string) => void
  forking?: boolean
}) {
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
        <div className="user-msg__actions">
          <span className="user-msg__time">{formatClock(item.timestamp)}</span>
          {forkEntryId && onFork ? (
            <button
              className="ghost-btn ghost-btn--branch"
              onClick={() => onFork(forkEntryId)}
              disabled={forking}
              title="Branch from here — a new conversation that keeps the earlier history"
            >
              <GitBranch size={12} />
              {forking ? 'Branching…' : 'Branch'}
            </button>
          ) : null}
          <button
            className="ghost-btn"
            onClick={() => onCopy(item.id, item.text)}
            title="Copy your message"
          >
            {copied === item.id ? <Check size={12} /> : <Copy size={12} />}
            {copied === item.id ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function AssistantText({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="assistant__text">
      <Markdown>{text}</Markdown>
      {streaming ? <span className="caret-blink" aria-hidden="true" /> : null}
    </div>
  )
}

export function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false)
  // A click wins over the automatic behaviour for good.
  const [touched, setTouched] = useState(false)

  // While the model is still reasoning, that text is the only thing that is
  // happening, so it is shown. It folds away once the answer arrives.
  useEffect(() => {
    if (touched) return
    setOpen(streaming === true)
  }, [streaming, touched])

  if (!text.trim()) return null
  return (
    <div className="thinking" data-open={open}>
      <button
        className="thinking__head"
        onClick={() => {
          setTouched(true)
          setOpen((value) => !value)
        }}
      >
        <ChevronRight size={13} className="caret" data-open={open} />
        <Brain size={13} />
        <span className="thinking__title">Thinking</span>
        <span className="thinking__hint">{open ? 'hide' : 'show'}</span>
      </button>
      {open ? <div className="thinking__body">{text}</div> : null}
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
