/**
 * Pricing and packaging analysis for product managers.
 *
 * Everything in this module is pure and deterministic: no Pi imports, no
 * network calls, no hidden model calls. The extension only formats these
 * results; the product judgement stays with the model and the PM.
 *
 * Van Westendorp is deliberately treated as a directional tool. The
 * implementation uses cumulative curves over a sorted price grid and linearly
 * interpolates crossings between adjacent observed prices. That is a
 * defensible simple method, not a demand model: it must not be read as a
 * precise optimal price. The report states this caveat every time.
 */

export type OutputLanguage = 'zh-CN' | 'en'

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function positiveNumber(value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number !== undefined && number > 0 ? number : undefined
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

/** Linear-interpolated percentile (the same R-7 convention spreadsheets use). */
function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN
  if (sorted.length === 1) return sorted[0]
  const rank = (sorted.length - 1) * clamp(fraction, 0, 1)
  const lowerIndex = Math.floor(rank)
  const upperIndex = Math.ceil(rank)
  const lower = sorted[lowerIndex]
  const upper = sorted[upperIndex]
  if (lowerIndex === upperIndex) return lower
  return lower + (upper - lower) * (rank - lowerIndex)
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

/** Format a number for Markdown without trailing zeros or fake precision. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return Number.isInteger(value) ? String(value) : String(roundTo(value, 2))
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function pick<T>(language: OutputLanguage, en: T, zh: T): T {
  return language === 'en' ? en : zh
}

/** Prefix a price with a currency when one is supplied (`¥`, `USD`, ...). */
function money(value: number, currency?: string): string {
  const text = formatNumber(value)
  if (!currency) return text
  return /^[A-Za-z]{2,}$/.test(currency) ? `${currency} ${text}` : `${currency}${text}`
}

function markdownTable(headers: string[], rows: string[][]): string {
  const escape = (cell: string): string => cell.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  return [
    `| ${headers.map(escape).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escape).join(' | ')} |`)
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Van Westendorp Price Sensitivity Meter
// ---------------------------------------------------------------------------

export interface VanWestendorpResponse {
  /** Price so low the buyer would question quality. */
  tooCheap: number
  /** Price that feels like a bargain — a great buy for the money. */
  cheap: number
  /** Price that starts to feel expensive but is still worth considering. */
  expensive: number
  /** Price so high the buyer would not consider the product. */
  tooExpensive: number
}

export type VanWestendorpQuestion = 'tooCheap' | 'cheap' | 'expensive' | 'tooExpensive'

export interface PercentileSummary {
  count: number
  min: number
  p25: number
  median: number
  p75: number
  max: number
}

export interface VanWestendorpCurvePoint {
  price: number
  /** Share of usable respondents who call this price too cheap (0–1). */
  tooCheap: number
  /** Share who see this price as a bargain (0–1). */
  bargain: number
  /** Share who call this price expensive but acceptable (0–1). */
  expensive: number
  /** Share who call this price too expensive (0–1). */
  tooExpensive: number
}

export interface VanWestendorpCrossing {
  /** Interpolated crossing price on the observed grid. */
  price: number
  /** Lower observed grid price around the crossing. */
  lower: number
  /** Upper observed grid price around the crossing. */
  upper: number
}

export interface VanWestendorpResult {
  sampleCount: number
  usableCount: number
  excludedCount: number
  currency?: string
  stats: {
    tooCheap: PercentileSummary | null
    cheap: PercentileSummary | null
    expensive: PercentileSummary | null
    tooExpensive: PercentileSummary | null
  }
  /**
   * Classic acceptable range from the point of marginal cheapness to the
   * point of marginal expensiveness. Falls back to the median bargain and
   * median expensive prices (`source: 'medians'`) when the crossings are not
   * clean; null when neither is available.
   */
  acceptableRange: { low: number; high: number; source: 'crossings' | 'medians' } | null
  optimalPricePoint: VanWestendorpCrossing | null
  indifferencePricePoint: VanWestendorpCrossing | null
  pointOfMarginalCheapness: VanWestendorpCrossing | null
  pointOfMarginalExpensiveness: VanWestendorpCrossing | null
  /** Curve values at every observed price, for plotting or inspection. */
  curve: VanWestendorpCurvePoint[]
  warnings: string[]
}

export interface VanWestendorpOptions {
  currency?: string
}

const VAN_WESTENDORP_QUESTIONS: VanWestendorpQuestion[] = ['tooCheap', 'cheap', 'expensive', 'tooExpensive']

function summarise(values: number[]): PercentileSummary | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    min: sorted[0],
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    max: sorted[sorted.length - 1]
  }
}

interface CrossingLookup {
  crossing: VanWestendorpCrossing | null
  reason: string
}

/**
 * Find where a declining curve (share at or above its threshold) crosses a
 * rising curve (share at or below its threshold).
 *
 * The curves are cumulative shares sampled on the sorted observed price grid.
 * A crossing is linearly interpolated between the two adjacent grid prices;
 * an exact grid equality is returned as a point. More than one crossing, or a
 * zero plateau, is treated as ambiguous instead of picking a favourite.
 */
