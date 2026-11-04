import type { ModelInfo } from '@shared/types'

/** Lowercase, treat separators as spaces, so "sonnet 4" finds "claude-sonnet-4". */
export function normalizeModelSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_\-./:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every query token must match somewhere in name, id or provider. */
export function filterModels(models: readonly ModelInfo[], query: string): ModelInfo[] {
  const tokens = normalizeModelSearchText(query).split(' ').filter(Boolean)
  if (tokens.length === 0) return [...models]
  return models.filter((model) => {
    const haystack = normalizeModelSearchText(`${model.name ?? ''} ${model.id} ${model.provider}`)
    return tokens.every((token) => haystack.includes(token))
  })
}
