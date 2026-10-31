import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { enrichModels, parseModel } from '../src/main/providers/metadata'
import { fetchProviderModels, probeProvider } from '../src/main/providers/network'
import { ProviderStore } from '../src/main/providers/store'
import { providerControlsExtension } from '../src/main/pi/provider-controls'
import { mergeFetchedModels, modelsFromProfiles, resolveSavedModel, selectableModels } from '../src/shared/provider-models'
import type { ProviderApi, SaveProviderInput } from '../src/shared/providers'

const known = { id: 'gpt-known', name: 'Known model', contextWindow: 128000, maxTokens: 16384, reasoning: true,
  input: ['text', 'image'] as ('text' | 'image')[], cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } }

test('upstream parameters override catalog references and preserve false capabilities', () => {
  const [model] = enrichModels([{ id: 'gpt-known', context_length: 64000, max_output_tokens: 4096,
    reasoning: false, input: ['text'] }], [known])
  assert.equal(model.contextWindow, 64000)
  assert.equal(model.maxTokens, 4096)
  assert.equal(model.reasoning, false)
  assert.deepEqual(model.input, ['text', 'image'], 'a text-only proxy list must not erase catalog vision for the same id')
  assert.equal(model.sources?.input, 'catalog')
  assert.equal(model.name, 'Known model')
  assert.equal(model.sources?.name, 'catalog')
  assert.equal(model.sources?.contextWindow, 'upstream')
  assert.equal(model.cost, undefined, 'a proxy must not inherit another provider’s prices')
})

test('ID-only catalogs fill exact matches without guessing unknown model parameters', () => {
  const models = enrichModels([{ id: known.id }, { id: 'gpt-known-custom' }, { id: known.id }], [known])
  assert.equal(models.length, 2)
  assert.equal(models[0].contextWindow, 128000)
  assert.equal(models[0].sources?.contextWindow, 'catalog')
  assert.equal(models[1].contextWindow, undefined)
  assert.equal(models[1].reasoning, undefined)
})

test('OpenRouter metadata preserves modalities and converts per-token prices exactly once', () => {
  const model = parseModel({ id: 'org/model', context_length: 262144,
    top_provider: { max_completion_tokens: 32768 }, architecture: { input_modalities: ['text', 'image'] },
    supported_parameters: ['reasoning'], pricing: { prompt: '0.000003', completion: '0.000012' } })!
  assert.equal(model.maxTokens, 32768)
  assert.equal(model.reasoning, true)
  assert.deepEqual(model.input, ['text', 'image'])
  assert.deepEqual(model.cost, { input: 3, output: 12 })
  assert.equal(parseModel({ id: 'free', pricing: { prompt: '0', completion: '0' } })?.cost?.input, 0)
})

test('SenseNova catalogs publish output length, modalities, reasoning and tool support under their own names', () => {
  const model = parseModel({ id: 'sensenova-6.8-flash-lite', context_length: 262144, max_output_length: 65536,
    input_modalities: ['text', 'image'], output_modalities: ['text'],
    supported_features: ['tools', 'json_mode', 'reasoning'], supported_sampling_parameters: ['temperature', 'stop'],
    pricing: { prompt: '0', completion: '0', input_cache_read: '0' } })!
  assert.equal(model.contextWindow, 262144)
  assert.equal(model.maxTokens, 65536)
  assert.equal(model.reasoning, true)
  assert.equal(model.tools, true)
  assert.deepEqual(model.input, ['text', 'image'])
  assert.deepEqual(model.output, ['text'])
  assert.equal(model.sources?.maxTokens, 'upstream')
  assert.equal(model.sources?.tools, 'upstream')
  const without = parseModel({ id: 'plain', supported_features: ['json_mode'], output_modalities: ['image'] })!
  assert.equal(without.reasoning, false)
  assert.equal(without.tools, false)
  assert.deepEqual(without.output, ['image'])
  assert.equal(parseModel({ id: 'saved', tools: false, output: ['text'] })?.tools, false)
})

