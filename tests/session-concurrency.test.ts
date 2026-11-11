import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { PiEvent, RpcTraceHint, RuntimeEnsureOptions, RuntimeStatus, SessionMeta } from '@shared/types'

type EventPayload = { ownerId: string; event: PiEvent }
type RekeyPayload = { from: string; to: string; replace?: boolean }
const eventListeners = new Set<(payload: EventPayload) => void>()
const rekeyListeners = new Set<(change: RekeyPayload) => void>()
const statusListeners = new Set<(payload: { ownerId: string; status: RuntimeStatus }) => void>()
const emit = (payload: EventPayload) => eventListeners.forEach(handler => handler(payload))
const rekey = (change: RekeyPayload) => rekeyListeners.forEach(handler => handler(change))
function subscribe<T>(listeners: Set<T>, handler: T): () => void {
  listeners.add(handler)
  return () => { listeners.delete(handler) }
}
const calls: { command: string; key?: string; payload?: Record<string, unknown> }[] = []
const stopped: string[] = []
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const bridge = {
  app: { info: async () => ({}), setTheme: async () => {} },
  settings: { get: async () => ({ workspaces: [] }), patch: async (patch: object) => ({ workspaces: [], ...patch }) },
  workspaces: {
    remove: async (id?: string, hiddenPath?: string) => {
      const settings = useAppStore.getState().settings
      const workspace = settings.workspaces.find((entry) => entry.id === id)
      if (workspace) stopped.push(workspace.path)
      return {
        ...settings,
        workspaces: settings.workspaces.filter((workspace) => workspace.id !== id),
        hiddenProjects: hiddenPath
          ? [...new Set([...(settings.hiddenProjects ?? []), hiddenPath])]
          : settings.hiddenProjects
      }
    }
  },
  sessions: { list: async () => [], hydrate: async () => [] },
  git: { status: async () => ({ isRepo: false }) },
  runtime: {
    ensure: async (_options: RuntimeEnsureOptions) => ({ ok: true }),
    has: async (_key: string) => true,
    stop: async (_key?: string) => {},
    stopCwd: async (cwd: string) => { stopped.push(cwd) },
    onEvent: (handler: (payload: EventPayload) => void) => subscribe(eventListeners, handler),
    onRekey: (handler: (change: RekeyPayload) => void) => subscribe(rekeyListeners, handler),
    onStatus: (handler: (payload: { ownerId: string; status: RuntimeStatus }) => void) => subscribe(statusListeners, handler),
    request: async (
      command: string, payload?: Record<string, unknown>, _timeout?: number, _trace?: RpcTraceHint, key?: string
    ): Promise<unknown> => {
      calls.push({ command, key, payload })
      if (command === 'prompt') return { disposition: 'started' }
      if (command === 'get_state') return { sessionFile: key, isStreaming: false }
      return {}
    }
  }
}
Object.assign(globalThis, {
  document: {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    addEventListener: () => {}
  },
  window: { pi: bridge, location: { search: '' }, matchMedia: () => ({ matches: false }) }
})
const { useAppStore } = await import('../src/renderer/src/store/useAppStore')
await useAppStore.getState().bootstrap()
const initial = useAppStore.getState()
const originalRequest = bridge.runtime.request
const originalEnsure = bridge.runtime.ensure
const originalStop = bridge.runtime.stop
const originalGitStatus = bridge.git.status
afterEach(async () => {
  await tick()
  bridge.runtime.request = originalRequest
  bridge.runtime.ensure = originalEnsure
  bridge.runtime.stop = originalStop
  bridge.git.status = originalGitStatus
  calls.length = 0
  stopped.length = 0
  useAppStore.setState(initial, true)
  Reflect.deleteProperty(globalThis, 'requestAnimationFrame')
  Reflect.deleteProperty(globalThis, 'cancelAnimationFrame')
})

const session = (file: string): SessionMeta => ({
  id: file, file, cwd: '', preview: file, updatedAt: 1, messageCount: 0
})

