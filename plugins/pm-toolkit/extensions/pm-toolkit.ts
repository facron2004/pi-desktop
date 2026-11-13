/**
 * PM Toolkit — a product-manager workflow extension for Pi.
 *
 * The tools are intentionally small and deterministic: document skeletons,
 * prioritisation maths, experiment maths and document checks. The model still
 * does the product judgement; the extension makes the mechanical parts
 * consistent and inspectable.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { DOC_TEMPLATES, buildDoc, isDocKind, type DocKind, type DocLanguage } from '../src/templates.ts'
import {
  prioritize,
  type PriorityItem,
  type PriorityMethod
} from '../src/frameworks.ts'
import {
  funnelMetrics,
  sampleSizePerArm,
  twoProportionTest,
  type FunnelStepInput
} from '../src/stats.ts'
import { checkDocument, type CheckKind } from '../src/checks.ts'
import {
  formatCheckResult,
  formatFunnel,
  formatPriorityResult,
  formatSampleSize,
  formatSignificance,
  type OutputLanguage
} from '../src/format.ts'

const POLICY_MARKER = 'PI PM TOOLKIT POLICY'

const PM_POLICY = `[${POLICY_MARKER}]
When the user asks for product-management work:
- Name the decision and the audience first; state assumptions instead of inventing user evidence.
- Use pm_doc for PRD, user-story, launch, status, interview, survey, decision-log, roadmap, competitor and release-note skeletons.
- Use pm_prioritize for RICE / ICE / MoSCoW / value-effort; show the formula and inputs, never only a ranking.
- Use pm_experiment for sample size, significance and funnel maths; state hypothesis, primary metric, guardrails and decision rule.
- Use pm_check before presenting a PRD, user story, launch plan or status update; fix every reported issue.
- PRD quality bar: problem, users, goals/metrics, scope and non-goals, user stories, testable acceptance criteria, risks/dependencies, milestones, open questions.`

const PM_PROMPT_PATTERN =
  /(prd|product requirement|user stor(?:y|ies)|acceptance criteri|rice|ice score|moscow|prioriti[sz]|roadmap|user interview|user research|survey|north star|funnel|a\/b|experiment|launch plan|release note|status update|stakeholder|competitor|需求文档|需求评审|用户故事|验收标准|优先级|路线图|用户访谈|用户研究|访谈|问卷|北极星|漏斗|实验|发布计划|发布说明|周报|干系人|竞品|产品规划|产品策略)/i

const DOC_KIND_VALUES = DOC_TEMPLATES.map((template) => template.kind)
const PRIORITY_VALUES = ['rice', 'ice', 'moscow', 'value_effort'] as const

function languageOf(value: unknown): OutputLanguage {
  return value === 'en' ? 'en' : 'zh-CN'
}

function requireDocKind(value: unknown): DocKind {
  if (typeof value !== 'string' || !isDocKind(value)) throw new Error(`Unknown document kind "${String(value)}".`)
  return value
}

function checkKindOf(value: unknown): CheckKind {
  if (value === 'prd' || value === 'user_story' || value === 'launch_checklist' || value === 'status_update') return value
  throw new Error('kind must be prd, user_story, launch_checklist or status_update.')
}

export default function registerPmToolkit(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'pm_doc',
    label: 'PM Document',
    description:
      'Create a product-manager document skeleton: PRD, user story, acceptance criteria, launch checklist, status update, interview guide, survey, decision log, roadmap, competitor matrix or release notes. The model fills the placeholders with real product context.',
    promptSnippet: 'Create a PM document skeleton (PRD, user story, launch checklist, roadmap, etc.)',
    promptGuidelines: [
      'Use pm_doc to start a product document instead of inventing a format from scratch.',
      'After filling a pm_doc skeleton, use pm_check to verify that required sections and acceptance criteria are present.'
    ],
    parameters: Type.Object({
      kind: Type.String({ enum: [...DOC_KIND_VALUES], description: 'Document template kind' }),
      title: Type.String({ description: 'Product, initiative or document title' }),
      context: Type.Optional(Type.String({ description: 'Optional background; the model should fill the rest from the conversation' })),
      language: Type.Optional(Type.String({ enum: ['zh-CN', 'en'], description: 'Output language; default zh-CN' }))
    }),
    async execute(_toolCallId, params) {
      const kind = requireDocKind(params.kind)
      const language: DocLanguage = params.language === 'en' ? 'en' : 'zh-CN'
      const document = buildDoc(kind, params.title, params.context, language)
      return {
        content: [
          {
            type: 'text',
            text: `${document}\n---\n下一步：用真实用户、场景和数据替换占位内容；如果这是 PRD、用户故事、发布计划或周报，再调用 pm_check 检查缺失章节。`
          }
        ],
        details: { kind, title: params.title, language }
      }
    }
  })

  pi.registerTool({
    name: 'pm_prioritize',
    label: 'Prioritise',
    description:
      'Calculate a transparent product-prioritisation ranking with RICE, ICE, MoSCoW or a value-versus-cost matrix. Returns the sorted table, formula and warnings about missing inputs.',
    promptSnippet: 'Rank product work with RICE, ICE, MoSCoW or a value × cost matrix',
    promptGuidelines: [
      'Use pm_prioritize for prioritisation instead of doing arithmetic in prose.',
      'Show the formula and the inputs so the ranking can be challenged by stakeholders.'
    ],
    parameters: Type.Object({
      method: Type.String({ enum: [...PRIORITY_VALUES], description: 'rice, ice, moscow or value_effort' }),
      items: Type.Array(
        Type.Object({
          name: Type.String({ description: 'Feature/initiative name' }),
          reach: Type.Optional(Type.Number({ description: 'RICE: users reached per period' })),
          impact: Type.Optional(Type.Number({ description: 'RICE impact (0.25–3) or ICE impact (1–10)' })),
          confidence: Type.Optional(Type.Number({ description: 'RICE 0–1 or 0–100; ICE 1–10' })),
          effort: Type.Optional(Type.Number({ description: 'RICE person-effort' })),
          ease: Type.Optional(Type.Number({ description: 'ICE ease 1–10' })),
          priority: Type.Optional(
            Type.String({ enum: ['must', 'should', 'could', 'wont'], description: 'MoSCoW priority' })
          ),
          value: Type.Optional(Type.Number({ description: 'Value/effort: value 1–10' })),
          cost: Type.Optional(Type.Number({ description: 'Value/effort: cost 1–10' }))
        })
      ),
      language: Type.Optional(Type.String({ enum: ['zh-CN', 'en'], description: 'Output language; default zh-CN' }))
    }),
    async execute(_toolCallId, params) {
      const method = params.method as PriorityMethod
      const items = params.items as PriorityItem[]
      return {
        content: [{ type: 'text', text: formatPriorityResult(prioritize(method, items), languageOf(params.language)) }],
        details: { method, count: items.length }
      }
    }
  })

  pi.registerTool({
    name: 'pm_experiment',
    label: 'PM Experiment',
    description:
      'Calculate A/B sample size, two-proportion significance/confidence interval or funnel conversion. Use for experiment design and results interpretation.',
    promptSnippet: 'Calculate experiment sample size, significance or funnel conversion',
    promptGuidelines: [
      'Use pm_experiment for sample sizes and significance; state the hypothesis, primary metric and guardrails first.',
      'A significant result is not automatically a product win: check effect size, guardrails and sample quality.'
    ],
    parameters: Type.Object({
      action: Type.String({ enum: ['sample_size', 'significance', 'funnel'], description: 'Which calculation to run' }),
      baseline: Type.Optional(Type.Number({ description: 'Baseline rate 0–1 for sample_size' })),
      mde: Type.Optional(Type.Number({ description: 'Relative minimum detectable effect, e.g. 0.1 for +10%' })),
      alpha: Type.Optional(Type.Number({ description: 'Significance level, default 0.05' })),
      power: Type.Optional(Type.Number({ description: 'Statistical power, default 0.8' })),
      twoSided: Type.Optional(Type.Boolean({ description: 'Two-sided test, default true' })),
      controlVisitors: Type.Optional(Type.Number({ description: 'Significance: control visitors' })),
      controlConversions: Type.Optional(Type.Number({ description: 'Significance: control conversions' })),
      variantVisitors: Type.Optional(Type.Number({ description: 'Significance: variant visitors' })),
      variantConversions: Type.Optional(Type.Number({ description: 'Significance: variant conversions' })),
      steps: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ description: 'Funnel step name' }),
            users: Type.Number({ description: 'Users reaching this step' })
          })
        )
      ),
      language: Type.Optional(Type.String({ enum: ['zh-CN', 'en'], description: 'Output language; default zh-CN' }))
    }),
    async execute(
      _toolCallId,
      params
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }> {
      const language = languageOf(params.language)
      if (params.action === 'sample_size') {
        if (params.baseline === undefined || params.mde === undefined) {
          throw new Error('sample_size needs baseline and mde.')
        }
        return {
          content: [
            {
              type: 'text',
              text: formatSampleSize(
                sampleSizePerArm({
                  baseline: params.baseline,
                  relativeMde: params.mde,
                  alpha: params.alpha,
                  power: params.power,
                  twoSided: params.twoSided
                }),
                language
              )
            }
          ],
          details: { action: params.action }
        }
      }
      if (params.action === 'significance') {
        if (
          params.controlVisitors === undefined ||
          params.controlConversions === undefined ||
          params.variantVisitors === undefined ||
          params.variantConversions === undefined
        ) {
          throw new Error('significance needs controlVisitors, controlConversions, variantVisitors and variantConversions.')
        }
        return {
          content: [
            {
              type: 'text',
              text: formatSignificance(
                twoProportionTest({
                  controlVisitors: params.controlVisitors,
                  controlConversions: params.controlConversions,
                  variantVisitors: params.variantVisitors,
                  variantConversions: params.variantConversions,
                  alpha: params.alpha,
                  twoSided: params.twoSided
                }),
                language
              )
            }
          ],
          details: { action: params.action }
        }
      }
      if (!params.steps?.length) throw new Error('funnel needs at least one step.')
      return {
        content: [{ type: 'text', text: formatFunnel(funnelMetrics(params.steps as FunnelStepInput[]), language) }],
        details: { action: 'funnel', steps: params.steps.length }
      }
    }
  })

  pi.registerTool({
    name: 'pm_check',
    label: 'PM Document Check',
    description:
      'Check a PRD, user story, launch checklist or status update for missing required sections, vague wording and missing testable acceptance criteria.',
    promptSnippet: 'Check a PM document for missing sections and vague criteria',
    promptGuidelines: [
      'Run pm_check before presenting any PRD, user story, launch checklist or stakeholder update.'
    ],
    parameters: Type.Object({
      kind: Type.String({ enum: ['prd', 'user_story', 'launch_checklist', 'status_update'], description: 'Document kind' }),
      content: Type.String({ description: 'Document content to check' }),
      language: Type.Optional(Type.String({ enum: ['zh-CN', 'en'], description: 'Output language; default zh-CN' }))
    }),
    async execute(_toolCallId, params) {
      const result = checkDocument(checkKindOf(params.kind), params.content)
      return {
        content: [{ type: 'text', text: formatCheckResult(result, languageOf(params.language)) }],
        details: result
      }
    }
  })

  pi.registerCommand('pm', {
    description: 'Start a product-manager document or analysis from the PM toolkit',
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify('The /pm command needs an interactive UI. Ask the agent to use the pm_doc, pm_prioritize, pm_experiment or pm_check tools instead.', 'warning')
        return
      }
      const actions = [
        ...DOC_TEMPLATES.map((template) => ({ label: `${template.title} — ${template.description}`, kind: template.kind })),
        { label: 'RICE / ICE 优先级 — 打分并排序', kind: 'priority' as const },
        { label: 'A/B 实验设计 — 样本量与显著性', kind: 'experiment' as const },
        { label: '指标 / 漏斗分析 — 定义与转化', kind: 'metrics' as const }
      ]
      const choice = await ctx.ui.select('PM Toolkit', actions.map((action) => action.label))
      if (!choice) return
      const action = actions.find((candidate) => candidate.label === choice)
      if (!action) return
      const topic = await ctx.ui.input('主题 / 背景', args.trim() || '例如：退款审批体验优化')
      if (topic === undefined) return
      const subject = topic.trim() || '新产品需求'
      if (action.kind === 'priority') {
        pi.sendUserMessage(`请用 pm_prioritize 工具对以下产品事项做 RICE 或 ICE 优先级排序，并说明每个输入值的依据：\n${subject}`)
        return
      }
      if (action.kind === 'experiment') {
        pi.sendUserMessage(`请用 pm_experiment 工具设计一个 A/B 实验，说明假设、主指标、护栏指标、样本量和判定规则：\n${subject}`)
        return
      }
      if (action.kind === 'metrics') {
        pi.sendUserMessage(`请为以下产品/功能设计指标体系和漏斗，说明主指标、护栏指标、事件和计算口径：\n${subject}`)
        return
      }
      const document = buildDoc(action.kind, subject, undefined, 'zh-CN')
      pi.sendUserMessage(
        `请把下面这份 PM 文档骨架补成一份基于真实产品语境的文档，不要保留占位符。主题：${subject}\n\n${document}`
      )
    }
  })

  pi.on('before_agent_start', async (event) => {
    if (event.messageType !== 'user') return
    if (!PM_PROMPT_PATTERN.test(event.prompt)) return
    if (event.systemPrompt.includes(POLICY_MARKER)) return
    return { systemPrompt: `${event.systemPrompt}\n\n${PM_POLICY}` }
  })
}
