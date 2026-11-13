/**
 * 竞品情报核心逻辑。
 *
 * 这个模块刻意保持纯 TypeScript：不导入 Pi、不发网络请求、不读文件，
 * tests/pm-competitor.test.ts 可以直接用 esbuild 打包后跑 node:test。
 *
 * 三个产出：
 * - buildMatrix：加权功能矩阵（0–100 归一化总分 + 功能差距 + Markdown 表）
 * - buildBattlecard：七段式竞品作战卡骨架
 * - buildPricingComparison：统一口径的定价对比表
 * 另外提供 buildSourceLog，把证据分级和日期写成可复核的来源台账。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface Competitor {
  /** 竞品名称（也是 FeatureRow.scores 的键）。 */
  name: string
  /** 目标细分市场，例如「中小企业」「金融行业」「开发者」。 */
  segment?: string
  /** 对外定位或一句话卖点。 */
  positioning?: string
  /** 公开可见的定价摘要，例如「¥99/席位/月起，年付 8 折」。 */
  pricing?: string
  /** 客观优势，尽量写成可验证的事实而不是形容词。 */
  strengths?: string[]
  /** 客观弱点或限制。 */
  weaknesses?: string[]
  /** 近 90 天的产品、定价、融资、组织变化，建议带日期。 */
  recentChanges?: string[]
  /** 资料复核日期，建议 YYYY-MM-DD。 */
  lastVerified?: string
  /** 主要来源（官网、定价页、评测等）。 */
  source?: string
}

export interface FeatureRow {
  /** 功能名称，例如「实时报表」。 */
  name: string
  /** 权重，正整数或小数；未填时按 1。 */
  weight?: number
  /** 竞品名 → 0–5 分。缺失的键按未评分处理。 */
  scores: Record<string, number>
  /** 该行评分的证据摘要，例如「官网文档 + 2026-03 客户访谈」。 */
  evidence?: string
  /** 证据日期，建议 YYYY-MM-DD。 */
  evidenceDate?: string
}

export interface CompetitorScore {
  name: string
  segment?: string
  positioning?: string
  /** 加权总分，0–100，保留 1 位小数。 */
  weightedScore: number
  /** 加权得分原始值：Σ(权重 × 评分)。 */
  rawPoints: number
  /** 满分：Σ(权重 × 5)。 */
  maxPoints: number
  /** 有评分的功能数。 */
  assessedFeatures: number
  /** 功能总数。 */
  totalFeatures: number
  /** 名次；同分共享名次（competition ranking）。 */
  rank: number
}

export interface FeatureGap {
  feature: string
  weight: number
  /** 最高分竞品，可能并列多个。 */
  leaders: string[]
  /** 最低分竞品，可能并列多个。 */
  laggers: string[]
  leaderScore: number
  laggerScore: number
  /** 最高分与最低分的差。 */
  spread: number
  /** 有评分的竞品数。 */
  assessed: number
}

export interface MatrixResult {
  /** 按名次排序。 */
  competitors: CompetitorScore[]
  /** 按「权重 × 差距」从大到小排序。 */
  gaps: FeatureGap[]
  markdown: string
  warnings: string[]
}

export interface ProductProfile {
  name: string
  segment?: string
  positioning?: string
  strengths?: string[]
  weaknesses?: string[]
  /** 可公开引用的客户案例、基准测试、第三方评测等。 */
  proofPoints?: string[]
}

export type BattlecardSectionKey =
  | 'who_they_win_with'
  | 'why_we_win'
  | 'landmines'
  | 'objection_handling'
  | 'proof_points'
  | 'questions_to_ask'
  | 'recent_changes'

export interface BattlecardSection {
  key: BattlecardSectionKey
  title: string
  items: string[]
}

export interface BattlecardResult {
  competitor: string
  ourProduct: string
  sections: BattlecardSection[]
  markdown: string
  warnings: string[]
}

export interface PricingTier {
  /** 方案名，例如「Starter」「企业版」。 */
  name: string
  /** 厂商名。 */
  vendor: string
  /** 报价数值。 */
  price: number
  /** 计价单位，例如「¥/席位/月」「元/账号/年」「美元/千次调用」。 */
  unit: string
  /** 该档位包含的内容。 */
  included: string[]
  /** 币种代码或符号，例如 CNY、USD、¥。 */
  currency?: string
  /** 备注：是否含税、最低消费、实施费等。 */
  notes?: string
}

export type BillingPeriod = 'month' | 'year' | 'quarter' | 'day' | 'unknown'
export type PriceBasis = 'seat' | 'user' | 'account' | 'usage' | 'unknown'

export interface NormalizedPricingTier extends PricingTier {
  period: BillingPeriod
  basis: PriceBasis
  /** 按周期简单折算的年价；周期无法识别时为 undefined。 */
  annualPrice?: number
  /** 是否为该厂商的入门档（同厂商可比较档位中最低年价）。 */
  entryTier: boolean
}

