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
import type { ProviderApi, SaveProviderInput } from '../src/shared/providers'

const known = { id: 'gpt-known', name: 'Known model', contextWindow: 128000, maxTokens: 16384, reasoning: true,
  input: ['text', 'image'] as ('text' | 'image')[], cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } }

test('upstream parameters override catalog references and preserve false capabilities', () => {
  const [model] = enrichModels([{ id: 'gpt-known', context_length: 64000, max_output_tokens: 4096,
    reasoning: false, input: ['text'] }], [known])
  assert.equal(model.contextWindow, 64000)
  assert.equal(model.maxTokens, 4096)
  assert.equal(model.reasoning, false)
  assert.deepEqual(model.input, ['text'])
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