for (const errorText of ['Unknown task mode', 'Unknown mode']) {
  test(`a stale desktop main process explains how to recover from ${errorText}`, async () => {
    await useAppStore.getState().selectSession(session('mode.jsonl'))
    let prompts = 0
    const retired: string[] = []
    bridge.runtime.stop = async (key) => { if (key) retired.push(key) }
    bridge.runtime.request = async (command, ...args) => {
      if (command === 'prompt') {
        prompts += 1
        throw new Error(errorText)
      }
      return originalRequest(command, ...args)
    }
    await useAppStore.getState().setAgentMode('subagent')
    assert.equal(prompts, 2, 'retry the idle Pi once before asking for an app restart')
    assert.deepEqual(retired, ['mode.jsonl'])
    assert.equal(useAppStore.getState().agentMode, 'default')
    assert.equal(useAppStore.getState().error, 'Restart Pi Desktop to load the updated task modes')
  })
}

test('an old Pi extension can be refreshed without restarting the desktop', async () => {
  await useAppStore.getState().selectSession(session('mode.jsonl'))
  let prompts = 0
  bridge.runtime.request = async (command, ...args) => {
    if (command === 'prompt' && ++prompts === 1) throw new Error('Unknown task mode')
    if (command === 'prompt') {
      emit({ ownerId: 'mode.jsonl', event: { type: 'extension_ui_request', method: 'setStatus', statusKey: 'pi-desktop-mode', statusText: 'subagent' } })
      return { disposition: 'handled' }
    }
    return originalRequest(command, ...args)
  }
  await useAppStore.getState().setAgentMode('subagent')
  assert.equal(prompts, 2)
  assert.equal(useAppStore.getState().agentMode, 'subagent')
  assert.equal(useAppStore.getState().error, undefined)
})

test('repeated bootstrap processes each runtime event once', async () => {
  await Promise.all([useAppStore.getState().bootstrap(), useAppStore.getState().bootstrap()])
  await useAppStore.getState().bootstrap()
  await useAppStore.getState().newChat()
  const ownerId = useAppStore.getState().draftId!
  const send = (event: PiEvent) => emit({ ownerId, event })
  const message = { role: 'user', content: 'same prompt', timestamp: 1 }
  const content = [
    { type: 'thinking', thinking: 'Inspect the project' },
    { type: 'toolCall', id: 'read-once', name: 'read', arguments: { path: 'AGENTS.md' } }
  ]
  send({ type: 'agent_start' })
  send({ type: 'message_start', message })
  send({ type: 'turn_start' })
  send({ type: 'message_start', message: { role: 'assistant', content: [] } })
  send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } })
  send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Inspect the project' } })
  const assistant = useAppStore.getState().items.findLast(item => item.kind === 'assistant')
  assert.ok(assistant?.kind === 'assistant')
  assert.deepEqual(assistant.blocks, [{ type: 'thinking', text: 'Inspect the project' }], 'streamed deltas must not repeat')
  send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 1, toolCall: content[1] } })
  send({ type: 'message_end', message: { role: 'assistant', content } })
  send({ type: 'tool_execution_start', toolCallId: 'read-once', toolName: 'read', args: { path: 'AGENTS.md' } })
  send({ type: 'tool_execution_end', toolCallId: 'read-once', toolName: 'read', result: { content: [{ type: 'text', text: 'rules' }] }, isError: false })
  const state = useAppStore.getState()
  assert.deepEqual(state.items.map(item => item.kind), ['user', 'assistant', 'tool'])
  assert.equal(state.run.turns, 1)
  assert.deepEqual([eventListeners.size, rekeyListeners.size, statusListeners.size], [1, 1, 1])

  send({ type: 'message_start', message: { ...message, timestamp: 2 } })
  assert.equal(useAppStore.getState().items.filter(item => item.kind === 'user').length, 2, 'intentional identical prompts must stay separate')
})

