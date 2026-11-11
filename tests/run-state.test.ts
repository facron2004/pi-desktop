import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentMessage, AppSettings, ModelInfo, PiEvent, PiState, RuntimeRekey, RuntimeStartOptions, RuntimeStatus } from '@shared/types'
import { forgetSessionTiming, readSessionTiming } from '../src/renderer/src/lib/session-timing'
import { sessionMetrics } from '../src/renderer/src/lib/session-metrics'

/* ------------------------------------------------------------------ *
 * A stand-in for the preload bridge.
 *
 * The store is the only place the run phase is decided, so the phase rules
 * can only be tested against real events arriving through the real
 * subscription. Everything the bridge exposes here answers with the smallest
 * plausible value; nothing in this file fabricates an event.
 * ------------------------------------------------------------------ */

/**
 * The two browser globals `bootstrap` touches on its way to subscribing.
 *
 * The store writes the appearance onto `document.documentElement` and paints
 * transcript updates on an animation frame. Neither is what these tests are
 * about, so they are the smallest stand-ins that let the real code path run.
 */
const style = new Map<string, string>()
const localValues = new Map<string, string>()
;(globalThis as unknown as { document: unknown }).document = {
  documentElement: {
    dataset: {} as Record<string, string>,
    style: {
      setProperty: (name: string, value: string) => void style.set(name, value),
      removeProperty: (name: string) => void style.delete(name)
    }
  },
  addEventListener: () => {}
}
;(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (
  callback: () => void
) => {
  callback()
  return 1
}
;(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = () => {}

type Handler = (event: PiEvent) => void

let emit: Handler = () => {}
let emitStatus: (status: RuntimeStatus) => void = () => {}
let emitRekey: (change: RuntimeRekey) => void = () => {}

const ok = <T,>(value: T) => Promise.resolve(value)

/** What the next `prompt` request answers, so the `handled` path is reachable. */
let promptResult: Record<string, unknown> = {}

const bridge = {
  app: {
    info: () => ok({ forcedTheme: undefined }),
    setTheme: () => ok(undefined),
    getSystemFonts: () => ok([])
  },
  settings: { get: () => ok({ workspaces: [] }), patch: (p: unknown) => ok(p) },
  runtime: {
    start: (_options: RuntimeStartOptions) => ok({ ok: true }),
    onEvent: (handler: Handler) => {
      emit = handler
      return () => {}
    },
    onStatus: (handler: (status: RuntimeStatus) => void) => {
      emitStatus = handler
      return () => {}
    },
    onRekey: (handler: (change: RuntimeRekey) => void) => {
      emitRekey = handler
      return () => {}
    },
    request: (command: string) => ok(command === 'prompt' ? promptResult : {}),
    respondUi: () => ok(undefined)
  },
  sessions: { list: () => ok([]) },
  workspaces: { pick: () => ok(undefined), add: () => ok({}) },
  git: { status: () => ok({ isRepo: false }) },
  fs: { search: () => ok([]) }
}

;(globalThis as unknown as { window: unknown }).window = {
  pi: bridge,
  location: { search: '' },
  localStorage: {
    getItem: (key: string) => localValues.get(key) ?? null,
    setItem: (key: string, value: string) => localValues.set(key, value),
    removeItem: (key: string) => localValues.delete(key)
  },
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
  setInterval: () => 1,
  clearInterval: () => {}
}

const { useAppStore } = await import('../src/renderer/src/store/useAppStore')

await useAppStore.getState().bootstrap()

/** Put the store in a settled state with one prompt in flight. */
function startRun(): void {
  const state = useAppStore.getState()
  const key = state.activeSessionFile || state.draftId
  const run = { phase: 'idle' as const, turns: 0, settled: true }
  const threads = { ...state.threads }
  if (key && threads[key]) {
    threads[key] = { ...threads[key], run, isStreaming: false, uiRequest: undefined, retry: undefined }
  }
  useAppStore.setState({
    isStreaming: false,
    uiRequest: undefined,
    run,
    threads,
    retry: undefined
  })
}

const phase = () => useAppStore.getState().run.phase

test('a selected disk conversation retries hydration when its cache has no items', async () => {
  const previous = useAppStore.getState()
  const sessions = bridge.sessions as unknown as {
    hydrate?: (file: string) => Promise<AgentMessage[]>
  }
  const originalHydrate = sessions.hydrate
  const file = 'C:/tmp/retry-empty-history.jsonl'
  const session = {
    id: 'retry-empty-history',
    file,
    cwd: '',
    preview: 'Existing prompt',
    updatedAt: 1,
    messageCount: 2
  }
  let hydrateCalls = 0

  try {
    await previous.newChat()
    const state = useAppStore.getState()
    const draftKey = state.draftId!
    const cached = { ...state.threads[draftKey], items: [], version: 1 }
    useAppStore.setState({
      threads: { ...state.threads, [file]: cached },
      activeSessionFile: file,
      draftId: undefined,
      hydratingSessionFile: undefined,
      items: [],
      isStreaming: false,
      run: { phase: 'idle', turns: 0, settled: true }
    })
    sessions.hydrate = async () => {
      hydrateCalls += 1
      return [{ role: 'user', content: 'Existing prompt', timestamp: 1 } as AgentMessage]
    }

    await useAppStore.getState().selectSession(session)

    assert.equal(hydrateCalls, 1)
    assert.equal(useAppStore.getState().items[0]?.kind, 'user')
  } finally {
    if (originalHydrate) sessions.hydrate = originalHydrate
    else delete sessions.hydrate
    useAppStore.setState(previous)
  }
})

test('model cycling includes a newly saved provider while Pi still reports its old list', async () => {
  const previous = useAppStore.getState()
  const model: ModelInfo = { id: 'shared-model', name: 'Existing model', provider: 'existing', api: 'openai-completions',
    reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 4096 }
  const added = { ...model, name: 'New provider model', provider: 'new-provider' }
  let selected: ModelInfo | undefined
  useAppStore.setState({
    models: [model], catalogModels: [model, added],
    piState: { ...previous.piState, model } as PiState,
    setModel: async value => { selected = value; return true }
  })
  try {
    await useAppStore.getState().cycleModel(1)
    assert.equal(selected?.provider, added.provider)
    assert.equal(selected?.id, added.id, 'identical model ids from different providers stay distinct')
  } finally {
    useAppStore.setState(previous)
  }
})

test('selecting a newly saved provider refreshes an idle Pi registry before set_model', async () => {
  const previous = useAppStore.getState()
  const originalRequest = bridge.runtime.request
  await previous.newChat()
  const active = useAppStore.getState()
  const key = active.draftId!
  const oldModel: ModelInfo = { id: 'shared-model', provider: 'existing', api: 'openai-completions',
    reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 4096 }
  const added = { ...oldModel, provider: 'added' }
  const calls: string[] = []
  let selected = oldModel
  bridge.runtime.request = async command => {
    calls.push(command)
    if (command === 'prompt') return { disposition: 'handled' }
    if (command === 'set_model') {
      assert.ok(calls.includes('prompt'), 'the stale registry must be refreshed first')
      selected = added
      return added
    }
    if (command === 'get_state') return { ...previous.piState, model: selected }
    if (command === 'get_available_models') return { models: [oldModel, added] }
    return {}
  }
  const thread = { ...active.threads[key], models: [oldModel], isStreaming: false,
    run: { phase: 'idle' as const, turns: 0, settled: true } }
  useAppStore.setState({ models: [oldModel], threads: { ...active.threads, [key]: thread },
    run: thread.run, isStreaming: false, catalogModels: [added], disabledModelSpecs: [] })
  try {
    assert.equal(await useAppStore.getState().setModel(added), true)
    assert.deepEqual(calls.slice(0, 2), ['prompt', 'set_model'])
    assert.equal(useAppStore.getState().piState?.model?.provider, 'added')
    assert.equal(useAppStore.getState().settings.model, 'added/shared-model')
  } finally {
    bridge.runtime.request = originalRequest
    useAppStore.setState(previous)
  }
})

test('a busy conversation keeps running when a new provider cannot be loaded yet', async () => {
  const previous = useAppStore.getState()
  await previous.newChat()
  startRun()
  emit({ type: 'agent_start' })
  const originalRequest = bridge.runtime.request
  const calls: string[] = []
  bridge.runtime.request = command => { calls.push(command); return ok({}) }
  try {
    const added: ModelInfo = { id: 'not-loaded', provider: 'new-provider', api: 'openai-completions',
      reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 4096 }
    assert.equal(await useAppStore.getState().setModel(added), false)
    assert.deepEqual(calls, [], 'loading must not queue a prompt, change the model or abort the run')
    assert.equal(useAppStore.getState().run.settled, false)
    assert.equal(useAppStore.getState().toast?.level, 'warning')
  } finally {
    bridge.runtime.request = originalRequest
    useAppStore.setState(previous)
  }
})

test('switching the model in a cold draft stores it without starting Pi', async () => {
  const previous = useAppStore.getState()
  await previous.newChat()
  const originalRequest = bridge.runtime.request
  const originalPatch = bridge.settings.patch
  const originalHas = (bridge.runtime as unknown as Record<string, unknown>).has
  const calls: string[] = []
  const patches: unknown[] = []
  ;(bridge.runtime as unknown as Record<string, unknown>).has = async () => false
  bridge.runtime.request = command => { calls.push(command); return ok({}) }
  bridge.settings.patch = (patch: unknown) => {
    patches.push(patch)
    return ok({ ...useAppStore.getState().settings, ...(patch as object) })
  }
  try {
    const target: ModelInfo = { id: 'codex/gpt-6.1-terra', provider: 'magpie', api: 'openai-responses',
      reasoning: true, input: ['text'], contextWindow: 500000, maxTokens: 128000 }
    assert.equal(await useAppStore.getState().setModel(target), true)
    assert.deepEqual(calls, [], 'a cold draft has no process to tell')
    assert.deepEqual(patches, [{ provider: 'magpie', model: 'magpie/codex/gpt-6.1-terra' }])
    assert.equal(useAppStore.getState().settings.model, 'magpie/codex/gpt-6.1-terra')
  } finally {
    bridge.runtime.request = originalRequest
    bridge.settings.patch = originalPatch
    ;(bridge.runtime as unknown as Record<string, unknown>).has = originalHas
    useAppStore.setState(previous)
  }
})

test('a model chosen while a resumed session is cold is applied when it starts', async () => {
  const previous = useAppStore.getState()
  await previous.newChat()
  const started = useAppStore.getState()
  const source = started.threads[started.draftId!]
  const session = 'C:/tmp/pi-desktop-cold-model.jsonl'
  useAppStore.setState({
    activeSessionFile: session,
    draftId: undefined,
    threads: { ...started.threads, [session]: source }
  })
  const originalRequest = bridge.runtime.request
  const originalPatch = bridge.settings.patch
  const originalHas = (bridge.runtime as unknown as Record<string, unknown>).has
  const originalEnsure = (bridge.runtime as unknown as Record<string, unknown>).ensure
  const calls: Array<{ command: string; payload?: Record<string, unknown> }> = []
  ;(bridge.runtime as unknown as Record<string, unknown>).has = async () => false
  ;(bridge.runtime as unknown as Record<string, unknown>).ensure = async () => ({ ok: true })
  bridge.runtime.request = (command: string, payload?: Record<string, unknown>) => {
    calls.push({ command, payload })
    if (command === 'set_model') return ok(payload)
    return ok({})
  }
  bridge.settings.patch = (patch: unknown) =>
    ok({ ...useAppStore.getState().settings, ...(patch as object) })
  try {
    const target: ModelInfo = { id: 'model-b', provider: 'p', api: 'openai-completions',
      reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 4096 }
    assert.equal(await useAppStore.getState().setModel(target), true)
    assert.deepEqual(calls, [], 'the selection waits for the process')
    await useAppStore.getState().ensureRuntime(session, 'test')
    assert.deepEqual(calls, [{ command: 'set_model', payload: { provider: 'p', modelId: 'model-b' } }])
  } finally {
    bridge.runtime.request = originalRequest
    bridge.settings.patch = originalPatch
    ;(bridge.runtime as unknown as Record<string, unknown>).has = originalHas
    ;(bridge.runtime as unknown as Record<string, unknown>).ensure = originalEnsure
    useAppStore.setState(previous)
  }
})

test('P01 — the queued phase follows what Pi says it did with the prompt', async () => {
  startRun()
  // Pi reports `started`: the prompt is opening a run, so the optimistic
  // "queued" is already stale by the time the response arrives.
  promptResult = { disposition: 'started' }
  const started = useAppStore.getState().send('hello', [], 'steer')
  assert.equal(phase(), 'queued', 'a prompt in flight is queued')
  await started
  assert.equal(phase(), 'working', 'a started prompt is working, not queued')

  startRun()
  // Pi reports `handled`: an extension or input handler consumed the prompt
  // and no model turn follows, so no run may be left open.
  promptResult = { disposition: 'handled' }
  await useAppStore.getState().send('/some-extension-command', [], 'steer')
  assert.equal(phase(), 'idle', 'a handled prompt leaves no run open')

  startRun()
  // Pi reports `queued`: it is holding the message for a run that is going.
  promptResult = { disposition: 'queued' }
  await useAppStore.getState().send('one more thing', [], 'steer')
  assert.equal(phase(), 'queued', 'a queued prompt stays queued')
})

test('P01b — a prompt Pi refuses does not leave a phantom queued run', async () => {
  startRun()
  promptResult = {}
  const original = useAppStore.getState().send
  // The bridge answers `{}` for a non-prompt command, which is the same shape
  // as a response with no disposition at all.
  await useAppStore.getState().send('hello', [], 'steer')
  assert.equal(phase(), 'idle', 'no disposition reported means no run opened')
  assert.equal(useAppStore.getState().run.settled, true)
  assert.equal(original, useAppStore.getState().send)
})

test('P02 — text deltas are the only thing that makes the run "generating"', () => {
  startRun()
  emit({ type: 'agent_start' })
  assert.equal(phase(), 'working')

  // A thinking delta is not the model writing the answer.
  emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } })
  assert.equal(phase(), 'working', 'thinking is not generating')

  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } })
  assert.equal(phase(), 'generating', 'a text delta is generating')

  emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read' })
  assert.equal(phase(), 'tool_running', 'a tool outranks generating')
})

