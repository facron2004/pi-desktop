import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
let observer: MutationObserver | null = null
let currentDark = readIsDark()

function readIsDark(): boolean {
  return typeof document === 'undefined'
    ? true
    : document.documentElement.dataset.theme !== 'light'
}

function subscribeIsDark(listener: () => void): () => void {
  listeners.add(listener)
  if (!observer && typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
    currentDark = readIsDark()
    observer = new MutationObserver(() => {
      const next = readIsDark()
      if (next === currentDark) return
      currentDark = next
      for (const notify of listeners) notify()
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && observer) {
      observer.disconnect()
      observer = null
    }
  }
}

function getIsDarkSnapshot(): boolean {
  return observer ? currentDark : readIsDark()
}

/**
 * Whether the app is currently in the dark theme.
 *
 * The theme lives on the document element; a single shared MutationObserver
 * broadcasts changes to every mounted code block, diagram and terminal pane.
 */
export function useIsDark(): boolean {
  return useSyncExternalStore(subscribeIsDark, getIsDarkSnapshot, () => true)
}
