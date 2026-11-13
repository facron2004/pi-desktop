/**
 * Mermaid authoring extension for Pi.
 *
 * Gives the model a `mermaid` tool (starter templates + syntax check) and a
 * `/mermaid` command for a guided template picker. Lovely-mermaid renders the
 * Unicode preview; it is optional at load time so the plugin still works in a
 * Pi build that does not ship a terminal Mermaid renderer.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { TEMPLATES, TEMPLATE_IDS, buildTemplate, templateLabel, type TemplateId } from '../src/templates.ts'
import { validateMermaid, type MermaidValidationError } from '../src/validate.ts'

const POLICY_MARKER = 'PI MERMAID POLICY'

const MERMAID_POLICY = `${POLICY_MARKER}
When the user asks for a diagram, use Mermaid and choose the smallest correct type: flowchart for process/decisions, flowchart with subgraph for swimlanes, sequence for interactions, stateDiagram-v2 for lifecycle, journey for experience, gantt for schedule, mindmap for structure, timeline for milestones, quadrantChart for prioritisation, requirementDiagram for requirements, kanban for work items, architecture-beta for systems, pie for proportions.
PM conventions: start labels with a verb, keep them short, use at most ~20 nodes, label every branch (|Yes| / |No|), and keep one idea per node. Leave colours to the host theme; do not hardcode fills unless the user asks for a status or risk colour.
Mermaid pitfalls: quote labels containing punctuation, parentheses, commas or brackets (A["Review (draft)"]); close every subgraph with end; never put raw < or > inside a label; Chinese labels are fine; use %% for comments.
Before presenting a diagram, call the mermaid tool with action=check and fix every reported error. Show the final source in a \`\`\`mermaid code block.`

const DIAGRAM_PROMPT_PATTERN =
  /\b(?:mermaid|diagrams?|flowcharts?|swimlanes?|sequences?|state[- ]?(?:diagrams?|machines?)|stateDiagram(?:-v2)?|gantt|mindmaps?|timelines?|quadrants?|kanban|requirements?|architecture)\b|流程图|泳道图|时序图|状态图|甘特图|思维导图|时间线|象限图|看板|需求图|架构图|图表/iu

const MAX_PREVIEW_COLUMNS = 80
const MAX_PREVIEW_ROWS = 30

interface MermaidArt {
  plain: string[]
  width: number
  warnings?: string[]
}

interface MermaidRendererModule {
  render(source: string): MermaidArt | null
  diagramKind?(source: string): string | null
}

interface MermaidToolDetails {
  action: 'template' | 'check'
  template?: string
  title?: string
  source?: string
  ok?: boolean
  diagramType?: string
  errors?: MermaidValidationError[]
  warnings?: string[]
  preview?: string
  previewWidth?: number
  previewRows?: number
  previewTruncated?: boolean
}

interface Preview {
  text: string
  width: number
  rows: number
  truncated: boolean
}

let rendererPromise: Promise<MermaidRendererModule | null> | undefined

/**
 * lovely-mermaid is Pi's renderer; grok-mermaid is the older package name some
 * Pi builds and this repository still carry. Either provides the same
 * `render()` shape, so try both and degrade to no preview when neither exists.
 */
async function loadRenderer(): Promise<MermaidRendererModule | null> {
  if (!rendererPromise) {
    rendererPromise = (async () => {
      const specifiers: string[] = ['lovely-mermaid', 'grok-mermaid']
      for (const specifier of specifiers) {
        try {
          const loaded: unknown = await import(specifier)
          const candidate = loaded as Partial<MermaidRendererModule>
          if (typeof candidate.render === 'function') return candidate as MermaidRendererModule
        } catch {
          // The package is optional; the next candidate may still be installed.
        }
      }
      return null
    })()
  }
  return rendererPromise
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  )
}

function visualWidth(text: string): number {
  let width = 0
  for (const char of text) width += isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1
  return width
}

function truncateToColumns(text: string, maxColumns: number): string {
  let width = 0
  let output = ''
  for (const char of text) {
    const next = isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1
    if (width + next > maxColumns) {
      const chars = [...output]
      chars.pop()
      return `${chars.join('')}…`
    }
    output += char
    width += next
  }
  return output
}

/** Mermaid comments are valid input but some terminal parsers do not skip them. */
function withoutComments(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => (line.trimStart().startsWith('%%') ? '' : line.replace(/\s*%%.*$/, '')))
    .join('\n')
}

async function buildPreview(source: string): Promise<Preview | null> {
  const renderer = await loadRenderer()
  if (!renderer) return null
  try {
    const art = renderer.render(withoutComments(source))
    if (!art || !Array.isArray(art.plain) || art.plain.length === 0) return null
    const rowsTruncated = art.plain.length > MAX_PREVIEW_ROWS
    const lines = art.plain.slice(0, MAX_PREVIEW_ROWS).map((line) => truncateToColumns(line, MAX_PREVIEW_COLUMNS))
    const columnsTruncated = art.plain.some((line) => visualWidth(line) > MAX_PREVIEW_COLUMNS)
    if (rowsTruncated) lines.push(`… (${art.plain.length - MAX_PREVIEW_ROWS} more rows)`)
    return {
      text: lines.join('\n'),
      width: art.width,
      rows: art.plain.length,
      truncated: rowsTruncated || columnsTruncated
    }
  } catch {
    return null
  }
}

