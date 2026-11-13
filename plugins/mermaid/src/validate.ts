/**
 * Deterministic, dependency-free Mermaid syntax pre-flight checks.
 *
 * This is a fast first pass for the mistakes language models make most often,
 * not a replacement for Mermaid's own parser. It never imports a renderer:
 * the extension loads lovely-mermaid separately and only for the preview.
 */

export interface MermaidValidationError {
  /** 1-based source line. */
  line: number
  message: string
  /** The concrete edit that fixes the problem. */
  fix?: string
}

export interface MermaidValidationResult {
  ok: boolean
  diagramType: string
  errors: MermaidValidationError[]
  warnings: string[]
}

export type DiagramType =
  | 'flowchart'
  | 'sequence'
  | 'state'
  | 'class'
  | 'er'
  | 'journey'
  | 'gantt'
  | 'mindmap'
  | 'timeline'
  | 'quadrant'
  | 'requirement'
  | 'kanban'
  | 'architecture'
  | 'pie'
  | 'gitGraph'
  | 'unknown'

interface HeaderMatch {
  type: DiagramType
  /** 1-based line where the header was found. */
  line: number
  text: string
}

const HEADER_RULES: ReadonlyArray<{ type: DiagramType; pattern: RegExp }> = [
  { type: 'flowchart', pattern: /^(?:flowchart|graph)\b/i },
  { type: 'sequence', pattern: /^sequenceDiagram\b/i },
  { type: 'state', pattern: /^stateDiagram(?:-v2)?\b/i },
  { type: 'class', pattern: /^classDiagram(?:-v2)?\b/i },
  { type: 'er', pattern: /^erDiagram\b/i },
  { type: 'journey', pattern: /^journey\b/i },
  { type: 'gantt', pattern: /^gantt\b/i },
  { type: 'mindmap', pattern: /^mindmap\b/i },
  { type: 'timeline', pattern: /^timeline\b/i },
  { type: 'quadrant', pattern: /^quadrantChart\b/i },
  { type: 'requirement', pattern: /^requirementDiagram\b/i },
  { type: 'kanban', pattern: /^kanban\b/i },
  { type: 'architecture', pattern: /^architecture-beta\b/i },
  { type: 'pie', pattern: /^pie\b/i },
  { type: 'gitGraph', pattern: /^gitGraph\b/i }
]

const FLOW_DIRECTIONS = new Set(['TD', 'TB', 'BT', 'LR', 'RL'])

const SUPPORTED_HEADERS =
  'flowchart TD, graph LR, sequenceDiagram, stateDiagram-v2, journey, gantt, mindmap, timeline, quadrantChart, requirementDiagram, kanban, architecture-beta, pie'

const OPENERS: Record<string, string> = { '[': ']', '(': ')', '{': '}' }
const CLOSERS: Record<string, string> = { ']': '[', ')': '(', '}': '{' }

/** Drop a trailing %% comment; a line that is entirely a comment yields ''. */
function codePart(line: string): string {
  if (line.trimStart().startsWith('%%')) return ''
  const index = line.indexOf('%%')
  return index === -1 ? line : line.slice(0, index)
}

/** Locate the Mermaid header, skipping blank lines, comments and YAML frontmatter. */
function findHeader(lines: string[]): { header?: HeaderMatch; frontmatterError?: MermaidValidationError } {
  let index = 0
  while (index < lines.length && lines[index].trim() === '') index += 1

  if (index < lines.length && lines[index].trim() === '---') {
    const start = index
    index += 1
    while (index < lines.length && lines[index].trim() !== '---') index += 1
    if (index >= lines.length) {
      return {
        frontmatterError: {
          line: start + 1,
          message: 'Frontmatter opened with --- but never closed',
          fix: 'Add a closing --- line before the diagram header.'
        }
      }
    }
    index += 1
  }

  for (; index < lines.length; index += 1) {
    const code = codePart(lines[index]).trim()
    if (!code) continue
    for (const rule of HEADER_RULES) {
      if (rule.pattern.test(code)) {
        return { header: { type: rule.type, line: index + 1, text: code } }
      }
    }
    return { header: { type: 'unknown', line: index + 1, text: code } }
  }
  return {}
}

