import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_THEMES,
  buildFeedbackReport,
  clusterFeedback,
  feedbackStats,
  normalizeSeverity,
  parseFeedback,
  type FeedbackItem,
  type ThemeRule
} from '../plugins/pm-feedback/src/feedback'
import { formatClusterResult, formatParsedItems } from '../plugins/pm-feedback/src/format'

test('CSV parser handles quoted commas, escaped quotes and newlines inside fields', () => {
  const csv = [
    'id,text,source,segment,severity,date',
    '1,"App crashes when I export, every time",App Store,Enterprise,high,2026-01-02',
    '2,"加载太慢，',
    '等了半分钟",客服,个人,中,2026-01-03',
    '3,"""Great"" but expensive",App Store,个人,low,2026-01-04'
  ].join('\n')

  const items = parseFeedback(csv, 'csv')
  assert.equal(items.length, 3)
  assert.equal(items[0].text, 'App crashes when I export, every time')
  assert.equal(items[0].source, 'App Store')
  assert.equal(items[0].severity, 'high')
  assert.ok(items[1].text.includes('加载太慢'))
  assert.ok(items[1].text.includes('等了半分钟'))
  assert.equal(items[1].segment, '个人')
  assert.equal(items[2].text, '"Great" but expensive')
})

test('CSV without a recognized header falls back to the first column as text', () => {
  const csv = ['"登录不上，验证码收不到",客服', '"希望增加批量导出",App Store'].join('\n')
  const items = parseFeedback(csv, 'csv')
  assert.equal(items.length, 2)
  assert.equal(items[0].text, '登录不上，验证码收不到')
  assert.equal(items[1].text, '希望增加批量导出')
  assert.equal(items[0].id, 'fb-1')
  assert.equal(items[1].id, 'fb-2')
})

test('JSON parser accepts arrays, wrapper objects and Chinese field aliases', () => {
  const json = JSON.stringify({
    items: [
      { 内容: '导出报表很慢，数据也不准', 来源: 'App Store', 用户群: '企业客户', 严重程度: '高', 日期: '2026-02-01' },
      { text: 'The API is confusing', source: 'Support', severity: 'medium' }
    ]
  })
  const items = parseFeedback(json, 'json')
  assert.equal(items.length, 2)
  assert.equal(items[0].text, '导出报表很慢，数据也不准')
  assert.equal(items[0].source, 'App Store')
  assert.equal(items[0].segment, '企业客户')
  assert.equal(items[0].severity, '高')
  assert.equal(items[0].date, '2026-02-01')
  assert.equal(items[1].source, 'Support')
  assert.throws(() => parseFeedback('{not valid json', 'json'), /Invalid JSON feedback/)
})

test('lines parser keeps one non-empty line per feedback item', () => {
  const items = parseFeedback('界面太复杂，找不到导出按钮\n\nApp crashes on launch\n   \n', 'lines')
  assert.equal(items.length, 2)
  assert.deepEqual(
    items.map((item) => item.text),
    ['界面太复杂，找不到导出按钮', 'App crashes on launch']
  )
  assert.deepEqual(
    items.map((item) => item.id),
    ['fb-1', 'fb-2']
  )
})

test('default theme taxonomy covers the required Chinese and English themes', () => {
  assert.deepEqual(
    DEFAULT_THEMES.map((theme) => theme.name),
    ['性能', '稳定性/崩溃', '易用性/学习成本', '功能缺失', '价格/计费', '客服/支持', '数据/报表', '集成/API', '权限/安全', '移动端', '其他']
  )
  assert.ok(DEFAULT_THEMES.every((theme) => Array.isArray(theme.keywords)))
  const text = DEFAULT_THEMES.map((theme) => theme.keywords.join(' ')).join(' ').toLowerCase()
  for (const keyword of ['slow', 'crash', 'usability', 'feature request', 'pricing', 'customer support', 'dashboard', 'api', 'security', 'mobile']) {
    assert.ok(text.includes(keyword), `missing English keyword ${keyword}`)
  }
})

