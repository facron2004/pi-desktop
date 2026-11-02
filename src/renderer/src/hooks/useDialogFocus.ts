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

/** A menu opened from this dialog is portaled to `document.body`, so it is not a child. */
function insideDialog(dialog: HTMLElement, node: Node | null): boolean {
  if (!node) return false
  if (dialog.contains(node)) return true
  return (
    node instanceof Element &&
    Boolean(node.closest('.popover')) &&
    Boolean(dialog.querySelector('.popover-wrap [aria-expanded="true"]'))
  )
}

export interface DialogFocusOptions {
  enabled?: boolean
  /**
   * `first` lands on the first control (the old behaviour); `dialog` keeps the
   * focus on the container so a programmatically focused icon button does not
   * flash a focus ring the moment the dialog opens.
   */
  initialFocus?: 'first' | 'dialog'
}

/** Keep keyboard focus inside a modal and return it to its opener on close. */
export function useDialogFocus<T extends HTMLElement>(
  dialogRef: RefObject<T | null>,
  onClose: () => void,
  enabledOrOptions: boolean | DialogFocusOptions = true
) {
  const enabled =
    typeof enabledOrOptions === 'boolean' ? enabledOrOptions : enabledOrOptions.enabled !== false
  const initialFocus =
    typeof enabledOrOptions === 'boolean' ? 'first' : (enabledOrOptions.initialFocus ?? 'first')
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!enabled) return
    const dialog = dialogRef.current
    if (!dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusInitial = () => {
      if (topModalDialog() !== dialog) return
      if (initialFocus === 'dialog') {
        dialog.focus()
        return
      }
      const first = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).find(isVisible)
      ;(first ?? dialog).focus()
    }
    const focusFrame = requestAnimationFrame(focusInitial)

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
      const active = document.activeElement
      // The container itself has tabIndex=-1; Tab from it still has to enter
      // the dialog rather than walking out of the modal.
      const atContainer = active === dialog
      if (event.shiftKey && (active === first || atContainer || !insideDialog(dialog, active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || atContainer || !insideDialog(dialog, active))) {
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
  }, [dialogRef, enabled, initialFocus])
}
