import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Paperclip, Square, X } from 'lucide-react'
import { useAppStore, type QueueKind } from '../store/useAppStore'

export function Composer() {
  const send = useAppStore((state) => state.send)
  const stop = useAppStore((state) => state.stop)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const queue = useAppStore((state) => state.queue)
  const status = useAppStore((state) => state.status)
  const workspace = useAppStore((state) => state.workspace)

  const [text, setText] = useState('')
  const [images, setImages] = useState<{ data: string; mimeType: string }[]>([])
  const [kind, setKind] = useState<QueueKind>('steer')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const ready = status.phase === 'ready'

  useEffect(() => {
    const node = textareaRef.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 240)}px`
  }, [text])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !isStreaming) return
      event.preventDefault()
      void stop()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isStreaming, stop])

  const submit = () => {
    if (!text.trim() && !images.length) return
    void send(text, images, kind)
    setText('')
    setImages([])
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  const onFiles = (files: FileList | null) => {
    if (!files) return
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue
      const reader = new FileReader()
      reader.onload = () => {
        const result = String(reader.result ?? '')
        const base64 = result.split(',')[1]
        if (base64) setImages((current) => [...current, { data: base64, mimeType: file.type }])
      }
      reader.readAsDataURL(file)
    }
  }

  const pendingQueue = [
    ...queue.steering.map((value) => ({ kind: 'steer' as const, text: value })),
    ...queue.followUp.map((value) => ({ kind: 'followUp' as const, text: value }))
  ]

  return (
    <div className="composer-wrap">
      <div className="composer">
        {pendingQueue.length > 0 ? (
          <div className="composer__queue">
            {pendingQueue.map((entry, index) => (
              <div className="composer__queue-item" data-kind={entry.kind} key={index}>
                <span className="composer__queue-tag">
                  {entry.kind === 'steer' ? 'Steer' : 'Queue'}
                </span>
                <span className="composer__queue-text">{entry.text}</span>
              </div>
            ))}
          </div>
        ) : null}

        {images.length > 0 ? (
          <div className="composer__queue">
            <div className="composer__queue-item">
              {images.map((image, index) => (
                <span key={index} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <img
                    src={`data:${image.mimeType};base64,${image.data}`}
                    alt=""
                    style={{ width: 34, height: 34, borderRadius: 6, objectFit: 'cover' }}
                  />
                  <button
                    className="icon-btn"
                    style={{ width: 20, height: 20 }}
                    onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          className="composer__input"
          rows={1}
          value={text}
          disabled={!ready}
          placeholder={
            ready
              ? `Ask Pi to work in ${workspace?.name ?? 'this project'}…`
              : 'Open a project folder to start'
          }
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            const files = event.clipboardData?.files
            if (files && files.length) {
              event.preventDefault()
              onFiles(files)
            }
          }}
          onDrop={(event) => {
            event.preventDefault()
            onFiles(event.dataTransfer?.files ?? null)
          }}
        />

        <div className="composer__bar">
          <button
            className="icon-btn"
            title="Attach an image"
            disabled={!ready}
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip size={15} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              onFiles(event.target.files)
              event.target.value = ''
            }}
          />

          <div className="composer__hint">
            {isStreaming ? (
              <div className="segmented" title="How the next message is delivered">
                <button
                  data-active={kind === 'steer'}
                  onClick={() => setKind('steer')}
                  title="Deliver after the current tool calls finish"
                >
                  Steer
                </button>
                <button
                  data-active={kind === 'followUp'}
                  onClick={() => setKind('followUp')}
                  title="Deliver when the current run is done"
                >
                  Queue
                </button>
              </div>
            ) : (
              <span>
                <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
              </span>
            )}
          </div>

          {isStreaming ? (
            <>
              <button
                className="btn btn--danger"
                onClick={() => void stop()}
                title="Stop the current run (Esc)"
              >
                <Square size={12} fill="currentColor" />
                Stop
              </button>
              <button
                className="btn btn--primary"
                onClick={submit}
                disabled={!text.trim() && !images.length}
                title={
                  kind === 'steer'
                    ? 'Send now — Pi applies it after the current tool calls finish'
                    : 'Queue — Pi applies it when the current run is done'
                }
              >
                <ArrowUp size={14} />
                Send
              </button>
            </>
          ) : (
            <button className="btn btn--primary" onClick={submit} disabled={!ready}>
              <ArrowUp size={14} />
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