function findCrossing(
  curve: VanWestendorpCurvePoint[],
  declining: 'tooCheap' | 'bargain',
  rising: 'expensive' | 'tooExpensive'
): CrossingLookup {
  if (curve.length < 2) return { crossing: null, reason: 'curve has fewer than two observed price points' }
  const epsilon = 1e-9
  const differences = curve.map((point) => point[declining] - point[rising])
  const candidates: VanWestendorpCrossing[] = []
  let overlap: { lower: number; upper: number } | null = null
  let zeroStart = -1

  for (let index = 0; index < differences.length; index += 1) {
    const difference = differences[index]
    if (Math.abs(difference) <= epsilon) {
      if (zeroStart < 0) zeroStart = index
      continue
    }
    if (zeroStart >= 0) {
      const before = zeroStart > 0 ? differences[zeroStart - 1] : 0
      const flatLength = index - zeroStart
      if (before > epsilon && difference < -epsilon) {
        if (flatLength > 1) {
          // Both curves sit at zero across adjacent grid prices: the data does
          // not identify a single crossing, only a band where they touch.
          overlap = { lower: curve[zeroStart].price, upper: curve[index - 1].price }
        } else {
          candidates.push({
            price: curve[zeroStart].price,
            lower: curve[zeroStart].price,
            upper: curve[zeroStart].price
          })
        }
      }
      zeroStart = -1
    }
    if (index > 0 && differences[index - 1] > epsilon && difference < -epsilon) {
      const lowerPoint = curve[index - 1]
      const upperPoint = curve[index]
      const previous = differences[index - 1]
      const ratio = previous / (previous - difference)
      candidates.push({
        price: lowerPoint.price + (upperPoint.price - lowerPoint.price) * ratio,
        lower: lowerPoint.price,
        upper: upperPoint.price
      })
    }
  }

  // A zero run that ends at the highest observed price means the curves only
  // touch at the edge of the data; do not extrapolate a crossing from it.
  if (zeroStart >= 0 && zeroStart > 0 && differences[zeroStart - 1] > epsilon) {
    return {
      crossing: null,
      reason: `curves only meet at zero at the highest observed price (${formatNumber(curve[zeroStart].price)})`
    }
  }
  if (overlap) {
    return {
      crossing: null,
      reason: `curves touch at zero across ${formatNumber(overlap.lower)}–${formatNumber(overlap.upper)}; no single crossing is identified`
    }
  }
  if (candidates.length > 1) {
    return { crossing: null, reason: 'curves cross more than once in the observed range' }
  }
  if (candidates.length === 0) return { crossing: null, reason: 'curves do not cross in the observed range' }
  return { crossing: candidates[0], reason: '' }
}

/**
 * Compute a Van Westendorp Price Sensitivity Meter from four-question survey
 * responses.
 *
 * Definitions used here (stated explicitly so the output can be challenged):
 * - Too-cheap curve: share of respondents whose too-cheap price is at or above
 *   the grid price — i.e. they would call that price too cheap.
 * - Bargain curve: share whose bargain price is at or above the grid price.
 * - Expensive curve: share whose expensive price is at or below the grid price.
 * - Too-expensive curve: share whose too-expensive price is at or below it.
 *
 * Crossings:
 * - PMC (point of marginal cheapness): too-cheap × expensive.
 * - PME (point of marginal expensiveness): bargain × too-expensive.
 * - OPP (optimal price point): too-cheap × too-expensive.
 * - IPP (indifference price point): bargain × expensive.
 *
 * These crossings are directional. They depend on stated prices, the sample,
 * the exact question wording and how ties are drawn on a coarse grid. Report
 * them as a band to investigate, never as a precise optimal price.
 */