test('Anthropic and Gemini token limits are read from their actual response fields', () => {
  const claude = parseModel({ id: 'claude', display_name: 'Claude', max_input_tokens: 200000, max_tokens: 64000,
    capabilities: { thinking: { types: { adaptive: { supported: true }, disabled: { supported: true } } }, image_input: { supported: true } } })!
  assert.equal(claude.contextWindow, 200000)
  assert.equal(claude.reasoning, true)
  assert.deepEqual(claude.input, ['text', 'image'])
  const gemini = parseModel({ name: 'models/gemini', displayName: 'Gemini', inputTokenLimit: 1048576,
    outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] })!
  assert.equal(gemini.id, 'gemini')
  assert.equal(gemini.maxTokens, 65536)
  assert.equal(parseModel({ name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }), null)
})

function directory(t: { after: (cleanup: () => void) => void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-providers-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

const input = (): SaveProviderInput => ({ name: 'My provider', api: 'openai-completions', baseUrl: 'https://example.com/v1/',
  apiKey: 'test-private-key', models: [{ id: 'custom', contextWindow: 64000, maxTokens: 4096 }], selectedModel: 'custom' })

test('provider saves preserve other providers, advanced model fields and credentials without exposing keys', t => {
  const root = directory(t)
  const other = { name: 'Existing', apiKey: '!keep-command', headers: { Secret: 'keep-header' }, models: [{ id: 'untouched' }] }
  writeFileSync(path.join(root, 'models.json'), JSON.stringify({ $schema: 'schema', providers: { other } }))
  writeFileSync(path.join(root, 'auth.json'), JSON.stringify({ oauth: { type: 'oauth', access: 'keep-access' } }))
  const store = new ProviderStore(root)
  const saved = store.save(input())
  assert.equal(saved.hasApiKey, true)
  assert.equal(JSON.stringify(saved).includes('test-private-key'), false)
  const before = JSON.parse(readFileSync(store.file, 'utf8'))
  assert.deepEqual(before.providers.other, other)
  before.providers[saved.id].models[0].compat = { supportsStore: false }
  before.providers[saved.id].headers = { Extra: 'preserve' }
  writeFileSync(store.file, JSON.stringify(before))
  const refreshed = store.list().find(provider => provider.id === saved.id)!
  store.save({ ...input(), id: saved.id, revision: refreshed.revision, apiKey: undefined,
    models: [{ id: 'custom', maxTokens: 2048 }], selectedModel: 'custom' })
  const after = JSON.parse(readFileSync(store.file, 'utf8'))
  assert.deepEqual(after.providers.other, other)
  assert.deepEqual(after.providers[saved.id].headers, { Extra: 'preserve' })
  assert.deepEqual(after.providers[saved.id].models[0].compat, { supportsStore: false })
  assert.equal(after.providers[saved.id].models[0].contextWindow, undefined, 'clearing a field restores Pi defaults')
  assert.equal(after.providers[saved.id].apiKey, 'test-private-key')
  assert.equal(after.providers[saved.id].models[0].sources, undefined)
  assert.equal(JSON.parse(readFileSync(path.join(root, 'auth.json'), 'utf8')).oauth.access, 'keep-access')
})

test('stale edits and invalid parameters cannot overwrite provider configuration', t => {
  const store = new ProviderStore(directory(t))
  const saved = store.save(input())
  const snapshot = readFileSync(store.file, 'utf8')
  assert.throws(() => store.save({ ...input(), id: saved.id, revision: 'outdated' }), /changed/)
  assert.throws(() => store.save({ ...input(), id: saved.id, revision: saved.revision, models: [{ id: 'custom', contextWindow: -1 }] }), /positive/)
  assert.equal(readFileSync(store.file, 'utf8'), snapshot)
})

test('the editor can read a saved key back without saving it onto the profile or running a credential command', t => {
  const root = directory(t)
  const store = new ProviderStore(root)
  const saved = store.save(input())
  assert.equal(store.savedKey(saved.id), 'test-private-key')
  assert.equal(JSON.stringify(saved).includes('test-private-key'), false)
  assert.equal(store.list().find(provider => provider.id === saved.id)?.apiKey, 'test-private-key')
  const escaped = store.save({ ...input(), name: 'Escaped', apiKey: 'a$b' })
  assert.equal(store.savedKey(escaped.id), 'a$b')
  writeFileSync(path.join(root, 'auth.json'), JSON.stringify({ [saved.id]: { type: 'api_key', key: 'from-auth' }, oauth: { type: 'oauth', access: 'keep-token' } }))
  assert.equal(store.savedKey(saved.id), 'from-auth')
  assert.equal(store.savedKey('oauth'), '')
  writeFileSync(store.file, JSON.stringify({ providers: { cmd: { name: 'Cmd', api: 'openai-completions', baseUrl: 'https://example.com/v1', apiKey: '!keep-command', models: [{ id: 'm' }] } } }))
  assert.equal(store.savedKey('cmd'), '')
  assert.equal(store.savedKey('../secret'), '')
})

test('literal API keys are escaped for Pi without evaluating commands or environment interpolation', t => {
  const store = new ProviderStore(directory(t))
  const key = '!not-a-command$LITERAL'
  const saved = store.save({ ...input(), apiKey: key })
  assert.equal(store.key({ id: saved.id, api: saved.api, baseUrl: saved.baseUrl }), key)
  assert.equal(JSON.parse(readFileSync(store.file, 'utf8')).providers[saved.id].apiKey, '$!not-a-command$$LITERAL')
})

test('malformed existing configuration is reported without overwriting it', t => {
  const store = new ProviderStore(directory(t))
  writeFileSync(store.file, '{ invalid test-private-key json')
  assert.throws(() => store.save(input()), error => error instanceof Error && !error.message.includes('test-private-key'))
  assert.equal(readFileSync(store.file, 'utf8'), '{ invalid test-private-key json')
  writeFileSync(store.file, '{"providers": ["invalid"]}')
  assert.throws(() => store.save(input()), /must be an object/)
  assert.equal(readFileSync(store.file, 'utf8'), '{"providers": ["invalid"]}')
})

test('base-URL-only overrides remain managed by Pi instead of becoming empty custom providers', t => {
  const store = new ProviderStore(directory(t))
  writeFileSync(store.file, JSON.stringify({ providers: { anthropic: { baseUrl: 'https://proxy.example.com' } } }))
  const provider = store.list()[0]
  assert.equal(provider.external, true)
  assert.equal(provider.id, 'anthropic')
})

test('explicit connection changes replace old model endpoints and the effective stored API key', t => {
  const root = directory(t)
  const store = new ProviderStore(root)
  const saved = store.save(input())
  const document = JSON.parse(readFileSync(store.file, 'utf8'))
  document.providers[saved.id].models[0].api = 'openai-completions'
  document.providers[saved.id].models[0].baseUrl = 'https://old-model-endpoint/v1'
  writeFileSync(store.file, JSON.stringify(document))
  writeFileSync(path.join(root, 'auth.json'), JSON.stringify({ [saved.id]: { type: 'api_key', key: 'old-key' }, untouched: { type: 'api_key', key: 'leave-alone' } }))
  const current = store.list()[0]
  store.save({ ...input(), id: saved.id, revision: current.revision, api: 'openai-responses', baseUrl: 'https://new-endpoint/v1', apiKey: 'new-key' })
  const updated = JSON.parse(readFileSync(store.file, 'utf8')).providers[saved.id]
  assert.equal(updated.api, 'openai-responses')
  assert.equal(updated.models[0].api, undefined)
  assert.equal(updated.models[0].baseUrl, undefined)
  assert.equal(store.key({ id: saved.id, api: 'openai-responses', baseUrl: updated.baseUrl }), 'new-key')
  assert.equal(JSON.parse(readFileSync(path.join(root, 'auth.json'), 'utf8')).untouched.key, 'leave-alone')
})

test('removing a provider drops its models.json entry and api key, and leaves other credentials', t => {
  const root = directory(t)
  const store = new ProviderStore(root)
  const saved = store.save(input())
  writeFileSync(path.join(root, 'auth.json'), JSON.stringify({
    [saved.id]: { type: 'api_key', key: 'secret-key' },
    oauth: { type: 'oauth', access: 'keep-access' }
  }))
  store.remove(saved.id)
  const document = JSON.parse(readFileSync(store.file, 'utf8'))
  assert.equal(document.providers[saved.id], undefined)
  const auth = JSON.parse(readFileSync(path.join(root, 'auth.json'), 'utf8'))
  assert.equal(auth[saved.id], undefined)
  assert.equal(auth.oauth.access, 'keep-access')
  assert.throws(() => store.remove(saved.id), /managed by Pi/)
  const desktop = JSON.parse(readFileSync(path.join(root, 'models.desktop.json'), 'utf8'))
  assert.equal(desktop.providers[saved.id], undefined)
})

test('disabled models stay out of the picker and come back with their extra fields', t => {
  const root = directory(t)
  const store = new ProviderStore(root)
  const saved = store.save({ ...input(), models: [
    { id: 'keep', contextWindow: 1000 },
    { id: 'park', contextWindow: 2000, maxTokens: 50 }
  ], selectedModel: 'keep' })
  const document = JSON.parse(readFileSync(store.file, 'utf8'))
  const parked = document.providers[saved.id].models.find((model: { id: string }) => model.id === 'park')
  parked.compat = { supportsStore: false }
  writeFileSync(store.file, JSON.stringify(document))
  const current = store.list().find(provider => provider.id === saved.id)!
  assert.equal(current.models.find(model => model.id === 'park')?.enabled, true)
  const snapshot = readFileSync(store.file, 'utf8')
  assert.throws(() => store.save({ ...input(), id: saved.id, revision: current.revision, apiKey: undefined,
    models: [{ id: 'keep', enabled: true }, { id: 'park', enabled: false }], selectedModel: 'park' }), /not enabled/)
  assert.equal(readFileSync(store.file, 'utf8'), snapshot)
  store.save({ ...input(), id: saved.id, revision: current.revision, apiKey: undefined,
    models: [
      { id: 'keep', contextWindow: 1000, enabled: true },
      { id: 'park', contextWindow: 2000, maxTokens: 50, enabled: false }
    ], selectedModel: 'keep' })
  const after = JSON.parse(readFileSync(store.file, 'utf8')).providers[saved.id]
  assert.deepEqual(after.models.map((model: { id: string }) => model.id), ['keep'])
  assert.equal(after.models[0].enabled, undefined)
  const desktop = JSON.parse(readFileSync(path.join(root, 'models.desktop.json'), 'utf8'))
  const stored = desktop.providers[saved.id].models.find((model: { id: string }) => model.id === 'park')
  assert.equal(stored.enabled, false)
  assert.deepEqual(stored.compat, { supportsStore: false })
  const reloaded = store.list().find(provider => provider.id === saved.id)!
  assert.deepEqual(reloaded.models.map(model => model.id), ['keep', 'park'])
  assert.equal(reloaded.models[1].enabled, false)
  assert.equal(reloaded.models[1].contextWindow, 2000)
  store.save({ ...input(), id: saved.id, revision: reloaded.revision, apiKey: undefined,
    models: reloaded.models.map(model => ({ ...model, enabled: true })), selectedModel: 'keep' })
  const restored = JSON.parse(readFileSync(store.file, 'utf8')).providers[saved.id]
  assert.deepEqual(restored.models.find((model: { id: string }) => model.id === 'park').compat, { supportsStore: false })
})

test('a provider saved before model switches still lists every model as enabled', t => {
  const root = directory(t)
  const store = new ProviderStore(root)
  store.save(input())
  const desktop = path.join(root, 'models.desktop.json')
  writeFileSync(desktop, '{}')
  const model = store.list()[0].models[0]
  assert.equal(model.id, 'custom')
  assert.equal(model.enabled, true)
})

test('tool support and output modalities stay out of the Pi model file and come back from the desktop list', t => {
  const root = directory(t)
  const store = new ProviderStore(root)
  const saved = store.save({ ...input(), models: [{ id: 'custom', contextWindow: 64000, maxTokens: 4096,
    reasoning: true, tools: true, output: ['text', 'image'] }], selectedModel: 'custom' })
  const model = store.list().find(provider => provider.id === saved.id)!.models[0]
  assert.equal(model.tools, true)
  assert.deepEqual(model.output, ['text', 'image'])
  assert.equal(model.reasoning, true)
  const pi = JSON.parse(readFileSync(store.file, 'utf8')).providers[saved.id].models[0]
  assert.equal(pi.tools, undefined)
  assert.equal(pi.output, undefined)
  assert.equal(pi.maxTokens, 4096)
  assert.equal(pi.reasoning, true)
  const desktop = JSON.parse(readFileSync(path.join(root, 'models.desktop.json'), 'utf8')).providers[saved.id].models[0]
  assert.equal(desktop.tools, true)
  assert.deepEqual(desktop.output, ['text', 'image'])
})

test('fetching merges upstream configuration without dropping manual edits or disabled models', () => {
  const existing = [
    { id: 'kept', enabled: false, contextWindow: 1000, sources: { contextWindow: 'manual' as const } },
    { id: 'note', name: 'Mine' },
    { id: '', name: 'draft' }
  ]
  const merged = mergeFetchedModels(existing, [
    { id: 'kept', contextWindow: 99999, maxTokens: 10, sources: { contextWindow: 'upstream', maxTokens: 'upstream' } },
    { id: 'new', name: 'New', contextWindow: 32000 }
  ])
  assert.deepEqual(merged.map(model => model.id), ['kept', 'new', 'note', ''])
  assert.equal(merged[0].enabled, false)
  assert.equal(merged[0].contextWindow, 1000)
  assert.equal(merged[0].maxTokens, 10)
  assert.equal(merged[0].sources?.contextWindow, 'manual')
  assert.equal(merged[0].sources?.maxTokens, 'upstream')
  assert.equal(merged[1].enabled, true)
  assert.equal(merged[1].contextWindow, 32000)
  assert.equal(merged[2].name, 'Mine')
  assert.equal(merged[3].name, 'draft')
  const kept = mergeFetchedModels(
    [{ id: 'kept', output: ['text'], sources: { output: 'manual' } }],
    [{ id: 'kept', tools: true, output: ['text', 'image'], maxTokens: 65536, reasoning: true }]
  )
  assert.deepEqual(kept[0].output, ['text'])
  assert.equal(kept[0].sources?.output, 'manual')
  assert.equal(kept[0].tools, true)
  assert.equal(kept[0].maxTokens, 65536)
  assert.equal(kept[0].reasoning, true)
  const keptVision = mergeFetchedModels(
    [{ id: 'deepseek-flash', maxTokens: 384000, input: ['text', 'image'], sources: { maxTokens: 'saved', input: 'saved' } }],
    [{ id: 'deepseek-flash', input: ['text'], reasoning: true }]
  )
  assert.equal(keptVision[0].maxTokens, 384000, 'an omitted output cap must not erase the saved one')
  assert.deepEqual(keptVision[0].input, ['text', 'image'])
  assert.equal(keptVision[0].reasoning, true)
  const keptCap = mergeFetchedModels(
    [{ id: 'deepseek-flash', maxTokens: 384000, sources: { maxTokens: 'saved' } }],
    [{ id: 'deepseek-flash', maxTokens: 65536 }]
  )
  assert.equal(keptCap[0].maxTokens, 384000, 'a smaller upstream cap must not shrink a saved output length')
})

async function server(t: { after: (cleanup: () => Promise<void>) => void }, handler: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => void) {
  const instance = createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += chunk
    response.setHeader('content-type', 'application/json')
    handler(request, response, text ? JSON.parse(text) : {})
  })
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => { instance.closeAllConnections(); instance.close(() => resolve()) }))
  return `http://127.0.0.1:${(instance.address() as { port: number }).port}`
}

