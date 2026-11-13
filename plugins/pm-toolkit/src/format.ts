/**
 * Markdown formatting for the PM toolkit tools.
 *
 * Keeping this pure makes the tool output predictable and snapshot-friendly.
 */

import type { PriorityResult } from './frameworks'
import { formatScore } from './frameworks'
import type { CheckResult } from './checks'
import type { FunnelResult, ProportionTestResult, SampleSizeResult } from './stats'

export type OutputLanguage = 'zh-CN' | 'en'

function table(headers: string[], rows: string[][]): string {
  const escape = (cell: string): string => cell.replace(/\|/g, '\\|')
  return [
    `| ${headers.map(escape).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escape).join(' | ')} |`)
  ].join('\n')
}

function percent(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(2).replace(/\.?0+$/, '')}%`
}

export function formatPriorityResult(result: PriorityResult, language: OutputLanguage = 'zh-CN'): string {
  const zh = language === 'zh-CN'
  const title =
    result.method === 'rice'
      ? 'RICE 优先级'
      : result.method === 'ice'
        ? 'ICE 优先级'
        : result.method === 'moscow'
          ? 'MoSCoW 分组'
          : '价值 × 成本矩阵'
  const lines: string[] = [`## ${title}`, '']
  if (result.ranked.length === 0) {
    lines.push(zh ? '没有可计算的条目，请检查输入。' : 'No scoreable items. Check the inputs.')
  } else if (result.method === 'moscow') {
    const grouped = new Map<string, string[]>()
    for (const item of result.ranked) {
      const priority = String(item.inputs.priority ?? '')
      if (!grouped.has(priority)) grouped.set(priority, [])
      grouped.get(priority)?.push(item.name)
    }
    for (const priority of ['must', 'should', 'could', 'wont']) {
      const names = grouped.get(priority) ?? []
      if (names.length) lines.push(`- **${priority.toUpperCase()}**：${names.join('、')}`)
    }
  } else if (result.method === 'value_effort') {
    lines.push(
      table(
        zh ? ['排名', '功能', '价值', '成本', '象限', '分数'] : ['Rank', 'Item', 'Value', 'Cost', 'Quadrant', 'Score'],
        result.ranked.map((item, index) => [
          String(index + 1),
          item.name,
          formatScore(Number(item.inputs.value)),
          formatScore(Number(item.inputs.cost)),
          item.quadrant ?? '',
          formatScore(item.score)
        ])
      )
    )
  } else if (result.method === 'rice') {
    lines.push(
      table(
        zh ? ['排名', '功能', 'Reach', 'Impact', 'Confidence', 'Effort', 'RICE'] : ['Rank', 'Item', 'Reach', 'Impact', 'Confidence', 'Effort', 'RICE'],
        result.ranked.map((item, index) => [
          String(index + 1),
          item.name,
          formatScore(Number(item.inputs.reach)),
          formatScore(Number(item.inputs.impact)),
          percent(Number(item.inputs.confidence)),
          formatScore(Number(item.inputs.effort)),
          formatScore(item.score)
        ])
      )
    )
  } else {
    lines.push(
      table(
        zh ? ['排名', '功能', 'Impact', 'Confidence', 'Ease', 'ICE'] : ['Rank', 'Item', 'Impact', 'Confidence', 'Ease', 'ICE'],
        result.ranked.map((item, index) => [
          String(index + 1),
          item.name,
          formatScore(Number(item.inputs.impact)),
          formatScore(Number(item.inputs.confidence)),
          formatScore(Number(item.inputs.ease)),
          formatScore(item.score)
        ])
      )
    )
  }

  if (result.method === 'rice') {
    lines.push('', zh ? '公式：RICE = Reach × Impact × Confidence ÷ Effort。' : 'Formula: RICE = Reach × Impact × Confidence ÷ Effort.')
  } else if (result.method === 'ice') {
    lines.push('', zh ? '公式：ICE = Impact × Confidence × Ease（1–10 分）。' : 'Formula: ICE = Impact × Confidence × Ease (1–10).')
  } else if (result.method === 'value_effort') {
    lines.push('', zh ? '价值 ≥ 5 且成本 < 5 为速赢；价值 ≥ 5 且成本 ≥ 5 为战略下注。' : 'Value ≥ 5 and cost < 5 = quick wins; value ≥ 5 and cost ≥ 5 = strategic bets.')
  }
  if (result.warnings.length) {
    lines.push('', zh ? '注意：' : 'Notes:')
    for (const warning of result.warnings) lines.push(`- ${warning}`)
  }
  return lines.join('\n')
}