export function vanWestendorp(
  responses: VanWestendorpResponse[],
  options: VanWestendorpOptions = {}
): VanWestendorpResult {
  const warnings: string[] = []
  const values: Record<VanWestendorpQuestion, number[]> = {
    tooCheap: [],
    cheap: [],
    expensive: [],
    tooExpensive: []
  }
  let excludedCount = 0
  const input = Array.isArray(responses) ? responses : []

  input.forEach((response, index) => {
    const prices = VAN_WESTENDORP_QUESTIONS.map((question) =>
      positiveNumber((response as unknown as Record<string, unknown> | null | undefined)?.[question])
    )
    if (prices.some((price) => price === undefined)) {
      warnings.push(
        `Response ${index + 1} skipped: all four prices must be positive finite numbers.`
      )
      excludedCount += 1
      return
    }
    const [tooCheap, cheap, expensive, tooExpensive] = prices as [number, number, number, number]
    if (tooCheap > cheap || cheap > expensive || expensive > tooExpensive || tooCheap >= tooExpensive) {
      warnings.push(
        `Response ${index + 1} is inconsistent: expected tooCheap ≤ cheap ≤ expensive ≤ tooExpensive, got ${formatNumber(tooCheap)} / ${formatNumber(cheap)} / ${formatNumber(expensive)} / ${formatNumber(tooExpensive)}.`
      )
      excludedCount += 1
      return
    }
    values.tooCheap.push(tooCheap)
    values.cheap.push(cheap)
    values.expensive.push(expensive)
    values.tooExpensive.push(tooExpensive)
  })

  const usableCount = values.tooCheap.length
  const stats = {
    tooCheap: summarise(values.tooCheap),
    cheap: summarise(values.cheap),
    expensive: summarise(values.expensive),
    tooExpensive: summarise(values.tooExpensive)
  }

  if (usableCount < 2) {
    warnings.push(
      'Not enough usable responses to compute price curves; supply at least two consistent responses (30–100+ per segment for a directional read).'
    )
    return {
      sampleCount: input.length,
      usableCount,
      excludedCount,
      currency: options.currency,
      stats,
      acceptableRange: null,
      optimalPricePoint: null,
      indifferencePricePoint: null,
      pointOfMarginalCheapness: null,
      pointOfMarginalExpensiveness: null,
      curve: [],
      warnings
    }
  }

  const grid = Array.from(
    new Set([
      ...values.tooCheap,
      ...values.cheap,
      ...values.expensive,
      ...values.tooExpensive
    ])
  ).sort((a, b) => a - b)

  const share = (sample: number[], predicate: (value: number) => boolean): number =>
    sample.filter(predicate).length / usableCount

  const curve: VanWestendorpCurvePoint[] = grid.map((price) => ({
    price,
    tooCheap: share(values.tooCheap, (value) => value >= price),
    bargain: share(values.cheap, (value) => value >= price),
    expensive: share(values.expensive, (value) => value <= price),
    tooExpensive: share(values.tooExpensive, (value) => value <= price)
  }))

  const pmcLookup = findCrossing(curve, 'tooCheap', 'expensive')
  const pmeLookup = findCrossing(curve, 'bargain', 'tooExpensive')
  const oppLookup = findCrossing(curve, 'tooCheap', 'tooExpensive')
  const ippLookup = findCrossing(curve, 'bargain', 'expensive')

  const describeLookup = (name: string, lookup: CrossingLookup): void => {
    if (lookup.crossing) return
    warnings.push(`No clean ${name}: ${lookup.reason}; report it as undefined rather than extrapolating.`)
  }
  describeLookup('point of marginal cheapness (PMC)', pmcLookup)
  describeLookup('point of marginal expensiveness (PME)', pmeLookup)
  describeLookup('optimal price point (OPP)', oppLookup)
  describeLookup('indifference price point (IPP)', ippLookup)

  let acceptableRange: VanWestendorpResult['acceptableRange'] = null
  if (pmcLookup.crossing && pmeLookup.crossing && pmcLookup.crossing.price <= pmeLookup.crossing.price) {
    acceptableRange = {
      low: pmcLookup.crossing.price,
      high: pmeLookup.crossing.price,
      source: 'crossings'
    }
  } else {
    const medianBargain = stats.cheap?.median
    const medianExpensive = stats.expensive?.median
    if (medianBargain !== undefined && medianExpensive !== undefined && medianBargain <= medianExpensive) {
      acceptableRange = { low: medianBargain, high: medianExpensive, source: 'medians' }
      warnings.push(
        'Acceptable range falls back to median(cheap)–median(expensive) because the PMC/PME crossings were not clean.'
      )
    }
  }

  if (usableCount < 30) {
    warnings.push(
      `Only ${usableCount} usable responses. Van Westendorp is directional at this sample size; aim for 30–100+ representative respondents per segment before making a price decision.`
    )
  }

  return {
    sampleCount: input.length,
    usableCount,
    excludedCount,
    currency: options.currency,
    stats,
    acceptableRange,
    optimalPricePoint: oppLookup.crossing,
    indifferencePricePoint: ippLookup.crossing,
    pointOfMarginalCheapness: pmcLookup.crossing,
    pointOfMarginalExpensiveness: pmeLookup.crossing,
    curve,
    warnings
  }
}

// ---------------------------------------------------------------------------
// Tier and feature matrix
// ---------------------------------------------------------------------------

export interface TierInput {
  name: string
  price: number
  billing: string
  features: string[]
  limits?: Record<string, string>
}

export interface TierColumn {
  name: string
  price: number
  billing: string
  featureCount: number
  limits: Record<string, string>
}

export interface TierFeatureRow {
  name: string
  /** One entry per tier column, in input order. */
  presence: boolean[]
  count: number
  inAllTiers: boolean
  uniqueTo: string | null
}

export interface TierMatrixResult {
  tiers: TierColumn[]
  features: TierFeatureRow[]
  /** Features present in every tier — table stakes, not differentiators. */
  sharedFeatures: string[]
  /** Features present in exactly one tier. */
  uniqueFeatures: Array<{ feature: string; tier: string }>
  /** Every limit key found across tiers, in first-appearance order. */
  limitKeys: string[]
  warnings: string[]
}

/** Build a feature-by-tier matrix and flag shared vs unique features. */
export function tierMatrix(tiers: TierInput[]): TierMatrixResult {
  const warnings: string[] = []
  const columns: TierColumn[] = []
  const featureOrder: string[] = []
  const featureSets: Set<string>[] = []
  const seenNames = new Set<string>()
  const input = Array.isArray(tiers) ? tiers : []

  input.forEach((tier, index) => {
    const name = typeof tier?.name === 'string' ? tier.name.trim() : ''
    if (!name) {
      warnings.push(`Tier ${index + 1} skipped: a tier name is required.`)
      return
    }
    if (seenNames.has(name)) {
      warnings.push(`Duplicate tier name "${name}"; keep tier names unique so the matrix is readable.`)
    }
    seenNames.add(name)

    const price = finiteNumber(tier.price)
    if (price === undefined || price < 0) {
      warnings.push(`Tier "${name}" has an invalid price; using 0 in the matrix.`)
    }
    const billing = typeof tier.billing === 'string' ? tier.billing.trim() : ''
    if (!billing) warnings.push(`Tier "${name}" has no billing period (for example "per month").`)

    const limits: Record<string, string> = {}
    if (tier.limits && typeof tier.limits === 'object') {
      for (const [key, value] of Object.entries(tier.limits)) {
        const trimmedKey = key.trim()
        if (trimmedKey) limits[trimmedKey] = String(value)
      }
    }

    const features = new Set<string>()
    for (const feature of Array.isArray(tier.features) ? tier.features : []) {
      const value = typeof feature === 'string' ? feature.trim() : ''
      if (!value) continue
      if (features.has(value)) {
        warnings.push(`Tier "${name}" lists "${value}" more than once; counted once.`)
        continue
      }
      features.add(value)
      if (!featureOrder.includes(value)) featureOrder.push(value)
    }
    if (features.size === 0) {
      warnings.push(`Tier "${name}" has no features; check whether it is a real offer.`)
    }

    columns.push({
      name,
      price: price !== undefined && price >= 0 ? price : 0,
      billing,
      featureCount: features.size,
      limits
    })
    featureSets.push(features)
  })

  const features: TierFeatureRow[] = featureOrder.map((name) => {
    const presence = featureSets.map((set) => set.has(name))
    const count = presence.filter(Boolean).length
    const uniqueIndex = count === 1 ? presence.findIndex(Boolean) : -1
    return {
      name,
      presence,
      count,
      inAllTiers: columns.length > 0 && count === columns.length,
      uniqueTo: uniqueIndex >= 0 ? columns[uniqueIndex].name : null
    }
  })

  const sharedFeatures = features.filter((row) => row.inAllTiers).map((row) => row.name)
  const uniqueFeatures = features
    .filter((row) => row.uniqueTo !== null)
    .map((row) => ({ feature: row.name, tier: row.uniqueTo as string }))

  const limitKeys: string[] = []
  for (const column of columns) {
    for (const key of Object.keys(column.limits)) {
      if (!limitKeys.includes(key)) limitKeys.push(key)
    }
  }

  if (columns.length >= 2 && features.length > 0 && uniqueFeatures.length === 0) {
    warnings.push(
      'Every feature appears in every tier; the tiers differ only on price or limits. Add a genuine reason to upgrade, or simplify to one offer.'
    )
  }

  return { tiers: columns, features, sharedFeatures, uniqueFeatures, limitKeys, warnings }
}