test('real HTTP discovery follows pagination, sends authentication and keeps supplied parameters', async t => {
  const base = await server(t, (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer private-test-key')
    const second = request.url?.includes('after_id=first')
    response.end(JSON.stringify({ data: [{ id: second ? 'second' : 'first', context_length: second ? 32000 : 64000 }],
      has_more: !second, last_id: second ? 'second' : 'first' }))
  })
  const models = await fetchProviderModels({ api: 'openai-completions', baseUrl: `${base}/v1` }, 'private-test-key')
  assert.deepEqual(models.map(model => model.id), ['first', 'second'])
  assert.equal(models[1].contextWindow, 32000)
})

test('connectivity probes validate all four actual inference protocols', async t => {
  const seen: string[] = []
  const base = await server(t, (request, response, body) => {
    seen.push(request.url!)
    if (body.model) assert.equal(body.model, 'test-model')
    if (request.url === '/v1/chat/completions') {
      assert.equal(request.headers.authorization, 'Bearer key')
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }))
    } else if (request.url === '/v1/responses') {
      assert.equal(body.max_output_tokens, 16)
      response.end(JSON.stringify({ status: 'completed', output: [{ type: 'message' }] }))
    } else if (request.url === '/v1/messages') {
      assert.equal(request.headers['x-api-key'], 'key')
      assert.equal(request.headers['anthropic-version'], '2023-06-01')
      response.end(JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'OK' }] }))
    } else {
      assert.equal(request.headers['x-goog-api-key'], 'key')
      response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }))
    }
  })
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'] as ProviderApi[]) {
    const result = await probeProvider({ api, baseUrl: `${base}${api.startsWith('openai') ? '/v1' : ''}` }, 'key', 'test-model')
    assert.equal(result.ok, true, `${api}: ${result.error}`)
    assert.equal(result.stage, 'inference')
  }
  assert.equal(seen.length, 4)
})

