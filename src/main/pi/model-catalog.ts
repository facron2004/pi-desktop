import { app } from 'electron'
import { readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * What a model says about reasoning effort.
 *
 * This is deliberately a local read of Pi's own data files instead of an
 * import of `@earendil-works/pi-coding-agent`: that package pulls the whole
 * agent bundle in, and the first picker render paid several seconds for it.
 * `models.json` and the generated provider catalogs carry the same
 * `reasoning`/`thinkingLevelMap` fields, and reading them is a few
 * milliseconds.
 */
export interface ThinkingModel {
  reasoning?: boolean
  thinkingLevelMap?: Record<string, unknown>
}

interface ModelCatalogOptions {
  /** Directory of Pi's generated provider catalogs. */
  builtinDirectory?: string
  /** Pi's models.json. */
  modelsFile?: string
}

interface ProviderRules {
  models: Map<string, ThinkingModel>
  overrides: Map<string, ThinkingModel>
}

const EXTENDED_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

let builtinCatalogPromise: Promise<Map<string, ThinkingModel>> | undefined
let modelsFilePromise: Promise<Map<string, ProviderRules>> | undefined
let loadedModelsFile: string | undefined
const levelCache = new Map<string, string[]>()

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function thinkingLevelMap(value: unknown): Record<string, unknown> | undefined {
  const raw = record(value)
  return raw ? { ...raw } : undefined
}

function defaultBuiltinDirectory(): string {
  return path.join(
    app.getAppPath(),
    'node_modules',
    '@earendil-works',
    'pi-ai',
    'dist',
    'providers',
    'data'
  )
}

function defaultModelsFile(): string {
  const env = process.env.PI_CODING_AGENT_DIR
  const directory = env && env.trim() ? path.resolve(env.trim()) : path.join(os.homedir(), '.pi', 'agent')
  return path.join(directory, 'models.json')
}

async function loadBuiltinCatalog(directory: string): Promise<Map<string, ThinkingModel>> {
  const models = new Map<string, ThinkingModel>()
  try {
    const files = await readdir(directory)
    for (const file of files) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue
      let data: unknown
      try {
        data = JSON.parse((await readFile(path.join(directory, file), 'utf8')).replace(/^\uFEFF/, ''))
      } catch {
        continue
      }
      const groups = record(data)
      if (!groups) continue
      for (const group of Object.values(groups)) {
        const entries = record(group)
        if (!entries) continue
        for (const value of Object.values(entries)) {
          const raw = record(value)
          if (!raw || typeof raw.id !== 'string' || typeof raw.provider !== 'string') continue
          const key = `${raw.provider}\n${raw.id}`
          if (!models.has(key)) {
            models.set(key, {
              reasoning: raw.reasoning === true,
              thinkingLevelMap: thinkingLevelMap(raw.thinkingLevelMap)
            })
          }
        }
      }
    }
  } catch {
    // A custom Pi installation without the bundled catalog is not an error.
  }
  return models
}

async function loadModelsFile(file: string): Promise<Map<string, ProviderRules>> {
  const providers = new Map<string, ProviderRules>()
  try {
    const data = record(JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')))
    const entries = record(data?.providers)
    if (!entries) return providers
    for (const [providerId, value] of Object.entries(entries)) {
      const config = record(value)
      if (!config) continue
      const models = new Map<string, ThinkingModel>()
      for (const entry of Array.isArray(config.models) ? config.models : []) {
        const raw = record(entry)
        if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) continue
        models.set(raw.id, {
          reasoning: raw.reasoning === true,
          thinkingLevelMap: thinkingLevelMap(raw.thinkingLevelMap)
        })
      }
      const overrides = new Map<string, ThinkingModel>()
      const overrideEntries = record(config.modelOverrides)
      for (const [modelId, entry] of Object.entries(overrideEntries ?? {})) {
        const raw = record(entry)
        if (!raw) continue
        overrides.set(modelId, {
          reasoning: typeof raw.reasoning === 'boolean' ? raw.reasoning : undefined,
          thinkingLevelMap: thinkingLevelMap(raw.thinkingLevelMap)
        })
      }
      providers.set(providerId, { models, overrides })
    }
  } catch {
    // Missing or unreadable models.json just means "no local override".
  }
  return providers
}

function getBuiltinCatalog(directory: string): Promise<Map<string, ThinkingModel>> {
  builtinCatalogPromise ??= loadBuiltinCatalog(directory)
  return builtinCatalogPromise
}

function getModelsFile(file: string): Promise<Map<string, ProviderRules>> {
  if (!modelsFilePromise || loadedModelsFile !== file) {
    loadedModelsFile = file
    modelsFilePromise = loadModelsFile(file)
  }
  return modelsFilePromise
}

async function lookupModel(
  provider: string,
  modelId: string,
  options: ModelCatalogOptions
): Promise<ThinkingModel | undefined> {
  const providers = await getModelsFile(options.modelsFile ?? defaultModelsFile())
  const config = providers.get(provider)
  let rule = config?.models.get(modelId)
  if (!rule) {
    const builtin = await getBuiltinCatalog(options.builtinDirectory ?? defaultBuiltinDirectory())
    rule = builtin.get(`${provider}\n${modelId}`)
  }
  const override = config?.overrides.get(modelId)
  if (override) {
    rule = {
      reasoning: override.reasoning ?? rule?.reasoning ?? false,
      thinkingLevelMap: override.thinkingLevelMap
        ? { ...(rule?.thinkingLevelMap ?? {}), ...override.thinkingLevelMap }
        : rule?.thinkingLevelMap
    }
  }
  return rule
}

/** Pi's own rule: reasoning models offer off through high unless mapped out. */
export function supportedThinkingLevels(model: ThinkingModel): string[] {
  if (!model.reasoning) return ['off']
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

/** Read Pi's supported effort list from its local data, without starting an agent. */
export async function getModelThinkingLevels(
  provider: string,
  modelId: string,
  options: ModelCatalogOptions = {}
): Promise<string[]> {
  if (!provider.trim() || !modelId.trim()) return []
  const key = `${provider}\n${modelId}`
  const cached = levelCache.get(key)
  if (cached) return cached
  const model = await lookupModel(provider, modelId, options)
  const levels = model ? supportedThinkingLevels(model) : []
  levelCache.set(key, levels)
  return levels
}

/** Re-read local catalogs after the provider editor changes models.json. */
export function invalidateModelThinkingLevels(): void {
  builtinCatalogPromise = undefined
  modelsFilePromise = undefined
  loadedModelsFile = undefined
  levelCache.clear()
}
