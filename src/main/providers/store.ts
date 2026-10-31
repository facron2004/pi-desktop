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

/** Capabilities Pi's models.json schema does not accept. They stay in the desktop sidecar. */
function withDesktopCapabilities(disk: ProviderModel, sidecar: ProviderModel): ProviderModel {
  const next: ProviderModel = { ...disk, sources: disk.sources ? { ...disk.sources } : {} }
  for (const field of ['tools', 'output'] as const) {
    if (next[field] === undefined && sidecar[field] !== undefined) {
      Object.assign(next, { [field]: sidecar[field] })
      next.sources = { ...next.sources, [field]: sidecar.sources?.[field] ?? 'saved' }
    }
  }
  return next
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
    if (value.tools !== undefined && typeof value.tools !== 'boolean') throw new Error('Tool support must be true or false')
    if (value.output !== undefined && (!Array.isArray(value.output) || !value.output.length || value.output.some(item => item !== 'text' && item !== 'image'))) {
      throw new Error('Output types must be text or image')
    }
    if (value.cost && Object.values(value.cost).some(price => typeof price !== 'number' || !Number.isFinite(price) || price < 0)) throw new Error('Model prices must be nonnegative numbers')
    const model = parseModel(value, 'saved')
    if (!model) throw new Error('Invalid model configuration')
    return { ...model, enabled: value.enabled !== false }
  })
  if (!models.some(model => model.id === selected.trim())) throw new Error('The selected model is not in the provider model list')
  if (!models.some(model => model.enabled !== false && model.id === selected.trim())) throw new Error('The selected model is not enabled')
  return models
}

export class ProviderStore {
  readonly file: string
  private readonly authFile: string
  /** Pi's schema rejects unknown model fields, and a listed model is selectable. Disabled models live here. */
  private readonly desktopFile: string

  constructor(directory: string) {
    this.file = path.join(directory, 'models.json')
    this.authFile = path.join(directory, 'auth.json')
    this.desktopFile = path.join(directory, 'models.desktop.json')
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
    return Object.entries(providers).map(([id, value]) => {
      const profile = this.profile(id, record(value))
      if (profile.external) return profile
      const apiKey = this.savedKey(id)
      return apiKey ? { ...profile, apiKey } : profile
    })
  }

  /** Editor catalog. A missing or unreadable file only hides disabled models; Pi's own list still loads. */
  private desktopDocument(): Record<string, unknown> | undefined {
    try { return readObject(this.desktopFile) }
    catch { return undefined }
  }

  private withDisabled(id: string, disk: ProviderModel[]): ProviderModel[] {
    const document = this.desktopDocument()
    if (!document) return disk
    const providers = record(document.providers)
    if (!Object.hasOwn(providers, id)) return disk
    const rawModels = record(providers[id]).models
    if (!Array.isArray(rawModels) || !rawModels.length) return disk
    const diskById = new Map(disk.map(model => [model.id, model]))
    const seen = new Set<string>()
    const models: ProviderModel[] = []
    for (const value of rawModels) {
      const parsed = parseModel(value, 'saved')
      if (!parsed || seen.has(parsed.id)) continue
      seen.add(parsed.id)
      const onDisk = diskById.get(parsed.id)
      // Presence in models.json is what Pi actually offers. A sidecar flag cannot
      // outvote that, and a model missing there is not selectable yet.
      // Pi's schema has no tools or output-modality fields, so those live only in the sidecar.
      if (record(value).enabled !== false && onDisk) models.push(withDesktopCapabilities(onDisk, parsed))
      else models.push({ ...parsed, enabled: false })
    }
    for (const model of disk) {
      if (!seen.has(model.id)) models.push(model)
    }
    return models
  }

  private forgetDesktop(id: string): void {
    if (!existsSync(this.desktopFile)) return
    try {
      const document = readObject(this.desktopFile)
      const providers = record(document.providers)
      if (!Object.hasOwn(providers, id)) return
      const rest = { ...providers }
      delete rest[id]
      writeObject(this.desktopFile, { ...document, providers: rest })
    } catch {
      // models.json no longer has the provider. A bad sidecar must not undo the removal.
    }
  }