test('Gemini pagination and OpenAI token-field fallback follow upstream responses', async t => {
  let posts = 0
  const base = await server(t, (request, response, body) => {
    if (request.method === 'GET') {
      const second = request.url?.includes('pageToken=next')
      response.end(JSON.stringify({ models: [{ name: `models/${second ? 'second' : 'first'}`, inputTokenLimit: 1000,
        supportedGenerationMethods: ['generateContent'] }], ...(second ? {} : { nextPageToken: 'next' }) }))
    } else if (posts++ === 0) {
      assert.equal(body.max_tokens, 16)
      response.statusCode = 400
      response.end(JSON.stringify({ error: { message: 'max_tokens unsupported; use max_completion_tokens' } }))
    } else {
      assert.equal(body.max_completion_tokens, 16)
      assert.equal(body.max_tokens, undefined)
      response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
    }
  })
  const models = await fetchProviderModels({ api: 'google-generative-ai', baseUrl: base }, 'key')
  assert.deepEqual(models.map(model => model.id), ['first', 'second'])
  assert.equal((await probeProvider({ api: 'openai-completions', baseUrl: base }, 'key', 'model')).ok, true)
  assert.equal(posts, 2)
})

test('401 failures redact secrets and HTTP 200 HTML or unrelated JSON never count as connectivity', async t => {
  const base = await server(t, (request, response) => {
    if (request.url?.startsWith('/unauthorized')) {
      response.statusCode = 401
      response.end(JSON.stringify({ error: { message: 'bad private-secret-key' } }))
    } else if (request.url?.startsWith('/html')) response.end('<html>Login</html>')
    else response.end(JSON.stringify({ success: true }))
  })
  for (const prefix of ['unauthorized', 'html', 'unrelated']) {
    const result = await probeProvider({ api: 'openai-completions', baseUrl: `${base}/${prefix}` }, 'private-secret-key', 'model')
    assert.equal(result.ok, false)
    assert.equal(result.error?.includes('private-secret-key'), false)
  }
})