export interface PricingComparisonResult {
  tiers: NormalizedPricingTier[]
  markdown: string
  warnings: string[]
}

export type EvidenceLevel = 'public_doc' | 'pricing_page' | 'customer_interview' | 'rumor' | 'other'

export interface SourceEntry {
  /** 这条证据支持的主题/结论。 */
  topic: string
  /** 来源名称，例如「官网产品文档」「G2 评测」「客户 A 访谈」。 */
  source: string
  /** 链接；没有就留空。 */
  url?: string
  /** 日期，建议 YYYY-MM-DD；未知时留空。 */
  date: string
  /** 证据级别。 */
  level: EvidenceLevel
  /** 备注：口径、样本量、访谈对象角色等。 */
  note?: string
}

export interface SourceLogResult {
  entries: SourceEntry[]
  markdown: string
  warnings: string[]
  counts: Record<EvidenceLevel, number>
}

/** 证据等级的说明与排序：数字越小越可信。 */
export const EVIDENCE_LEVELS: Record<
  EvidenceLevel,
  { label: string; rank: number; confidence: string }
> = {
  public_doc: { label: '公开文档', rank: 1, confidence: '高' },
  pricing_page: { label: '官方定价页', rank: 2, confidence: '中高' },
  customer_interview: { label: '客户访谈', rank: 3, confidence: '中（需交叉验证）' },
  rumor: { label: '传闻', rank: 4, confidence: '低（仅线索）' },
  other: { label: '其他', rank: 5, confidence: '待评估' }
}

/** 作战卡的七段固定结构，顺序即展示顺序。 */
export const BATTLECARD_SECTION_KEYS: BattlecardSectionKey[] = [
  'who_they_win_with',
  'why_we_win',
  'landmines',
  'objection_handling',
  'proof_points',
  'questions_to_ask',
  'recent_changes'
]

// ---------------------------------------------------------------------------
// 通用小工具（保持确定性：排序不依赖 locale）
// ---------------------------------------------------------------------------

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function roundTo(value: number, digits = 1): number {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

/** 表格数字：整数原样，小数最多 1 位；非有限数显示 —。 */
export function formatMatrixNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return Number.isInteger(value) ? String(value) : String(roundTo(value, 1))
}

function formatPriceNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return Number.isInteger(value) ? String(value) : String(roundTo(value, 2))
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

type Align = 'left' | 'right' | 'center'

function markdownTable(headers: string[], aligns: Align[], rows: string[][]): string {
  const separator = aligns.map((align) => (align === 'right' ? '---:' : align === 'center' ? ':---:' : '---'))
  return [
    `| ${headers.map(escapeCell).join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`)
  ].join('\n')
}

function cleanList(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0)
}

function quote(value: string): string {
  return `「${value}」`
}

// ---------------------------------------------------------------------------
// buildMatrix
// ---------------------------------------------------------------------------

interface PreparedFeature {
  name: string
  weight: number
  scores: Map<string, number>
  evidence?: string
  evidenceDate?: string
}

/**
 * 建立竞品功能矩阵。
 *
 * 评分口径：0 = 无能力，1 = 只有概念/路线图，2 = 早期可用，3 = 可用但一般，
 * 4 = 强，5 = 市场最佳。加权总分 = Σ(权重 × 评分) ÷ Σ(权重 × 5) × 100。
 * 缺失评分按 0 计入（这样各竞品分母一致、分数可比），并在 warnings 中提示。
 */
