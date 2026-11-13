/**
 * Deterministic product-prioritisation frameworks.
 *
 * The tool layer only formats these results; every number here is computed
 * locally so a PM can explain how a ranking was produced. No Pi imports, no
 * network, no hidden model call.
 */

export type PriorityMethod = 'rice' | 'ice' | 'moscow' | 'value_effort'

export interface PriorityItem {
  name: string
  /** RICE: number of users reached per period. */
  reach?: number
  /** RICE: expected impact, normally 0.25–3; ICE: 1–10. */
  impact?: number
  /** RICE/ICE: confidence. Accepts 0–1 or 0–100 for RICE. */
  confidence?: number
  /** RICE: person-effort. */
  effort?: number
  /** ICE: ease, 1–10. */
  ease?: number
  /** MoSCoW class. */
  priority?: 'must' | 'should' | 'could' | 'wont'
  /** Value/effort matrix: value and cost, normally 1–10. */
  value?: number
  cost?: number
}

export interface RankedPriority {
  name: string
  score: number
  /** Human-readable inputs used for this method. */
  inputs: Record<string, number | string>
  /** Value/effort quadrant, when applicable. */
  quadrant?: string
}

export interface PriorityResult {
  method: PriorityMethod
  ranked: RankedPriority[]
  warnings: string[]
}

const MOSCOW_ORDER: Record<NonNullable<PriorityItem['priority']>, number> = {
  must: 0,
  should: 1,
  could: 2,
  wont: 3
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function confidence01(value: unknown): number | undefined {
  const number = finite(value)
  if (number === undefined) return undefined
  const normalized = number > 1 ? number / 100 : number
  return Math.min(1, Math.max(0, normalized))
}

function scoreName(a: RankedPriority, b: RankedPriority): number {
  if (b.score !== a.score) return b.score - a.score
  return a.name.localeCompare(b.name)
}

/** RICE = Reach × Impact × Confidence ÷ Effort. */
export function calculateRice(items: PriorityItem[]): PriorityResult {
  const warnings: string[] = []
  const ranked: RankedPriority[] = []
  for (const item of items) {
    const name = item.name?.trim()
    if (!name) {
      warnings.push('Skipped an item without a name.')
      continue
    }
    const reach = finite(item.reach)
    const impact = finite(item.impact)
    const confidence = confidence01(item.confidence)
    const effort = finite(item.effort)
    if (reach === undefined || impact === undefined || confidence === undefined || effort === undefined) {
      warnings.push(`"${name}" is missing reach, impact, confidence or effort.`)
      continue
    }
    if (reach < 0 || effort <= 0) {
      warnings.push(`"${name}" needs reach ≥ 0 and effort > 0.`)
      continue
    }
    const score = (reach * impact * confidence) / effort
    ranked.push({
      name,
      score,
      inputs: { reach, impact, confidence, effort }
    })
  }
  ranked.sort(scoreName)
  return { method: 'rice', ranked, warnings }
}

/** ICE = Impact × Confidence × Ease. */
export function calculateIce(items: PriorityItem[]): PriorityResult {
  const warnings: string[] = []
  const ranked: RankedPriority[] = []
  for (const item of items) {
    const name = item.name?.trim()
    if (!name) {
      warnings.push('Skipped an item without a name.')
      continue
    }
    const rawImpact = finite(item.impact)
    const rawConfidence = finite(item.confidence)
    const rawEase = finite(item.ease)
    if (rawImpact === undefined || rawConfidence === undefined || rawEase === undefined) {
      warnings.push(`"${name}" is missing impact, confidence or ease.`)
      continue
    }
    // People naturally enter 1–10; tolerate 0–1 confidence values from other
    // frameworks by promoting them to the 1–10 scale.
    const normalizeTen = (value: number): number => (value >= 0 && value <= 1 ? value * 10 : value)
    const impact = normalizeTen(rawImpact)
    const confidence = normalizeTen(rawConfidence)
    const ease = normalizeTen(rawEase)
    const score = impact * confidence * ease
    ranked.push({ name, score, inputs: { impact, confidence, ease } })
  }
  ranked.sort(scoreName)
  return { method: 'ice', ranked, warnings }
}

/**
 * Value × effort matrix. The score is value minus cost for ordering, while
 * the quadrant is the decision aid a PM actually reads.
 */
export function calculateValueEffort(items: PriorityItem[]): PriorityResult {
  const warnings: string[] = []
  const ranked: RankedPriority[] = []
  for (const item of items) {
    const name = item.name?.trim()
    if (!name) {
      warnings.push('Skipped an item without a name.')
      continue
    }
    const value = finite(item.value)
    const cost = finite(item.cost)
    if (value === undefined || cost === undefined) {
      warnings.push(`"${name}" is missing value or cost.`)
      continue
    }
    const highValue = value >= 5
    const highCost = cost >= 5
    const quadrant = highValue
      ? highCost
        ? 'Strategic bets'
        : 'Quick wins'
      : highCost
        ? 'Avoid'
        : 'Fill-ins'
    ranked.push({ name, score: value - cost, inputs: { value, cost }, quadrant })
  }
  ranked.sort(scoreName)
  return { method: 'value_effort', ranked, warnings }
}

/** MoSCoW grouping, returning one ranked list in Must → Won't order. */
export function calculateMoscow(items: PriorityItem[]): PriorityResult {
  const warnings: string[] = []
  const ranked: RankedPriority[] = []
  for (const item of items) {
    const name = item.name?.trim()
    if (!name) {
      warnings.push('Skipped an item without a name.')
      continue
    }
    const priority = item.priority
    if (!priority || !(priority in MOSCOW_ORDER)) {
      warnings.push(`"${name}" has no MoSCoW priority.`)
      continue
    }
    ranked.push({
      name,
      score: 4 - MOSCOW_ORDER[priority],
      inputs: { priority }
    })
  }
  ranked.sort((a, b) => {
    const orderA = MOSCOW_ORDER[(a.inputs.priority as NonNullable<PriorityItem['priority']>)] ?? 99
    const orderB = MOSCOW_ORDER[(b.inputs.priority as NonNullable<PriorityItem['priority']>)] ?? 99
    return orderA - orderB || a.name.localeCompare(b.name)
  })
  return { method: 'moscow', ranked, warnings }
}

export function prioritize(method: PriorityMethod, items: PriorityItem[]): PriorityResult {
  switch (method) {
    case 'rice':
      return calculateRice(items)
    case 'ice':
      return calculateIce(items)
    case 'moscow':
      return calculateMoscow(items)
    case 'value_effort':
      return calculateValueEffort(items)
  }
}

/** Format a number without trailing `.0`, used in Markdown tables. */
export function formatScore(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}
