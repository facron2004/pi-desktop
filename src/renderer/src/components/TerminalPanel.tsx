import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Copy, Eraser, Folder, Search, Square, SquareTerminal, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { formatDuration } from '../lib/format'
import { formatPlatformShortcut } from '../lib/shortcuts'
import { scrollBehavior } from '../lib/motion'
import { useT } from '../lib/i18n'
import { parseAnsi, stripAnsi, type AnsiSegment } from '../lib/ansi'

const MIN_TERMINAL_HEIGHT = 160
/** The drawer may not swallow the conversation above it. */
const MAX_TERMINAL_HEIGHT_RATIO = 0.65
const RESIZE_STEP = 16

function clampHeight(value: number): number {
  const max = Math.round(window.innerHeight * MAX_TERMINAL_HEIGHT_RATIO)
  return Math.max(MIN_TERMINAL_HEIGHT, Math.min(max, Math.round(value)))
}

function defaultTerminalHeight(): number {
  return clampHeight(window.innerHeight / 3)
}

function segmentClassName(segment: AnsiSegment): string {
  const names = ['terminal__seg']
  if (segment.tone) names.push(`terminal__seg--tone-${segment.tone}`)
  if (segment.bold) names.push('terminal__seg--bold')
  if (segment.dim) names.push('terminal__seg--dim')
  return names.join(' ')
}

/**
 * The output of one command, with SGR colour runs turned into spans.
 *
 * The stored text stays untouched: copy reads it with `stripAnsi`, so the
 * clipboard never carries escape bytes.
 */
function AnsiText({ text }: { text: string }) {
  const segments = useMemo(() => parseAnsi(text), [text])
  const styled = segments.some((segment) => segment.tone || segment.bold || segment.dim)
  if (!styled) {
    return (
      <pre className="terminal__output">
        {segments.map((segment) => segment.text).join('')}
      </pre>
    )
  }
  return (
    <pre className="terminal__output">
      {segments.map((segment, index) => (
        // The runs are cut out of the whole output again on every delta, and
        // the final response can replace that text outright, so the run's own
        // text is the stable part of the key; the index only keeps two
        // identical runs apart.
        <span key={`${segment.text}-${index}`} className={segmentClassName(segment)}>
          {segment.text}
        </span>
      ))}
    </pre>
  )
}

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

/** A command handed to the drawer from somewhere else in the app. */
export interface TerminalRunRequest {
  command: string
  /** Bumped for every hand-off, so the same command twice still runs twice. */
  seq: number
}

// The drawer can be closed and opened again; a shell remembers what it ran.
let rememberedHistory: string[] = []

/**
 * The command drawer.
 *
 * Every command goes through Pi's RPC `bash` command with an id prefixed
 * `terminal-`, so the streamed `bash_execution_update` events can be matched
 * here. The output of these commands is excluded from the model context — the
 * drawer is the user's terminal, not a conversation message.
 *
 * It runs in two places: horizontally under the thread, and vertically inside
 * the side panel. `embedded` is that difference — the height, the resize edge
 * and the Close button belong to the drawer, while the panel draws its own
 * header and closing.
 */