export function buildMatrix(competitors: Competitor[], features: FeatureRow[]): MatrixResult {
  const warnings: string[] = []

  const defined: Competitor[] = []
  const seenCompetitors = new Set<string>()
  for (const competitor of competitors ?? []) {
    const name = competitor?.name?.trim()
    if (!name) {
      warnings.push('已跳过没有名称的竞品。')
      continue
    }
    if (seenCompetitors.has(name)) {
      warnings.push(`竞品${quote(name)}重复出现，保留第一次的定义。`)
      continue
    }
    seenCompetitors.add(name)
    defined.push({ ...competitor, name })
  }
  const competitorNames = defined.map((competitor) => competitor.name)
  const competitorSet = new Set(competitorNames)

  const prepared: PreparedFeature[] = []
  const seenFeatures = new Set<string>()
  for (const feature of features ?? []) {
    const name = feature?.name?.trim()
    if (!name) {
      warnings.push('已跳过没有名称的功能行。')
      continue
    }
    if (seenFeatures.has(name)) {
      warnings.push(`功能${quote(name)}重复出现，将分别计算（建议合并为一行）。`)
    }
    seenFeatures.add(name)

    let weight = 1
    if (feature.weight !== undefined) {
      if (typeof feature.weight === 'number' && Number.isFinite(feature.weight) && feature.weight > 0) {
        weight = feature.weight
      } else {
        warnings.push(`功能${quote(name)}的权重无效（需为正数），已按 1 处理。`)
      }
    }

    const scores = new Map<string, number>()
    let unknown = 0
    for (const [competitorName, rawScore] of Object.entries(feature.scores ?? {})) {
      if (!competitorSet.has(competitorName)) {
        unknown += 1
        continue
      }
      if (typeof rawScore !== 'number' || !Number.isFinite(rawScore)) {
        warnings.push(`功能${quote(name)}中${quote(competitorName)}的评分不是有效数字，按未评分处理。`)
        continue
      }
      let score = rawScore
      if (score < 0 || score > 5) {
        score = Math.min(5, Math.max(0, score))
        warnings.push(
          `功能${quote(name)}中${quote(competitorName)}的评分 ${formatMatrixNumber(rawScore)} 超出 0–5，已按 ${formatMatrixNumber(score)} 计算。`
        )
      }
      scores.set(competitorName, score)
    }
    if (unknown > 0) {
      warnings.push(`功能${quote(name)}包含 ${unknown} 个不在竞品清单中的评分，已忽略。`)
    }
    if (scores.size === 0) {
      warnings.push(`功能${quote(name)}没有任何竞品评分，按 0 分计入（会拉低所有竞品的总分）。`)
    }
    const evidenceDate = feature.evidenceDate?.trim() || undefined
    if (evidenceDate && !isValidDate(evidenceDate)) {
      warnings.push(`功能${quote(name)}的 evidenceDate${quote(evidenceDate)}不是 YYYY-MM-DD 格式。`)
    }
    prepared.push({
      name,
      weight,
      scores,
      evidence: feature.evidence?.trim() || undefined,
      evidenceDate
    })
  }

  const totalFeatures = prepared.length
  const maxPoints = prepared.reduce((sum, feature) => sum + feature.weight * 5, 0)

  const scored: CompetitorScore[] = defined.map((competitor) => {
    let rawPoints = 0
    let assessedFeatures = 0
    for (const feature of prepared) {
      const score = feature.scores.get(competitor.name)
      if (score === undefined) continue
      rawPoints += feature.weight * score
      assessedFeatures += 1
    }
    if (assessedFeatures < totalFeatures) {
      warnings.push(
        `竞品${quote(competitor.name)}有 ${totalFeatures - assessedFeatures} 个功能未评分，按 0 分计入；总分可能偏低，请补充证据后再比较。`
      )
    }
    if (totalFeatures > 0 && assessedFeatures === 0) {
      warnings.push(`竞品${quote(competitor.name)}没有任何功能评分，无法判断其位置。`)
    }
    const weightedScore = maxPoints > 0 ? roundTo((rawPoints / maxPoints) * 100, 1) : 0
    return {
      name: competitor.name,
      segment: competitor.segment?.trim() || undefined,
      positioning: competitor.positioning?.trim() || undefined,
      weightedScore,
      rawPoints: roundTo(rawPoints, 2),
      maxPoints: roundTo(maxPoints, 2),
      assessedFeatures,
      totalFeatures,
      rank: 0
    }
  })

  scored.sort((a, b) => b.weightedScore - a.weightedScore || compareText(a.name, b.name))
  for (let index = 0; index < scored.length; index += 1) {
    const previous = index > 0 ? scored[index - 1] : undefined
    scored[index].rank = previous && previous.weightedScore === scored[index].weightedScore ? previous.rank : index + 1
  }

  const gapFor = (feature: PreparedFeature): FeatureGap | undefined => {
    if (feature.scores.size === 0) return undefined
    const scores = [...feature.scores.entries()]
    const leaderScore = Math.max(...scores.map(([, score]) => score))
    const laggerScore = Math.min(...scores.map(([, score]) => score))
    const leaders = scores
      .filter(([, score]) => score === leaderScore)
      .map(([name]) => name)
      .sort(compareText)
    const laggers = scores
      .filter(([, score]) => score === laggerScore)
      .map(([name]) => name)
      .sort(compareText)
    return {
      feature: feature.name,
      weight: feature.weight,
      leaders,
      laggers,
      leaderScore,
      laggerScore,
      spread: roundTo(leaderScore - laggerScore, 2),
      assessed: feature.scores.size
    }
  }
  const gaps: FeatureGap[] = prepared
    .map((feature) => gapFor(feature))
    .filter((gap): gap is FeatureGap => gap !== undefined)
  gaps.sort((a, b) => b.weight * b.spread - a.weight * a.spread || compareText(a.feature, b.feature))

  const anyEvidence = prepared.some((feature) => feature.evidence || feature.evidenceDate)
  if (totalFeatures > 0 && !anyEvidence) {
    warnings.push('没有任何功能行提供 evidence / evidenceDate；请补充来源和日期，否则矩阵只是一张主观打分表。')
  }
  if (totalFeatures > 0) {
    warnings.push(
      '加权总分只是讨论工具：它会隐藏权重选择和评分判断。请把权重理由、证据日期和仍不确定的地方一起展示，不要用总分替代客户访谈与赢单/输单复盘。'
    )
  }

  const lines: string[] = ['## 竞品功能矩阵', '']
  if (defined.length === 0 || totalFeatures === 0) {
    lines.push('> 没有可用的竞品或功能数据。请至少提供一个竞品和一个功能行。')
  } else {
    lines.push(
      '评分口径：0 = 无能力，1 = 只有概念/路线图，2 = 早期可用，3 = 可用但一般，4 = 强，5 = 市场最佳；权重默认 1。',
      '',
      '加权总分 = Σ(权重 × 评分) ÷ Σ(权重 × 5) × 100。'
    )
    lines.push('')

    const tableHeaders = ['功能', '权重', ...competitorNames, '领先者', '落后者', '差距']
    if (anyEvidence) tableHeaders.push('证据（日期）')
    const tableAligns: Align[] = ['left', 'right', ...competitorNames.map(() => 'right' as Align), 'left', 'left', 'right']
    if (anyEvidence) tableAligns.push('left')
    const tableRows = prepared.map((feature) => {
      const row = [
        feature.name,
        formatMatrixNumber(feature.weight),
        ...competitorNames.map((name) => {
          const score = feature.scores.get(name)
          return score === undefined ? '—' : formatMatrixNumber(score)
        })
      ]
      const gap = gapFor(feature)
      if (!gap) {
        row.push('—', '—', '—')
      } else if (gap.spread === 0) {
        row.push(`持平（${gap.leaders.join('、')}）`, '—', '0')
      } else {
        row.push(gap.leaders.join('、'), gap.laggers.join('、'), formatMatrixNumber(gap.spread))
      }
      if (anyEvidence) {
        const parts: string[] = []
        if (feature.evidence) parts.push(feature.evidence)
        if (feature.evidenceDate) parts.push(`（${feature.evidenceDate}）`)
        row.push(parts.length > 0 ? parts.join('') : '—')
      }
      return row
    })
    lines.push(markdownTable(tableHeaders, tableAligns, tableRows))
    lines.push('')

    lines.push('### 加权总分', '')
    lines.push(
      markdownTable(
        ['排名', '竞品', '加权总分 (0–100)', '已评分功能', '细分 / 定位'],
        ['right', 'left', 'right', 'right', 'left'],
        scored.map((competitor) => [
          String(competitor.rank),
          competitor.name,
          formatMatrixNumber(competitor.weightedScore),
          `${competitor.assessedFeatures}/${competitor.totalFeatures}`,
          [competitor.segment, competitor.positioning].filter(Boolean).join('；') || '—'
        ])
      )
    )
    lines.push('')

    lines.push('### 功能差距（谁领先 / 谁落后）', '')
    if (gaps.length === 0) {
      lines.push('- 没有可比较的评分。')
    } else {
      for (const gap of gaps) {
        if (gap.spread === 0) {
          lines.push(
            `- **${gap.feature}**（权重 ${formatMatrixNumber(gap.weight)}）：全部持平，均为 ${formatMatrixNumber(gap.leaderScore)} 分（${gap.assessed} 个竞品有评分）。`
          )
        } else {
          const leaders = gap.leaders.map((name) => `${name}（${formatMatrixNumber(gap.leaderScore)}）`).join('、')
          const laggers = gap.laggers.map((name) => `${name}（${formatMatrixNumber(gap.laggerScore)}）`).join('、')
          lines.push(
            `- **${gap.feature}**（权重 ${formatMatrixNumber(gap.weight)}，差距 ${formatMatrixNumber(gap.spread)}）：领先 ${leaders}；落后 ${laggers}。`
          )
        }
      }
    }
  }

  if (warnings.length > 0) {
    lines.push('', '> **注意**')
    for (const warning of warnings) lines.push(`> - ${warning}`)
  }

  return { competitors: scored, gaps, markdown: lines.join('\n'), warnings }
}

