/**
 * Generate the two bitmaps MUI2 paints on the Windows installer wizard:
 *
 *   build/installerHeader.bmp   150 x 57  - the banner on every interior page
 *   build/installerSidebar.bmp  164 x 314 - the artwork on the welcome/finish pages
 *
 * Both are 24-bit, uncompressed BMPs - that is what the NSIS MUI2 header and
 * welcome/finish bitmaps accept. The artwork is the same geometric Pi mark used
 * for the app icon (build/icon-geometric.png), composited onto the brand
 * gradient with a small hand-rolled 5x7 bitmap font. Keeping the font in this
 * file means the generator has no image or font dependencies. The PNG decoder
 * below handles the 8-bit RGBA master; zlib is a Node built-in.
 *
 * Run with: npm run installer-art
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const buildDir = path.join(root, 'build')

const NAVY = [11, 30, 77]
const BLUE = [0, 32, 144]
const CORAL = [207, 79, 61]
const GOLD = [228, 177, 53]
const WHITE = [239, 244, 255]
const MUTED = [150, 172, 214]

// 5x7 glyphs, one row of five pixels per string. Only the characters used in
// the installer artwork are present; anything else is drawn as a blank.
const GLYPHS = {
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  B: ['11110','10001','10001','11110','10001','10001','11110'],
  C: ['01111','10000','10000','10000','10000','10000','01111'],
  D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  F: ['11111','10000','10000','11110','10000','10000','10000'],
  G: ['01111','10000','10000','10111','10001','10001','01111'],
  H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['11111','00100','00100','00100','00100','00100','11111'],
  J: ['00111','00010','00010','00010','00010','10010','01100'],
  K: ['10001','10010','10100','11000','10100','10010','10001'],
  L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'],
  N: ['10001','11001','10101','10011','10001','10001','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'],
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  Q: ['01110','10001','10001','10001','10101','10010','01101'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'],
  V: ['10001','10001','10001','10001','10001','01010','00100'],
  W: ['10001','10001','10001','10101','10101','11011','10001'],
  X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'],
  Z: ['11111','00001','00010','00100','01000','10000','11111'],
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'],
  '3': ['11110','00001','00001','01110','00001','00001','11110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','10000','11110','00001','00001','11110'],
  '6': ['01110','10000','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00001','01110'],
  ' ': ['00000','00000','00000','00000','00000','00000','00000'],
  '.': ['00000','00000','00000','00000','00000','01100','01100'],
  ',': ['00000','00000','00000','00000','01100','01100','00100'],
  '-': ['00000','00000','00000','11111','00000','00000','00000'],
  ':': ['00000','01100','01100','00000','01100','01100','00000']
}

function canvas(width, height, color) {
  const data = Buffer.alloc(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    data[i * 3] = color[0]
    data[i * 3 + 1] = color[1]
    data[i * 3 + 2] = color[2]
  }
  return { width, height, data }
}

function pixel(c, x, y, color, alpha = 1) {
  if (x < 0 || y < 0 || x >= c.width || y >= c.height || alpha <= 0) return
  const i = (y * c.width + x) * 3
  if (alpha >= 1) {
    c.data[i] = color[0]
    c.data[i + 1] = color[1]
    c.data[i + 2] = color[2]
    return
  }
  c.data[i] = Math.round(c.data[i] * (1 - alpha) + color[0] * alpha)
  c.data[i + 1] = Math.round(c.data[i + 1] * (1 - alpha) + color[1] * alpha)
  c.data[i + 2] = Math.round(c.data[i + 2] * (1 - alpha) + color[2] * alpha)
}

function rectangle(c, x, y, width, height, color, alpha = 1) {
  for (let row = y; row < y + height; row++) {
    for (let col = x; col < x + width; col++) pixel(c, col, row, color, alpha)
  }
}

function gradient(c, from, to) {
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const t = (x / (c.width - 1) + y / (c.height - 1)) / 2
      pixel(c, x, y, [
        Math.round(from[0] + (to[0] - from[0]) * t),
        Math.round(from[1] + (to[1] - from[1]) * t),
        Math.round(from[2] + (to[2] - from[2]) * t)
      ])
    }
  }
}

function wordmark(c, text, x, y, scale, color, spacing = 1) {
  let cursor = x
  for (const char of text.toUpperCase()) {
    const glyph = GLYPHS[char] ?? GLYPHS[' ']
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] === '1') rectangle(c, cursor + col * scale, y + row * scale, scale, scale, color)
      }
    }
    cursor += (5 + spacing) * scale
  }
}

function disc(c, cx, cy, radius, color) {
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) pixel(c, x, y, color)
    }
  }
}

/** Composite the RGBA app mark, scaled to `size`, onto the canvas. */
function mark(c, rgba, width, height, x, y, size) {
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const sx = Math.min(width - 1, Math.floor(col * width / size))
      const sy = Math.min(height - 1, Math.floor(row * height / size))
      const s = (sy * width + sx) * 4
      const a = rgba[s + 3] / 255
      if (a <= 0) continue
      pixel(c, x + col, y + row, [rgba[s], rgba[s + 1], rgba[s + 2]], a)
    }
  }
}