test('a send stays with its draft when the view changes during startup', async () => {
  await useAppStore.getState().newChat()
  const owner = useAppStore.getState().draftId!
  let ready!: (value: { ok: boolean }) => void
  bridge.runtime.ensure = () => new Promise((resolve) => { ready = resolve })
  const sending = useAppStore.getState().send('for A only', [])
  await useAppStore.getState().newChat()
  const viewing = useAppStore.getState().draftId!
  rekey({ from: owner, to: 'A.jsonl' })
  ready({ ok: true })
  await sending
  const prompt = calls.find(({ command }) => command === 'prompt')
  assert.ok(prompt?.key === owner || prompt?.key === 'A.jsonl')
  assert.equal(useAppStore.getState().draftId, viewing)
  assert.equal(useAppStore.getState().run.phase, 'idle')
  assert.equal(useAppStore.getState().threads['A.jsonl'].run.phase, 'working')
})

test('a late prompt response updates its own thread', async () => {
  await useAppStore.getState().selectSession(session('A.jsonl'))
  let finish!: (value: unknown) => void
  bridge.runtime.request = async (command, ...args) => {
    if (command === 'prompt') return new Promise((resolve) => { finish = resolve })
    return originalRequest(command, ...args)
  }
  const sending = useAppStore.getState().send('/handled', [])
  await tick()
  await useAppStore.getState().selectSession(session('B.jsonl'))
  finish({ disposition: 'handled' })
  await sending
  assert.equal(useAppStore.getState().items.length, 0)
  assert.equal(useAppStore.getState().threads['A.jsonl'].items.length, 1)
})

test('background settlement refreshes only the runtime that settled', async () => {
  await useAppStore.getState().selectSession(session('A.jsonl'))
  emit({ ownerId: 'A.jsonl', event: { type: 'agent_start' } })
  await useAppStore.getState().selectSession(session('B.jsonl'))
  calls.length = 0
  emit({ ownerId: 'A.jsonl', event: { type: 'agent_settled' } })
  await tick()
  assert.ok(calls.some(({ command }) => command === 'get_state'))
  assert.ok(calls.every(({ key }) => key === 'A.jsonl'))
  assert.equal(useAppStore.getState().activeSessionFile, 'B.jsonl')
  assert.equal(useAppStore.getState().threads['A.jsonl'].run.settled, true)
})

test('an in-flight state read cannot switch the view back to its owner', async () => {
  await useAppStore.getState().selectSession(session('A.jsonl'))
  let finish!: (value: unknown) => void
  bridge.runtime.request = async (command, ...args) => {
    if (command === 'get_state') return new Promise((resolve) => { finish = resolve })
    return originalRequest(command, ...args)
  }
  const refreshing = useAppStore.getState().refreshState()
  await useAppStore.getState().selectSession(session('B.jsonl'))
  finish({ sessionFile: 'A.jsonl', sessionName: 'A' })
  await refreshing
  assert.equal(useAppStore.getState().activeSessionFile, 'B.jsonl')
  assert.equal(useAppStore.getState().piState?.sessionName, undefined)
  assert.equal(useAppStore.getState().threads['A.jsonl'].piState?.sessionName, 'A')
})

test('a pending animation frame follows the draft file binding', async () => {
  const frames: (() => void)[] = []
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length },
    cancelAnimationFrame: () => {}
  })
  await useAppStore.getState().newChat()
  const draft = useAppStore.getState().draftId!
  emit({ ownerId: draft, event: { type: 'message_start', message: { role: 'assistant', content: [] } } })
  emit({ ownerId: draft, event: {
    type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'A text' }
  } })
  rekey({ from: draft, to: 'A.jsonl' })
  frames.forEach((frame) => frame())
  assert.equal(useAppStore.getState().threads[draft], undefined)
  assert.equal(useAppStore.getState().threads['A.jsonl'].items.length, 1)
  assert.equal(useAppStore.getState().items.length, 1)
})