// ---------------------------------------------------------------------------
// buildBattlecard
// ---------------------------------------------------------------------------

function battlecardSectionItems(
  competitor: Competitor,
  ourProduct: ProductProfile
): Record<BattlecardSectionKey, string[]> {
  const competitorStrengths = cleanList(competitor.strengths)
  const competitorWeaknesses = cleanList(competitor.weaknesses)
  const ourStrengths = cleanList(ourProduct.strengths)
  const ourWeaknesses = cleanList(ourProduct.weaknesses)
  const proofPoints = cleanList(ourProduct.proofPoints)

  const whoTheyWinWith: string[] = []
  if (competitor.segment) whoTheyWinWith.push(`目标细分：${competitor.segment}`)
  if (competitor.positioning) whoTheyWinWith.push(`定位话术：${competitor.positioning}`)
  for (const strength of competitorStrengths) whoTheyWinWith.push(`凭${quote(strength)}赢单`)
  whoTheyWinWith.push('[待补充] 用最近 3 个赢单/输单记录验证：客户画像、决策链、采购触发事件（附日期）。')
  whoTheyWinWith.push('[待补充] 他们最常出现的场景与最不擅长的场景（附客户访谈日期）。')

  const whyWeWin: string[] = []
  if (ourProduct.positioning) whyWeWin.push(`我方定位：${ourProduct.positioning}`)
  for (const strength of ourStrengths) whyWeWin.push(`我们凭${quote(strength)}赢单`)
  for (const weakness of competitorWeaknesses) whyWeWin.push(`对手弱点${quote(weakness)}可作为切入点`)
  if (whyWeWin.length === 0) {
    whyWeWin.push('[待补充] 写出一句话价值主张：当客户 <场景> 时，我们比他们 <可验证的差异>。')
    whyWeWin.push('[待补充] 列出 2–3 个只有我们能兑现的价值，并附证据。')
  }

  const landmines: string[] = []
  for (const strength of competitorStrengths) {
    landmines.push(`不要在${quote(strength)}上正面比较；先改变评估标准，把客户拉到我们有优势的场景。`)
  }
  for (const weakness of ourWeaknesses) {
    landmines.push(`我方短板${quote(weakness)}：销售不要承诺，准备替代方案或明确的路线图日期。`)
  }
  if (landmines.length === 0) {
    landmines.push('[待补充] 标出对方最强的一两项和我们的短板；这些战场不要硬碰，先换评估维度。')
  }

  const objections: string[] = []
  for (const strength of competitorStrengths) {
    objections.push(
      `异议：“他们在${quote(strength)}上更强。” → 先确认客户的具体场景与衡量口径，再用我方证据点回应；承认对方优势，不贬低。`
    )
  }
  for (const weakness of ourWeaknesses) {
    objections.push(`异议：“你们在${quote(weakness)}上不如对方。” → 说明边界、替代方案和时间表，不做无法兑现的承诺。`)
  }
  objections.push('异议：“价格比对手贵。” → 用总拥有成本（迁移、培训、集成、风险）对比，给出可复核的 ROI 口径，不要只比单价。')
  objections.push(`异议：“${competitor.name}更成熟/风险更低。” → 承认对方优势，给出我方上线案例、SLA、服务范围与可验证指标。`)

  const proofPointItems: string[] = []
  if (proofPoints.length > 0) {
    for (const proofPoint of proofPoints) proofPointItems.push(proofPoint)
  } else {
    proofPointItems.push('[待补充] 客户案例：行业/规模/上线前后指标/日期（需客户授权引用）。')
    proofPointItems.push('[待补充] 基准测试或第三方评测：方法、样本量、结论、日期。')
    proofPointItems.push('[待补充] ROI 测算：假设、口径、敏感度分析、日期。')
  }

  const questionsToAsk = [
    `你们现在怎么解决这个问题？用了哪些工具、自建方案或外包？`,
    '这次更换/采购的触发事件是什么？希望什么时候上线？',
    '评估的硬性门槛有哪些：合规、数据驻留、集成、部署方式、预算区间？',
    '谁会参与决策，谁可能否决？他们各自最在意什么？',
    '你们如何衡量成功？现在的基线是多少？',
    '如果维持现状，成本是什么（时间、人力、错误率、机会成本）？',
    `你们看过${competitor.name}吗？他们承诺了什么（价格、合同期限、路线图、服务）？`,
    '你们最担心迁移或上线的哪一步？需要什么才能降低这个风险？'
  ]

  const recentChanges: string[] = []
  const changes = cleanList(competitor.recentChanges)
  if (changes.length > 0) {
    for (const change of changes) recentChanges.push(change)
  } else {
    recentChanges.push('[待补充] 产品发布：近 90 天的新功能、下线、定价页变化（日期 + 来源）。')
    recentChanges.push('[待补充] 定价与合同：涨价/降价、套餐调整、折扣政策（日期 + 来源）。')
    recentChanges.push('[待补充] 融资、并购、关键人事与渠道变化（日期 + 来源）。')
  }

  return {
    who_they_win_with: whoTheyWinWith,
    why_we_win: whyWeWin,
    landmines,
    objection_handling: objections,
    proof_points: proofPointItems,
    questions_to_ask: questionsToAsk,
    recent_changes: recentChanges
  }
}

