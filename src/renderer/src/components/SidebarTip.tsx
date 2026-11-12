import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { createPortal } from 'react-dom'
import '../styles/sidebar-tip.css'

/**
 * The card a sidebar row shows while the pointer rests on it.
 *
 * It replaces the native `title` tooltip, which can only carry one string and
 * takes its colours from the OS. A row says several things at once 鈥?when it
 * started, where it lives, how it is doing 鈥?and those want a shape, not a
 * line: one label column and one value column, with the path allowed to wrap.
 *
 * The card is drawn in a portal and positioned from the row's rectangle, so a
 * scrolled or clipped sidebar list cannot cut it off. It never covers the row
 * it describes: it sits beside it, on the reading side.
 */

export interface SidebarTipRow {
  label: string
  value: string
  /** A path: it wraps onto a second line instead of being clipped. */
  path?: boolean
}

/**
 * The delay before the card appears, and the grace period after the pointer
 * leaves. The first is long enough that moving across the list to click
 * something does not flash a card; the second lets the pointer leave the row
 * without the card disappearing mid-move.
 */
const HOVER_DELAY = 320
const CLOSE_DELAY = 120

/** What a row hands the card: where to point, and what to say. */
interface TipState<T> {
  anchor: HTMLElement
  payload: T
}

/**
 * When the pointer last pressed something, anywhere in the window.
 *
 * A click focuses the button it lands on, so the row's `focus` handler fires
 * for a mouse too. The card must answer "what is this row" for the keyboard,
 * not stay open because someone clicked a conversation — so a focus that
 * arrives right after a press is ignored. `:focus-visible` would be the
 * idiomatic test, but it reports a heuristic rather than the actual input that
 * caused the focus, and it is false for a programmatic focus.
 */
let lastPointerDownAt = 0
const POINTER_FOCUS_WINDOW_MS = 600

if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    () => {
      lastPointerDownAt = Date.now()
    },
    true
  )
}

/**
 * Owns the "is the pointer resting on this row" state for a list of rows.
 *
 * One instance serves every row of a list 鈥?only one can be hovered 鈥?so the
 * payload is passed in by the handler instead of being held per row. The
 * handlers attach to the row's own button; there is no wrapper element,
 * because the sidebar's rows are laid out to the pixel and a wrapping `div`
 * would move the title.
 */
export function useHoverTip<T>(): {
  /** The row being described, or null when no card is showing. */
  tip: TipState<T> | null
  enter: (payload: T) => (event: ReactMouseEvent<HTMLElement> | ReactFocusEvent<HTMLElement>) => void
  leave: () => void
} {
  const [tip, setTip] = useState<TipState<T> | null>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  // The payload of the row the pointer is on right now. A ref, because the
  // delay timer must read it when it fires rather than capture the render it
  // was scheduled in.
  const pending = useRef<T | null>(null)
  const showing = useRef(false)
  showing.current = tip !== null

  const stopOpen = useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
  }, [])

  const stopClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])

  useEffect(
    () => () => {
      stopOpen()
      stopClose()
    },
    [stopClose, stopOpen]
  )

  const enter = useCallback(
    (payload: T) => (event: ReactMouseEvent<HTMLElement> | ReactFocusEvent<HTMLElement>) => {
      stopClose()
      // A mouse click focuses the button too. The card must answer "what is
      // this row" for the keyboard, not pop up and stay up because someone
      // clicked a conversation.
      if (event.type === 'focus' && Date.now() - lastPointerDownAt < POINTER_FOCUS_WINDOW_MS) {
        return
      }
      pending.current = payload
      // The described element is the whole row, not the button that happened
      // to be hit: the card is placed past the row's action slot so it lands
      // outside the sidebar.
      const anchor =
        event.currentTarget.closest<HTMLElement>('.project__row, .session-item') ??
        event.currentTarget
      if (openTimer.current !== null) return
      const delay = showing.current ? 0 : HOVER_DELAY
      openTimer.current = window.setTimeout(() => {
        openTimer.current = null
        const next = pending.current
        if (next !== null) setTip({ anchor, payload: next })
      }, delay)
    },
    [stopClose]
  )

  const leave = useCallback(() => {
    stopOpen()
    pending.current = null
    if (!showing.current) return
    stopClose()
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setTip(null)
    }, CLOSE_DELAY)
  }, [stopClose, stopOpen])

  return { tip, enter, leave }
}

interface SidebarTipProps {
  /** The row the card describes; measured, never wrapped. */
  anchor: HTMLElement
  /** What the row is: the conversation's or the project's name. */
  title: string
  rows: SidebarTipRow[]
}

/**
 * Only one card can be on screen at a time 鈥?the pointer rests on one row 鈥?so
 * it takes one fixed id. A per-row id would put an `aria-describedby` on every
 * row in the list for a card that exists for one of them.
 */
export const SIDEBAR_TIP_ID = 'sidebar-tip'

export function SidebarTip({ anchor, title, rows }: SidebarTipProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return

    const place = () => {
      if (!anchor.isConnected) return
      const rect = anchor.getBoundingClientRect()
      const edge = 12
      const gap = 10
      const width = panel.offsetWidth
      const height = panel.offsetHeight
      // The reading side of a left-hand sidebar is its right; flip only when
      // the card would leave the window.
      let left = rect.right + gap
      if (left + width > innerWidth - edge) {
        left = Math.max(edge, rect.left - gap - width)
      }
      const top = Math.max(
        edge,
        Math.min(rect.top + rect.height / 2 - height / 2, innerHeight - edge - height)
      )
      setPosition({ left, top })
    }

    place()
    // A card that stayed put while its row scrolled away would point at
    // nothing, so it follows the row instead of closing.
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor])

  return createPortal(
    <div
      ref={panelRef}
      id={SIDEBAR_TIP_ID}
      className="sidebar-tip"
      role="tooltip"
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? 'visible' : 'hidden'
      }}
    >
      <div className="sidebar-tip__title">{title}</div>
      <dl className="sidebar-tip__rows">
        {rows.map((row) => (
          <div className="sidebar-tip__row" key={row.label}>
            <dt className="sidebar-tip__label">{row.label}</dt>
            <dd className="sidebar-tip__value" data-path={row.path ? 'true' : undefined}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>,
    document.body
  )
}
