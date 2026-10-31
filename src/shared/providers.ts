export type ProviderApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'

export type ParameterSource = 'upstream' | 'catalog' | 'saved' | 'manual'
export type ModelParameter = 'name' | 'contextWindow' | 'maxTokens' | 'reasoning' | 'input' | 'output' | 'tools' | 'cost'

export interface ProviderModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: ('text' | 'image')[]
  /** What the model can emit. Image-only catalogs are not chat models, but the editor still shows them. */
  output?: ('text' | 'image')[]
  /** Whether the upstream catalog says the model accepts tool calls. */
  tools?: boolean
  /** USD per million tokens; omitted prices are unknown. */
  cost?: Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite', number>>
  sources?: Partial<Record<ModelParameter, ParameterSource>>
  /**
   * Whether the model is offered in the picker. Omitted means enabled.
   * Disabled models stay editable, but they are not written to Pi's models.json:
   * a model listed there is a model Pi will offer.
   */
  enabled?: boolean
}

export interface ProviderProfile {
  id: string
  name: string
  api: ProviderApi
  baseUrl: string
  hasApiKey: boolean
  /**
   * Effective saved key, included by `list()` so the editor can show it.
   * `save()` omits it. Absent for Pi sign-in and for `!` credential commands.
   */
  apiKey?: string
  models: ProviderModel[]
  revision?: string
  /** Providers supplied by Pi login/extensions keep their existing authentication. */
  external?: boolean
}

export interface ProviderConnection {
  id?: string
  api: ProviderApi
  baseUrl: string
  /** Empty means keep the existing credential. `save()` results stay redacted; `list()` carries the key for the editor. */
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