// ---------------------------------------------------------------------------
// Value metric assessment
// ---------------------------------------------------------------------------

export type ValueMetricCriterion =
  | 'alignment'
  | 'scalability'
  | 'predictability'
  | 'fairness'
  | 'measurability'

export interface ValueMetricCandidate {
  name: string
  /** 1–5 (or 0–10) score: how closely the metric tracks customer value. */
  alignment: number
  /** Grows with customer value without repeated sales negotiation. */
  scalability: number
  /** Stable and forecastable enough for budgeting and billing. */
  predictability: number
  /** Customers perceive the bill as fair and can influence it. */
  fairness: number
  /** Easy to measure from telemetry and explain on an invoice. */
  measurability: number
  /** The billing unit, e.g. "per active user" or "per 1,000 API calls". */
  unit?: string
  notes?: string
}

export interface ValueMetricRationale {
  criterion: ValueMetricCriterion
  score: number
  kind: 'strength' | 'risk' | 'neutral'
}

export interface RankedValueMetric {
  name: string
  /** Weighted score on a 0–5 scale. */
  score: number
  grade: 'strong' | 'promising' | 'weak'
  scores: Record<ValueMetricCriterion, number>
  unit?: string
  notes?: string
  rationale: ValueMetricRationale[]
  strengths: ValueMetricCriterion[]
  risks: ValueMetricCriterion[]
}

export interface ValueMetricResult {
  ranked: RankedValueMetric[]
  weights: Record<ValueMetricCriterion, number>
  recommended: string | null
  warnings: string[]
}

export const VALUE_METRIC_WEIGHTS: Record<ValueMetricCriterion, number> = {
  alignment: 0.3,
  scalability: 0.2,
  predictability: 0.2,
  fairness: 0.15,
  measurability: 0.15
}

const VALUE_METRIC_CRITERIA: ValueMetricCriterion[] = [
  'alignment',
  'scalability',
  'predictability',
  'fairness',
  'measurability'
]

/**
 * Rank candidate value metrics on five decision criteria and attach a
 * rationale hook per criterion. Scores may be entered on a 0–5 scale or a
 * 0–10 scale; the scale is detected per criterion across the candidate set.
 */
