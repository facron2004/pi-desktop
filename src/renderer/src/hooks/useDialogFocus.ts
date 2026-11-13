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
  if (!(node instanceof Element)) return false
  const popover = node.closest<HTMLElement>('.popover[data-popover-id]')
  if (!popover) return false
  const popoverId = popover.dataset.popoverId
  return Boolean(
    popoverId &&
    Array.from(dialog.querySelectorAll<HTMLElement>('.popover-wrap[data-open="true"]'))
      .some((wrap) => wrap.dataset.popoverId === popoverId)
  )
}

function focusableNodes(dialog: HTMLElement): HTMLElement[] {
  const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isVisible)
  const nodesWithPortals: HTMLElement[] = []
  for (const node of nodes) {
    nodesWithPortals.push(node)
    const wrap = node.closest<HTMLElement>('.popover-wrap[data-open="true"]')
    if (!wrap || wrap.querySelector<HTMLElement>(FOCUSABLE) !== node) continue
    const portal = Array.from(document.querySelectorAll<HTMLElement>('.popover[data-popover-id]'))
      .find((item) => item.dataset.popoverId === wrap.dataset.popoverId)
    if (portal) nodesWithPortals.push(...Array.from(portal.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isVisible))
  }
  return nodesWithPortals
}

function isPopoverTabStop(dialog: HTMLElement, node: Node | null): node is HTMLElement {
  if (!(node instanceof HTMLElement)) return false
  const portal = node.closest<HTMLElement>('.popover[data-popover-id]')
  if (portal) return insideDialog(dialog, node)
  const wrap = node.closest<HTMLElement>('.popover-wrap[data-open="true"]')
  if (!wrap || wrap.querySelector<HTMLElement>(FOCUSABLE) !== node) return false
  return Array.from(document.querySelectorAll<HTMLElement>('.popover[data-popover-id]'))
    .some((item) => item.dataset.popoverId === wrap.dataset.popoverId)
}

export interface DialogFocusOptions {
  enabled?: boolean
  /**
   * `first` lands on the first control (the old behaviour); `dialog` keeps the
   * focus on the container so a programmatically focused icon button does not
   * flash a focus ring the moment the dialog opens.
   */
  initialFocus?: 'first' | 'dialog'
  /**
   * Whether this layer claims Escape. A side panel drawn as an overlay is not
   * a modal dialog: its own content (a find box, a maximized view) has to see
   * Escape first, so it turns this off and handles the key itself.
   */
  closeOnEscape?: boolean
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
  const closeOnEscape =
    typeof enabledOrOptions === 'boolean' ? true : enabledOrOptions.closeOnEscape !== false
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!enabled) return
    const dialog = dialogRef.current
    if (!dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusInitial = () => {
      if (topModalDialog() !== dialog) return
      // A child that already took focus (React's `autoFocus` runs during
      // commit) is the intended landing spot; stealing it back to the dialog's
      // first control made a create form impossible to type into.
      const active = document.activeElement
      if (active instanceof HTMLElement && active !== dialog && dialog.contains(active)) return
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
        if (!closeOnEscape) return
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
      const nodes = focusableNodes(dialog)
      if (!nodes.length) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const active = document.activeElement
      if (isPopoverTabStop(dialog, active)) {
        const index = nodes.indexOf(active)
        if (index >= 0) {
          event.preventDefault()
          const offset = event.shiftKey ? -1 : 1
          nodes[(index + offset + nodes.length) % nodes.length].focus()
          return
        }
      }
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
  }, [dialogRef, enabled, initialFocus, closeOnEscape])
}
