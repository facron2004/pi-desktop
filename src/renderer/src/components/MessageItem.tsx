import { memo, useEffect, useId, useMemo, useState } from 'react'
import {
  Check,
  ChevronRight,
  Copy,
  CircleAlert,
  CircleCheck,
  Download,
  Pencil,
  Info,
  TriangleAlert
} from 'lucide-react'
import type { SideChatReference } from '@shared/side-chat'
import type { NoticeItem, UserItem } from '../lib/thread'
import { formatClock } from '../lib/format'
import { Markdown } from './Markdown'
import { ImageButton } from './Lightbox'
import { useT } from '../lib/i18n'
import { stripImageAnnotations } from '../lib/message-text'
import { readProcessOpen, writeProcessOpen } from '../lib/view-state'
import { useThreadEnv } from './conversation/ThreadEnvContext'
import { SideChatRefChip } from './side-chat/SideChatRefChip'

export const UserMessage = memo(function UserMessage({
  item,
  onCopy,
  copied,
  onEdit,
  editing
}: {
  item: UserItem
  onCopy: (id: string, text: string) => void
  copied: string | null
  onEdit?: (item: UserItem) => void
  editing?: boolean
}) {
  const t = useT()
  const sideRefs = (item as UserItem & { sideRefs?: SideChatReference[] }).sideRefs
  return (
    <div className="user-msg" data-pending={item.pending ? 'true' : undefined}>
      <div className="user-msg__content">
        <div className="user-msg__bubble">
          {sideRefs && sideRefs.length > 0 ? (
            <div className="user-msg__refs">
              {sideRefs.map((ref) => (
                <SideChatRefChip key={ref.id} reference={ref} compact />
              ))}
            </div>
          ) : null}
          {item.images.length > 0 ? (
            <div className="user-msg__images">
              {item.images.map((image, index) => (
                <ImageButton
                  key={`${item.id}-${index}`}
                  // A fixed mark, not the picture: the bubble is where the
                  // prompt is read, and the attachment opens on click.
                  compact
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt="attachment"
                  inline={{ data: image.data, mimeType: image.mimeType }}
                />
              ))}
            </div>
          ) : null}
          {item.text ? (
            <Markdown>
              {item.images.length > 0 ? stripImageAnnotations(item.text) : item.text}
            </Markdown>
          ) : null}
        </div>
        <div className="user-msg__actions">
          {/* A prompt that Pi has not taken yet can be waiting for another
              conversation's run in the same folder. Saying so keeps the empty
              composer from reading as "nothing was sent". */}
          {item.pending ? (
            <span className="user-msg__pending" role="status">
              {t('Waiting to send')}
            </span>
          ) : (
            <span className="user-msg__time">{formatClock(item.timestamp)}</span>
          )}
          {item.pending ? null : (
            <>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => onCopy(item.id, item.text)}
                aria-label={t(copied === item.id ? 'Copied' : 'Copy your message')}
              >
                {copied === item.id ? <Check size={12} /> : <Copy size={12} />}
              </button>
              {onEdit ? (
                <button
                  type="button"
                  className="ghost-btn ghost-btn--edit"
                  onClick={() => onEdit(item)}
                  disabled={editing}
                  aria-label={t('Edit message')}
                >
                  <Pencil size={12} />
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
})

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
export const AssistantImage = memo(function AssistantImage({ data, mimeType }: { data: string; mimeType: string }) {
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
})

export const ThinkingBlock = memo(
  function ThinkingBlock({
    turnId,
    parts,
    streaming
  }: {
    turnId: string
    parts: string[]
    streaming?: boolean
  }) {
    const t = useT()
    const { threadKey } = useThreadEnv()
    const disclosureKey = `thinking-${turnId}`
    const bodyId = useId()
    const [open, setOpen] = useState(() => readProcessOpen(threadKey, disclosureKey) === true)

    useEffect(() => {
      setOpen(readProcessOpen(threadKey, disclosureKey) === true)
    }, [threadKey, disclosureKey])

    const toggle = () => {
      const next = !open
      setOpen(next)
      writeProcessOpen(threadKey, disclosureKey, next ? true : undefined)
    }
    // Each reasoning step is its own paragraph, so the gap between steps is the
    // block's own spacing instead of the full blank line a `pre-wrap` `\n\n`
    // reserves. Blank lines inside one step are split too: Pi sometimes delivers
    // a whole stretch of reasoning as one block. Defer splitting while collapsed
    // so long hidden reasoning does not burn CPU on every streamed frame.
    const paragraphs = useMemo(
      () =>
        open
          ? parts
              .flatMap((part) => part.split(/\n[ \t]*\n/))
              .map((paragraph) => paragraph.trim())
              .filter(Boolean)
          : [],
      [open, parts]
    )
    return (
      <div className="thinking" data-open={open} data-streaming={streaming ? 'true' : undefined}>
        <button
          type="button"
          className="thinking__head"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          onClick={toggle}
        >
          <ChevronRight size={13} className="caret" data-open={open} aria-hidden="true" />
          <span className="thinking__title">{t('Thinking content')}</span>
        </button>
        {open ? (
          <div className="thinking__body" id={bodyId} tabIndex={0}>
            {paragraphs.map((paragraph, index) => (
              <p key={index} className="thinking__text">{paragraph}</p>
            ))}
          </div>
        ) : null}
      </div>
    )
  },
  (previous, next) =>
    previous.turnId === next.turnId &&
    previous.streaming === next.streaming &&
    previous.parts.length === next.parts.length &&
    previous.parts.every((part, index) => part === next.parts[index])
)

const NOTICE_ICONS = {
  info: Info,
  warn: TriangleAlert,
  error: CircleAlert,
  success: CircleCheck
} as const

export const NoticeMessage = memo(function NoticeMessage({ item }: { item: NoticeItem }) {
  const t = useT()
  const Icon = NOTICE_ICONS[item.level]
  return (
    <div className={item.source === 'retry' ? 'notice notice--retry' : 'notice'} data-level={item.level}>
      <Icon size={14} className="notice__icon" />
      <span>{t(item.text)}</span>
    </div>
  )
})
