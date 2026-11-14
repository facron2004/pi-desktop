import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { PiEvent, RpcTraceHint, RuntimeEnsureOptions, RuntimeStatus, SessionMeta } from '@shared/types'
import { lastAssistantText } from '../src/renderer/src/lib/thread'

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
  sessions: { list: async () => [], hydrate: async () => [], remove: async (_file?: string) => true },
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
const docListeners = new Map<string, Set<() => void>>()
Object.assign(globalThis, {
  document: {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    addEventListener: (type: string, handler: () => void) => {
      const set = docListeners.get(type) ?? new Set()
      set.add(handler)
      docListeners.set(type, set)
    },
    removeEventListener: (type: string, handler: () => void) => {
      docListeners.get(type)?.delete(handler)
    },
    dispatchEvent: (type: string) => {
      docListeners.get(type)?.forEach((fn) => fn())
    }
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

test('coalesced drainPending flushes multi-session batches in one atomic store dispatch', async () => {
  const frames: (() => void)[] = []
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length },
    cancelAnimationFrame: () => {}
  })

  // Select active session A
  await useAppStore.getState().selectSession(session('A.jsonl'))
  emit({ ownerId: 'A.jsonl', event: { type: 'agent_start' } })

  // Background session B is auto-initialized and starts
  emit({ ownerId: 'B.jsonl', event: { type: 'agent_start' } })

  // Queue message events for active session A
  emit({ ownerId: 'A.jsonl', event: { type: 'message_start', message: { role: 'assistant', content: [] } } })
  emit({ ownerId: 'A.jsonl', event: {
    type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello from A' }
  } })

  // Queue message events for background session B
  emit({ ownerId: 'B.jsonl', event: { type: 'message_start', message: { role: 'assistant', content: [] } } })
  emit({ ownerId: 'B.jsonl', event: {
    type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello from B' }
  } })

  // Now both batches are queued in pending.
  // Count how many store state notifications fire during the rAF flush.
  let updateCount = 0
  const unsubscribe = useAppStore.subscribe(() => {
    updateCount += 1
  })

  frames.forEach((frame) => frame())
  unsubscribe()

  // Must update store exactly once atomically, coalescing all session batches
  assert.equal(updateCount, 1, 'all session batches must be flushed in a single atomic Zustand update')

  // Active session view has A's items
  const activeItems = useAppStore.getState().items
  assert.ok(activeItems.length > 0)
  assert.equal(useAppStore.getState().threads['A.jsonl'].items.length, activeItems.length)

  // Background session B has B's items stored in its thread
  const bItems = useAppStore.getState().threads['B.jsonl'].items
  assert.ok(bItems.length > 0)

  // Active view does not contain B's items
  assert.notEqual(activeItems, bItems)
})

test('events for unvisited background sessions establish thread shell with running and unread status', async () => {
  assert.equal(useAppStore.getState().threads['background-task.jsonl'], undefined)

  // Incoming event for unvisited session initializes shell and sets streaming
  emit({ ownerId: 'background-task.jsonl', event: { type: 'agent_start' } })
  const thread = useAppStore.getState().threads['background-task.jsonl']
  assert.ok(thread, 'thread shell must be created')
  assert.equal(thread.isStreaming, true, 'background session must reflect running state')

  // When settled in background, unread notice is set
  emit({ ownerId: 'background-task.jsonl', event: { type: 'agent_settled', aborted: false } })
  const settledThread = useAppStore.getState().threads['background-task.jsonl']
  assert.equal(settledThread.isStreaming, false)
  assert.equal(settledThread.notice, 'unread', 'background session must acquire unread notice')
})

test('deleted sessions are not resurrected by late background events', async () => {
  await useAppStore.getState().selectSession(session('deleted-session.jsonl'))
  assert.ok(useAppStore.getState().threads['deleted-session.jsonl'])

  // Delete session
  await useAppStore.getState().deleteSession('deleted-session.jsonl')
  assert.equal(useAppStore.getState().threads['deleted-session.jsonl'], undefined)

  // Late events from terminating child process arrive
  emit({ ownerId: 'deleted-session.jsonl', event: { type: 'agent_start' } })
  emit({ ownerId: 'deleted-session.jsonl', event: { type: 'agent_settled', aborted: true } })

  // Thread must remain deleted and not resurrected
  assert.equal(useAppStore.getState().threads['deleted-session.jsonl'], undefined, 'deleted session must not be resurrected')
})

