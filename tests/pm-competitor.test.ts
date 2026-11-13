import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BATTLECARD_SECTION_KEYS,
  EVIDENCE_LEVELS,
  buildBattlecard,
  buildMatrix,
  buildPricingComparison,
  buildSourceLog,
  detectBillingPeriod,
  detectPriceBasis,
  annualizePrice,
  formatMatrixNumber
} from '../plugins/pm-competitor/src/matrix'
import {
  COMPETITOR_POLICY,
  COMPETITOR_POLICY_MARKER,
  shouldApplyCompetitorPolicy
} from '../plugins/pm-competitor/src/policy'
import registerPmCompetitor from '../plugins/pm-competitor/extensions/pm-competitor'

const competitors = [
  { name: '竞品A', segment: '中小企业', positioning: '低价快上线' },
  { name: '竞品B', segment: '大型企业', positioning: '合规与集成' }
]

test('weighted matrix normalises scores to 0–100 and ranks competitors', () => {
  const result = buildMatrix(competitors, [
    { name: '实时报表', weight: 2, scores: { 竞品A: 5, 竞品B: 3 } },
    { name: '单点登录', weight: 1, scores: { 竞品A: 3, 竞品B: 5 } }
  ])
  assert.equal(result.competitors[0].name, '竞品A')
  assert.equal(result.competitors[0].weightedScore, 86.7)
  assert.equal(result.competitors[0].rank, 1)
  assert.equal(result.competitors[0].rawPoints, 13)
  assert.equal(result.competitors[0].maxPoints, 15)
  assert.equal(result.competitors[1].weightedScore, 73.3)
  assert.equal(result.competitors[1].rank, 2)
  assert.deepEqual(result.warnings.filter((warning) => /错误|无效|跳过/.test(warning)), [])
})

test('weights change the ranking rather than being decorative', () => {
  const result = buildMatrix(competitors, [
    { name: 'AI 能力', weight: 5, scores: { 竞品A: 0, 竞品B: 5 } },
    { name: '本地部署', weight: 1, scores: { 竞品A: 5, 竞品B: 0 } }
  ])
  assert.equal(result.competitors.find((item) => item.name === '竞品B')?.weightedScore, 83.3)
  assert.equal(result.competitors.find((item) => item.name === '竞品A')?.weightedScore, 16.7)
})

test('tied features report every leader and lagger, and tied totals share a rank', () => {
  const result = buildMatrix(
    [...competitors, { name: '竞品C' }],
    [
      { name: '全部持平', scores: { 竞品A: 4, 竞品B: 4, 竞品C: 4 } },
      { name: '两强并列', weight: 2, scores: { 竞品A: 5, 竞品B: 4, 竞品C: 4 } }
    ]
  )
  const allTied = result.gaps.find((gap) => gap.feature === '全部持平')
  assert.deepEqual(allTied?.leaders, ['竞品A', '竞品B', '竞品C'])
  assert.deepEqual(allTied?.laggers, ['竞品A', '竞品B', '竞品C'])
  assert.equal(allTied?.spread, 0)
  const twoWayTie = result.gaps.find((gap) => gap.feature === '两强并列')
  assert.deepEqual(twoWayTie?.leaders, ['竞品A'])
  assert.deepEqual(twoWayTie?.laggers, ['竞品B', '竞品C'])
  // 竞品B 和 竞品C 分数完全相同，应共享名次。
  const b = result.competitors.find((item) => item.name === '竞品B')
  const c = result.competitors.find((item) => item.name === '竞品C')
  assert.equal(b?.weightedScore, c?.weightedScore)
  assert.equal(b?.rank, c?.rank)
})