test('default themes match Chinese and English feedback into the right clusters', () => {
  const items = parseFeedback(
    ['App is very slow and laggy', '应用崩溃了，一直闪退', '希望增加深色模式', '定价太贵了'].join('\n'),
    'lines'
  )
  const result = clusterFeedback(items)
  const byTheme = new Map(result.clusters.map((cluster) => [cluster.theme, cluster]))
  assert.equal(byTheme.get('性能')?.count, 1)
  assert.equal(byTheme.get('稳定性/崩溃')?.count, 1)
  assert.equal(byTheme.get('功能缺失')?.count, 1)
  assert.equal(byTheme.get('价格/计费')?.count, 1)
  assert.equal(result.unclustered.length, 0)
  for (const cluster of result.clusters) {
    assert.ok(cluster.share > 0 && cluster.share <= 1)
    assert.ok(cluster.quotes.length >= 1)
  }
})

test('an item can match several themes and carries confidence plus matched keywords', () => {
  const items: FeedbackItem[] = [{ id: 'x1', text: 'The app crashes and is very slow', source: 'App Store' }]
  const result = clusterFeedback(items)
  const assignment = result.assignments[0]
  assert.equal(assignment.matches.length, 2)
  const themes = assignment.matches.map((match) => match.theme)
  assert.ok(themes.includes('性能'))
  assert.ok(themes.includes('稳定性/崩溃'))
  for (const match of assignment.matches) {
    assert.ok(match.confidence >= 0.45 && match.confidence <= 0.95)
    assert.ok(match.keywords.length >= 1)
  }
  assert.equal(result.clusteredCount, 1)
})

test('custom themes replace the default taxonomy and leave unmatched items unclustered', () => {
  const themes: ThemeRule[] = [
    { name: 'Onboarding', keywords: ['onboarding', '引导'] },
    { name: 'Billing', keywords: ['billing', '计费'] }
  ]
  const items = parseFeedback('Onboarding is confusing\n计费规则不透明\nThe color scheme is nice', 'lines')
  const result = clusterFeedback(items, { themes })
  assert.deepEqual(
    result.clusters.map((cluster) => cluster.theme),
    ['Onboarding', 'Billing']
  )
  assert.equal(result.unclustered.length, 1)
  assert.equal(result.unclustered[0].text, 'The color scheme is nice')
  assert.equal(result.clusters.some((cluster) => cluster.theme === '其他'), false)
})

test('default catch-all keeps unmatched items visible in 其他 and in unclustered', () => {
  const items = parseFeedback('The color scheme is nice\n也还行吧', 'lines')
  const result = clusterFeedback(items)
  assert.equal(result.unclustered.length, 2)
  const other = result.clusters.find((cluster) => cluster.theme === '其他')
  assert.ok(other)
  assert.equal(other.catchAll, true)
  assert.equal(other.count, 2)
  assert.equal(other.quotes.length, 2)
})

test('feedbackStats counts sources, segments, severity and top themes', () => {
  const items: FeedbackItem[] = [
    { id: 'a', text: '崩溃', source: 'App Store', segment: '企业', severity: 'high' },
    { id: 'b', text: '太慢', source: 'App Store', segment: '企业' },
    { id: 'c', text: '价格太贵', source: '客服', segment: '个人', severity: '中' }
  ]
  const clusters = clusterFeedback(items)
  const stats = feedbackStats(items, clusters)
  assert.equal(stats.total, 3)
  assert.equal(stats.sourceCount, 2)
  assert.equal(stats.segmentCount, 2)
  assert.equal(stats.bySource['App Store'], 2)
  assert.equal(stats.bySource['客服'], 1)
  assert.equal(stats.bySegment['企业'], 2)
  assert.equal(stats.bySegment['个人'], 1)
  assert.equal(stats.bySeverity.high, 1)
  assert.equal(stats.bySeverity.medium, 1)
  assert.equal(stats.bySeverity.unspecified, 1)
  assert.equal(stats.topThemes[0].theme, '性能')
  assert.match(stats.quickSummary, /共 3 条反馈/)
  assert.equal(normalizeSeverity('P0'), 'critical')
  assert.equal(normalizeSeverity(' 高 '), 'high')
})