test('high-concurrency streaming across 12+ concurrent sessions merges atomically without dropping deltas or corrupting items', async () => {
  const frames: (() => void)[] = []
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length },
    cancelAnimationFrame: () => {}
  })

  const sessionCount = 12
  const sessionIds = Array.from({ length: sessionCount }, (_, i) => `concurrent-${i}.jsonl`)

  // Select the first session as active
  await useAppStore.getState().selectSession(session(sessionIds[0]))

  // Start all sessions
  for (const id of sessionIds) {
    emit({ ownerId: id, event: { type: 'agent_start' } })
    emit({ ownerId: id, event: { type: 'message_start', message: { role: 'assistant', content: [] } } })
  }

  // Interleave 20 text deltas across all 12 sessions in round-robin fashion (240 deltas total in one rAF frame)
  const deltasPerSession = 20
  for (let r = 0; r < deltasPerSession; r++) {
    for (let s = 0; s < sessionCount; s++) {
      const delta = `[S${s}#${r}]`
      emit({
        ownerId: sessionIds[s],
        event: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta }
        }
      })
    }
  }

  // Count store dispatches during the frame flush
  let updateCount = 0
  const unsubscribe = useAppStore.subscribe(() => {
    updateCount += 1
  })

  // Flush frame
  frames.forEach((frame) => frame())
  frames.length = 0
  unsubscribe()

  // Must update store exactly once atomically for all 12 sessions
  assert.equal(updateCount, 1, 'all 12 concurrent session batches must be flushed in a single atomic Zustand update')

  // Verify active session projection
  const activeItems = useAppStore.getState().items
  assert.ok(activeItems.length > 0)
  assert.equal(useAppStore.getState().threads[sessionIds[0]].items.length, activeItems.length)

  // Verify text content across all 12 sessions
  for (let s = 0; s < sessionCount; s++) {
    const thread = useAppStore.getState().threads[sessionIds[s]]
    assert.ok(thread, `thread ${sessionIds[s]} must exist`)
    const expected = Array.from({ length: deltasPerSession }, (_, r) => `[S${s}#${r}]`).join('')
    const actual = lastAssistantText(thread.items)
    assert.equal(actual, expected, `Session ${sessionIds[s]} text must contain all concatenated deltas without drop or cross-session corruption`)
  }

  // Second frame: send 10 more deltas
  for (let r = deltasPerSession; r < deltasPerSession + 10; r++) {
    for (let s = 0; s < sessionCount; s++) {
      const delta = `[S${s}#${r}]`
      emit({
        ownerId: sessionIds[s],
        event: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta }
        }
      })
    }
  }

  let secondUpdateCount = 0
  const unsubscribe2 = useAppStore.subscribe(() => {
    secondUpdateCount += 1
  })
  frames.forEach((frame) => frame())
  frames.length = 0
  unsubscribe2()

  assert.equal(secondUpdateCount, 1, 'second frame must also flush all 12 sessions in a single atomic update')

  for (let s = 0; s < sessionCount; s++) {
    const thread = useAppStore.getState().threads[sessionIds[s]]
    const expected = Array.from({ length: deltasPerSession + 10 }, (_, r) => `[S${s}#${r}]`).join('')
    const actual = lastAssistantText(thread.items)
    assert.equal(actual, expected, `Session ${sessionIds[s]} must preserve full 30-delta text across multiple frames`)
  }

  // Authoritative message_end completion
  for (let s = 0; s < sessionCount; s++) {
    const fullText = Array.from({ length: deltasPerSession + 10 }, (_, r) => `[S${s}#${r}]`).join('')
    emit({
      ownerId: sessionIds[s],
      event: {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: fullText }] }
      }
    })
  }
})

