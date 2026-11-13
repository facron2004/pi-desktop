/**
 * User-feedback parsing, deterministic keyword pre-clustering, statistics and
 * Markdown report building.
 *
 * This module is deliberately pure: no network, no Pi imports, no clock, no
 * randomness and no locale-dependent sorting. Everything is deterministic for
 * the same input, which makes the tool output reviewable and testable.
 *
 * IMPORTANT: clusterFeedback is keyword matching, not semantic clustering. It
 * is a first pass that makes a raw export inspectable; the model or PM must
 * still read the quotes, merge/split/rename themes and remove false positives.
 */

export type OutputLanguage = 'zh-CN' | 'en'
export type FeedbackFormat = 'csv' | 'json' | 'lines'

export interface FeedbackItem {
  id?: string
  text: string
  source?: string
  segment?: string
  severity?: string
  date?: string
  metadata?: Record<string, string>
}

export interface ThemeRule {
  name: string
  keywords: string[]
  /** Optional note for the model; never used for matching. */
  description?: string
}

export interface ItemThemeMatch {
  theme: string
  /** Heuristic keyword-match confidence, not a probability. */
  confidence: number
  keywords: string[]
}

export interface FeedbackAssignment {
  id: string
  text: string
  source?: string
  segment?: string
  severity?: string
  matches: ItemThemeMatch[]
}

export interface FeedbackCluster {
  theme: string
  count: number
  /** count / total valid items, rounded to four decimal places. */
  share: number
  keywords: string[]
  itemIds: string[]
  /** Up to three representative quotes, selected deterministically. */
  quotes: string[]
  severityCounts: Record<string, number>
  /** True for the `其他` / `Other` catch-all bucket. */
  catchAll: boolean
}

export interface FeedbackClusterResult {
  total: number
  /** Items with at least one keyword-matched theme. */
  clusteredCount: number
  clusters: FeedbackCluster[]
  assignments: FeedbackAssignment[]
  unclustered: FeedbackItem[]
}

export interface FeedbackStats {
  total: number
  sourceCount: number
  segmentCount: number
  unclusteredCount: number
  bySource: Record<string, number>
  bySegment: Record<string, number>
  bySeverity: Record<string, number>
  topThemes: Array<{ theme: string; count: number; share: number }>
  quickSummary: string
}

export interface ReportOptions {
  title?: string
  language?: OutputLanguage
}

export interface ClusterOptions {
  themes?: ThemeRule[]
}