const BATTLECARD_TITLES: Record<BattlecardSectionKey, string> = {
  who_they_win_with: '他们赢在哪里（Who they win with）',
  why_we_win: '我们为什么赢（Why we win）',
  landmines: '地雷（Landmines）',
  objection_handling: '异议处理（Objection handling）',
  proof_points: '证据点（Proof points）',
  questions_to_ask: '该问的问题（Questions to ask）',
  recent_changes: '近期变化（Recent changes）'
}

/**
 * 生成竞品作战卡骨架。能从输入推出的内容直接填入，推不出的部分显式写
 * `[待补充]`，避免模型用营销话术填空。
 */
export function buildBattlecard(competitor: Competitor, ourProduct: ProductProfile): BattlecardResult {
  const competitorName = competitor?.name?.trim()
  const ourName = ourProduct?.name?.trim()
  if (!competitorName) throw new Error('buildBattlecard 需要 competitor.name。')
  if (!ourName) throw new Error('buildBattlecard 需要 ourProduct.name。')

  const normalizedCompetitor: Competitor = { ...competitor, name: competitorName }
  const normalizedProduct: ProductProfile = { ...ourProduct, name: ourName }
  const items = battlecardSectionItems(normalizedCompetitor, normalizedProduct)
  const sections: BattlecardSection[] = BATTLECARD_SECTION_KEYS.map((key) => ({
    key,
    title: BATTLECARD_TITLES[key],
    items: items[key]
  }))

  const warnings: string[] = []
  if (cleanList(competitor.strengths).length === 0) {
    warnings.push(`资料不足：未提供${quote(competitorName)}的优势，请补充后再用于销售培训。`)
  }
  if (cleanList(ourProduct.strengths).length === 0) {
    warnings.push('未提供我方优势；“我们为什么赢”仍是骨架。')
  }
  if (!competitor.lastVerified?.trim()) {
    warnings.push('未提供 lastVerified：请标注资料复核日期，超过 90 天的资料应重新核对。')
  } else if (!isValidDate(competitor.lastVerified)) {
    warnings.push(`lastVerified${quote(competitor.lastVerified)}不是 YYYY-MM-DD 格式，复核日期无法机器校验。`)
  }
  if (cleanList(competitor.recentChanges).length === 0) {
    warnings.push('未提供 recentChanges：请补充近 90 天的产品、定价、融资和人事变化（附日期与来源）。')
  }
  warnings.push('作战卡是讨论底稿，不是事实清单：每条结论都要有来源和日期；禁止使用对方机密文件、窃取的报价单或未公开客户名单。')

  const meta: string[] = [`- **对手**：${competitorName}`]
  const details: string[] = []
  if (competitor.segment) details.push(`细分：${competitor.segment}`)
  if (competitor.positioning) details.push(`定位：${competitor.positioning}`)
  if (competitor.pricing) details.push(`定价：${competitor.pricing}`)
  if (details.length > 0) meta.push(`- **对手概况**：${details.join('；')}`)
  meta.push(`- **资料复核日期**：${competitor.lastVerified?.trim() || '`[待补充]`'}`)
  if (competitor.source) meta.push(`- **主要来源**：${competitor.source}`)

  const lines: string[] = [`## 竞品作战卡：${competitorName} vs ${ourName}`, '', ...meta, '']
  for (const section of sections) {
    lines.push(`### ${section.title}`, '')
    for (const item of section.items) lines.push(`- ${item}`)
    lines.push('')
  }
  lines.push('> **使用规则**：只使用公开或合法获得的资料；每条结论附来源与日期；不贬低对手，只陈述可验证事实。')

  return {
    competitor: competitorName,
    ourProduct: ourName,
    sections,
    markdown: lines.join('\n').trimEnd(),
    warnings
  }
}

