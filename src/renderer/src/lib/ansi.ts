/**
 * A very small ANSI reader for the terminal drawer.
 *
 * Programs colour their output with SGR sequences (`ESC [ ... m`). Showing
 * those bytes literally turns the log into noise, and dropping the whole
 * output would lose the text, so the text is split into runs that share one
 * style and the sequences themselves disappear.
 *
 * Only the SGR codes the drawer can render are honoured: 30–37/90–97 for the
 * foreground, 1/2/22 for intensity and 0/39 to go back to the default. Every
 * other escape — cursor movement, screen clearing, OSC titles, charsets — is
 * removed rather than printed; the drawer is not a full terminal emulator and
 * should not pretend to be one.
 */

export type AnsiTone =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'bright-black'
  | 'bright-red'
  | 'bright-green'
  | 'bright-yellow'
  | 'bright-blue'
  | 'bright-magenta'
  | 'bright-cyan'
  | 'bright-white'
  | 'dim'

export interface AnsiSegment {
  text: string
  tone?: AnsiTone
  bold?: boolean
  dim?: boolean
}

const ESC = '\u001b'
const BEL = '\u0007'

const BASIC_TONES: Record<number, AnsiTone> = {
  30: 'black',
  31: 'red',
  32: 'green',
  33: 'yellow',
  34: 'blue',
  35: 'magenta',
  36: 'cyan',
  37: 'white'
}

const BRIGHT_TONES: Record<number, AnsiTone> = {
  90: 'bright-black',
  91: 'bright-red',
  92: 'bright-green',
  93: 'bright-yellow',
  94: 'bright-blue',
  95: 'bright-magenta',
  96: 'bright-cyan',
  97: 'bright-white'
}

/** The style a run of text is drawn with. `tone` is absent at the default. */
interface Style {
  tone?: AnsiTone
  bold: boolean
  dim: boolean
}

function resetStyle(style: Style): void {
  style.tone = undefined
  style.bold = false
  style.dim = false
}

function append(segments: AnsiSegment[], text: string, style: Style): void {
  if (!text) return
  const last = segments[segments.length - 1]
  if (last && last.tone === style.tone && !!last.bold === style.bold && !!last.dim === style.dim) {
    last.text += text
    return
  }
  const segment: AnsiSegment = { text }
  if (style.tone) segment.tone = style.tone
  if (style.bold) segment.bold = true
  if (style.dim) segment.dim = true
  segments.push(segment)
}

/**
 * `ESC [ … m` parameters. An empty parameter is 0, as the spec says, and a
 * missing body means a bare `ESC [ m` — also a reset.
 */
function parseParams(body: string): number[] {
  if (!body) return [0]
  return body.split(/[;:]/).map((part) => {
    const value = Number.parseInt(part, 10)
    return Number.isFinite(value) ? value : 0
  })
}

/** Apply one SGR sequence to the running style. */
function applySgr(body: string, style: Style): void {
  const params = parseParams(body)
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index]
    if (code === 0) {
      resetStyle(style)
    } else if (code === 1) {
      style.bold = true
    } else if (code === 2) {
      style.dim = true
      if (!style.tone) style.tone = 'dim'
    } else if (code === 22) {
      style.bold = false
      style.dim = false
      if (style.tone === 'dim') style.tone = undefined
    } else if (code === 39) {
      style.tone = undefined
    } else if (BASIC_TONES[code] || BRIGHT_TONES[code]) {
      style.tone = BASIC_TONES[code] ?? BRIGHT_TONES[code]
    } else if (code === 38 || code === 48 || code === 58) {
      // Extended colour (256-colour or true colour). Unsupported, but its
      // arguments still have to be consumed or they read as SGR codes.
      const mode = params[index + 1]
      if (mode === 5) index += 2
      else if (mode === 2) index += 4
    }
    // Everything else (backgrounds, underline, blink, inverse…) has no visual
    // equivalent here and is ignored; it never reaches the log.
  }
}

/**
 * Split `text` into styled runs.
 *
 * The plain text is recovered by joining the `text` of every segment, which is
 * also how `stripAnsi` works — copy must never carry the escape bytes.
 */
export function parseAnsi(text: string): AnsiSegment[] {
  if (!text.includes(ESC)) return text ? [{ text }] : []

  const segments: AnsiSegment[] = []
  const style: Style = { bold: false, dim: false }
  let plain = ''

  const flush = (): void => {
    append(segments, plain, style)
    plain = ''
  }

  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char !== ESC) {
      plain += char
      index += 1
      continue
    }

    const next = text[index + 1]
    if (next === '[') {
      // CSI ends on the first byte in 0x40–0x7E (the final byte).
      let end = index + 2
      while (end < text.length) {
        const code = text.charCodeAt(end)
        if (code >= 0x40 && code <= 0x7e) break
        end += 1
      }
      if (end >= text.length) break // still arriving; the next chunk completes it
      const final = text[end]
      if (final === 'm') {
        flush()
        applySgr(text.slice(index + 2, end), style)
      }
      index = end + 1
      continue
    }

    if (next === ']' || next === 'P' || next === '^' || next === '_') {
      // OSC/DCS/PM/APC: terminated by BEL or by ST (`ESC \`).
      let end = index + 2
      while (end < text.length) {
        if (text[end] === BEL) {
          end += 1
          break
        }
        if (text[end] === ESC && text[end + 1] === '\\') {
          end += 2
          break
        }
        end += 1
      }
      index = end
      continue
    }

    if (next === '(' || next === ')' || next === '*' || next === '+' || next === '#' || next === '%') {
      // Character-set designation: `ESC ( B` and friends; the designator byte
      // belongs to the sequence.
      index = Math.min(text.length, index + 3)
      continue
    }

    if (next === undefined) break
    // Any other two-byte escape. `ESC c` is a full reset.
    if (next === 'c') {
      flush()
      resetStyle(style)
    }
    index += 2
  }

  flush()
  return segments
}

/** The text with every escape sequence removed — what copy and search use. */
export function stripAnsi(text: string): string {
  if (!text.includes(ESC)) return text
  return parseAnsi(text)
    .map((segment) => segment.text)
    .join('')
}
