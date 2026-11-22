import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GOAL_STATUS_KEY,
  SUBAGENT_EDITOR_CANCEL_STATUS_KEY,
  type ExtensionUiResponse,
  type PiEvent,
  type RpcTraceHint,
  type RuntimeEnsureOptions,
  type RuntimeQueueEvent,
  type RuntimeStatus,
  type SessionMeta,
  type SessionHydrationResult
} from '@shared/types'
import { lastAssistantText } from '../src/renderer/src/lib/thread'
import {
  listPendingUiSessions,
  liveConversationRows,
  streamingProjectPaths
} from '../src/renderer/src/lib/live-sessions'
import { projectIndicator, sessionIndicator } from '../src/renderer/src/lib/session-indicator'

type EventPayload = { ownerId: string; event: PiEvent }
type RekeyPayload = { from: string; to: string; replace?: boolean }
const eventListeners = new Set<(payload: EventPayload) => void>()
const rekeyListeners = new Set<(change: RekeyPayload) => void>()
const statusListeners = new Set<(payload: { ownerId: string; status: RuntimeStatus }) => void>()
const queueListeners = new Set<(payload: RuntimeQueueEvent) => void>()
const notificationListeners = new Set<(payload: { sessionKey: string; reply?: string }) => void>()
const emit = (payload: EventPayload) => eventListeners.forEach(handler => handler(payload))
const rekey = (change: RekeyPayload) => rekeyListeners.forEach(handler => handler(change))
const emitQueue = (payload: RuntimeQueueEvent) => queueListeners.forEach(handler => handler(payload))
function subscribe<T>(listeners: Set<T>, handler: T): () => void {
  listeners.add(handler)
  return () => { listeners.delete(handler) }
}
const calls: { command: string; key?: string; payload?: Record<string, unknown> }[] = []
const ensureCalls: RuntimeEnsureOptions[] = []
const respondUiCalls: { requestId: string; response: ExtensionUiResponse; key?: string }[] = []
let customRespondUi: ((requestId: string, response: ExtensionUiResponse, key?: string) => Promise<void>) | undefined
const stopped: string[] = []
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const bridge = {
  app: {
    info: async () => ({}),
    setTheme: async () => {},
    onNotificationOpen: (handler: (payload: { sessionKey: string; reply?: string }) => void) =>
      subscribe(notificationListeners, handler)
  },
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
  sessions: { list: async () => [], hydrate: async () => ({ messages: [], historyTruncated: false }), remove: async (_file?: string) => true },
  git: { status: async () => ({ isRepo: false }) },
  runtime: {
    ensure: async (options: RuntimeEnsureOptions) => {
      ensureCalls.push(options)
      return { ok: true }
    },
    has: async (_key: string) => true,
    stop: async (_key?: string) => {},
    stopCwd: async (cwd: string) => { stopped.push(cwd) },
    onEvent: (handler: (payload: EventPayload) => void) => subscribe(eventListeners, handler),
    onRekey: (handler: (change: RekeyPayload) => void) => subscribe(rekeyListeners, handler),
    onStatus: (handler: (payload: { ownerId: string; status: RuntimeStatus }) => void) => subscribe(statusListeners, handler),
    onQueue: (handler: (payload: RuntimeQueueEvent) => void) => subscribe(queueListeners, handler),
    respondUi: async (requestId: string, response: ExtensionUiResponse, key?: string) => {
      respondUiCalls.push({ requestId, response, key })
      if (customRespondUi) await customRespondUi(requestId, response, key)
    },
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
const { useAppStore, draftKeyOf } = await import('../src/renderer/src/store/useAppStore')
await useAppStore.getState().bootstrap()
const initial = useAppStore.getState()
const originalRequest = bridge.runtime.request
const originalEnsure = bridge.runtime.ensure
const originalStop = bridge.runtime.stop
const originalHydrate = bridge.sessions.hydrate
const originalGitStatus = bridge.git.status
afterEach(async () => {
  await tick()
  bridge.runtime.request = originalRequest
  bridge.runtime.ensure = originalEnsure
  bridge.runtime.stop = originalStop
  bridge.sessions.hydrate = originalHydrate
  bridge.git.status = originalGitStatus
  customRespondUi = undefined
  calls.length = 0
  ensureCalls.length = 0
  respondUiCalls.length = 0
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

test('a prompt held behind another conversation stays visible until Pi echoes it', async () => {
  await useAppStore.getState().selectSession(session('A.jsonl'))
  let finish!: (value: unknown) => void
  bridge.runtime.request = async (command, ...args) => {
    if (command === 'prompt') return new Promise((resolve) => { finish = resolve })
    return originalRequest(command, ...args)
  }
  const sending = useAppStore.getState().send('held prompt', [])
  await tick()
  // Nothing has reached Pi yet, so there is nothing to show.
  assert.deepEqual(useAppStore.getState().items.map((item) => item.kind), [])

  // The supervisor reports the prompt is waiting for the folder.
  emitQueue({
    ownerId: 'A.jsonl',
    cwd: 'C:/p',
    queued: true,
    position: 1,
    holderOwnerId: 'B.jsonl',
    holderCwd: 'C:/p'
  })
  const waiting = useAppStore.getState().items.find((item) => item.kind === 'user')
  assert.ok(waiting?.kind === 'user' && waiting.pending === true, 'the held prompt is shown as waiting')
  assert.equal(useAppStore.getState().cwdWait?.position, 1)

  finish({ disposition: 'started' })
  await sending
  emit({ ownerId: 'A.jsonl', event: { type: 'message_start', message: { role: 'user', content: 'held prompt' } } })
  const echoed = useAppStore.getState().items.filter((item) => item.kind === 'user')
  assert.equal(echoed.length, 1, 'the echo claims the waiting bubble instead of adding a second one')
  assert.ok(echoed[0]?.kind === 'user' && echoed[0].pending !== true)
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
  assert.equal(
    useAppStore.getState().sessionNotices['background-task.jsonl'],
    'unread',
    'the unread mark must survive the thread for the next run'
  )

  // A restart loses the live thread; the persisted mark is what the sidebar
  // falls back to until the reader opens the conversation.
  useAppStore.setState((state) => {
    const threads = { ...state.threads }
    delete threads['background-task.jsonl']
    return { threads }
  })
  assert.equal(
    useAppStore.getState().sessionNotices['background-task.jsonl'],
    'unread',
    'the persisted mark must outlive the in-memory thread'
  )
  await useAppStore.getState().selectSession(session('background-task.jsonl'))
  assert.equal(
    useAppStore.getState().sessionNotices['background-task.jsonl'],
    undefined,
    'opening the conversation clears the persisted mark'
  )
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

test('per-session drafts stay isolated across switches and migrate on draft promotion preserving clientKey', async () => {
  await useAppStore.getState().selectSession(session('draft-a.jsonl'))
  useAppStore.getState().updateDraft('draft-a.jsonl', {
    text: 'unsent A',
    images: [{ id: 'img-a', data: 'Zm9v', mimeType: 'image/png' }]
  })

  await useAppStore.getState().selectSession(session('draft-b.jsonl'))
  assert.equal(useAppStore.getState().drafts['draft-a.jsonl']?.text, 'unsent A')
  useAppStore.getState().updateDraft('draft-b.jsonl', { text: 'unsent B' })

  assert.equal(useAppStore.getState().drafts['draft-a.jsonl']?.images.length, 1)
  assert.equal(useAppStore.getState().drafts['draft-b.jsonl']?.text, 'unsent B')

  await useAppStore.getState().newChat()
  const draftKey = draftKeyOf(useAppStore.getState())
  assert.ok(draftKey.startsWith('draft:'))
  const draftClientKey = useAppStore.getState().clientKey
  useAppStore.getState().updateDraft(draftKey, { text: 'follow-up draft' })

  rekey({ from: draftKey, to: 'promoted-session.jsonl', replace: true })
  const promoted = useAppStore.getState()
  assert.equal(promoted.activeSessionFile, 'promoted-session.jsonl')
  assert.equal(promoted.clientKey, draftClientKey)
  assert.equal(promoted.drafts[draftKey], undefined)
  assert.equal(promoted.drafts['promoted-session.jsonl']?.text, 'follow-up draft')

  // Rekeying must not overwrite an existing image-only draft on the target key.
  await useAppStore.getState().newChat()
  const draftKey2 = draftKeyOf(useAppStore.getState())
  useAppStore.getState().updateDraft(draftKey2, { text: 'incoming text' })
  useAppStore.getState().updateDraft('img-target.jsonl', {
    text: '',
    images: [{ id: 'img-only', data: 'YmFy', mimeType: 'image/png' }]
  })
  rekey({ from: draftKey2, to: 'img-target.jsonl', replace: true })
  assert.equal(useAppStore.getState().drafts['img-target.jsonl']?.text, '')
  assert.equal(useAppStore.getState().drafts['img-target.jsonl']?.images.length, 1)
})

test('set_editor_text routes background edits to drafts without overwriting active composerText', async () => {
  await useAppStore.getState().selectSession(session('editor-fg.jsonl'))
  useAppStore.getState().updateDraft('editor-fg.jsonl', { text: 'fg draft' })

  emit({
    ownerId: 'editor-bg.jsonl',
    event: { type: 'extension_ui_request', id: 'ed-1', method: 'set_editor_text', text: 'bg text' }
  })

  assert.equal(useAppStore.getState().composerText, undefined)
  assert.equal(useAppStore.getState().drafts['editor-fg.jsonl']?.text, 'fg draft')
  assert.equal(useAppStore.getState().drafts['editor-bg.jsonl']?.text, 'bg text')

  emit({
    ownerId: 'editor-fg.jsonl',
    event: { type: 'extension_ui_request', id: 'ed-2', method: 'set_editor_text', text: 'fg override' }
  })

  assert.equal(useAppStore.getState().composerText, 'fg override')
  assert.equal(useAppStore.getState().drafts['editor-fg.jsonl']?.text, 'fg override')
})

test('concurrent extension uiRequests queue FIFO per thread, respond IPC-first with double-submit guard, and restore run phase', async () => {
  await useAppStore.getState().selectSession(session('ui-a.jsonl'))
  emit({ ownerId: 'ui-a.jsonl', event: { type: 'agent_start' } })
  emit({ ownerId: 'ui-a.jsonl', event: { type: 'message_start', message: { role: 'assistant', content: [] } } })
  emit({
    ownerId: 'ui-a.jsonl',
    event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Working...' } }
  })
  assert.equal(useAppStore.getState().run.phase, 'generating')

  emit({ ownerId: 'ui-a.jsonl', event: { type: 'extension_ui_request', id: 'req-1', method: 'confirm', title: 'First', message: 'One?' } })
  emit({ ownerId: 'ui-a.jsonl', event: { type: 'extension_ui_request', id: 'req-2', method: 'input', title: 'Second', placeholder: 'Two' } })

  assert.equal(useAppStore.getState().uiRequests.length, 2)
  assert.equal(useAppStore.getState().uiRequest?.id, 'req-1')
  assert.equal(useAppStore.getState().run.phase, 'waiting_approval')

  await useAppStore.getState().selectSession(session('ui-b.jsonl'))
  assert.equal(useAppStore.getState().uiRequests.length, 0)
  assert.equal(useAppStore.getState().threads['ui-a.jsonl'].uiRequests.length, 2)

  // Deferred IPC response: ensures queue pops only after IPC resolves and duplicate clicks are ignored.
  let resolveRpc!: () => void
  let rejectNext = false
  customRespondUi = () =>
    new Promise<void>((resolve, reject) => {
      if (rejectNext) {
        reject(new Error('IPC down'))
        return
      }
      resolveRpc = resolve
    })

  const firstAttempt = useAppStore.getState().respondUi({ confirmed: true }, { sessionKey: 'ui-a.jsonl', requestId: 'req-1' })
  const duplicateAttempt = useAppStore.getState().respondUi({ confirmed: true }, { sessionKey: 'ui-a.jsonl', requestId: 'req-1' })
  assert.equal(respondUiCalls.length, 1)
  assert.equal(useAppStore.getState().threads['ui-a.jsonl'].uiRequests[0]?.id, 'req-1')

  resolveRpc()
  await Promise.all([firstAttempt, duplicateAttempt])

  assert.equal(useAppStore.getState().threads['ui-a.jsonl'].uiRequests.length, 1)
  assert.equal(useAppStore.getState().threads['ui-a.jsonl'].uiRequests[0]?.id, 'req-2')
  assert.equal(useAppStore.getState().threads['ui-a.jsonl'].run.phase, 'waiting_approval')

  // If IPC rejects on req-2, keep req-2 intact so user can retry cleanly.
  rejectNext = true
  await useAppStore.getState().respondUi({ value: 'retry' }, { sessionKey: 'ui-a.jsonl', requestId: 'req-2' })
  assert.equal(useAppStore.getState().threads['ui-a.jsonl'].uiRequests.length, 1)
  assert.equal(useAppStore.getState().error, 'IPC down')
  rejectNext = false
  customRespondUi = undefined

  // Cancelling a queued editor dialog via reserved status key dismisses it and restores 'generating'.
  emit({
    ownerId: 'ui-a.jsonl',
    event: {
      type: 'extension_ui_request',
      id: 'cancel-1',
      method: 'setStatus',
      statusKey: SUBAGENT_EDITOR_CANCEL_STATUS_KEY,
      statusText: JSON.stringify({ requestId: 'req-2' })
    }
  })

  assert.equal(useAppStore.getState().threads['ui-a.jsonl'].uiRequests.length, 0)
  assert.equal(useAppStore.getState().threads['ui-a.jsonl'].uiRequest, undefined)
  assert.equal(useAppStore.getState().threads['ui-a.jsonl'].run.phase, 'generating')
  const lastCall = respondUiCalls[respondUiCalls.length - 1]
  assert.equal(lastCall?.requestId, 'req-2')
  assert.deepEqual(lastCall?.response, { confirmed: false, cancelled: true })
})

test('background warning/error notifications attribute their conversation title', async () => {
  await useAppStore.getState().selectSession(session('notify-fg.jsonl'))
  useAppStore.setState((state) => ({
    sessions: [
      ...state.sessions,
      { ...session('notify-bg.jsonl'), name: 'Deploy Pipeline' }
    ]
  }))

  emit({
    ownerId: 'notify-bg.jsonl',
    event: { type: 'extension_ui_request', id: 'n-1', method: 'notify', notifyType: 'warning', message: 'Token expiring' }
  })
  assert.equal(useAppStore.getState().toast?.text, '[Deploy Pipeline] Token expiring')

  emit({
    ownerId: 'notify-fg.jsonl',
    event: { type: 'extension_ui_request', id: 'n-2', method: 'notify', notifyType: 'error', message: 'Local failure' }
  })
  assert.equal(useAppStore.getState().toast?.text, 'Local failure')
  useAppStore.getState().clearToast()
})

test('a native notification reply continues its own conversation in the background', async () => {
  const foreground = session('notification-foreground.jsonl')
  const background = { ...session('notification-background.jsonl'), cwd: 'E:/background' }
  await useAppStore.getState().selectSession(foreground)
  useAppStore.setState({ sessions: [foreground, background], composerText: 'Foreground draft' })

  for (const listener of notificationListeners) {
    listener({ sessionKey: background.file, reply: '  Continue with the next step  ' })
    listener({ sessionKey: foreground.file, reply: '   ' })
    listener({ sessionKey: 'missing.jsonl', reply: 'Do not redirect this reply' })
  }
  await tick()

  assert.deepEqual(calls.filter((call) => call.command === 'prompt'), [{
    command: 'prompt', key: background.file,
    payload: { message: 'Continue with the next step', streamingBehavior: 'followUp' }
  }])
  assert.ok(ensureCalls.some(({ sessionKey, cwd }) => sessionKey === background.file && cwd === background.cwd))
  assert.equal(useAppStore.getState().activeSessionFile, foreground.file)
  assert.equal(useAppStore.getState().composerText, 'Foreground draft')

  for (const listener of notificationListeners) listener({ sessionKey: background.file })
  await tick()
  assert.equal(useAppStore.getState().activeSessionFile, background.file)
})

test('fork rekey clones non-draft threads with a fresh clientKey while keeping the parent intact', async () => {
  await useAppStore.getState().selectSession(session('fork-parent.jsonl'))
  emit({ ownerId: 'fork-parent.jsonl', event: { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'parent msg' }], timestamp: 1 } } })
  const parentClientKey = useAppStore.getState().clientKey

  rekey({ from: 'fork-parent.jsonl', to: 'fork-child.jsonl', replace: false })
  const after = useAppStore.getState()

  assert.ok(after.threads['fork-parent.jsonl'])
  assert.equal(after.threads['fork-parent.jsonl'].items.length, 1)
  assert.equal(after.threads['fork-parent.jsonl'].clientKey, parentClientKey)

  assert.ok(after.threads['fork-child.jsonl'])
  assert.equal(after.threads['fork-child.jsonl'].items.length, 1)
  assert.notEqual(after.threads['fork-child.jsonl'].clientKey, parentClientKey)
  assert.equal(after.activeSessionFile, 'fork-child.jsonl')
})

test('runtime.onQueue updates and clears per-thread cwdWait state', async () => {
  await useAppStore.getState().selectSession(session('cwd-a.jsonl'))
  emitQueue({ ownerId: 'cwd-a.jsonl', queued: true, position: 2, holderOwnerId: 'cwd-b.jsonl', cwd: 'E:/repo' })

  assert.deepEqual(useAppStore.getState().cwdWait, {
    position: 2,
    holderOwnerId: 'cwd-b.jsonl',
    holderCwd: undefined,
    externalHolder: undefined,
    cwd: 'E:/repo'
  })
  assert.deepEqual(useAppStore.getState().threads['cwd-a.jsonl'].cwdWait, {
    position: 2,
    holderOwnerId: 'cwd-b.jsonl',
    holderCwd: undefined,
    externalHolder: undefined,
    cwd: 'E:/repo'
  })

  emit({ ownerId: 'cwd-a.jsonl', event: { type: 'agent_start' } })
  assert.equal(useAppStore.getState().cwdWait, undefined)
  assert.equal(useAppStore.getState().threads['cwd-a.jsonl'].cwdWait, undefined)
})

test('hydrateSession deduplicates concurrent loads and preserves live prompt items appended mid-hydration', async () => {
  let hydrateCalls = 0
  let resolveHydrate!: (result: SessionHydrationResult) => void
  bridge.sessions.hydrate = async () => {
    hydrateCalls += 1
    return await new Promise<SessionHydrationResult>((resolve) => {
      resolveHydrate = resolve
    })
  }

  const p1 = useAppStore.getState().selectSession(session('hyd.jsonl'))
  const p2 = useAppStore.getState().hydrateSession('hyd.jsonl')
  assert.equal(hydrateCalls, 1)

  // User prompt lands live while disk hydration is still in flight.
  emit({
    ownerId: 'hyd.jsonl',
    event: { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'live tail' }], timestamp: 200 } }
  })

  resolveHydrate({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'historical prompt' }], timestamp: 100 },
      { role: 'assistant', content: [{ type: 'text', text: 'historical answer' }], timestamp: 150 }
    ],
    historyTruncated: true
  })
  await Promise.all([p1, p2])

  const items = useAppStore.getState().threads['hyd.jsonl'].items
  assert.equal(useAppStore.getState().threads['hyd.jsonl'].historyTruncated, true)
  assert.equal(items.length, 3)
  assert.equal(items[0]?.kind === 'user' ? items[0].text : '', 'historical prompt')
  assert.equal(items[1]?.kind, 'assistant')
  assert.equal(lastAssistantText([items[1]]), 'historical answer')
  assert.equal(items[2]?.kind === 'user' ? items[2].text : '', 'live tail')
})

