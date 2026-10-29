import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AppSettings, PiEvent, RuntimeStartOptions } from '@shared/types'

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
    onStatus: () => () => {},
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
  useAppStore.setState({
    isStreaming: false,
    uiRequest: undefined,
    run: { phase: 'idle', turns: 0, settled: true }
  })
}

const phase = () => useAppStore.getState().run.phase

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

test('P06 — a search hit never stops or switches a running conversation', async () => {
  const previous = useAppStore.getState()
  let stops = 0
  let switches = 0
  let warning = ''
  useAppStore.setState({
    isStreaming: true,
    activeSessionFile: 'active.jsonl',
    pendingJump: undefined,
    stop: async () => { stops += 1 },
    selectSession: async () => { switches += 1 },
    showToast: (message) => { warning = message }
  })
  try {
    await useAppStore.getState().openSearchHit({
      sessionId: 'other', file: 'other.jsonl', cwd: 'C:/project',
      preview: 'Another conversation', updatedAt: 0,
      role: 'assistant', snippet: 'search result', matchStart: 0, matchLength: 6, messageIndex: 0
    }, 'search')
    assert.equal(stops, 0)
    assert.equal(switches, 0)
    assert.equal(useAppStore.getState().activeSessionFile, 'active.jsonl')
    assert.equal(useAppStore.getState().pendingJump, undefined)
    assert.equal(warning, 'Stop the current run to open another conversation')
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
    assert.equal(starts.at(-1)?.cwd, '', 'no-project work must not inherit the previous project')

    useAppStore.setState({ workspace, settings: previous.settings })
    await useAppStore.getState().bootstrap()
    assert.equal(useAppStore.getState().workspace, undefined, 'startup must respect the no-project choice')
    assert.equal(starts.at(-1)?.cwd, '')

    useAppStore.setState({ workspace, settings: { ...saved, activeWorkspaceId: workspace.id } })
    await useAppStore.getState().selectSession({
      id: 'chat', file: 'chat.jsonl', cwd: '', preview: 'General chat', updatedAt: 1, messageCount: 1
    })
    assert.equal(useAppStore.getState().workspace, undefined)
    assert.equal(starts.at(-1)?.sessionFile, 'chat.jsonl')
    assert.equal(saved.activeWorkspaceId, null)

    await useAppStore.getState().selectSession({
      id: 'project-chat', file: 'project.jsonl', cwd: workspace.path,
      preview: 'Project chat', updatedAt: 1, messageCount: 1
    })
    assert.equal(useAppStore.getState().workspace?.id, workspace.id)
    assert.equal(saved.activeWorkspaceId, workspace.id, 'returning to a project restores its selection')
    assert.equal(starts.at(-1)?.cwd, workspace.path)
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
  const workspace = { id: 'project', path: 'C:/project', name: 'Project', lastOpenedAt: 1 }
  const requests: string[] = []
  let warning = ''
  bridge.runtime.request = (command: string) => {
    requests.push(command)
    return ok({})
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
    }],
    showToast: (message) => { warning = message }
  })
  try {
    await useAppStore.getState().renameSessionFile('chat.jsonl', 'Renamed chat')
    assert.deepEqual(requests, [], 'a cross-workspace rename must not switch Pi sessions')
    assert.equal(warning, 'Open that project to rename the conversation')
    assert.equal(useAppStore.getState().activeSessionFile, undefined)
    assert.equal(useAppStore.getState().workspace?.path, workspace.path)
  } finally {
    bridge.runtime.request = originalRequest
    useAppStore.setState(previous)
  }
})

test('a queued no-project selection waits until the current run settles', async () => {
  const previous = useAppStore.getState()
  const selections: (string | null)[] = []
  const workspace = { id: 'project', path: 'C:/project', name: 'Project', lastOpenedAt: 1 }
  useAppStore.setState({ workspace, isStreaming: true, showToast: () => {} })
  try {
    await useAppStore.getState().switchProject(null)
    assert.equal(useAppStore.getState().workspace, workspace)
    assert.equal(useAppStore.getState().pendingProject?.path, null)
    useAppStore.setState({ switchProject: async (path) => { selections.push(path) } })

    emit({ type: 'agent_end' })
    assert.deepEqual(selections, [], 'agent_end must not end the active work')
    emit({ type: 'agent_settled', aborted: false })
    assert.deepEqual(selections, [null])
    assert.equal(useAppStore.getState().pendingProject, undefined)
  } finally {
    useAppStore.setState(previous)
  }
})
