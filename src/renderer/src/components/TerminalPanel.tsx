import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react'
import { Copy, Eraser, Plus, RotateCcw, SquareTerminal, X } from 'lucide-react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useAppStore } from '../store/useAppStore'
import { useIsDark } from '../lib/theme'
import { useT } from '../lib/i18n'

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

function cssValue(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/** The terminal follows the app's canvas, not its own hard-coded palette. */
function terminalTheme(isDark: boolean) {
  return {
    background: cssValue('--surface-sunken', isDark ? '#0d0f13' : '#f2f2f2'),
    foreground: cssValue('--text-primary', isDark ? '#f2f4f8' : '#242424'),
    cursor: cssValue('--accent', isDark ? '#4c9aff' : '#292929'),
    cursorAccent: cssValue('--surface-sunken', isDark ? '#0d0f13' : '#f2f2f2'),
    selectionBackground: cssValue('--accent-soft', isDark ? 'rgba(76,154,255,.25)' : '#d8d8d8')
  }
}

/** A command handed to the terminal from somewhere else in the app. */
export interface TerminalRunRequest {
  command: string
  /** Bumped for every hand-off, so the same command twice still runs twice. */
  seq: number
}

export interface TerminalPaneHandle {
  /** The whole visible buffer, for the copy action. */
  copySelection(): string
  clear(): void
  restart(): void
  focus(): void
}

interface TerminalPaneProps {
  active: boolean
  cwd?: string
  shell: string
  request?: TerminalRunRequest | null
  /** The shell name, once the PTY reports it, for the tab label. */
  onLabel: (label: string) => void
}

/**
 * One real shell on one PTY, with its own xterm screen.
 *
 * Each tab keeps its own pane alive while another tab is in front, so the
 * scrollback of a terminal survives a switch instead of being replayed into a
 * shared screen. The pane owns nothing but its own process and viewport.
 */
const TerminalPane = forwardRef<TerminalPaneHandle, TerminalPaneProps>(function TerminalPane(
  { active, cwd, shell, request, onLabel },
  ref
) {
  const t = useT()
  const showToast = useAppStore((state) => state.showToast)
  const isDark = useIsDark()

  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<string | null>(null)
  const pendingOutputRef = useRef('')
  const pendingRequestRef = useRef<string | null>(null)
  const handledRequestRef = useRef(0)
  const onLabelRef = useRef(onLabel)
  onLabelRef.current = onLabel

  const [exited, setExited] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restartKey, setRestartKey] = useState(0)

  useImperativeHandle(
    ref,
    () => ({
      copySelection() {
        const term = termRef.current
        if (!term) return ''
        term.selectAll()
        const text = term.getSelection()
        term.clearSelection()
        return text
      },
      clear() {
        termRef.current?.clear()
        termRef.current?.focus()
      },
      restart() {
        setRestartKey((value) => value + 1)
      },
      focus() {
        termRef.current?.focus()
      }
    }),
    []
  )

  // Create the shell and the screen together. The xterm instance is created
  // first so the first PTY write already knows the viewport size.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    setExited(null)
    setError(null)
    pendingOutputRef.current = ''
    pendingRequestRef.current = null

    const term = new XTerm({
      allowTransparency: false,
      cursorBlink: true,
      convertEol: false,
      scrollback: 8000,
      fontFamily: cssValue('--font-mono', 'Consolas, monospace'),
      fontSize: 12,
      lineHeight: 1.35,
      theme: terminalTheme(isDark)
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    try {
      fit.fit()
    } catch {
      /* the panel may be measured before its first layout */
    }
    termRef.current = term
    fitRef.current = fit

    let disposed = false
    let resizeFrame = 0
    // Only the window between the mount and our own `create` resolving may
    // buffer unknown-id output. Anything after that belongs to another
    // session — typically a sibling tab — and would paint its banner here.
    let awaitingCreate = true

    const offData = window.pi.terminal.onData(({ id, data }) => {
      if (id === sessionRef.current) {
        term.write(data)
      } else if (awaitingCreate && sessionRef.current === null) {
        // The banner can arrive before `create` resolves; keep it for the
        // moment the id becomes known instead of dropping the first prompt.
        pendingOutputRef.current += data
      }
    })
    const offExit = window.pi.terminal.onExit(({ id, exitCode }) => {
      if (id !== sessionRef.current) return
      sessionRef.current = null
      setExited(exitCode)
    })
    const offBinary = term.onBinary((data) => {
      const id = sessionRef.current
      if (id) void window.pi.terminal.write(id, data)
    })
    const offInput = term.onData((data) => {
      const id = sessionRef.current
      if (id) void window.pi.terminal.write(id, data)
    })

    const resize = () => {
      if (disposed) return
      try {
        fit.fit()
      } catch {
        return
      }
      const id = sessionRef.current
      if (id) void window.pi.terminal.resize(id, term.cols, term.rows)
    }
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(resize)
    })
    observer.observe(container)

    void window.pi.terminal
      .create({ cols: term.cols, rows: term.rows, cwd, shell })
      .then((info) => {
        awaitingCreate = false
        if (disposed) {
          void window.pi.terminal.kill(info.id)
          return
        }
        sessionRef.current = info.id
        onLabelRef.current(info.shell)
        if (pendingOutputRef.current) {
          term.write(pendingOutputRef.current)
          pendingOutputRef.current = ''
        }
        const pending = pendingRequestRef.current
        if (pending) {
          pendingRequestRef.current = null
          void window.pi.terminal.write(info.id, `${pending}\r`)
        }
        term.focus()
      })
      .catch((failure: unknown) => {
        awaitingCreate = false
        if (disposed) return
        const message = failure instanceof Error ? failure.message : String(failure)
        setError(message)
        showToast(message, 'error')
      })

    return () => {
      disposed = true
      awaitingCreate = false
      cancelAnimationFrame(resizeFrame)
      observer.disconnect()
      offData()
      offExit()
      offBinary.dispose()
      offInput.dispose()
      const id = sessionRef.current
      sessionRef.current = null
      if (id) void window.pi.terminal.kill(id)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [cwd, shell, restartKey, showToast])

  // The app theme can change without restarting the shell.
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = terminalTheme(isDark)
  }, [isDark])

  // A hidden pane measured 0×0; when it comes back in front it has to learn its
  // real size and take the keyboard again.
  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        return
      }
      const term = termRef.current
      if (!term) return
      term.focus()
      const id = sessionRef.current
      if (id) void window.pi.terminal.resize(id, term.cols, term.rows)
    })
    return () => cancelAnimationFrame(frame)
  }, [active])

  // A command handed over from the transcript is typed into the shell.
  useEffect(() => {
    if (!request || request.seq === handledRequestRef.current) return
    handledRequestRef.current = request.seq
    const command = request.command.trim()
    if (!command) return
    const id = sessionRef.current
    if (!id) {
      pendingRequestRef.current = command
      return
    }
    termRef.current?.focus()
    void window.pi.terminal.write(id, `${command}\r`)
  }, [request])

  return (
    <div className="terminal__pane-body">
      <div className="terminal__xterm" ref={containerRef} />
      {error ? (
        <div className="terminal__overlay" role="status">
          <span className="terminal__notice-title">{t('Could not start the terminal')}</span>
          <span className="terminal__notice-text">{error}</span>
          <button type="button" className="btn btn--sm" onClick={() => setRestartKey((v) => v + 1)}>
            {t('Restart the terminal')}
          </button>
        </div>
      ) : null}
      {exited !== null ? (
        <div className="terminal__overlay" role="status">
          <span className="terminal__notice-title">{t('The shell has exited')}</span>
          <span className="terminal__notice-text">
            {t('exit')} {exited}
          </span>
          <button type="button" className="btn btn--sm" onClick={() => setRestartKey((v) => v + 1)}>
            {t('Restart the terminal')}
          </button>
        </div>
      ) : null}
    </div>
  )
})