/** Default Chinese + English theme taxonomy. `其他` is the catch-all bucket. */
export const DEFAULT_THEMES: ThemeRule[] = [
  {
    name: '性能',
    description: 'Speed, latency, lag, memory, battery',
    keywords: [
      '性能',
      '卡顿',
      '很卡',
      '太卡',
      '慢',
      '加载',
      '很慢',
      '太慢',
      '加载慢',
      '响应慢',
      '响应',
      '延迟',
      '掉帧',
      '发热',
      '耗电',
      '内存',
      'performance',
      'slow',
      'slowly',
      'sluggish',
      'lag',
      'laggy',
      'latency',
      'speed',
      'responsive',
      'memory',
      'battery',
      'cpu'
    ]
  },
  {
    name: '稳定性/崩溃',
    description: 'Crashes, errors, freezes, data loss',
    keywords: [
      '崩溃',
      '闪退',
      '报错',
      '错误',
      '异常',
      '不稳定',
      '白屏',
      '黑屏',
      '卡死',
      '卡住',
      '死机',
      '无响应',
      '打不开',
      '无法打开',
      '丢失',
      '损坏',
      'bug',
      'bugs',
      'crash',
      'crashes',
      'crashed',
      'freeze',
      'freezes',
      'frozen',
      'error',
      'errors',
      'exception',
      'unstable',
      'blank screen',
      'black screen',
      'data loss',
      'broken',
      'failure',
      'not working',
      "won't open",
      'does not work',
      "doesn't work"
    ]
  },
  {
    name: '易用性/学习成本',
    description: 'Confusing flows, discoverability, onboarding',
    keywords: [
      '难用',
      '不好用',
      '不会用',
      '找不到',
      '难找',
      '看不懂',
      '不直观',
      '复杂',
      '繁琐',
      '学习成本',
      '上手',
      '引导',
      '交互',
      '操作',
      '体验差',
      '界面',
      '设计',
      'usability',
      'confusing',
      'confused',
      'hard to use',
      'difficult',
      'unintuitive',
      'onboarding',
      'tutorial',
      'guide',
      'discover',
      'navigate',
      'workflow',
      'clunky',
      'friction',
      'ux',
      'ui'
    ]
  },
  {
    name: '功能缺失',
    description: 'Missing capabilities and feature requests',
    keywords: [
      '缺少',
      '缺',
      '没有',
      '不支持',
      '希望增加',
      '建议增加',
      '能不能',
      '能否',
      '需要增加',
      '功能不足',
      '没有这个功能',
      '什么时候支持',
      '求支持',
      'feature request',
      'missing',
      'lack',
      'lacks',
      'no way to',
      'would like',
      'wish',
      'add support',
      'support for',
      'need',
      'needs',
      'request'
    ]
  },
  {
    name: '价格/计费',
    description: 'Pricing, plans, billing, refunds',
    keywords: [
      '价格',
      '价钱',
      '收费',
      '太贵',
      '贵',
      '计费',
      '订阅',
      '退款',
      '会员',
      '付费',
      '付费墙',
      '免费',
      '续费',
      '涨价',
      '性价比',
      'price',
      'pricing',
      'expensive',
      'costly',
      'cost',
      'billing',
      'subscription',
      'refund',
      'paywall',
      'trial',
      'discount',
      'invoice'
    ]
  },
  {
    name: '客服/支持',
    description: 'Support responsiveness and service quality',
    keywords: [
      '客服',
      '售后',
      '工单',
      '回复',
      '没人理',
      '态度',
      '解决问题',
      'customer service',
      'customer support',
      'support team',
      'support',
      'response',
      'reply',
      'ticket',
      'help desk',
      'helpline'
    ]
  },
  {
    name: '数据/报表',
    description: 'Data accuracy, exports, dashboards, analytics',
    keywords: [
      '数据',
      '报表',
      '导出',
      '统计',
      '图表',
      '看板',
      '分析',
      '筛选',
      'dashboard',
      'report',
      'reports',
      'data',
      'export',
      'analytics',
      'chart',
      'charts',
      'metrics',
      'csv',
      'excel',
      'filter',
      'visualization'
    ]
  },
  {
    name: '集成/API',
    description: 'Integrations, API, SDK, third-party tools',
    keywords: [
      '集成',
      '对接',
      '打通',
      '接口',
      '第三方',
      '开放平台',
      'webhook',
      'integration',
      'integrate',
      'api',
      'sdk',
      'plugin',
      'extension',
      'third party',
      'third-party',
      'connect',
      'zapier',
      'oauth'
    ]
  },
  {
    name: '权限/安全',
    description: 'Permissions, privacy, login and accounts',
    keywords: [
      '权限',
      '安全',
      '隐私',
      '登录',
      '账号',
      '账户',
      '授权',
      '密码',
      '验证码',
      '认证',
      '泄露',
      'permission',
      'permissions',
      'security',
      'privacy',
      'login',
      'log in',
      'account',
      'access',
      'password',
      'auth',
      'authentication',
      '2fa',
      'sso',
      'role',
      'roles'
    ]
  },
  {
    name: '移动端',
    description: 'Mobile app and device-specific issues',
    keywords: [
      '手机',
      '移动端',
      '小程序',
      '平板',
      'mobile',
      'phone',
      'iphone',
      'android',
      'tablet',
      'app store',
      'play store'
    ]
  },
  {
    name: '其他',
    description: 'Catch-all for items with no keyword match',
    keywords: []
  }
]

type KnownField = 'id' | 'text' | 'source' | 'segment' | 'severity' | 'date'

const FIELD_ALIASES: Record<KnownField, string[]> = {
  id: ['id', 'feedbackid', 'feedback_id', '编号', '序号'],
  text: [
    'text',
    'feedback',
    'comment',
    'comments',
    'content',
    'message',
    'review',
    'reviewtext',
    'review_text',
    'body',
    'opinion',
    'feedbackcontent',
    '反馈',
    '反馈内容',
    '内容',
    '评论',
    '评价',
    '意见',
    '建议'
  ],
  source: ['source', 'channel', 'platform', '来源', '渠道', '平台'],
  segment: ['segment', 'usersegment', 'user_segment', 'customersegment', 'customer_segment', 'cohort', '用户群', '客群', '细分', '用户类型'],
  severity: ['severity', 'priority', 'sev', '严重程度', '优先级', '级别'],
  date: ['date', 'createdat', 'created_at', 'time', 'timestamp', '日期', '时间', '创建时间']
}

type ThemeBucket = {
  theme: string
  catchAll: boolean
  order: number
  items: FeedbackItem[]
  itemIds: string[]
  matchesByItem: Map<number, ItemThemeMatch>
}

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, unspecified: 0 }

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function normalizeKey(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
}