test('active session projection updates top-level items while inactive background sessions do not pollute active items', async () => {
  const frames: (() => void)[] = []
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length },
    cancelAnimationFrame: () => {}
  })

  // Select Session A as active
  await useAppStore.getState().selectSession(session('active-proj-A.jsonl'))
  emit({ ownerId: 'active-proj-A.jsonl', event: { type: 'agent_start' } })
  emit({ ownerId: 'active-proj-A.jsonl', event: { type: 'message_start', message: { role: 'assistant', content: [] } } })
  emit({ ownerId: 'active-proj-A.jsonl', event: {
    type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Active initial text' }
  } })
  frames.forEach((frame) => frame())
  frames.length = 0

  const initialActiveItems = useAppStore.getState().items
  assert.equal(lastAssistantText(initialActiveItems), 'Active initial text')

  // Now, ONLY background sessions B and C receive deltas. Active session A receives NOTHING.
  emit({ ownerId: 'bg-proj-B.jsonl', event: { type: 'agent_start' } })
  emit({ ownerId: 'bg-proj-B.jsonl', event: { type: 'message_start', message: { role: 'assistant', content: [] } } })
  emit({ ownerId: 'bg-proj-B.jsonl', event: {
    type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Background B delta' }
  } })

  emit({ ownerId: 'bg-proj-C.jsonl', event: { type: 'agent_start' } })
  emit({ ownerId: 'bg-proj-C.jsonl', event: { type: 'message_start', message: { role: 'assistant', content: [] } } })
  emit({ ownerId: 'bg-proj-C.jsonl', event: {
    type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Background C delta' }
  } })

  // Flush background session batches
  frames.forEach((frame) => frame())
  frames.length = 0

  // Top-level active items must remain strictly untouched (same reference)
  assert.equal(useAppStore.getState().items, initialActiveItems, 'top-level items must not be re-allocated or modified when only background sessions stream')
  assert.equal(lastAssistantText(useAppStore.getState().items), 'Active initial text')

  // Background sessions must have their text updated in state.threads
  assert.equal(lastAssistantText(useAppStore.getState().threads['bg-proj-B.jsonl'].items), 'Background B delta')
  assert.equal(lastAssistantText(useAppStore.getState().threads['bg-proj-C.jsonl'].items), 'Background C delta')

  // Now switch active view from A to B
  await useAppStore.getState().selectSession(session('bg-proj-B.jsonl'))
  assert.equal(lastAssistantText(useAppStore.getState().items), 'Background B delta')

  // Now both A (now background) and B (now active) receive new deltas
  emit({ ownerId: 'active-proj-A.jsonl', event: {
    type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' + A background update' }
  } })
  emit({ ownerId: 'bg-proj-B.jsonl', event: {
    type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' + B active update' }
  } })

  frames.forEach((frame) => frame())
  frames.length = 0

  // Top-level active items must now reflect B (the new active view)
  assert.equal(lastAssistantText(useAppStore.getState().items), 'Background B delta + B active update')
  // A's thread holds its update without polluting the active view
  assert.equal(lastAssistantText(useAppStore.getState().threads['active-proj-A.jsonl'].items), 'Active initial text + A background update')
})