// ---------------------------------------------------------------------------
// buildPricingComparison
// ---------------------------------------------------------------------------

/** 从计价单位里识别计费周期。 */
export function detectBillingPeriod(unit: string): BillingPeriod {
  const text = unit ?? ''
  if (/年|year|annual|annum|yr/i.test(text)) return 'year'
  if (/季|quarter|qtr/i.test(text)) return 'quarter'
  if (/月|month|\bmo\b/i.test(text)) return 'month'
  if (/天|day|daily/i.test(text)) return 'day'
  return 'unknown'
}

/** 从计价单位里识别计价基准。 */
export function detectPriceBasis(unit: string): PriceBasis {
  const text = unit ?? ''
  if (/调用|请求|token|用量|usage|request|\bapi\b|千次|百万次/i.test(text)) return 'usage'
  if (/席位|坐席|seat|用户|user/i.test(text)) return 'seat'
  if (/账号|账户|企业|account|company|org/i.test(text)) return 'account'
  return 'unknown'
}

/** 按周期简单折算为年价；无法识别周期时返回 undefined。 */
export function annualizePrice(price: number, unit: string): number | undefined {
  if (!Number.isFinite(price) || price < 0) return undefined
  const period = detectBillingPeriod(unit)
  if (period === 'year') return roundTo(price, 2)
  if (period === 'quarter') return roundTo(price * 4, 2)
  if (period === 'month') return roundTo(price * 12, 2)
  if (period === 'day') return roundTo(price * 365, 2)
  return undefined
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: '¥',
  RMB: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥'
}