export function formatSampleSize(result: SampleSizeResult, language: OutputLanguage = 'zh-CN'): string {
  const zh = language === 'zh-CN'
  return [
    zh ? '## A/B 实验样本量' : '## A/B sample size',
    '',
    zh ? `- 基线转化率：${percent(result.baseline)}` : `- Baseline conversion: ${percent(result.baseline)}`,
    zh ? `- 目标相对提升：${percent(result.variant / result.baseline - 1)}` : `- Relative MDE: ${percent(result.variant / result.baseline - 1)}`,
    zh ? `- 绝对提升：${percent(result.absoluteMde)}` : `- Absolute MDE: ${percent(result.absoluteMde)}`,
    zh ? `- 显著性水平 α：${result.alpha}` : `- Alpha: ${result.alpha}`,
    zh ? `- 统计功效：${percent(result.power)}` : `- Power: ${percent(result.power)}`,
    zh ? `- 每组样本：${result.perArm.toLocaleString()}` : `- Sample per arm: ${result.perArm.toLocaleString()}`,
    zh ? `- 总样本：${result.total.toLocaleString()}` : `- Total sample: ${result.total.toLocaleString()}`,
    '',
    zh
      ? '建议按 50/50 分流；如果实际流量不足，优先延长实验而不是降低样本量。'
      : 'Use a 50/50 split; if traffic is short, extend the experiment rather than reducing the sample.'
  ].join('\n')
}

export function formatSignificance(result: ProportionTestResult, language: OutputLanguage = 'zh-CN'): string {
  const zh = language === 'zh-CN'
  return [
    zh ? '## A/B 实验结果' : '## A/B result',
    '',
    zh ? `- 对照组转化率：${percent(result.controlRate)}` : `- Control rate: ${percent(result.controlRate)}`,
    zh ? `- 实验组转化率：${percent(result.variantRate)}` : `- Variant rate: ${percent(result.variantRate)}`,
    zh ? `- 绝对提升：${percent(result.absoluteLift)}；相对提升：${percent(result.relativeLift)}` : `- Absolute lift: ${percent(result.absoluteLift)}; relative: ${percent(result.relativeLift)}`,
    zh ? `- z 值：${result.z.toFixed(3)}，p 值：${result.pValue.toFixed(4)}` : `- z: ${result.z.toFixed(3)}, p-value: ${result.pValue.toFixed(4)}`,
    zh
      ? `- 95% 置信区间：${percent(result.confidenceInterval[0])} 至 ${percent(result.confidenceInterval[1])}`
      : `- 95% CI: ${percent(result.confidenceInterval[0])} to ${percent(result.confidenceInterval[1])}`,
    zh
      ? `- 结论：在 α=${result.alpha} 下${result.significant ? '达到统计显著' : '未达到统计显著'}。`
      : `- Conclusion: ${result.significant ? 'statistically significant' : 'not statistically significant'} at α=${result.alpha}.`,
    '',
    zh
      ? '注意：统计显著不等于业务显著；请同时检查护栏指标、样本质量和实际收益。'
      : 'Statistical significance is not business significance; check guardrails, sample quality and practical impact.'
  ].join('\n')
}

export function formatFunnel(result: FunnelResult, language: OutputLanguage = 'zh-CN'): string {
  const zh = language === 'zh-CN'
  const rows = result.steps.map((step, index) => [
    String(index + 1),
    step.name,
    step.users.toLocaleString(),
    percent(step.overallConversion),
    index === 0 ? '—' : percent(step.stepConversion),
    index === 0 ? '—' : percent(step.dropRate)
  ])
  return [
    zh ? '## 漏斗转化' : '## Funnel conversion',
    '',
    table(zh ? ['步骤', '名称', '用户数', '整体转化', '步骤转化', '流失率'] : ['Step', 'Name', 'Users', 'Overall', 'Step conversion', 'Drop rate'], rows),
    '',
    zh ? `整体转化率：${percent(result.overallConversion)}` : `Overall conversion: ${percent(result.overallConversion)}`,
    result.biggestDrop
      ? zh
        ? `最大流失：${result.biggestDrop.name}（流失 ${percent(result.biggestDrop.dropRate)}，${result.biggestDrop.dropOff.toLocaleString()} 人）`
        : `Biggest drop: ${result.biggestDrop.name} (${percent(result.biggestDrop.dropRate)}, ${result.biggestDrop.dropOff.toLocaleString()} users)`
      : ''
  ]
    .filter(Boolean)
    .join('\n')
}

export function formatCheckResult(result: CheckResult, language: OutputLanguage = 'zh-CN'): string {
  const zh = language === 'zh-CN'
  if (!result.issues.length) {
    return zh ? '检查通过：没有发现缺失章节或模糊表述。' : 'Check passed: no missing sections or vague wording found.'
  }
  const lines = [zh ? `检查结果：${result.ok ? '有提醒' : '未通过'}` : `Check: ${result.ok ? 'warnings' : 'failed'}`, '']
  for (const issue of result.issues) {
    lines.push(`- **${issue.severity === 'error' ? (zh ? '错误' : 'error') : zh ? '提醒' : 'warning'}**：${issue.message}`)
    if (issue.fix) lines.push(`  - ${zh ? '建议' : 'Fix'}：${issue.fix}`)
  }
  return lines.join('\n')
}
