import { Notification, type BrowserWindow } from 'electron'
import { windowIconImage } from './app-icon'

export function showDesktopNotification(
  mainWindow: BrowserWindow,
  title: string,
  body: string
): void {
  if (mainWindow.isDestroyed() || !Notification.isSupported()) return

  const icon = windowIconImage()
  const notification = new Notification({
    title,
    body,
    ...(icon ? { icon } : {})
  })

  notification.on('click', () => {
    if (mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  })
  notification.on('failed', (_event, error) => {
    console.error('[pi-desktop] could not show system notification:', error)
  })
  notification.show()
}