interface TerminalTab {
  key: string
  label: string
}

/**
 * The integrated terminal, as a strip of terminal tabs.
 *
 * This is a real shell on a PTY, not a command runner over Pi's `bash` RPC:
 * every tab is its own process with a prompt, a working directory, interactive
 * programs and a scrollback. The renderer owns the screen (xterm.js); the main
 * process owns the processes (`TerminalManager`), so no Node access leaks into
 * the React tree.
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
  const workspace = useAppStore((state) => state.workspace)
  const shell = useAppStore((state) => state.settings.terminalShell ?? 'powershell')
  const storedHeight = useAppStore((state) => state.settings.terminalHeight)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const showToast = useAppStore((state) => state.showToast)

  const [height, setHeight] = useState(() =>
    typeof storedHeight === 'number' ? clampHeight(storedHeight) : defaultTerminalHeight()
  )
  const [tabs, setTabs] = useState<TerminalTab[]>(() => [
    { key: 'terminal-1', label: '' }
  ])
  const [activeKey, setActiveKey] = useState('terminal-1')
  const [assignedRequest, setAssignedRequest] = useState<{
    key: string
    request: TerminalRunRequest
  } | null>(null)
  const nextKeyRef = useRef(2)
  const paneApis = useRef(new Map<string, TerminalPaneHandle>())
  const heightRef = useRef(height)
  const draggingRef = useRef(false)

  // A hand-off belongs to the tab that received it, even after another tab
  // becomes active. Keeping that owner prevents old requests from replaying.
  useEffect(() => {
    if (!request) return
    setAssignedRequest((previous) =>
      previous?.request.seq === request.seq ? previous : { key: activeKey, request }
    )
  }, [request, activeKey])

  useEffect(() => {
    heightRef.current = height
  }, [height])

  useEffect(() => {
    if (draggingRef.current) return
    const next =
      typeof storedHeight === 'number' ? clampHeight(storedHeight) : defaultTerminalHeight()
    heightRef.current = next
    setHeight(next)
  }, [storedHeight])

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

  useEffect(() => () => document.body.classList.remove('terminal-resizing'), [])

  const setTabLabel = useCallback((key: string, label: string) => {
    setTabs((previous) =>
      previous.map((tab) => (tab.key === key && tab.label !== label ? { ...tab, label } : tab))
    )
  }, [])

  const addTab = useCallback(() => {
    const key = `terminal-${nextKeyRef.current}`
    nextKeyRef.current += 1
    setTabs((previous) => [...previous, { key, label: '' }])
    setActiveKey(key)
  }, [])

  const closeTab = useCallback(
    (key: string) => {
      const index = tabs.findIndex((tab) => tab.key === key)
      const next = tabs.filter((tab) => tab.key !== key)
      paneApis.current.delete(key)
      if (next.length === 0) {
        onClose()
        return
      }
      setTabs(next)
      if (activeKey === key) setActiveKey(next[Math.max(0, index - 1)].key)
    },
    [tabs, activeKey, onClose]
  )

  const activePane = useCallback(() => paneApis.current.get(activeKey), [activeKey])

  const copyOutput = useCallback(async () => {
    const text = activePane()?.copySelection() ?? ''
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
  }, [activePane, showToast, t])

  const clearOutput = useCallback(() => activePane()?.clear(), [activePane])
  const restart = useCallback(() => activePane()?.restart(), [activePane])

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

  return (
    <section
      className="terminal"
      data-embedded={embedded || undefined}
      style={embedded ? undefined : { height: `${height}px` }}
      aria-label={t('Terminal')}
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

      <div className="terminal__bar">
        <div className="terminal__tabstrip" role="tablist" aria-label={t('Terminal')}>
          {tabs.map((tab) => (
            <div
              key={tab.key}
              className="terminal__tab"
              data-active={tab.key === activeKey || undefined}
              role="tab"
              aria-selected={tab.key === activeKey}
            >
              <button
                type="button"
                className="terminal__tab-main"
                title={tab.label || t('Terminal')}
                onClick={() => setActiveKey(tab.key)}
              >
                <SquareTerminal size={13} className="terminal__tab-icon" />
                <span className="terminal__tab-label">{tab.label || t('Terminal')}</span>
              </button>
              <button
                type="button"
                className="terminal__tab-close"
                title={t('Close')}
                aria-label={t('Close')}
                onClick={() => closeTab(tab.key)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="terminal__new"
            title={t('New terminal')}
            aria-label={t('New terminal')}
            onClick={addTab}
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="terminal__actions">
          <button
            className="icon-btn"
            title={t('Copy the output')}
            aria-label={t('Copy the output')}
            onClick={() => void copyOutput()}
          >
            <Copy size={13} />
          </button>
          <button
            className="icon-btn"
            title={t('Clear')}
            aria-label={t('Clear')}
            onClick={clearOutput}
          >
            <Eraser size={13} />
          </button>
          <button
            className="icon-btn"
            title={t('Restart the terminal')}
            aria-label={t('Restart the terminal')}
            onClick={restart}
          >
            <RotateCcw size={13} />
          </button>
          {embedded ? null : (
            <button className="icon-btn" title={t('Close')} aria-label={t('Close')} onClick={onClose}>
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="terminal__body">
        {tabs.map((tab) => (
          <div
            key={tab.key}
            className="terminal__pane"
            data-active={tab.key === activeKey || undefined}
          >
            <TerminalPane
              ref={(api) => {
                if (api) paneApis.current.set(tab.key, api)
                else paneApis.current.delete(tab.key)
              }}
              active={tab.key === activeKey}
              cwd={workspace?.path}
              shell={shell}
              request={tab.key === assignedRequest?.key ? assignedRequest.request : null}
              onLabel={(label) => setTabLabel(tab.key, label)}
            />
          </div>
        ))}
      </div>
    </section>
  )
}
