import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelInfo } from '@shared/types'
import type { ModelParameter, ProviderApi, ProviderModel, ProviderProbeResult, ProviderProfile, SaveProviderInput } from '@shared/providers'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'

export interface ProviderDraft extends ProviderProfile {
  apiKey: string
  selectedModel: string
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
    request.current++
    setBusy(null); setError(''); setProbe(null)
    if (!profile) {
      setDraft({ id: '', name: '', api: 'openai-completions', baseUrl: '', hasApiKey: false,
        models: [], apiKey: '', selectedModel: '' })
      return
    }
    const selected = profile.models.find(model => settings.model === `${profile.id}/${model.id}` || (settings.provider === profile.id && settings.model === model.id))
    setDraft({ ...profile, apiKey: '', selectedModel: selected?.id ?? profile.models[0]?.id ?? '' })
  }

  const cancel = () => { request.current++; setDraft(null); setBusy(null); setProbe(null); setError('') }
  const change = (patch: Partial<ProviderDraft>) => {
    setDraft(current => current ? { ...current, ...patch } : current)
    setProbe(null); setError('')
  }
  const changeModel = (field: ModelParameter, value: ProviderModel[ModelParameter]) => {
    if (!draft?.selectedModel) return
    const model = draft.models.find(model => model.id === draft.selectedModel) ?? { id: draft.selectedModel }
    const next = { ...model, [field]: value, sources: { ...model.sources, [field]: 'manual' as const } }
    change({ models: [...draft.models.filter(model => model.id !== next.id), next] })
  }

  const run = async (operation: 'models' | 'probe' | 'save') => {
    if (!draft || busy) return
    const sequence = ++request.current
    setBusy(operation); setError('')
    const connection = { id: draft.id || undefined, api: draft.api, baseUrl: draft.baseUrl, apiKey: draft.apiKey || undefined }
    try {
      if (operation === 'models') {
        const fetched = await window.pi.providers.models(connection)
        if (request.current !== sequence) return
        setDraft({ ...draft, models: fetched, selectedModel: fetched.some(model => model.id === draft.selectedModel) ? draft.selectedModel : fetched[0]?.id ?? '' })
        setProbe(null)
        if (!fetched.length) setError(t('The provider returned no chat models. Enter a model ID manually.'))
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
          const values = draft.models.some(model => model.id === draft.selectedModel) ? draft.models : [...draft.models, { id: draft.selectedModel }]
          const input: SaveProviderInput = { ...connection, name: draft.name, revision: draft.revision,
            models: values, selectedModel: draft.selectedModel }
          const result = await store.saveProvider(input)
          applied = result.applied
          if (request.current !== sequence) return
          setConfigured(current => [...current.filter(provider => provider.id !== result.provider.id), result.provider])
          applyError = result.applyError
        }
        if (request.current !== sequence) return
        setDraft(null)
        store.showToast(applyError
          ? `${t('Provider saved, but the current session could not switch')}: ${applyError}`
          : t(applied ? 'Provider saved and activated' : 'Provider saved for new conversations'), applyError ? 'warning' : 'info')
      }
    } catch (error) {
      if (request.current === sequence) setError(error instanceof Error ? error.message : String(error))
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

  return { providers, loading, draft, busy, probe, error, edit, cancel, change, changeModel, remove,
    fetchModels: () => void run('models'), test: () => void run('probe'), save: () => void run('save') }
}
