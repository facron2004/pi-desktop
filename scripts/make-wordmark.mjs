/**
 * The pixel wordmark, as a file.
 *
 * `src/renderer/src/components/PiWordmark.tsx` draws the same grid inline (the
 * sidebar needs it in the DOM, where it can follow `currentColor`). This script
 * is the source for the standalone vector: `build/wordmark-pixel.svg`, which is
 * what a README, a store page or a slide deck can drop in.
 *
 *   node scripts/make-wordmark.mjs [--preview]
 *
 * With `--preview` it also rasterises the grid into `output/wordmark-preview/`
 * at 1x and 4x, light and dark, so the drawing can be looked at without a
 * browser. Nothing in the app reads those previews.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Glyphs sit on a 5-column cell; caps fill rows 0-6, lowercase rows 2-6. */
const GLYPHS = {
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....', '.....'],
  i: ['..#..', '.....', '..#..', '..#..', '..#..', '..#..', '.###.', '.....'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.', '.....'],
  e: ['.....', '.....', '.###.', '#...#', '#####', '#....', '.###.', '.....'],
  s: ['.....', '.....', '.####', '#....', '.###.', '....#', '####.', '.....'],
  k: ['#....', '#....', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '.....'],
  t: ['..#..', '..#..', '.###.', '..#..', '..#..', '..#..', '..##.', '.....'],
  o: ['.....', '.....', '.###.', '#...#', '#...#', '#...#', '.###.', '.....'],
  // The only glyph with a descender, so the grid is eight rows tall.
  p: ['.....', '.....', '####.', '#...#', '#...#', '####.', '#....', '#....']
}

const TEXT = 'Pi Desktop'
const WORD_SPACE = 3
const CELL_WIDTH = 5
const ROWS = 8

function layout(text) {
  const glyphs = []
  let x = 0
  for (const character of text) {
    if (character === ' ') {
      x += WORD_SPACE
      continue
    }
    const art = GLYPHS[character]
    if (!art) throw new Error(`no glyph for ${JSON.stringify(character)}`)
    glyphs.push({ character, x, art })
    x += CELL_WIDTH + 1
  }
  // Trim the trailing gap between letters so the right edge is tight.
  return { glyphs, width: x - 1 }
}

/** One sub-path per horizontal run, which keeps the file small and square. */
function toPath(glyphs) {
  const parts = []
  for (const { x, art } of glyphs) {
    for (let row = 0; row < ROWS; row += 1) {
      const line = art[row] ?? ''
      let column = 0
      while (column < CELL_WIDTH) {
        if (line[column] !== '#') {
          column += 1
          continue
        }
        let end = column
        while (end < CELL_WIDTH && line[end] === '#') end += 1
        parts.push(`M${x + column} ${row}h${end - column}v1h-${end - column}z`)
        column = end
      }
    }
  }
  return parts.join('')
}

/** Coral for the `i` dot, matching the app mark. */
const CORAL = '#cf4f3d'
/** The file is the grid at six times, so it opens at a readable size. */
const FILE_SCALE = 6

function svg({ text, ink, accent }) {
  const { glyphs, width } = layout(text)
  const dot = accent
    ? `<rect x="${glyphs[1].x + 2}" y="0" width="1" height="1" fill="${accent}"/>`
    : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${ROWS}" ` +
    `width="${width * FILE_SCALE}" height="${ROWS * FILE_SCALE}" fill="${ink}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="${text}">` +
    `<path d="${toPath(glyphs)}"/>${dot}</svg>\n`
  )
}

/** A PNG writer, so the preview needs no dependency and no browser. */
function png(width, height, rgba) {
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4)
  }
  const table = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  const crc = (buffer) => {
    let c = 0xffffffff
    for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc(body))
    return Buffer.concat([length, body, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function raster(text, scale, pad, background, ink, accent) {
  const { glyphs, width } = layout(text)
  const w = width * scale + pad * 2
  const h = ROWS * scale + pad * 2
  const rgba = Buffer.alloc(w * h * 4)
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const [br, bg, bb] = rgb(background)
  for (let i = 0; i < w * h; i += 1) {
    rgba[i * 4] = br
    rgba[i * 4 + 1] = bg
    rgba[i * 4 + 2] = bb
    rgba[i * 4 + 3] = 255
  }
  const paint = (x, y, hex) => {
    const [r, g, b] = rgb(hex)
    for (let dy = 0; dy < scale; dy += 1) {
      for (let dx = 0; dx < scale; dx += 1) {
        const i = ((y * scale + dy + pad) * w + x * scale + dx + pad) * 4
        rgba[i] = r
        rgba[i + 1] = g
        rgba[i + 2] = b
      }
    }
  }
  for (const { x, art } of glyphs) {
    for (let row = 0; row < ROWS; row += 1) {
      const line = art[row] ?? ''
      for (let column = 0; column < CELL_WIDTH; column += 1) {
        if (line[column] === '#') paint(x + column, row, ink)
      }
    }
  }
  if (accent) paint(glyphs[1].x + 2, 0, accent)
  return { w, h, rgba }
}

const { width, glyphs } = layout(TEXT)
console.log(`grid ${width}x${ROWS} (aspect ${(width / ROWS).toFixed(2)}:1)`)
console.log('cells: ' + glyphs.map((g) => `${g.character}@${g.x}`).join(' '))

const asset = path.join(root, 'build', 'wordmark-pixel.svg')
writeFileSync(asset, svg({ text: TEXT, ink: 'currentColor', accent: CORAL }))
console.log('wrote ' + path.relative(root, asset))

if (process.argv.includes('--preview')) {
  const out = path.join(root, 'output', 'wordmark-preview')
  mkdirSync(out, { recursive: true })
  for (const [name, background, ink] of [
    ['light', '#ffffff', '#16181d'],
    ['dark', '#12141a', '#e8eaf0']
  ]) {
    for (const scale of [1, 4]) {
      const image = raster(TEXT, scale, scale * 2, background, ink, CORAL)
      const file = path.join(out, `${name}-${scale}x.png`)
      writeFileSync(file, png(image.w, image.h, image.rgba))
      console.log('wrote ' + path.relative(root, file))
    }
  }
}