const FIELD_BY_ALIAS = new Map<string, KnownField>()
for (const [field, aliases] of Object.entries(FIELD_ALIASES) as Array<[KnownField, string[]]>) {
  for (const alias of aliases) FIELD_BY_ALIAS.set(normalizeKey(alias), field)
}

function cleanText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim()
}

function assignKnownField(item: FeedbackItem, field: KnownField, value: string): void {
  const cleaned = cleanText(value)
  if (!cleaned) return
  switch (field) {
    case 'id':
      item.id = cleaned
      break
    case 'text':
      item.text = cleaned
      break
    case 'source':
      item.source = cleaned
      break
    case 'segment':
      item.segment = cleaned
      break
    case 'severity':
      item.severity = cleaned
      break
    case 'date':
      item.date = cleaned
      break
  }
}

function addMetadata(item: FeedbackItem, key: string, value: string): void {
  const cleanedKey = key.trim()
  const cleanedValue = cleanText(value)
  if (!cleanedKey || !cleanedValue) return
  if (!item.metadata) item.metadata = {}
  item.metadata[cleanedKey] = cleanedValue
}

function assignMissingIds(items: FeedbackItem[]): void {
  const used = new Set<string>()
  for (const item of items) if (item.id) used.add(item.id)
  let next = 1
  for (const item of items) {
    if (item.id) continue
    while (used.has(`fb-${next}`)) next += 1
    item.id = `fb-${next}`
    used.add(item.id)
    next += 1
  }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Small RFC-4180-style CSV reader: quoted fields, escaped quotes ("") and
 * newlines inside quotes are supported. Rows are not required to have the same
 * number of columns; empty rows are dropped.
 */
export function parseCsvRows(input: string): string[][] {
  const source = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let index = 0

  while (index < source.length) {
    const char = source[index]
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        inQuotes = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }
    if (char === '"') {
      inQuotes = true
      index += 1
      continue
    }
    if (char === ',') {
      row.push(field)
      field = ''
      index += 1
      continue
    }
    if (char === '\r' || char === '\n') {
      row.push(field)
      field = ''
      rows.push(row)
      row = []
      index += 1
      if (char === '\r' && source[index] === '\n') index += 1
      continue
    }
    field += char
    index += 1
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''))
}

function detectCsvHeader(row: string[]): { header: string[]; fields: Array<KnownField | null> } | null {
  const fields = row.map((cell) => FIELD_BY_ALIAS.get(normalizeKey(cell)) ?? null)
  const known = fields.filter((field): field is KnownField => field !== null)
  if (known.length === 0) return null
  // A single non-text match is not enough: a data row like "source,text value"
  // must not be mistaken for a header.
  if (!known.includes('text') && known.length < 2) return null
  return { header: row, fields }
}