function formatPrice(price: number, currency: string | undefined): string {
  if (!Number.isFinite(price) || price < 0) return '—'
  const amount = formatPriceNumber(price)
  const code = currency?.trim()
  if (!code) return amount
  const symbol = CURRENCY_SYMBOLS[code.toUpperCase()]
  return symbol ? `${symbol}${amount}` : `${code} ${amount}`
}

/**
 * 统一口径的定价对比。年价只是周期折算，不会替用户假设折扣、税费、
 * 实施费或最低消费——这些必须留在备注里。
 */
export function buildPricingComparison(tiers: PricingTier[]): PricingComparisonResult {
  const warnings: string[] = []
  const normalized: NormalizedPricingTier[] = []

  for (const tier of tiers ?? []) {
    const name = tier?.name?.trim()
    const vendor = tier?.vendor?.trim()
    if (!name || !vendor) {
      warnings.push('已跳过缺少方案名称或厂商的报价。')
      continue
    }
    if (typeof tier.price !== 'number' || !Number.isFinite(tier.price) || tier.price < 0) {
      warnings.push(`方案${quote(name)}的价格无效，按「—」展示。`)
    }
    const unit = tier.unit?.trim() ?? ''
    if (!unit) warnings.push(`方案${quote(name)}缺少计价单位，无法折算年价。`)
    const period = detectBillingPeriod(unit)
    const basis = detectPriceBasis(unit)
    if (unit && period === 'unknown') {
      warnings.push(`方案${quote(name)}的计价单位${quote(unit)}无法识别周期，未折算年价。`)
    }
    const annualPrice = annualizePrice(tier.price, unit)
    normalized.push({
      ...tier,
      name,
      vendor,
      unit,
      included: cleanList(tier.included),
      currency: tier.currency?.trim() || undefined,
      period,
      basis,
      annualPrice,
      entryTier: false
    })
  }

  // 每个厂商的入门档：同厂商中折算年价最低的一档；没有年价时退回最低单价。
  const byVendor = new Map<string, NormalizedPricingTier[]>()
  for (const tier of normalized) {
    const list = byVendor.get(tier.vendor) ?? []
    list.push(tier)
    byVendor.set(tier.vendor, list)
  }
  for (const vendorTiers of byVendor.values()) {
    const annualized = vendorTiers.filter((tier) => tier.annualPrice !== undefined)
    if (annualized.length > 0) {
      let min = Number.POSITIVE_INFINITY
      for (const tier of annualized) min = Math.min(min, tier.annualPrice as number)
      for (const tier of annualized) if (tier.annualPrice === min) tier.entryTier = true
    } else {
      const priced = vendorTiers.filter((tier) => Number.isFinite(tier.price) && tier.price >= 0)
      if (priced.length === 1) {
        priced[0].entryTier = true
      } else if (priced.length > 1) {
        let min = Number.POSITIVE_INFINITY
        for (const tier of priced) min = Math.min(min, tier.price)
        for (const tier of priced) if (tier.price === min) tier.entryTier = true
      }
    }
  }

  const currencies = [
    ...new Set(
      normalized
        .map((tier) => tier.currency)
        .filter((code): code is string => Boolean(code))
        .map((code) => code.toUpperCase())
    )
  ]
  if (normalized.some((tier) => !tier.currency)) {
    warnings.push('部分方案未注明币种；对比前请统一币种。')
  }
  if (currencies.length > 1) {
    warnings.push(`报价包含多种币种（${currencies.join('、')}），本表不做汇率折算，请勿直接比较数字。`)
  }
  const bases = [...new Set(normalized.map((tier) => tier.basis).filter((basis) => basis !== 'unknown'))]
  if (bases.length > 1) {
    const labels: Record<PriceBasis, string> = {
      seat: '席位',
      user: '用户',
      account: '账号',
      usage: '用量',
      unknown: '未知'
    }
    warnings.push(
      `计价基准不一致（${bases.map((basis) => labels[basis]).join('、')}混合），请先统一到同一口径再比较。`
    )
  }
  if (normalized.length > 0) {
    warnings.push('折算年价只做周期换算，不含折扣、税费、实施费、最低消费与超量费用；谈判前请用合同口径复核。')
  }

  const lines: string[] = ['## 定价对比', '']
  if (normalized.length === 0) {
    lines.push('> 没有可用的报价数据。请提供名称、厂商、价格、计价单位和包含内容。')
  } else {
    const hasNotes = normalized.some((tier) => tier.notes?.trim())
    const headers = ['方案', '厂商', '报价', '计价单位', '折算年价', '入门档', '包含内容']
    const aligns: Align[] = ['left', 'left', 'right', 'left', 'right', 'center', 'left']
    if (hasNotes) {
      headers.push('备注')
      aligns.push('left')
    }
    const rows = normalized.map((tier) => {
      const row = [
        tier.name,
        tier.vendor,
        formatPrice(tier.price, tier.currency),
        tier.unit || '—',
        tier.annualPrice === undefined ? '—' : formatPrice(tier.annualPrice, tier.currency),
        tier.entryTier ? '✓' : '',
        tier.included.length > 0 ? tier.included.join('、') : '—'
      ]
      if (hasNotes) row.push(tier.notes?.trim() || '—')
      return row
    })
    lines.push(markdownTable(headers, aligns, rows))
    lines.push('')

    lines.push('### 同厂商入门档', '')
    for (const [vendor, vendorTiers] of byVendor) {
      const entry = vendorTiers.find((tier) => tier.entryTier)
      if (!entry) {
        lines.push(`- **${vendor}**：暂无可比报价（缺少有效价格或周期）。`)
        continue
      }
      const priceText = `报价 ${formatPrice(entry.price, entry.currency)}，计价单位「${entry.unit || '未知'}」`
      const annualText = entry.annualPrice === undefined ? '年价无法折算' : `折算年价 ${formatPrice(entry.annualPrice, entry.currency)}`
      lines.push(`- **${vendor}**：${entry.name} — ${priceText}；${annualText}。`)
    }
  }

  if (warnings.length > 0) {
    lines.push('', '> **注意**')
    for (const warning of warnings) lines.push(`> - ${warning}`)
  }

  return { tiers: normalized, markdown: lines.join('\n'), warnings }
}