function checkBrackets(lines: string[], errors: MermaidValidationError[]): void {
  const stack: Array<{ char: string; line: number }> = []

  lines.forEach((line, index) => {
    const code = codePart(line)
    let inQuote = false
    for (const char of code) {
      if (char === '"') {
        inQuote = !inQuote
        continue
      }
      if (inQuote) continue
      if (char in OPENERS) {
        stack.push({ char, line: index + 1 })
        continue
      }
      if (char in CLOSERS) {
        const top = stack.pop()
        if (!top || top.char !== CLOSERS[char]) {
          errors.push({
            line: index + 1,
            message: `Unmatched closing '${char}'`,
            fix: `Remove the extra '${char}' or add the matching '${OPENERS[CLOSERS[char]]}' before it.`
          })
        }
      }
    }
  })

  for (const entry of stack.reverse()) {
    errors.push({
      line: entry.line,
      message: `Unclosed '${entry.char}'`,
      fix: `Add the missing '${OPENERS[entry.char]}' at the end of this label or block.`
    })
  }
}

/**
 * Extract `[...]` and `{...}` node labels from one line, ignoring brackets that
 * sit inside a quoted label. Quoted labels may themselves contain `[` or `]`.
 */
function nodeLabels(code: string): string[] {
  const labels: string[] = []
  for (let index = 0; index < code.length; index += 1) {
    const opener = code[index]
    if (opener !== '[' && opener !== '{') continue
    const closer = opener === '[' ? ']' : '}'
    let inQuote = false
    let end = index + 1
    for (; end < code.length; end += 1) {
      const char = code[end]
      if (char === '"') {
        inQuote = !inQuote
        continue
      }
      if (!inQuote && char === closer) break
    }
    if (end >= code.length) break
    labels.push(code.slice(index + 1, end))
    index = end
  }
  return labels
}

