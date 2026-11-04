import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The platform's colour emoji font, read once for the renderer.
 *
 * Chromium normally resolves emoji through the OS font registry, but on this
 * Windows image the registry entry for `Segoe UI Emoji` has an empty path even
 * though `seguiemj.ttf` is on disk. Loading the file through the FontFace API
 * bypasses that broken registry entry; the same lookup covers macOS and Linux,
 * where the renderer can use Apple Color Emoji or Noto Color Emoji.
 */
let cached: Uint8Array | null | undefined

function candidates(): string[] {
  if (process.platform === 'win32') {
    const windir = process.env.WINDIR ?? 'C:\\Windows'
    return [
      path.join(windir, 'Fonts', 'seguiemj.ttf'),
      ...(process.env.LOCALAPPDATA
        ? [path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts', 'seguiemj.ttf')]
        : [])
    ]
  }
  if (process.platform === 'darwin') {
    return [
      '/System/Library/Fonts/Apple Color Emoji.ttc',
      '/System/Library/Fonts/Supplemental/Apple Color Emoji.ttc',
      '/Library/Fonts/Apple Color Emoji.ttc'
    ]
  }
  return [
    '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf',
    '/usr/share/fonts/noto/NotoColorEmoji.ttf',
    '/usr/share/fonts/truetype/noto/NotoEmoji-Regular.ttf'
  ]
}

/** Bytes of the emoji font, or null when this platform has none installed. */
export function readEmojiFont(): Uint8Array | null {
  if (cached !== undefined) return cached
  for (const file of candidates()) {
    try {
      if (!existsSync(file)) continue
      cached = new Uint8Array(readFileSync(file))
      return cached
    } catch {
      // A font can disappear between the check and the read; try the next.
    }
  }
  cached = null
  return null
}
