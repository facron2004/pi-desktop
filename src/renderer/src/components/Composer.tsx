import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  ListFilter,
  Paperclip,
  Plus,
  Sparkles,
  Square,
  Terminal,
  Wrench,
  X
} from 'lucide-react'
import { useAppStore, type QueueKind } from '../store/useAppStore'
import type { FileEntry, PiCommand } from '@shared/types'
import { filterCommands } from '../lib/commands'
import { relativePath } from '../lib/path'
import { useT } from '../lib/i18n'
import { CommandPalette } from './CommandPalette'
import { FileMention } from './FileMention'
import { ModelPicker } from './TopBar'
import { Popover } from './Popover'
import { ProjectSelector } from './ProjectSelector'
import { BranchMenu } from './BranchMenu'

interface SlashMatch {
  query: string
  start: number
  cursor: number
}

interface MentionMatch {
  query: string
  start: number
  cursor: number
}

type AddMenuPage = 'actions' | 'skills' | 'plugins'

/** Detect a `/command` token that ends at the caret. */
function detectSlash(text: string, cursor: number): SlashMatch | null {
  const before = text.slice(0, cursor)
  const match = before.match(/(?:^|\s)\/([\w:.-]*)$/)
  if (!match) return null
  const query = match[1]
  return { query, start: cursor - query.length - 1, cursor }
}

/**
 * Detect an `@file` token that ends at the caret.
 *
 * The `@` has to start a word, so an address in a sentence does not open the
 * file list.
 */
