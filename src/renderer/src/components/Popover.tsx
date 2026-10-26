import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

interface PopoverProps {
  /**
   * The trigger element. It has to call `toggle` when it is clicked —
   * without it the popover never opens.
   */
  renderTrigger: (state: {
    open: boolean
    toggle: (event?: ReactMouseEvent<HTMLElement>) => void
  }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  placement?: 'top' | 'bottom' | 'right'
  width?: number
  className?: string
}

export function Popover({
  renderTrigger,
  children,
  align = 'left',
  placement = 'bottom',
  width,
  className
}: PopoverProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)

  const close = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

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

    const position = () => {
      const rect = anchor.getBoundingClientRect()
      const edge = 12
      const gap = 8
      const above = Math.max(0, rect.top - edge - gap)
      const below = Math.max(0, innerHeight - rect.bottom - edge - gap)
      const preferTop = placement === 'top'
      const naturalHeight = panel.scrollHeight + 2
      const useTop =
        placement !== 'right' &&
        (preferTop
          ? above >= naturalHeight || above >= below
          : below < naturalHeight && above > below)
      const available = placement === 'right' ? innerHeight - edge * 2 : useTop ? above : below
      panel.style.maxHeight = `${available}px`
      const size = { width: panel.offsetWidth, height: panel.offsetHeight }
      const left =
        placement === 'right'
          ? rect.right + gap
          : align === 'right'
            ? rect.right - size.width
            : rect.left
      const top =
        placement === 'right' ? rect.top : useTop ? rect.top - gap - size.height : rect.bottom + gap
      panel.style.left = `${Math.max(edge, Math.min(left, innerWidth - edge - size.width))}px`
      panel.style.top = `${Math.max(edge, Math.min(top, innerHeight - edge - size.height))}px`
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
  }, [align, open, placement])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!containerRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Node
      if (!containerRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false)
      }
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
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [close, open])

  return (
    <div className="popover-wrap" ref={containerRef}>
      {renderTrigger({ open, toggle })}
      {open ? createPortal(
        <div
          ref={popoverRef}
          className={`popover ${className ?? ''}`}
          style={{
            width,
            visibility: 'hidden'
          }}
        >
          {children(close)}
        </div>,
        document.body
      ) : null}
    </div>
  )
}