test('completed events persist model time and prompt TTFT for the conversation', () => {
  startRun()
  const sessionKey = useAppStore.getState().activeSessionFile ?? useAppStore.getState().draftId
  const now = Date.now
  const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance')
  let monotonic = 100
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => monotonic }
  })
  try {
    Date.now = () => 1_000
    emit({ type: 'agent_start' })
    emit({ type: 'turn_start' })
    monotonic = 350
    Date.now = () => 125_000
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } })
    monotonic = 900
    Date.now = () => 180_000
    emit({ type: 'message_end', message: { role: 'assistant', content: [] } })
    emit({ type: 'agent_settled', aborted: false })
  } finally {
    Date.now = now
    if (performanceDescriptor) Object.defineProperty(globalThis, 'performance', performanceDescriptor)
  }

  const timing = readSessionTiming(sessionKey)
  assert.deepEqual(Object.values(timing.modelDurationsMs), [800])
  assert.deepEqual(Object.values(timing.ttftDurationsMs), [250])
})

test('a prompt event before agent_start keeps its identity and elapsed metrics', () => {
  startRun()
  const sessionKey = useAppStore.getState().activeSessionFile ?? useAppStore.getState().draftId
  const now = Date.now
  const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance')
  let monotonic = 100
  let turnId: string | undefined
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => monotonic }
  })
  try {
    Date.now = () => 1_000
    emit({ type: 'message_start', message: { role: 'user', content: 'Prompt', timestamp: 900 } })
    const runId = useAppStore.getState().run.runId
    const user = useAppStore.getState().items.find((item) => item.kind === 'user')
    assert.ok(runId)
    assert.equal(user?.kind === 'user' ? user.runId : undefined, runId)

    emit({ type: 'agent_start' })
    emit({ type: 'turn_start' })
    turnId = useAppStore.getState().run.turnId
    emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
    monotonic = 350
    Date.now = () => 125_000
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } })
    monotonic = 900
    Date.now = () => 180_000
    emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: 'Hi',
        usage: { input: 10, output: 120, cacheRead: 0, cacheWrite: 0, totalTokens: 130 }
      }
    })
    emit({ type: 'agent_settled', aborted: false })
  } finally {
    Date.now = now
    if (performanceDescriptor) Object.defineProperty(globalThis, 'performance', performanceDescriptor)
  }

  const timing = readSessionTiming(sessionKey)
  assert.equal(timing.runDurationsMs['900'], 800)
  assert.equal(timing.generationWindowMs['900'], 550)
  assert.equal(timing.modelDurationsMs[turnId!], 800)
})

