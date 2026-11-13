/**
 * PM Feedback — parse raw user feedback, run deterministic keyword
 * pre-clustering and build a defensible theme report.
 *
 * The extension is intentionally thin. The pure modules in `src/` own parsing,
 * clustering and formatting; the model still owns theme judgement. The tool
 * description, the prompt policy and the formatters all say explicitly that
 * keyword pre-clustering is not semantic clustering.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  buildFeedbackReport,
  clusterFeedback,
  feedbackStats,
  parseFeedback,
  type FeedbackFormat,
  type FeedbackItem,
  type OutputLanguage,
  type ThemeRule
} from '../src/feedback.ts'
import { formatClusterResult, formatParsedItems } from '../src/format.ts'

const POLICY_MARKER = 'PI FEEDBACK POLICY'

const FEEDBACK_POLICY = `[${POLICY_MARKER}]
When the user asks to analyse user feedback, customer reviews, app-store ratings, support tickets, VOC or interview notes:
- Use pm_feedback to parse the raw export first; do not cluster from memory or from a short excerpt.
- The tool performs deterministic keyword pre-clustering, not semantic clustering. Treat its themes as a first pass: read the representative quotes and every unclustered item, then merge, split, rename or discard themes and remove keyword false positives.
- Keep frequency (how many items), severity (how damaging) and segment (who) separate. A high-frequency minor annoyance is not automatically a higher priority than a rare crash.
- Quote real feedback verbatim and keep source, segment and date. Never invent quotes, counts or percentages, and never claim the sample is statistically representative unless the sampling method proves it.
- End with what to investigate next, what the data cannot answer, and the limits of the sample.`

const FEEDBACK_PROMPT_PATTERN =
  /(user feedback|customer feedback|voice of (?:the )?customer|\bvoc\b|\bnps\b|feedback|reviews?|ratings?|app[- ]store|support tickets?|user interviews?|用户反馈|客户反馈|用户评论|评论|评价|工单|访谈|反馈)/i

function languageOf(value: unknown): OutputLanguage {
  return value === 'en' ? 'en' : 'zh-CN'
}

function detectFormat(value: unknown, input: string): FeedbackFormat {
  if (value === 'csv' || value === 'json' || value === 'lines') return value
  const trimmed = input.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json'
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? ''
  if (firstLine.includes(',') || firstLine.includes('\t')) return 'csv'
  return 'lines'
}

function themesOf(value: unknown): ThemeRule[] | undefined {
  if (!Array.isArray(value)) return undefined
  const themes = value
    .filter((entry): entry is { name?: unknown; keywords?: unknown } => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      name: typeof entry.name === 'string' ? entry.name : '',
      keywords: Array.isArray(entry.keywords) ? entry.keywords.filter((keyword): keyword is string => typeof keyword === 'string') : []
    }))
    .filter((theme) => theme.name.trim() !== '')
  return themes.length > 0 ? themes : undefined
}

function commandPrompt(action: 'parse' | 'cluster' | 'report', pasted: string): string {
  const actionLine =
    action === 'parse'
      ? '请调用 pm_feedback，action=parse，先解析并检查字段覆盖与明显的数据问题，不要急着下结论。'
      : action === 'cluster'
        ? '请调用 pm_feedback，action=cluster，先得到关键词预聚类结果。'
        : '请调用 pm_feedback，action=report，先得到报告草稿。'
  return `${actionLine}

工具只做确定性的关键词预聚类，不是语义聚类。拿到工具结果后你必须：
1. 逐条阅读代表性引用和所有未归类反馈，合并、拆分或重命名主题，删除关键词误报；
2. 把频率、严重程度和用户细分分开陈述，不要用高频代替高优先级；
3. 只引用原文，不编造引语、数量或百分比；
4. 明确说明样本不是统计上具有代表性的，并给出下一步需要调查的问题。

以下是用户反馈原文（格式可能是 CSV、JSON 或每行一条，请自行判断并传给 pm_feedback）：

---
${pasted}`
}

export default function registerPmFeedback(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'pm_feedback',
    label: 'PM Feedback',
    description:
      'Parse raw user feedback (CSV/JSON/lines) and run DETERMINISTIC KEYWORD PRE-CLUSTERING into a bilingual theme taxonomy. This is not semantic clustering: the model must inspect quotes, unclustered items and keyword false positives, refine the themes, and then build the report. Actions: parse, cluster, report.',
    promptSnippet: 'Parse, keyword pre-cluster and report on raw user feedback',
    promptGuidelines: [
      'Use pm_feedback whenever the user supplies app-store reviews, support tickets, survey comments or a feedback export.',
      'Treat pm_feedback themes as a keyword pre-pass, never as final semantic themes; read the quotes and unclustered items and refine them yourself.',
      'Keep frequency, severity and segment separate, quote real feedback verbatim, and state that the sample is not statistically representative.'
    ],
    parameters: Type.Object({
      action: Type.String({ enum: ['parse', 'cluster', 'report'], description: 'parse, cluster or report' }),
      input: Type.String({ description: 'Raw feedback text: CSV, JSON array or one item per line' }),
      format: Type.Optional(
        Type.String({ enum: ['csv', 'json', 'lines'], description: 'Input format; auto-detected when omitted' })
      ),
      themes: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ description: 'Theme name, e.g. 性能 or Onboarding' }),
            keywords: Type.Array(Type.String({ description: 'Keyword or phrase for deterministic matching' }))
          }),
          { description: 'Optional custom theme taxonomy; replaces the default taxonomy when provided' }
        )
      ),
      language: Type.Optional(Type.String({ enum: ['zh-CN', 'en'], description: 'Output language; default zh-CN' }))
    }),
    async execute(
      _toolCallId,
      params
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }> {
      const language = languageOf(params.language)
      const format = detectFormat(params.format, params.input)
      const items: FeedbackItem[] = parseFeedback(params.input, format)
      const themes = themesOf(params.themes)

      if (params.action === 'parse') {
        return {
          content: [{ type: 'text', text: formatParsedItems(items, language) }],
          details: { action: 'parse', format, count: items.length, items }
        }
      }

      const clusters = clusterFeedback(items, { themes })
      if (params.action === 'cluster') {
        return {
          content: [{ type: 'text', text: formatClusterResult(clusters, language) }],
          details: {
            action: 'cluster',
            format,
            total: clusters.total,
            clusteredCount: clusters.clusteredCount,
            unclusteredCount: clusters.unclustered.length,
            clusters: clusters.clusters.map((cluster) => ({
              theme: cluster.theme,
              count: cluster.count,
              share: cluster.share,
              keywords: cluster.keywords,
              catchAll: cluster.catchAll
            }))
          }
        }
      }

      if (params.action === 'report') {
        const report = buildFeedbackReport(items, clusters, { language })
        return {
          content: [{ type: 'text', text: report }],
          details: {
            action: 'report',
            format,
            stats: feedbackStats(items, clusters, language),
            clusters: clusters.clusters.map((cluster) => ({ theme: cluster.theme, count: cluster.count, share: cluster.share }))
          }
        }
      }

      throw new Error(`Unknown action "${String(params.action)}". Use parse, cluster or report.`)
    }
  })

  pi.registerCommand('feedback', {
    description: 'Parse, keyword-cluster or report on pasted user feedback',
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return
      const actions = [
        { label: '解析反馈 / Parse feedback', action: 'parse' as const },
        { label: '关键词聚类 / Keyword pre-cluster', action: 'cluster' as const },
        { label: '生成主题报告 / Build theme report', action: 'report' as const }
      ]
      const choice = await ctx.ui.select('用户反馈 / User feedback', actions.map((entry) => entry.label))
      if (!choice) return
      const selected = actions.find((entry) => entry.label === choice)
      if (!selected) return
      const pasted = await ctx.ui.editor('粘贴用户反馈（CSV / JSON / 每行一条）', args.trim())
      if (pasted === undefined || pasted.trim() === '') return
      pi.sendUserMessage(commandPrompt(selected.action, pasted.trim()))
    }
  })

  pi.on('before_agent_start', async (event) => {
    if (event.messageType !== 'user') return
    if (!FEEDBACK_PROMPT_PATTERN.test(event.prompt)) return
    if (event.systemPrompt.includes(POLICY_MARKER)) return
    return { systemPrompt: `${event.systemPrompt}\n\n${FEEDBACK_POLICY}` }
  })
}
