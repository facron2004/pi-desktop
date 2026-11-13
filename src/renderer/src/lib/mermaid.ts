/**
 * Pure helpers for the Mermaid plugin.
 *
 * Nothing in this module touches the DOM or imports `mermaid`; the renderer
 * component and the Node tests can both use it. The heavy library lives in
 * `mermaid-renderer.ts` behind a dynamic import.
 */

/** A recognised Mermaid diagram type, as shown in the block's toolbar. */
export interface MermaidDiagramType {
  /** Mermaid's own id (`flowchart`, `sequence`, …). */
  id: string
  /** English label. The component passes it through `useT`. */
  label: string
}

interface DiagramTypeDefinition extends MermaidDiagramType {
  pattern: RegExp
}

/**
 * The detector table mirrors Mermaid's own diagram detectors, but it runs on
 * the source text synchronously: a streaming fence can be labelled before the
 * library has finished loading. Order matters — `flowchart` must not catch
 * `flowchart-elk` before it, and `classDiagram` must precede the bare `class`
 * keyword.
 */
const DIAGRAM_TYPE_DEFINITIONS: readonly DiagramTypeDefinition[] = [
  { id: 'flowchart', label: 'Flowchart', pattern: /^\s*(?:flowchart|graph)(?:\s|$)/ },
  { id: 'swimlane', label: 'Swimlane', pattern: /^\s*swimlane-beta\b/ },
  { id: 'sequence', label: 'Sequence diagram', pattern: /^\s*sequenceDiagram\b/ },
  { id: 'classDiagram', label: 'Class diagram', pattern: /^\s*classDiagram(?:-v2)?\b/ },
  { id: 'state', label: 'State diagram', pattern: /^\s*stateDiagram(?:-v2)?\b/ },
  { id: 'er', label: 'ER diagram', pattern: /^\s*erDiagram\b/ },
  { id: 'journey', label: 'User journey', pattern: /^\s*journey\b/ },
  { id: 'gantt', label: 'Gantt chart', pattern: /^\s*gantt\b/ },
  { id: 'pie', label: 'Pie chart', pattern: /^\s*pie\b/ },
  { id: 'quadrant', label: 'Quadrant chart', pattern: /^\s*quadrantChart\b/ },
  { id: 'requirement', label: 'Requirement diagram', pattern: /^\s*requirement(?:Diagram)?\b/ },
  { id: 'gitGraph', label: 'Git graph', pattern: /^\s*gitGraph\b/ },
  { id: 'mindmap', label: 'Mind map', pattern: /^\s*mindmap\b/ },
  { id: 'timeline', label: 'Timeline', pattern: /^\s*timeline\b/ },
  { id: 'kanban', label: 'Kanban board', pattern: /^\s*kanban\b/ },
  { id: 'sankey', label: 'Sankey diagram', pattern: /^\s*sankey(?:-beta)?\b/ },
  { id: 'xyChart', label: 'XY chart', pattern: /^\s*xychart(?:-beta)?\b/ },
  { id: 'block', label: 'Block diagram', pattern: /^\s*block(?:-beta)?\b/ },
  { id: 'packet', label: 'Packet diagram', pattern: /^\s*packet(?:-beta)?\b/ },
  { id: 'architecture', label: 'Architecture diagram', pattern: /^\s*architecture\b/ },
  { id: 'c4', label: 'C4 diagram', pattern: /^\s*C4(?:Context|Container|Component|Dynamic|Deployment)\b/ },
  { id: 'radar', label: 'Radar chart', pattern: /^\s*radar-beta\b/ },
  { id: 'treemap', label: 'Treemap', pattern: /^\s*treemap\b/ },
  { id: 'venn', label: 'Venn diagram', pattern: /^\s*venn-beta\b/ },
  { id: 'wardley', label: 'Wardley map', pattern: /^\s*wardley-beta\b/i },
  { id: 'eventmodeling', label: 'Event modeling', pattern: /^\s*eventmodeling\b/ },
  { id: 'ishikawa', label: 'Ishikawa diagram', pattern: /^\s*ishikawa(?:-beta)?\b/i },
  { id: 'treeView', label: 'Tree view', pattern: /^\s*treeView-beta\b/ },
  { id: 'cynefin', label: 'Cynefin', pattern: /^\s*cynefin-beta\b/ },
  {
    id: 'railroad',
    label: 'Railroad diagram',
    pattern: /^\s*railroad(?:-beta|-ebnf-beta|-abnf-beta|-peg-beta)?\b/i
  },
  { id: 'info', label: 'Info diagram', pattern: /^\s*info\b/ }
]

