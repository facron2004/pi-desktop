import type { ModelInfo } from './types'
import type { ModelParameter, ProviderModel, ProviderProfile } from './providers'

const FIELDS: ModelParameter[] = ['name', 'contextWindow', 'maxTokens', 'reasoning', 'input', 'output', 'tools', 'cost']

/**
 * Fold an upstream catalog into the editor list.
 * New models start enabled, so a fetch can be saved immediately.
 * A model the user already turned off, or a field they edited, stays as they left it.
 * Models the upstream no longer returns are kept: a manual row, or a transient omission, is not a deletion.
 */
export function mergeFetchedModels(existing: ProviderModel[], fetched: ProviderModel[]): ProviderModel[] {
  const previous = new Map(existing.filter(model => model.id).map(model => [model.id, model]))
  const seen = new Set<string>()
  const merged: ProviderModel[] = []
  for (const model of fetched) {
    if (!model.id || seen.has(model.id)) continue
    seen.add(model.id)
    const old = previous.get(model.id)
    if (!old) {
      merged.push({ ...model, enabled: true })
      continue
    }
    const next: ProviderModel = { ...model, enabled: old.enabled !== false, sources: { ...model.sources } }
    for (const field of FIELDS) {
      if (old.sources?.[field] === 'manual') {
        if (old[field] === undefined) delete next[field]
        else Object.assign(next, { [field]: old[field] })
        next.sources = { ...next.sources, [field]: 'manual' }
        continue
      }
      // A list that omits a field is not a deletion. Keep the length or capability already saved.
      if (next[field] === undefined && old[field] !== undefined) {
        Object.assign(next, { [field]: old[field] })
        if (old.sources?.[field]) next.sources = { ...next.sources, [field]: old.sources[field] }
      }
    }
    // A proxy list can publish a smaller cap than the model actually accepts. Don't shrink a saved one.
    if (typeof old.maxTokens === 'number' && typeof next.maxTokens === 'number' && old.maxTokens > next.maxTokens) {
      next.maxTokens = old.maxTokens
      if (old.sources?.maxTokens) next.sources = { ...next.sources, maxTokens: old.sources.maxTokens }
    }
    if (old.sources?.input !== 'manual' && old.input?.includes('image') && !next.input?.includes('image')) {
      next.input = [...new Set<'text' | 'image'>([...(next.input ?? ['text']), 'image'])]
      next.sources = { ...next.sources, input: 'saved' }
    }
    merged.push(next)
  }
  for (const model of existing) {
    if (!model.id || !seen.has(model.id)) merged.push(model)
  }
  return merged
}

/**
 * Saved models the picker can offer before Pi has loaded the latest providers.
 * Disabled rows stay out: a model Pi was not given is not selectable.
 */
export function modelsFromProfiles(profiles: ProviderProfile[]): ModelInfo[] {
  const models: ModelInfo[] = []
  for (const profile of profiles) {
    for (const model of profile.models) {
      if (!model.id || model.enabled === false) continue
      const cost = model.cost
        ? Object.fromEntries(
            Object.entries(model.cost).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
          )
        : undefined
      models.push({
        id: model.id,
        name: model.name || model.id,
        api: profile.api,
        provider: profile.id,
        baseUrl: profile.baseUrl || undefined,
        reasoning: model.reasoning === true,
        input: model.input?.length ? [...model.input] : ['text'],
        contextWindow: model.contextWindow ?? 0,
        maxTokens: model.maxTokens ?? 0,
        ...(cost && Object.keys(cost).length > 0 ? { cost } : {})
      })
    }
  }
  return models
}

/** Keep Pi's order and metadata, then append newly saved models it has not loaded yet. */
export function selectableModels(
  runtimeModels: ModelInfo[],
  catalogModels: ModelInfo[],
  disabledModelSpecs: string[]
): ModelInfo[] {
  const disabled = new Set(disabledModelSpecs)
  const seen = new Set<string>()
  const models: ModelInfo[] = []
  for (const model of [...runtimeModels, ...catalogModels]) {
    if (!model.id || !model.provider) continue
    const key = `${model.provider}/${model.id}`
    if (seen.has(key) || disabled.has(key)) continue
    seen.add(key)
    models.push(model)
  }
  return models
}

/**
 * The model saved as `provider/id`.
 * Provider ids do not contain a slash; a model id may, so only the first slash splits them.
 * A saved pair that is not in `models` yet still resolves, so the chip can show it
 * before Pi has published a list.
 */
export function resolveSavedModel(
  spec: string | undefined,
  providerHint: string | undefined,
  models: ModelInfo[]
): ModelInfo | undefined {
  const raw = spec?.trim()
  const slash = raw ? raw.indexOf('/') : -1
  const provider = slash > 0 ? raw!.slice(0, slash) : providerHint?.trim()
  const id = raw ? (slash > 0 ? raw.slice(slash + 1) : raw) : ''
  if (!provider || !id) return undefined
  const known = models.find((model) => model.provider === provider && model.id === id)
  if (known) return known
  return {
    id,
    name: id,
    api: '',
    provider,
    reasoning: false,
    input: ['text'],
    contextWindow: 0,
    maxTokens: 0
  }
}
