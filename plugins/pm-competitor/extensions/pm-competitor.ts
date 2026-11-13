/**
 * 竞品情报扩展 —— 面向产品经理的竞争对手分析工具箱。
 *
 * 工具只做确定性的整理与计算：加权功能矩阵、七段式作战卡、定价对比。
 * 判断、访谈和证据收集仍然由产品经理完成；扩展负责让格式、口径和
 * 警告保持一致，避免“拍脑袋的加权总分”冒充事实。
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  buildBattlecard,
  buildMatrix,
  buildPricingComparison,
  type Competitor,
  type FeatureRow,
  type PricingTier,
  type ProductProfile
} from '../src/matrix.ts'
import { COMPETITOR_POLICY, shouldApplyCompetitorPolicy } from '../src/policy.ts'

const competitorSchema = Type.Object({
  name: Type.String({ description: '竞品名称，也是 scores 的键' }),
  segment: Type.Optional(Type.String({ description: '目标细分市场' })),
  positioning: Type.Optional(Type.String({ description: '对外定位或一句话卖点' })),
  pricing: Type.Optional(Type.String({ description: '公开定价摘要' })),
  strengths: Type.Optional(Type.Array(Type.String(), { description: '客观优势' })),
  weaknesses: Type.Optional(Type.Array(Type.String(), { description: '客观弱点' })),
  recentChanges: Type.Optional(Type.Array(Type.String(), { description: '近 90 天变化，建议带日期' })),
  lastVerified: Type.Optional(Type.String({ description: '资料复核日期，YYYY-MM-DD' })),
  source: Type.Optional(Type.String({ description: '主要来源' }))
})

const featureSchema = Type.Object({
  name: Type.String({ description: '功能名称' }),
  weight: Type.Optional(Type.Number({ description: '权重（正数），默认 1' })),
  scores: Type.Record(Type.String(), Type.Number(), { description: '竞品名 → 0–5 分' }),
  evidence: Type.Optional(Type.String({ description: '该行评分的证据摘要' })),
  evidenceDate: Type.Optional(Type.String({ description: '证据日期，YYYY-MM-DD' }))
})

const ourProductSchema = Type.Object({
  name: Type.String({ description: '我方产品名称' }),
  segment: Type.Optional(Type.String({ description: '我方目标细分' })),
  positioning: Type.Optional(Type.String({ description: '我方定位' })),
  strengths: Type.Optional(Type.Array(Type.String(), { description: '我方优势' })),
  weaknesses: Type.Optional(Type.Array(Type.String(), { description: '我方短板' })),
  proofPoints: Type.Optional(Type.Array(Type.String(), { description: '可公开引用的证据点' }))
})

const pricingTierSchema = Type.Object({
  name: Type.String({ description: '方案名称' }),
  vendor: Type.String({ description: '厂商名称' }),
  price: Type.Number({ description: '报价数值' }),
  unit: Type.String({ description: '计价单位，例如 ¥/席位/月' }),
  included: Type.Array(Type.String(), { description: '该档位包含内容' }),
  currency: Type.Optional(Type.String({ description: '币种，例如 CNY、USD' })),
  notes: Type.Optional(Type.String({ description: '是否含税、最低消费等备注' }))
})

function requireArray<T>(value: T[] | undefined, message: string): T[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(message)
  return value
}

export default function registerPmCompetitor(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'pm_competitor',
    label: '竞品情报',
    description:
      '竞品情报工具：action=matrix 生成加权功能矩阵（0–100 归一化总分、功能差距、Markdown 表）；action=battlecard 生成七段式竞品作战卡；action=pricing 生成统一周期的定价对比表。输出中文 Markdown，附带证据/日期提醒与“加权分会掩盖判断”的警告。',
    promptSnippet: 'Build a competitor feature matrix, battlecard or pricing comparison',
    promptGuidelines: [
      '当用户要求竞品分析、功能对比、battlecard 或定价对比时，使用 pm_competitor，不要手工拼一张不可复核的表。',
      '调用 pm_competitor 前先确认竞品集合（含直接竞品、间接竞品与替代方案）、决策问题和证据来源。',
      'pm_competitor 的输出是讨论底稿：把权重理由、证据日期和仍不确定的地方一起交给用户。'
    ],
    parameters: Type.Object({
      action: Type.String({ enum: ['matrix', 'battlecard', 'pricing'], description: '要生成的产出类型' }),
      competitors: Type.Optional(Type.Array(competitorSchema, { description: 'action=matrix：竞品清单' })),
      features: Type.Optional(Type.Array(featureSchema, { description: 'action=matrix：功能与 0–5 评分' })),
      competitor: Type.Optional(competitorSchema),
      ourProduct: Type.Optional(ourProductSchema),
      tiers: Type.Optional(Type.Array(pricingTierSchema, { description: 'action=pricing：报价档位' }))
    }),
    async execute(_toolCallId, params): Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }> {
      if (params.action === 'matrix') {
        const competitors = requireArray(params.competitors as Competitor[] | undefined, 'action=matrix 需要 competitors（至少一个竞品）。')
        const features = requireArray(params.features as FeatureRow[] | undefined, 'action=matrix 需要 features（至少一个功能行）。')
        const result = buildMatrix(competitors, features)
        return {
          content: [{ type: 'text', text: result.markdown }],
          details: {
            action: 'matrix',
            competitorCount: result.competitors.length,
            featureCount: features.length,
            gapCount: result.gaps.length,
            warnings: result.warnings
          }
        }
      }

      if (params.action === 'battlecard') {
        if (!params.competitor) throw new Error('action=battlecard 需要 competitor。')
        if (!params.ourProduct) throw new Error('action=battlecard 需要 ourProduct。')
        const result = buildBattlecard(params.competitor as Competitor, params.ourProduct as ProductProfile)
        return {
          content: [{ type: 'text', text: result.markdown }],
          details: {
            action: 'battlecard',
            competitor: result.competitor,
            ourProduct: result.ourProduct,
            sections: result.sections.map((section) => section.key),
            warnings: result.warnings
          }
        }
      }

      if (params.action === 'pricing') {
        const tiers = requireArray(params.tiers as PricingTier[] | undefined, 'action=pricing 需要 tiers（至少一个报价档位）。')
        const result = buildPricingComparison(tiers)
        return {
          content: [{ type: 'text', text: result.markdown }],
          details: {
            action: 'pricing',
            tierCount: result.tiers.length,
            warnings: result.warnings
          }
        }
      }

      throw new Error(`未知 action "${String(params.action)}"。请使用 matrix、battlecard 或 pricing。`)
    }
  })

  pi.registerCommand('competitor', {
    description: '竞品情报：功能矩阵、作战卡、定价对比与来源台账',
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(
          'The /competitor command needs an interactive UI. Ask the agent to use the pm_competitor tool instead.',
          'warning'
        )
        return
      }

      const actions = [
        { label: '功能矩阵 — 加权评分、功能差距与 Markdown 表', value: 'matrix' },
        { label: '竞品作战卡 — 他们赢在哪里、我们为什么赢、异议与证据', value: 'battlecard' },
        { label: '定价对比 — 统一币种、计价单位与周期', value: 'pricing' },
        { label: '来源台账 — 证据分级、日期与可信度复核', value: 'source_log' }
      ] as const

      const choice = await ctx.ui.select(
        '竞品情报 / Competitor intelligence',
        actions.map((action) => action.label)
      )
      if (!choice) return
      const action = actions.find((candidate) => candidate.label === choice)
      if (!action) return

      const topic = await ctx.ui.input(
        '主题或竞品范围',
        args.trim() || '例如：AI 客服 SaaS，中小企业，2026 年 Q2 续费率下滑'
      )
      if (topic === undefined) return
      const subject = topic.trim() || '待分析主题'

      if (action.value === 'matrix') {
        pi.sendUserMessage(
          `请用 pm_competitor 工具 action=matrix 生成竞品功能矩阵。主题：${subject}\n\n` +
            '要求：先列出直接竞品、间接竞品和替代方案；选 6–12 个对购买决策重要的功能；为每个功能显式填写 1–5 权重，并按 0–5 分给每个竞品打分。每个评分尽量附证据来源和日期（FeatureRow.evidence / evidenceDate）。缺失的真实数据标 [待补充] 并向我确认，不要编造。输出后解释加权总分可能掩盖了哪些判断，以及最值得验证的 3 个假设。'
        )
        return
      }
      if (action.value === 'battlecard') {
        pi.sendUserMessage(
          `请用 pm_competitor 工具 action=battlecard 生成竞品作战卡。主题：${subject}\n\n` +
            '要求：先确认对手名称和我方产品名称；作战卡必须覆盖他们赢在哪里、我们为什么赢、地雷、异议处理、证据点、该问的问题、近期变化七段。资料不足的地方保留 [待补充]，并列出获取证据的最小行动（问谁、查哪个公开页面、截止日期）。'
        )
        return
      }
      if (action.value === 'pricing') {
        pi.sendUserMessage(
          `请用 pm_competitor 工具 action=pricing 生成定价对比表。主题：${subject}\n\n` +
            '要求：按厂商列出在售档位的名称、价格、计价单位、包含内容和备注；统一币种与周期，注明是否含税、折扣、实施费和最低消费。无法确认的报价标 [待补充]，并给出复核来源（官方定价页链接 + 日期）。'
        )
        return
      }

      pi.sendUserMessage(
        `请为以下主题建立竞品来源台账：${subject}\n\n` +
          '要求：用中文 Markdown 表格，列包括日期（YYYY-MM-DD）、主题、来源、链接、证据级别（公开文档 / 官方定价页 / 客户访谈 / 传闻）、可信度、备注。按日期倒序；传闻只能标为待验证线索。最后列出证据缺口和下一步核实计划。'
      )
    }
  })

  pi.on('before_agent_start', async (event) => {
    if (event.messageType !== 'user') return
    if (!shouldApplyCompetitorPolicy(event.prompt, event.systemPrompt)) return
    return { systemPrompt: `${event.systemPrompt}\n\n${COMPETITOR_POLICY}` }
  })
}
