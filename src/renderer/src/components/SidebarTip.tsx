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
import { windowShellBottom } from '../lib/hover-tip'
import {
  decidePointerMoveDismiss,
  decideScrollDismiss,
  isAnchorRectVisible,
  type TipPoint,
  type TipRect,
  type TipTriggerSource
} from '../lib/sidebar-tip'
import '../styles/sidebar-tip.css'

/**
 * The card a sidebar or picker row shows while the pointer rests on it.
 *
 * It replaces the native `title` tooltip, which can only carry one string and
 * takes its colours from the OS. A row says several things at once — when it
 * started, where it lives, how it is doing — and those want a shape, not a
 * line: one label column and one value column, with the path allowed to wrap.
 *
 * The card is drawn in a portal and positioned from the row's rectangle, so a
 * scrolled or clipped list cannot cut it off. It never covers the row it
 * describes: it sits beside it, on the reading side.
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

function clippingRectsOf(anchor: HTMLElement): TipRect[] {
  const rects: TipRect[] = []
  let parent = anchor.parentElement
  while (parent && parent !== document.body && parent !== document.documentElement) {
    const style = window.getComputedStyle(parent)
    const overflow = `${style.overflowX} ${style.overflowY}`
    if (/(auto|scroll|hidden|clip)/.test(overflow)) {
      rects.push(parent.getBoundingClientRect())
    }
    parent = parent.parentElement
  }
  return rects
}

function isAnchorVisible(anchor: HTMLElement | null): boolean {
  if (!anchor || !anchor.isConnected) return false
  if (anchor.getClientRects().length === 0) return false
  return isAnchorRectVisible(true, anchor.getBoundingClientRect(), clippingRectsOf(anchor), {
    width: window.innerWidth,
    height: window.innerHeight
  })
}

/**
 * Owns the "is the pointer resting on this row" state for a list of rows.
 *
 * One instance serves every row of a list — only one can be hovered — so the
 * payload is passed in by the handler instead of being held per row. The
 * handlers attach to the row's own button; there is no wrapper element,
 * because the sidebar's rows are laid out to the pixel and a wrapping `div`
 * would move the title.
 *
 * Global dismissal watchers (anchor removal, pointer press, dropped
 * `mouseleave`, scroll clipping, Escape, window blur) attach imperatively only
 * while a card is pending or visible — zero listener overhead on idle rows and
 * zero extra renders while crossing a list.
 */
