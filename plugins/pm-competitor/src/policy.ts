/**
 * 竞品情报的系统提示策略。
 *
 * 保持纯 TypeScript，方便 tests/pm-competitor.test.ts 直接测试触发条件，
 * 不必加载 Pi 扩展运行时。
 */

export const COMPETITOR_POLICY_MARKER = 'PI COMPETITOR POLICY'

export const COMPETITOR_POLICY = `[${COMPETITOR_POLICY_MARKER}]
当用户请求竞品、竞争、市场分析、功能对比、定价对比或 battlecard 时：
- 先写清这次分析要支持的具体决策（定位、定价、赢单策略或路线图），以及读者是谁；没有决策的分析只是资料堆砌。
- 先确定竞品集合：直接竞品、间接竞品和替代方案（Excel、自建、外包、维持现状）都要考虑，不要只列最知名的三家。
- 证据分级固定为：公开文档 > 官方定价页 > 客户访谈 > 传闻。每条结论必须附来源和日期；传闻只能作为待验证线索。
- 功能对比用 pm_competitor 的 action=matrix：0–5 分、权重显式填写；加权总分只是讨论工具，必须同时说明它会掩盖哪些判断。
- 作战卡用 pm_competitor 的 action=battlecard：他们赢在哪里、我们为什么赢、地雷、异议处理、证据点、该问的问题、近期变化，七段齐全。
- 定价对比用 pm_competitor 的 action=pricing：统一币种、计价单位和周期，注明是否含税、折扣、实施费和最低消费。
- 禁止使用对方机密文件、窃取的报价单或未公开客户名单；不贬低对手，只陈述可验证事实。
- 最终输出中文 Markdown：先给结论，再给表格，最后写“证据与日期”和“仍不确定的地方”。`

/**
 * 触发词同时覆盖中英文。注意不要用全局（g）标志，避免 lastIndex 造成偶发漏判。
 */
export const COMPETITOR_PROMPT_PATTERN =
  /(competitor|competitive|competition|battlecard|battle card|competitive analysis|pricing comparison|pricing compare|price comparison|竞品|竞对|竞争|市场分析|竞品分析|竞争分析|定价对比|价格对比|功能对比|作战卡|竞争情报)/i

/** 只有当 prompt 命中竞品主题、且 systemPrompt 尚未注入策略时才追加。 */
export function shouldApplyCompetitorPolicy(prompt: string, systemPrompt: string): boolean {
  if (systemPrompt.includes(COMPETITOR_POLICY_MARKER)) return false
  return COMPETITOR_PROMPT_PATTERN.test(prompt)
}