test('opening a cold conversation shows the saved mode and goal before Pi starts', async () => {
  const goal = { text: 'Verify the saved goal', status: 'paused' as const }
  const disk: SessionHydrationResult = {
    messages: [{ role: 'user', content: goal.text, timestamp: 1 }],
    historyTruncated: false,
    taskMode: { mode: 'goal', goal }
  }
  bridge.sessions.hydrate = async () => disk
  await useAppStore.getState().selectSession(session('cold-goal.jsonl'))

  const state = useAppStore.getState()
  assert.equal(state.agentMode, 'goal')
  assert.deepEqual(state.uiStatuses.find(({ key }) => key === GOAL_STATUS_KEY), {
    key: GOAL_STATUS_KEY, text: JSON.stringify(goal)
  })
  assert.equal(ensureCalls.length, 0)
})

test('late history hydration cannot restore a goal already cleared by Pi', async () => {
  const ownerId = 'live-goal-clear.jsonl'
  let finishRead!: (result: SessionHydrationResult) => void
  bridge.sessions.hydrate = async () => new Promise((resolve) => { finishRead = resolve })
  const selected = useAppStore.getState().selectSession(session(ownerId))
  emit({
    ownerId,
    event: { type: 'extension_ui_request', id: 'live-mode', method: 'setStatus', statusKey: 'pi-desktop-mode', statusText: 'default' }
  })
  emit({
    ownerId,
    event: { type: 'extension_ui_request', id: 'live-clear', method: 'setStatus', statusKey: GOAL_STATUS_KEY }
  })
  finishRead({
    messages: [{ role: 'user', content: 'Old goal', timestamp: 1 }],
    historyTruncated: false,
    taskMode: { mode: 'goal', goal: { text: 'Old goal', status: 'active' } }
  })
  await selected
  assert.equal(useAppStore.getState().agentMode, 'default')
  assert.equal(useAppStore.getState().uiStatuses.some(({ key }) => key === GOAL_STATUS_KEY), false)
})