export function useHoverTip<T>(): {
  /** The row being described, or null when no card is showing. */
  tip: TipState<T> | null
  enter: (payload: T | (() => T)) => (event: ReactMouseEvent<HTMLElement> | ReactFocusEvent<HTMLElement>) => void
  leave: () => void
  /** Close immediately and cancel any pending hover timer. */
  dismiss: () => void
} {
  const [tip, setTip] = useState<TipState<T> | null>(null)
  const tipRef = useRef<TipState<T> | null>(null)
  tipRef.current = tip
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const stopWatchersRef = useRef<(() => void) | null>(null)
  // The payload, positioning anchor and event trigger of the row the pointer
  // or focus is on right now. Refs keep the delay timer reading the latest row
  // rather than capturing a stale closure from an earlier render.
  const pending = useRef<T | (() => T) | null>(null)
  const pendingAnchor = useRef<HTMLElement | null>(null)
  const activeTrigger = useRef<HTMLElement | null>(null)
  const sourceRef = useRef<TipTriggerSource>('pointer')
  const pointerRef = useRef<TipPoint | null>(null)

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

  const stopWatching = useCallback(() => {
    const cleanup = stopWatchersRef.current
    if (!cleanup) return
    stopWatchersRef.current = null
    cleanup()
  }, [])

  const dismiss = useCallback(() => {
    stopOpen()
    stopClose()
    stopWatching()
    pending.current = null
    pendingAnchor.current = null
    activeTrigger.current = null
    tipRef.current = null
    setTip(null)
  }, [stopClose, stopOpen, stopWatching])

  const leave = useCallback(() => {
    stopOpen()
    pending.current = null
    pendingAnchor.current = null
    if (tipRef.current === null) {
      activeTrigger.current = null
      stopWatching()
      return
    }
    stopClose()
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      activeTrigger.current = null
      tipRef.current = null
      stopWatching()
      setTip(null)
    }, CLOSE_DELAY)
  }, [stopClose, stopOpen, stopWatching])

  const startWatching = useCallback(() => {
    if (stopWatchersRef.current || typeof window === 'undefined' || typeof document === 'undefined') {
      return
    }

    const currentAnchor = () => pendingAnchor.current ?? tipRef.current?.anchor ?? null

    const checkAnchor = () => {
      const anchor = currentAnchor()
      const trigger = activeTrigger.current
      if (!anchor || (trigger && !trigger.isConnected) || !isAnchorVisible(anchor)) {
        dismiss()
      }
    }

    const onPointerDown = () => {
      dismiss()
    }

    const onPointerMove = (event: PointerEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY }
      const anchor = currentAnchor()
      const trigger = activeTrigger.current ?? anchor
      const anchorVisible = Boolean(
        anchor && (!trigger || trigger.isConnected) && isAnchorVisible(anchor)
      )
      const target = event.target
      const triggerContainsTarget = Boolean(
        trigger && target instanceof Node && trigger.contains(target)
      )
      const action = decidePointerMoveDismiss(
        sourceRef.current,
        anchorVisible,
        triggerContainsTarget
      )
      if (action === 'dismiss') dismiss()
      else if (action === 'leave' && closeTimer.current === null) leave()
    }

    const onScroll = (event: Event) => {
      const anchor = currentAnchor()
      const anchorVisible = isAnchorVisible(anchor)
      const scroller = event.target
      const scrolledAncestor = Boolean(
        anchor && scroller instanceof Node && scroller !== anchor && scroller.contains(anchor)
      )
      const action = decideScrollDismiss(
        sourceRef.current,
        anchorVisible,
        scrolledAncestor,
        anchor ? anchor.getBoundingClientRect() : null,
        pointerRef.current
      )
      if (action === 'dismiss') dismiss()
      else if (action === 'leave' && closeTimer.current === null) leave()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss()
    }

    const onWindowBlur = () => {
      dismiss()
    }

    const onVisibilityChange = () => {
      if (document.hidden) dismiss()
    }

    const onDocumentMouseLeave = () => {
      if (sourceRef.current === 'pointer') dismiss()
    }

    // A streaming transcript mutates the DOM every frame while a card is up,
    // and every check forces a layout read (rect plus clipping ancestors).
    // Coalesce the mutation checks onto the next frame: one check per paint,
    // and the anchor still cannot outlive its element by more than a frame.
    let anchorCheckFrame = 0
    const scheduleAnchorCheck = () => {
      if (anchorCheckFrame !== 0) return
      anchorCheckFrame = window.requestAnimationFrame(() => {
        anchorCheckFrame = 0
        checkAnchor()
      })
    }

    const observer = new MutationObserver(scheduleAnchorCheck)
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true })
    }

    window.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointermove', onPointerMove, true)
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onWindowBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
    document.documentElement.addEventListener('mouseleave', onDocumentMouseLeave)

    stopWatchersRef.current = () => {
      if (anchorCheckFrame !== 0) {
        window.cancelAnimationFrame(anchorCheckFrame)
        anchorCheckFrame = 0
      }
      observer.disconnect()
      window.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointermove', onPointerMove, true)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onWindowBlur)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      document.documentElement.removeEventListener('mouseleave', onDocumentMouseLeave)
    }
  }, [dismiss, leave])

  useEffect(
    () => () => {
      stopOpen()
      stopClose()
      stopWatching()
    },
    [stopClose, stopOpen, stopWatching]
  )

  const enter = useCallback(
    (payload: T | (() => T)) => (event: ReactMouseEvent<HTMLElement> | ReactFocusEvent<HTMLElement>) => {
      stopClose()
      const isFocus = event.type === 'focus'
      // A mouse click focuses the button too. The card must answer "what is
      // this row" for the keyboard, not pop up and stay up because someone
      // clicked a conversation.
      if (isFocus && Date.now() - lastPointerDownAt < POINTER_FOCUS_WINDOW_MS) {
        return
      }
      const trigger = event.currentTarget
      // The described element is the whole row, not the button that happened
      // to be hit: the card is placed past the row's action slot so it lands
      // outside the sidebar.
      const anchor =
        trigger.closest<HTMLElement>('.project__row, .session-item') ?? trigger
      if (!anchor.isConnected) return
      pending.current = payload
      pendingAnchor.current = anchor
      activeTrigger.current = trigger
      sourceRef.current = isFocus ? 'focus' : 'pointer'
      if (!isFocus && 'clientX' in event) {
        pointerRef.current = { x: event.clientX, y: event.clientY }
      }
      startWatching()
      if (openTimer.current !== null) return
      const delay = tipRef.current !== null ? 0 : HOVER_DELAY
      openTimer.current = window.setTimeout(() => {
        openTimer.current = null
        const source = pending.current
        const nextAnchor = pendingAnchor.current
        if (source === null || !nextAnchor || !isAnchorVisible(nextAnchor)) {
          pending.current = null
          pendingAnchor.current = null
          if (tipRef.current === null) {
            activeTrigger.current = null
            stopWatching()
          }
          return
        }
        const next = typeof source === 'function' ? (source as () => T)() : source
        const nextTip = { anchor: nextAnchor, payload: next }
        tipRef.current = nextTip
        setTip(nextTip)
      }, delay)
    },
    [startWatching, stopClose, stopWatching]
  )

  return { tip, enter, leave, dismiss }
}

interface SidebarTipProps {
  /** The row the card describes; measured, never wrapped. */
  anchor: HTMLElement
  /** What the row is: the conversation's or the project's name. */
  title: string
  rows: SidebarTipRow[]
  /** Called if the anchor disappears or scrolls out of view while mounted. */
  onDismiss?: () => void
}

/**
 * Only one card can be on screen at a time — the pointer rests on one row — so
 * it takes one fixed id. A per-row id would put an `aria-describedby` on every
 * row in the list for a card that exists for one of them.
 */
export const SIDEBAR_TIP_ID = 'sidebar-tip'

export function SidebarTip({ anchor, title, rows, onDismiss }: SidebarTipProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return

    const place = () => {
      if (!isAnchorVisible(anchor)) {
        setPosition(null)
        onDismissRef.current?.()
        return
      }
      const rect = anchor.getBoundingClientRect()
      const edge = 12
      const gap = 10
      const topInset = Math.max(edge, windowShellBottom())
      const width = panel.offsetWidth
      const height = panel.offsetHeight
      // The reading side of a left-hand sidebar is its right; flip only when
      // the card would leave the window.
      let left = rect.right + gap
      if (left + width > innerWidth - edge) {
        left = Math.max(edge, rect.left - gap - width)
      }
      const top = Math.max(
        topInset,
        Math.min(rect.top + rect.height / 2 - height / 2, innerHeight - edge - height)
      )
      setPosition({ left, top })
    }

    place()
    // A card that stayed put while its row scrolled away would point at
    // nothing, so it follows the row while visible and dismisses once clipped.
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor])

  if (!anchor.isConnected) return null

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