function checkReport(result: ReturnType<typeof validateMermaid>, preview: Preview | null): string {
  const lines: string[] = [`mermaid check: ${result.ok ? 'OK' : 'FAILED'} — ${result.diagramType}`]
  if (result.errors.length === 0) {
    lines.push('Errors: none')
  } else {
    lines.push(`Errors (${result.errors.length}):`)
    for (const error of result.errors) {
      lines.push(`- line ${error.line}: ${error.message}`)
      if (error.fix) lines.push(`  fix: ${error.fix}`)
    }
  }
  lines.push(result.warnings.length > 0 ? `Warnings: ${result.warnings.join('; ')}` : 'Warnings: none')
  if (preview) {
    lines.push(
      `Preview (${preview.width} columns, ${preview.rows} rows${preview.truncated ? '; trimmed to 80×30' : ''}):`
    )
    lines.push('```text')
    lines.push(preview.text)
    lines.push('```')
  } else {
    lines.push('Preview: not available (renderer does not support this type or could not parse the source).')
  }
  return lines.join('\n')
}

function commandPrompt(templateName: string, source: string, topic: string): string {
  return `Create a Mermaid ${templateName.toLowerCase()} diagram about: ${topic}

Start from this template and replace every placeholder with concrete, product-specific content:
\`\`\`mermaid
${source.trim()}
\`\`\`

Requirements:
- Keep the diagram to at most 20 nodes and use short, verb-first labels.
- Quote labels that contain punctuation or parentheses, close every subgraph with end, and never put raw < or > inside a label.
- Call the mermaid tool with action=check on your final source and fix every reported error before presenting it.
- Show the final diagram in a \`\`\`mermaid code block and add 2-4 bullets with the key takeaway for a product audience.`
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'mermaid',
    label: 'Mermaid',
    description:
      'Create a product-manager Mermaid starter from a template, or check Mermaid source for syntax errors and render a terminal preview. Use action=template with one of the template ids, or action=check with complete Mermaid source before showing a diagram.',
    promptSnippet: 'Create Mermaid starter templates or validate Mermaid syntax before presenting a diagram',
    promptGuidelines: [
      'Use mermaid with action=check to validate Mermaid source before presenting a diagram to the user.',
      'Use mermaid with action=template to start a product diagram: flowchart, swimlane, sequence, state, journey, gantt, mindmap, timeline, quadrant, requirement, kanban, architecture or pie.'
    ],
    parameters: Type.Object({
      action: Type.String({ enum: ['template', 'check'], description: 'template creates a starter; check validates source' }),
      template: Type.Optional(
        Type.String({
          enum: [...TEMPLATE_IDS],
          description: 'Template id for action=template'
        })
      ),
      title: Type.Optional(Type.String({ description: 'Optional topic or title used in the starter labels' })),
      source: Type.Optional(Type.String({ description: 'Complete Mermaid source for action=check' }))
    }),

    async execute(_toolCallId, params): Promise<{ content: { type: 'text'; text: string }[]; details: MermaidToolDetails }> {
      if (params.action === 'template') {
        const templateId = params.template as TemplateId | undefined
        if (!templateId) throw new Error('`template` is required when action is "template".')
        if (!TEMPLATE_IDS.includes(templateId)) throw new Error(`Unknown template "${templateId}".`)
        const title = params.title?.trim() || undefined
        const source = buildTemplate(templateId, title)
        const details: MermaidToolDetails = {
          action: 'template',
          template: templateId,
          title: title ?? 'Untitled diagram',
          source
        }
        return {
          content: [
            {
              type: 'text',
              text: `${source}\nUsage: replace the placeholder labels with concrete content, then call mermaid action=check on the final source before presenting it.`
            }
          ],
          details
        }
      }

      if (params.action === 'check') {
        const source = params.source
        if (typeof source !== 'string' || source.trim().length === 0) {
          throw new Error('`source` is required when action is "check".')
        }
        const result = validateMermaid(source)
        const preview = await buildPreview(source)
        return {
          content: [{ type: 'text', text: checkReport(result, preview) }],
          details: {
            action: 'check',
            source,
            ok: result.ok,
            diagramType: result.diagramType,
            errors: result.errors,
            warnings: result.warnings,
            preview: preview?.text,
            previewWidth: preview?.width,
            previewRows: preview?.rows,
            previewTruncated: preview?.truncated
          }
        }
      }

      throw new Error(`Unknown action "${String(params.action)}". Use "template" or "check".`)
    }
  })

  pi.registerCommand('mermaid', {
    description: 'Create a Mermaid diagram from a product-manager template',
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify('The /mermaid command needs an interactive UI. Ask the agent to use the mermaid tool instead.', 'warning')
        return
      }

      const labels = TEMPLATES.map((template) => templateLabel(template.id))
      const choice = await ctx.ui.select('Mermaid template', labels)
      if (!choice) return
      const template = TEMPLATES[labels.indexOf(choice)]
      if (!template) return

      const topic = await ctx.ui.input('What should the diagram show?', args.trim() || `e.g. ${template.useWhen}`)
      if (topic === undefined) return
      const title = topic.trim() || template.name
      pi.sendUserMessage(commandPrompt(template.name, buildTemplate(template.id, title), title))
    }
  })

  pi.on('before_agent_start', async (event) => {
    if (event.messageType !== 'user') return
    if (!DIAGRAM_PROMPT_PATTERN.test(event.prompt)) return
    if (event.systemPrompt.includes(POLICY_MARKER)) return
    return { systemPrompt: `${event.systemPrompt}\n\n${MERMAID_POLICY}` }
  })
}
