import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Paperclip, Square, Terminal, X } from 'lucide-react'
import { useAppStore, type QueueKind } from '../store/useAppStore'
import type { PiCommand } from '@shared/types'
import { CommandPalette, filterCommands } from './CommandPalette'

interface SlashMatch {
  query: string
  start: number
  cursor: number
}

/** Detect a `/command` token that ends at the caret. */
function detectSlash(text: string, cursor: number): SlashMatch | null {
  const before = text.slice(0, cursor)
  const match = before.match(/(?:^|\s)\/([\w:.-]*)$/)
  if (!match) return null
  const query = match[1]
  return { query, start: cursor - query.length - 1, cursor }
}

export function Composer() {
  const send = useAppStore((state) => state.send)
  const stop = useAppStore((state) => state.stop)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const queue = useAppStore((state) => state.queue)
  const status = useAppStore((state) => state.status)
  const workspace = useAppStore((state) => state.workspace)
  const commands = useAppStore((state) => state.commands)
  const composerText = useAppStore((state) => state.composerText)
  const clearComposerText = useAppStore((state) => state.clearComposerText)
  const composerInsert = useAppStore((state) => state.composerInsert)

  const [text, setText] = useState('')
  const [images, setImages] = useState<{ data: string; mimeType: string }[]>([])
  const [kind, setKind] = useState<QueueKind>('steer')
  const [slash, setSlash] = useState<SlashMatch | null>(null)
  const [paletteIndex, setPaletteIndex] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const ready = status.phase === 'ready'

  useEffect(() => {
    const focus = () => {
      const node = textareaRef.current
      if (!node) return
      node.focus()
      const end = node.value.length
      node.setSelectionRange(end, end)
    }
    window.addEventListener('pi:focus-composer', focus)
    return () => window.removeEventListener('pi:focus-composer', focus)
  }, [])

  // Development aid: prefill the composer so screenshots can show the
  // command palette. Set by the main process via PI_DESKTOP_PREFILL.
  useEffect(() => {
    const prefill = (window as unknown as { __piDesktopDev?: { prefill?: string } })
      .__piDesktopDev?.prefill
    if (!prefill) return
    setText(prefill)
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      const cursor = prefill.length
      node.focus()
      node.setSelectionRange(cursor, cursor)
      setSlash(detectSlash(prefill, cursor))
    })
  }, [])

  // An extension can prefill the editor through `set_editor_text`.
  useEffect(() => {
    if (composerText === undefined) return
    setText(composerText)
    clearComposerText()
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      const cursor = composerText.length
      node.focus()
      node.setSelectionRange(cursor, cursor)
    })
  }, [composerText, clearComposerText])

  // A tool card can hand a command or a path back to the composer, and a
  // branch puts the original prompt back so it can be tweaked and sent again.
  const insertSeq = useRef(0)
  useEffect(() => {
    if (!composerInsert || composerInsert.seq === insertSeq.current) return
    insertSeq.current = composerInsert.seq
    const addition = composerInsert.text
    const replace = composerInsert.mode === 'replace'
    setText((current) => {
      if (replace) return addition
      return current.trim() ? `${current.trimEnd()}\n${addition}` : addition
    })
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      const cursor = node.value.length
      node.focus()
      node.setSelectionRange(cursor, cursor)
    })
  }, [composerInsert])

  const matching = useMemo(
    () => (slash ? filterCommands(commands, slash.query) : []),
    [commands, slash]
  )
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

  // Keep the highlighted command in view when the list changes.
  useEffect(() => {
    setPaletteIndex((index) => Math.min(index, Math.max(0, matching.length - 1)))
  }, [matching.length])

  const closePalette = useCallback(() => setSlash(null), [])

  const insertCommand = useCallback(
    (command: PiCommand) => {
      if (!slash) return
      const node = textareaRef.current
      const cursor = node?.selectionStart ?? slash.cursor
      const next = `${text.slice(0, slash.start)}/${command.name} ${text.slice(cursor)}`
      setText(next)
      setSlash(null)
      requestAnimationFrame(() => {
        const target = textareaRef.current
        if (!target) return
        const position = slash.start + command.name.length + 2
        target.focus()
        target.setSelectionRange(position, position)
      })
    },
    [slash, text]
  )

  const submit = useCallback(() => {
    if (!text.trim() && !images.length) return
    void send(text, images, kind)
    setHistory((current) => [text, ...current.filter((entry) => entry !== text)].slice(0, 50))
    setHistoryIndex(-1)
    setText('')
    setImages([])
    closePalette()
  }, [text, images, kind, send, closePalette])

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash && matching.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setPaletteIndex((index) => (index + 1) % matching.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setPaletteIndex((index) => (index - 1 + matching.length) % matching.length)
        return
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault()
        insertCommand(matching[paletteIndex])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        closePalette()
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
      return
    }

    // Recall previous prompts with the arrow keys when the composer is empty.
    if (event.key === 'ArrowUp' && !event.shiftKey && !text) {
      if (!history.length) return
      event.preventDefault()
      const next = Math.min(historyIndex + 1, history.length - 1)
      setHistoryIndex(next)
      setText(history[next])
      return
    }
    if (event.key === 'ArrowDown' && !event.shiftKey && historyIndex >= 0) {
      event.preventDefault()
      const next = historyIndex - 1
      setHistoryIndex(next)
      setText(next < 0 ? '' : history[next])
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

  const openPaletteManually = () => {
    const node = textareaRef.current
    const cursor = node?.selectionStart ?? text.length
    const prefix = text.slice(0, cursor)
    const startsClean = prefix === '' || /\s$/.test(prefix)
    const next = startsClean ? `${prefix}/` : `${prefix} /`
    setText(next)
    requestAnimationFrame(() => {
      const target = textareaRef.current
      if (!target) return
      const position = next.length
      target.focus()
      target.setSelectionRange(position, position)
      setSlash(detectSlash(next, position))
    })
  }

  const pendingQueue = [
    ...queue.steering.map((value) => ({ kind: 'steer' as const, text: value })),
    ...queue.followUp.map((value) => ({ kind: 'followUp' as const, text: value }))
  ]

  return (
    <div className="composer-wrap">
      <div className="composer-stack">
        {slash ? (
          <CommandPalette
            commands={matching}
            query={slash.query}
            activeIndex={paletteIndex}
            onActiveChange={setPaletteIndex}
            onSelect={insertCommand}
          />
        ) : null}

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
                ? `Ask Pi to work in ${workspace?.name ?? 'this project'} — or type / for commands`
                : 'Open a project folder to start'
            }
            onChange={(event) => {
              const value = event.target.value
              const cursor = event.target.selectionStart ?? value.length
              setText(value)
              setSlash(detectSlash(value, cursor))
              setPaletteIndex(0)
            }}
            onKeyDown={onKeyDown}
            onClick={(event) => {
              const cursor = event.currentTarget.selectionStart ?? text.length
              setSlash(detectSlash(text, cursor))
            }}
            onBlur={() => {
              // Let a click on a palette item land before the list disappears.
              window.setTimeout(() => setSlash(null), 120)
            }}
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
            <button
              className="icon-btn"
              title="Browse commands"
              disabled={!ready || commands.length === 0}
              onClick={openPaletteManually}
            >
              <Terminal size={15} />
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
                  <kbd>Enter</kbd> to send · <kbd>↑</kbd> for history · type <kbd>/</kbd> for
                  commands
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
              <button
                className="btn btn--primary"
                onClick={submit}
                disabled={!ready || (!text.trim() && !images.length)}
              >
                <ArrowUp size={14} />
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