test('missing scores and unknown competitors are surfaced instead of silently invented', () => {
  const result = buildMatrix(
    [{ name: '竞品A' }, { name: '竞品B' }],
    [{ name: '报表', weight: 1, scores: { 竞品A: 4, 不存在的竞品: 5 } }]
  )
  assert.equal(result.competitors.find((item) => item.name === '竞品A')?.weightedScore, 80)
  assert.equal(result.competitors.find((item) => item.name === '竞品B')?.weightedScore, 0)
  assert.ok(result.warnings.some((warning) => /不在竞品清单/.test(warning)))
  assert.ok(result.warnings.some((warning) => /未评分，按 0 分计入/.test(warning)))
  assert.ok(result.warnings.some((warning) => /加权总分只是讨论工具/.test(warning)))
})

test('matrix rejects invalid weights, out-of-range scores and duplicate competitors with warnings', () => {
  const result = buildMatrix(
    [{ name: '竞品A' }, { name: '竞品A', segment: '重复' }],
    [
      { name: '功能1', weight: 0, scores: { 竞品A: 7 } },
      { name: '功能2', weight: Number.NaN, scores: { 竞品A: 3 } }
    ]
  )
  assert.equal(result.competitors.length, 1)
  assert.ok(result.warnings.some((warning) => /重复出现/.test(warning)))
  assert.ok(result.warnings.some((warning) => /权重无效/.test(warning)))
  assert.ok(result.warnings.some((warning) => /超出 0–5/.test(warning)))
  // 功能1 权重按 1、评分按 5；功能2 权重按 1、评分 3 → 8/10 = 80
  assert.equal(result.competitors[0].weightedScore, 80)
})

