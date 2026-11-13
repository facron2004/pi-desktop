import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PRICING_CHECKLIST,
  VALUE_METRIC_WEIGHTS,
  buildPricingReport,
  formatTierMatrix,
  formatValueMetrics,
  formatVanWestendorp,
  migrationQuestions,
  tierMatrix,
  valueMetricCandidates,
  vanWestendorp,
  type TierInput,
  type ValueMetricCandidate,
  type VanWestendorpResponse
} from '../plugins/pm-pricing/src/pricing'

/**
 * Ten consistent responses spread evenly across the four questions. The
 * quartiles are clean and the four crossings all have a single interpolation
 * interval, which makes the arithmetic easy to verify by hand.
 */
const RESPONSES: VanWestendorpResponse[] = [
  { tooCheap: 5, cheap: 15, expensive: 35, tooExpensive: 55 },
  { tooCheap: 10, cheap: 20, expensive: 40, tooExpensive: 60 },
  { tooCheap: 15, cheap: 25, expensive: 45, tooExpensive: 65 },
  { tooCheap: 20, cheap: 30, expensive: 50, tooExpensive: 70 },
  { tooCheap: 25, cheap: 35, expensive: 55, tooExpensive: 75 },
  { tooCheap: 30, cheap: 40, expensive: 60, tooExpensive: 80 },
  { tooCheap: 35, cheap: 45, expensive: 65, tooExpensive: 85 },
  { tooCheap: 40, cheap: 50, expensive: 70, tooExpensive: 90 },
  { tooCheap: 45, cheap: 55, expensive: 75, tooExpensive: 95 },
  { tooCheap: 50, cheap: 60, expensive: 80, tooExpensive: 100 }
]

const TIERS: TierInput[] = [
  {
    name: 'Starter',
    price: 10,
    billing: 'per month',
    features: ['Dashboard', 'Projects'],
    limits: { seats: '3', storage: '5 GB' }
  },
  {
    name: 'Pro',
    price: 30,
    billing: 'per month',
    features: ['Dashboard', 'Projects', 'SSO'],
    limits: { seats: '20', storage: '100 GB' }
  },
  {
    name: 'Enterprise',
    price: 100,
    billing: 'per month',
    features: ['Dashboard', 'Projects', 'SSO', 'Audit log', 'SLA'],
    limits: { seats: 'Unlimited', storage: '1 TB' }
  }
]

const METRICS: ValueMetricCandidate[] = [
  { name: 'Per seat', alignment: 3, scalability: 4, predictability: 5, fairness: 4, measurability: 5, unit: 'per seat / month' },
  { name: 'API calls', alignment: 5, scalability: 5, predictability: 2, fairness: 2, measurability: 4, unit: 'per 1,000 calls' },
  { name: 'Outcome fee', alignment: 5, scalability: 3, predictability: 1, fairness: 3, measurability: 2, unit: 'per resolved ticket' }
]

test('Van Westendorp reports medians and quartiles for all four questions', () => {
  const result = vanWestendorp(RESPONSES, { currency: '¥' })
  assert.equal(result.sampleCount, 10)
  assert.equal(result.usableCount, 10)
  assert.equal(result.excludedCount, 0)
  assert.equal(result.stats.tooCheap?.median, 27.5)
  assert.equal(result.stats.cheap?.median, 37.5)
  assert.equal(result.stats.expensive?.median, 57.5)
  assert.equal(result.stats.tooExpensive?.median, 77.5)
  assert.equal(result.stats.tooCheap?.p25, 16.25)
  assert.equal(result.stats.expensive?.p75, 68.75)
  assert.equal(result.stats.tooCheap?.count, 10)
})

test('Van Westendorp crossings are interpolated and ordered PMC < IPP < OPP < PME', () => {
  const result = vanWestendorp(RESPONSES)
  assert.ok(result.pointOfMarginalCheapness)
  assert.ok(result.pointOfMarginalExpensiveness)
  assert.ok(result.optimalPricePoint)
  assert.ok(result.indifferencePricePoint)
  assert.equal(result.pointOfMarginalCheapness?.price, 42.5)
  assert.equal(result.indifferencePricePoint?.price, 47.5)
  assert.equal(result.optimalPricePoint?.price, 52.5)
  assert.equal(result.pointOfMarginalExpensiveness?.price, 57.5)
  assert.deepEqual(result.acceptableRange, { low: 42.5, high: 57.5, source: 'crossings' })
  assert.ok(result.curve.length >= 4)
  assert.ok(result.curve.every((point) => point.tooCheap >= 0 && point.tooCheap <= 1))
})