function parseCsv(input: string): FeedbackItem[] {
  const rows = parseCsvRows(input)
  if (rows.length === 0) return []
  const detected = detectCsvHeader(rows[0])
  const dataRows = detected ? rows.slice(1) : rows
  const items: FeedbackItem[] = []

  for (const cells of dataRows) {
    const item: FeedbackItem = { text: '' }
    if (!detected) {
      // No header: the first column is the feedback text.
      item.text = cleanText(cells[0] ?? '')
    } else {
      detected.fields.forEach((field, column) => {
        const value = cells[column] ?? ''
        if (field) {
          assignKnownField(item, field, value)
        } else {
          addMetadata(item, detected.header[column] ?? '', value)
        }
      })
      if (!item.text) item.text = cleanText(cells[0] ?? '')
    }
    if (item.text) items.push(item)
  }

  assignMissingIds(items)
  return items
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function valueToString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return cleanText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function itemFromRecord(record: Record<string, unknown>): FeedbackItem {
  const item: FeedbackItem = { text: '' }
  for (const [key, rawValue] of Object.entries(record)) {
    if (normalizeKey(key) === 'metadata' && isRecord(rawValue)) {
      for (const [metaKey, metaValue] of Object.entries(rawValue)) {
        const text = valueToString(metaValue)
        if (text) addMetadata(item, metaKey, text)
      }
      continue
    }
    const field = FIELD_BY_ALIAS.get(normalizeKey(key))
    const value = valueToString(rawValue)
    if (value === undefined) continue
    if (field) assignKnownField(item, field, value)
    else addMetadata(item, key, value)
  }
  return item
}

const JSON_WRAPPER_KEYS = ['items', 'feedback', 'data', 'records', 'results', 'reviews']

function parseJson(input: string): FeedbackItem[] {
  let data: unknown
  try {
    data = JSON.parse(input)
  } catch (error) {
    // Tolerate JSON Lines exports, which are common from support tools.
    const lines = input
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    if (lines.length > 1) {
      try {
        data = lines.map((line) => JSON.parse(line))
      } catch {
        throw new Error(`Invalid JSON feedback: ${(error as Error).message}`)
      }
    } else {
      throw new Error(`Invalid JSON feedback: ${(error as Error).message}`)
    }
  }

  let records: unknown[]
  if (Array.isArray(data)) {
    records = data
  } else if (isRecord(data)) {
    const wrapper = JSON_WRAPPER_KEYS.map((key) => data[key]).find((value) => Array.isArray(value))
    if (Array.isArray(wrapper)) records = wrapper
    else if (Object.keys(data).some((key) => FIELD_BY_ALIAS.get(normalizeKey(key)) === 'text')) {
      records = [data]
    } else {
      throw new Error('JSON feedback must be an array of objects or an object with an items/feedback/data array.')
    }
  } else {
    throw new Error('JSON feedback must be an array of objects or an object with an items/feedback/data array.')
  }

  const items: FeedbackItem[] = []
  for (const record of records) {
    if (typeof record === 'string') {
      const text = cleanText(record)
      if (text) items.push({ text })
    } else if (isRecord(record)) {
      const item = itemFromRecord(record)
      if (item.text) items.push(item)
    }
  }
  assignMissingIds(items)
  return items
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

function parseLines(input: string): FeedbackItem[] {
  const items = input
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => ({ text: line }))
  assignMissingIds(items)
  return items
}

export function parseFeedback(input: string, format: FeedbackFormat = 'lines'): FeedbackItem[] {
  if (typeof input !== 'string') throw new Error('Feedback input must be a string.')
  const normalized = String(format).toLowerCase()
  if (normalized === 'csv') return parseCsv(input)
  if (normalized === 'json') return parseJson(input)
  if (normalized === 'lines') return parseLines(input)
  throw new Error(`Unknown feedback format "${String(format)}". Use csv, json or lines.`)
}

// ---------------------------------------------------------------------------
// Keyword matching and clustering
// ---------------------------------------------------------------------------

interface CompiledKeyword {
  keyword: string
  test: (lowerText: string) => boolean
}

interface CompiledTheme {
  name: string
  catchAll: boolean
  order: number
  keywords: CompiledKeyword[]
}

const CATCH_ALL_NAMES = new Set(['其他', '其它', 'other', 'others', 'misc', 'miscellaneous'])

function compileKeyword(keyword: string): CompiledKeyword {
  const cleaned = keyword.trim().toLowerCase()
  const asciiOnly = /^[\x20-\x7e]+$/.test(cleaned)
  if (!asciiOnly) {
    return { keyword, test: (lowerText) => lowerText.includes(cleaned) }
  }
  const escaped = cleaned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i')
  return { keyword, test: (lowerText) => pattern.test(lowerText) }
}

function compileThemes(themes: ThemeRule[]): CompiledTheme[] {
  const merged = new Map<string, ThemeRule>()
  for (const rule of themes) {
    if (!rule || typeof rule !== 'object') continue
    const name = String(rule.name ?? '').trim()
    if (!name) continue
    const keywords = Array.isArray(rule.keywords) ? rule.keywords.map((keyword) => String(keyword).trim()).filter(Boolean) : []
    const existing = merged.get(name)
    if (existing) {
      existing.keywords = [...new Set([...existing.keywords, ...keywords])]
    } else {
      merged.set(name, { name, keywords })
    }
  }
  return [...merged.values()].map((rule, order) => ({
    name: rule.name,
    catchAll: rule.keywords.length === 0 && CATCH_ALL_NAMES.has(rule.name.toLowerCase()),
    order,
    keywords: rule.keywords.map(compileKeyword)
  }))
}

function confidenceFor(keywords: string[]): number {
  const distinct = new Set(keywords).size
  const longest = keywords.reduce((max, keyword) => Math.max(max, Array.from(keyword).length), 0)
  // A heuristic on match count and keyword specificity. It is not a probability.
  const raw = 0.45 + 0.12 * Math.max(0, distinct - 1) + (longest >= 4 ? 0.08 : 0)
  return Math.round(Math.min(0.95, raw) * 100) / 100
}

export function normalizeSeverity(value: string | undefined): string {
  const raw = (value ?? '').trim().toLowerCase()
  if (!raw) return 'unspecified'
  if (['critical', 'blocker', 'p0', '致命', '严重'].includes(raw)) return 'critical'
  if (['high', 'p1', '高', '紧急'].includes(raw)) return 'high'
  if (['medium', 'normal', 'p2', '中', '一般'].includes(raw)) return 'medium'
  if (['low', 'minor', 'p3', '低', '轻微'].includes(raw)) return 'low'
  return raw
}

function countValues(values: Array<string | undefined>, fallback: string): Record<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) {
    const key = value?.trim() || fallback
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const result: Record<string, number> = {}
  for (const key of [...counts.keys()].sort(compareText)) result[key] = counts.get(key) ?? 0
  return result
}

