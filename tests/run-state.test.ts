import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AppSettings, ModelInfo, PiEvent, PiState, RuntimeStartOptions, RuntimeStatus } from '@shared/types'

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
;(globalThis as unknown as { document: unknown }).document = {
  documentElement: {
    dataset: {} as Record<string, string>,
    style: {
      setProperty: (name: string, value: string) => void style.set(name, value),
      removeProperty: (name: string) => void style.delete(name)
    }
  }
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