/** Every label `detectMermaidDiagramType` can return, in detector order. */
export const MERMAID_DIAGRAM_TYPES: readonly MermaidDiagramType[] = DIAGRAM_TYPE_DEFINITIONS.map(
  ({ id, label }) => ({ id, label })
)

/** Whether a fenced code block's language should be rendered as a diagram. */
export function isMermaidLanguage(language: string | undefined): boolean {
  const value = (language ?? '').trim().toLowerCase()
  return value === 'mermaid' || value === 'mmd'
}

/**
 * Normalise a fence body without changing Mermaid's significant layout:
 * indentation matters to mind maps, so only line endings, trailing spaces and
 * the wrapping blank lines are touched.
 */
export function normalizeMermaidSource(source: string): string {
  if (!source) return ''
  return source
    .replace(/^\uFEFF/, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '')
}

/**
 * The first line that actually starts a diagram.
 *
 * A fence may carry YAML frontmatter (`--- title: … ---`) and `%%` comments
 * or directives before the diagram header. A partial frontmatter returns an
 * empty string: there is no type to show yet while the fence is still being
 * written.
 */
function diagramHeaderLine(source: string): string {
  let text = normalizeMermaidSource(source)
  while (text) {
    if (text.startsWith('---')) {
      const rest = text.slice(3)
      const close = /(?:^|\n)---[ \t]*(?=\n|$)/.exec(rest)
      if (!close) return ''
      text = rest.slice(close.index + close[0].length).replace(/^\n+/, '')
      continue
    }
    const newline = text.indexOf('\n')
    const line = (newline === -1 ? text : text.slice(0, newline)).trim()
    if (!line || line.startsWith('%%')) {
      if (newline === -1) return ''
      text = text.slice(newline + 1).replace(/^\n+/, '')
      continue
    }
    return line
  }
  return ''
}

/** Detect the diagram type from a (possibly partial) fence body. */
export function detectMermaidDiagramType(source: string): MermaidDiagramType | null {
  const line = diagramHeaderLine(source)
  if (!line) return null
  const definition = DIAGRAM_TYPE_DEFINITIONS.find((type) => type.pattern.test(line))
  if (!definition) return null
  // A left-to-right flowchart with two or more subgraphs is the conventional
  // Mermaid spelling of a swimlane: the subgraphs are the lanes. Label it as
  // such so the reader knows what they are looking at (the source still says
  // `flowchart`, because Mermaid has no native swimlane type).
  if (
    definition.id === 'flowchart' &&
    /^(?:flowchart|graph)\s+(?:LR|RL)\b/i.test(line) &&
    (source.match(/^\s*subgraph\b/gim) ?? []).length >= 2
  ) {
    return { id: 'swimlane', label: 'Swimlane' }
  }
  return { id: definition.id, label: definition.label }
}

/** The label the block header shows; falls back while the header is incomplete. */
export function mermaidDiagramLabel(source: string, fallback = 'Diagram'): string {
  return detectMermaidDiagramType(source)?.label ?? fallback
}

/** The palette the renderer resolves from the app's CSS custom properties. */
export interface MermaidPalette {
  background: string
  surface: string
  surfaceRaised: string
  surfaceSunken: string
  text: string
  textMuted: string
  textFaint: string
  border: string
  borderStrong: string
  accent: string
  accentContrast: string
  accentSoft: string
  success: string
  warning: string
  danger: string
  fontFamily: string
  /** Soft drop shadow used by nodes and cards inside the SVG. */
  shadow: string
  /** Categorical colours for pie slices, git branches and scale ramps. */
  series: readonly string[]
}

