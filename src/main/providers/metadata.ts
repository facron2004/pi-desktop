import type { ParameterSource, ProviderModel } from '@shared/providers'

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function positive(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value !== 'number' && typeof value !== 'string') continue
    const number = Number(value)
    if (Number.isSafeInteger(number) && number > 0) return number
  }
  return undefined
}

function supported(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : typeof record(value).supported === 'boolean'
    ? record(value).supported as boolean : undefined
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined
}

function modalities(value: unknown): ('text' | 'image')[] | undefined {
  const names = strings(value)
  if (!names) return undefined
  const list = [...new Set(names.filter((entry): entry is 'text' | 'image' => entry === 'text' || entry === 'image'))]
  return list.length ? list : undefined
}

function price(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  if (value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function parseCost(raw: Record<string, unknown>): ProviderModel['cost'] {
  const cost = record(raw.cost)
  const pricing = record(raw.pricing)
  const result: NonNullable<ProviderModel['cost']> = {}
  for (const [field, upstream] of [['input', 'prompt'], ['output', 'completion'], ['cacheRead', 'input_cache_read'], ['cacheWrite', 'input_cache_write']] as const) {
    const value = price(cost[field]) ?? (price(pricing[upstream]) === undefined ? undefined : Number((Number(pricing[upstream]) * 1_000_000).toPrecision(12)))
    if (value !== undefined) result[field] = value
  }
  return Object.keys(result).length ? result : undefined
}

/** Only explicit capability fields count; model-name substrings are not metadata. */
export function parseModel(value: unknown, source: ParameterSource = 'upstream'): ProviderModel | null {
  const raw = record(value)
  const id = typeof raw.id === 'string' ? raw.id : typeof raw.name === 'string' ? raw.name.replace(/^models\//, '') : ''
  if (!id.trim()) return null
  if (raw.type && !['chat', 'model'].includes(String(raw.type))) return null
  const methods = raw.supportedGenerationMethods
  if (Array.isArray(methods) && !methods.includes('generateContent')) return null
  const top = record(raw.top_provider)
  const limits = record(raw.limits)
  const capabilities = record(raw.capabilities)
  const architecture = record(raw.architecture)
  const model: ProviderModel = { id: id.trim() }
  const name = raw.display_name ?? raw.displayName ?? raw.name
  if (typeof name === 'string' && name.trim() && !name.startsWith('models/')) model.name = name.trim()
  model.contextWindow = positive(raw.contextWindow, raw.context_length, raw.context_window, raw.max_input_tokens, raw.inputTokenLimit, top.context_length, limits.context)
  // SenseNova names the output cap `max_output_length`, not `max_output_tokens`.
  model.maxTokens = positive(raw.maxTokens, raw.max_output_tokens, raw.max_completion_tokens, raw.max_tokens, raw.max_output_length, raw.outputTokenLimit, top.max_completion_tokens, limits.output)
  const parameters = strings(raw.supported_parameters)
  const features = strings(raw.supported_features)
  const thinking = record(capabilities.thinking)
  model.reasoning = supported(raw.reasoning) ?? supported(capabilities.reasoning) ?? supported(thinking)
  if (model.reasoning === undefined && Object.keys(record(thinking.types)).length) {
    model.reasoning = Object.entries(record(thinking.types)).some(([type, support]) => type !== 'disabled' && supported(support) === true)
  }
  // A feature list that omits reasoning is a real "no", not a missing field. Pi ignores thinkingLevelMap unless this is true.
  if (model.reasoning === undefined && (parameters || features)) {
    model.reasoning = [...(parameters ?? []), ...(features ?? [])].some(name => name === 'reasoning' || name === 'reasoning_effort')
  }
  const inputModalities = modalities(raw.input) ?? modalities(architecture.input_modalities) ?? modalities(raw.input_modalities)
  if (inputModalities) model.input = inputModalities
  else if (supported(capabilities.vision) !== undefined || supported(capabilities.image_input) !== undefined) {
    model.input = supported(capabilities.vision) || supported(capabilities.image_input) ? ['text', 'image'] : ['text']
  }
  model.output = modalities(raw.output) ?? modalities(raw.output_modalities) ?? modalities(architecture.output_modalities)
  model.tools = typeof raw.tools === 'boolean' ? raw.tools
    : features ? features.some(name => name === 'tools' || name === 'function_calling' || name === 'tool_choice') : undefined
  model.cost = parseCost(raw)
  model.sources = {}
  for (const field of ['name', 'contextWindow', 'maxTokens', 'reasoning', 'input', 'output', 'tools', 'cost'] as const) {
    if (model[field] !== undefined) model.sources[field] = source
    else delete model[field]
  }
  return model
}

export function enrichModels(values: unknown[], catalog: ProviderModel[]): ProviderModel[] {
  const known = new Map(catalog.map(model => [model.id, model]))
  const unique = new Map<string, ProviderModel>()
  for (const value of values) {
    const model = parseModel(value)
    if (!model || unique.has(model.id)) continue
    const reference = known.get(model.id)
    // A proxy's prices are its own. Never fill pricing from another provider's catalog.
    for (const field of ['name', 'contextWindow', 'maxTokens', 'reasoning', 'output', 'tools'] as const) {
      if (model[field] === undefined && reference?.[field] !== undefined) {
        Object.assign(model, { [field]: reference[field] })
        model.sources![field] = 'catalog'
      }
    }
    // Image support is additive. SenseNova's list has dropped `image` for models that still accept it.
    if (reference?.input?.includes('image') && !model.input?.includes('image')) {
      model.input = [...new Set<'text' | 'image'>([...(model.input ?? ['text']), 'image'])]
      model.sources!.input = model.sources!.input === 'upstream' ? 'catalog' : (model.sources!.input ?? 'catalog')
    } else if (model.input === undefined && reference?.input !== undefined) {
      model.input = reference.input
      model.sources!.input = 'catalog'
    }
    unique.set(model.id, model)
  }
  return [...unique.values()]
}