test('an incomplete model response is not counted when the run settles', () => {
  startRun()
  const sessionKey = useAppStore.getState().activeSessionFile ?? useAppStore.getState().draftId
  const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance')
  let monotonic = 100
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => monotonic }
  })
  try {
    emit({ type: 'agent_start' })
    emit({ type: 'turn_start' })
    const turnId = useAppStore.getState().run.turnId!
    monotonic += 19_882_000
    emit({ type: 'agent_settled', aborted: true })

    assert.equal(readSessionTiming(sessionKey).modelDurationsMs[turnId], undefined)
    assert.equal(useAppStore.getState().run.modelTurnStartedAt, undefined)
  } finally {
    if (performanceDescriptor) Object.defineProperty(globalThis, 'performance', performanceDescriptor)
  }
})

test('a provider retry freezes model time during its backoff', () => {
  startRun()
  const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance')
  let monotonic = 100
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => monotonic }
  })
  try {
    emit({ type: 'agent_start' })
    emit({ type: 'turn_start' })
    monotonic += 5_000
    emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 60_000 })
    assert.equal(useAppStore.getState().run.modelTurnStartedAt, undefined)

    monotonic += 60_000
    emit({ type: 'auto_retry_end' })
    emit({ type: 'turn_start' })
    assert.equal(useAppStore.getState().run.modelTurnStartedAt, monotonic)
    emit({ type: 'agent_settled', aborted: true })
  } finally {
    if (performanceDescriptor) Object.defineProperty(globalThis, 'performance', performanceDescriptor)
  }
})

