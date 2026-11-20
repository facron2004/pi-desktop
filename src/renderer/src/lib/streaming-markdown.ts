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

interface TailCheckpoint {
  /** Offset in `split.tail` at a `\n` boundary before any trailing blank run or incomplete line. */
  cursor: number
  fence: { marker: string; length: number } | null
  htmlEnd: RegExp | undefined
  listIndent: number | null
  inQuote: boolean
  inIndented: boolean
  lastNonBlankLine: string
  hasRefDef: boolean
}

const tailCheckpoints = new WeakMap<StreamingMarkdownSplit, TailCheckpoint>()

function freshCheckpoint(hasRefDef = false): TailCheckpoint {
  return {
    cursor: 0,
    fence: null,
    htmlEnd: undefined,
    listIndent: null,
    inQuote: false,
    inIndented: false,
    lastNonBlankLine: '',
    hasRefDef
  }
}

/**
 * Advance a live split when text is appended to its current tail. Finished
 * blocks have already passed the safe-boundary scan, so only lines from the
 * saved checkpoint onward need scanning. A reference definition is
 * document-global and collapses the split back into a single live tail.
 */
export function appendStreamingMarkdown(
  previous: StreamingMarkdownSplit,
  delta: string
): StreamingMarkdownSplit {
  if (!delta) return previous
  const prevCheckpoint = tailCheckpoints.get(previous)
  const growingTail = previous.tail + delta
  const checkStart = prevCheckpoint
    ? prevCheckpoint.cursor
    : Math.max(0, previous.tail.lastIndexOf('\n') + 1)
  const deltaHasRefDef =
    prevCheckpoint?.hasRefDef ||
    REFERENCE_DEFINITION.test(
      prevCheckpoint ? growingTail.slice(checkStart) : previous.blocks.length ? growingTail : previous.tail.slice(checkStart) + delta
    )

  if (deltaHasRefDef) {
    const full = previous.blocks.length ? previous.blocks.join('') + growingTail : growingTail
    const next: StreamingMarkdownSplit = { blocks: [], tail: full }
    tailCheckpoints.set(next, freshCheckpoint(true))
    return next
  }

  if (growingTail.length < MIN_SPLIT_CHARS) {
    const next: StreamingMarkdownSplit = { blocks: previous.blocks, tail: growingTail }
    tailCheckpoints.set(next, freshCheckpoint(false))
    return next
  }

  const next = scanStreamingMarkdown(growingTail, prevCheckpoint ?? freshCheckpoint(false))
  if (!next.blocks.length) {
    if (!previous.blocks.length) return next
    const reused: StreamingMarkdownSplit = { blocks: previous.blocks, tail: next.tail }
    const cp = tailCheckpoints.get(next)
    if (cp) tailCheckpoints.set(reused, cp)
    return reused
  }
  const merged: StreamingMarkdownSplit = {
    blocks: previous.blocks.length ? [...previous.blocks, ...next.blocks] : next.blocks,
    tail: next.tail
  }
  const cp = tailCheckpoints.get(next)
  if (cp) tailCheckpoints.set(merged, cp)
  return merged
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

function scanStreamingMarkdown(text: string, initial: TailCheckpoint): StreamingMarkdownSplit {
  const hasRefDef =
    initial.hasRefDef ||
    REFERENCE_DEFINITION.test(initial.cursor === 0 ? text : text.slice(initial.cursor))
  if (text.length < MIN_SPLIT_CHARS || hasRefDef) {
    const split: StreamingMarkdownSplit = { blocks: [], tail: text }
    tailCheckpoints.set(split, freshCheckpoint(hasRefDef))
    return split
  }

  const complete: string[] = []
  let blockStart = 0
  let fence = initial.fence
  let htmlEnd = initial.htmlEnd
  let listIndent = initial.listIndent
  let inQuote = initial.inQuote
  let inIndented = initial.inIndented
  let lastNonBlankLine = initial.lastNonBlankLine

  let cpCursor = initial.cursor
  let cpFence = fence
  let cpHtmlEnd = htmlEnd
  let cpListIndent = listIndent
  let cpInQuote = inQuote
  let cpInIndented = inIndented
  let cpLastNonBlankLine = lastNonBlankLine
  let cpFrozen = false

  let lineStart = initial.cursor
  while (lineStart < text.length) {
    const nl = text.indexOf('\n', lineStart)
    const hasNewline = nl !== -1
    const lineEnd = hasNewline ? nl + 1 : text.length
    const lineText = text.slice(lineStart, hasNewline ? nl : text.length)
    const trimmed = lineText.trimStart()
    const indent = lineText.length - trimmed.length

    if (!hasNewline) cpFrozen = true

    if (fence) {
      const close = FENCE.exec(lineText)
      if (
        close &&
        close[1][0] === fence.marker &&
        close[1].length >= fence.length &&
        close[2].trim() === ''
      ) {
        fence = null
      }
      if (trimmed.length > 0) lastNonBlankLine = lineText
      if (!cpFrozen) {
        cpCursor = lineEnd
        cpFence = fence
        cpHtmlEnd = htmlEnd
        cpListIndent = listIndent
        cpInQuote = inQuote
        cpInIndented = inIndented
        cpLastNonBlankLine = lastNonBlankLine
      }
      lineStart = lineEnd
      continue
    }

    if (htmlEnd) {
      if (htmlEnd.test(lineText)) htmlEnd = undefined
      if (trimmed.length > 0) lastNonBlankLine = lineText
      if (!cpFrozen) {
        cpCursor = lineEnd
        cpFence = fence
        cpHtmlEnd = htmlEnd
        cpListIndent = listIndent
        cpInQuote = inQuote
        cpInIndented = inIndented
        cpLastNonBlankLine = lastNonBlankLine
      }
      lineStart = lineEnd
      continue
    }

    const open = FENCE.exec(lineText)
    if (open) {
      fence = { marker: open[1][0], length: open[1].length }
      lastNonBlankLine = lineText
      if (!cpFrozen) {
        cpCursor = lineEnd
        cpFence = fence
        cpHtmlEnd = htmlEnd
        cpListIndent = listIndent
        cpInQuote = inQuote
        cpInIndented = inIndented
        cpLastNonBlankLine = lastNonBlankLine
      }
      lineStart = lineEnd
      continue
    }

    const htmlTerminator = htmlBlockTerminator(lineText)
    if (htmlTerminator) {
      if (!htmlTerminator.test(lineText)) htmlEnd = htmlTerminator
      lastNonBlankLine = lineText
      if (!cpFrozen) {
        cpCursor = lineEnd
        cpFence = fence
        cpHtmlEnd = htmlEnd
        cpListIndent = listIndent
        cpInQuote = inQuote
        cpInIndented = inIndented
        cpLastNonBlankLine = lastNonBlankLine
      }
      lineStart = lineEnd
      continue
    }

    if (!trimmed) {
      // A trailing blank line is part of the live tail: there is nothing after
      // it yet that proves the block has really ended.
      let scanPos = lineEnd
      let nextLineText = ''
      let nextHasNewline = false
      let foundNonBlank = false
      while (scanPos < text.length) {
        const nextNl = text.indexOf('\n', scanPos)
        const nextEnd = nextNl !== -1 ? nextNl + 1 : text.length
        const candidate = text.slice(scanPos, nextNl !== -1 ? nextNl : text.length)
        if (candidate.trim()) {
          nextLineText = candidate
          nextHasNewline = nextNl !== -1
          foundNonBlank = true
          break
        }
        scanPos = nextEnd
      }
      if (!foundNonBlank) {
        cpFrozen = true
        break
      }

      const nextTrimmed = nextLineText.trimStart()
      const nextIndent = nextLineText.length - nextTrimmed.length

      let safe = true
      if (listIndent !== null) {
        // A blank line inside a loose list is still the same list. Only a
        // non-list, non-indented line ends it.
        if (LIST_ITEM.test(nextLineText) || nextIndent >= listIndent + 2) safe = false
        else listIndent = null
      } else if (inQuote) {
        if (nextTrimmed.startsWith('>')) safe = false
        else inQuote = false
      } else if (inIndented) {
        if (nextIndent >= 4) safe = false
        else inIndented = false
      }

      // Raw HTML blocks can contain blank lines; never split next to one.
      if (safe && (lastNonBlankLine.trimStart().startsWith('<') || nextTrimmed.startsWith('<'))) {
        safe = false
      }

      if (safe && lineEnd > blockStart) {
        complete.push(text.slice(blockStart, lineEnd))
        blockStart = lineEnd
      }
      if (!nextHasNewline) cpFrozen = true
      if (!cpFrozen) {
        cpCursor = lineEnd
        cpFence = fence
        cpHtmlEnd = htmlEnd
        cpListIndent = listIndent
        cpInQuote = inQuote
        cpInIndented = inIndented
        cpLastNonBlankLine = lastNonBlankLine
      }
      lineStart = lineEnd
      continue
    }

    lastNonBlankLine = lineText
    if (LIST_ITEM.test(lineText)) {
      listIndent = indent
      inQuote = false
      inIndented = false
    } else if (listIndent !== null) {
      if (indent < listIndent + 2) {
        listIndent = null
        if (trimmed.startsWith('>')) {
          inQuote = true
          inIndented = false
        } else {
          inQuote = false
          inIndented = indent >= 4
        }
      }
    } else if (trimmed.startsWith('>')) {
      inQuote = true
      inIndented = false
    } else {
      inQuote = false
      inIndented = indent >= 4
    }

    if (!cpFrozen) {
      cpCursor = lineEnd
      cpFence = fence
      cpHtmlEnd = htmlEnd
      cpListIndent = listIndent
      cpInQuote = inQuote
      cpInIndented = inIndented
      cpLastNonBlankLine = lastNonBlankLine
    }
    lineStart = lineEnd
  }

  const savedCheckpoint: TailCheckpoint =
    cpCursor >= blockStart
      ? {
          cursor: cpCursor - blockStart,
          fence: cpFence,
          htmlEnd: cpHtmlEnd,
          listIndent: cpListIndent,
          inQuote: cpInQuote,
          inIndented: cpInIndented,
          lastNonBlankLine: cpLastNonBlankLine,
          hasRefDef: false
        }
      : freshCheckpoint(false)

  if (complete.length === 0) {
    const split: StreamingMarkdownSplit = { blocks: [], tail: text }
    tailCheckpoints.set(split, savedCheckpoint)
    return split
  }

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
  const split: StreamingMarkdownSplit = { blocks, tail: text.slice(blockStart) }
  tailCheckpoints.set(split, savedCheckpoint)
  return split
}

export function splitStreamingMarkdown(text: string): StreamingMarkdownSplit {
  return scanStreamingMarkdown(text, freshCheckpoint(false))
}

const SETTLED_SPLIT_CACHE_LIMIT = 64
const MAX_CACHED_SETTLED_MARKDOWN_CHARS = 256 * 1024
const settledSplitCache = new Map<string, StreamingMarkdownSplit>()

/**
 * Reuse split block arrays across conversation switches for settled replies so
 * remounting a thread does not re-scan long Markdown documents from scratch.
 */
export function splitSettledMarkdown(text: string): StreamingMarkdownSplit {
  if (text.length < MIN_SPLIT_CHARS || text.length > MAX_CACHED_SETTLED_MARKDOWN_CHARS) {
    return splitStreamingMarkdown(text)
  }
  const hit = settledSplitCache.get(text)
  if (hit) {
    settledSplitCache.delete(text)
    settledSplitCache.set(text, hit)
    return hit
  }
  const split = splitStreamingMarkdown(text)
  settledSplitCache.set(text, split)
  while (settledSplitCache.size > SETTLED_SPLIT_CACHE_LIMIT) {
    const oldest = settledSplitCache.keys().next().value
    if (oldest === undefined) break
    settledSplitCache.delete(oldest)
  }
  return split
}