/**
 * Build Mermaid's `themeVariables` from app colours.
 *
 * Kept pure and explicit so the mapping is testable and a theme change is a
 * single function call. Values are real CSS colours resolved from `tokens.css`
 * by `mermaid-renderer.ts` — no hard-coded brand hex belongs here.
 */
export function buildMermaidThemeVariables(palette: MermaidPalette): Record<string, string> {
  const {
    background,
    surface,
    surfaceRaised,
    surfaceSunken,
    text,
    textMuted,
    textFaint,
    border,
    borderStrong,
    accent,
    accentContrast,
    accentSoft,
    success,
    warning,
    danger,
    fontFamily,
    series
  } = palette

  const variables: Record<string, string> = {
    background,
    primaryColor: surfaceRaised,
    primaryTextColor: text,
    primaryBorderColor: borderStrong,
    secondaryColor: surface,
    secondaryTextColor: text,
    secondaryBorderColor: border,
    tertiaryColor: surfaceSunken,
    tertiaryTextColor: text,
    tertiaryBorderColor: border,
    lineColor: textMuted,
    textColor: text,
    mainBkg: surfaceRaised,
    nodeBorder: borderStrong,
    nodeTextColor: text,
    clusterBkg: surface,
    clusterBorder: border,
    edgeLabelBackground: surfaceRaised,
    titleColor: text,
    fontFamily,
    fontSize: '14px',
    // Sequence diagrams
    actorBkg: surfaceRaised,
    actorBorder: borderStrong,
    actorTextColor: text,
    actorLineColor: textFaint,
    signalColor: textMuted,
    signalTextColor: text,
    labelBoxBkgColor: surfaceRaised,
    labelBoxBorderColor: borderStrong,
    labelTextColor: text,
    loopTextColor: text,
    noteBkgColor: accentSoft,
    noteBorderColor: accent,
    noteTextColor: text,
    activationBkgColor: accentSoft,
    activationBorderColor: accent,
    sequenceNumberColor: accentContrast,
    // Gantt and journey sections
    sectionBkgColor: surface,
    altSectionBkgColor: background,
    sectionBkgColor2: surfaceRaised,
    taskBkgColor: accentSoft,
    taskBorderColor: accent,
    taskTextColor: text,
    taskTextOutsideColor: text,
    taskTextLightColor: text,
    taskTextDarkColor: text,
    taskTextClickableColor: accent,
    activeTaskBkgColor: accent,
    activeTaskBorderColor: accent,
    gridColor: border,
    doneTaskBkgColor: success,
    doneTaskBorderColor: success,
    critBkgColor: danger,
    critBorderColor: danger,
    todayLineColor: warning,
    // Pie
    pieTitleTextColor: text,
    pieSectionTextColor: text,
    pieLegendTextColor: text,
    pieStrokeColor: background,
    pieOuterStrokeColor: border,
    pieOpacity: '0.92',
    // Quadrant
    quadrant1Fill: accentSoft,
    quadrant2Fill: surface,
    quadrant3Fill: surfaceSunken,
    quadrant4Fill: surfaceRaised,
    quadrant1TextFill: text,
    quadrant2TextFill: text,
    quadrant3TextFill: text,
    quadrant4TextFill: text,
    quadrantPointFill: accent,
    quadrantPointTextFill: accentContrast,
    quadrantXAxisTextFill: textMuted,
    quadrantYAxisTextFill: textMuted,
    quadrantInternalBorderStrokeFill: border,
    quadrantExternalBorderStrokeFill: borderStrong,
    quadrantTitleFill: text,
    // ER / class / state
    attributeBackgroundColorOdd: surfaceRaised,
    attributeBackgroundColorEven: surfaceSunken
  }

  series.forEach((color, index) => {
    variables[`pie${index + 1}`] = color
    variables[`cScale${index}`] = color
    variables[`cScaleLabel${index}`] = text
  })

  return variables
}