test('stopping captures its target before clearing the queue', async () => {
  await useAppStore.getState().selectSession(session('A.jsonl'))
  emit({ ownerId: 'A.jsonl', event: { type: 'agent_start' } })
  let finish!: (value: unknown) => void
  bridge.runtime.request = async (command, ...args) => {
    if (command === 'clear_queue') return new Promise((resolve) => { finish = resolve })
    if (command === 'abort') emit({ ownerId: 'A.jsonl', event: { type: 'agent_settled', aborted: true } })
    return originalRequest(command, ...args)
  }
  const stopping = useAppStore.getState().stop()
  await useAppStore.getState().selectSession(session('B.jsonl'))
  finish({ steering: [], followUp: [] })
  await stopping
  assert.equal(calls.find(({ command }) => command === 'abort')?.key, 'A.jsonl')
  assert.equal(useAppStore.getState().run.phase, 'idle')
  assert.equal(useAppStore.getState().threads['A.jsonl'].run.phase, 'idle')
})

test('removing an inactive workspace stops its background runtimes', async () => {
  const a = { id: 'a', path: 'C:/a', name: 'A', lastOpenedAt: 1 }
  const b = { id: 'b', path: 'C:/b', name: 'B', lastOpenedAt: 1 }
  useAppStore.setState({ workspace: b, settings: { ...initial.settings, workspaces: [a, b], activeWorkspaceId: b.id } })
  await useAppStore.getState().removeWorkspace(a)
  assert.deepEqual(stopped, [a.path])
  assert.equal(useAppStore.getState().workspace?.id, b.id)
})

test('agent modes remain attached to their own conversations', async () => {
  await useAppStore.getState().selectSession(session('A.jsonl'))
  emit({ ownerId: 'A.jsonl', event: { type: 'extension_ui_request', method: 'setStatus', statusKey: 'pi-desktop-mode', statusText: 'plan' } })
  await useAppStore.getState().selectSession(session('B.jsonl'))
  assert.equal(useAppStore.getState().agentMode, 'default')
  await useAppStore.getState().selectSession(session('A.jsonl'))
  assert.equal(useAppStore.getState().agentMode, 'plan')
})

test('resuming a saved chat does not override its model with global defaults', async () => {
  await useAppStore.getState().selectSession(session('A.jsonl'))
  useAppStore.setState({ settings: { ...initial.settings, model: 'another/model', thinkingLevel: 'high' } })
  const starts: RuntimeEnsureOptions[] = []
  bridge.runtime.ensure = async (options) => { starts.push(options); return { ok: true } }
  await useAppStore.getState().send('resume A', [])
  assert.equal(starts[0].sessionFile, 'A.jsonl')
  assert.equal(starts[0].model, undefined)
  assert.equal(starts[0].thinkingLevel, undefined)
})

test('inline shell output stays in its own chat after switching views', async () => {
  await useAppStore.getState().selectSession(session('A.jsonl'))
  let finish!: (value: unknown) => void
  bridge.runtime.request = async (command, ...args) => {
    if (command === 'bash') return new Promise((resolve) => { finish = resolve })
    return originalRequest(command, ...args)
  }
  const running = useAppStore.getState().runInlineBash('echo A')
  await tick()
  await useAppStore.getState().selectSession(session('B.jsonl'))
  finish({ output: 'A output', exitCode: 0 })
  await running
  await tick()
  assert.equal(useAppStore.getState().items.length, 0)
  const item = useAppStore.getState().threads['A.jsonl'].items[0]
  assert.equal(item.kind === 'bash' && item.output, 'A output')
})

test('a new prompt after an aborted run can start normally', async () => {
  await useAppStore.getState().selectSession(session('A.jsonl'))
  emit({ ownerId: 'A.jsonl', event: { type: 'agent_start' } })
  emit({ ownerId: 'A.jsonl', event: { type: 'agent_settled', aborted: true } })
  await tick()
  calls.length = 0
  await useAppStore.getState().send('try again', [])
  assert.equal(calls.find(({ command }) => command === 'prompt')?.key, 'A.jsonl')
  assert.equal(useAppStore.getState().run.phase, 'working')
  assert.equal(useAppStore.getState().run.outcome, undefined)
})

