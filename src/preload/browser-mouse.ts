import { ipcRenderer } from 'electron'

/**
 * The in-app browser is a webview. A page does not own browser history, so the
 * mouse's back and forward keys do nothing unless something outside the page
 * asks the webview to move. This preload is the guest's only script: it
 * exposes nothing to the page and only reports those two buttons.
 *
 * Capture phase, so a page handler cannot swallow the click first. The preload
 * project has no DOM library, so the listener is typed locally.
 */
const page = globalThis as unknown as {
  addEventListener(
    type: 'mouseup',
    listener: (event: { button: number }) => void,
    capture: boolean
  ): void
}

page.addEventListener(
  'mouseup',
  (event) => {
    if (event.button !== 3 && event.button !== 4) return
    ipcRenderer.send('browser:mouse-history', event.button)
  },
  true
)
