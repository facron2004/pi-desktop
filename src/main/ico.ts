import { readFileSync } from 'node:fs'

/**
 * The PNG frames inside an .ico file.
 *
 * An .ico is a directory of images, and Windows allows each of them to be a
 * PNG rather than a bitmap. Electron's own loader keeps only the largest
 * frame, so a reader that wants one particular pixel size has to walk the
 * directory itself.
 */

export interface IcoFrame {
  /** Pixel width of the frame. A 256px frame is stored as 0 in the directory. */
  size: number
  /** The PNG bytes of the frame. */
  data: Buffer
}

/** The PNG signature, read little-endian the way the directory stores it. */
const PNG_SIGNATURE = 0x474e5089

/** Every PNG-compressed frame in an .ico, in directory order. */
export function icoPngFrames(file: string): IcoFrame[] {
  try {
    const data = readFileSync(file)
    if (data.length < 6 || data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1) return []
    const count = data.readUInt16LE(4)
    const frames: IcoFrame[] = []
    for (let index = 0; index < count; index += 1) {
      const entry = 6 + index * 16
      if (entry + 16 > data.length) break
      const size = data[entry] === 0 ? 256 : data[entry]
      const length = data.readUInt32LE(entry + 8)
      const offset = data.readUInt32LE(entry + 12)
      if (offset + length > data.length || length < 8) continue
      if (data.readUInt32LE(offset) !== PNG_SIGNATURE) continue
      frames.push({ size, data: data.subarray(offset, offset + length) })
    }
    return frames
  } catch {
    return []
  }
}

/** The frame whose pixel size is closest to `target`. */
export function icoPngFrame(file: string, target: number): Buffer | undefined {
  let best: IcoFrame | undefined
  for (const frame of icoPngFrames(file)) {
    if (!best || Math.abs(frame.size - target) < Math.abs(best.size - target)) best = frame
  }
  return best?.data
}

/** The largest PNG frame, as a data URL. */
export function icoPngDataUrl(file: string): string | undefined {
  const largest = icoPngFrames(file).reduce<IcoFrame | undefined>(
    (top, frame) => (!top || frame.size > top.size ? frame : top),
    undefined
  )
  return largest ? `data:image/png;base64,${largest.data.toString('base64')}` : undefined
}
