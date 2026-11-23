import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { windowShellBottom } from '../lib/hover-tip'

interface PopoverProps {
  /**
   * The trigger element. In `click` mode it has to call `toggle` when it is
   * clicked — without it the popover never opens. In `hover` mode it is opened
   * by the pointer and `toggle` only pins or dismisses it.
   */
  renderTrigger: (state: {
    open: boolean
    toggle: (event?: ReactMouseEvent<HTMLElement>) => void
    close: () => void
  }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  placement?: 'top' | 'bottom' | 'right'
  width?: number
  className?: string
  /**
   * `click` is the default because every menu and picker in the app is a
   * deliberate action. `hover` is for a control that only *answers a question*
   * — a number the reader wants explained — so the card appears under the
   * pointer and leaves when the pointer does.
   */
  trigger?: 'click' | 'hover'
  /** How long the pointer must rest on the trigger before the card appears. */
  hoverDelay?: number
  /**
   * How long the card survives the pointer leaving. It has to be enough to
   * cross the gap to the card, or the card would vanish on the way in.
   */
  closeDelay?: number
}

export function Popover({
  renderTrigger,
  children,
  align = 'left',
  placement = 'bottom',
  width,
  className,
  trigger = 'click',
  hoverDelay = 120,
  closeDelay = 160
}: PopoverProps) {
  const [open, setOpen] = useState(false)
  const popoverId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const hover = trigger === 'hover'

  const clearTimers = useCallback(() => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current)
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    openTimer.current = null
    closeTimer.current = null
  }, [])

  useEffect(() => clearTimers, [clearTimers])

  const stopClosing = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])

  const stopOpening = useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
  }, [])

  const openNow = useCallback(() => {
    if (!hover) return
    clearTimers()
    setOpen(true)
  }, [clearTimers, hover])

  const scheduleOpen = useCallback(() => {
    if (!hover || openTimer.current !== null) return
    stopClosing()
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null
      setOpen(true)
    }, hoverDelay)
  }, [hover, hoverDelay, stopClosing])

  // Leaving does not close the card: the pointer may only be crossing the gap to
  // it. Re-entering either side cancels the pending close.
  const scheduleClose = useCallback(() => {
    if (!hover) return
    stopOpening()
    stopClosing()
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setOpen(false)
    }, closeDelay)
  }, [closeDelay, hover, stopClosing, stopOpening])

  const close = useCallback(() => {
    clearTimers()
    setOpen(false)
    // A card dismissed by the pointer must not move the caret; one dismissed by
    // Escape or a menu item has to give focus back to the control it came from.
    if (!hover) triggerRef.current?.focus()
  }, [clearTimers, hover])

  const toggle = (event?: ReactMouseEvent<HTMLElement>) => {
    const target = event?.currentTarget ?? document.activeElement
    setOpen((value) => {
      if (!value) triggerRef.current = target instanceof HTMLElement ? target : null
      return !value
    })
  }

  useLayoutEffect(() => {
    if (!open) return
    const anchor = containerRef.current
    const panel = popoverRef.current
    if (!anchor || !panel) return

    // The panel is portaled to the body, so it cannot inherit the stacking of
    // whatever it was opened from. A dialog paints at `--z-modal`, which
    // outranks the `--z-floating` a popover uses in the page, so a menu opened
    // from inside a dialog was painted behind the dialog's own card. The
    // stylesheet raises the panel when this attribute says it is in one.
    if (anchor.closest('.modal-layer')) panel.dataset.layer = 'modal'
    else delete panel.dataset.layer

    // React reapplies the inline `visibility: hidden` on every render. A parent
    // that updates while the menu is open (the branch list loading, for one)
    // would otherwise leave the panel hidden, because this effect used to skip
    // when `open` itself had not changed. Re-assert visibility before paint.
    const position = () => {
      const rect = anchor.getBoundingClientRect()
      const edge = 12
      const gap = 8
      // The caption buttons are a native layer over the page. Room "above" a
      // control does not include that band, or the menu opens under the shell.
      const topInset = Math.max(edge, windowShellBottom())
      const above = Math.max(0, rect.top - topInset - gap)
      const below = Math.max(0, innerHeight - rect.bottom - edge - gap)
      const preferTop = placement === 'top'
      // `scrollHeight` is the full content height even while the panel is
      // clamped, so this reads the natural size without first undoing the
      // previous clamp (which would bounce the ResizeObserver).
      const naturalHeight = panel.scrollHeight + 2
      const useTop =
        placement !== 'right' &&
        (preferTop
          ? above >= naturalHeight || above >= below
          : below < naturalHeight && above > below)
      let sideTop = useTop
      let available = placement === 'right' ? innerHeight - edge * 2 : sideTop ? above : below
      // A chip flush with the window edge used to clamp the menu to 0px, so
      // the click looked like it did nothing. Flip to the roomier side, and
      // never collapse below a readable strip.
      if (placement !== 'right' && available < 160) {
        const other = sideTop ? below : above
        if (other > available) {
          sideTop = !sideTop
          available = other
        }
      }
      available = Math.max(available, Math.min(160, innerHeight - edge * 2))
      // A max-height that only just covers the content still produces a
      // scrollbar: the border and rounding take the last pixels. Leave the
      // panel unclamped when it fits, and only scroll when it really cannot.
      const nextMaxHeight = available >= naturalHeight + 2 ? '' : `${available}px`
      if (panel.style.maxHeight !== nextMaxHeight) panel.style.maxHeight = nextMaxHeight
      const size = { width: panel.offsetWidth, height: panel.offsetHeight }
      const left =
        placement === 'right'
          ? rect.right + gap
          : align === 'right'
            ? rect.right - size.width
            : rect.left
      const top =
        placement === 'right' ? rect.top : sideTop ? rect.top - gap - size.height : rect.bottom + gap
      panel.style.left = `${Math.max(edge, Math.min(left, innerWidth - edge - size.width))}px`
      panel.style.top = `${Math.max(topInset, Math.min(top, innerHeight - edge - size.height))}px`
      panel.style.visibility = 'visible'
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(anchor)
    observer.observe(panel)
    window.addEventListener('resize', position)
    const onScroll = (event: Event) => {
      if (!panel.contains(event.target as Node)) position()
    }
    window.addEventListener('scroll', onScroll, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, placement, align, width])

  useEffect(() => {
    if (!open) return
    // The opening click and the search field's autofocus both move focus
    // before this effect runs. Arming immediately treated that as "focus
    // left the menu" and closed it on the same gesture.
    let armed = false
    const arm = window.setTimeout(() => {
      armed = true
    }, 0)
    const inside = (target: Node | null) =>
      Boolean(
        target &&
          (containerRef.current?.contains(target) || popoverRef.current?.contains(target))
      )
    const onPointerDown = (event: MouseEvent) => {
      if (!armed || inside(event.target as Node)) return
      setOpen(false)
    }
    const onFocusIn = (event: FocusEvent) => {
      if (!armed || inside(event.target as Node)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const active = document.activeElement
        if (
          active instanceof HTMLElement &&
          active.matches('input, textarea, select, [contenteditable="true"]')
        ) return
        const buttons = [...(popoverRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
          .filter((button) => button.getClientRects().length > 0)
        if (!buttons.length) return
        const index = buttons.findIndex((button) => button === active)
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : event.key === 'ArrowDown'
                ? (index + 1) % buttons.length
                : index < 0
                  ? buttons.length - 1
                  : (index - 1 + buttons.length) % buttons.length
        event.preventDefault()
        buttons[next].focus()
        return
      }
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(arm)
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [close, open])

  const panelStyle = useMemo(
    () => (width !== undefined ? { width } : undefined),
    [width]
  )

  return (
    <div
      className="popover-wrap"
      data-open={open ? 'true' : undefined}
      data-popover-id={popoverId}
      ref={containerRef}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onFocus={openNow}
      onBlur={scheduleClose}
    >
      {renderTrigger({ open, toggle, close })}
      {open ? createPortal(
        <div
          ref={popoverRef}
          data-popover-id={popoverId}
          className={`popover ${className ?? ''}`}
          onMouseEnter={stopClosing}
          onMouseLeave={scheduleClose}
          style={panelStyle}
        >
          {children(close)}
        </div>,
        document.body
      ) : null}
    </div>
  )
}
