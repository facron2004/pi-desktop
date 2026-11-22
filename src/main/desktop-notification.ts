import { Notification, type BrowserWindow } from 'electron'
import type { AgentMessage } from '@shared/types'
import { windowIconImage } from './app-icon'

/** Pi's agent_end contains the messages produced by this run. */
export function describeRunCompletion(messages: unknown): { body: string; failed: boolean } {
  const assistant = Array.isArray(messages)
    ? (messages as AgentMessage[]).findLast((message) => message?.role === 'assistant')
    : undefined
  const failed = assistant?.stopReason === 'error'
  const content = assistant?.content
  let text = ''
  if (failed) {
    text = assistant.errorMessage ?? ''
  } else if (typeof content === 'string' && assistant?.stopReason !== 'toolUse') {
    text = content
  } else if (Array.isArray(content)) {
    const lastTool = content.findLastIndex((block) => block.type === 'toolCall')
    text = content.slice(lastTool + 1)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
  }
  const preview = text.replace(/[\s\u0000-\u001f]+/g, ' ').trim()
  const body = preview.length > 480
    ? `${preview.slice(0, 479).replace(/[\uD800-\uDBFF]$/, '').trimEnd()}…`
    : preview
  return { body, failed }
}

/**
 * A system notification, with the app mark and the click-to-focus behaviour.
 *
 * **The sender name is the executable's, not the window's.** Windows groups
 * toasts under an app identity resolved from the AppUserModelID, and a run
 * that has no id of its own falls back to `electron.app.Electron` — so a dev
 * run of `electron.exe` is labelled "Electron" in the notification center
 * while the packaged `Pi Desktop.exe` is labelled "Pi Desktop". That is the
 * packaged product name in its version resource, and it is the whole reason
 * the two builds differ here.
 *
 * Do not try to fix the dev label by other means; each was measured against
 * the real notification database (`wpndatabase.db`) and the center UI:
 *
 * - `app.setName('Pi Desktop')` changes `app.getName()` only. The toast keeps
 *   landing on the `electron.app.Electron` handler, so the group stays
 *   "Electron".
 * - Writing `HKCU\Software\Classes\AppUserModelId\<id>\DisplayName` does not
 *   reach the center either; a custom id only renames the handler record.
 * - `groupTitle` adds a header line inside the card, so the reader sees
 *   "Electron" above a second "Pi Desktop" — worse than the plain card.
 *
 * The remaining option is a Start-menu shortcut carrying the id, which would
 * mean writing into the user's Start menu on every dev launch. The packaged
 * build already carries the right name and icon, so that cost buys nothing
 * for anyone who is not running the source tree.
 */
export function showDesktopNotification(
  mainWindow: BrowserWindow,
  { title, body, onActivate, reply }: {
    title: string
    body: string
    onActivate: () => void
    reply?: { placeholder: string; submit: (message: string) => void }
  }
): void {
  if (mainWindow.isDestroyed() || !Notification.isSupported()) return

  const icon = windowIconImage()
  const inlineReply = process.platform === 'win32' || process.platform === 'darwin' ? reply : undefined
  const notification = new Notification({
    title,
    body,
    ...(icon ? { icon } : {}),
    ...(inlineReply ? { hasReply: true, replyPlaceholder: inlineReply.placeholder } : {})
  })

  notification.on('click', () => {
    if (mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
    onActivate()
  })
  if (inlineReply) {
    notification.once('reply', (event) => {
      const message = event.reply.trim()
      if (message && !mainWindow.isDestroyed()) inlineReply.submit(message)
    })
  }
  notification.on('failed', (_event, error) => {
    console.error('[pi-desktop] could not show system notification:', error)
  })
  notification.show()
}