/**
 * Extra CSS Mermaid injects into the rendered SVG.
 *
 * Theme variables control colours; this layer controls the shape language that
 * makes a product diagram read as a designed artifact: rounded nodes, a softer
 * hierarchy, tinted decision diamonds and lane headers, and restrained shadows.
 * It intentionally stays away from per-diagram layout so one diagram type
 * cannot look unrelated to the rest.
 */
export function buildMermaidThemeCss(palette: MermaidPalette): string {
  const { surfaceRaised, border, accent, accentSoft, shadow, fontFamily } = palette
  return `
.node rect, .node circle, .node ellipse, .node polygon, .node path {
  stroke-width: 1.2px;
}
.node rect, .node circle, .node ellipse {
  rx: 9px;
  ry: 9px;
}
.node polygon {
  fill: ${accentSoft} !important;
  stroke: ${accent} !important;
}
.node rect, .node circle, .node ellipse, .node polygon {
  filter: drop-shadow(0 3px 8px ${shadow});
}
.nodeLabel, .label {
  font-family: ${fontFamily};
  font-weight: 600;
  letter-spacing: 0.012em;
}
.edgePath .path {
  stroke-width: 1.4px;
}
.edgeLabel rect {
  rx: 5px;
  ry: 5px;
}
.cluster rect {
  rx: 14px;
  ry: 14px;
  stroke-dasharray: 4 6;
  fill-opacity: 0.5;
}
.cluster-label .nodeLabel, .cluster-label span {
  font-weight: 600;
  letter-spacing: 0.04em;
}
.cluster-label .nodeLabel {
  padding: 1px 8px;
  border: 1px solid ${border};
  border-radius: 999px;
  background: ${surfaceRaised};
}
.actor {
  rx: 8px;
  ry: 8px;
  filter: drop-shadow(0 2px 5px ${shadow});
}
.messageText, .loopText, .noteText {
  font-size: 13px;
}
.sectionTitle, .titleText, .pieTitleText {
  font-weight: 600;
  letter-spacing: 0.01em;
}
.grid .tick line {
  stroke-opacity: 0.32;
}
`
}

export interface MermaidSvgSize {
  width: number
  height: number
}

function toPositiveNumber(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number.parseFloat(value.replace(/px$/i, '').trim())
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * Read the natural size Mermaid wrote onto the `<svg>` element.
 *
 * `useMaxWidth:false` makes the library emit pixel dimensions; the viewBox is
 * the fallback for diagrams that only carry a viewBox.
 */
export function readMermaidSvgSize(svg: string): MermaidSvgSize | null {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0]
  if (!tag) return null
  const width = toPositiveNumber(/\bwidth="([^"]+)"/i.exec(tag)?.[1])
  const height = toPositiveNumber(/\bheight="([^"]+)"/i.exec(tag)?.[1])
  if (width !== null && height !== null) return { width, height }
  const viewBox = /\bviewBox="([^"]+)"/i.exec(tag)?.[1]
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] }
    }
  }
  return null
}

function escapeXmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

/**
 * Make a rendered SVG stand on its own when downloaded.
 *
 * Mermaid draws transparently: the app surface shows through on screen, but a
 * file opened in an image viewer gets the viewer's white page. A background
 * rect in the current palette keeps the diagram readable outside the app.
 */
export function prepareMermaidSvgForDownload(svg: string, background: string): string {
  const match = /<svg\b[^>]*>/i.exec(svg)
  if (!match) return svg
  let openTag = match[0]
  if (!/\bxmlns=/.test(openTag)) {
    openTag = openTag.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  }
  const rect = `<rect x="0" y="0" width="100%" height="100%" fill="${escapeXmlAttribute(background)}"/>`
  const bodyStart = match.index + match[0].length
  return `${svg.slice(0, match.index)}${openTag}${rect}${svg.slice(bodyStart)}`
}

/** A short, readable message for an arbitrary render failure. */
export function formatMermaidError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error && typeof error === 'object' && 'message' in error
          ? String((error as { message?: unknown }).message ?? '')
          : ''
  const text = raw.replace(/\u001b\[[0-9;]*m/g, '').trim()
  if (!text) return 'The diagram could not be rendered.'
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text
}
