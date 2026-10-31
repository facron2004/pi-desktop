import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelInfo } from '@shared/types'
import type { ModelParameter, ProviderApi, ProviderModel, ProviderProbeResult, ProviderProfile, SaveProviderInput } from '@shared/providers'
import { mergeFetchedModels } from '@shared/provider-models'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'

export interface EditorModel extends ProviderModel {
  clientKey: string
}

export interface ProviderDraft extends Omit<ProviderProfile, 'models'> {
  apiKey: string
  selectedModel: string
  models: EditorModel[]
}

function stamp(models: ProviderModel[]): EditorModel[] {
  return models.map(model => ({ ...model, enabled: model.enabled !== false, clientKey: crypto.randomUUID() }))
}

function mergeEditorModels(existing: EditorModel[], fetched: ProviderModel[]): EditorModel[] {
  const merged = mergeFetchedModels(existing, fetched)
  const keys = new Map(existing.filter(model => model.id).map(model => [model.id, model.clientKey]))
  const blanks = existing.filter(model => !model.id).map(model => model.clientKey)
  let blank = 0
  return merged.map(model => ({
    ...model,
    clientKey: model.id ? keys.get(model.id) ?? crypto.randomUUID() : blanks[blank++] ?? crypto.randomUUID()
  }))
}

function storedModel(model: EditorModel): ProviderModel | null {
  const id = model.id.trim()
  if (!id) return null
  const { clientKey, sources, ...rest } = model
  void clientKey
  void sources
  return { ...rest, id, enabled: model.enabled !== false }
}

function fromPi(models: ModelInfo[]): ProviderProfile[] {
  const groups = new Map<string, ProviderProfile>()
  for (const model of models) {
    let provider = groups.get(model.provider)
    if (!provider) {
      provider = { id: model.provider, name: model.provider, api: model.api as ProviderApi,
        baseUrl: model.baseUrl ?? '', hasApiKey: false, models: [], external: true }
      groups.set(model.provider, provider)
    }
    provider.models.push({ id: model.id, name: model.name, contextWindow: model.contextWindow,
      maxTokens: model.maxTokens, reasoning: model.reasoning, input: model.input.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image'),
      sources: { name: 'saved', contextWindow: 'saved', maxTokens: 'saved', reasoning: 'saved', input: 'saved' } })
  }
  return [...groups.values()]
}

