import type { ModelInfo } from '@shared/types'

/**
 * The display name of a model.
 *
 * The messages carry the raw model id, which reads like a slug
 * (`deepseek-v4-pro`). The model list knows the name the user picked in the
 * model menu, so that is what the conversation shows.
 */
export function modelName(models: ModelInfo[], id?: string): string {
  if (!id) return ''
  const model = models.find((item) => item.id === id)
  return model?.name || id
}
