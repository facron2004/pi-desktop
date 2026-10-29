import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ProviderApi, ProviderConnection, ProviderModel, ProviderProfile, SaveProviderInput } from '@shared/providers'
import { parseModel, record } from './metadata'
import { normalizeConnection } from './network'

function readObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {}
  let value: unknown
  try { value = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) }
  catch { throw new Error(`Could not read ${path.basename(file)}. Check its JSON before editing providers.`) }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Pi configuration must be a JSON object')
  return value as Record<string, unknown>
}

function writeObject(file: string, data: Record<string, unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, file)
}

function revision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function providerMap(document: Record<string, unknown>): Record<string, unknown> {
  if (document.providers !== undefined && (!document.providers || typeof document.providers !== 'object' || Array.isArray(document.providers))) {
    throw new Error('The providers field in models.json must be an object')
  }
  return record(document.providers)
}

/** Resolve interpolation, but never run a credential command from the settings UI. */
function resolveKey(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.startsWith('!')) return undefined
  return value.replace(/\$\$|\$!|\$\{([A-Za-z_][A-Za-z_0-9]*)\}|\$([A-Za-z_][A-Za-z_0-9]*)/g,
    (match, braced: string | undefined, plain: string | undefined) => match === '$$' ? '$' : match === '$!' ? '!' : process.env[braced ?? plain ?? ''] ?? '')
}

function literalKey(value: string): string {
  const escaped = value.replaceAll('$', () => '$$')
  return escaped.startsWith('!') ? `$${escaped}` : escaped
}

function modelForDisk(model: ProviderModel): Record<string, unknown> {
  const value: Record<string, unknown> = { id: model.id }
  for (const field of ['name', 'contextWindow', 'maxTokens', 'reasoning', 'input', 'cost'] as const) {
    if (model[field] !== undefined) value[field] = model[field]
  }
  // Pi requires every cost key when cost is set. Missing prices keep its defaults.
  if (model.cost) value.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...model.cost }
  return value
}

function validateModels(values: ProviderModel[], selected: string): ProviderModel[] {
  if (!Array.isArray(values) || !values.length || values.length > 10_000) throw new Error('Choose at least one model')
  const seen = new Set<string>()
  const models = values.map(value => {
    if (!value || typeof value.id !== 'string' || !value.id.trim() || seen.has(value.id.trim())) throw new Error('Model IDs must be nonempty and unique')
    seen.add(value.id.trim())
    for (const field of ['contextWindow', 'maxTokens'] as const) {
      if (value[field] !== undefined && (!Number.isSafeInteger(value[field]) || value[field]! <= 0)) throw new Error(`${field} must be a positive integer`)
    }
    if (value.reasoning !== undefined && typeof value.reasoning !== 'boolean') throw new Error('Reasoning must be true or false')
    if (value.cost && Object.values(value.cost).some(price => typeof price !== 'number' || !Number.isFinite(price) || price < 0)) throw new Error('Model prices must be nonnegative numbers')
    const model = parseModel(value, 'saved')
    if (!model) throw new Error('Invalid model configuration')
    return model
  })
  if (!models.some(model => model.id === selected.trim())) throw new Error('The selected model is not in the provider model list')
  return models
}

export class ProviderStore {
  readonly file: string
  private readonly authFile: string

  constructor(directory: string) {
    this.file = path.join(directory, 'models.json')
    this.authFile = path.join(directory, 'auth.json')
  }

  private configured(id?: string): Record<string, unknown> {
    const providers = providerMap(readObject(this.file))
    return id && Object.hasOwn(providers, id) ? record(providers[id]) : {}
  }

  private credential(id?: string): Record<string, unknown> {
    const credentials = readObject(this.authFile)
    return id && Object.hasOwn(credentials, id) ? record(credentials[id]) : {}
  }

  list(): ProviderProfile[] {
    const providers = providerMap(readObject(this.file))
    return Object.entries(providers).map(([id, value]) => this.profile(id, record(value)))
  }

  private profile(id: string, raw: Record<string, unknown>): ProviderProfile {
    const models = (Array.isArray(raw.models) ? raw.models : []).map(model => parseModel(model, 'saved')).filter((model): model is ProviderModel => model !== null)
    const auth = this.credential(id)
    const api = typeof raw.api === 'string' ? raw.api : typeof record((raw.models as unknown[] | undefined)?.[0]).api === 'string' ? String(record((raw.models as unknown[])[0]).api) : 'openai-completions'
    return {
      id, name: typeof raw.name === 'string' ? raw.name : id,
      api: api as ProviderApi,
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
      hasApiKey: Boolean(raw.apiKey || (auth.type === 'api_key' && auth.key)),
      models, revision: revision(raw),
      external: Boolean(auth.type && auth.type !== 'api_key') || (!raw.api && !models.length) || !['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].includes(api)
    }
  }

  key(connection: ProviderConnection): string {
    if (connection.apiKey?.trim()) return connection.apiKey.trim()
    const auth = this.credential(connection.id)
    const key = auth.type === 'api_key' && typeof auth.key === 'string' ? auth.key : resolveKey(this.configured(connection.id).apiKey)
    if (!key) throw new Error('Enter an API key. Pi sign-in and credential commands remain managed by Pi.')
    return key
  }

  save(input: SaveProviderInput): ProviderProfile {
    const connection = normalizeConnection(input)
    const name = input.name?.trim()
    if (!name) throw new Error('Enter a provider name')
    const document = readObject(this.file)
    const providers = providerMap(document)
    const stem = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provider'
    const id = input.id || `${stem.slice(0, 40)}-${randomUUID().slice(0, 8)}`
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(id) || ['constructor', 'prototype'].includes(id)) throw new Error('Invalid provider ID')
    const previous = Object.hasOwn(providers, id) ? record(providers[id]) : undefined
    if (previous && input.revision !== revision(previous)) throw new Error('Provider configuration changed. Reload it before saving.')
    const models = validateModels(input.models, input.selectedModel)
    const key = this.key({ ...connection, id: input.id })
    const oldModels = new Map((Array.isArray(previous?.models) ? previous.models : []).map(value => [record(value).id, record(value)]))
    const next = {
      ...previous, name, baseUrl: connection.baseUrl, api: connection.api,
      apiKey: input.apiKey?.trim() ? literalKey(key) : previous?.apiKey ?? literalKey(key),
      models: models.map(model => {
        const old = { ...oldModels.get(model.id) }
        if (previous && previous.api !== connection.api) delete old.api
        if (previous && previous.baseUrl !== connection.baseUrl) delete old.baseUrl
        const cost = record(old.cost)
        for (const field of ['name', 'contextWindow', 'maxTokens', 'reasoning', 'input', 'cost']) delete old[field]
        const normalized = modelForDisk(model)
        if (normalized.cost) normalized.cost = { ...cost, ...record(normalized.cost) }
        return { ...old, ...normalized }
      })
    }
    writeObject(this.file, { ...document, providers: { ...providers, [id]: next } })
    // Stored API-key credentials precede models.json in Pi. Keep an explicitly
    // replaced key in sync without changing credentials belonging to other providers.
    if (input.apiKey?.trim() && this.credential(id).type === 'api_key') {
      const credentials = readObject(this.authFile)
      writeObject(this.authFile, { ...credentials, [id]: { ...record(credentials[id]), key } })
    }
    return this.profile(id, next)
  }
}
