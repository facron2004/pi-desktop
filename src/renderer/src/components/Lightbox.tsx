import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Download, X } from 'lucide-react'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useT } from '../lib/i18n'
import { useAppStore } from '../store/useAppStore'
import '../styles/lightbox.css'

interface InlineImage {
  data: string
  mimeType: string
}

/** The base64 half of a `data:` URL, when it is the kind the bridge can write. */
function inlineOf(src: string): InlineImage | null {
  const match = /^data:(image\/[^;,]+)[^,]*;base64,(.+)$/.exec(src)
  if (!match) return null
  return { mimeType: match[1], data: match[2] }
}

/**
 * A picture in the conversation, clickable.
 *
 * The picture itself is the button, so the keyboard reaches it in the normal
 * tab order. The overlay is portalled to the body so neither the scrolling
 * conversation nor any stacking context of a message can clip it.
 */
export function ImageButton({
  src,
  alt,
  inline,
  title
}: {
  src: string
  alt?: string
  /** The base64 half of the picture, when the caller already knows it. */
  inline?: InlineImage
  /** The markdown image title, shown as the tooltip. */
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const t = useT()
  return (
    <>
      <button
        type="button"
        className="lightbox-trigger"
        onClick={(event) => {
          // Markdown can wrap a picture in a link; opening the lightbox is the
          // whole point of the click, so the link does not also open.
          event.stopPropagation()
          // Some platforms do not focus a button on a mouse click, and the
          // overlay returns focus to whatever was focused when it opened.
          event.currentTarget.focus()
          setOpen(true)
        }}
        aria-label={t('Open the image')}
        title={title ?? t('Open the image')}
      >
        <img src={src} alt={alt ?? ''} draggable={false} />
      </button>
      {open ? (
        <Lightbox
          src={src}
          alt={alt}
          inline={inline ?? inlineOf(src)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

/** The full-window view of one picture. */
function Lightbox({
  src,
  alt,
  inline,
  onClose
}: {
  src: string
  alt?: string
  inline: InlineImage | null
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const showToast = useAppStore((state) => state.showToast)
  const t = useT()
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [saved, setSaved] = useState(false)
  // Escape and Tab are handled here, so the conversation's shortcuts stay off
  // while the picture is open; focus goes back to the trigger on close.
  useDialogFocus(dialogRef, onClose)

  const save = async () => {
    if (!inline) return
    try {
      const path = await window.pi.fs.saveImage(inline.data, inline.mimeType)
      if (!path) return
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1600)
      showToast(t('The image was saved'))
    } catch {
      showToast(t('The image could not be saved'), 'error')
    }
  }

  const kind = inline ? inline.mimeType.replace(/^image\//, '').toUpperCase() : null
  const meta = [size ? `${size.width} × ${size.height}` : null, kind].filter(Boolean).join(' · ')

  return createPortal(
    <div
      className="lightbox-layer"
      onMouseDown={(event) => {
        // Only the scrim itself closes; the picture and its header do not.
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="lightbox"
        role="dialog"
        aria-modal="true"
        aria-label={t('Image preview')}
        tabIndex={-1}
      >
        <div className="lightbox__head">
          <span className="lightbox__meta">{meta}</span>
          <span className="lightbox__actions">
            {inline ? (
              <button
                type="button"
                className="lightbox__btn"
                onClick={() => void save()}
                title={t('Save the image')}
              >
                {saved ? <Check size={14} /> : <Download size={14} />}
                {saved ? t('Saved') : t('Save')}
              </button>
            ) : null}
            <button
              type="button"
              className="lightbox__btn lightbox__btn--icon"
              onClick={onClose}
              title={t('Close')}
              aria-label={t('Close')}
            >
              <X size={15} />
            </button>
          </span>
        </div>
        <div className="lightbox__stage">
          <img
            src={src}
            alt={alt ?? ''}
            draggable={false}
            onLoad={(event) =>
              setSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight
              })
            }
          />
        </div>
      </div>
    </div>,
    document.body
  )
}