test('tool events persist a measured duration when Pi omits it', () => {
  startRun()
  const sessionKey = useAppStore.getState().activeSessionFile ?? useAppStore.getState().draftId
  const now = Date.now
  const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance')
  let monotonic = 1_000
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => monotonic }
  })
  try {
    Date.now = () => 2_000
    emit({ type: 'agent_start' })
    emit({ type: 'tool_execution_start', toolCallId: 'timed-call', toolName: 'read' })
    monotonic = 1_375
    Date.now = () => 999_999
    emit({ type: 'tool_execution_end', toolCallId: 'timed-call', toolName: 'read', isError: false })
  } finally {
    Date.now = now
    if (performanceDescriptor) Object.defineProperty(globalThis, 'performance', performanceDescriptor)
  }

  assert.equal(readSessionTiming(sessionKey).toolDurationsMs['timed-call'], 375)
  const tool = useAppStore.getState().items.find((item) => item.kind === 'tool' && item.toolCallId === 'timed-call')
  assert.equal(tool?.kind === 'tool' ? tool.durationMs : undefined, 375)
})

test('a tool timing sample follows its conversation when Pi rekeys a draft', () => {
  startRun()
  const from = useAppStore.getState().activeSessionFile ?? useAppStore.getState().draftId
  assert.ok(from)
  const to = 'C:/tmp/rekeyed-tool.jsonl'
  const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance')
  let monotonic = 1_000
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => monotonic }
  })
  try {
    emit({ type: 'agent_start' })
    emit({ type: 'tool_execution_start', toolCallId: 'rekeyed-call', toolName: 'read' })
    emitRekey({ from, to })
    monotonic = 1_375
    emit({ type: 'tool_execution_end', toolCallId: 'rekeyed-call', toolName: 'read', isError: false })
    assert.equal(readSessionTiming(to).toolDurationsMs['rekeyed-call'], 375)
  } finally {
    if (performanceDescriptor) Object.defineProperty(globalThis, 'performance', performanceDescriptor)
  }
})

test('P03 — an extension dialog is the one real "waiting for the user" state', () => {
  startRun()
  emit({ type: 'agent_start' })
  emit({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'confirm',
    title: 'Proceed?',
    message: 'Write the file?'
  })
  assert.equal(phase(), 'waiting_approval')

  // A sibling tool finishing must not hide the block: the agent still cannot
  // move until the dialog is answered.
  emit({ type: 'tool_execution_end', toolCallId: 'c1', isError: false })
  assert.equal(phase(), 'waiting_approval', 'a tool ending does not clear the block')

  return useAppStore.getState().respondUi({ confirmed: true }).then(() => {
    assert.equal(phase(), 'working', 'answering unblocks the run')
  })
})

test('P04 — aborting outranks everything until the runtime settles', () => {
  startRun()
  emit({ type: 'agent_start' })
  emit({ type: 'agent_end' })
  assert.equal(phase(), 'working', 'agent_end is not the end of the work')
  assert.equal(useAppStore.getState().run.settled, false)

  emit({ type: 'agent_settled', aborted: true })
  assert.equal(phase(), 'idle')
  assert.equal(useAppStore.getState().run.outcome, 'aborted')
  assert.equal(useAppStore.getState().run.settled, true)
})

test('P04a — an error answer settles as failed, not completed', () => {
  startRun()
  emit({ type: 'agent_start' })
  emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } })
  emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'provider failed',
      timestamp: 2
    }
  })
  emit({ type: 'agent_settled', aborted: false })
  assert.equal(useAppStore.getState().run.outcome, 'failed')
  assert.equal(useAppStore.getState().run.settled, true)
})

test('P04b — a process that died mid-run settles the run as failed', () => {
  startRun()
  emit({ type: 'agent_start' })
  emit({
    type: 'tool_execution_start',
    toolCallId: 'crashed-tool',
    toolName: 'bash',
    args: { command: 'sleep 10' }
  })
  emit({ type: 'agent_settled', aborted: false, crashed: true })

  const state = useAppStore.getState()
  assert.equal(state.run.phase, 'idle')
  assert.equal(state.run.settled, true)
  assert.equal(state.run.outcome, 'failed')
  assert.equal(state.isStreaming, false)
  const tool = state.items.find((item) => item.kind === 'tool' && item.toolCallId === 'crashed-tool')
  assert.equal(tool?.kind === 'tool' ? tool.status : undefined, 'aborted')
  assert.ok(
    state.items.some((item) => item.kind === 'notice' && item.level === 'error'),
    'the transcript says why the run ended'
  )
})