// ---------------------------------------------------------------------------
// buildSourceLog
// ---------------------------------------------------------------------------

function isValidDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(value.trim())
}

/**
 * 把来源记录整理成按日期倒序的台账。证据等级固定为：
 * 公开文档 > 官方定价页 > 客户访谈 > 传闻。
 */
export function buildSourceLog(entries: SourceEntry[]): SourceLogResult {
  const warnings: string[] = []
  const counts: Record<EvidenceLevel, number> = {
    public_doc: 0,
    pricing_page: 0,
    customer_interview: 0,
    rumor: 0,
    other: 0
  }
  const cleaned: SourceEntry[] = []
  for (const entry of entries ?? []) {
    const topic = entry?.topic?.trim()
    const source = entry?.source?.trim()
    if (!topic || !source) {
      warnings.push('已跳过缺少主题或来源的记录。')
      continue
    }
    const level: EvidenceLevel = Object.prototype.hasOwnProperty.call(EVIDENCE_LEVELS, entry.level)
      ? entry.level
      : 'other'
    counts[level] += 1
    const date = entry.date?.trim() ?? ''
    if (!date) {
      warnings.push(`${quote(topic)}缺少日期，证据无法复核。`)
    } else if (!isValidDate(date)) {
      warnings.push(`${quote(topic)}的日期${quote(date)}不是 YYYY-MM-DD 格式。`)
    }
    cleaned.push({
      ...entry,
      topic,
      source,
      date,
      level,
      url: entry.url?.trim() || undefined,
      note: entry.note?.trim() || undefined
    })
  }

  cleaned.sort((a, b) => {
    const byDate = compareText(b.date, a.date)
    if (byDate !== 0) return byDate
    const byRank = EVIDENCE_LEVELS[a.level].rank - EVIDENCE_LEVELS[b.level].rank
    if (byRank !== 0) return byRank
    return compareText(a.topic, b.topic)
  })

  if (counts.rumor > 0) {
    warnings.push(`有 ${counts.rumor} 条传闻级来源：只能作为待验证线索，不能写进对外材料。`)
  }
  if (cleaned.length > 0) {
    warnings.push('证据等级：公开文档 > 官方定价页 > 客户访谈 > 传闻；对外引用前请复核原始链接和日期。')
  }

  const lines: string[] = ['## 来源台账', '']
  if (cleaned.length === 0) {
    lines.push('> 还没有来源记录。每条竞品结论至少应有一条带日期的来源。')
  } else {
    lines.push(
      markdownTable(
        ['日期', '主题', '来源', '链接', '证据级别', '可信度', '备注'],
        ['left', 'left', 'left', 'left', 'left', 'left', 'left'],
        cleaned.map((entry) => [
          entry.date || '—',
          entry.topic,
          entry.source,
          entry.url ? `[链接](${entry.url})` : '—',
          EVIDENCE_LEVELS[entry.level].label,
          EVIDENCE_LEVELS[entry.level].confidence,
          entry.note || '—'
        ])
      )
    )
  }

  if (warnings.length > 0) {
    lines.push('', '> **注意**')
    for (const warning of warnings) lines.push(`> - ${warning}`)
  }

  return { entries: cleaned, markdown: lines.join('\n'), warnings, counts }
}