for (const entry of ['sidebar', 'workspace'] as const) {
  test(`${entry} opens the saved history of a conversation already streaming`, async () => {
    const workspace = { id: 'reconnect', path: 'E:/repo', name: 'Repo', lastOpenedAt: 1 }
    const ownerId = `reconnect-${entry}.jsonl`
    const meta = { ...session(ownerId), cwd: workspace.path }
    const call = { type: 'toolCall' as const, id: 'reconnected-tool', name: 'bash', arguments: { command: 'echo ok' } }
    const assistant = { role: 'assistant', content: [{ type: 'text' as const, text: 'Running the check' }, call], timestamp: 4 }
    const disk: SessionHydrationResult = {
      messages: [
        { role: 'user', content: 'Continue', timestamp: 1 },
        { role: 'assistant', content: 'Previous answer', timestamp: 2 },
        { role: 'user', content: 'Continue', timestamp: 3 },
        assistant
      ],
      historyTruncated: false
    }
    let calls = 0
    bridge.sessions.hydrate = async () => { calls += 1; return disk }
    const send = (event: PiEvent) => emit({ ownerId, event })
    send({ type: 'agent_start' })
    send({ type: 'turn_start' })
    send({ type: 'message_start', message: { ...assistant, content: [] } })
    send({ type: 'message_end', message: assistant })
    send({ type: 'tool_execution_start', toolName: 'bash', toolCallId: call.id, args: call.arguments })
    send({ type: 'tool_execution_update', toolCallId: call.id, partialResult: { content: [{ type: 'text', text: 'still working' }] } })
    const liveItems = useAppStore.getState().threads[ownerId].items
    assert.deepEqual(liveItems.map(({ kind }) => kind), ['assistant', 'tool'])

    // The sidebar can still have a live row with no count from disk.
    if (entry === 'sidebar') await useAppStore.getState().selectSession(meta)
    else await useAppStore.getState().openWorkspace(workspace, ownerId)

    const state = useAppStore.getState()
    assert.equal(calls, 1)
    assert.equal(state.isStreaming, true)
    assert.deepEqual(state.items.map(({ kind }) => kind), ['user', 'assistant', 'user', 'assistant', 'tool'])
    assert.deepEqual(state.items.filter(item => item.kind === 'user').map(({ timestamp }) => timestamp), [1, 3])
    assert.equal(lastAssistantText(state.items.slice(0, 2)), 'Previous answer')
    assert.equal(state.items[3].id, liveItems[0].id)
    const tool = state.items[4]
    assert.ok(tool.kind === 'tool')
    assert.equal(tool.id, liveItems[1].id)
    assert.equal(tool.status, 'running')
    assert.equal(tool.progress, 'still working')

    await useAppStore.getState().selectSession(meta)
    assert.equal(calls, 1, 'reselecting with history already loaded should use the cache')
    send({ type: 'tool_execution_end', toolCallId: call.id, result: { content: [{ type: 'text', text: 'ok' }] }, isError: false })
    const tools = useAppStore.getState().items.filter(item => item.kind === 'tool')
    assert.deepEqual(tools.map(({ id, status, result }) => [id, status, result]), [[tool.id, 'ok', 'ok']])
  })
}