test('P04c — stopping an already settled run leaves the phase idle', async () => {
  startRun()
  emit({ type: 'agent_start' })
  emit({ type: 'agent_settled', aborted: false })
  assert.equal(phase(), 'idle')
  await useAppStore.getState().stop()
  assert.equal(phase(), 'idle', 'an idle Pi emits no settle, so stop must not wait for one')
  assert.equal(useAppStore.getState().run.settled, true)
})

test('P04d — generation time is summed per answer, not across a tool gap', () => {
  const originalNow = Date.now
  const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance')
  let now = 1_000
  let monotonic = 10_000
  Date.now = () => now
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => monotonic }
  })
  try {
    startRun()
    const sessionKey = useAppStore.getState().activeSessionFile ?? useAppStore.getState().draftId
    emit({ type: 'agent_start' })

    emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: now } })
    now = 1_050
    monotonic = 10_050
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } })
    assert.equal(useAppStore.getState().run.firstTokenMonotonicAt, undefined)
    assert.equal(phase(), 'working', 'a text block start has not produced readable text yet')
    now = 1_100
    monotonic = 10_100
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'first' } })
    assert.equal(useAppStore.getState().run.firstTokenMonotonicAt, 10_100)
    now = 1_400
    monotonic = 10_400
    emit({ type: 'message_end', message: { role: 'assistant', content: [], timestamp: now } })

    // A tool runs for ten seconds between the two answers.
    now = 11_400
    monotonic = 10_400
    emit({ type: 'tool_execution_start', toolCallId: 'gap-tool', toolName: 'bash', args: {} })
    now = 111_400
    monotonic = 20_400
    emit({ type: 'tool_execution_end', toolCallId: 'gap-tool', isError: false })
    now = 11_500
    monotonic = 20_500
    emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: now } })
    now = 11_600
    monotonic = 20_600
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'second' } })
    now = 11_900
    monotonic = 20_900
    emit({ type: 'message_end', message: { role: 'assistant', content: [], timestamp: now } })

    // 350ms in the first answer and 300ms in the second. The old first-to-last
    // span would have counted the tool call and produced 10.8s.
    assert.equal(useAppStore.getState().run.generationMs, 650)
    const tool = useAppStore.getState().items.find((item) => item.kind === 'tool' && item.toolCallId === 'gap-tool')
    assert.equal(tool?.kind === 'tool' ? tool.durationMs : undefined, 10_000)
    assert.equal(readSessionTiming(sessionKey).toolDurationsMs['gap-tool'], 10_000)
  } finally {
    Date.now = originalNow
    if (performanceDescriptor) Object.defineProperty(globalThis, 'performance', performanceDescriptor)
  }
})

test('TTFT excludes time spent queued before Pi reports agent_start', () => {
  const originalNow = Date.now
  const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance')
  let now = 1_000
  let monotonic = 10_000
  Date.now = () => now
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => monotonic }
  })
  startRun()
  const sessionKey = useAppStore.getState().activeSessionFile ?? useAppStore.getState().draftId
  forgetSessionTiming(sessionKey)
  const queuedRun = {
    phase: 'queued' as const,
    runId: 'queued-ttft-run',
    turns: 0,
    startedAt: now,
    startedMonotonicAt: monotonic,
    settled: false
  }
  useAppStore.setState((state) => ({
    isStreaming: true,
    run: queuedRun,
    threads: {
      ...state.threads,
      [sessionKey]: { ...state.threads[sessionKey], run: queuedRun }
    }
  }))

  try {
    now = 2_000
    monotonic = 11_000
    emit({ type: 'agent_start' })
    now = 2_300
    monotonic = 11_300
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'first' } })
    now = 2_500
    monotonic = 11_500
    emit({ type: 'agent_settled', aborted: false })

    assert.equal(readSessionTiming(sessionKey).ttftDurationsMs['queued-ttft-run'], 300)
  } finally {
    forgetSessionTiming(sessionKey)
    Date.now = originalNow
    if (performanceDescriptor) Object.defineProperty(globalThis, 'performance', performanceDescriptor)
    startRun()
  }
})

test('P04e — a steer starts a fresh TPS window inside the same run', async () => {
  const previous = useAppStore.getState()
  const originalNow = Date.now
  const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance')
  let now = 1_000
  let monotonic = 10_000
  let sessionKey: string | undefined
  Date.now = () => now
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => monotonic }
  })
  try {
    await useAppStore.getState().newChat()
    startRun()
    sessionKey = useAppStore.getState().activeSessionFile ?? useAppStore.getState().draftId

    emit({ type: 'message_start', message: { role: 'user', content: 'First prompt', timestamp: 1_000 } })
    const runId = useAppStore.getState().run.runId
    emit({ type: 'agent_start' })
    emit({ type: 'turn_start' })
    emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
    monotonic = 10_100
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'first answer' } })
    monotonic = 10_400
    emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] } })
    assert.equal(useAppStore.getState().run.generationMs, 300)

    now = 2_000
    emit({ type: 'message_start', message: { role: 'user', content: 'Steer prompt', timestamp: 2_000 } })
    assert.equal(useAppStore.getState().run.runId, runId, 'the steer remains in the same run')
    assert.equal(useAppStore.getState().run.generationMs, 0)

    emit({ type: 'turn_start' })
    emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
    monotonic = 10_500
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'steered answer' } })
    monotonic = 10_800
    emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'steered answer' }] } })
    assert.equal(useAppStore.getState().run.generationMs, 300)

    emit({ type: 'agent_settled', aborted: false })
    const timings = readSessionTiming(sessionKey)
    assert.equal(timings.generationWindowMs['2000'], 300)
    assert.equal(timings.generationWindowMs['1000'], undefined)
  } finally {
    if (sessionKey) forgetSessionTiming(sessionKey)
    Date.now = originalNow
    if (performanceDescriptor) Object.defineProperty(globalThis, 'performance', performanceDescriptor)
    useAppStore.setState(previous)
  }
})