/** Decode the 8-bit RGBA master PNG into a raw RGBA buffer (zlib + unfilter). */
function decodePng(file) {
  const png = readFileSync(file)
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  const idat = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const body = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) throw new Error('expected 8-bit RGBA, non-interlaced PNG')
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const rgba = Buffer.alloc(stride * height)
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? row[i - 4] : 0
      const above = previous[i]
      const upperLeft = i >= 4 ? previous[i - 4] : 0
      if (filter === 1) row[i] = (row[i] + left) & 0xff
      else if (filter === 2) row[i] = (row[i] + above) & 0xff
      else if (filter === 3) row[i] = (row[i] + Math.floor((left + above) / 2)) & 0xff
      else if (filter === 4) {
        const p = left + above - upperLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - above)
        const pc = Math.abs(p - upperLeft)
        row[i] = (row[i] + (pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft)) & 0xff
      }
    }
    row.copy(rgba, y * stride)
    previous = row
  }
  return { rgba, width, height }
}

/** Write a 24-bit, bottom-up, BI_RGB BMP - the format NSIS MUI2 expects. */
function writeBmp(file, c) {
  const rowSize = Math.ceil(c.width * 3 / 4) * 4
  const pixelBytes = rowSize * c.height
  const buffer = Buffer.alloc(54 + pixelBytes)
  buffer.write('BM', 0, 'ascii')
  buffer.writeUInt32LE(buffer.length, 2)
  buffer.writeUInt32LE(54, 10)
  buffer.writeUInt32LE(40, 14)
  buffer.writeInt32LE(c.width, 18)
  buffer.writeInt32LE(c.height, 22)
  buffer.writeUInt16LE(1, 26)
  buffer.writeUInt16LE(24, 28)
  buffer.writeUInt32LE(0, 30)
  buffer.writeUInt32LE(pixelBytes, 34)
  buffer.writeInt32LE(2835, 38)
  buffer.writeInt32LE(2835, 42)
  for (let y = 0; y < c.height; y++) {
    const source = (c.height - 1 - y) * c.width * 3
    const target = 54 + y * rowSize
    for (let x = 0; x < c.width; x++) {
      buffer[target + x * 3] = c.data[source + x * 3 + 2]
      buffer[target + x * 3 + 1] = c.data[source + x * 3 + 1]
      buffer[target + x * 3 + 2] = c.data[source + x * 3]
    }
  }
  writeFileSync(file, buffer)
  console.log(`${path.basename(file)}: ${c.width}x${c.height}, ${buffer.length} bytes`)
}

const { rgba, width: sourceWidth, height: sourceHeight } = decodePng(path.join(buildDir, 'icon-geometric.png'))

// Interior-page banner. The gold rule on the right keeps the mark from
  // bleeding into the native window controls painted over the wizard header.
  const header = canvas(150, 57, NAVY)
  gradient(header, NAVY, BLUE)
  mark(header, rgba, sourceWidth, sourceHeight, 4, 14, 29)
  wordmark(header, 'PI DESKTOP', 42, 21, 2, WHITE, 0)
  rectangle(header, 147, 0, 3, 57, GOLD)
  writeBmp(path.join(buildDir, 'installerHeader.bmp'), header)

  // Welcome / finish artwork. Framed by the brand colours, with the three
  // palette dots echoing the three shapes in the mark.
  const sidebar = canvas(164, 314, NAVY)
  gradient(sidebar, NAVY, BLUE)
  rectangle(sidebar, 0, 0, 164, 3, CORAL)
  rectangle(sidebar, 0, 311, 164, 3, GOLD)
  mark(sidebar, rgba, sourceWidth, sourceHeight, 26, 42, 112)
  wordmark(sidebar, 'PI DESKTOP', 27, 180, 2, WHITE)
  wordmark(sidebar, 'AI CODING AGENT', 37, 205, 1, MUTED)
  rectangle(sidebar, 28, 228, 108, 1, GOLD)
  wordmark(sidebar, 'PI PROTOCOL CLIENT', 28, 244, 1, MUTED)
  disc(sidebar, 70, 290, 4, BLUE)
  disc(sidebar, 82, 290, 4, CORAL)
  disc(sidebar, 94, 290, 4, GOLD)
  writeBmp(path.join(buildDir, 'installerSidebar.bmp'), sidebar)