export function TerminalPanel({
  onClose,
  request,
  embedded = false
}: {
  onClose: () => void
  request?: TerminalRunRequest | null
  /** Draw as a column inside the side panel rather than a drawer. */
  embedded?: boolean
}) {
  const t = useT()
  const status = useAppStore((state) => state.status)
  const platform = useAppStore((state) => state.info?.platform)
  const workspace = useAppStore((state) => state.workspace)
  const showToast = useAppStore((state) => state.showToast)
  const storedHeight = useAppStore((state) => state.settings.terminalHeight)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const ready = status.phase === 'ready'

  const [blocks, setBlocks] = useState<TerminalBlock[]>([])
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>(rememberedHistory)
  // -1 means the input is the live draft rather than a recalled command.
  const [cursor, setCursor] = useState(-1)
  const [running, setRunning] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  // The drag updates this locally; the store only hears about it on release.
  const [height, setHeight] = useState(() =>
    typeof storedHeight === 'number' ? clampHeight(storedHeight) : defaultTerminalHeight()
  )
  const [filter, setFilter] = useState('')

  const inputRef = useRef<HTMLInputElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const stickRef = useRef(true)
  const draftRef = useRef('')
  const runningRef = useRef<string | null>(null)
  const ownerRef = useRef<string | undefined>(undefined)
  const sequenceRef = useRef(0)
  const heightRef = useRef(height)
  const draggingRef = useRef(false)
  // Command ids whose events land in this panel, and when they started.
  const activeRef = useRef<Set<string>>(new Set())
  const startedRef = useRef<Map<string, number>>(new Map())
  // Ids the reader stopped, so the block shows "Cancelled" even if Pi's
  // response does not say so itself.
  const stoppedRef = useRef<Set<string>>(new Set())

  // The filter only hides blocks; the log and the copy still hold everything.
  const filterQuery = filter.trim()
  const visibleBlocks = useMemo(() => {
    if (!filterQuery) return blocks
    const needle = filterQuery.toLowerCase()
    return blocks.filter(
      (block) =>
        block.command.toLowerCase().includes(needle) ||
        stripAnsi(block.output).toLowerCase().includes(needle)
    )
  }, [blocks, filterQuery])

  useEffect(() => {
    heightRef.current = height
  }, [height])

  // The stored value can land after the drawer mounted (bootstrap) or change
  // elsewhere; follow it unless a drag is in progress.
  useEffect(() => {
    if (draggingRef.current) return
    const next =
      typeof storedHeight === 'number' ? clampHeight(storedHeight) : defaultTerminalHeight()
    heightRef.current = next
    setHeight(next)
  }, [storedHeight])

  // Keep the responsive default in step with the window; custom heights only
  // shrink when needed to leave room for the conversation.
  useEffect(() => {
    const onWindowResize = () => {
      const next =
        typeof storedHeight === 'number'
          ? clampHeight(heightRef.current)
          : defaultTerminalHeight()
      heightRef.current = next
      setHeight(next)
    }
    window.addEventListener('resize', onWindowResize)
    return () => window.removeEventListener('resize', onWindowResize)
  }, [storedHeight])

  // A drag that ends in an unmount must not leave the resize cursor behind.
  useEffect(() => () => document.body.classList.remove('terminal-resizing'), [])

  // The streamed output is the full text; the final response may be the
  // truncated version of it, so the events are appended as they arrive.
  useEffect(() => {
    return window.pi.runtime.onEvent(({ event }) => {
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
      const sessionKey = ownerRef.current
      void window.pi.runtime
        .request('abort_bash', undefined, undefined, {
          sourceAction: 'terminal-close',
          uiSessionId: sessionKey
        }, sessionKey)
        .catch(() => {
          /* the runtime may be gone already */
        })
    },
    []
  )

  // Development-mode strict effects mount, unmount and mount again, and the
  // unmount half aborts whatever runs. A handed-over command therefore waits
  // one tick before it starts, and does nothing when the drawer really closed.
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useLayoutEffect(() => {
    const node = logRef.current
    if (!node || !stickRef.current) return
    node.scrollTop = node.scrollHeight
  }, [visibleBlocks, height])

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

  // The handle is the top edge of the drawer: dragging it up makes the drawer
  // taller. The height is local while the pointer is down and only the release
  // writes it to the settings, so a drag is one settings change rather than one
  // per pixel.
  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      const handle = event.currentTarget
      const startY = event.clientY
      const startHeight = heightRef.current
      draggingRef.current = true
      document.body.classList.add('terminal-resizing')

      const move = (moveEvent: PointerEvent) => {
        const next = clampHeight(startHeight + (startY - moveEvent.clientY))
        heightRef.current = next
        setHeight(next)
      }
      const finish = () => {
        if (!draggingRef.current) return
        draggingRef.current = false
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', finish)
        handle.removeEventListener('pointercancel', finish)
        handle.removeEventListener('lostpointercapture', finish)
        document.body.classList.remove('terminal-resizing')
        void updateSettings({ terminalHeight: heightRef.current })
      }

      handle.setPointerCapture(event.pointerId)
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', finish)
      handle.addEventListener('pointercancel', finish)
      handle.addEventListener('lostpointercapture', finish)
    },
    [updateSettings]
  )

  // The same handle works from the keyboard: arrows resize by a step, Escape
  // still belongs to the drawer.
  const resizeFromKeyboard = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? RESIZE_STEP * 4 : RESIZE_STEP
      let delta = 0
      if (event.key === 'ArrowUp') delta = step
      else if (event.key === 'ArrowDown') delta = -step
      else return
      event.preventDefault()
      const next = clampHeight(heightRef.current + delta)
      heightRef.current = next
      setHeight(next)
      void updateSettings({ terminalHeight: next })
    },
    [updateSettings]
  )

  const resetHeight = useCallback(() => {
    const next = defaultTerminalHeight()
    heightRef.current = next
    setHeight(next)
    void updateSettings({ terminalHeight: undefined })
  }, [updateSettings])

  // The one path a command takes, whether it was typed or handed over from a
  // card in the transcript: the id, the streaming, the history and the exit
  // code handling all live here rather than in a second runner.
  const submit = useCallback((override?: string) => {
    const command = (override ?? input).trim()
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
        const state = useAppStore.getState()
        const sessionKey = state.activeSessionFile ?? state.draftId
        ownerRef.current = sessionKey
        if (sessionKey && typeof window.pi.runtime.ensure === 'function') {
          const ensured = await window.pi.runtime.ensure({
            sessionKey,
            cwd: state.workspace?.path ?? '',
            sessionFile: sessionKey.startsWith('draft:') ? undefined : sessionKey,
            trace: { sourceAction: 'terminal-bash', uiSessionId: sessionKey }
          })
          if (!ensured.ok) throw new Error(ensured.error ?? 'Pi did not start')
        }
        if (!aliveRef.current || stoppedRef.current.has(id)) return
        const result = await window.pi.runtime.request<BashResult>(
          'bash',
          { command, id, excludeFromContext: true },
          0,
          { sourceAction: 'terminal-bash', uiSessionId: sessionKey },
          sessionKey
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
                  cancelled: result.cancelled === true || stoppedRef.current.has(id),
                  truncated: result.truncated === true,
                  fullOutputPath: result.fullOutputPath,
                  durationMs: started === undefined ? undefined : Date.now() - started
                }
              : block
          )
        )
      } catch (error) {
        const started = startedRef.current.get(id)
        const cancelled = stoppedRef.current.has(id)
        const message = error instanceof Error ? error.message : String(error)
        setBlocks((previous) =>
          previous.map((block) =>
            block.id === id
              ? {
                  ...block,
                  status: cancelled ? 'done' : 'error',
                  cancelled,
                  // A stop is not a failure: the partial output is all there is.
                  output: cancelled
                    ? block.output
                    : block.output
                      ? `${block.output}\n${message}`
                      : message,
                  durationMs: started === undefined ? undefined : Date.now() - started
                }
              : block
          )
        )
      } finally {
        activeRef.current.delete(id)
        startedRef.current.delete(id)
        stoppedRef.current.delete(id)
        runningRef.current = null
        setRunning(null)
        setStopping(false)
        requestAnimationFrame(() => inputRef.current?.focus())
      }
    })()
  }, [input, ready, history])

  // A command handed over from the transcript lands in the input and, when the
  // drawer is idle, runs through the same path as typing Enter. The sequence
  // number is remembered so a re-render does not run the same hand-off twice.
  const handledRequestRef = useRef(0)
  useEffect(() => {
    if (!request || request.seq === handledRequestRef.current) return
    handledRequestRef.current = request.seq
    const command = request.command.trim()
    if (!command) return
    setInput(command)
    setCursor(-1)
    draftRef.current = command
    // A command that is already running is not interleaved with another one:
    // the handed-over command waits in the input for the user to send it.
    if (ready && !runningRef.current) {
      // Deferred by a tick so a development-mode remount cannot abort the
      // command before it has started.
      window.setTimeout(() => {
        if (!aliveRef.current) return
        // A command started in the meantime keeps the input instead of being
        // cleared by a run that cannot happen.
        if (runningRef.current) {
          setInput(command)
          return
        }
        submit(command)
      }, 0)
      return
    }
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [request, ready, submit])

  // The Stop button and Ctrl+C share this path: the runtime is asked to abort
  // the command, and the block is marked cancelled straight away so the log
  // does not keep claiming that it runs.
  const stop = useCallback(async () => {
    const id = runningRef.current
    if (!id) return
    stoppedRef.current.add(id)
    setStopping(true)
    try {
      const sessionKey = ownerRef.current
      await window.pi.runtime.request('abort_bash', undefined, undefined, {
        sourceAction: 'terminal-stop',
        uiSessionId: sessionKey
      }, sessionKey)
      setBlocks((previous) =>
        previous.map((block) => (block.id === id ? { ...block, cancelled: true } : block))
      )
    } catch {
      stoppedRef.current.delete(id)
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
      .map((block) => {
        const output = stripAnsi(block.output)
        return output ? `$ ${block.command}\n${output}` : `$ ${block.command}`
      })
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
    // Control+C is the shell interrupt; Command+C must remain native copy on macOS.
    if (event.ctrlKey && event.key.toLowerCase() === 'c') {
      if (event.currentTarget.selectionStart !== event.currentTarget.selectionEnd) return
      event.preventDefault()
      if (runningRef.current) {
        void stop()
        return
      }
      setInput('')
      setCursor(-1)
      draftRef.current = ''
      return
    }
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
      data-embedded={embedded || undefined}
      // The drawer sets its own height and is dragged by its top edge; inside
      // the panel the column is the panel's height and the edge is not there.
      style={embedded ? undefined : { height: `${height}px` }}
      aria-label={t('Terminal')}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
          event.preventDefault()
          // The conversation search listens on the window for the same keys;
          // inside the terminal the filter owns them.
          event.stopPropagation()
          filterRef.current?.focus()
          filterRef.current?.select()
          return
        }
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
    >
      <div
        className="terminal__resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('Resize the terminal')}
        aria-valuenow={height}
        aria-valuemin={MIN_TERMINAL_HEIGHT}
        aria-valuemax={Math.max(MIN_TERMINAL_HEIGHT, Math.round(window.innerHeight * MAX_TERMINAL_HEIGHT_RATIO))}
        title={t('Drag to resize · double-click to reset')}
        tabIndex={embedded ? -1 : 0}
        onPointerDown={embedded ? undefined : startResize}
        onKeyDown={embedded ? undefined : resizeFromKeyboard}
        onDoubleClick={embedded ? undefined : resetHeight}
        hidden={embedded || undefined}
      />
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
        <div className="terminal__filter">
          <Search size={11} aria-hidden="true" />
          <input
            ref={filterRef}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              // An empty box lets Escape through, so the drawer still closes.
              if (!filterQuery) return
              event.preventDefault()
              event.stopPropagation()
              setFilter('')
            }}
            spellCheck={false}
            autoComplete="off"
            placeholder={t('Filter')}
            aria-label={t('Filter the output')}
          />
          {filter ? (
            <button
              type="button"
              className="terminal__filter-clear"
              title={t('Clear the filter')}
              aria-label={t('Clear the filter')}
              onClick={() => {
                setFilter('')
                filterRef.current?.focus()
              }}
            >
              <X size={10} />
            </button>
          ) : null}
        </div>
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
            aria-label={t('Copy the output')}
            onClick={() => void copyOutput()}
            disabled={!hasBlocks}
          >
            <Copy size={13} />
          </button>
          <button
            className="icon-btn"
            title={t('Clear')}
            aria-label={t('Clear')}
            onClick={clear}
            disabled={!hasBlocks}
          >
            <Eraser size={13} />
          </button>
          {embedded ? null : (
            <button className="icon-btn" title={t('Close')} aria-label={t('Close')} onClick={onClose}>
              <X size={14} />
            </button>
          )}
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

          {ready && hasBlocks && filterQuery && visibleBlocks.length === 0 ? (
            <div className="terminal__empty">{t('No commands match the filter.')}</div>
          ) : null}

          {visibleBlocks.map((block) => (
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
                <AnsiText text={block.output} />
              ) : block.status === 'running' ? (
                <pre className="terminal__output terminal__output--muted">
                  {t('Waiting for output…')}
                </pre>
              ) : null}
            </article>
          ))}
        </div>

        {!atBottom && hasBlocks ? (
          <button
            className="terminal__jump"
            onClick={scrollToBottom}
            title={t('Scroll to the latest')}
            aria-label={t('Scroll to the latest')}
          >
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
        <span className="terminal__hint">
          {formatPlatformShortcut(t('Enter to run · Ctrl+L to clear'), platform)}
        </span>
      </div>
    </section>
  )
}