test('Van Westendorp excludes inconsistent respondents and warns about the sample', () => {
  const inconsistent = [
    ...RESPONSES.slice(0, 2),
    { tooCheap: 100, cheap: 80, expensive: 90, tooExpensive: 120 }
  ] as VanWestendorpResponse[]
  const result = vanWestendorp(inconsistent)
  assert.equal(result.sampleCount, 3)
  assert.equal(result.usableCount, 2)
  assert.equal(result.excludedCount, 1)
  assert.ok(result.warnings.some((warning) => /inconsistent/i.test(warning)))
  assert.ok(result.warnings.some((warning) => /Only 2 usable responses/.test(warning)))
})

test('Van Westendorp rejects non-positive prices and handles an empty sample', () => {
  const invalid = [{ tooCheap: 0, cheap: 10, expensive: 20, tooExpensive: 30 }] as VanWestendorpResponse[]
  const invalidResult = vanWestendorp(invalid)
  assert.equal(invalidResult.usableCount, 0)
  assert.equal(invalidResult.stats.tooCheap, null)
  assert.ok(invalidResult.warnings.some((warning) => /positive finite numbers/.test(warning)))

  const empty = vanWestendorp([])
  assert.equal(empty.sampleCount, 0)
  assert.equal(empty.usableCount, 0)
  assert.equal(empty.acceptableRange, null)
  assert.deepEqual(empty.curve, [])
  assert.ok(empty.warnings.some((warning) => /Not enough usable responses/.test(warning)))
})

test('small representative-ish samples keep the directional warning', () => {
  const result = vanWestendorp(RESPONSES.slice(0, 5))
  assert.ok(result.warnings.some((warning) => /directional at this sample size/.test(warning)))
  assert.ok(result.acceptableRange)
})

test('tier matrix flags features present in every tier and features unique to one tier', () => {
  const result = tierMatrix(TIERS)
  assert.deepEqual(result.sharedFeatures, ['Dashboard', 'Projects'])
  assert.deepEqual(result.uniqueFeatures, [
    { feature: 'Audit log', tier: 'Enterprise' },
    { feature: 'SLA', tier: 'Enterprise' }
  ])
  const sso = result.features.find((feature) => feature.name === 'SSO')
  assert.deepEqual(sso?.presence, [false, true, true])
  assert.equal(sso?.count, 2)
  assert.equal(sso?.inAllTiers, false)
  assert.equal(sso?.uniqueTo, null)
  const dashboard = result.features.find((feature) => feature.name === 'Dashboard')
  assert.equal(dashboard?.inAllTiers, true)
  assert.deepEqual(result.limitKeys, ['seats', 'storage'])
  assert.equal(result.tiers[2].limits.seats, 'Unlimited')
})

test('tier matrix warns about a lineup with no differentiators and duplicate features', () => {
  const result = tierMatrix([
    { name: 'Basic', price: 10, billing: 'per month', features: ['Dashboard', 'Dashboard'] },
    { name: 'Pro', price: 20, billing: 'per month', features: ['Dashboard'] }
  ])
  assert.ok(result.warnings.some((warning) => /lists "Dashboard" more than once/.test(warning)))
  assert.ok(result.warnings.some((warning) => /differ only on price or limits/.test(warning)))
  assert.deepEqual(result.sharedFeatures, ['Dashboard'])
  assert.deepEqual(result.uniqueFeatures, [])
})

test('value metric ranking is deterministic and respects the weights', () => {
  const result = valueMetricCandidates(METRICS)
  assert.deepEqual(
    result.ranked.map((metric) => metric.name),
    ['Per seat', 'API calls', 'Outcome fee']
  )
  assert.equal(result.recommended, 'Per seat')
  assert.equal(result.ranked[0].score, 4.05)
  assert.equal(result.ranked[1].score, 3.8)
  assert.equal(result.ranked[2].score, 3.05)
  const totalWeight = Object.values(VALUE_METRIC_WEIGHTS).reduce((sum, weight) => sum + weight, 0)
  assert.ok(Math.abs(totalWeight - 1) < 1e-12)
  assert.equal(result.weights.alignment, 0.3)
  assert.ok(result.ranked[0].strengths.includes('predictability'))
  assert.ok(result.ranked[2].risks.includes('measurability'))
})

