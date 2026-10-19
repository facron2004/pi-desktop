import { useEffect, useRef, useState, type ReactNode } from 'react'

interface PopoverProps {
  /**
   * The trigger element. It has to call `toggle` when it is clicked —
   * without it the popover never opens.
   */
  renderTrigger: (state: { open: boolean; toggle: () => void }) => ReactNode
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

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="popover-wrap" ref={containerRef}>
      {renderTrigger({ open, toggle: () => setOpen((value) => !value) })}
      {open ? (
        <div
          className={`popover ${className ?? ''}`}
          style={{
            top: 'calc(100% + 6px)',
            [align === 'right' ? 'right' : 'left']: 0,
            width
          }}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  )
}
