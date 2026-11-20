import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TrayPopupState } from '@shared/types'

const EMPTY_STATE: TrayPopupState = {
  running: [],
  recent: [],
  labels: { show: 'Show window', running: 'In progress', recent: 'Recent', quit: 'Quit', empty: 'No conversations yet' }
}

/**
 * The frameless popup drawn next to the tray icon. It owns no conversation
 * data: the main process pushes a compact projection, and each row hands its
 * key back so the main window opens on the right conversation.
 */
export function TrayPopup() {
  const [state, setState] = useState<TrayPopupState>(EMPTY_STATE)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    void window.pi.trayPopup.getState().then((next) => {
      if (alive) setState(next)
    }).catch(() => {})
    const off = window.pi.trayPopup.onState((next) => setState(next))
    return () => {
      alive = false
      off()
    }
  }, [])

  // The window is frameless with a fixed width; tell main the content height
  // so it can size itself exactly and stay a compact, single-column menu.
  useLayoutEffect(() => {
    const node = rootRef.current
    if (!node) return
    window.pi.trayPopup.setHeight(Math.ceil(node.getBoundingClientRect().height))
  }, [state])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') window.pi.trayPopup.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onConversation = useCallback((key: string) => {
    window.pi.trayPopup.openConversation(key)
  }, [])

  const hasRows = state.running.length > 0 || state.recent.length > 0

  return (
    <div className="tray" ref={rootRef}>
      <div className="tray__card">
        <button type="button" className="tray__row tray__row--action" onClick={() => window.pi.trayPopup.showWindow()}>
          <span className="tray__glyph" aria-hidden="true">▣</span>
          <span>{state.labels.show}</span>
        </button>

        {hasRows ? (
          <>
            {state.running.length > 0 && (
              <>
                <div className="tray__section">{state.labels.running}</div>
                {state.running.map((item) => (
                  <button
                    type="button"
                    className="tray__row tray__row--conversation"
                    key={item.key}
                    title={item.title}
                    onClick={() => onConversation(item.key)}
                  >
                    <span className="tray__dot tray__dot--running" aria-hidden="true" />
                    <span className="tray__label">{item.title}</span>
                  </button>
                ))}
              </>
            )}
            {state.recent.length > 0 && (
              <>
                <div className="tray__section">{state.labels.recent}</div>
                {state.recent.map((item) => (
                  <button
                    type="button"
                    className="tray__row tray__row--conversation"
                    key={item.key}
                    title={item.title}
                    onClick={() => onConversation(item.key)}
                  >
                    <span className="tray__dot" aria-hidden="true" />
                    <span className="tray__label">{item.title}</span>
                  </button>
                ))}
              </>
            )}
          </>
        ) : (
          <div className="tray__empty">{state.labels.empty}</div>
        )}

        <div className="tray__divider" />
        <button type="button" className="tray__row tray__row--action tray__row--quit" onClick={() => window.pi.trayPopup.quit()}>
          <span className="tray__glyph" aria-hidden="true">⏻</span>
          <span>{state.labels.quit}</span>
        </button>
      </div>
    </div>
  )
}
