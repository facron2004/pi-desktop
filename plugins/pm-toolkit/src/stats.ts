/**
 * Small, dependency-free experiment calculators for product work.
 *
 * These are deliberately approximations: a PM needs a defensible planning
 * number and a quick read on a result, not a replacement for a statistics
 * package. Every function documents the assumptions it makes.
 */

export interface SampleSizeInput {
  /** Current conversion rate, 0 < baseline < 1. */
  baseline: number
  /** Relative minimum detectable effect, e.g. 0.1 for +10%. */
  relativeMde: number
  alpha?: number
  power?: number
  twoSided?: boolean
}

export interface SampleSizeResult {
  baseline: number
  variant: number
  absoluteMde: number
  alpha: number
  power: number
  twoSided: boolean
  perArm: number
  total: number
}

export interface ProportionTestInput {
  controlVisitors: number
  controlConversions: number
  variantVisitors: number
  variantConversions: number
  alpha?: number
  twoSided?: boolean
}

export interface ProportionTestResult {
  controlRate: number
  variantRate: number
  absoluteLift: number
  relativeLift: number
  z: number
  pValue: number
  significant: boolean
  alpha: number
  confidenceInterval: [number, number]
}

export interface FunnelStepInput {
  name: string
  users: number
}

export interface FunnelStepResult {
  name: string
  users: number
  /** Conversion from the first step, 0–1. */
  overallConversion: number
  /** Conversion from the immediately previous step, 0–1. */
  stepConversion: number
  /** Users lost from the previous step. */
  dropOff: number
  /** Step-to-step drop as a percentage of the previous step, 0–1. */
  dropRate: number
}

export interface FunnelResult {
  steps: FunnelStepResult[]
  overallConversion: number
  biggestDrop: FunnelStepResult | null
}

function assertProbability(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${name} must be between 0 and 1 (exclusive), received ${value}.`)
  }
}

/** Abramowitz–Stegun approximation of erf, accurate enough for p-values. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const absolute = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * absolute)
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) *
      Math.exp(-absolute * absolute)
  return sign * y
}

export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2))
}

/**
 * Inverse normal CDF using Peter Acklam's rational approximation.
 * Enough for alpha/power planning values used by product teams.
 */
export function inverseNormal(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) throw new Error('p must be between 0 and 1.')
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239
  ]
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1
  ]
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783
  ]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const plow = 0.02425
  const phigh = 1 - plow
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  const q = p - 0.5
  const r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/**
 * Sample size per arm for a two-proportion test.
 *
 * Uses the normal approximation with pooled variance; for very small baseline
 * rates (under ~1%) ask a data scientist to check the exact test instead.
 */
export function sampleSizePerArm(input: SampleSizeInput): SampleSizeResult {
  assertProbability(input.baseline, 'baseline')
  if (!Number.isFinite(input.relativeMde) || input.relativeMde <= 0) {
    throw new Error('relativeMde must be a positive number, for example 0.1 for a 10% lift.')
  }
  const alpha = input.alpha ?? 0.05
  const power = input.power ?? 0.8
  if (alpha <= 0 || alpha >= 1) throw new Error('alpha must be between 0 and 1.')
  if (power <= 0 || power >= 1) throw new Error('power must be between 0 and 1.')
  const twoSided = input.twoSided ?? true
  const variant = input.baseline * (1 + input.relativeMde)
  if (variant > 1) throw new Error('baseline and relativeMde imply a conversion rate above 100%.')
  const absoluteMde = variant - input.baseline
  const pBar = (input.baseline + variant) / 2
  const zAlpha = inverseNormal(twoSided ? 1 - alpha / 2 : 1 - alpha)
  const zPower = inverseNormal(power)
  const numerator =
    zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) +
    zPower * Math.sqrt(input.baseline * (1 - input.baseline) + variant * (1 - variant))
  const perArm = Math.ceil((numerator * numerator) / (absoluteMde * absoluteMde))
  return {
    baseline: input.baseline,
    variant,
    absoluteMde,
    alpha,
    power,
    twoSided,
    perArm,
    total: perArm * 2
  }
}

/** Two-proportion z-test with a pooled standard error. */
export function twoProportionTest(input: ProportionTestInput): ProportionTestResult {
  const { controlVisitors, controlConversions, variantVisitors, variantConversions } = input
  if (controlVisitors <= 0 || variantVisitors <= 0) throw new Error('Both arms need a positive visitor count.')
  if (controlConversions < 0 || controlConversions > controlVisitors) throw new Error('Control conversions must be between 0 and its visitor count.')
  if (variantConversions < 0 || variantConversions > variantVisitors) throw new Error('Variant conversions must be between 0 and its visitor count.')
  const alpha = input.alpha ?? 0.05
  const twoSided = input.twoSided ?? true
  const controlRate = controlConversions / controlVisitors
  const variantRate = variantConversions / variantVisitors
  const absoluteLift = variantRate - controlRate
  const relativeLift = controlRate === 0 ? Number.POSITIVE_INFINITY : absoluteLift / controlRate
  const pooled = (controlConversions + variantConversions) / (controlVisitors + variantVisitors)
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / controlVisitors + 1 / variantVisitors))
  const z = standardError === 0 ? 0 : absoluteLift / standardError
  const pValue = twoSided ? 2 * (1 - normalCdf(Math.abs(z))) : 1 - normalCdf(z)
  const unpooledSe = Math.sqrt(
    (controlRate * (1 - controlRate)) / controlVisitors +
      (variantRate * (1 - variantRate)) / variantVisitors
  )
  const critical = inverseNormal(1 - alpha / 2)
  const confidenceInterval: [number, number] = [
    absoluteLift - critical * unpooledSe,
    absoluteLift + critical * unpooledSe
  ]
  return {
    controlRate,
    variantRate,
    absoluteLift,
    relativeLift,
    z,
    pValue: Math.max(0, Math.min(1, pValue)),
    significant: pValue < alpha,
    alpha,
    confidenceInterval
  }
}

/** Funnel conversion from ordered steps with absolute user counts. */
export function funnelMetrics(steps: FunnelStepInput[]): FunnelResult {
  if (!steps.length) throw new Error('A funnel needs at least one step.')
  const firstUsers = steps[0].users
  if (!Number.isFinite(firstUsers) || firstUsers <= 0) throw new Error('The first funnel step needs more than zero users.')
  const rows: FunnelStepResult[] = steps.map((step, index) => {
    if (!Number.isFinite(step.users) || step.users < 0) throw new Error(`Step "${step.name}" has an invalid user count.`)
    const previous = index === 0 ? step.users : steps[index - 1].users
    const stepConversion = previous === 0 ? 0 : step.users / previous
    return {
      name: step.name,
      users: step.users,
      overallConversion: step.users / firstUsers,
      stepConversion,
      dropOff: Math.max(0, previous - step.users),
      dropRate: previous === 0 ? 0 : Math.max(0, (previous - step.users) / previous)
    }
  })
  const biggestDrop = rows
    .slice(1)
    .filter((step) => step.dropOff > 0)
    .sort((a, b) => b.dropRate - a.dropRate)[0] ?? null
  return { steps: rows, overallConversion: rows.at(-1)?.overallConversion ?? 0, biggestDrop }
}