function checkFlowchart(header: HeaderMatch, lines: string[], errors: MermaidValidationError[]): void {
  const match = /^(?:flowchart|graph)\s+([A-Za-z]+)/i.exec(header.text)
  if (!match) {
    errors.push({
      line: header.line,
      message: 'Flowchart is missing a direction',
      fix: 'Put TD, TB, BT, LR or RL after the header, for example `flowchart TD`.'
    })
  } else if (!FLOW_DIRECTIONS.has(match[1].toUpperCase())) {
    errors.push({
      line: header.line,
      message: `Unsupported flowchart direction "${match[1]}"`,
      fix: 'Use one of TD, TB, BT, LR or RL, for example `flowchart LR`.'
    })
  }

  // subgraph/end balance: an `end` without a subgraph is the common copy error.
  const subgraphs: Array<{ line: number; label: string }> = []
  const ends: number[] = []
  lines.forEach((line, index) => {
    const code = codePart(line).trim()
    const subgraph = /^subgraph\b\s*(.*)$/i.exec(code)
    if (subgraph) subgraphs.push({ line: index + 1, label: subgraph[1].trim() })
    if (/^end\s*$/i.test(code)) ends.push(index + 1)
  })

  for (let index = ends.length; index < subgraphs.length; index += 1) {
    const subgraph = subgraphs[index]
    errors.push({
      line: subgraph.line,
      message: `Subgraph ${subgraph.label ? `"${subgraph.label}" ` : ''}is never closed`,
      fix: 'Add a matching `end` line after the last node in this subgraph.'
    })
  }
  for (let index = subgraphs.length; index < ends.length; index += 1) {
    errors.push({
      line: ends[index],
      message: '`end` has no matching `subgraph`',
      fix: 'Add a `subgraph` before this line or remove the extra `end`.'
    })
  }

  // Unquoted parentheses inside node labels break Mermaid's parser.
  lines.forEach((line, index) => {
    for (const label of nodeLabels(codePart(line))) {
      if (!label.includes('(') && !label.includes(')')) continue
      const trimmed = label.trim()
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) continue
      errors.push({
        line: index + 1,
        message: `Node label "${trimmed}" contains unquoted parentheses`,
        fix: `Wrap the whole label in double quotes, for example A["${trimmed.replace(/"/g, '#quot;')}"].`
      })
    }
  })

  const nodeCount = new Set(
    [...lines.map((line) => codePart(line)).join('\n').matchAll(/\b([A-Za-z0-9_]+)\s*(?:\[|\{|\()/g)].map((match) => match[1])
  ).size
  if (nodeCount > 20) {
    errors.push({
      line: header.line,
      message: `Flowchart has ${nodeCount} nodes, which is hard to read`,
      fix: 'Keep it to about 20 nodes or split it into smaller diagrams.'
    })
  }
}

function checkSequence(header: HeaderMatch, lines: string[], errors: MermaidValidationError[]): void {
  const hasMessage = lines.some((line) => /(?:-->>|->>)/.test(codePart(line)))
  if (!hasMessage) {
    errors.push({
      line: header.line,
      message: 'Sequence diagram has no messages',
      fix: 'Add a message with an arrow, for example `Client->>Service: request`.'
    })
  }
}

function checkGantt(header: HeaderMatch, lines: string[], errors: MermaidValidationError[]): void {
  const hasDateFormat = lines.some((line) => /^\s*dateFormat\s+\S+/.test(codePart(line)))
  if (!hasDateFormat) {
    errors.push({
      line: header.line,
      message: 'Gantt diagram is missing dateFormat',
      fix: 'Add `dateFormat YYYY-MM-DD` directly under the `gantt` header.'
    })
  }
}

function checkRequirement(header: HeaderMatch, lines: string[], errors: MermaidValidationError[]): void {
  const requirementLines = lines
    .map((line, index) => ({ code: codePart(line).trim(), line: index + 1 }))
    .filter((entry) => /^requirement\b/.test(entry.code))
  if (requirementLines.length === 0) {
    errors.push({
      line: header.line,
      message: 'Requirement diagram has no requirement block',
      fix: 'Add `requirement R1 { ... }` with id, text, risk and verifymethod fields.'
    })
  }
  for (const entry of requirementLines) {
    if (!entry.code.includes('{')) {
      errors.push({
        line: entry.line,
        message: 'Requirement block is missing its opening brace',
        fix: 'Put `{` on the same line, for example `requirement R1 {`.'
      })
    }
  }
}

function checkPie(header: HeaderMatch, lines: string[], errors: MermaidValidationError[]): void {
  const hasSlice = lines.some((line) => /^\s*"[^"]+"\s*:\s*\d+(?:\.\d+)?\s*$/.test(codePart(line)))
  if (!hasSlice) {
    errors.push({
      line: header.line,
      message: 'Pie chart has no data slices',
      fix: 'Add a slice such as `"Discovery" : 30`.'
    })
  }
}

function checkTimeline(header: HeaderMatch, lines: string[], errors: MermaidValidationError[]): void {
  const hasEvent = lines.some((line) => /^\s*[^:\s][^:]*\s*:\s*\S/.test(codePart(line)))
  if (!hasEvent) {
    errors.push({
      line: header.line,
      message: 'Timeline has no events',
      fix: 'Add a period and event such as `2026-01 : Kickoff`.'
    })
  }
}

function checkQuadrant(header: HeaderMatch, lines: string[], errors: MermaidValidationError[]): void {
  const hasAxis = lines.some((line) => /^\s*[xy]-axis\b/.test(codePart(line)))
  if (!hasAxis) {
    errors.push({
      line: header.line,
      message: 'Quadrant chart is missing its axes',
      fix: 'Add `x-axis Low --> High` and `y-axis Low --> High`.'
    })
  }
}

function collectWarnings(header: HeaderMatch | undefined, lines: string[]): string[] {
  const warnings: string[] = []
  if (!header) return warnings
  const contentLines = lines.filter((line) => codePart(line).trim() !== '').length
  if (contentLines <= 1) warnings.push('Diagram has no content after the header')
  return warnings
}

/**
 * Validate Mermaid source without a renderer.
 *
 * The result always carries a line number for every error and, where possible,
 * a concrete fix. Warnings never fail validation.
 */
export function validateMermaid(source: string): MermaidValidationResult {
  const errors: MermaidValidationError[] = []
  const warnings: string[] = []

  if (typeof source !== 'string' || source.trim().length === 0) {
    return {
      ok: false,
      diagramType: 'unknown',
      errors: [{ line: 1, message: 'Mermaid source is empty', fix: 'Paste the diagram source or use a template first.' }],
      warnings
    }
  }

  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const { header, frontmatterError } = findHeader(lines)
  if (frontmatterError) errors.push(frontmatterError)

  if (!header || header.type === 'unknown') {
    errors.push({
      line: header?.line ?? 1,
      message: header ? `Unknown diagram type "${header.text.split(/\s+/)[0]}"` : 'No Mermaid diagram header found',
      fix: `Start the source with a supported header, for example: ${SUPPORTED_HEADERS}.`
    })
    checkBrackets(lines, errors)
    return { ok: false, diagramType: 'unknown', errors, warnings }
  }

  checkBrackets(lines, errors)

  switch (header.type) {
    case 'flowchart':
      checkFlowchart(header, lines, errors)
      break
    case 'sequence':
      checkSequence(header, lines, errors)
      break
    case 'gantt':
      checkGantt(header, lines, errors)
      break
    case 'requirement':
      checkRequirement(header, lines, errors)
      break
    case 'pie':
      checkPie(header, lines, errors)
      break
    case 'timeline':
      checkTimeline(header, lines, errors)
      break
    case 'quadrant':
      checkQuadrant(header, lines, errors)
      break
    default:
      break
  }

  warnings.push(...collectWarnings(header, lines))
  return { ok: errors.length === 0, diagramType: header.type, errors, warnings }
}
