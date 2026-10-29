import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ProviderModel } from '@shared/providers'
import { parseModel, record } from './metadata'

let catalogRequest: Promise<ProviderModel[]> | undefined

export function loadModelCatalog(directory: string): Promise<ProviderModel[]> {
  catalogRequest ??= readCatalog(directory)
  return catalogRequest
}

async function readCatalog(directory: string): Promise<ProviderModel[]> {
  try {
    const preferred = ['openai.json', 'anthropic.json', 'google.json', 'deepseek.json']
    const files = (await readdir(directory)).filter(name => name.endsWith('.json') && !name.startsWith('.'))
      .sort((a, b) => {
        const rank = (name: string) => preferred.includes(name) ? preferred.indexOf(name) : preferred.length
        return rank(a) - rank(b) || a.localeCompare(b)
      })
    const groups = await Promise.all(files.map(async file => {
      const data: unknown = JSON.parse(await readFile(path.join(directory, file), 'utf8'))
      return Object.values(record(data)).flatMap(group => Object.values(record(group)))
    }))
    const models = new Map<string, ProviderModel>()
    for (const value of groups.flat()) {
      const model = parseModel(value, 'catalog')
      if (model && !models.has(model.id)) models.set(model.id, model)
    }
    return [...models.values()]
  } catch {
    // The upstream catalog still works when a custom Pi installation has no bundled catalog.
    return []
  }
}