test('matrix markdown includes a readable table, gap bullets and evidence dates', () => {
  const result = buildMatrix(competitors, [
    {
      name: '实时报表',
      weight: 3,
      scores: { 竞品A: 4, 竞品B: 2 },
      evidence: '官网文档 + 客户访谈',
      evidenceDate: '2026-03-01'
    },
    { name: '本地部署', weight: 1, scores: { 竞品A: 1, 竞品B: 5 }, evidence: '官方定价页', evidenceDate: '2026-02-20' }
  ])
  assert.match(result.markdown, /## 竞品功能矩阵/)
  assert.match(result.markdown, /\| 功能 \| 权重 \| 竞品A \| 竞品B \| 领先者 \| 落后者 \| 差距 \| 证据（日期） \|/)
  assert.match(result.markdown, /官网文档 \+ 客户访谈（2026-03-01）/)
  assert.match(result.markdown, /### 加权总分/)
  assert.match(result.markdown, /### 功能差距（谁领先 \/ 谁落后）/)
  assert.match(result.markdown, /领先 竞品A（4）；落后 竞品B（2）/)
  assert.match(result.markdown, /> \*\*注意\*\*/)
})

test('matrix marks every feature as tied when only one competitor is assessed', () => {
  const result = buildMatrix([{ name: '竞品A' }], [{ name: '功能', scores: { 竞品A: 3 } }])
  const gap = result.gaps[0]
  assert.deepEqual(gap.leaders, ['竞品A'])
  assert.deepEqual(gap.laggers, ['竞品A'])
  assert.equal(gap.spread, 0)
  assert.match(result.markdown, /全部持平，均为 3 分/)
})

test('battlecard contains all seven required sections and uses supplied evidence', () => {
  const result = buildBattlecard(
    {
      name: '竞品B',
      segment: '大型企业',
      positioning: '合规与集成',
      pricing: '年付 10 万起',
      strengths: ['私有化部署', '审计日志'],
      weaknesses: ['实施周期长'],
      recentChanges: ['2026-02 发布审计 2.0'],
      lastVerified: '2026-03-01',
      source: '官网 + 定价页'
    },
    {
      name: '我方产品',
      positioning: '一周上线',
      strengths: ['快速开通', '按量计费'],
      weaknesses: ['私有化版本滞后'],
      proofPoints: ['某零售客户 7 天上线，转化率 +12%（2026-01，客户授权）']
    }
  )
  assert.deepEqual(
    result.sections.map((section) => section.key),
    BATTLECARD_SECTION_KEYS
  )
  assert.equal(result.sections.length, 7)
  for (const section of result.sections) {
    assert.ok(section.title.length > 0, section.key)
    assert.ok(section.items.length > 0, section.key)
  }
  assert.match(result.markdown, /## 竞品作战卡：竞品B vs 我方产品/)
  assert.match(result.markdown, /### 他们赢在哪里/)
  assert.match(result.markdown, /### 我们为什么赢/)
  assert.match(result.markdown, /### 地雷/)
  assert.match(result.markdown, /### 异议处理/)
  assert.match(result.markdown, /### 证据点/)
  assert.match(result.markdown, /### 该问的问题/)
  assert.match(result.markdown, /### 近期变化/)
  const who = result.sections.find((section) => section.key === 'who_they_win_with')
  assert.ok(who?.items.some((item) => item.includes('大型企业')))
  assert.ok(who?.items.some((item) => item.includes('私有化部署')))
  const changes = result.sections.find((section) => section.key === 'recent_changes')
  assert.deepEqual(changes?.items, ['2026-02 发布审计 2.0'])
  assert.ok(!result.warnings.some((warning) => /未提供 recentChanges/.test(warning)))
})

test('battlecard keeps honest placeholders and warnings when evidence is thin', () => {
  const result = buildBattlecard({ name: '竞品B' }, { name: '我方产品' })
  assert.equal(result.sections.length, 7)
  assert.ok(result.markdown.includes('[待补充]'))
  assert.ok(result.warnings.some((warning) => /资料不足/.test(warning)))
  assert.ok(result.warnings.some((warning) => /lastVerified/.test(warning)))
  assert.ok(result.warnings.some((warning) => /recentChanges/.test(warning)))
  assert.ok(result.warnings.some((warning) => /禁止使用对方机密文件/.test(warning)))
})

test('pricing comparison annualises by period and marks each vendor entry tier', () => {
  const result = buildPricingComparison([
    { name: 'Starter', vendor: 'Acme', price: 99, unit: '¥/席位/月', included: ['基础报表'], currency: 'CNY' },
    { name: 'Pro', vendor: 'Acme', price: 199, unit: '¥/席位/月', included: ['基础报表', 'API'], currency: 'CNY' },
    { name: 'Enterprise', vendor: 'Beta', price: 1200, unit: '元/账号/年', included: ['全部功能'], currency: 'CNY' }
  ])
  const starter = result.tiers.find((tier) => tier.name === 'Starter')
  const pro = result.tiers.find((tier) => tier.name === 'Pro')
  const enterprise = result.tiers.find((tier) => tier.name === 'Enterprise')
  assert.equal(starter?.annualPrice, 1188)
  assert.equal(pro?.annualPrice, 2388)
  assert.equal(enterprise?.annualPrice, 1200)
  assert.equal(starter?.entryTier, true)
  assert.equal(pro?.entryTier, false)
  assert.equal(enterprise?.entryTier, true)
  assert.match(result.markdown, /\| 方案 \| 厂商 \| 报价 \| 计价单位 \| 折算年价 \| 入门档 \| 包含内容 \|/)
  assert.match(result.markdown, /¥1188/)
  assert.match(result.markdown, /### 同厂商入门档/)
  assert.ok(result.warnings.some((warning) => /折扣、税费、实施费/.test(warning)))
})

test('pricing comparison flags mixed currencies, mixed bases and unknown periods', () => {
  const result = buildPricingComparison([
    { name: 'Global', vendor: 'Acme', price: 10, unit: 'USD/seat/month', included: [], currency: 'USD' },
    { name: 'CN', vendor: 'Beta', price: 1000, unit: '元/账号/年', included: [], currency: 'CNY' },
    { name: 'Usage', vendor: 'Gamma', price: 2, unit: '元/千次调用', included: [] }
  ])
  assert.ok(result.warnings.some((warning) => /多种币种/.test(warning)))
  assert.ok(result.warnings.some((warning) => /计价基准不一致/.test(warning)))
  assert.ok(result.warnings.some((warning) => /无法识别周期/.test(warning)))
  assert.ok(result.warnings.some((warning) => /未注明币种/.test(warning)))
})

test('period detection and annualisation are explicit and testable', () => {
  assert.equal(detectBillingPeriod('¥/席位/月'), 'month')
  assert.equal(detectBillingPeriod('元/账号/年'), 'year')
  assert.equal(detectBillingPeriod('USD per quarter'), 'quarter')
  assert.equal(detectBillingPeriod('per day'), 'day')
  assert.equal(detectBillingPeriod('千次调用'), 'unknown')
  assert.equal(detectPriceBasis('¥/席位/月'), 'seat')
  assert.equal(detectPriceBasis('元/账号/年'), 'account')
  assert.equal(detectPriceBasis('元/千次调用'), 'usage')
  assert.equal(annualizePrice(99, '¥/席位/月'), 1188)
  assert.equal(annualizePrice(1200, '元/账号/年'), 1200)
  assert.equal(annualizePrice(10, '千次调用'), undefined)
})

test('source log sorts by date, counts evidence levels and warns on rumours', () => {
  const result = buildSourceLog([
    { topic: '定价', source: '官网定价页', url: 'https://example.com/pricing', date: '2026-03-01', level: 'pricing_page' },
    { topic: '功能', source: '帮助中心', date: '2026-02-01', level: 'public_doc' },
    { topic: '组织变化', source: '销售口述', date: '2026-03-05', level: 'rumor' }
  ])
  assert.deepEqual(result.entries.map((entry) => entry.topic), ['组织变化', '定价', '功能'])
  assert.equal(result.counts.rumor, 1)
  assert.equal(result.counts.public_doc, 1)
  assert.equal(result.counts.pricing_page, 1)
  assert.ok(result.warnings.some((warning) => /传闻级来源/.test(warning)))
  assert.match(result.markdown, /\| 日期 \| 主题 \| 来源 \| 链接 \| 证据级别 \| 可信度 \| 备注 \|/)
  assert.match(result.markdown, /公开文档/)
  assert.match(result.markdown, /\[链接\]\(https:\/\/example\.com\/pricing\)/)
})

test('source log warns about missing and malformed dates', () => {
  const result = buildSourceLog([
    { topic: '无日期', source: '官网', date: '', level: 'public_doc' },
    { topic: '坏日期', source: '评测', date: '2026/03/01', level: 'other' }
  ])
  assert.ok(result.warnings.some((warning) => /缺少日期/.test(warning)))
  assert.ok(result.warnings.some((warning) => /YYYY-MM-DD/.test(warning)))
  assert.equal(result.entries.length, 2)
})

test('all builders are deterministic for identical input', () => {
  const matrixInput = [
    { name: 'A', scores: { A: 4, B: 2 } },
    { name: 'B', scores: { A: 3, B: 5 } }
  ]
  assert.deepEqual(buildMatrix(competitors, matrixInput), buildMatrix(competitors, matrixInput))
  assert.deepEqual(
    buildBattlecard({ name: 'B', strengths: ['x'] }, { name: 'Us', strengths: ['y'] }),
    buildBattlecard({ name: 'B', strengths: ['x'] }, { name: 'Us', strengths: ['y'] })
  )
  const pricing = [{ name: 'S', vendor: 'V', price: 10, unit: '¥/月', included: ['x'], currency: 'CNY' }]
  assert.deepEqual(buildPricingComparison(pricing), buildPricingComparison(pricing))
  const sources = [{ topic: 'T', source: 'S', date: '2026-01-01', level: 'public_doc' as const }]
  assert.deepEqual(buildSourceLog(sources), buildSourceLog(sources))
})

test('policy triggers on Chinese and English competitor prompts but not on unrelated ones', () => {
  assert.equal(shouldApplyCompetitorPolicy('帮我做一份竞品分析', ''), true)
  assert.equal(shouldApplyCompetitorPolicy('分析一下竞争对手的定价', ''), true)
  assert.equal(shouldApplyCompetitorPolicy('Build a battlecard for Acme', ''), true)
  assert.equal(shouldApplyCompetitorPolicy('pricing comparison for our SaaS', ''), true)
  assert.equal(shouldApplyCompetitorPolicy('今天天气怎么样', ''), false)
  assert.equal(shouldApplyCompetitorPolicy('帮我写个 PRD', ''), false)
  assert.equal(shouldApplyCompetitorPolicy('竞品分析', `prefix ${COMPETITOR_POLICY_MARKER} suffix`), false)
  assert.ok(COMPETITOR_POLICY.includes(COMPETITOR_POLICY_MARKER))
  assert.match(COMPETITOR_POLICY, /公开文档 > 官方定价页 > 客户访谈 > 传闻/)
})

test('evidence levels keep the documented order and human labels', () => {
  assert.equal(EVIDENCE_LEVELS.public_doc.rank, 1)
  assert.equal(EVIDENCE_LEVELS.pricing_page.rank, 2)
  assert.equal(EVIDENCE_LEVELS.customer_interview.rank, 3)
  assert.equal(EVIDENCE_LEVELS.rumor.rank, 4)
  assert.equal(EVIDENCE_LEVELS.public_doc.label, '公开文档')
  assert.equal(formatMatrixNumber(86.66), '86.7')
  assert.equal(formatMatrixNumber(100), '100')
})

test('empty matrix input produces a clear message instead of crashing', () => {
  const result = buildMatrix([], [])
  assert.equal(result.competitors.length, 0)
  assert.equal(result.gaps.length, 0)
  assert.match(result.markdown, /没有可用的竞品或功能数据/)
})

test('extension registers the tool, the /competitor command and the before_agent_start policy', async () => {
  const tools: Array<Record<string, unknown>> = []
  const commands: Array<{ name: string }> = []
  const handlers: Array<{ event: string; handler: (event: unknown) => Promise<unknown> }> = []
  const mockPi = {
    registerTool(tool: Record<string, unknown>) {
      tools.push(tool)
    },
    registerCommand(name: string) {
      commands.push({ name })
    },
    on(event: string, handler: (event: unknown) => Promise<unknown>) {
      handlers.push({ event, handler })
    },
    sendUserMessage() {}
  }
  registerPmCompetitor(mockPi as unknown as Parameters<typeof registerPmCompetitor>[0])
  assert.equal(tools.length, 1)
  assert.equal(tools[0]?.name, 'pm_competitor')
  assert.deepEqual(commands.map((command) => command.name), ['competitor'])
  assert.deepEqual(handlers.map((entry) => entry.event), ['before_agent_start'])

  const execute = tools[0]?.execute as (
    id: string,
    params: Record<string, unknown>
  ) => Promise<{ content: Array<{ text: string }> }>
  const matrix = await execute('call-1', {
    action: 'matrix',
    competitors: [{ name: '竞品A' }, { name: '竞品B' }],
    features: [{ name: '报表', weight: 2, scores: { 竞品A: 5, 竞品B: 3 } }]
  })
  assert.match(matrix.content[0].text, /## 竞品功能矩阵/)

  const injected = (await handlers[0].handler({ messageType: 'user', prompt: '做个竞品分析', systemPrompt: 'base' })) as {
    systemPrompt?: string
  }
  assert.ok(injected.systemPrompt?.includes(COMPETITOR_POLICY_MARKER))
  const skipped = await handlers[0].handler({ messageType: 'user', prompt: '今天天气怎么样', systemPrompt: 'base' })
  assert.equal(skipped, undefined)
})
