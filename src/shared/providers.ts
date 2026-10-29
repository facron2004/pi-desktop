export type ProviderApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'

export type ParameterSource = 'upstream' | 'catalog' | 'saved' | 'manual'
export type ModelParameter = 'name' | 'contextWindow' | 'maxTokens' | 'reasoning' | 'input' | 'cost'

export interface ProviderModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: ('text' | 'image')[]
  /** USD per million tokens; omitted prices are unknown. */
  cost?: Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite', number>>
  sources?: Partial<Record<ModelParameter, ParameterSource>>
}

export interface ProviderProfile {
  id: string
  name: string
  api: ProviderApi
  baseUrl: string
  hasApiKey: boolean
  models: ProviderModel[]
  revision?: string
  /** Providers supplied by Pi login/extensions keep their existing authentication. */
  external?: boolean
}

export interface ProviderConnection {
  id?: string
  api: ProviderApi
  baseUrl: string
  /** Empty means keep the existing credential; stored keys never cross back to the renderer. */
  apiKey?: string
}

export interface SaveProviderInput extends ProviderConnection {
  name: string
  revision?: string
  models: ProviderModel[]
  selectedModel: string
}

export interface ProviderProbeResult {
  ok: boolean
  latencyMs: number
  stage: 'models' | 'inference'
  error?: string
}