function severityCountsOf(items: FeedbackItem[]): Record<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) {
    const severity = normalizeSeverity(item.severity)
    counts.set(severity, (counts.get(severity) ?? 0) + 1)
  }
  const result: Record<string, number> = {}
  for (const key of [...counts.keys()].sort(compareText)) result[key] = counts.get(key) ?? 0
  return result
}

function pickQuotes(items: FeedbackItem[]): string[] {
  return items
    .map((item, index) => ({
      text: item.text.replace(/\s+/g, ' ').trim(),
      rank: SEVERITY_RANK[normalizeSeverity(item.severity)] ?? 0,
      length: item.text.length,
      index
    }))
    .sort((a, b) => b.rank - a.rank || b.length - a.length || a.index - b.index)
    .slice(0, 3)
    .map((entry) => entry.text)
}

function clusterKeywordSummary(bucket: ThemeBucket): string[] {
  const counts = new Map<string, number>()
  for (const match of bucket.matchesByItem.values()) {
    for (const keyword of match.keywords) counts.set(keyword, (counts.get(keyword) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || Array.from(b[0]).length - Array.from(a[0]).length || compareText(a[0], b[0]))
    .slice(0, 8)
    .map(([keyword]) => keyword)
}

export function clusterFeedback(items: FeedbackItem[], options: ClusterOptions = {}): FeedbackClusterResult {
  const validItems = (Array.isArray(items) ? items : []).filter((item) => item && typeof item.text === 'string' && item.text.trim() !== '')
  const rules = compileThemes(options.themes ?? DEFAULT_THEMES)
  const catchAllRule = rules.find((rule) => rule.catchAll)
  const buckets = new Map<string, ThemeBucket>()
  const assignments: FeedbackAssignment[] = []
  const unclustered: FeedbackItem[] = []

  for (const rule of rules) {
    buckets.set(rule.name, { theme: rule.name, catchAll: rule.catchAll, order: rule.order, items: [], itemIds: [], matchesByItem: new Map() })
  }

  validItems.forEach((item, index) => {
    const lowerText = item.text.toLowerCase()
    const matches: ItemThemeMatch[] = []
    for (const rule of rules) {
      if (rule.catchAll) continue
      const keywords = rule.keywords.filter((keyword) => keyword.test(lowerText)).map((keyword) => keyword.keyword)
      if (keywords.length > 0) matches.push({ theme: rule.name, confidence: confidenceFor(keywords), keywords })
    }

    const id = item.id?.trim() || `item-${index + 1}`
    assignments.push({
      id,
      text: item.text,
      source: item.source,
      segment: item.segment,
      severity: item.severity,
      matches
    })

    if (matches.length === 0) {
      unclustered.push(item)
      if (catchAllRule) {
        const bucket = buckets.get(catchAllRule.name)
        if (bucket) {
          bucket.items.push(item)
          bucket.itemIds.push(id)
        }
      }
      return
    }

    for (const match of matches) {
      const bucket = buckets.get(match.theme)
      if (!bucket) continue
      bucket.items.push(item)
      bucket.itemIds.push(id)
      bucket.matchesByItem.set(index, match)
    }
  })

  const total = validItems.length
  const clusters: FeedbackCluster[] = [...buckets.values()]
    .filter((bucket) => bucket.items.length > 0)
    .map((bucket) => ({
      theme: bucket.theme,
      count: bucket.items.length,
      share: total === 0 ? 0 : Math.round((bucket.items.length / total) * 10000) / 10000,
      keywords: bucket.catchAll ? [] : clusterKeywordSummary(bucket),
      itemIds: [...bucket.itemIds],
      quotes: bucket.catchAll ? pickQuotes(bucket.items).slice(0, 2) : pickQuotes(bucket.items),
      severityCounts: severityCountsOf(bucket.items),
      catchAll: bucket.catchAll
    }))
    .sort((a, b) => {
      if (a.catchAll !== b.catchAll) return a.catchAll ? 1 : -1
      if (b.count !== a.count) return b.count - a.count
      return (buckets.get(a.theme)?.order ?? 0) - (buckets.get(b.theme)?.order ?? 0)
    })

  return {
    total,
    clusteredCount: assignments.filter((assignment) => assignment.matches.length > 0).length,
    clusters,
    assignments,
    unclustered
  }
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function percentLabel(share: number): string {
  const percent = Math.round(share * 1000) / 10
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent}%`
}

export function feedbackStats(
  items: FeedbackItem[],
  clusters: FeedbackClusterResult,
  language: OutputLanguage = 'zh-CN'
): FeedbackStats {
  const zh = language === 'zh-CN'
  const validItems = (Array.isArray(items) ? items : []).filter((item) => item && typeof item.text === 'string' && item.text.trim() !== '')
  const fallback = zh ? '未标注' : 'Unspecified'
  const bySource = countValues(validItems.map((item) => item.source), fallback)
  const bySegment = countValues(validItems.map((item) => item.segment), fallback)
  const bySeverity = countValues(validItems.map((item) => normalizeSeverity(item.severity)), 'unspecified')
  const topThemes = clusters.clusters.slice(0, 5).map((cluster) => ({
    theme: cluster.theme,
    count: cluster.count,
    share: cluster.share
  }))
  const unclusteredCount = clusters.unclustered.length
  const top = topThemes[0]
  const quickSummary = zh
    ? `共 ${validItems.length} 条反馈；${top ? `最大主题「${top.theme}」${top.count} 条（${percentLabel(top.share)}）` : '没有主题命中关键词'}；${unclusteredCount} 条未归类。`
    : `Total ${validItems.length} items; ${top ? `largest theme "${top.theme}" with ${top.count} items (${percentLabel(top.share)})` : 'no theme matched keywords'}; ${unclusteredCount} unclustered.`

  return {
    total: validItems.length,
    sourceCount: Object.keys(bySource).filter((key) => key !== fallback).length,
    segmentCount: Object.keys(bySegment).filter((key) => key !== fallback).length,
    unclusteredCount,
    bySource,
    bySegment,
    bySeverity,
    topThemes,
    quickSummary
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const SEVERITY_LABELS: Record<string, { zh: string; en: string }> = {
  critical: { zh: '致命', en: 'critical' },
  high: { zh: '高', en: 'high' },
  medium: { zh: '中', en: 'medium' },
  low: { zh: '低', en: 'low' },
  unspecified: { zh: '未标注', en: 'unspecified' }
}

function severityLabel(value: string, language: OutputLanguage): string {
  const entry = SEVERITY_LABELS[value]
  return entry ? entry[language === 'zh-CN' ? 'zh' : 'en'] : value
}

function truncateQuote(text: string, maxLength = 220): string {
  const singleLine = text.replace(/\s+/g, ' ').trim()
  if (singleLine.length <= maxLength) return singleLine
  return `${singleLine.slice(0, maxLength - 1)}…`
}

function joinList(values: string[], language: OutputLanguage): string {
  return values.join(language === 'zh-CN' ? '、' : ', ')
}

function buildSegmentRows(clusters: FeedbackClusterResult, language: OutputLanguage): string[] {
  const zh = language === 'zh-CN'
  const segments = new Map<string, { total: number; themes: Map<string, number> }>()
  for (const assignment of clusters.assignments) {
    const segment = assignment.segment?.trim()
    if (!segment) continue
    const entry = segments.get(segment) ?? { total: 0, themes: new Map<string, number>() }
    entry.total += 1
    for (const match of assignment.matches) entry.themes.set(match.theme, (entry.themes.get(match.theme) ?? 0) + 1)
    segments.set(segment, entry)
  }

  if (segments.size === 0) {
    return [zh ? '- 反馈未提供细分字段，无法比较细分差异。' : '- No segment field was provided, so segment differences cannot be compared.']
  }

  const rows = [...segments.entries()].sort((a, b) => b[1].total - a[1].total || compareText(a[0], b[0]))
  const lines = [zh ? '| 细分 | 反馈数 | 主要主题 | 主题占比 |' : '| Segment | Items | Top theme | Share |', '| --- | --- | --- | --- |']
  for (const [segment, entry] of rows) {
    const topTheme = [...entry.themes.entries()].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))[0]
    const share = topTheme ? topTheme[1] / entry.total : 0
    lines.push(
      `| ${escapeCell(segment)} | ${entry.total} | ${topTheme ? escapeCell(topTheme[0]) : zh ? '未归类' : 'unclustered'} | ${topTheme ? percentLabel(share) : '—'} |`
    )
  }
  if (segments.size === 1) {
    lines.push('', zh ? '- 只有一个细分，无法做跨细分对比。' : '- Only one segment is present, so no cross-segment comparison is possible.')
  }
  return lines
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n+/g, ' ')
}

function buildNextSteps(clusters: FeedbackClusterResult, stats: FeedbackStats, language: OutputLanguage): string[] {
  const zh = language === 'zh-CN'
  const lines: string[] = []
  const top = clusters.clusters.filter((cluster) => !cluster.catchAll).slice(0, 3)
  for (const cluster of top) {
    lines.push(
      zh
        ? `- 「${cluster.theme}」：抽取 5–10 条原始反馈逐条复核，确认关键词命中不是误报，并记录具体场景、版本、设备和用户类型。`
        : `- "${cluster.theme}": re-read 5–10 raw items to confirm the keyword hits are not false positives, and record scenario, version, device and segment.`
    )
  }
  if (top.length >= 2) {
    lines.push(
      zh
        ? `- 对比「${top[0].theme}」的频率与「${top[1].theme}」的严重程度：高频低严重不等于高优先级，低频崩溃可能更值得先修。`
        : `- Compare the frequency of "${top[0].theme}" with the severity of "${top[1].theme}": frequent-but-minor is not automatically higher priority than rare-but-critical.`
    )
  }
  if (stats.unclusteredCount > 0) {
    lines.push(
      zh
        ? `- 人工阅读 ${stats.unclusteredCount} 条未归类反馈，补充主题关键词或发现新的主题；不要把它们直接忽略。`
        : `- Manually read the ${stats.unclusteredCount} unclustered items, add theme keywords or discover new themes; do not silently drop them.`
    )
  }
  if ((stats.bySeverity.unspecified ?? 0) > 0) {
    lines.push(
      zh
        ? `- 补齐 ${stats.bySeverity.unspecified} 条缺失严重程度的反馈，并区分“影响多少人”和“单次影响多严重”。`
        : `- Fill in the missing severity for ${stats.bySeverity.unspecified} items, and separate "how many people" from "how bad per occurrence".`
    )
  }
  lines.push(
    zh
      ? '- 回到原始导出核对时间范围、渠道口径、去重规则和样本偏差，再决定能否对外引用比例。'
      : '- Go back to the raw export and verify date range, channel coverage, de-duplication and sampling bias before quoting percentages externally.'
  )
  return lines
}

export function buildFeedbackReport(
  items: FeedbackItem[],
  clusters: FeedbackClusterResult,
  options: ReportOptions = {}
): string {
  const language: OutputLanguage = options.language === 'en' ? 'en' : 'zh-CN'
  const zh = language === 'zh-CN'
  const stats = feedbackStats(items, clusters, language)
  const lines: string[] = []
  lines.push(`# ${options.title?.trim() || (zh ? '用户反馈主题报告' : 'User feedback theme report')}`, '')

  // TL;DR
  lines.push('## TL;DR', '')
  lines.push(
    zh
      ? `- 共解析 ${stats.total} 条反馈，其中 ${clusters.clusteredCount} 条命中关键词主题，${stats.unclusteredCount} 条未归类。`
      : `- Parsed ${stats.total} feedback items: ${clusters.clusteredCount} matched a keyword theme and ${stats.unclusteredCount} were unclustered.`
  )
  const topThree = clusters.clusters.filter((cluster) => !cluster.catchAll).slice(0, 3)
  if (topThree.length > 0) {
    lines.push(
      zh
        ? `- 主题前三：${topThree.map((cluster) => `「${cluster.theme}」${cluster.count} 条（${percentLabel(cluster.share)}）`).join('、')}。`
        : `- Top themes: ${topThree.map((cluster) => `"${cluster.theme}" ${cluster.count} items (${percentLabel(cluster.share)})`).join(', ')}.`
    )
  } else {
    lines.push(zh ? '- 没有主题命中关键词，需要人工阅读和补充主题词。' : '- No theme matched any keyword; manual reading and additional theme keywords are needed.')
  }
  const sourceNames = Object.keys(stats.bySource).filter((key) => key !== (zh ? '未标注' : 'Unspecified'))
  lines.push(
    zh
      ? `- 来源 ${stats.sourceCount} 个${sourceNames.length ? `（${joinList(sourceNames.slice(0, 5), language)}）` : ''}；细分 ${stats.segmentCount} 个；严重程度：${Object.entries(stats.bySeverity).map(([key, count]) => `${severityLabel(key, language)} ${count}`).join('、') || '未提供'}。`
      : `- ${stats.sourceCount} source(s)${sourceNames.length ? ` (${joinList(sourceNames.slice(0, 5), language)})` : ''}; ${stats.segmentCount} segment(s); severity: ${Object.entries(stats.bySeverity).map(([key, count]) => `${severityLabel(key, language)} ${count}`).join(', ') || 'not provided'}.`
  )
  lines.push(
    zh
      ? '- 本报告是关键词初筛结果，不是统计代表性结论；对外引用前必须人工复核原文和样本口径。'
      : '- This is a keyword pre-pass, not a statistically representative conclusion; human review of raw text and sampling is required before external use.'
  )
  lines.push('')

  // Theme distribution
  lines.push(zh ? '## 主题分布' : '## Theme distribution', '')
  if (clusters.clusters.length === 0) {
    lines.push(zh ? '没有识别出主题。' : 'No themes identified.')
  } else {
    lines.push(zh ? '| 主题 | 条数 | 占比 | 关键词 |' : '| Theme | Items | Share | Keywords |', '| --- | --- | --- | --- |')
    for (const cluster of clusters.clusters) {
      lines.push(
        `| ${escapeCell(cluster.theme)} | ${cluster.count} | ${percentLabel(cluster.share)} | ${escapeCell(cluster.keywords.slice(0, 4).join(zh ? '、' : ', ') || '—')} |`
      )
    }
  }
  lines.push('')

  // Representative quotes
  lines.push(zh ? '## 核心主题与代表引用' : '## Top themes and representative quotes', '')
  const quoteClusters = clusters.clusters.filter((cluster) => !cluster.catchAll).slice(0, 5)
  if (quoteClusters.length === 0) {
    lines.push(zh ? '没有命中关键词的主题可引用。' : 'No keyword-matched theme has representative quotes.')
  } else {
    quoteClusters.forEach((cluster, index) => {
      lines.push(`### ${index + 1}. ${cluster.theme} — ${cluster.count} ${zh ? '条' : 'items'}（${percentLabel(cluster.share)}）`)
      if (cluster.keywords.length > 0) {
        lines.push(zh ? `- 命中关键词：${joinList(cluster.keywords.slice(0, 6), language)}` : `- Matched keywords: ${joinList(cluster.keywords.slice(0, 6), language)}`)
      }
      for (const quote of cluster.quotes.slice(0, 2)) lines.push(`> ${truncateQuote(quote)}`)
      lines.push('')
    })
  }
  if (stats.unclusteredCount > 0) {
    lines.push(
      zh
        ? `另有 ${stats.unclusteredCount} 条反馈没有命中任何关键词，已放入「其他」或未归类清单，需人工阅读。`
        : `${stats.unclusteredCount} items matched no keyword and sit in "Other"/unclustered; they need manual reading.`
    )
    lines.push('')
  }

  // Segment differences
  lines.push(zh ? '## 细分差异' : '## Segment differences', '')
  lines.push(...buildSegmentRows(clusters, language), '')

  // Next steps
  lines.push(zh ? '## 下一步调查' : '## What to investigate next', '')
  lines.push(...buildNextSteps(clusters, stats, language), '')

  // Caveats
  lines.push(zh ? '## 说明与限制' : '## Caveats and limitations', '')
  lines.push(
    zh
      ? '- **不是统计上具有代表性的样本（not statistically representative）。** 反馈来自特定渠道和愿意发声的人，不能直接推断整体用户。占比只在当前解析到的样本内有意义。'
      : '- **Not a statistically representative sample.** Feedback comes from specific channels and people who chose to speak, so it cannot be generalised to all users. Shares are only meaningful within the parsed sample.'
  )
  lines.push(
    zh
      ? '- **关键词预聚类不是语义聚类。** 工具只按主题关键词做确定性匹配，会漏掉同义表达、误判否定句，也无法理解上下文。主题名称、边界和引用必须由模型或 PM 复核。'
      : '- **Keyword pre-clustering is not semantic clustering.** The tool matches deterministic keywords, misses synonyms, can misread negations and does not understand context. Theme names, boundaries and quotes must be reviewed by the model or PM.'
  )
  lines.push(
    zh
      ? '- 频率不是优先级：请结合严重程度、受影响用户群、可复现性和业务影响判断先修什么。'
      : '- Frequency is not priority: combine severity, affected segment, reproducibility and business impact when deciding what to fix first.'
  )
  lines.push(
    zh
      ? '- 一条反馈可以命中多个主题，因此各主题占比之和可能超过 100%；这里的占比是主题覆盖度，不是互斥分布。'
      : '- One item can match several themes, so theme shares may add up to more than 100%; they measure theme coverage, not a mutually exclusive distribution.'
  )

  return lines.join('\n')
}