test('TPS pairs completed message usage with its generation time across streamed blocks', async () => {
  const previous = useAppStore.getState()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance')
  const frameDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: undefined })
  let monotonic = 1_000
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => monotonic }
  })
  const speed = () => {
    const state = useAppStore.getState()
    return sessionMetrics(state.items, state.stats, state.run).tps
  }
  const usage = (output: number) => ({ input: 10, output, cacheRead: 0, cacheWrite: 0, totalTokens: 10 + output })
  try {
    await useAppStore.getState().newChat()
    startRun()
    emit({ type: 'message_start', message: { role: 'user', content: 'First prompt', timestamp: 1_000 } })
    emit({ type: 'agent_start' })
    emit({ type: 'turn_start' })
    emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } })
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'First answer' } })
    assert.equal(speed(), null, 'there is no completed sample yet')
    monotonic = 2_000
    emit({ type: 'message_end', message: { role: 'assistant', content: 'First answer', usage: usage(60) } })
    assert.equal(speed(), 60)

    emit({ type: 'tool_execution_start', toolCallId: 'tps-gap', toolName: 'read', args: {} })
    monotonic = 12_000
    emit({ type: 'tool_execution_end', toolCallId: 'tps-gap', isError: false })
    emit({ type: 'turn_start' })
    emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
    assert.equal(useAppStore.getState().run.messageGenerationBaseMs, 1_000)
    emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } })
    monotonic = 12_500
    emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'Thinking' } })
    assert.equal(speed(), 60, 'a finished block still has no final message usage')
    monotonic = 12_600
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 1 } })
    for (monotonic of [12_700, 12_800, 13_000]) {
      emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'more' } })
      assert.equal(speed(), 60, 'text deltas keep the completed reading')
    }
    monotonic = 13_100
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: 'Second answer' } })
    assert.equal(speed(), 60)
    emit({ type: 'message_end', message: { role: 'assistant', content: 'Second answer', usage: usage(120) } })
    assert.equal(speed(), 90, '180 tokens over 2s of generation; the tool gap is excluded')

    emit({ type: 'message_start', message: { role: 'user', content: 'Steer prompt', timestamp: 2_000 } })
    assert.equal(useAppStore.getState().run.messageGenerationBaseMs, 0)
    assert.equal(speed(), null, 'a new prompt cannot inherit the previous prompt\'s speed')
  } finally {
    forgetSessionTiming(useAppStore.getState().activeSessionFile ?? useAppStore.getState().draftId)
    if (descriptor) Object.defineProperty(globalThis, 'performance', descriptor)
    if (frameDescriptor) Object.defineProperty(globalThis, 'requestAnimationFrame', frameDescriptor)
    useAppStore.setState(previous)
  }
})

test('P05 — a retry is reported as retrying, not as a finished run', () => {
  startRun()
  emit({ type: 'agent_start' })
  emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 100 })
  assert.equal(phase(), 'retrying')
  assert.equal(useAppStore.getState().retry?.attempt, 1)

  emit({ type: 'auto_retry_end' })
  assert.equal(phase(), 'working')
  assert.equal(useAppStore.getState().retry, undefined)
})

test('P05a — a retry deadline survives view reads and clears when Pi starts the next attempt', () => {
  for (const next of ['agent_start', 'turn_start']) {
    startRun()
    emit({ type: 'agent_start' })
    const runId = useAppStore.getState().run.runId
    const before = Date.now()
    emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 8, delayMs: 60_000, errorMessage: '429 RPM' })
    const retry = useAppStore.getState().retry
    assert.ok(retry)
    assert.ok(retry.retryAt >= before + 60_000)
    assert.ok(retry.retryAt <= Date.now() + 60_000)
    assert.equal(useAppStore.getState().isStreaming, true)
    assert.equal(useAppStore.getState().run.settled, false)

    emit({ type: next })
    assert.equal(useAppStore.getState().retry, undefined, next)
    assert.equal(phase(), 'working', next)
    assert.equal(useAppStore.getState().run.runId, runId, 'a retry continues the same run')
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Recovered' } })
    assert.equal(phase(), 'generating')
  }
})

test('P05b — retry events cannot hide a stop or an approval request', async () => {
  for (const priority of ['aborting', 'waiting_approval'] as const) {
    startRun()
    emit({ type: 'agent_start' })
    if (priority === 'aborting') {
      await useAppStore.getState().stop()
    } else {
      emit({ type: 'extension_ui_request', id: 'retry-approval', method: 'confirm', title: 'Proceed?' })
    }
    emit({ type: 'auto_retry_start', attempt: 1, delayMs: 100 })
    assert.equal(phase(), priority)
    emit({ type: 'auto_retry_end', success: false, finalError: 'Retry cancelled' })
    assert.equal(phase(), priority)
    emit({ type: 'agent_settled', aborted: true })
    assert.equal(phase(), 'idle')
    assert.equal(useAppStore.getState().retry, undefined)
  }
})

test('P06 — a search hit switches the view and does not stop the running conversation', async () => {
  const previous = useAppStore.getState()
  let stops = 0
  let switches = 0
  useAppStore.setState({
    isStreaming: true,
    activeSessionFile: 'active.jsonl',
    pendingJump: undefined,
    stop: async () => { stops += 1 },
    selectSession: async () => { switches += 1 },
    showToast: () => {}
  })
  try {
    await useAppStore.getState().openSearchHit({
      sessionId: 'other', file: 'other.jsonl', cwd: 'C:/project',
      preview: 'Another conversation', updatedAt: 0,
      role: 'assistant', snippet: 'search result', matchStart: 0, matchLength: 6, messageIndex: 0
    }, 'search')
    assert.equal(stops, 0)
    assert.equal(switches, 1)
  } finally {
    useAppStore.setState(previous)
  }
})

