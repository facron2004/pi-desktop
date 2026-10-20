import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, Copy, Eraser, Folder, Square, SquareTerminal, X } from 'lucide-react'
import type { PiEvent } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { formatDuration } from '../lib/format'
import { scrollBehavior } from '../lib/motion'
import { useT } from '../lib/i18n'

/** The payload of Pi's `bash` command, as far as the panel cares. */
interface BashResult {
  output?: string
  exitCode?: number
  cancelled?: boolean
  truncated?: boolean
  fullOutputPath?: string
}

interface TerminalBlock {
  /** The command id, shared with the `bash_execution_update` events it emits. */
  id: string
  command: string
  output: string
  status: 'running' | 'done' | 'error'
  exitCode?: number
  cancelled?: boolean
  truncated?: boolean
  fullOutputPath?: string
  durationMs?: number
}

// The drawer can be closed and opened again; a shell remembers what it ran.
let rememberedHistory: string[] = []

/**
 * The command drawer under the conversation.
 *
 * Every command goes through Pi's RPC `bash` command with an id prefixed
 * `terminal-`, so the streamed `bash_execution_update` events can be matched
 * here. The output of these commands is excluded from the model context — the
 * drawer is the user's terminal, not a conversation message.
 */
export function TerminalPanel({ onClose }: { onClose: () => void }) {
  const t = useT()
  const status = useAppStore((state) => state.status)
  const workspace = useAppStore((state) => state.workspace)
  const showToast = useAppStore((state) => state.showToast)
  const ready = status.phase === 'ready'

  const [blocks, setBlocks] = useState<TerminalBlock[]>([])
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>(rememberedHistory)
  // -1 means the input is the live draft rather than a recalled command.
  const [cursor, setCursor] = useState(-1)
  const [running, setRunning] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const [atBottom, setAtBottom] = useState(true)

  const inputRef = useRef<HTMLInputElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const draftRef = useRef('')
  const runningRef = useRef<string | null>(null)
  const sequenceRef = useRef(0)
  // Command ids whose events land in this panel, and when they started.
  const activeRef = useRef<Set<string>>(new Set())
  const startedRef = useRef<Map<string, number>>(new Map())

  // The streamed output is the full text; the final response may be the
  // truncated version of it, so the events are appended as they arrive.
  useEffect(() => {
    return window.pi.runtime.onEvent((event: PiEvent) => {
      if (event.type !== 'bash_execution_update') return
      const id = typeof event.id === 'string' ? event.id : ''
      if (!id.startsWith('terminal-') || !activeRef.current.has(id)) return
      const delta = typeof event.delta === 'string' ? event.delta : ''
      if (!delta) return
      setBlocks((previous) =>
        previous.map((block) =>
          block.id === id ? { ...block, output: block.output + delta } : block
        )
      )
    })
  }, [])

  // Opened from the titlebar, the palette or `Ctrl+\`` — the caret belongs in
  // the input so the drawer is ready to type in.
  useEffect(() => {
    if (!ready) return
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [ready])

  // A command belongs to the project it ran in; switching projects empties the
  // log rather than showing another folder's output under its name.
  const rootRef = useRef(workspace?.path)
  useEffect(() => {
    if (rootRef.current === workspace?.path) return
    rootRef.current = workspace?.path
    setBlocks([])
  }, [workspace?.path])

  // Closing the drawer stops the command it was running, the way closing a
  // terminal does.
  useEffect(
    () => () => {
      if (!runningRef.current) return
      void window.pi.runtime.request('abort_bash').catch(() => {
        /* the runtime may be gone already */
      })
    },
    []
  )

  useLayoutEffect(() => {
    const node = logRef.current
    if (!node || !stickRef.current) return
    node.scrollTop = node.scrollHeight
  }, [blocks])

  // The reader can scroll up to read an earlier command; from then on the log
  // stays where it is instead of jumping to the newest output.
  useEffect(() => {
    const node = logRef.current
    if (!node) return
    const onScroll = () => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight
      stickRef.current = distance < 24
      setAtBottom(stickRef.current)
    }
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => node.removeEventListener('scroll', onScroll)
  }, [])

  const scrollToBottom = useCallback(() => {
    const node = logRef.current
    if (!node) return
    stickRef.current = true
    setAtBottom(true)
    node.scrollTo({ top: node.scrollHeight, behavior: scrollBehavior() })
  }, [])

  const submit = useCallback(() => {
    const command = input.trim()
    if (!command || runningRef.current || !ready) return
    const id = `terminal-${Date.now().toString(36)}-${++sequenceRef.current}`
    runningRef.current = id
    activeRef.current.add(id)
    startedRef.current.set(id, Date.now())
    setRunning(id)
    setStopping(false)
    setInput('')
    setCursor(-1)
    draftRef.current = ''
    stickRef.current = true
    setAtBottom(true)
    setBlocks((previous) => [...previous, { id, command, output: '', status: 'running' }])

    const nextHistory =
      history[history.length - 1] === command ? history : [...history, command]
    rememberedHistory = nextHistory
    setHistory(nextHistory)

    void (async () => {
      try {
        const result = await window.pi.runtime.request<BashResult>(
          'bash',
          { command, id, excludeFromContext: true },
          0
        )
        const started = startedRef.current.get(id)
        // The streamed text is the complete output; the response may carry
        // only the truncated version, but it is the fallback when the events
        // did not make it here.
        setBlocks((previous) =>
          previous.map((block) =>
            block.id === id
              ? {
                  ...block,
                  output:
                    block.output.length >= (result.output ?? '').length
                      ? block.output
                      : result.output ?? '',
                  status: 'done',
                  exitCode: typeof result.exitCode === 'number' ? result.exitCode : undefined,
                  cancelled: result.cancelled === true,
                  truncated: result.truncated === true,
                  fullOutputPath: result.fullOutputPath,
                  durationMs: started === undefined ? undefined : Date.now() - started
                }
              : block
          )
        )
      } catch (error) {
        const started = startedRef.current.get(id)
        const message = error instanceof Error ? error.message : String(error)
        setBlocks((previous) =>
          previous.map((block) =>
            block.id === id
              ? {
                  ...block,
                  status: 'error',
                  output: block.output ? `${block.output}\n${message}` : message,
                  durationMs: started === undefined ? undefined : Date.now() - started
                }
              : block
          )
        )
      } finally {
        activeRef.current.delete(id)
        startedRef.current.delete(id)
        runningRef.current = null
        setRunning(null)
        setStopping(false)
        requestAnimationFrame(() => inputRef.current?.focus())
      }
    })()
  }, [input, ready, history])

  const stop = useCallback(async () => {
    if (!runningRef.current) return
    setStopping(true)
    try {
      await window.pi.runtime.request('abort_bash')
    } catch {
      setStopping(false)
    }
  }, [])

  const clear = useCallback(() => {
    setBlocks([])
    stickRef.current = true
    setAtBottom(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  const copyOutput = useCallback(async () => {
    const text = blocks
      .map((block) => (block.output ? `$ ${block.command}\n${block.output}` : `$ ${block.command}`))
      .join('\n')
    if (!text.trim()) {
      showToast(t('There is nothing to copy yet'), 'warning')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      showToast(t('Copied to clipboard'))
    } catch {
      showToast(t('The clipboard is not available'), 'error')
    }
  }, [blocks, showToast, t])

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault()
      clear()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
      return
    }
    if (event.key === 'ArrowUp') {
      if (!history.length) return
      event.preventDefault()
      if (cursor === -1) draftRef.current = input
      const next = cursor === -1 ? history.length - 1 : Math.max(0, cursor - 1)
      setCursor(next)
      setInput(history[next])
      return
    }
    if (event.key === 'ArrowDown') {
      if (cursor === -1) return
      event.preventDefault()
      const next = cursor + 1
      if (next >= history.length) {
        setCursor(-1)
        setInput(draftRef.current)
        return
      }
      setCursor(next)
      setInput(history[next])
    }
  }

  const hasBlocks = blocks.length > 0

  return (
    <section
      className="terminal"
      aria-label={t('Terminal')}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
    >
      <header className="terminal__head">
        <SquareTerminal size={13} className="terminal__head-icon" />
        <span className="terminal__title">{t('Terminal')}</span>
        {workspace ? (
          <span className="terminal__folder" title={workspace.path}>
            <Folder size={11} />
            <span>{workspace.name}</span>
          </span>
        ) : null}
        {running ? (
          <span className="terminal__running">
            <span className="terminal__pulse" />
            {stopping ? t('Stopping…') : t('running…')}
          </span>
        ) : null}
        <span className="terminal__spacer" />
        <div className="terminal__actions">
          {running ? (
            <button className="ghost-btn" onClick={() => void stop()} disabled={stopping}>
              <Square size={9} />
              {t('Stop')}
            </button>
          ) : null}
          <button
            className="icon-btn"
            title={t('Copy the output')}
            onClick={() => void copyOutput()}
            disabled={!hasBlocks}
          >
            <Copy size={13} />
          </button>
          <button
            className="icon-btn"
            title={t('Clear')}
            onClick={clear}
            disabled={!hasBlocks}
          >
            <Eraser size={13} />
          </button>
          <button className="icon-btn" title={t('Close')} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </header>

      <div className="terminal__body">
        <div className="terminal__log" ref={logRef} role="log" aria-label={t('Terminal output')}>
          {!ready ? (
            <div className="terminal__notice" role="status">
              <span className="terminal__notice-title">{t('The terminal needs the Pi runtime.')}</span>
              <span className="terminal__notice-text">
                {status.error ?? t('Open a project to start Pi, then run commands here.')}
              </span>
            </div>
          ) : null}

          {ready && !hasBlocks ? (
            <div className="terminal__empty">{t('Run a command in the workspace…')}</div>
          ) : null}

          {blocks.map((block) => (
            <article className="terminal__block" key={block.id}>
              <div className="terminal__command">
                <span className="terminal__prompt" aria-hidden="true">
                  $
                </span>
                <span className="terminal__cmd">{block.command}</span>
                <span className="terminal__meta">
                  {block.status === 'running' ? (
                    <span className="terminal__meta-item" data-kind="running">
                      {t('running…')}
                    </span>
                  ) : block.cancelled ? (
                    <span className="terminal__meta-item" data-kind="warn">
                      {t('Cancelled')}
                    </span>
                  ) : block.status === 'error' ? (
                    <span className="terminal__meta-item" data-kind="bad">
                      {t('Failed')}
                    </span>
                  ) : (
                    <span
                      className="terminal__meta-item"
                      data-kind={block.exitCode === 0 ? 'ok' : 'bad'}
                    >
                      {t('exit')} {block.exitCode ?? '—'}
                    </span>
                  )}
                  {block.truncated ? (
                    <span className="terminal__badge" title={block.fullOutputPath}>
                      {t('truncated')}
                    </span>
                  ) : null}
                  {block.durationMs === undefined ? null : (
                    <span className="terminal__meta-item">{formatDuration(block.durationMs)}</span>
                  )}
                </span>
              </div>
              {block.output ? (
                <pre className="terminal__output">{block.output}</pre>
              ) : block.status === 'running' ? (
                <pre className="terminal__output terminal__output--muted">
                  {t('Waiting for output…')}
                </pre>
              ) : null}
            </article>
          ))}
        </div>

        {!atBottom && hasBlocks ? (
          <button className="terminal__jump" onClick={scrollToBottom} title={t('Scroll to the latest')}>
            <ArrowDown size={11} />
            {t('Latest')}
          </button>
        ) : null}
      </div>

      <div className="terminal__input-row">
        <span className="terminal__prompt" aria-hidden="true">
          $
        </span>
        <input
          ref={inputRef}
          className="terminal__input"
          value={input}
          disabled={!ready}
          spellCheck={false}
          autoComplete="off"
          aria-label={t('Run command')}
          placeholder={
            ready ? t('Type a command and press Enter') : t('Pi is not running')
          }
          onChange={(event) => {
            setInput(event.target.value)
            setCursor(-1)
          }}
          onKeyDown={onInputKeyDown}
        />
        <span className="terminal__hint">{t('Enter to run · Ctrl+L to clear')}</span>
      </div>
    </section>
  )
}