function detectMention(text: string, cursor: number): MentionMatch | null {
  const before = text.slice(0, cursor)
  const at = before.lastIndexOf('@')
  if (at === -1) return null
  if (at > 0 && !/\s/.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  if (/\s/.test(query)) return null
  return { query, start: at, cursor }
}

export function Composer() {
  const send = useAppStore((state) => state.send)
  const stop = useAppStore((state) => state.stop)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const aborting = useAppStore((state) => state.run.phase === 'aborting')
  const queue = useAppStore((state) => state.queue)
  const status = useAppStore((state) => state.status)
  const workspace = useAppStore((state) => state.workspace)
  const commands = useAppStore((state) => state.commands)
  const runAppCommand = useAppStore((state) => state.runAppCommand)
  const composerText = useAppStore((state) => state.composerText)
  const clearComposerText = useAppStore((state) => state.clearComposerText)
  const composerInsert = useAppStore((state) => state.composerInsert)
  const fontScale = useAppStore((state) => state.settings.fontScale ?? 1)
  const sendShortcut = useAppStore((state) => state.settings.sendShortcut ?? 'enter')
  const defaultFollowUpMode = useAppStore((state) => state.settings.followUpMode ?? 'steer')
  const plainTextEditor = useAppStore((state) => state.settings.plainTextEditor === true)
  const hasDialogue = useAppStore(
    (state) => state.items.length > 0 || Boolean(state.activeSessionFile)
  )
  const t = useT()
  const toast = useAppStore((state) => state.toast)

  const [text, setText] = useState('')
  const [images, setImages] = useState<{ data: string; mimeType: string }[]>([])
  const [kind, setKind] = useState<QueueKind>(defaultFollowUpMode === 'queue' ? 'followUp' : 'steer')

  useEffect(() => {
    setKind(defaultFollowUpMode === 'queue' ? 'followUp' : 'steer')
  }, [defaultFollowUpMode])
  const [slash, setSlash] = useState<SlashMatch | null>(null)
  const [mention, setMention] = useState<MentionMatch | null>(null)
  const [mentionFiles, setMentionFiles] = useState<FileEntry[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const [paletteIndex, setPaletteIndex] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [addMenuPage, setAddMenuPage] = useState<AddMenuPage>('actions')

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const mentionListRef = useRef<HTMLDivElement>(null)

  const ready = status.phase === 'ready'
  const inputPrompt = ready
    ? t('Describe a task, or use @ to reference project files…')
    : !workspace
      ? t('Open a project folder to start')
      : status.phase === 'starting'
        ? t('Starting the Pi runtime…')
        : status.phase === 'error'
          ? t('Pi unavailable')
          : t('Pi stopped')

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
      setMention(detectMention(prefill, cursor))
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
      setSlash(detectSlash(composerText, cursor))
      setMention(detectMention(composerText, cursor))
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
  const skillCommands = useMemo(
    () => commands.filter((command) => command.source === 'skill'),
    [commands]
  )
  const pluginCommands = useMemo(
    () => commands.filter((command) => command.source === 'extension'),
    [commands]
  )
  useEffect(() => {
    const node = textareaRef.current
    if (!node) return
    node.style.height = 'auto'
    const contentHeight = node.scrollHeight
    node.style.height = `${Math.min(contentHeight, 240)}px`
    node.style.overflowY = contentHeight > 240 ? 'auto' : 'hidden'
  }, [text, fontScale])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return
      if (document.querySelector('[aria-modal="true"]')) return
      if (event.key !== 'Escape' || !isStreaming) return
      // The palette uses Escape to close itself and handles the key before
      // it reaches the window, so the run is left alone.
      if (event.defaultPrevented) return
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

  useEffect(() => {
    mentionListRef.current
      ?.querySelector<HTMLElement>(`[data-active='true']`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [mentionIndex, mentionFiles])

  // The files that match the `@` in the composer. The search waits a moment,
  // so a fast typist does not walk the project over and over.
  useEffect(() => {
    if (!mention || !workspace?.path) {
      setMentionFiles([])
      return
    }
    setMentionFiles([])
    setMentionIndex(0)
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.pi.fs
        .search(mention.query, 12)
        .then((files) => {
          if (cancelled) return
          setMentionFiles(files)
          setMentionIndex(0)
        })
        .catch(() => {
          if (!cancelled) setMentionFiles([])
        })
    }, 110)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [mention, workspace?.path])

  const closePalette = useCallback(() => setSlash(null), [])

  /** Put the path of a picked file into the composer. */
  const insertMention = useCallback(
    (file: FileEntry) => {
      if (!mention) return
      // Pi writes its paths with slashes, even on Windows.
      const relative = relativePath(workspace?.path ?? '', file.path).replace(/\\/g, '/')
      const addition = `@${relative} `
      setText(`${text.slice(0, mention.start)}${addition}${text.slice(mention.cursor)}`)
      setMention(null)
      requestAnimationFrame(() => {
        const target = textareaRef.current
        if (!target) return
        const position = mention.start + addition.length
        target.focus()
        target.setSelectionRange(position, position)
      })
    },
    [mention, text, workspace?.path]
  )

  const insertCommand = useCallback(
    (command: PiCommand) => {
      // The app's own commands run right away; Pi's are text that is sent
      // to the agent. A command that needs an argument is typed instead.
      if (command.source === 'app' && !command.takesArgument) {
        setSlash(null)
        if (slash) {
          // The typed command is consumed by the app.
          const cursor = textareaRef.current?.selectionStart ?? text.length
          setText(`${text.slice(0, slash.start)}${text.slice(cursor)}`.trim())
        }
        void runAppCommand(command.name)
        return
      }
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
    [slash, text, runAppCommand]
  )

  const submit = useCallback(() => {
    if (!text.trim() && !images.length) return
    void send(text, images, kind)
    setHistory((current) => [text, ...current.filter((entry) => entry !== text)].slice(0, 50))
    setHistoryIndex(-1)
    setText('')
    setImages([])
    closePalette()
    setMention(null)
  }, [text, images, kind, send, closePalette])

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    // The file list comes first: an `@` in the text means the user is
    // pointing at a file, not at a command.
    if (mention) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMention(null)
        return
      }
      if (mentionFiles.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setMentionIndex((index) => (index + 1) % mentionFiles.length)
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setMentionIndex((index) => (index - 1 + mentionFiles.length) % mentionFiles.length)
          return
        }
        if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
          event.preventDefault()
          insertMention(mentionFiles[mentionIndex])
          return
        }
      }
    }

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

    const isEnter = event.key === 'Enter'
    const isCtrlEnter = isEnter && (event.ctrlKey || event.metaKey)
    const isPlainEnter = isEnter && !event.shiftKey && !event.ctrlKey && !event.metaKey

    if (sendShortcut === 'ctrlEnter') {
      if (isCtrlEnter) {
        event.preventDefault()
        submit()
        return
      }
    } else {
      if (isPlainEnter) {
        event.preventDefault()
        submit()
        return
      }
      if (isCtrlEnter) {
        event.preventDefault()
        setKind((current) => (current === 'steer' ? 'followUp' : 'steer'))
        submit()
        return
      }
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

  const insertProjectFile = useCallback(() => {
    const node = textareaRef.current
    const cursor = node?.selectionStart ?? text.length
    const before = text.slice(0, cursor)
    const marker = before === '' || /\s$/.test(before) ? '@' : ' @'
    const next = `${before}${marker}${text.slice(cursor)}`
    const position = cursor + marker.length
    setText(next)
    setSlash(null)
    setMention(detectMention(next, position))
    requestAnimationFrame(() => {
      const target = textareaRef.current
      if (!target) return
      target.focus()
      target.setSelectionRange(position, position)
    })
  }, [text])

  const insertMenuCommand = useCallback(
    (command: PiCommand) => {
      const prefix = text.trimEnd()
      const next = `${prefix ? `${prefix}\n` : ''}/${command.name} `
      setText(next)
      setSlash(null)
      setMention(null)
      requestAnimationFrame(() => {
        const target = textareaRef.current
        if (!target) return
        target.focus()
        target.setSelectionRange(next.length, next.length)
      })
    },
    [text]
  )

  const pendingQueue = [
    ...queue.steering.map((value) => ({ kind: 'steer' as const, text: value })),
    ...queue.followUp.map((value) => ({ kind: 'followUp' as const, text: value }))
  ]
  const addMenuCommands = addMenuPage === 'skills' ? skillCommands : pluginCommands

  return (
    <div className="composer-wrap">
      <div className="composer-stack">
        {slash && !mention ? (
          <CommandPalette
            commands={matching}
            query={slash.query}
            activeIndex={paletteIndex}
            onActiveChange={setPaletteIndex}
            onSelect={insertCommand}
          />
        ) : null}

        {mention ? (
          <FileMention
            listRef={mentionListRef}
            files={mentionFiles}
            root={workspace?.path}
            activeIndex={mentionIndex}
            onActiveChange={setMentionIndex}
            onSelect={insertMention}
          />
        ) : null}

        {!hasDialogue ? (
          <div className="composer__top-selectors">
            <ProjectSelector placement="top" align="left" />
            {workspace ? (
              <BranchMenu
                placement="top"
                align="left"
                onOpenChanges={() => {
                  window.dispatchEvent(
                    new CustomEvent('pi:open-inspector', { detail: { tab: 'changes' } })
                  )
                }}
              />
            ) : null}
          </div>
        ) : null}

        <div
          className="composer"
          data-streaming={isStreaming}
          data-has-content={Boolean(text.trim() || images.length > 0)}
        >
          {toast ? (
            <div className="composer__notice" data-level={toast.level}>
              {t(toast.text)}
            </div>
          ) : null}

          {pendingQueue.length > 0 ? (
            <div className="composer__queue">
              {pendingQueue.map((entry, index) => (
                <div className="composer__queue-item" data-kind={entry.kind} key={index}>
                  <span className="composer__queue-tag">
                    {entry.kind === 'steer' ? t('Steer') : t('Queue')}
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
                      aria-label={`${t('Remove image')} ${index + 1}`}
                      title={`${t('Remove image')} ${index + 1}`}
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
            aria-label={inputPrompt}
            placeholder={inputPrompt}
            onChange={(event) => {
              const value = event.target.value
              const cursor = event.target.selectionStart ?? value.length
              setText(value)
              setSlash(detectSlash(value, cursor))
              setMention(detectMention(value, cursor))
              setPaletteIndex(0)
            }}
            onKeyDown={onKeyDown}
            onClick={(event) => {
              const cursor = event.currentTarget.selectionStart ?? text.length
              setSlash(detectSlash(text, cursor))
              setMention(detectMention(text, cursor))
            }}
            onBlur={() => {
              // Let a click on a list item land before the list disappears.
              window.setTimeout(() => {
                setSlash(null)
                setMention(null)
              }, 120)
            }}
            onPaste={(event) => {
              if (plainTextEditor) {
                const textOnly = event.clipboardData?.getData('text/plain')
                if (textOnly && !event.clipboardData?.files?.length) {
                  event.preventDefault()
                  document.execCommand('insertText', false, textOnly)
                  return
                }
              }
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

          <div className="composer__bar" data-streaming={isStreaming} data-ready={ready}>
            <Popover
              placement="top"
              width={270}
              className="composer__add-popover"
              renderTrigger={({ open, toggle }) => (
                <button
                  className="icon-btn composer__add-trigger"
                  aria-label={t('Add to message')}
                  title={t('Add to message')}
                  aria-expanded={open}
                  disabled={!ready}
                  onClick={(event) => {
                    if (!open) setAddMenuPage('actions')
                    toggle(event)
                  }}
                >
                  <Plus size={17} />
                </button>
              )}
            >
              {(close) =>
                addMenuPage === 'actions' ? (
                  <div>
                    <div className="popover__label">{t('Add to message')}</div>
                    <button
                      className="popover__item"
                      onClick={() => {
                        close()
                        openPaletteManually()
                      }}
                    >
                      <Terminal size={14} />
                      <span className="popover__item-text">{t('Browse commands')}</span>
                    </button>
                    <button
                      className="popover__item"
                      onClick={() => {
                        close()
                        fileRef.current?.click()
                      }}
                    >
                      <Paperclip size={14} />
                      <span className="popover__item-text">{t('Add image attachment')}</span>
                    </button>
                    <button
                      className="popover__item"
                      onClick={() => {
                        close()
                        insertProjectFile()
                      }}
                    >
                      <FolderOpen size={14} />
                      <span className="popover__item-text">{t('Insert a project file')}</span>
                    </button>
                    <button className="popover__item" onClick={() => setAddMenuPage('skills')}>
                      <Sparkles size={14} />
                      <span className="popover__item-text">{t('Skills')}</span>
                      <span className="composer__add-count">{skillCommands.length}</span>
                      <ChevronRight size={13} />
                    </button>
                    <button className="popover__item" onClick={() => setAddMenuPage('plugins')}>
                      <Wrench size={14} />
                      <span className="popover__item-text">{t('Plugins')}</span>
                      <span className="composer__add-count">{pluginCommands.length}</span>
                      <ChevronRight size={13} />
                    </button>
                  </div>
                ) : (
                  <div>
                    <div className="composer__add-head">
                      <button
                        className="icon-btn composer__add-back"
                        aria-label={t('Back')}
                        title={t('Back')}
                        onClick={() => setAddMenuPage('actions')}
                      >
                        <ChevronLeft size={14} />
                      </button>
                      <div className="popover__label">
                        {t(addMenuPage === 'skills' ? 'Skills' : 'Plugins')}
                      </div>
                      <span className="composer__add-count">
                        {addMenuPage === 'skills' ? skillCommands.length : pluginCommands.length}
                      </span>
                    </div>
                    {addMenuCommands.length ? (
                      <div className="composer__add-list">
                        {addMenuCommands.map((command) => (
                          <button
                            key={`${command.source}-${command.name}`}
                            className="popover__item composer__add-command"
                            title={command.description}
                            onClick={() => {
                              close()
                              insertMenuCommand(command)
                            }}
                          >
                            <span className="composer__add-command-name">/{command.name}</span>
                            {command.description ? (
                              <span className="composer__add-command-description">
                                {command.description}
                              </span>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="composer__add-empty">
                        {t(addMenuPage === 'skills' ? 'No skills available' : 'No plugins available')}
                      </div>
                    )}
                  </div>
                )
              }
            </Popover>
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

            <div className="composer__bar-spacer" />

            {ready ? <ModelPicker /> : null}

            {isStreaming ? (
              <Popover
                placement="top"
                width={230}
                className="composer__delivery-popover"
                renderTrigger={({ open, toggle }) => (
                  <button
                    className="icon-btn composer__delivery"
                    aria-label={t('How the next message is delivered')}
                    title={t('How the next message is delivered')}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    onClick={toggle}
                  >
                    <ListFilter size={15} />
                  </button>
                )}
              >
                {(close) => (
                  <div role="menu" aria-label={t('How the next message is delivered')}>
                    <div className="popover__label">
                      {t('How the next message is delivered')}
                    </div>
                    <button
                      className="popover__item composer__delivery-option"
                      type="button"
                      role="menuitemradio"
                      aria-checked={kind === 'steer'}
                      data-active={kind === 'steer'}
                      onClick={() => {
                        setKind('steer')
                        close()
                      }}
                    >
                      <span className="composer__delivery-option-title">{t('Steer')}</span>
                      <span className="composer__delivery-option-description">
                        {t('Deliver after the current tool calls finish')}
                      </span>
                    </button>
                    <button
                      className="popover__item composer__delivery-option"
                      type="button"
                      role="menuitemradio"
                      aria-checked={kind === 'followUp'}
                      data-active={kind === 'followUp'}
                      onClick={() => {
                        setKind('followUp')
                        close()
                      }}
                    >
                      <span className="composer__delivery-option-title">{t('Queue')}</span>
                      <span className="composer__delivery-option-description">
                        {t('Deliver when the current run is done')}
                      </span>
                    </button>
                  </div>
                )}
              </Popover>
            ) : null}

            {isStreaming ? (
              <button
                type="button"
                className="btn composer__send composer__send--stop"
                data-aborting={aborting || undefined}
                disabled={aborting}
                onClick={() => void stop()}
                aria-label={aborting ? t('Stopping…') : t('Stop the current run (Esc)')}
                title={aborting ? t('Stopping…') : t('Stop the current run (Esc)')}
              >
                <Square size={12} fill="currentColor" strokeWidth={0} />
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--primary composer__send"
                onClick={submit}
                disabled={!ready || (!text.trim() && !images.length)}
                aria-label={t('Send message')}
                title={t('Send message')}
              >
                <ArrowUp size={18} strokeWidth={2.6} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