test('value metric ties break alphabetically and the 0–10 scale is normalised', () => {
  const tied = valueMetricCandidates([
    { name: 'Beta', alignment: 3, scalability: 3, predictability: 3, fairness: 3, measurability: 3 },
    { name: 'Alpha', alignment: 3, scalability: 3, predictability: 3, fairness: 3, measurability: 3 }
  ])
  assert.deepEqual(
    tied.ranked.map((metric) => metric.name),
    ['Alpha', 'Beta']
  )

  const tenScale = valueMetricCandidates([
    { name: 'Calls', alignment: 10, scalability: 8, predictability: 6, fairness: 4, measurability: 2 }
  ])
  assert.equal(tenScale.ranked[0].scores.alignment, 5)
  assert.equal(tenScale.ranked[0].scores.scalability, 4)
  assert.equal(tenScale.ranked[0].scores.measurability, 1)
  assert.equal(tenScale.ranked[0].score, 3.35)
})

test('value metric warns about missing and out-of-range scores', () => {
  const result = valueMetricCandidates([
    {
      name: 'Usage',
      alignment: 12,
      scalability: 4,
      predictability: 4,
      fairness: 4,
      measurability: undefined as unknown as number
    }
  ])
  assert.ok(result.warnings.some((warning) => /outside 0–10/.test(warning)))
  assert.ok(result.warnings.some((warning) => /missing measurability/.test(warning)))
  assert.equal(result.ranked[0].scores.measurability, 0)
})

test('formatters render readable Markdown sections', () => {
  const vw = formatVanWestendorp(vanWestendorp(RESPONSES, { currency: '¥' }), 'en')
  assert.match(vw, /## Van Westendorp price sensitivity/)
  assert.match(vw, /Optimal price point \(OPP\)/)
  assert.match(vw, /directional, not a demand curve/)

  const matrix = formatTierMatrix(tierMatrix(TIERS), 'en')
  assert.match(matrix, /## Packaging and tier matrix/)
  assert.match(matrix, /\| Dashboard \| ✓ \| ✓ \| ✓ \|/)

  const metrics = formatValueMetrics(valueMetricCandidates(METRICS), 'en')
  assert.match(metrics, /## Value-metric assessment/)
  assert.match(metrics, /\*\*Recommended: Per seat\*\*/)
})

test('buildPricingReport contains every required section and migration questions', () => {
  const report = buildPricingReport({
    product: 'Acme Team',
    segment: 'Small teams',
    currency: '¥',
    vanWestendorp: vanWestendorp(RESPONSES, { currency: '¥' }),
    tierMatrix: tierMatrix(TIERS),
    valueMetrics: valueMetricCandidates(METRICS),
    language: 'en'
  })
  assert.match(report, /^# Pricing and packaging report — Acme Team/)
  assert.match(report, /## 1\. Van Westendorp price sensitivity/)
  assert.match(report, /## 2\. Packaging and tier matrix/)
  assert.match(report, /## 3\. Value-metric guidance/)
  assert.match(report, /## 4\. Migration and rollback questions/)
  assert.match(report, /## 5\. Before you ship/)
  assert.match(report, /grandfathering/i)
  assert.match(report, /rollback plan/i)
  assert.equal(migrationQuestions('en').length, 8)
  assert.equal(migrationQuestions('zh-CN').length, 8)
  assert.equal(PRICING_CHECKLIST.en.length, 7)
  assert.equal(PRICING_CHECKLIST['zh-CN'].length, 7)
})

test('buildPricingReport states missing evidence instead of silently omitting it', () => {
  const report = buildPricingReport({ language: 'en' })
  assert.match(report, /No analysis data was supplied yet/)
  assert.equal((report.match(/Not supplied\./g) ?? []).length, 3)
  assert.match(report, /## 4\. Migration and rollback questions/)

  const zh = buildPricingReport({ language: 'zh-CN' })
  assert.match(zh, /# 定价与包装报告/)
  assert.match(zh, /尚未提供分析数据/)
})

test('all pure functions are deterministic', () => {
  const firstVw = vanWestendorp(RESPONSES)
  const secondVw = vanWestendorp(RESPONSES)
  assert.deepEqual(firstVw, secondVw)

  const firstTiers = tierMatrix(TIERS)
  assert.deepEqual(firstTiers, tierMatrix(TIERS))

  const input: ValueMetricCandidate[] = [...METRICS]
  assert.deepEqual(valueMetricCandidates(input), valueMetricCandidates(input))

  const makeReport = (): string =>
    buildPricingReport({
      product: 'Acme',
      vanWestendorp: firstVw,
      tierMatrix: firstTiers,
      valueMetrics: valueMetricCandidates(METRICS),
      language: 'en'
    })
  assert.equal(makeReport(), makeReport())
})