test('the provider reload command is idle-only and refreshes Pi without starting inference', async () => {
  type Context = { isIdle: () => boolean; modelRegistry: { refresh: (options: { allowNetwork: boolean }) => Promise<void>; getError: () => string | undefined } }
  let handler: (_args: string, ctx: Context) => Promise<void>
  const install = new Function(providerControlsExtension().replace('export default function', 'return function'))() as (api: { registerCommand: (name: string, command: { handler: typeof handler }) => void }) => void
  install({ registerCommand: (_name, command) => { handler = command.handler } })
  let refreshes = 0
  const ctx: Context = { isIdle: () => false, modelRegistry: { refresh: async options => { assert.equal(options.allowNetwork, false); refreshes++ }, getError: () => undefined } }
  await assert.rejects(() => handler('', ctx), /working/)
  assert.equal(refreshes, 0)
  ctx.isIdle = () => true
  await handler!('', ctx)
  assert.equal(refreshes, 1)
})

test('saved providers still identify a model when Pi has not reported one', () => {
  const models = modelsFromProfiles([{
    id: 'sensetime', name: 'sensetime', api: 'openai-completions', baseUrl: 'https://example.com/v1', hasApiKey: true,
    models: [
      { id: 'deepseek-flash', name: 'deepseek-flash', reasoning: true, input: ['text'], enabled: true },
      { id: 'parked', enabled: false }
    ]
  }])
  assert.deepEqual(models.map(model => model.provider + '/' + model.id), ['sensetime/deepseek-flash'])
  const saved = resolveSavedModel('sensetime/deepseek-flash', undefined, models)
  assert.equal(saved?.provider, 'sensetime')
  assert.equal(saved?.id, 'deepseek-flash')
  const pending = resolveSavedModel('sensetime/not-listed-yet', 'sensetime', [])
  assert.equal(pending?.provider, 'sensetime')
  assert.equal(pending?.id, 'not-listed-yet')
  assert.equal(resolveSavedModel(undefined, undefined, models), undefined)
})

test('model selection merges new providers without losing Pi order, metadata or provider identity', () => {
  const catalog = modelsFromProfiles([{
    id: 'added', name: 'Added', api: 'openai-completions', baseUrl: 'https://example.com/v1', hasApiKey: true,
    models: [{ id: 'shared-model' }, { id: 'new/slash-model' }, { id: 'disabled', enabled: false }]
  }])
  const native = [
    { ...catalog[0], provider: 'native', contextWindow: 128000 },
    { ...catalog[0], contextWindow: 64000 },
    { ...catalog[0], id: 'disabled' },
    { ...catalog[0], id: 'runtime-only' }
  ]
  const models = selectableModels(native, catalog, ['added/disabled'])
  assert.deepEqual(models.map(model => `${model.provider}/${model.id}`), [
    'native/shared-model', 'added/shared-model', 'added/runtime-only', 'added/new/slash-model'
  ])
  assert.equal(models[0], native[0])
  assert.equal(models[1], native[1], 'Pi keeps the resolved defaults when saved parameters are incomplete')
  assert.deepEqual(selectableModels([], catalog, ['added/disabled']), catalog)
  assert.deepEqual(selectableModels(native, [], []), native, 'Pi-managed providers need no desktop catalog')
})