  private profile(id: string, raw: Record<string, unknown>): ProviderProfile {
    const disk = (Array.isArray(raw.models) ? raw.models : []).map(model => parseModel(model, 'saved')).filter((model): model is ProviderModel => model !== null)
      .map(model => ({ ...model, enabled: true }))
    const models = this.withDisabled(id, disk)
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

  /** The key the editor shows. A `!` credential command is left for Pi to run; this UI does not. */
  savedKey(id: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(id) || ['constructor', 'prototype'].includes(id)) return ''
    const auth = this.credential(id)
    if (auth.type && auth.type !== 'api_key') return ''
    const key = auth.type === 'api_key' && typeof auth.key === 'string' ? auth.key : resolveKey(this.configured(id).apiKey)
    return key?.trim() ?? ''
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
    // Read the sidecar before either file changes. A corrupt catalog must not
    // truncate models.json and then fail while parking the disabled models.
    const desktopDocument = readObject(this.desktopFile)
    if (desktopDocument.providers !== undefined && (!desktopDocument.providers || typeof desktopDocument.providers !== 'object' || Array.isArray(desktopDocument.providers))) {
      throw new Error('The providers field in the desktop model list must be an object')
    }
    const desktopProviders = record(desktopDocument.providers)
    const parked = new Map((Array.isArray(record(desktopProviders[id]).models) ? record(desktopProviders[id]).models as unknown[] : []).map(value => [String(record(value).id), record(value)]))
    const oldModels = new Map((Array.isArray(previous?.models) ? previous.models : []).map(value => [record(value).id, record(value)]))
    const compose = (model: ProviderModel): { pi: Record<string, unknown>; desktop: Record<string, unknown> } => {
      const old = { ...parked.get(model.id), ...oldModels.get(model.id) }
      if (previous && previous.api !== connection.api) delete old.api
      if (previous && previous.baseUrl !== connection.baseUrl) delete old.baseUrl
      const cost = record(old.cost)
      for (const field of ['name', 'contextWindow', 'maxTokens', 'reasoning', 'input', 'output', 'tools', 'cost', 'enabled', 'sources']) delete old[field]
      const normalized = modelForDisk(model)
      if (normalized.cost) normalized.cost = { ...cost, ...record(normalized.cost) }
      const pi = { ...old, ...normalized }
      const desktop: Record<string, unknown> = { ...pi, enabled: model.enabled !== false }
      if (model.tools !== undefined) desktop.tools = model.tools
      if (model.output !== undefined) desktop.output = model.output
      return { pi, desktop }
    }
    const written = models.map(model => ({ enabled: model.enabled !== false, ...compose(model) }))
    const next = {
      ...previous, name, baseUrl: connection.baseUrl, api: connection.api,
      apiKey: input.apiKey?.trim() ? literalKey(key) : previous?.apiKey ?? literalKey(key),
      models: written.filter(model => model.enabled).map(model => model.pi)
    }
    writeObject(this.file, { ...document, providers: { ...providers, [id]: next } })
    writeObject(this.desktopFile, {
      ...desktopDocument,
      providers: { ...desktopProviders, [id]: { models: written.map(model => model.desktop) } }
    })
    // Stored API-key credentials precede models.json in Pi. Keep an explicitly
    // replaced key in sync without changing credentials belonging to other providers.
    if (input.apiKey?.trim() && this.credential(id).type === 'api_key') {
      const credentials = readObject(this.authFile)
      writeObject(this.authFile, { ...credentials, [id]: { ...record(credentials[id]), key } })
    }
    return this.profile(id, next)
  }

  /** Drop a provider written into models.json. Pi sign-in credentials stay. */
  remove(id: string): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(id)) throw new Error('Invalid provider ID')
    const document = readObject(this.file)
    const providers = providerMap(document)
    if (!Object.hasOwn(providers, id)) throw new Error('This provider is managed by Pi')
    const rest = { ...providers }
    delete rest[id]
    writeObject(this.file, { ...document, providers: rest })
    this.forgetDesktop(id)
    if (!existsSync(this.authFile)) return
    const credentials = readObject(this.authFile)
    if (record(credentials[id]).type !== 'api_key') return
    const remaining = { ...credentials }
    delete remaining[id]
    writeObject(this.authFile, remaining)
  }
}