export function useProviders() {
  const models = useAppStore(state => state.models)
  const settings = useAppStore(state => state.settings)
  const t = useT()
  const [configured, setConfigured] = useState<ProviderProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<ProviderDraft | null>(null)
  const [busy, setBusy] = useState<'models' | 'probe' | 'save' | null>(null)
  const [probe, setProbe] = useState<ProviderProbeResult | null>(null)
  const request = useRef(0)
  const editGeneration = useRef(0)
  const loadedKey = useRef('')

  useEffect(() => {
    let active = true
    window.pi.providers.list().then(value => { if (active) setConfigured(value) })
      .catch(error => { if (active) setError(String(error instanceof Error ? error.message : error)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false; request.current++ }
  }, [])

  const providers = useMemo(() => {
    const ids = new Set(configured.map(provider => provider.id))
    const available = fromPi(models)
    return [...configured.map(provider => {
      const native = available.find(value => value.id === provider.id)
      return !provider.models.length && native ? { ...provider, models: native.models, api: native.api, baseUrl: provider.baseUrl || native.baseUrl } : provider
    }), ...available.filter(provider => !ids.has(provider.id))]
  }, [configured, models])

  const edit = (profile?: ProviderProfile) => {
    const sequence = ++editGeneration.current
    loadedKey.current = ''
    setBusy(null); setError(''); setProbe(null)
    if (!profile) {
      setDraft({ id: '', name: '', api: 'openai-completions', baseUrl: '', hasApiKey: false,
        models: [], apiKey: '', selectedModel: '' })
      return
    }
    const models = stamp(profile.models)
    const selected = models.find(model => settings.model === `${profile.id}/${model.id}` || (settings.provider === profile.id && settings.model === model.id))
    const fallback = models.find(model => model.enabled !== false)
    const saved = profile.external ? '' : profile.apiKey?.trim() ?? ''
    loadedKey.current = saved
    setDraft({ ...profile, models, apiKey: saved, selectedModel: selected?.id ?? fallback?.id ?? '' })
    if (!saved && !profile.external && profile.hasApiKey && profile.id) {
      window.pi.providers.savedKey(profile.id).then(apiKey => {
        if (editGeneration.current !== sequence) return
        loadedKey.current = apiKey
        // A key typed before this returns is the user's edit, not a blank field waiting to be filled.
        setDraft(current => current && current.id === profile.id && !current.apiKey.trim() ? { ...current, apiKey } : current)
      }).catch(() => { /* a blank field still means keep the stored key */ })
    }
  }

  const cancel = () => { editGeneration.current++; request.current++; setDraft(null); setBusy(null); setProbe(null); setError('') }
  const change = (patch: Partial<ProviderDraft>) => {
    setDraft(current => current ? { ...current, ...patch } : current)
    setProbe(null); setError('')
  }
  const patchModel = (clientKey: string, patch: Partial<ProviderModel>, manual: ModelParameter[] = []) => {
    setDraft(current => {
      if (!current) return current
      let selectedModel = current.selectedModel
      const models = current.models.map(model => {
        if (model.clientKey !== clientKey) return model
        const next: EditorModel = { ...model, ...patch, sources: model.sources ? { ...model.sources } : undefined }
        for (const field of manual) next.sources = { ...next.sources, [field]: 'manual' }
        if (patch.id !== undefined && model.id === current.selectedModel) selectedModel = patch.id
        else if (patch.id?.trim() && !current.selectedModel.trim() && next.enabled !== false) selectedModel = patch.id
        return next
      })
      return { ...current, models, selectedModel }
    })
    setProbe(null)
    setError('')
  }

  const toggleModel = (clientKey: string) => {
    setDraft(current => {
      if (!current) return current
      const models = current.models.map(model => model.clientKey === clientKey ? { ...model, enabled: model.enabled === false } : model)
      const toggled = models.find(model => model.clientKey === clientKey)
      const stillSelected = models.some(model => model.enabled !== false && model.id.trim() && model.id === current.selectedModel)
      const selectedModel = stillSelected
        ? current.selectedModel
        : toggled && toggled.enabled !== false && toggled.id.trim()
          ? toggled.id
          : models.find(model => model.enabled !== false && model.id.trim())?.id ?? ''
      return { ...current, models, selectedModel }
    })
    setProbe(null)
    setError('')
  }

  const makeDefault = (clientKey: string) => {
    setDraft(current => {
      if (!current) return current
      const model = current.models.find(item => item.clientKey === clientKey)
      if (!model?.id.trim() || (!current.external && model.enabled === false)) return current
      return { ...current, selectedModel: model.id }
    })
    setProbe(null)
    setError('')
  }

  const addModel = (clientKey: string) => {
    setDraft(current => current ? {
      ...current,
      models: [...current.models, { id: '', enabled: true, clientKey }]
    } : current)
    setProbe(null)
    setError('')
  }

  const removeModel = (clientKey: string) => {
    setDraft(current => {
      if (!current) return current
      const models = current.models.filter(model => model.clientKey !== clientKey)
      const selectedModel = models.some(model => model.enabled !== false && model.id === current.selectedModel)
        ? current.selectedModel
        : models.find(model => model.enabled !== false && model.id.trim())?.id ?? ''
      return { ...current, models, selectedModel }
    })
    setProbe(null)
    setError('')
  }

  const run = async (operation: 'models' | 'probe' | 'save') => {
    if (!draft || busy) return
    const sequence = ++request.current
    setBusy(operation); setError('')
    const typedKey = draft.apiKey.trim()
    // The field is prefilled with the saved key. Sending it back would rewrite
    // env references and escaping, so an untouched value stays on disk.
    const connection = { id: draft.id || undefined, api: draft.api, baseUrl: draft.baseUrl,
      apiKey: typedKey && typedKey !== loadedKey.current ? typedKey : undefined }
    try {
      if (operation === 'models') {
        const fetched = await window.pi.providers.models(connection)
        if (request.current !== sequence) return
        if (!fetched.length) {
          setError(t('The provider returned no chat models. Enter a model ID manually.'))
          return
        }
        const models = mergeEditorModels(draft.models, fetched)
        const selectedModel = models.some(model => model.id === draft.selectedModel && model.enabled !== false)
          ? draft.selectedModel
          : models.find(model => model.enabled !== false && model.id)?.id ?? ''
        setDraft({ ...draft, models, selectedModel })
        setProbe(null)
      } else if (operation === 'probe') {
        const result = await window.pi.providers.probe(connection, draft.selectedModel || undefined)
        if (request.current === sequence) setProbe(result)
      } else {
        const store = useAppStore.getState()
        let applied = false
        let applyError: string | undefined
        if (draft.external) {
          await store.updateSettings({ provider: draft.id, model: `${draft.id}/${draft.selectedModel}` })
          const target = models.find(model => model.provider === draft.id && model.id === draft.selectedModel)
          if (target && !store.isStreaming && store.status.phase === 'ready') {
            await store.setModel(target)
            applied = useAppStore.getState().piState?.model?.id === target.id && useAppStore.getState().piState?.model?.provider === target.provider
          }
        } else {
          const values = draft.models.flatMap(model => {
            const stored = storedModel(model)
            return stored ? [stored] : []
          })
          const selectedModel = values.find(model => model.id === draft.selectedModel && model.enabled !== false)?.id
            ?? values.find(model => model.enabled !== false)?.id
          if (!selectedModel) throw new Error('Enable at least one model')
          const input: SaveProviderInput = { ...connection, name: draft.name, revision: draft.revision,
            models: values, selectedModel }
          const result = await store.saveProvider(input)
          applied = result.applied
          if (request.current !== sequence) return
          const keptKey = typedKey || loadedKey.current
          setConfigured(current => [...current.filter(provider => provider.id !== result.provider.id),
            keptKey ? { ...result.provider, apiKey: keptKey } : result.provider])
          applyError = result.applyError
        }
        if (request.current !== sequence) return
        setDraft(null)
        store.showToast(applyError
          ? `${t('Provider saved, but the current session could not switch')}: ${applyError}`
          : t(applied ? 'Provider saved and activated' : 'Provider saved for new conversations'), applyError ? 'warning' : 'info')
      }
    } catch (error) {
      if (request.current === sequence) setError(t(error instanceof Error ? error.message : String(error)))
    } finally {
      if (request.current === sequence) setBusy(null)
    }
  }

  const remove = async (provider: ProviderProfile) => {
    if (!provider.revision) return
    setError('')
    try {
      const result = await window.pi.providers.remove(provider.id)
      setConfigured(current => current.filter(item => item.id !== provider.id))
      useAppStore.setState({ settings: result.settings })
      useAppStore.getState().showToast(t('Provider removed'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return { providers, loading, draft, busy, probe, error, edit, cancel, change, patchModel, toggleModel, makeDefault, addModel, removeModel, remove,
    fetchModels: () => void run('models'), test: () => void run('probe'), save: () => void run('save') }
}
