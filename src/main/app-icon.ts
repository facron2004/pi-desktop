import { app, nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { icoPngFrame } from './ico'

/**
 * The id electron-builder stamps on the Windows shortcut (`appId` in
 * `electron-builder.yml`). The window has to claim the same one, or Windows
 * treats a dev run and an installed run as two different apps.
 *
 * The `v3` suffix is not the app version. Windows caches an AppUserModelID
 * with the name and the icon it saw the first time, and never gives them
 * back: `dev.pi.desktop` was first claimed by a dev run that still carried
 * electron.exe's icon, and `dev.pi.desktop.v2` was first registered with the
 * old pixel mark. A fresh id is the only way out.
 */
export const APP_USER_MODEL_ID = 'dev.pi.desktop.v3'

let warned = false

function iconCandidates(name: string): string[] {
  return [
    // Packaged copies sit beside the asar. The shell reads the taskbar icon
    // itself, and it cannot open a file that lives inside the archive.
    path.join(process.resourcesPath, name),
    path.join(app.getAppPath(), 'build', name),
    path.join(path.resolve(__dirname, '../..'), 'build', name)
  ]
}

function firstExisting(name: string): string | undefined {
  return iconCandidates(name).find((file) => existsSync(file))
}

/** Absolute .ico path for the Windows shell. Undefined when the file is absent. */
export function windowsIconFile(): string | undefined {
  const file = firstExisting('icon-geometric.ico')
  return file ? path.resolve(file) : undefined
}

function imageFromFile(file: string | undefined): NativeImage | undefined {
  if (!file) return undefined
  const image = nativeImage.createFromPath(file)
  return image.isEmpty() ? undefined : image
}

/** Window and Alt-Tab icon. The taskbar icon is applied separately on Windows. */
export function windowIconImage(): NativeImage | undefined {
  const fromIco = imageFromFile(windowsIconFile())
  if (fromIco) return fromIco
  const fromPng = imageFromFile(firstExisting('icon-geometric.png'))
  if (fromPng) return fromPng
  if (!warned) {
    warned = true
    console.error('[pi-desktop] application icon missing; the taskbar keeps the Electron icon')
  }
  return undefined
}

/** Tray slot. Prefer the 32px frame so the app mark is not resampled. */
export function trayIconImage(): NativeImage | undefined {
  const file = windowsIconFile()
  if (file) {
    const frame = icoPngFrame(file, process.platform === 'darwin' ? 22 : 32)
    if (frame) {
      const image = nativeImage.createFromBuffer(frame)
      if (!image.isEmpty()) return image
    }
  }
  const image = windowIconImage()
  if (!image) return undefined
  const size = process.platform === 'darwin' ? 22 : 32
  return image.resize({ width: size, height: size, quality: 'best' })
}

/**
 * Point the Windows taskbar at the app icon.
 *
 * The AppUserModelID belongs to the window, and it must not also be set on
 * the process. `app.setAppUserModelId` registers the id for the process, and
 * the shell then files that registration under the executable's own icon -
 * electron.exe's atom in a dev run. A window that reuses the registered id
 * inherits that entry and its own `appIconPath` is ignored; the taskbar
 * keeps drawing the Electron logo. A window that carries an id of its own
 * is registered from `appIconPath`, and the taskbar draws the app mark.
 *
 * The window icon is set as well, because it is what the taskbar falls back
 * to and what Alt-Tab shows.
 */
export function applyTaskbarIcon(window: BrowserWindow): void {
  const image = windowIconImage()
  if (image && !window.isDestroyed()) window.setIcon(image)
  if (process.platform !== 'win32' || window.isDestroyed()) return
  const file = windowsIconFile()
  if (!file) return
  try {
    window.setAppDetails({
      appId: APP_USER_MODEL_ID,
      appIconPath: file,
      relaunchDisplayName: 'Pi Desktop'
    })
  } catch (error) {
    console.error('[pi-desktop] could not set the taskbar icon:', error)
  }
}