test('returning to a conversation whose history read was superseded retries the load', async () => {
  const a = { ...session('hydrate-reselect-a.jsonl'), messageCount: 2 }
  const b = { ...session('hydrate-reselect-b.jsonl'), messageCount: 1 }
  let readsA = 0
  let finishFirstRead!: (result: SessionHydrationResult) => void
  bridge.sessions.hydrate = async (file?: string) => {
    if (file === a.file && ++readsA === 1) {
      return new Promise<SessionHydrationResult>(resolve => { finishFirstRead = resolve })
    }
    return { messages: [{ role: 'user', content: file ?? '', timestamp: 1 }], historyTruncated: false }
  }
  const first = useAppStore.getState().selectSession(a)
  await useAppStore.getState().selectSession(b)
  const back = useAppStore.getState().selectSession(a)
  finishFirstRead({ messages: [], historyTruncated: false })
  await Promise.all([first, back])

  const state = useAppStore.getState()
  assert.equal(state.activeSessionFile, a.file)
  assert.equal(state.hydratingSessionFile, undefined)
  assert.equal(readsA, 2)
  assert.equal(state.items[0]?.kind === 'user' && state.items[0].text, a.file)
})

test('deskPage unread mark, hadError settlement, idle draft pruning, prewarm flag, and per-owner drainPending', async () => {
  // 1. Settling active session while deskPage is open marks unread; returning clears notice.
  await useAppStore.getState().selectSession(session('desk.jsonl'))
  useAppStore.getState().setDeskPage('marketplace')
  emit({ ownerId: 'desk.jsonl', event: { type: 'agent_start' } })
  emit({ ownerId: 'desk.jsonl', event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ready' }] } } })
  emit({ ownerId: 'desk.jsonl', event: { type: 'agent_settled', aborted: false } })
  assert.equal(useAppStore.getState().threads['desk.jsonl'].notice, 'unread')
  useAppStore.getState().setDeskPage(null)
  assert.equal(useAppStore.getState().threads['desk.jsonl'].notice, undefined)

  // 2. Extension error sets hadError and settles run as failed.
  emit({ ownerId: 'desk.jsonl', event: { type: 'agent_start' } })
  emit({ ownerId: 'desk.jsonl', event: { type: 'extension_error', extensionPath: 'ext.ts', event: 'turn_start', error: 'Upstream failure' } })
  emit({ ownerId: 'desk.jsonl', event: { type: 'agent_settled', aborted: false } })
  assert.equal(useAppStore.getState().threads['desk.jsonl'].run.outcome, 'failed')

  // 3. Switching away from an untouched empty draft prunes it.
  await useAppStore.getState().newChat()
  const firstDraft = draftKeyOf(useAppStore.getState())
  await useAppStore.getState().newChat()
  const secondDraft = draftKeyOf(useAppStore.getState())
  assert.equal(useAppStore.getState().threads[firstDraft], undefined)
  assert.ok(useAppStore.getState().threads[secondDraft])

  // 4. prewarmRuntime sends prewarm: true.
  useAppStore.getState().prewarmRuntime('cold-disk.jsonl')
  await tick()
  assert.equal(ensureCalls.some((opt) => opt.sessionKey === 'cold-disk.jsonl' && opt.prewarm === true), true)

  // 5. Draining pending updates for owner A leaves owner B pending until next frame.
  let scheduledFrame: (() => void) | undefined
  Object.assign(globalThis, {
    requestAnimationFrame: (cb: () => void) => {
      scheduledFrame = cb
      return 1
    },
    cancelAnimationFrame: () => {}
  })
  await useAppStore.getState().selectSession(session('drain-a.jsonl'))
  emit({ ownerId: 'drain-a.jsonl', event: { type: 'agent_start' } })
  emit({ ownerId: 'drain-b.jsonl', event: { type: 'agent_start' } })
  emit({ ownerId: 'drain-a.jsonl', event: { type: 'message_start', message: { role: 'assistant', content: [] } } })
  emit({ ownerId: 'drain-b.jsonl', event: { type: 'message_start', message: { role: 'assistant', content: [] } } })

  emit({
    ownerId: 'drain-a.jsonl',
    event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'alpha' } }
  })
  emit({
    ownerId: 'drain-b.jsonl',
    event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'beta' } }
  })

  // Settling drain-a drains ONLY drain-a; drain-b stays queued until rAF fires.
  emit({
    ownerId: 'drain-a.jsonl',
    event: { type: 'agent_settled', aborted: false }
  })
  assert.equal(lastAssistantText(useAppStore.getState().threads['drain-a.jsonl'].items), 'alpha')
  assert.equal(lastAssistantText(useAppStore.getState().threads['drain-b.jsonl'].items), '')

  scheduledFrame?.()
  assert.equal(lastAssistantText(useAppStore.getState().threads['drain-b.jsonl'].items), 'beta')
})

