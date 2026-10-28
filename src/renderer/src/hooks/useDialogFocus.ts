import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE =
  'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'

function isVisible(node: HTMLElement): boolean {
  const style = window.getComputedStyle(node)
  return node.isConnected && node.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none'
}

function topModalDialog(): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]'))
    .filter(isVisible)
    .at(-1)
}

/** Keep keyboard focus inside a modal and return it to its opener on close. */
export function useDialogFocus<T extends HTMLElement>(
  dialogRef: RefObject<T | null>,
  onClose: () => void,
  enabled = true
) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!enabled) return
    const dialog = dialogRef.current
    if (!dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusFirst = () => {
      if (topModalDialog() !== dialog) return
      const first = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).find(isVisible)
      ;(first ?? dialog).focus()
    }
    const focusFrame = requestAnimationFrame(focusFirst)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || topModalDialog() !== dialog) return
      if (event.key === 'Escape') {
        // A popover opened from this dialog handles Escape before the dialog.
        if (dialog.querySelector('.popover-wrap [aria-expanded="true"]')) return
        if (dialog.querySelector('select:open')) {
          event.stopImmediatePropagation()
          return
        }
        event.preventDefault()
        event.stopImmediatePropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      event.stopImmediatePropagation()
      const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isVisible)
      if (!nodes.length) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      cancelAnimationFrame(focusFrame)
      const top = topModalDialog()
      if (previous?.isConnected && (!top || top.contains(previous))) previous.focus()
    }
  }, [dialogRef, enabled])
}
