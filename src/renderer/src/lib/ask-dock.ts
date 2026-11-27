import { useSyncExternalStore } from 'react'

/**
 * Where a blocking question rests: the slot above one of the two composers.
 *
 * A question the agent asks (`desktop_ask_user`, or any extension's `select`)
 * used to arrive as a centered modal over a dimmed window. It belongs to the
 * conversation on screen, though, and the reader answers it from the input box
 * — so the card docks on that box instead: same column, same width, nothing
 * dimmed, and the transcript it is about stays readable.
 *
 * `ExtensionDialog` lives at the app root while the composers live deep in the
 * conversation branch, so the slot is found through this small store rather
 * than the component tree. A surface with no composer on screen (a desk page,
 * the side panel closed) simply has no host, and the dialog keeps its modal
 * presentation there.
 */
export type AskDockSurface = 'main' | 'side'

const hosts: Record<AskDockSurface, HTMLElement | null> = { main: null, side: null }
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** The slot a mounted composer hands over. */
export function setAskDockHost(surface: AskDockSurface, node: HTMLElement | null): void {
  if (hosts[surface] === node) return
  hosts[surface] = node
  emit()
}

/**
 * A host that goes away only clears its slot once React has finished the
 * commit: a remount detaches the old node and attaches the new one in the same
 * commit, and clearing first would drop the card back to a modal for a frame.
 */
export function releaseAskDockHost(surface: AskDockSurface, node: HTMLElement): void {
  if (hosts[surface] !== node) return
  queueMicrotask(() => {
    if (hosts[surface] === node) setAskDockHost(surface, null)
  })
}

export function askDockHost(surface: AskDockSurface): HTMLElement | null {
  return hosts[surface]
}

/** Notified whenever any slot is published or cleared. */
export function subscribeAskDock(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The slot for that surface, or null while the surface has no composer. */
export function useAskDockHost(surface: AskDockSurface): HTMLElement | null {
  return useSyncExternalStore(
    subscribeAskDock,
    () => askDockHost(surface),
    () => null
  )
}