export function valueMetricCandidates(candidates: ValueMetricCandidate[]): ValueMetricResult {
  const warnings: string[] = []
  const input = Array.isArray(candidates) ? candidates : []
  const valid: ValueMetricCandidate[] = []

  input.forEach((candidate, index) => {
    const name = typeof candidate?.name === 'string' ? candidate.name.trim() : ''
    if (!name) {
      warnings.push(`Candidate ${index + 1} skipped: a name is required.`)
      return
    }
    valid.push({ ...candidate, name })
  })

  // Detect the scale from each candidate's own answers: a candidate that uses
  // any score above 5 is treated as answering on the 0–10 scale throughout.
  // That keeps one candidate's mixed-looking set from being half-divided.
  const scaleFor = (candidate: ValueMetricCandidate): number => {
    let maximum = 0
    for (const criterion of VALUE_METRIC_CRITERIA) {
      const value = finiteNumber(candidate[criterion])
      if (value !== undefined) maximum = Math.max(maximum, value)
    }
    return maximum > 5 ? 2 : 1
  }

  const normalize = (name: string, criterion: ValueMetricCriterion, raw: unknown, scale: number): number => {
    const value = finiteNumber(raw)
    if (value === undefined) {
      warnings.push(`"${name}" is missing ${criterion}; scored 0 for that criterion.`)
      return 0
    }
    if (value < 0 || value > 10) {
      warnings.push(`"${name}" has ${criterion}=${formatNumber(value)} outside 0–10; clamped.`)
    }
    return clamp(value, 0, 10) / scale
  }

  const ranked: RankedValueMetric[] = valid.map((candidate) => {
    const scores = {} as Record<ValueMetricCriterion, number>
    const scale = scaleFor(candidate)
    for (const criterion of VALUE_METRIC_CRITERIA) {
      scores[criterion] = normalize(candidate.name, criterion, candidate[criterion], scale)
    }
    const score = VALUE_METRIC_CRITERIA.reduce(
      (total, criterion) => total + scores[criterion] * VALUE_METRIC_WEIGHTS[criterion],
      0
    )
    const rationale: ValueMetricRationale[] = VALUE_METRIC_CRITERIA.map((criterion) => ({
      criterion,
      score: roundTo(scores[criterion], 2),
      kind: scores[criterion] >= 4 ? 'strength' : scores[criterion] <= 2.5 ? 'risk' : 'neutral'
    }))
    return {
      name: candidate.name,
      score: roundTo(score, 2),
      grade: score >= 4.2 ? 'strong' : score >= 3.2 ? 'promising' : 'weak',
      scores,
      unit: candidate.unit,
      notes: candidate.notes,
      rationale,
      strengths: rationale.filter((item) => item.kind === 'strength').map((item) => item.criterion),
      risks: rationale.filter((item) => item.kind === 'risk').map((item) => item.criterion)
    }
  })

  ranked.sort((a, b) => (b.score !== a.score ? b.score - a.score : compareText(a.name, b.name)))

  return {
    ranked,
    weights: { ...VALUE_METRIC_WEIGHTS },
    recommended: ranked.length > 0 ? ranked[0].name : null,
    warnings
  }
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

const QUESTION_LABELS: Record<OutputLanguage, Record<VanWestendorpQuestion, string>> = {
  en: {
    tooCheap: 'Too cheap (quality concern)',
    cheap: 'Bargain / cheap',
    expensive: 'Expensive but acceptable',
    tooExpensive: 'Too expensive (would not consider)'
  },
  'zh-CN': {
    tooCheap: '太便宜（怀疑质量）',
    cheap: '便宜 / 划算',
    expensive: '偏贵但可接受',
    tooExpensive: '太贵（不会考虑）'
  }
}

const CRITERION_TEXT: Record<
  OutputLanguage,
  Record<ValueMetricCriterion, { label: string; high: string; low: string; mid: string }>
> = {
  en: {
    alignment: {
      label: 'Alignment',
      high: 'Tracks the value customers actually receive, so revenue grows when they succeed.',
      low: 'Weak link between price and value; customers may over- or under-pay relative to what they get.',
      mid: 'Reasonable proxy for value, but check it against the customer’s job to be done.'
    },
    scalability: {
      label: 'Scalability',
      high: 'Grows with usage and value without a new sales negotiation every time.',
      low: 'Revenue is hard to grow without renegotiating each account.',
      mid: 'Scales with some sales or admin effort; watch the marginal cost of growth.'
    },
    predictability: {
      label: 'Predictability',
      high: 'Usage tends to be stable and forecastable, which supports budgeting and billing.',
      low: 'Spiky usage makes invoices and forecasts hard to predict.',
      mid: 'Predictable for mature accounts; new accounts may vary.'
    },
    fairness: {
      label: 'Fairness',
      high: 'Customers can understand and influence the bill; light users are not overcharged.',
      low: 'Customers may feel punished for normal use or unable to control the bill.',
      mid: 'Broadly defensible, but explain the meter and offer a ceiling or alert.'
    },
    measurability: {
      label: 'Measurability',
      high: 'Easy to measure from product telemetry and easy to explain on an invoice.',
      low: 'Hard to measure reliably or hard for the customer to verify.',
      mid: 'Measurable with instrumentation work; document the counting rules.'
    }
  },
  'zh-CN': {
    alignment: {
      label: '价值对齐',
      high: '与客户真正获得的价值同步增长，客户成功时收入也增长。',
      low: '价格与价值关联弱，客户可能为得不到的东西多付或少付。',
      mid: '是价值的合理代理指标，但仍需对照客户的任务与场景验证。'
    },
    scalability: {
      label: '可扩展性',
      high: '随使用量和价值增长，不需要每次都重新谈价。',
      low: '不逐个客户重谈就很难扩大收入。',
      mid: '增长需要一定销售或运营投入，关注增长的边际成本。'
    },
    predictability: {
      label: '可预测性',
      high: '用量稳定、可预测，便于预算和账单管理。',
      low: '用量波动大，账单和收入预测都很难。',
      mid: '成熟客户可预测，新客户可能波动。'
    },
    fairness: {
      label: '公平性',
      high: '账单可理解、可影响，轻度用户不会被多收。',
      low: '客户可能觉得正常使用被惩罚，或无法控制账单。',
      mid: '总体说得通，但要解释计量规则并提供上限或提醒。'
    },
    measurability: {
      label: '可测量性',
      high: '能从产品埋点稳定测量，也容易在账单上解释。',
      low: '难以可靠测量，或客户难以核对。',
      mid: '需要一定埋点工作，务必写清计量口径。'
    }
  }
}

function gradeLabel(grade: RankedValueMetric['grade'], language: OutputLanguage): string {
  if (language === 'en') return grade
  return grade === 'strong' ? '强' : grade === 'promising' ? '有潜力' : '偏弱'
}

function crossingText(
  crossing: VanWestendorpCrossing | null,
  currency: string | undefined,
  language: OutputLanguage
): string {
  if (!crossing) return pick(language, 'undefined (no clean crossing)', '未定义（没有干净交点）')
  const price = money(crossing.price, currency)
  if (Math.abs(crossing.upper - crossing.lower) < 1e-9) return `≈${price}`
  return pick(
    language,
    `≈${price} (between ${money(crossing.lower, currency)} and ${money(crossing.upper, currency)})`,
    `≈${price}（位于 ${money(crossing.lower, currency)}–${money(crossing.upper, currency)} 之间）`
  )
}

function vanWestendorpBody(result: VanWestendorpResult, language: OutputLanguage): string {
  const lines: string[] = []
  lines.push(
    pick(
      language,
      `- Sample: ${result.sampleCount} responses (${result.usableCount} usable, ${result.excludedCount} excluded as inconsistent or incomplete)`,
      `- 样本：${result.sampleCount} 份（可用 ${result.usableCount}，因不一致或不完整剔除 ${result.excludedCount}）`
    )
  )

  const stats = result.stats
  if (!stats.tooCheap || !stats.cheap || !stats.expensive || !stats.tooExpensive) {
    lines.push('', pick(language, 'No usable responses, so no price percentiles are available.', '没有可用样本，无法计算价格分位数。'))
  } else {
    lines.push(
      '',
      markdownTable(
        pick(language, ['Question', 'P25', 'Median', 'P75', 'Min', 'Max'], ['问题', 'P25', '中位数', 'P75', '最小', '最大']),
        VAN_WESTENDORP_QUESTIONS.map((question) => {
          const summary = stats[question] as PercentileSummary
          return [
            QUESTION_LABELS[language][question],
            money(summary.p25, result.currency),
            money(summary.median, result.currency),
            money(summary.p75, result.currency),
            money(summary.min, result.currency),
            money(summary.max, result.currency)
          ]
        })
      )
    )
    const range = result.acceptableRange
    if (range) {
      const source =
        range.source === 'crossings'
          ? pick(language, 'PMC–PME crossings', 'PMC–PME 交点')
          : pick(language, 'median fallback', '中位数回退')
      lines.push(
        '',
        pick(
          language,
          `- Acceptable range: ${money(range.low, result.currency)}–${money(range.high, result.currency)} (${source})`,
          `- 可接受价格区间：${money(range.low, result.currency)}–${money(range.high, result.currency)}（${source}）`
        ),
        pick(
          language,
          `- Optimal price point (OPP): ${crossingText(result.optimalPricePoint, result.currency, language)}`,
          `- 最优价格点（OPP）：${crossingText(result.optimalPricePoint, result.currency, language)}`
        ),
        pick(
          language,
          `- Indifference price point (IPP): ${crossingText(result.indifferencePricePoint, result.currency, language)}`,
          `- 无差异价格点（IPP）：${crossingText(result.indifferencePricePoint, result.currency, language)}`
        ),
        pick(
          language,
          `- Point of marginal cheapness (PMC): ${crossingText(result.pointOfMarginalCheapness, result.currency, language)}`,
          `- 边际便宜点（PMC）：${crossingText(result.pointOfMarginalCheapness, result.currency, language)}`
        ),
        pick(
          language,
          `- Point of marginal expensiveness (PME): ${crossingText(result.pointOfMarginalExpensiveness, result.currency, language)}`,
          `- 边际昂贵点（PME）：${crossingText(result.pointOfMarginalExpensiveness, result.currency, language)}`
        )
      )
    }
  }

  lines.push(
    '',
    pick(
      language,
      '> Caveat: Van Westendorp is directional, not a demand curve. It measures stated price perceptions at one moment, not purchase intent, elasticity or revenue. Use a representative sample of the target segment (roughly 30–100+ respondents per segment; more for narrow segments), screen out people who would never buy, keep the question wording identical, and treat the crossings as a band to investigate. Confirm with behavioural tests and margin analysis before setting a price.',
      '> 注意：Van Westendorp 是方向性工具，不是需求曲线。它测的是某一时点的价格感知，不是购买意愿、价格弹性或收入。请使用目标客群的代表性样本（每个细分约 30–100+ 份，越窄的客群越多），筛掉绝不会购买的人，保持问题措辞一致，并把交点当作「值得进一步验证的区间」而不是最终价格。定价前用行为测试和毛利分析交叉验证。'
    )
  )

  if (result.warnings.length > 0) {
    lines.push('', pick(language, '**Data warnings**', '**数据提醒**'))
    for (const warning of result.warnings) lines.push(`- ${warning}`)
  }
  return lines.join('\n')
}

function tierMatrixBody(result: TierMatrixResult, language: OutputLanguage, currency?: string): string {
  if (result.tiers.length === 0) {
    return pick(language, 'No tiers were supplied, so no packaging matrix can be built.', '没有提供套餐，无法生成套餐矩阵。')
  }
  const lines: string[] = [
    markdownTable(
      pick(language, ['Tier', 'Price', 'Billing', 'Features'], ['套餐', '价格', '计费周期', '功能数']),
      result.tiers.map((tier) => [
        tier.name,
        money(tier.price, currency),
        tier.billing || '—',
        String(tier.featureCount)
      ])
    ),
    ''
  ]

  if (result.features.length > 0) {
    lines.push(
      markdownTable(
        [pick(language, 'Feature', '功能'), ...result.tiers.map((tier) => tier.name)],
        result.features.map((feature) => [
          feature.name,
          ...feature.presence.map((present) => (present ? '✓' : '—'))
        ])
      ),
      ''
    )
  }

  lines.push(pick(language, '**Shared features (every tier)**', '**共有功能（每个套餐都有）**'))
  if (result.sharedFeatures.length === 0) lines.push(pick(language, '- None.', '- 无。'))
  else for (const feature of result.sharedFeatures) lines.push(`- ${feature}`)

  lines.push('', pick(language, '**Unique features (differentiators)**', '**独有功能（差异化卖点）**'))
  if (result.uniqueFeatures.length === 0) {
    lines.push(pick(language, '- None: no feature belongs to exactly one tier.', '- 无：没有只属于某一个套餐的功能。'))
  } else {
    for (const unique of result.uniqueFeatures) {
      lines.push(pick(language, `- ${unique.feature} — only in ${unique.tier}`, `- ${unique.feature} — 仅 ${unique.tier}`))
    }
  }

  if (result.limitKeys.length > 0) {
    lines.push('', pick(language, '**Limits and quotas**', '**限额与配额**'))
    lines.push(
      markdownTable(
        [pick(language, 'Limit', '限额'), ...result.tiers.map((tier) => tier.name)],
        result.limitKeys.map((key) => [
          key,
          ...result.tiers.map((tier) => tier.limits[key] ?? '—')
        ])
      )
    )
  }

  if (result.warnings.length > 0) {
    lines.push('', pick(language, '**Packaging warnings**', '**包装提醒**'))
    for (const warning of result.warnings) lines.push(`- ${warning}`)
  }
  return lines.join('\n')
}

function valueMetricBody(result: ValueMetricResult, language: OutputLanguage): string {
  if (result.ranked.length === 0) {
    return pick(language, 'No value-metric candidates were supplied.', '没有提供价值指标候选。')
  }
  const lines: string[] = [
    markdownTable(
      pick(
        language,
        ['Rank', 'Value metric', 'Score / 5', 'Grade', 'Main rationale'],
        ['排名', '价值指标', '得分 / 5', '评价', '主要理由']
      ),
      result.ranked.map((metric, index) => {
        const strongest = metric.rationale.find((item) => item.kind === 'strength') ?? metric.rationale[0]
        return [
          String(index + 1),
          metric.name,
          formatNumber(metric.score),
          gradeLabel(metric.grade, language),
          `${CRITERION_TEXT[language][strongest.criterion].label}: ${formatNumber(strongest.score)}/5`
        ]
      })
    ),
    ''
  ]

  if (result.recommended) {
    lines.push(pick(language, `**Recommended: ${result.recommended}**`, `**推荐：${result.recommended}**`), '')
  }

  for (const metric of result.ranked) {
    lines.push(pick(language, `**${metric.name}** — ${formatNumber(metric.score)}/5 (${gradeLabel(metric.grade, language)})`, `**${metric.name}** — ${formatNumber(metric.score)}/5（${gradeLabel(metric.grade, language)}）`))
    if (metric.unit) lines.push(pick(language, `- Billing unit: ${metric.unit}`, `- 计费单位：${metric.unit}`))
    if (metric.notes) lines.push(pick(language, `- Notes: ${metric.notes}`, `- 备注：${metric.notes}`))
    for (const rationale of metric.rationale) {
      const text = CRITERION_TEXT[language][rationale.criterion]
      const phrase = rationale.kind === 'strength' ? text.high : rationale.kind === 'risk' ? text.low : text.mid
      lines.push(`- ${text.label} (${formatNumber(rationale.score)}/5): ${phrase}`)
    }
    lines.push('')
  }

  if (result.warnings.length > 0) {
    lines.push(pick(language, '**Value-metric warnings**', '**价值指标提醒**'))
    for (const warning of result.warnings) lines.push(`- ${warning}`)
  }
  return lines.join('\n').trimEnd()
}

export function formatVanWestendorp(
  result: VanWestendorpResult,
  language: OutputLanguage = 'zh-CN'
): string {
  return `${pick(language, '## Van Westendorp price sensitivity', '## Van Westendorp 价格敏感度')}\n\n${vanWestendorpBody(result, language)}`
}

export function formatTierMatrix(
  result: TierMatrixResult,
  language: OutputLanguage = 'zh-CN',
  currency?: string
): string {
  return `${pick(language, '## Packaging and tier matrix', '## 套餐与功能矩阵')}\n\n${tierMatrixBody(result, language, currency)}`
}

export function formatValueMetrics(result: ValueMetricResult, language: OutputLanguage = 'zh-CN'): string {
  return `${pick(language, '## Value-metric assessment', '## 价值指标评估')}\n\n${valueMetricBody(result, language)}`
}

// ---------------------------------------------------------------------------
// Full pricing report
// ---------------------------------------------------------------------------

export interface PricingReportInput {
  product?: string
  segment?: string
  context?: string
  currency?: string
  vanWestendorp?: VanWestendorpResult
  tierMatrix?: TierMatrixResult
  valueMetrics?: ValueMetricResult
  language?: OutputLanguage
}

export function migrationQuestions(language: OutputLanguage = 'zh-CN'): string[] {
  if (language === 'en') {
    return [
      'Which existing customers, contracts and price lists are affected, and when does each segment renew?',
      'Do existing customers keep their current price (grandfathering)? For how long, and what happens at the next renewal?',
      'How much notice do contracts and local law require, and who communicates the change?',
      'What is the downgrade path for customers who cannot accept the new price, and what revenue churn should we expect?',
      'Are proration, refunds, tax/VAT and billing-system changes handled, and who owns each?',
      'What is the rollback plan if churn, support contacts or conversion move outside the expected range?',
      'Which success metric and guardrail decide whether the new price stays, and when will we review them?',
      'How will we test willingness to pay without unfair discrimination, fake urgency or dark patterns?'
    ]
  }
  return [
    '哪些老客户、合同和价格表会受影响？每个细分什么时候续约？',
    '老客户是否保留现价（grandfathering）？保留多久，下一次续约时怎么办？',
    '合同和当地法律要求提前多久通知？由谁负责沟通？',
    '无法接受新价格的客户如何降级？预计会流失多少收入？',
    '按比例计费、退款、税费/VAT 和账单系统改造是否都处理了？每项由谁负责？',
    '如果流失率、客服咨询量或转化率超出预期，回滚方案是什么？',
    '用哪个成功指标和护栏指标决定新价格是否保留？什么时候复盘？',
    '如何在不公平歧视、虚构紧迫感和暗黑模式之外测试付费意愿？'
  ]
}

export const PRICING_CHECKLIST: Record<OutputLanguage, string[]> = {
  en: [
    'The decision, target segment and willingness-to-pay range are written down.',
    'At least one representative WTP study or behavioural price test exists; sample size and bias are stated.',
    'The value metric grows with customer value and is easy to explain, measure and forecast.',
    'Each higher tier has a clear reason to upgrade, and no tier exists only as a decoy.',
    'Existing customers, contracts, notice periods and grandfathering are mapped.',
    'Billing, tax, proration, refunds and rollback are tested before launch.',
    'Price testing is legal, ethical and does not discriminate unfairly between similar customers.'
  ],
  'zh-CN': [
    '决策、目标客群和可接受价格区间已经写清楚。',
    '至少有一份代表性的付费意愿研究或行为价格测试；样本量和偏差已说明。',
    '价值指标随客户价值增长，且容易解释、测量和预测。',
    '每个更高档位都有明确升级理由，没有纯做诱饵的套餐。',
    '老客户、合同、通知期和 grandfathering 已梳理。',
    '账单、税费、按比例计费、退款和回滚在上线前已测试。',
    '价格测试合法、符合伦理，且不会在相似客户之间造成不公平歧视。'
  ]
}

/**
 * Build a Markdown pricing and packaging report.
 *
 * Sections that have no input are still rendered as explicit evidence gaps —
 * a report that quietly omits the missing WTP study is worse than one that
 * says "no evidence yet".
 */
export function buildPricingReport(input: PricingReportInput = {}): string {
  const language = input.language ?? 'zh-CN'
  const title = pick(language, 'Pricing and packaging report', '定价与包装报告')
  const product = input.product?.trim()
  const lines: string[] = [`# ${title}${product ? ` — ${product}` : ''}`, '']
  lines.push(
    pick(
      language,
      '> A decision aid, not a price calculator. Every number below is only as good as the evidence and sample behind it.',
      '> 这是决策辅助，不是价格计算器。下面的每个数字，都只与背后的证据和样本一样可靠。'
    ),
    ''
  )
  if (input.segment?.trim()) lines.push(pick(language, `- Target segment: ${input.segment.trim()}`, `- 目标客群：${input.segment.trim()}`))
  if (input.currency?.trim()) lines.push(pick(language, `- Currency: ${input.currency.trim()}`, `- 货币：${input.currency.trim()}`))
  if (input.context?.trim()) lines.push(pick(language, `- Context: ${input.context.trim()}`, `- 背景：${input.context.trim()}`))

  const hasAnyData = Boolean(input.vanWestendorp || input.tierMatrix || input.valueMetrics)
  if (!hasAnyData) {
    lines.push(
      '',
      pick(
        language,
        '> No analysis data was supplied yet. This report is a scaffold: collect the evidence below before recommending a price.',
        '> 尚未提供分析数据。本报告目前是骨架：在建议价格之前，先补齐下面的证据。'
      )
    )
  }

  lines.push('', pick(language, '## 1. Van Westendorp price sensitivity', '## 1. Van Westendorp 价格敏感度'), '')
  if (input.vanWestendorp) {
    lines.push(vanWestendorpBody(input.vanWestendorp, language))
  } else {
    lines.push(
      pick(
        language,
        'Not supplied. Run the four-question survey with a representative sample (30–100+ per segment) before treating any price point as evidenced.',
        '未提供。在把任何价格点当作有依据的结论之前，先用代表性样本（每个细分 30–100+ 份）完成四问调研。'
      )
    )
  }

  lines.push('', pick(language, '## 2. Packaging and tier matrix', '## 2. 套餐与功能矩阵'), '')
  if (input.tierMatrix) {
    lines.push(tierMatrixBody(input.tierMatrix, language, input.currency))
  } else {
    lines.push(
      pick(
        language,
        'Not supplied. Map the current or proposed tiers feature by feature; every tier needs a reason to exist and a reason to upgrade.',
        '未提供。请逐项列出当前或拟议套餐的功能；每个套餐都要有存在理由，也要有升级到下一档的理由。'
      )
    )
  }

  lines.push('', pick(language, '## 3. Value-metric guidance', '## 3. 价值指标建议'), '')
  if (input.valueMetrics) {
    lines.push(valueMetricBody(input.valueMetrics, language))
  } else {
    lines.push(
      pick(
        language,
        'Not supplied. Score candidate value metrics on alignment, scalability, predictability, fairness and measurability before choosing a billing unit.',
        '未提供。选择计费单位前，先按价值对齐、可扩展性、可预测性、公平性和可测量性给候选价值指标打分。'
      )
    )
  }

  lines.push('', pick(language, '## 4. Migration and rollback questions', '## 4. 迁移与回滚问题'), '')
  migrationQuestions(language).forEach((question, index) => lines.push(`${index + 1}. ${question}`))

  lines.push('', pick(language, '## 5. Before you ship', '## 5. 上线前检查清单'), '')
  for (const item of PRICING_CHECKLIST[language]) lines.push(`- [ ] ${item}`)

  return lines.join('\n')
}
