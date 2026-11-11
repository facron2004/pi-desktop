/**
 * Split a growing Markdown document into finished blocks and a live tail.
 *
 * `react-markdown` parses the whole document on every render. While Pi is
 * streaming, that means the cost of a long answer grows with its total length
 * on every animation frame — even though only the last paragraph changed.
 * Parsing finished blocks once and re-parsing only the tail keeps the per-frame
 * cost tied to what is actually being written.
 *
 * The split has to be conservative. A wrong boundary changes what the reader
 * sees (a list restarting at 1, a blockquote losing its bar, a reference link
 * turning into literal text), so anything this scanner is unsure about stays
 * in the tail and is parsed as part of the live document.
 */

export interface StreamingMarkdownSplit {
  /** Finished block groups, safe to parse once and memoise. */
  blocks: string[]
  /** The still-growing remainder, parsed on every delta. */
  tail: string
}

/**
 * Advance a live split when text is appended to its current tail. Finished
 * blocks have already passed the safe-boundary scan, so only the tail needs
 * scanning again. A reference definition is document-global and forces the
 * original whole-document path.
 */
export function appendStreamingMarkdown(
  previous: StreamingMarkdownSplit,
  delta: string
): StreamingMarkdownSplit {
  if (!delta) return previous
  const growingTail = previous.tail + delta
  if (!previous.blocks.length || REFERENCE_DEFINITION.test(growingTail)) {
    return splitStreamingMarkdown(previous.blocks.join('') + growingTail)
  }
  const next = splitStreamingMarkdown(growingTail)
  if (!next.blocks.length) return { blocks: previous.blocks, tail: next.tail }
  return { blocks: [...previous.blocks, ...next.blocks], tail: next.tail }
}

/** Below this a whole-document parse is cheap and splitting is not worth it. */
const MIN_SPLIT_CHARS = 1200

/**
 * Finished blocks are grouped until they reach this size. Smaller groups mean
 * a block that closes later never forces a long re-parse; larger groups keep
 * the number of `react-markdown` instances small.
 */
const CHUNK_CHARS = 1600

const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
/** Reference definitions are document-global: splitting would break tail links. */
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:[ \t]*\S/m

function htmlBlockTerminator(line: string): RegExp | undefined {
  const trimmed = line.trimStart()
  if (line.length - trimmed.length > 3) return undefined
  const tag = /^<(script|pre|style|textarea)(?:[\s/>]|$)/i.exec(trimmed)?.[1]
  if (tag) return new RegExp(`<\\/${tag}\\s*>`, 'i')
  if (trimmed.startsWith('<!--')) return /-->/
  if (trimmed.startsWith('<?')) return /\?>/
  if (/^<!\[CDATA\[/i.test(trimmed)) return /\]\]>/
  if (/^<![A-Z]/.test(trimmed)) return />/
  return undefined
}

interface Line {
  text: string
  start: number
  /** End of the line including its newline, when it has one. */
  end: number
}

function linesOf(text: string): Line[] {
  const lines: Line[] = []
  let start = 0
  while (start <= text.length) {
    const newline = text.indexOf('\n', start)
    if (newline === -1) {
      lines.push({ text: text.slice(start), start, end: text.length })
      break
    }
    lines.push({ text: text.slice(start, newline), start, end: newline + 1 })
    start = newline + 1
  }
  return lines
}

export function splitStreamingMarkdown(text: string): StreamingMarkdownSplit {
  if (text.length < MIN_SPLIT_CHARS || REFERENCE_DEFINITION.test(text)) {
    return { blocks: [], tail: text }
  }

  const lines = linesOf(text)
  const complete: string[] = []
  let blockStart = 0
  let fence: { marker: string; length: number } | null = null
  let htmlEnd: RegExp | undefined
  let listIndent: number | null = null
  let inQuote = false
  let inIndented = false

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.text.trimStart()
    const indent = line.text.length - trimmed.length

    if (fence) {
      const close = FENCE.exec(line.text)
      if (
        close &&
        close[1][0] === fence.marker &&
        close[1].length >= fence.length &&
        close[2].trim() === ''
      ) {
        fence = null
      }
      continue
    }

    if (htmlEnd) {
      if (htmlEnd.test(line.text)) htmlEnd = undefined
      continue
    }

    const open = FENCE.exec(line.text)
    if (open) {
      fence = { marker: open[1][0], length: open[1].length }
      continue
    }

    const htmlTerminator = htmlBlockTerminator(line.text)
    if (htmlTerminator) {
      if (!htmlTerminator.test(line.text)) htmlEnd = htmlTerminator
      continue
    }

    if (!line.text.trim()) {
      // A trailing blank line is part of the live tail: there is nothing after
      // it yet that proves the block has really ended.
      let nextIndex = index + 1
      while (nextIndex < lines.length && !lines[nextIndex].text.trim()) nextIndex += 1
      if (nextIndex >= lines.length) continue

      const next = lines[nextIndex].text
      const nextTrimmed = next.trimStart()
      const nextIndent = next.length - nextTrimmed.length
      let previousIndex = index - 1
      while (previousIndex >= 0 && !lines[previousIndex].text.trim()) previousIndex -= 1
      const previous = previousIndex >= 0 ? lines[previousIndex].text : ''

      let safe = true
      if (listIndent !== null) {
        // A blank line inside a loose list is still the same list. Only a
        // non-list, non-indented line ends it.
        if (LIST_ITEM.test(next) || nextIndent >= listIndent + 2) safe = false
        else listIndent = null
      } else if (inQuote) {
        if (nextTrimmed.startsWith('>')) safe = false
        else inQuote = false
      } else if (inIndented) {
        if (nextIndent >= 4) safe = false
        else inIndented = false
      }

      // Raw HTML blocks can contain blank lines; never split next to one.
      if (safe && (previous.trimStart().startsWith('<') || nextTrimmed.startsWith('<'))) {
        safe = false
      }

      if (safe && line.end > blockStart) {
        complete.push(text.slice(blockStart, line.end))
        blockStart = line.end
      }
      continue
    }

    if (LIST_ITEM.test(line.text)) {
      listIndent = indent
      inQuote = false
      inIndented = false
      continue
    }
    if (listIndent !== null) {
      if (indent >= listIndent + 2) continue
      listIndent = null
    }
    if (trimmed.startsWith('>')) {
      inQuote = true
      inIndented = false
      continue
    }
    inQuote = false
    if (indent >= 4) {
      inIndented = true
      continue
    }
    inIndented = false
  }

  if (complete.length === 0) return { blocks: [], tail: text }

  const blocks: string[] = []
  let current = ''
  for (const block of complete) {
    current += block
    if (current.length >= CHUNK_CHARS) {
      blocks.push(current)
      current = ''
    }
  }
  // Keep the small trailing chunk with the finished blocks: it is complete
  // Markdown and must not be re-parsed on every delta. Only the still-growing
  // last block is the tail. If another block completes later, this chunk is
  // re-parsed once and then stays memoised.
  if (current) blocks.push(current)
  return { blocks, tail: text.slice(blockStart) }
}
