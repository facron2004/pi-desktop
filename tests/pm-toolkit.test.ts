import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateIce,
  calculateMoscow,
  calculateRice,
  calculateValueEffort,
  formatScore,
  prioritize
} from '../plugins/pm-toolkit/src/frameworks'
import { funnelMetrics, sampleSizePerArm, twoProportionTest } from '../plugins/pm-toolkit/src/stats'
import { DOC_TEMPLATES, buildDoc } from '../plugins/pm-toolkit/src/templates'
import { checkDocument } from '../plugins/pm-toolkit/src/checks'
import { formatPriorityResult, formatSampleSize } from '../plugins/pm-toolkit/src/format'

test('RICE ranks by reach × impact × confidence ÷ effort', () => {
  const result = calculateRice([
    { name: 'A', reach: 1000, impact: 2, confidence: 0.8, effort: 4 },
    { name: 'B', reach: 500, impact: 3, confidence: 0.5, effort: 2 }
  ])
  assert.equal(result.ranked[0].name, 'A')
  assert.equal(result.ranked[0].score, 400)
  assert.equal(result.ranked[1].score, 375)
  assert.deepEqual(result.warnings, [])
})

test('RICE normalises confidence percentages and warns on missing inputs', () => {
  const result = calculateRice([
    { name: 'A', reach: 100, impact: 1, confidence: 80, effort: 1 },
    { name: 'B', reach: 100, impact: 1, effort: 1 }
  ])
  assert.equal(result.ranked[0].score, 80)
  assert.match(result.warnings[0], /missing reach, impact, confidence or effort/)
  assert.equal(result.ranked.length, 1)
})

test('ICE multiplies impact × confidence × ease and tolerates 0–1 scores', () => {
  const result = calculateIce([
    { name: 'A', impact: 8, confidence: 8, ease: 5 },
    { name: 'B', impact: 1, confidence: 1, ease: 1 }
  ])
  assert.equal(result.ranked.find((item) => item.name === 'A')?.score, 320)
  assert.equal(result.ranked.find((item) => item.name === 'B')?.score, 1000)
  assert.equal(result.ranked[0].name, 'B')
})

test('value × cost assigns the four quadrants', () => {
  const result = calculateValueEffort([
    { name: 'quick', value: 8, cost: 2 },
    { name: 'bet', value: 8, cost: 8 },
    { name: 'fill', value: 2, cost: 2 },
    { name: 'avoid', value: 2, cost: 8 }
  ])
  assert.equal(result.ranked.find((item) => item.name === 'quick')?.quadrant, 'Quick wins')
  assert.equal(result.ranked.find((item) => item.name === 'bet')?.quadrant, 'Strategic bets')
  assert.equal(result.ranked.find((item) => item.name === 'fill')?.quadrant, 'Fill-ins')
  assert.equal(result.ranked.find((item) => item.name === 'avoid')?.quadrant, 'Avoid')
})

test('MoSCoW groups in Must → Should → Could → Won’t order', () => {
  const result = calculateMoscow([
    { name: 'later', priority: 'could' },
    { name: 'now', priority: 'must' },
    { name: 'soon', priority: 'should' },
    { name: 'no', priority: 'wont' }
  ])
  assert.deepEqual(result.ranked.map((item) => item.name), ['now', 'soon', 'later', 'no'])
})

test('prioritize dispatches the requested method', () => {
  assert.equal(prioritize('rice', []).method, 'rice')
  assert.equal(prioritize('ice', []).method, 'ice')
  assert.equal(prioritize('moscow', []).method, 'moscow')
  assert.equal(prioritize('value_effort', []).method, 'value_effort')
  assert.equal(formatScore(400), '400')
  assert.equal(formatScore(1.2345), '1.23')
})

test('sample size grows as the minimum detectable effect shrinks', () => {
  const small = sampleSizePerArm({ baseline: 0.03, relativeMde: 0.1 })
  const large = sampleSizePerArm({ baseline: 0.03, relativeMde: 0.2 })
  assert.ok(small.perArm > 0)
  assert.ok(large.perArm > 0)
  assert.ok(large.perArm < small.perArm)
  assert.equal(small.total, small.perArm * 2)
  assert.equal(small.variant, 0.033)
  assert.ok(Math.abs(small.absoluteMde - 0.003) < 1e-12)
})

test('sample size rejects an impossible conversion target and preserves valid near-one baselines', () => {
  assert.throws(() => sampleSizePerArm({ baseline: 0.9, relativeMde: 0.5 }), /100%/)
  const result = sampleSizePerArm({ baseline: 0.9999999, relativeMde: 0.00000001 })
  assert.ok(result.variant > result.baseline)
  assert.ok(result.absoluteMde > 0)
})

test('two-proportion test detects a meaningful lift and returns an interval', () => {
  const result = twoProportionTest({
    controlVisitors: 1000,
    controlConversions: 50,
    variantVisitors: 1000,
    variantConversions: 80
  })
  assert.equal(result.controlRate, 0.05)
  assert.equal(result.variantRate, 0.08)
  assert.equal(result.significant, true)
  assert.ok(result.pValue < 0.05)
  assert.ok(result.confidenceInterval[0] > 0)
  assert.ok(result.confidenceInterval[1] > result.confidenceInterval[0])
})

test('funnel conversion reports step, overall and biggest drop', () => {
  const result = funnelMetrics([
    { name: 'visit', users: 1000 },
    { name: 'signup', users: 500 },
    { name: 'activate', users: 100 }
  ])
  assert.equal(result.steps[0].overallConversion, 1)
  assert.equal(result.steps[1].stepConversion, 0.5)
  assert.equal(result.steps[2].overallConversion, 0.1)
  assert.equal(result.biggestDrop?.name, 'activate')
  assert.equal(result.overallConversion, 0.1)
})

test('every document template builds a non-empty titled document', () => {
  for (const template of DOC_TEMPLATES) {
    const zh = buildDoc(template.kind, '测试主题')
    const en = buildDoc(template.kind, 'Test Topic', 'context', 'en')
    assert.ok(zh.trim().length > 0, template.kind)
    assert.ok(en.trim().length > 0, template.kind)
    assert.match(zh, /测试主题/)
    assert.match(en, /Test Topic/)
  }
  assert.match(buildDoc('prd', '退款'), /Non-goals|明确不做/)
  assert.match(buildDoc('user_story', '退款'), /Given/)
  assert.match(buildDoc('launch_checklist', '退款'), /回滚|rollback/i)
})

test('document checks catch missing sections and accept a strong PRD', () => {
  const strong = buildDoc('prd', '退款审批体验')
  assert.equal(checkDocument('prd', strong).ok, true)
  const weak = checkDocument('prd', '# 需求\n做一个更好的退款体验。')
  assert.equal(weak.ok, false)
  assert.ok(weak.issues.some((issue) => issue.severity === 'error'))
  assert.ok(weak.issues.some((issue) => issue.message.includes('acceptance')))
})

test('formatters produce readable Markdown', () => {
  const priority = formatPriorityResult(
    calculateRice([{ name: 'A', reach: 100, impact: 1, confidence: 1, effort: 1 }])
  )
  assert.match(priority, /RICE 优先级/)
  assert.match(priority, /\| 排名 \| 功能 \|/)
  const sample = formatSampleSize(sampleSizePerArm({ baseline: 0.05, relativeMde: 0.1 }))
  assert.match(sample, /A\/B 实验样本量/)
  assert.match(sample, /每组样本/)
})