test('an explicit runtime start cancels the pending speculative prewarm', async () => {
  const previous = useAppStore.getState()
  const runtimeBridge = bridge.runtime as typeof bridge.runtime & {
    ensure: (options: unknown) => Promise<{ ok: boolean }>
    stop: (key?: string) => Promise<void>
  }
  const dynamicRuntime = bridge.runtime as unknown as Record<string, unknown>
  const originalEnsure = dynamicRuntime.ensure
  const originalStop = dynamicRuntime.stop
  const file = 'C:/tmp/prewarm-explicit-start.jsonl'
  let ensures = 0
  let stops = 0

  runtimeBridge.ensure = async () => {
    ensures += 1
    return { ok: true }
  }
  runtimeBridge.stop = async () => {
    stops += 1
  }
  useAppStore.setState({
    workspace: undefined,
    settings: { ...previous.settings, workspaces: [], activeWorkspaceId: null },
    activeSessionFile: undefined,
    draftId: undefined,
    threads: {}
  })

  try {
    await useAppStore.getState().selectSession({
      id: 'prewarm-explicit-start', file, cwd: '', preview: 'Existing chat', updatedAt: 1, messageCount: 1
    })
    await useAppStore.getState().ensureRuntime(file, 'explicit-action')
    await new Promise((resolve) => setTimeout(resolve, 1100))
    assert.equal(ensures, 1, 'the timer must not start the same runtime a second time')

    await useAppStore.getState().newChat()
    assert.equal(stops, 0, 'leaving the chat must not stop its explicitly started runtime')
  } finally {
    await useAppStore.getState().newChat()
    useAppStore.setState(previous)
    if (originalEnsure === undefined) delete dynamicRuntime.ensure
    else dynamicRuntime.ensure = originalEnsure
    if (originalStop === undefined) delete dynamicRuntime.stop
    else dynamicRuntime.stop = originalStop
  }
})

test('project selection supports starting, restoring and reopening chats without a project', async () => {
  const previous = useAppStore.getState()
  const originalBridge = { get: bridge.settings.get, patch: bridge.settings.patch, start: bridge.runtime.start }
  const workspace = { id: 'project', path: 'C:/project', name: 'Project', lastOpenedAt: 1 }
  let saved: AppSettings = { ...previous.settings, workspaces: [workspace], activeWorkspaceId: workspace.id }
  const starts: RuntimeStartOptions[] = []
  bridge.settings.get = () => ok(saved)
  bridge.settings.patch = (patch: unknown) => {
    saved = { ...saved, ...patch as Partial<AppSettings> }
    return ok(saved)
  }
  bridge.runtime.start = (options) => {
    starts.push(options)
    return ok({ ok: true })
  }
  useAppStore.setState({ workspace, settings: saved, isStreaming: false })
  try {
    await useAppStore.getState().switchProject(null, { allowWhileRunning: true })
    assert.equal(useAppStore.getState().workspace, undefined)
    assert.equal(saved.activeWorkspaceId, null, 'the no-project choice must survive serialization')
    assert.deepEqual(saved.workspaces, [workspace], 'existing projects must remain registered')
    assert.equal(starts.length, 0, 'opening a project view must not start Pi')

    useAppStore.setState({ workspace, settings: previous.settings })
    await useAppStore.getState().bootstrap()
    assert.equal(useAppStore.getState().workspace, undefined, 'startup must respect the no-project choice')
    assert.equal(starts.length, 0)

    useAppStore.setState({ workspace, settings: { ...saved, activeWorkspaceId: workspace.id } })
    await useAppStore.getState().selectSession({
      id: 'chat', file: 'chat.jsonl', cwd: '', preview: 'General chat', updatedAt: 1, messageCount: 1
    })
    assert.equal(useAppStore.getState().workspace, undefined)
    assert.equal(useAppStore.getState().activeSessionFile, 'chat.jsonl')
    assert.equal(starts.length, 0, 'viewing a conversation must not start Pi')
    assert.equal(saved.activeWorkspaceId, null)

    await useAppStore.getState().selectSession({
      id: 'project-chat', file: 'project.jsonl', cwd: workspace.path,
      preview: 'Project chat', updatedAt: 1, messageCount: 1
    })
    assert.equal(useAppStore.getState().workspace?.id, workspace.id)
    assert.equal(saved.activeWorkspaceId, workspace.id, 'returning to a project restores its selection')
    assert.equal(starts.length, 0)
  } finally {
    bridge.settings.get = originalBridge.get
    bridge.settings.patch = originalBridge.patch
    bridge.runtime.start = originalBridge.start
    useAppStore.setState(previous)
  }
})

test('renaming a projectless conversation never switches an active project runtime', async () => {
  const previous = useAppStore.getState()
  const originalRequest = bridge.runtime.request
  const sessions = bridge.sessions as { list: () => Promise<unknown>; rename?: (file: string, name: string) => Promise<boolean> }
  const originalRename = sessions.rename
  const workspace = { id: 'project', path: 'C:/project', name: 'Project', lastOpenedAt: 1 }
  const requests: string[] = []
  const renames: { file: string; name: string }[] = []
  bridge.runtime.request = (command: string) => {
    requests.push(command)
    return ok({})
  }
  sessions.rename = (file, name) => {
    renames.push({ file, name })
    return ok(true)
  }
  useAppStore.setState({
    workspace,
    activeSessionFile: undefined,
    status: { phase: 'ready', cwd: workspace.path },
    sessions: [{
      id: 'chat',
      file: 'chat.jsonl',
      cwd: '',
      preview: 'General chat',
      updatedAt: 1,
      messageCount: 1
    }]
  })
  try {
    await useAppStore.getState().renameSessionFile('chat.jsonl', 'Renamed chat')
    assert.deepEqual(requests, [], 'a cross-workspace rename must not switch Pi sessions')
    assert.deepEqual(renames, [{ file: 'chat.jsonl', name: 'Renamed chat' }])
    assert.equal(useAppStore.getState().activeSessionFile, undefined)
    assert.equal(useAppStore.getState().workspace?.path, workspace.path)
  } finally {
    bridge.runtime.request = originalRequest
    sessions.rename = originalRename
    useAppStore.setState(previous)
  }
})