test('report has the required sections, quotes, segment differences and caveat', () => {
  const items: FeedbackItem[] = [
    { id: '1', text: 'App 经常崩溃，闪退', source: 'App Store', segment: '企业客户', severity: 'critical' },
    { id: '2', text: '加载太慢，等很久', source: 'App Store', segment: '个人用户', severity: 'high' },
    { id: '3', text: '希望增加批量导出', source: '客服工单', segment: '企业客户', severity: 'medium' },
    { id: '4', text: '价格太贵，不会续费', source: '客服工单', segment: '个人用户', severity: 'low' },
    { id: '5', text: 'The color scheme is nice', source: 'App Store', segment: '个人用户' }
  ]
  const clusters = clusterFeedback(items)
  const report = buildFeedbackReport(items, clusters)

  for (const heading of ['## TL;DR', '## 主题分布', '## 核心主题与代表引用', '## 细分差异', '## 下一步调查', '## 说明与限制']) {
    assert.ok(report.includes(heading), `missing heading ${heading}`)
  }
  assert.match(report, /不是统计上具有代表性的样本/)
  assert.match(report, /关键词预聚类不是语义聚类/)
  assert.match(report, /App 经常崩溃，闪退/)
  assert.match(report, /企业客户/)
  assert.match(report, /个人用户/)
  assert.match(report, /未归类/)
})

test('English report switches headings and caveat language', () => {
  const items: FeedbackItem[] = [{ id: '1', text: 'The app crashes constantly', source: 'App Store', segment: 'Enterprise', severity: 'high' }]
  const clusters = clusterFeedback(items)
  const report = buildFeedbackReport(items, clusters, { language: 'en', title: 'Q1 feedback review' })
  assert.ok(report.startsWith('# Q1 feedback review'))
  for (const heading of ['## TL;DR', '## Theme distribution', '## Top themes and representative quotes', '## Segment differences', '## What to investigate next', '## Caveats and limitations']) {
    assert.ok(report.includes(heading), `missing heading ${heading}`)
  }
  assert.match(report, /Not a statistically representative sample/i)
  assert.match(report, /Keyword pre-clustering is not semantic clustering/)
})

test('parsing, clustering and reporting are deterministic for the same input', () => {
  const csv = [
    'text,source,segment,severity',
    '"崩溃了，打不开",App Store,企业,high',
    '"加载很慢",App Store,个人,medium',
    '"希望增加导出",客服,企业,low',
    '"The color scheme is nice",App Store,个人,'
  ].join('\n')

  const firstItems = parseFeedback(csv, 'csv')
  const secondItems = parseFeedback(csv, 'csv')
  assert.deepEqual(firstItems, secondItems)

  const first = clusterFeedback(firstItems)
  const second = clusterFeedback(secondItems)
  assert.deepEqual(first, second)

  const firstReport = buildFeedbackReport(firstItems, first)
  const secondReport = buildFeedbackReport(secondItems, second)
  assert.equal(firstReport, secondReport)
  assert.equal(formatParsedItems(firstItems), formatParsedItems(secondItems))
  assert.equal(formatClusterResult(first), formatClusterResult(second))
})

test('empty input produces a safe empty report instead of throwing', () => {
  const items = parseFeedback('', 'lines')
  assert.deepEqual(items, [])
  const clusters = clusterFeedback(items)
  assert.equal(clusters.total, 0)
  assert.deepEqual(clusters.clusters, [])
  assert.deepEqual(clusters.unclustered, [])
  const report = buildFeedbackReport(items, clusters)
  assert.ok(report.includes('## TL;DR'))
  assert.match(report, /不是统计上具有代表性的样本/)
  assert.match(formatParsedItems(items), /没有解析到反馈/)
})

test('JSON Lines exports are accepted by the JSON parser as a fallback', () => {
  const jsonl = ['{"text":"App crashes","source":"App Store"}', '{"text":"太慢了，加载很久","source":"客服"}'].join('\n')
  const items = parseFeedback(jsonl, 'json')
  assert.equal(items.length, 2)
  assert.equal(items[0].source, 'App Store')
  assert.equal(items[1].text, '太慢了，加载很久')
})
