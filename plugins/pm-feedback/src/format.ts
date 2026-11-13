/**
 * Markdown formatting for the pm_feedback tool output.
 *
 * Pure formatting only: the tool result stays deterministic and easy to paste
 * into a report. The model-facing reminders about pre-clustering vs semantic
 * clustering live here as well so every action repeats the caveat.
 */

import type { FeedbackClusterResult, FeedbackItem, OutputLanguage } from './feedback'

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n+/g, ' ')
}

function truncate(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, ' ').trim()
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}…`
}

function percent(share: number): string {
  const value = Math.round(share * 1000) / 10
  return `${Number.isInteger(value) ? value.toFixed(0) : value}%`
}

export function formatParsedItems(items: FeedbackItem[], language: OutputLanguage = 'zh-CN'): string {
  const zh = language === 'zh-CN'
  const lines: string[] = [zh ? '## 反馈解析结果' : '## Parsed feedback', '']
  if (items.length === 0) {
    lines.push(zh ? '没有解析到反馈。请检查输入格式和分隔符。' : 'No feedback was parsed. Check the input format and delimiters.')
    return lines.join('\n')
  }

  const withField = (field: 'source' | 'segment' | 'severity' | 'date'): number => items.filter((item) => item[field]?.trim()).length
  lines.push(zh ? `- 共 ${items.length} 条反馈。` : `- ${items.length} feedback items.`)
  lines.push(
    zh
      ? `- 字段覆盖：来源 ${withField('source')} 条，细分 ${withField('segment')} 条，严重程度 ${withField('severity')} 条，日期 ${withField('date')} 条。`
      : `- Field coverage: source ${withField('source')}, segment ${withField('segment')}, severity ${withField('severity')}, date ${withField('date')}.`
  )
  lines.push('')

  const preview = items.slice(0, 15)
  lines.push(
    zh ? '| # | 反馈内容 | 来源 | 细分 | 严重度 | 日期 |' : '| # | Feedback | Source | Segment | Severity | Date |',
    '| --- | --- | --- | --- | --- | --- |'
  )
  preview.forEach((item, index) => {
    lines.push(
      `| ${index + 1} | ${escapeCell(truncate(item.text, 90))} | ${escapeCell(item.source ?? '')} | ${escapeCell(item.segment ?? '')} | ${escapeCell(item.severity ?? '')} | ${escapeCell(item.date ?? '')} |`
    )
  })
  if (items.length > preview.length) {
    lines.push('', zh ? `仅展示前 ${preview.length} 条，另有 ${items.length - preview.length} 条未展示。` : `Showing the first ${preview.length}; ${items.length - preview.length} more not shown.`)
  }
  lines.push('', zh ? '下一步：把解析结果交给 cluster 动作做关键词预聚类，再由模型复核主题。' : 'Next: pass the parsed items to the cluster action, then have the model review the themes.')
  return lines.join('\n')
}

export function formatClusterResult(result: FeedbackClusterResult, language: OutputLanguage = 'zh-CN'): string {
  const zh = language === 'zh-CN'
  const lines: string[] = [zh ? '## 关键词预聚类（非语义）' : '## Keyword pre-clustering (not semantic)', '']
  lines.push(
    zh
      ? `- 共 ${result.total} 条反馈：${result.clusteredCount} 条命中关键词主题，${result.unclustered.length} 条未归类。`
      : `- ${result.total} items: ${result.clusteredCount} matched a keyword theme, ${result.unclustered.length} unclustered.`
  )
  lines.push('')

  if (result.clusters.length === 0) {
    lines.push(zh ? '没有识别出主题。' : 'No themes identified.')
  } else {
    lines.push(zh ? '| 排名 | 主题 | 条数 | 占比 | 关键词 |' : '| Rank | Theme | Items | Share | Keywords |', '| --- | --- | --- | --- | --- |')
    result.clusters.forEach((cluster, index) => {
      lines.push(
        `| ${index + 1} | ${escapeCell(cluster.theme)}${cluster.catchAll ? (zh ? '（未归类）' : ' (catch-all)') : ''} | ${cluster.count} | ${percent(cluster.share)} | ${escapeCell(cluster.keywords.slice(0, 6).join(zh ? '、' : ', ') || '—')} |`
      )
    })
  }
  lines.push('')

  const quoted = result.clusters.filter((cluster) => !cluster.catchAll && cluster.quotes.length > 0).slice(0, 3)
  if (quoted.length > 0) {
    lines.push(zh ? '### 代表引用' : '### Representative quotes', '')
    for (const cluster of quoted) {
      lines.push(`**${cluster.theme}** — ${cluster.count} ${zh ? '条' : 'items'}`)
      for (const quote of cluster.quotes.slice(0, 2)) lines.push(`> ${truncate(quote, 180)}`)
      lines.push('')
    }
  }

  if (result.unclustered.length > 0) {
    lines.push(zh ? '### 未归类反馈' : '### Unclustered feedback', '')
    for (const item of result.unclustered.slice(0, 8)) lines.push(`- ${truncate(item.text, 160)}`)
    if (result.unclustered.length > 8) {
      lines.push(zh ? `- 另有 ${result.unclustered.length - 8} 条未展示。` : `- ${result.unclustered.length - 8} more not shown.`)
    }
    lines.push('')
  }

  lines.push(
    zh
      ? '> 注意：以上只是确定性的关键词预聚类，不是语义聚类。请模型逐条阅读引用和未归类反馈，合并、拆分或重命名主题，并删除关键词误报后才能用于决策或报告。'
      : '> Note: this is deterministic keyword pre-clustering, not semantic clustering. The model must read the quotes and unclustered items, merge/split/rename themes and remove keyword false positives before using them in a decision or report.'
  )
  return lines.join('\n')
}
