import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'

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
  width?: number
  className?: string
}

export function Popover({
  renderTrigger,
  children,
  align = 'left',
  width,
  className
}: PopoverProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
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

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onFocusIn = (event: FocusEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
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
      {open ? (
        <div
          className={`popover ${className ?? ''}`}
          style={{
            top: 'calc(100% + 6px)',
            [align === 'right' ? 'right' : 'left']: 0,
            width
          }}
        >
          {children(close)}
        </div>
      ) : null}
    </div>
  )
}