test('a project view changes immediately while a conversation is still running', async () => {
  const previous = useAppStore.getState()
  const originalPatch = bridge.settings.patch
  const workspace = { id: 'project', path: 'C:/project', name: 'Project', lastOpenedAt: 1 }
  bridge.settings.patch = (patch: unknown) => ok({ ...previous.settings, workspaces: [workspace], ...patch as object })
  useAppStore.setState({
    workspace,
    isStreaming: true,
    settings: { ...previous.settings, workspaces: [workspace], activeWorkspaceId: workspace.id },
    showToast: () => {}
  })
  try {
    await useAppStore.getState().switchProject(null)
    assert.equal(useAppStore.getState().workspace, undefined)
    assert.equal(useAppStore.getState().pendingProject, undefined)
  } finally {
    bridge.settings.patch = originalPatch
    useAppStore.setState(previous)
  }
})

test('opening another workspace does not stop or blank a running conversation', async () => {
  const previous = useAppStore.getState()
  const kept = {
    id: 'keep',
    kind: 'notice' as const,
    level: 'info' as const,
    text: 'stay',
    timestamp: 1,
    order: 1
  }
  useAppStore.setState({
    items: [kept],
    threads: {
      'C:/old/a.jsonl': {
        items: [kept],
        run: { phase: 'working', turns: 1, settled: false },
        isStreaming: true,
        transport: 'connected',
        uiStatuses: [],
        uiWidgets: [],
        queue: { steering: [], followUp: [] },
        status: { phase: 'ready', cwd: 'C:/old' },
        forkTargets: [],
        version: 2
      }
    },
    activeSessionFile: 'C:/old/a.jsonl',
    isStreaming: true,
    status: { phase: 'ready', cwd: 'C:/old' },
    transport: 'connected',
    workspace: { id: 'old', path: 'C:/old', name: 'Old', lastOpenedAt: 1 }
  })
  try {
    await useAppStore.getState().openWorkspace({
      id: 'new',
      path: 'C:/new',
      name: 'New',
      lastOpenedAt: 2
    })
    const next = useAppStore.getState()
    assert.equal(next.workspace?.name, 'New')
    assert.equal(next.threads['C:/old/a.jsonl']?.isStreaming, true)
    assert.equal(next.threads['C:/old/a.jsonl']?.items[0]?.id, 'keep')
    assert.notEqual(next.activeSessionFile, 'C:/old/a.jsonl')
  } finally {
    useAppStore.setState(previous)
  }
})

test('context stats skip the transcript fetch when a request breakdown is known', async () => {
  const previous = useAppStore.getState()
  const originalRequest = bridge.runtime.request
  const commands: string[] = []
  bridge.runtime.request = (command: string) => {
    commands.push(command)
    return ok({})
  }
  const sessionKey = 'C:/sessions/context.jsonl'
  const requestBreakdown = {
    systemPrompt: 10,
    toolDefinitions: 20,
    conversationMessages: 30,
    source: 'request' as const
  }
  try {
    useAppStore.setState({ contextBreakdown: requestBreakdown, stats: undefined })
    await useAppStore.getState().readSessionStats(sessionKey)
    assert.ok(commands.includes('get_session_stats'), 'the live statistics are still read')
    assert.equal(commands.includes('get_messages'), false, 'the transcript is not copied again')

    commands.length = 0
    useAppStore.setState({
      contextBreakdown: { ...requestBreakdown, source: 'session' },
      stats: undefined
    })
    await useAppStore.getState().readSessionStats(sessionKey)
    assert.ok(commands.includes('get_messages'), 'an estimate can still be refreshed')
  } finally {
    bridge.runtime.request = originalRequest
    useAppStore.setState(previous)
  }
})

test('extension status and widget text lose their terminal colour codes', async () => {
  const previous = useAppStore.getState()
  try {
    await useAppStore.getState().newChat()
    emit({
      type: 'extension_ui_request',
      method: 'setStatus',
      statusKey: 'mcp',
      statusText: '\u001b[38;2;167;152;215mMCP: 3 servers enabled\u001b[39m'
    })
    const status = useAppStore.getState().uiStatuses.find((entry) => entry.key === 'mcp')
    assert.equal(status?.text, 'MCP: 3 servers enabled')

    emit({
      type: 'extension_ui_request',
      method: 'setWidget',
      widgetKey: 'ponytail',
      widgetLines: ['\u001b[31mponytail: FULL\u001b[39m'],
      widgetPlacement: 'aboveEditor'
    })
    const widget = useAppStore.getState().uiWidgets.find((entry) => entry.key === 'ponytail')
    assert.deepEqual(widget?.lines, ['ponytail: FULL'])
  } finally {
    useAppStore.setState(previous)
  }
})

test('an informational extension notification does not interrupt the composer', async () => {
  const previous = useAppStore.getState()
  try {
    await useAppStore.getState().newChat()
    useAppStore.setState({ toast: undefined })
    emit({
      type: 'extension_ui_request',
      method: 'notify',
      notifyType: 'info',
      message: 'Ponytail loaded: full'
    })
    assert.equal(useAppStore.getState().toast, undefined)
  } finally {
    useAppStore.setState(previous)
  }
})