test('one frame of text deltas publishes one transcript update', async () => {
  const frames: (() => void)[] = []
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length },
    cancelAnimationFrame: () => {}
  })
  await useAppStore.getState().selectSession(session('A.jsonl'))
  emit({ ownerId: 'A.jsonl', event: { type: 'agent_start' } })
  emit({ ownerId: 'A.jsonl', event: { type: 'message_start', message: { role: 'assistant', content: [] } } })
  let paints = 0
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.items !== previous.items) paints += 1
  })
  for (let i = 0; i < 100; i += 1) {
    emit({ ownerId: 'A.jsonl', event: {
      type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x' }
    } })
  }
  frames.forEach(frame => frame())
  unsubscribe()
  assert.equal(paints, 1)
  const item = useAppStore.getState().items[0]
  assert.equal(item.kind === 'assistant' && item.blocks[0].type === 'text' && item.blocks[0].text, 'x'.repeat(100))
})

test('a fork finishing in the background cannot rename the chat on screen', async () => {
  await useAppStore.getState().selectSession(session('A.jsonl'))
  let finish!: (value: unknown) => void
  bridge.runtime.request = async (command, ...args) => {
    if (command === 'fork') return new Promise((resolve) => { finish = resolve })
    return originalRequest(command, ...args)
  }
  const forking = useAppStore.getState().forkFrom('message-1')
  await tick()
  await useAppStore.getState().selectSession(session('B.jsonl'))
  rekey({ from: 'A.jsonl', to: 'fork.jsonl' })
  finish({ sessionFile: 'fork.jsonl', text: 'fork prompt', cancelled: false })
  await forking
  assert.equal(useAppStore.getState().activeSessionFile, 'B.jsonl')
  assert.ok(useAppStore.getState().threads['A.jsonl'])
  assert.ok(useAppStore.getState().threads['fork.jsonl'])
  assert.equal(calls.find(({ command }) => command === 'set_session_name')?.key, 'fork.jsonl')
  assert.equal(useAppStore.getState().composerInsert, undefined)
})

test('an explicitly stopped worker settles without sending reads to a dead runtime', async () => {
  await useAppStore.getState().selectSession(session('A.jsonl'))
  emit({ ownerId: 'A.jsonl', event: { type: 'agent_start' } })
  await useAppStore.getState().selectSession(session('B.jsonl'))
  calls.length = 0
  emit({ ownerId: 'A.jsonl', event: { type: 'agent_settled', aborted: true, runtimeStopped: true } })
  await tick()
  assert.equal(calls.length, 0)
  assert.equal(useAppStore.getState().threads['A.jsonl'].isStreaming, false)
  assert.equal(useAppStore.getState().threads['A.jsonl'].run.outcome, 'aborted')
  assert.equal(useAppStore.getState().activeSessionFile, 'B.jsonl')
})

test('replacing an unpersisted file follows its in-flight updates without leaving a ghost thread', async () => {
  await useAppStore.getState().selectSession(session('unpersisted.jsonl'))
  let finish!: (value: unknown) => void
  bridge.runtime.request = async (command, ...args) => {
    if (command === 'prompt') return new Promise(resolve => { finish = resolve })
    return originalRequest(command, ...args)
  }
  const sending = useAppStore.getState().send('same conversation', [])
  await tick()
  rekey({ from: 'unpersisted.jsonl', to: 'replacement.jsonl', replace: true })
  finish({ disposition: 'handled' })
  await sending
  assert.equal(useAppStore.getState().activeSessionFile, 'replacement.jsonl')
  assert.equal(useAppStore.getState().threads['unpersisted.jsonl'], undefined)
  assert.equal(useAppStore.getState().threads['replacement.jsonl'].run.phase, 'idle')
})