test('hiddenFlushTimer flushes queued deltas across multiple sessions when document visibility is hidden and rAF is paused', async () => {
  // Mock document.visibilityState = 'hidden'
  const originalVisibility = (globalThis as any).document?.visibilityState
  Object.defineProperty(globalThis.document, 'visibilityState', {
    value: 'hidden',
    configurable: true,
    writable: true
  })

  // rAF should not be called when window is hidden
  let rafCalled = false
  Object.assign(globalThis, {
    requestAnimationFrame: () => {
      rafCalled = true
      return 1
    },
    cancelAnimationFrame: () => {}
  })

  try {
    await useAppStore.getState().selectSession(session('hidden-active.jsonl'))
    emit({ ownerId: 'hidden-active.jsonl', event: { type: 'agent_start' } })
    emit({ ownerId: 'hidden-bg.jsonl', event: { type: 'agent_start' } })
    emit({ ownerId: 'hidden-active.jsonl', event: { type: 'message_start', message: { role: 'assistant', content: [] } } })
    emit({ ownerId: 'hidden-bg.jsonl', event: { type: 'message_start', message: { role: 'assistant', content: [] } } })

    // Now emit high-frequency text deltas while window is hidden
    emit({ ownerId: 'hidden-active.jsonl', event: {
      type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Active hidden delta' }
    } })
    emit({ ownerId: 'hidden-bg.jsonl', event: {
      type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Background hidden delta' }
    } })

    // Verify rAF was not called
    assert.equal(rafCalled, false, 'requestAnimationFrame must not be scheduled when window is hidden')

    // Before timer fires, pending text deltas are not yet applied to the store items
    assert.equal(lastAssistantText(useAppStore.getState().items), '', 'assistant text should remain empty before hidden timer fires')
    assert.equal(lastAssistantText(useAppStore.getState().threads['hidden-bg.jsonl'].items), '', 'background text should remain empty before hidden timer fires')

    // Wait for HIDDEN_EVENT_FLUSH_MS (100ms) to fire
    await new Promise((resolve) => setTimeout(resolve, 140))

    // Now hiddenFlushTimer should have fired and drained pending items atomically
    assert.equal(lastAssistantText(useAppStore.getState().items), 'Active hidden delta')
    assert.equal(lastAssistantText(useAppStore.getState().threads['hidden-bg.jsonl'].items), 'Background hidden delta')

    // Test early manual drain clearing hiddenFlushTimer
    emit({ ownerId: 'hidden-active.jsonl', event: {
      type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' + second delta' }
    } })
    // Explicit manual drain via tool_execution_start which flushes immediately
    emit({ ownerId: 'hidden-active.jsonl', event: { type: 'tool_execution_start', toolCallId: 't1', toolName: 'test' } })

    // The explicit tool_execution_start triggers immediate flush and cancels hiddenFlushTimer
    assert.ok(lastAssistantText(useAppStore.getState().items).includes('second delta'))
  } finally {
    Object.defineProperty(globalThis.document, 'visibilityState', {
      value: originalVisibility,
      configurable: true,
      writable: true
    })
  }
})

test('visibilitychange from hidden to visible immediately drains pending multi-session deltas without waiting for timer', async () => {
  const originalVisibility = (globalThis as any).document?.visibilityState
  Object.defineProperty(globalThis.document, 'visibilityState', {
    value: 'hidden',
    configurable: true,
    writable: true
  })
  Object.assign(globalThis, {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {}
  })

  try {
    await useAppStore.getState().selectSession(session('vis-active.jsonl'))
    emit({ ownerId: 'vis-active.jsonl', event: { type: 'agent_start' } })
    emit({ ownerId: 'vis-bg.jsonl', event: { type: 'agent_start' } })
    emit({ ownerId: 'vis-active.jsonl', event: { type: 'message_start', message: { role: 'assistant', content: [] } } })
    emit({ ownerId: 'vis-bg.jsonl', event: { type: 'message_start', message: { role: 'assistant', content: [] } } })

    // Emit deltas while hidden
    emit({ ownerId: 'vis-active.jsonl', event: {
      type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Vis active delta' }
    } })
    emit({ ownerId: 'vis-bg.jsonl', event: {
      type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Vis bg delta' }
    } })

    // Before visibility change, pending deltas are not applied
    assert.equal(lastAssistantText(useAppStore.getState().items), '')
    assert.equal(lastAssistantText(useAppStore.getState().threads['vis-bg.jsonl'].items), '')

    // Window becomes visible again
    Object.defineProperty(globalThis.document, 'visibilityState', {
      value: 'visible',
      configurable: true,
      writable: true
    })
    ;(globalThis.document as any).dispatchEvent('visibilitychange')

    // Must have drained immediately without waiting for 100ms timer
    assert.equal(lastAssistantText(useAppStore.getState().items), 'Vis active delta', 'active items must be drained immediately on visibility change')
    assert.equal(lastAssistantText(useAppStore.getState().threads['vis-bg.jsonl'].items), 'Vis bg delta', 'background items must be drained immediately on visibility change')
  } finally {
    Object.defineProperty(globalThis.document, 'visibilityState', {
      value: originalVisibility,
      configurable: true,
      writable: true
    })
  }
})
