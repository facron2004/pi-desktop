/** Last time each model was picked, used to put familiar models first. */
const MODEL_RECENCY_KEY = 'pi-desktop.model-recency'

export type ModelRecency = Record<string, number>

export function modelRecencyKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`
}

export function readModelRecency(): ModelRecency {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MODEL_RECENCY_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    )
  } catch {
    // An unreadable store only loses the ordering, never the picker.
    return {}
  }
}

/** Keep the picker shortcut short even after months of switching models. */
const MAX_RECENT_MODELS = 20

export function recordModelUse(model: { provider: string; id: string }, now = Date.now()): ModelRecency {
  const recency = Object.fromEntries(
    Object.entries({ ...readModelRecency(), [modelRecencyKey(model)]: now })
      .sort(([, left], [, right]) => right - left)
      .slice(0, MAX_RECENT_MODELS)
  )
  try {
    localStorage.setItem(MODEL_RECENCY_KEY, JSON.stringify(recency))
  } catch {
    // The pick still applies when storage is unavailable.
  }
  return recency
}

/** Most recently used first; never-used models keep their original order. */
export function sortModelsByRecency<T extends { provider: string; id: string }>(
  models: readonly T[],
  recency: ModelRecency
): T[] {
  const lastUsed = (model: T): number => recency[modelRecencyKey(model)] ?? Number.NEGATIVE_INFINITY
  return models
    .map((model, index) => ({ model, index, used: lastUsed(model) }))
    .sort((a, b) => (b.used === a.used ? a.index - b.index : b.used - a.used))
    .map(({ model }) => model)
}
