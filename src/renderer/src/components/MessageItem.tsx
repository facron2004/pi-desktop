import { useEffect, useRef, useState } from 'react'
import {
  Brain,
  Check,
  Copy,
  CircleAlert,
  CircleCheck,
  Download,
  Pencil,
  Info,
  TriangleAlert
} from 'lucide-react'
import type { NoticeItem, UserItem } from '../lib/thread'
import { formatClock } from '../lib/format'
import { Markdown } from './Markdown'
import { ImageButton } from './Lightbox'
import { useT } from '../lib/i18n'

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
  const t = useT()
  return (
    <div className="user-msg">
      <div className="user-msg__content">
        <div className="user-msg__bubble">
          {item.images.length > 0 ? (
            <div className="user-msg__images">
              {item.images.map((image, index) => (
                <ImageButton
                  key={`${item.id}-${index}`}
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt="attachment"
                  inline={{ data: image.data, mimeType: image.mimeType }}
                />
              ))}
            </div>
          ) : null}
          {item.text ? <Markdown>{item.text}</Markdown> : null}
        </div>
        <div className="user-msg__actions">
          <span className="user-msg__time">{formatClock(item.timestamp)}</span>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => onCopy(item.id, item.text)}
            title={t(copied === item.id ? 'Copied' : 'Copy your message')}
            aria-label={t(copied === item.id ? 'Copied' : 'Copy your message')}
          >
            {copied === item.id ? <Check size={14} /> : <Copy size={14} />}
          </button>
          {forkEntryId && onFork ? (
            <button
              type="button"
              className="ghost-btn ghost-btn--edit"
              onClick={() => onFork(forkEntryId)}
              disabled={forking}
              title={t('Edit message')}
              aria-label={t('Edit message')}
            >
              <Pencil size={14} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/**
 * The assistant text moved to `conversation/StreamingText` so the document
 * block has its own module. The old export name stays: callers and the thread
 * import `AssistantText` from here.
 */
export { StreamingText as AssistantText } from './conversation/StreamingText'

/**
 * A picture the model produced.
 *
 * Some models answer with an image instead of text. It arrives as base64 in
 * the message, so it can be shown and written to disk without a round trip.
 */
export function AssistantImage({ data, mimeType }: { data: string; mimeType: string }) {
  const [saved, setSaved] = useState(false)
  const t = useT()

  const save = async () => {
    try {
      const path = await window.pi.fs.saveImage(data, mimeType)
      if (!path) return
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1600)
    } catch {
      /* the user may have cancelled the dialog */
    }
  }

  return (
    <figure className="assistant__image">
      <ImageButton
        src={`data:${mimeType};base64,${data}`}
        alt={t('The picture the model produced')}
        inline={{ data, mimeType }}
      />
      <figcaption>
        <button className="ghost-btn" onClick={() => void save()}>
          {saved ? <Check size={12} /> : <Download size={12} />}
          {saved ? t('Saved') : t('Save')}
        </button>
      </figcaption>
    </figure>
  )
}

export function ThinkingBlock({
  text,
  streaming
}: {
  text: string
  streaming?: boolean
}) {
  const startedAtRef = useRef<number | null>(null)
  const [elapsedSec, setElapsedSec] = useState(0)
  const t = useT()

  useEffect(() => {
    if (!streaming) return
    if (startedAtRef.current === null) {
      startedAtRef.current = Date.now()
    }
    const tick = () => {
      if (startedAtRef.current !== null) {
        setElapsedSec(Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000)))
      }
    }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [streaming])

  if (!text.trim()) return null
  return (
    <div className="thinking" data-open="false">
      {/* The model's raw reasoning is not conversation content. The row says
          that a thought happened and how long it took; it never prints the
          private chain of thought. */}
      <div className="thinking__head" role="status">
        <Brain size={13} />
        <span className="thinking__title">
          {streaming
            ? t('Thinking')
            : elapsedSec > 0
              ? `${t('Thought for')} ${elapsedSec}${t('s')}`
              : t('Thought')}
        </span>
        {streaming && elapsedSec > 0 ? (
          <span className="thinking__duration">{elapsedSec}{t('s')}</span>
        ) : null}
        <span className="thinking__private">{t('Reasoning hidden')}</span>
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
  const t = useT()
  const Icon = NOTICE_ICONS[item.level]
  return (
    <div className={item.source === 'retry' ? 'notice notice--retry' : 'notice'} data-level={item.level}>
      <Icon size={14} className="notice__icon" />
      <span>{t(item.text)}</span>
    </div>
  )
}