test('multiple concurrent draft and saved conversations in the same project stay isolated across boots, rekeys, switches, and attention states', async () => {
  const projectPath = 'E:/same-project'
  const ws = { id: 'ws-same', path: projectPath, name: 'same-project', lastOpenedAt: 1 }
  useAppStore.setState({
    workspace: ws,
    settings: { ...initial.settings, workspaces: [ws], activeWorkspaceId: ws.id }
  })

  // Hold ensure per sessionKey so both drafts are concurrently mid-boot.
  const ensureGates = new Map<string, (value: { ok: boolean }) => void>()
  bridge.runtime.ensure = (options) => {
    ensureCalls.push(options)
    return new Promise((resolve) => {
      ensureGates.set(options.sessionKey, resolve)
    })
  }

  // 1. Create Draft A and start sending before its runtime finishes booting.
  await useAppStore.getState().newChat()
  const draftA = useAppStore.getState().draftId!
  assert.ok(draftA.startsWith('draft:'))
  const sendA = useAppStore.getState().send('Prompt for conversation A', [])

  // Pre-await state must mark Draft A as active work with project cwd so New chat cannot prune it.
  const midBootA = useAppStore.getState().threads[draftA]
  assert.ok(midBootA)
  assert.equal(midBootA.isStreaming, true)
  assert.equal(midBootA.run.settled, false)
  assert.equal(midBootA.status.cwd, projectPath)

  // 2. Immediately create Draft B in the same project while Draft A is still booting.
  await useAppStore.getState().newChat()
  const draftB = useAppStore.getState().draftId!
  assert.ok(draftB.startsWith('draft:'))
  assert.notEqual(draftB, draftA)
  assert.ok(useAppStore.getState().threads[draftA], 'starting Draft B must not prune mid-boot Draft A')
  const sendB = useAppStore.getState().send('Prompt for conversation B', [])

  // Both Draft A and Draft B appear in liveConversationRows for the same workspace before any JSONL exists.
  const stateMidBoot = useAppStore.getState()
  const rowsMidBoot = liveConversationRows(stateMidBoot.sessions, stateMidBoot.threads, projectPath)
  assert.deepEqual(rowsMidBoot.map((r) => r.file).sort(), [draftA, draftB].sort())
  assert.equal(rowsMidBoot.every((r) => r.cwd === projectPath && r.onDisk === false), true)
  assert.deepEqual(
    streamingProjectPaths(stateMidBoot.sessions, stateMidBoot.threads, stateMidBoot.draftId, projectPath),
    ['e:/same-project']
  )

  // Resolve both boots concurrently and verify both prompt RPCs dispatch independently.
  ensureGates.get(draftA)?.({ ok: true })
  ensureGates.get(draftB)?.({ ok: true })
  await Promise.all([sendA, sendB])

  assert.equal(calls.filter((c) => c.command === 'prompt' && c.key === draftA).length, 1)
  assert.equal(calls.filter((c) => c.command === 'prompt' && c.key === draftB).length, 1)
  assert.equal(useAppStore.getState().threads[draftA].run.phase, 'working')
  assert.equal(useAppStore.getState().threads[draftB].run.phase, 'working')
  const clientKeyA = useAppStore.getState().threads[draftA].clientKey
  const clientKeyB = useAppStore.getState().threads[draftB].clientKey
  assert.notEqual(clientKeyA, clientKeyB)

  // 3. Stream deltas into both drafts concurrently, then rekey Draft A to .jsonl while viewing Draft B.
  emit({ ownerId: draftA, event: { type: 'agent_start' } })
  emit({ ownerId: draftB, event: { type: 'agent_start' } })
  emit({ ownerId: draftA, event: { type: 'message_start', message: { role: 'assistant', content: [] } } })
  emit({ ownerId: draftB, event: { type: 'message_start', message: { role: 'assistant', content: [] } } })
  emit({ ownerId: draftA, event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Reply A' } } })
  emit({ ownerId: draftB, event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Reply B' } } })

  const fileA = `${projectPath}/conv-a.jsonl`
  const fileB = `${projectPath}/conv-b.jsonl`
  rekey({ from: draftA, to: fileA })

  const afterRekeyA = useAppStore.getState()
  assert.equal(afterRekeyA.draftId, draftB, 'rekeying background Draft A must keep Draft B on screen')
  assert.equal(afterRekeyA.activeSessionFile, undefined)
  assert.equal(afterRekeyA.threads[draftA], undefined)
  assert.ok(afterRekeyA.threads[fileA])
  assert.equal(afterRekeyA.threads[fileA].clientKey, clientKeyA)
  assert.equal(afterRekeyA.threads[fileA].isStreaming, true)
  assert.equal(lastAssistantText(afterRekeyA.threads[fileA].items), 'Reply A')
  assert.equal(lastAssistantText(afterRekeyA.threads[draftB].items), 'Reply B')

  // Switching to fileA and back to draftB never aborts or stops either running conversation.
  bridge.runtime.ensure = originalEnsure
  let stopCalls = 0
  bridge.runtime.stop = async () => { stopCalls += 1 }
  await useAppStore.getState().selectSession({ ...session(fileA), cwd: projectPath })
  assert.equal(useAppStore.getState().activeSessionFile, fileA)
  assert.equal(lastAssistantText(useAppStore.getState().items), 'Reply A')
  useAppStore.getState().prewarmRuntime(fileA)
  await tick()
  assert.equal(
    ensureCalls.some((opt) => opt.sessionKey === fileA && opt.prewarm === true),
    false,
    'must not prewarm an already-streaming conversation'
  )

  // Rekey Draft B to fileB while viewing fileA.
  rekey({ from: draftB, to: fileB })
  assert.equal(useAppStore.getState().activeSessionFile, fileA)
  assert.equal(useAppStore.getState().threads[draftB], undefined)
  assert.equal(useAppStore.getState().threads[fileB]?.clientKey, clientKeyB)
  assert.equal(lastAssistantText(useAppStore.getState().threads[fileB].items), 'Reply B')
  assert.equal(stopCalls, 0)
  assert.equal(calls.some((c) => c.command === 'abort'), false)

  // Selecting a stale draftB key right after rekey opens fileB cleanly without spawning a ghost draft.
  await useAppStore.getState().selectSession({ ...session(draftB), cwd: projectPath })
  assert.equal(useAppStore.getState().activeSessionFile, fileB)
  assert.equal(useAppStore.getState().draftId, undefined)
  assert.equal(useAppStore.getState().threads[draftB], undefined)
  assert.equal(lastAssistantText(useAppStore.getState().items), 'Reply B')

  // 4. Concurrent attention indicators in the same project: needs-input > error > unread > running.
  emit({
    ownerId: fileB,
    event: { type: 'extension_ui_request', id: 'dlg-b', method: 'confirm', title: 'Approve', message: 'Run tool?' }
  })
  const pending = listPendingUiSessions(useAppStore.getState().threads, useAppStore.getState().sessions)
  assert.equal(pending.length, 1)
  assert.equal(pending[0]?.sessionKey, fileB)
  assert.equal(pending[0]?.cwd, projectPath)

  const indicators1 = [fileA, fileB].map((k) => {
    const t = useAppStore.getState().threads[k]
    return { isStreaming: t.isStreaming, notice: t.notice, needsInput: Boolean(t.uiRequest || t.uiRequests?.length) }
  })
  assert.equal(sessionIndicator(indicators1[0]), 'running')
  assert.equal(sessionIndicator(indicators1[1]), 'needs-input')
  assert.equal(projectIndicator(indicators1), 'needs-input')

  // Answer fileB's dialog, move view to a fresh chat, then settle fileA with error and fileB normally.
  await useAppStore.getState().respondUi({ confirmed: true }, { sessionKey: fileB, requestId: 'dlg-b' })
  await useAppStore.getState().newChat()
  emit({ ownerId: fileA, event: { type: 'extension_error', extensionPath: 'ext.ts', event: 'turn_start', error: 'Boom' } })
  emit({ ownerId: fileA, event: { type: 'agent_settled', aborted: false } })
  emit({ ownerId: fileB, event: { type: 'agent_settled', aborted: false } })

  const tA = useAppStore.getState().threads[fileA]
  const tB = useAppStore.getState().threads[fileB]
  assert.equal(tA.notice, 'error')
  assert.equal(tB.notice, 'unread')
  assert.equal(
    projectIndicator([
      { isStreaming: tA.isStreaming, notice: tA.notice, needsInput: false },
      { isStreaming: tB.isStreaming, notice: tB.notice, needsInput: false }
    ]),
    'error'
  )
})

test('concurrent inline bash across drafts in the same project and operation cwdWait detail stay isolated', async () => {
  const projectPath = 'E:/bash-project'
  const ws = { id: 'ws-bash', path: projectPath, name: 'bash-project', lastOpenedAt: 1 }
  useAppStore.setState({
    workspace: ws,
    settings: { ...initial.settings, workspaces: [ws], activeWorkspaceId: ws.id }
  })

  const ensureGates = new Map<string, (value: { ok: boolean }) => void>()
  bridge.runtime.ensure = (options) => {
    ensureCalls.push(options)
    return new Promise((resolve) => {
      ensureGates.set(options.sessionKey, resolve)
    })
  }

  const bashGates = new Map<string, (value: { output?: string; exitCode?: number; cancelled?: boolean }) => void>()
  bridge.runtime.request = async (command, payload, timeout, trace, key) => {
    if (command === 'bash') {
      calls.push({ command, key, payload })
      return new Promise((resolve) => {
        if (key) bashGates.set(key, resolve)
      })
    }
    return originalRequest(command, payload, timeout, trace, key)
  }

  // Start inline bash on Draft A before ensure resolves.
  await useAppStore.getState().newChat()
  const draftA = useAppStore.getState().draftId!
  const runA = useAppStore.getState().runInlineBash('echo A')

  const midBootA = useAppStore.getState().threads[draftA]
  assert.ok(midBootA)
  assert.equal(midBootA.isStreaming, true)
  assert.equal(midBootA.run.settled, false)
  assert.equal(midBootA.status.cwd, projectPath)

  // Creating Draft B mid-boot keeps Draft A alive and allows concurrent inline bash.
  await useAppStore.getState().newChat()
  const draftB = useAppStore.getState().draftId!
  assert.notEqual(draftB, draftA)
  assert.ok(useAppStore.getState().threads[draftA], 'Draft A running inline bash must not be pruned')
  const runB = useAppStore.getState().runInlineBash('echo B')

  // Background drafts running in the active workspace contribute to streamingProjectPaths.
  assert.deepEqual(
    streamingProjectPaths(
      [],
      {
        [draftA]: { ...useAppStore.getState().threads[draftA]!, status: { phase: 'ready' } },
        [draftB]: useAppStore.getState().threads[draftB]!
      },
      'draft:other',
      projectPath
    ),
    ['e:/bash-project']
  )

  ensureGates.get(draftA)?.({ ok: true })
  ensureGates.get(draftB)?.({ ok: true })
  await tick()

  assert.equal(bashGates.size, 2, 'both inline bash commands must dispatch concurrently')
  assert.equal(calls.filter((c) => c.command === 'bash' && c.key === draftA).length, 1)
  assert.equal(calls.filter((c) => c.command === 'bash' && c.key === draftB).length, 1)

  // Settling Draft A leaves Draft B still running.
  bashGates.get(draftA)?.({ output: 'out A', exitCode: 0 })
  await runA
  assert.equal(useAppStore.getState().threads[draftA].isStreaming, false)
  assert.equal(useAppStore.getState().threads[draftA].run.settled, true)
  assert.equal(useAppStore.getState().threads[draftB].isStreaming, true)
  assert.equal(useAppStore.getState().threads[draftB].run.settled, false)

  // Stopping Draft B dispatches abort_bash and abort cleanly.
  await useAppStore.getState().stop()
  assert.equal(calls.some((c) => c.command === 'abort_bash' && c.key === draftB), true)
  assert.equal(calls.some((c) => c.command === 'abort' && c.key === draftB), true)
  bashGates.get(draftB)?.({ output: '', exitCode: 130, cancelled: true })
  await runB
  assert.equal(useAppStore.getState().threads[draftB].isStreaming, false)
  assert.equal(useAppStore.getState().threads[draftB].run.settled, true)
  assert.equal(useAppStore.getState().threads[draftB].run.outcome, 'aborted')

  // Exclusive operation lock records operation:* holder metadata and clears on queue release.
  emitQueue({
    ownerId: draftB,
    queued: true,
    position: 1,
    holderOwnerId: 'operation:deadbeef',
    holderCwd: projectPath,
    cwd: projectPath
  })
  assert.deepEqual(useAppStore.getState().threads[draftB].cwdWait, {
    position: 1,
    holderOwnerId: 'operation:deadbeef',
    holderCwd: projectPath,
    externalHolder: undefined,
    cwd: projectPath
  })
  assert.deepEqual(useAppStore.getState().cwdWait, {
    position: 1,
    holderOwnerId: 'operation:deadbeef',
    holderCwd: projectPath,
    externalHolder: undefined,
    cwd: projectPath
  })
  emitQueue({ ownerId: draftB, queued: false, cwd: projectPath })
  assert.equal(useAppStore.getState().threads[draftB].cwdWait, undefined)
  assert.equal(useAppStore.getState().cwdWait, undefined)
})
