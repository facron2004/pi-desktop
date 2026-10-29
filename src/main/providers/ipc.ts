import { app, ipcMain } from 'electron'
import os from 'node:os'
import path from 'node:path'
import type { ProviderConnection, SaveProviderInput } from '@shared/providers'
import type { PiState } from '@shared/types'
import type { IpcContext } from '../ipc'
import { loadModelCatalog } from './catalog'
import { fetchProviderModels, probeProvider, safeError } from './network'
import { ProviderStore } from './store'

export function registerProviderIpc({ runtime, settings }: IpcContext): void {
  const store = new ProviderStore(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'))
  const catalogDirectory = path.join(app.getAppPath(), 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data')
  ipcMain.handle('providers:list', () => store.list())
  ipcMain.handle('providers:models', async (_event, connection: ProviderConnection) => {
    const key = store.key(connection)
    try {
      return await fetchProviderModels(connection, key, await loadModelCatalog(catalogDirectory))
    } catch (error) { throw new Error(safeError(error, key)) }
  })
  ipcMain.handle('providers:probe', async (_event, connection: ProviderConnection, modelId?: string) => {
    try { return await probeProvider(connection, store.key(connection), modelId) }
    catch (error) { return { ok: false, latencyMs: 0, stage: modelId ? 'inference' : 'models', error: safeError(error, connection.apiKey) } }
  })
  ipcMain.handle('providers:save', async (_event, input: SaveProviderInput) => {
    input = { ...input, selectedModel: input.selectedModel.trim() }
    const provider = store.save(input)
    const updated = settings.patch({ provider: provider.id, model: `${provider.id}/${input.selectedModel}` })
    let applied = false
    let applyError: string | undefined
    if (runtime.isRunning) {
      try {
        const state = await runtime.request<PiState>('get_state')
        if (!state.isStreaming) {
          await runtime.request('prompt', { message: '/desktop-refresh-models' })
          const latest = await runtime.request<PiState>('get_state')
          if (!latest.isStreaming) {
            await runtime.request('set_model', { provider: provider.id, modelId: input.selectedModel })
            applied = true
          }
        }
      } catch (error) { applyError = safeError(error) }
    }
    return { provider, settings: updated, applied, applyError }
  })
  ipcMain.handle('providers:remove', (_event, id: string) => {
    if (typeof id !== 'string') throw new Error('Invalid provider ID')
    store.remove(id)
    const current = settings.get()
    const selected = current.provider === id || Boolean(current.model?.startsWith(`${id}/`))
    return { settings: selected ? settings.patch({ provider: undefined, model: undefined }) : current }
  })
}
