/**
 * PM Pricing — pricing and packaging analysis for Pi.
 *
 * The tools are deliberately deterministic: Van Westendorp maths, tier
 * matrices, value-metric scoring and a report skeleton. The model and the PM
 * still own the judgement — especially the call that a survey sample is good
 * enough to act on.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  buildPricingReport,
  formatTierMatrix,
  formatValueMetrics,
  formatVanWestendorp,
  tierMatrix,
  valueMetricCandidates,
  vanWestendorp,
  type OutputLanguage,
  type TierInput,
  type ValueMetricCandidate,
  type VanWestendorpResponse
} from '../src/pricing.ts'

const POLICY_MARKER = 'PI PRICING POLICY'

const PRICING_POLICY = `[${POLICY_MARKER}]
When the user asks about pricing, packaging or monetisation:
- Name the decision first: which segment, which offer, which billing unit, and what willingness-to-pay evidence actually exists. Never invent WTP data or present a guess as a survey result.
- Use pm_pricing with action=van_westendorp only on real, representative responses. State the sample size, response quality and exclusions. Van Westendorp is directional: report OPP/IPP/PMC/PME as a band to investigate, never as a precise optimal price or a demand forecast.
- Use pm_pricing with action=tier_matrix to make packaging explicit. Separate table-stakes features (present in every tier) from genuine differentiators, and give every higher tier a clear reason to upgrade. Avoid a tier that exists only as a decoy.
- Use pm_pricing with action=value_metric to compare candidate value metrics on alignment, scalability, predictability, fairness and measurability. Prefer a metric that grows with customer value and is easy to explain, measure and forecast.
- Before recommending a price change, cover migration: grandfathering, contract and notice requirements, downgrade path, proration/tax, communication and a rollback trigger.
- Price testing must be ethical and legal: no personalised price discrimination without consent and legal review, no fake urgency, no dark patterns, no exploiting vulnerable customers.
- Always state currency, tax treatment and billing period. Separate willingness to pay from ability to pay.`

const PRICING_PROMPT_PATTERN =
  /(pricing|price|packaging|willingness[ -]to[ -]pay|value metric|moneti[sz]|tiered|tiers?|subscription|billing|grandfather|discount|定价|价格|套餐|包装|付费意愿|付费|价值指标|计费|订阅|涨价|降价|折扣|毛利|商业化)/i

function languageOf(value: unknown): OutputLanguage {
  return value === 'en' ? 'en' : 'zh-CN'
}

function currencyOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export default function registerPmPricing(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'pm_pricing',
    label: 'PM Pricing',
    description:
      'Analyse pricing and packaging: Van Westendorp price sensitivity (four-question survey), a feature-by-tier packaging matrix, value-metric scoring, or a complete pricing and migration report.',
    promptSnippet: 'Analyse price sensitivity, packaging tiers, value metrics or a pricing migration report',
    promptGuidelines: [
      'Use pm_pricing for pricing and packaging analysis instead of inventing numbers in prose.',
      'Report the Van Westendorp sample size and caveats with the result; treat the crossings as directional, not an optimal price.',
      'When recommending a price change, include migration, grandfathering and rollback questions.'
    ],
    parameters: Type.Object({
      action: Type.String({
        enum: ['van_westendorp', 'tier_matrix', 'value_metric', 'report'],
        description: 'Which pricing analysis to run'
      }),
      responses: Type.Optional(
        Type.Array(
          Type.Object({
            tooCheap: Type.Number({ description: 'Price the respondent would call too cheap (quality concern)' }),
            cheap: Type.Number({ description: 'Price the respondent would call a bargain' }),
            expensive: Type.Number({ description: 'Price that starts to feel expensive but is still acceptable' }),
            tooExpensive: Type.Number({ description: 'Price that is too expensive to consider' })
          }),
          { description: 'Van Westendorp survey responses (one object per respondent)' }
        )
      ),
      tiers: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ description: 'Tier name, e.g. Starter / Pro / Enterprise' }),
            price: Type.Number({ description: 'List price per billing period' }),
            billing: Type.String({ description: 'Billing period, e.g. "per month" or "per year"' }),
            features: Type.Array(Type.String(), { description: 'Features included in this tier' }),
            limits: Type.Optional(
              Type.Record(Type.String(), Type.String(), { description: 'Quota or limit labels, e.g. { seats: "5" }' })
            )
          })
        )
      ),
      metrics: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ description: 'Candidate value metric, e.g. "Active users" or "API calls"' }),
            alignment: Type.Number({ description: '1–5 (or 0–10): tracks customer value' }),
            scalability: Type.Number({ description: '1–5 (or 0–10): grows with value without renegotiation' }),
            predictability: Type.Number({ description: '1–5 (or 0–10): stable and forecastable' }),
            fairness: Type.Number({ description: '1–5 (or 0–10): understandable and fair to customers' }),
            measurability: Type.Number({ description: '1–5 (or 0–10): easy to measure and explain' }),
            unit: Type.Optional(Type.String({ description: 'Billing unit wording' })),
            notes: Type.Optional(Type.String({ description: 'Evidence or implementation notes' }))
          })
        )
      ),
      product: Type.Optional(Type.String({ description: 'Product or offer name, used in the report title' })),
      segment: Type.Optional(Type.String({ description: 'Target segment, used in the report' })),
      context: Type.Optional(Type.String({ description: 'Decision context, constraints or current pricing' })),
      currency: Type.Optional(Type.String({ description: 'Currency symbol or code, e.g. ¥ or CNY' })),
      language: Type.Optional(Type.String({ enum: ['zh-CN', 'en'], description: 'Output language; default zh-CN' }))
    }),
    async execute(
      _toolCallId,
      params
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }> {
      const language = languageOf(params.language)
      const currency = currencyOf(params.currency)
      const action = params.action

      if (action === 'van_westendorp') {
        if (!params.responses || params.responses.length === 0) {
          throw new Error('van_westendorp needs at least one response with tooCheap, cheap, expensive and tooExpensive.')
        }
        const result = vanWestendorp(params.responses as VanWestendorpResponse[], { currency })
        return {
          content: [{ type: 'text', text: formatVanWestendorp(result, language) }],
          details: {
            action,
            sampleCount: result.sampleCount,
            usableCount: result.usableCount,
            excludedCount: result.excludedCount,
            warnings: result.warnings
          }
        }
      }

      if (action === 'tier_matrix') {
        if (!params.tiers || params.tiers.length === 0) {
          throw new Error('tier_matrix needs at least one tier with name, price, billing and features.')
        }
        const result = tierMatrix(params.tiers as TierInput[])
        return {
          content: [{ type: 'text', text: formatTierMatrix(result, language, currency) }],
          details: { action, tierCount: result.tiers.length, featureCount: result.features.length, warnings: result.warnings }
        }
      }

      if (action === 'value_metric') {
        if (!params.metrics || params.metrics.length === 0) {
          throw new Error('value_metric needs at least one candidate with five criterion scores.')
        }
        const result = valueMetricCandidates(params.metrics as ValueMetricCandidate[])
        return {
          content: [{ type: 'text', text: formatValueMetrics(result, language) }],
          details: { action, recommended: result.recommended, warnings: result.warnings }
        }
      }

      const vanWestendorpResult =
        params.responses && params.responses.length > 0
          ? vanWestendorp(params.responses as VanWestendorpResponse[], { currency })
          : undefined
      const tierMatrixResult = params.tiers && params.tiers.length > 0 ? tierMatrix(params.tiers as TierInput[]) : undefined
      const valueMetricResult =
        params.metrics && params.metrics.length > 0 ? valueMetricCandidates(params.metrics as ValueMetricCandidate[]) : undefined
      const report = buildPricingReport({
        product: params.product,
        segment: params.segment,
        context: params.context,
        currency,
        vanWestendorp: vanWestendorpResult,
        tierMatrix: tierMatrixResult,
        valueMetrics: valueMetricResult,
        language
      })
      return {
        content: [{ type: 'text', text: report }],
        details: {
          action: 'report',
          hasVanWestendorp: Boolean(vanWestendorpResult),
          hasTierMatrix: Boolean(tierMatrixResult),
          hasValueMetrics: Boolean(valueMetricResult)
        }
      }
    }
  })

  pi.registerCommand('pricing', {
    description: 'Pricing and packaging: price sensitivity, tiers, value metric or a full report',
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return
      const actions = [
        {
          label: 'Van Westendorp 价格敏感度 — 四问调研设计与分析',
          kind: 'van_westendorp' as const
        },
        {
          label: '套餐矩阵 — 功能分层、共有功能与差异化卖点',
          kind: 'tier_matrix' as const
        },
        {
          label: '价值指标 — 候选计费单位打分与选择',
          kind: 'value_metric' as const
        },
        {
          label: '完整定价报告 — 汇总以上内容并列出迁移问题',
          kind: 'report' as const
        },
        {
          label: '涨价 / 迁移方案 — grandfathering 与回滚计划',
          kind: 'migration' as const
        }
      ]
      const choice = await ctx.ui.select('PM Pricing', actions.map((action) => action.label))
      if (!choice) return
      const action = actions.find((candidate) => candidate.label === choice)
      if (!action) return
      const topic = await ctx.ui.input('产品 / 背景', args.trim() || '例如：团队版协作工具的年费定价')
      if (topic === undefined) return
      const subject = topic.trim() || '新的定价方案'

      if (action.kind === 'van_westendorp') {
        pi.sendUserMessage(
          `请用 pm_pricing 的 van_westendorp 动作分析下面的定价调研。如果还没有数据，先设计四问问卷（太便宜 / 划算 / 偏贵但可接受 / 太贵）并说明样本量、抽样方式和偏差风险；有数据时报告样本量、剔除项、各问题中位数、可接受价格区间和 OPP/IPP，并明确说明 Van Westendorp 只是方向性参考。\n${subject}`
        )
        return
      }
      if (action.kind === 'tier_matrix') {
        pi.sendUserMessage(
          `请用 pm_pricing 的 tier_matrix 动作梳理下面的套餐。逐项列出各档功能、价格和限额，区分每个档都有的 table stakes 与真正的差异化功能，并指出哪些档位缺少升级理由。\n${subject}`
        )
        return
      }
      if (action.kind === 'value_metric') {
        pi.sendUserMessage(
          `请用 pm_pricing 的 value_metric 动作评估下面的候选价值指标（例如按席位、按用量、按活跃用户、按成交额）。按价值对齐、可扩展性、可预测性、公平性和可测量性打分并给出推荐，同时说明客户能否理解并控制账单。\n${subject}`
        )
        return
      }
      if (action.kind === 'migration') {
        pi.sendUserMessage(
          `请为下面的涨价或包装调整设计迁移方案。用 pm_pricing 的 report 动作组织内容，重点回答：哪些老客户受影响、是否 grandfathering、通知期与合同约束、降级路径、按比例计费/退款/税费、沟通节奏，以及触发回滚的指标。\n${subject}`
        )
        return
      }
      pi.sendUserMessage(
        `请用 pm_pricing 的 report 动作生成一份完整定价与包装报告，包含 Van Westendorp 价格敏感度、套餐矩阵、价值指标建议、迁移与回滚问题、上线前检查清单。没有数据的部分要明确写成证据缺口，不要编造。\n${subject}`
      )
    }
  })

  pi.on('before_agent_start', async (event) => {
    if (event.messageType !== 'user') return
    if (!PRICING_PROMPT_PATTERN.test(event.prompt)) return
    if (event.systemPrompt.includes(POLICY_MARKER)) return
    return { systemPrompt: `${event.systemPrompt}\n\n${PRICING_POLICY}` }
  })
}