test('a new chat while the conversation list is being read keeps the fresh list', async () => {
  // The list describes the project, not the conversation on screen, so a
  // view-only change must not throw it away. This is the bug that made two
  // conversations created in quick succession both vanish from the sidebar:
  // a settle started the read, the reader asked for the next conversation,
  // and the refreshed list was dropped.
  let release!: () => void
  const reading = new Promise<void>((resolve) => {
    release = resolve
  })
  bridge.sessions.list = async () => {
    await reading
    return [session('A.jsonl')]
  }
  const refreshing = useAppStore.getState().refreshSessions()
  await useAppStore.getState().newChat()
  release()
  await refreshing
  await tick()
  assert.deepEqual(
    useAppStore.getState().sessions.map((entry) => entry.file),
    ['A.jsonl'],
    'the refreshed list must survive a new chat'
  )
  assert.ok(useAppStore.getState().draftId?.startsWith('draft:'), 'the new chat still owns the screen')
})

test('a project switch while the conversation list is being read discards it', async () => {
  // The other half of the same rule: a read that started in one project must
  // not land in another. The first read is held; the switch's own read
  // returns the new project's conversations.
  let release!: () => void
  const reading = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  bridge.sessions.list = async () => {
    calls += 1
    if (calls === 1) {
      await reading
      return [session('OLD.jsonl')]
    }
    return [session('NEW.jsonl')]
  }
  const refreshing = useAppStore.getState().refreshSessions()
  // Not awaited yet: its own refresh waits on the same read this test holds.
  const switching = useAppStore.getState().openWorkspace(undefined, undefined, 'project-switch')
  release()
  await Promise.all([refreshing, switching])
  await tick()
  assert.deepEqual(
    useAppStore.getState().sessions.map((entry) => entry.file),
    ['NEW.jsonl'],
    'the stale list must not paint over the project the switch opened'
  )
})

for (const fails of [false, true]) {
  test(`selecting another project's conversation discards a stale Git ${fails ? 'failure' : 'result'}`, async () => {
    const a = { id: 'project-a', path: 'C:/review-a', name: 'A', lastOpenedAt: 1 }
    const b = { id: 'project-b', path: 'C:/review-b', name: 'B', lastOpenedAt: 1 }
    useAppStore.setState({
      workspace: a,
      settings: { ...initial.settings, workspaces: [a, b], activeWorkspaceId: a.id }
    })
    let resolveOld!: (value: { isRepo: boolean; branch: string }) => void
    let rejectOld!: (error: Error) => void
    const oldRead = new Promise<{ isRepo: boolean; branch: string }>((resolve, reject) => {
      resolveOld = resolve
      rejectOld = reject
    })
    let reads = 0
    bridge.git.status = async () => ++reads === 1 ? oldRead : { isRepo: true, branch: 'branch-B' }
    const refreshing = useAppStore.getState().refreshGit()
    await useAppStore.getState().selectSession({ ...session('B.jsonl'), cwd: b.path })
    await tick()
    assert.equal(useAppStore.getState().git?.branch, 'branch-B')
    if (fails) rejectOld(new Error('The old project is unavailable'))
    else resolveOld({ isRepo: true, branch: 'branch-A' })
    await refreshing
    assert.equal(useAppStore.getState().workspace?.path, b.path)
    assert.equal(useAppStore.getState().git?.branch, 'branch-B')
  })
}

test('a conversation switch within the same project keeps an in-flight Git result', async () => {
  const workspace = { id: 'project-a', path: 'C:/review-a', name: 'A', lastOpenedAt: 1 }
  useAppStore.setState({
    workspace,
    settings: { ...initial.settings, workspaces: [workspace], activeWorkspaceId: workspace.id }
  })
  let resolve!: (value: { isRepo: boolean; branch: string }) => void
  bridge.git.status = () => new Promise((finish) => { resolve = finish })
  const refreshing = useAppStore.getState().refreshGit()
  await useAppStore.getState().selectSession({ ...session('A.jsonl'), cwd: 'c:\\review-a\\' })
  resolve({ isRepo: true, branch: 'branch-A' })
  await refreshing
  assert.equal(useAppStore.getState().git?.branch, 'branch-A')
})
