import type { ProviderApi, ProviderConnection, ProviderModel, ProviderProbeResult } from '@shared/providers'
import { enrichModels, record } from './metadata'

const APIS: ProviderApi[] = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']

export function normalizeConnection(input: ProviderConnection): ProviderConnection {
  if (!APIS.includes(input.api)) throw new Error('Unsupported API format')
  const url = new URL(input.baseUrl.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL must be an HTTP(S) API address without credentials or query parameters')
  }
  return { ...input, baseUrl: url.toString().replace(/\/+$/, '') }
}

function endpoint(connection: ProviderConnection, suffix: string): string {
  let base = connection.baseUrl
  if (connection.api === 'anthropic-messages' && !/\/v1$/.test(base)) base += '/v1'
  if (connection.api === 'google-generative-ai' && !/\/v1(?:beta)?$/.test(base)) base += '/v1beta'
  return `${base}/${suffix}`
}

function headers(connection: ProviderConnection, key: string): Record<string, string> {
  if (connection.api === 'anthropic-messages') {
    return { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
  }
  if (connection.api === 'google-generative-ai') return { 'x-goog-api-key': key, 'content-type': 'application/json' }
  return { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }
}

export function safeError(error: unknown, key = ''): string {
  const text = error instanceof Error ? error.message : String(error)
  return (key ? text.split(key).join('••••') : text).replace(/Bearer\s+[^\s"']+/gi, 'Bearer ••••').slice(0, 1000)
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

async function requestJson(url: string, connection: ProviderConnection, key: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: headers(connection, key),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
    redirect: 'error'
  })
  const text = await response.text()
  let data: unknown
  try { data = JSON.parse(text) } catch {
    throw new HttpError(response.status, response.ok ? 'The endpoint did not return JSON' : `HTTP ${response.status}: ${response.statusText}`)
  }
  const error = record(record(data).error)
  if (!response.ok || record(data).error) {
    const detail = typeof error.message === 'string' ? error.message : typeof record(data).error === 'string' ? String(record(data).error) : response.statusText
    throw new HttpError(response.status, safeError(new Error(`HTTP ${response.status}: ${detail}`), key))
  }
  return data
}

export async function fetchProviderModels(connection: ProviderConnection, key: string, catalog: ProviderModel[] = []): Promise<ProviderModel[]> {
  const normalized = normalizeConnection(connection)
  const signal = AbortSignal.timeout(20_000)
  const all: unknown[] = []
  let url = endpoint(normalized, 'models')
  for (let page = 0; page < 20; page++) {
    const data = await requestJson(url, normalized, key, signal)
    const payload = record(data)
    const entries = Array.isArray(data) ? data : payload.data ?? payload.models
    if (!Array.isArray(entries)) throw new Error('The endpoint did not return a model list')
    all.push(...entries)
    if (all.length > 10_000) throw new Error('The upstream model list exceeds 10,000 entries')
    const next = new URL(endpoint(normalized, 'models'))
    if (typeof payload.nextPageToken === 'string' && payload.nextPageToken) next.searchParams.set('pageToken', payload.nextPageToken)
    else if (payload.has_more === true) {
      if (typeof payload.last_id !== 'string' || !payload.last_id) throw new Error('The upstream omitted its next-page cursor')
      next.searchParams.set('after_id', payload.last_id)
    }
    else return enrichModels(all, catalog)
    if (next.toString() === url) throw new Error('The upstream returned a repeated pagination cursor')
    url = next.toString()
  }
  throw new Error('The upstream model list exceeds the pagination limit')
}

export async function probeProvider(connection: ProviderConnection, key: string, modelId?: string): Promise<ProviderProbeResult> {
  const started = performance.now()
  const stage = modelId ? 'inference' : 'models'
  try {
    const normalized = normalizeConnection(connection)
    if (!modelId) await fetchProviderModels(normalized, key)
    else await probeModel(normalized, key, modelId)
    return { ok: true, latencyMs: Math.round(performance.now() - started), stage }
  } catch (error) {
    return { ok: false, latencyMs: Math.round(performance.now() - started), stage, error: safeError(error, key) }
  }
}

async function probeModel(connection: ProviderConnection, key: string, modelId: string): Promise<void> {
  const signal = AbortSignal.timeout(30_000)
  const prompt = 'Reply with OK.'
  let data: unknown
  if (connection.api === 'openai-responses') {
    data = await requestJson(endpoint(connection, 'responses'), connection, key, signal, {
      model: modelId, input: prompt, max_output_tokens: 16, store: false
    })
    if (!Array.isArray(record(data).output) || record(data).status === 'failed') throw new Error('The endpoint did not return a Responses result')
  } else if (connection.api === 'anthropic-messages') {
    data = await requestJson(endpoint(connection, 'messages'), connection, key, signal, {
      model: modelId, messages: [{ role: 'user', content: prompt }], max_tokens: 16
    })
    if (record(data).role !== 'assistant' || !Array.isArray(record(data).content)) throw new Error('The endpoint did not return an Anthropic message')
  } else if (connection.api === 'google-generative-ai') {
    data = await requestJson(endpoint(connection, `models/${encodeURIComponent(modelId)}:generateContent`), connection, key, signal, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 16 }
    })
    if (!Array.isArray(record(data).candidates) || !(record(data).candidates as unknown[]).length) throw new Error('The endpoint did not return a Gemini candidate')
  } else {
    const body = { model: modelId, messages: [{ role: 'user', content: prompt }], max_tokens: 16 }
    try {
      data = await requestJson(endpoint(connection, 'chat/completions'), connection, key, signal, body)
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 400 || !error.message.includes('max_tokens')) throw error
      data = await requestJson(endpoint(connection, 'chat/completions'), connection, key, signal, {
        model: body.model, messages: body.messages, max_completion_tokens: 16
      })
    }
    if (!Array.isArray(record(data).choices) || !(record(data).choices as unknown[]).some(choice => Object.keys(record(record(choice).message)).length)) {
      throw new Error('The endpoint did not return a chat completion')
    }
  }
}
