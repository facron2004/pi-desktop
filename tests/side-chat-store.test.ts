import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_SIDE_CHAT_REFERENCES,
  MAX_SIDE_CHAT_SNIPPET_CHARS,
  SIDE_CHAT_TURN_META_ENTRY_TYPE,
  type AppSettings,
  type ModelInfo,
  type PiEvent,
  type RpcTraceHint,
  type RuntimeEnsureOptions,
  type RuntimeStatus,
  type SessionHydrationResult,
  type SideChatStagePromptInput,
  type SideChatStateSnapshot
} from '@shared/types'
import {
  itemsFromMessages,
  mergeHydratedItems,
  type UserItem
} from '../src/renderer/src/lib/thread'
import {
  conversationRows,
  listPendingUiSessions,
  liveConversationRows,
  streamingProjectPaths
} from '../src/renderer/src/lib/live-sessions'
import { trayConversations } from '../src/renderer/src/lib/tray-conversations'
import { loadComposerDrafts, saveComposerDrafts } from '../src/renderer/src/lib/composer-drafts'
import {
  buildMainSyncSummary,
  buildPresetPrompt,
  cleanReplyForHandoff,
  extractActionablePrompts,
  OPEN_SIDE_CHAT_EVENT,
  type SideChatOpenRequest
} from '../src/renderer/src/lib/side-chat-context'
import { IDLE_SIDE_THREAD, readSessionViewSlice } from '../src/renderer/src/lib/conversation-scope'
import { SHORTCUTS } from '../src/renderer/src/lib/shortcuts'
import { APP_COMMANDS, APP_COMMAND_ZH_NAMES } from '../src/renderer/src/lib/app-commands'

type EventPayload = { ownerId: string; event: PiEvent }
type RekeyPayload = { from: string; to: string; replace?: boolean }
type StatusPayload = { ownerId: string; status: RuntimeStatus }

const eventListeners = new Set<(payload: EventPayload) => void>()
const rekeyListeners = new Set<(change: RekeyPayload) => void>()
const statusListeners = new Set<(payload: StatusPayload) => void>()
const windowListeners = new Map<string, Set<(event: Event) => void>>()

const emit = (payload: EventPayload) => eventListeners.forEach((handler) => handler(payload))
const rekey = (change: RekeyPayload) => rekeyListeners.forEach((handler) => handler(change))

function subscribe<T>(listeners: Set<T>, handler: T): () => void {
  listeners.add(handler)
  return () => {
    listeners.delete(handler)
  }
}

const rpcCalls: { command: string; key?: string; payload?: Record<string, unknown> }[] = []
const ensureCalls: RuntimeEnsureOptions[] = []
const settingsPatchCalls: Partial<AppSettings>[] = []
const stagePromptCalls: SideChatStagePromptInput[] = []
const resolveCalls: { parentSessionKey: string; cwd: string }[] = []
const clearCalls: { parentSessionKey: string; cwd: string }[] = []
const stopForParentCalls: string[] = []
const stopCalls: string[] = []
let sessionsListCalls = 0
let gitStatusCalls = 0

let runtimeHasImpl: (key: string) => Promise<boolean> = async () => false
let rpcImpl: (
  command: string,
  payload?: Record<string, unknown>,
  key?: string
) => Promise<unknown> = async (command, _payload, key) => {
  if (command === 'prompt') return { disposition: 'started' }
  if (command === 'get_state') return { sessionFile: key, isStreaming: false }
  if (command === 'get_available_models') return { models: SAMPLE_MODELS }
  if (command === 'get_available_thinking_levels') return { levels: ['low', 'medium', 'high'] }
  return {}
}
let sideResolveImpl: (parentSessionKey: string, cwd: string) => Promise<SideChatStateSnapshot> = async (
  parentSessionKey
) => ({
  parentSessionKey,
  activeSideKey: 'draft:side:resolved-1',
  hasPersistedHistory: false,
  parentRunning: false,
  parentTurnCount: 0,
  sessionChangedFiles: []
})
let sideClearImpl: (parentSessionKey: string, cwd: string) => Promise<SideChatStateSnapshot> = async (
  parentSessionKey
) => ({
  parentSessionKey,
  activeSideKey: 'draft:side:cleared-1',
  hasPersistedHistory: false,
  parentRunning: false,
  parentTurnCount: 0,
  sessionChangedFiles: []
})

const storageMap = new Map<string, string>()
const mockStorage: Storage = {
  get length() {
    return storageMap.size
  },
  clear() {
    storageMap.clear()
  },
  getItem(key: string) {
    return storageMap.has(key) ? storageMap.get(key)! : null
  },
  key(index: number) {
    return [...storageMap.keys()][index] ?? null
  },
  removeItem(key: string) {
    storageMap.delete(key)
  },
  setItem(key: string, value: string) {
    storageMap.set(key, String(value))
  }
}

const SAMPLE_MODELS: ModelInfo[] = [
  {
    id: 'gpt-5',
    name: 'GPT-5',
    api: 'openai-responses',
    provider: 'openai',
    reasoning: true,
    input: ['text'],
    contextWindow: 200_000,
    maxTokens: 16_384
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    api: 'anthropic-messages',
    provider: 'anthropic',
    reasoning: true,
    input: ['text'],
    contextWindow: 200_000,
    maxTokens: 16_384
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    api: 'anthropic-messages',
    provider: 'anthropic',
    reasoning: true,
    input: ['text'],
    contextWindow: 200_000,
    maxTokens: 8_192
  }
]

const bridge = {
  app: {
    info: async () => ({}),
    setTheme: async () => {}
  },
  settings: {
    get: async () => ({
      workspaces: [],
      model: 'openai/gpt-5',
      provider: 'openai',
      thinkingLevel: 'low',
      theme: 'dark',
      language: 'en'
    }),
    patch: async (patch: Partial<AppSettings>) => {
      settingsPatchCalls.push(patch)
      return { ...useAppStore.getState().settings, ...patch }
    }
  },
  workspaces: {
    add: async (p: string) => {
      const workspace = { id: p, name: p, path: p, lastOpenedAt: 0 }
      return { workspace, settings: { ...useAppStore.getState().settings, workspaces: [workspace] } }
    },
    remove: async () => useAppStore.getState().settings
  },
  sessions: {
    list: async () => {
      sessionsListCalls += 1
      return []
    },
    hydrate: async (): Promise<SessionHydrationResult> => ({ messages: [], historyTruncated: false }),
    remove: async () => true
  },
  git: {
    status: async () => {
      gitStatusCalls += 1
      return { isRepo: false }
    }
  },
  sideChat: {
    resolve: async (parentSessionKey: string, cwd: string) => {
      resolveCalls.push({ parentSessionKey, cwd })
      return sideResolveImpl(parentSessionKey, cwd)
    },
    stagePrompt: async (input: SideChatStagePromptInput) => {
      stagePromptCalls.push(input)
    },
    clear: async (parentSessionKey: string, cwd: string) => {
      clearCalls.push({ parentSessionKey, cwd })
      return sideClearImpl(parentSessionKey, cwd)
    },
    stopForParent: async (parentSessionKey: string) => {
      stopForParentCalls.push(parentSessionKey)
    }
  },
  runtime: {
    ensure: async (options: RuntimeEnsureOptions) => {
      ensureCalls.push(options)
      return { ok: true }
    },
    has: async (key: string) => runtimeHasImpl(key),
    stop: async (key?: string) => {
      if (key) stopCalls.push(key)
    },
    onEvent: (handler: (payload: EventPayload) => void) => subscribe(eventListeners, handler),
    onRekey: (handler: (change: RekeyPayload) => void) => subscribe(rekeyListeners, handler),
    onStatus: (handler: (payload: StatusPayload) => void) => subscribe(statusListeners, handler),
    request: async (
      command: string,
      payload?: Record<string, unknown>,
      _timeout?: number,
      _trace?: RpcTraceHint,
      key?: string
    ) => {
      rpcCalls.push({ command, key, payload })
      return rpcImpl(command, payload, key)
    }
  }
}

Object.assign(globalThis, {
  localStorage: mockStorage,
  document: {
    visibilityState: 'visible',
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    addEventListener() {},
    removeEventListener() {},
    hasFocus: () => true
  },
  window: {
    pi: bridge,
    location: { search: '' },
    localStorage: mockStorage,
    matchMedia: () => ({ matches: true }),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener: (type: string, handler: (event: Event) => void) => {
      const set = windowListeners.get(type) ?? new Set()
      set.add(handler)
      windowListeners.set(type, set)
    },
    removeEventListener: (type: string, handler: (event: Event) => void) => {
      windowListeners.get(type)?.delete(handler)
    },
    dispatchEvent: (event: Event) => {
      windowListeners.get(event.type)?.forEach((handler) => handler(event))
      return true
    }
  }
})

const {
  useAppStore,
  enforceSessionLru,
  touchSessionLru,
  resolveEffectiveSessionModel,
  resolveEffectiveThinkingLevel
} = await import('../src/renderer/src/store/useAppStore')

await useAppStore.getState().bootstrap()

function resetTestState(): void {
  rpcCalls.length = 0
  ensureCalls.length = 0
  settingsPatchCalls.length = 0
  stagePromptCalls.length = 0
  resolveCalls.length = 0
  clearCalls.length = 0
  stopForParentCalls.length = 0
  stopCalls.length = 0
  sessionsListCalls = 0
  gitStatusCalls = 0
  storageMap.clear()
  windowListeners.clear()
  runtimeHasImpl = async () => false
  rpcImpl = async (command, _payload, key) => {
    if (command === 'prompt') return { disposition: 'started' }
    if (command === 'get_state') return { sessionFile: key, isStreaming: false }
    if (command === 'get_available_models') return { models: SAMPLE_MODELS }
    if (command === 'get_available_thinking_levels') return { levels: ['low', 'medium', 'high'] }
    return {}
  }
  sideResolveImpl = async (parentSessionKey) => ({
    parentSessionKey,
    activeSideKey: 'draft:side:resolved-1',
    hasPersistedHistory: false,
    parentRunning: false,
    parentTurnCount: 0,
    sessionChangedFiles: []
  })
  sideClearImpl = async (parentSessionKey) => ({
    parentSessionKey,
    activeSideKey: 'draft:side:cleared-1',
    hasPersistedHistory: false,
    parentRunning: false,
    parentTurnCount: 0,
    sessionChangedFiles: []
  })
  useAppStore.setState({
    settings: {
      ...useAppStore.getState().settings,
      workspaces: [{ id: 'ws-1', name: 'Demo', path: '/repo/demo', lastOpenedAt: 1 }],
      activeWorkspaceId: 'ws-1',
      model: 'openai/gpt-5',
      provider: 'openai',
      thinkingLevel: 'low',
      language: 'en'
    },
    workspace: { id: 'ws-1', name: 'Demo', path: '/repo/demo', lastOpenedAt: 1 },
    sessions: [],
    threads: {},
    items: [],
    drafts: {},
    activeSessionFile: undefined,
    draftId: undefined,
    sideChatOpen: false,
    sideSessionKey: undefined,
    sideNotices: {},
    sideByMainKey: {},
    sideParentByKey: {},
    sideModelOverrides: {},
    sideThinkingOverrides: {},
    sideQuotes: {},
    hydratingSessions: {},
    composerTexts: {},
    composerInserts: {},
    composerText: undefined,
    composerInsert: undefined,
    sessionNotices: {},
    models: SAMPLE_MODELS,
    catalogModels: SAMPLE_MODELS,
    disabledModelSpecs: [],
    thinkingLevels: ['low', 'medium', 'high'],
    isStreaming: false,
    run: { phase: 'idle', turns: 0, settled: true },
    error: undefined,
    toast: undefined,
    deskPage: null
  })
}

afterEach(() => {
  delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
  delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame
  resetTestState()
})

test('a failed side chat clear keeps the visible binding and draft and reports the error', async () => {
  resetTestState()
  const mainKey = '/sessions/main-clear-error.jsonl'
  const sideKey = '/sessions/_side-chats/side-clear-error.jsonl'
  const draft = { text: 'Keep my unsent reply', images: [] }
  useAppStore.setState({
    activeSessionFile: mainKey,
    sideChatOpen: true,
    sideSessionKey: sideKey,
    sideByMainKey: { [mainKey]: sideKey },
    sideParentByKey: { [sideKey]: mainKey },
    drafts: { [sideKey]: draft }
  })
  sideClearImpl = async () => { throw new Error('Disk refused removal') }

  assert.equal(await useAppStore.getState().clearActiveSideChat(), undefined)
  const state = useAppStore.getState()
  assert.equal(state.sideSessionKey, sideKey)
  assert.equal(state.sideByMainKey[mainKey], sideKey)
  assert.equal(state.sideParentByKey[sideKey], mainKey)
  assert.deepEqual(state.drafts[sideKey], draft)
  assert.deepEqual(state.toast, { text: 'Disk refused removal', level: 'error' })
})

test('clear updates its own side chat after the active main conversation switches', async () => {
  resetTestState()
  const mainA = '/sessions/main-clear-a.jsonl'
  const mainB = '/sessions/main-clear-b.jsonl'
  const sideA = '/sessions/_side-chats/side-clear-a.jsonl'
  const sideB = '/sessions/_side-chats/side-clear-b.jsonl'
  const freshA = 'draft:side:cleared-a'
  useAppStore.setState({
    activeSessionFile: mainA,
    sideChatOpen: true,
    sideSessionKey: sideA,
    sideByMainKey: { [mainA]: sideA, [mainB]: sideB },
    sideParentByKey: { [sideA]: mainA, [sideB]: mainB }
  })
  const requested = Promise.withResolvers<void>()
  const response = Promise.withResolvers<SideChatStateSnapshot>()
  sideClearImpl = () => {
    requested.resolve()
    return response.promise
  }

  const clearing = useAppStore.getState().clearActiveSideChat()
  await requested.promise
  useAppStore.setState({ activeSessionFile: mainB, sideSessionKey: sideB })
  response.resolve({
    parentSessionKey: mainA,
    activeSideKey: freshA,
    hasPersistedHistory: false,
    parentRunning: false,
    parentTurnCount: 0,
    sessionChangedFiles: []
  })
  await clearing
  const state = useAppStore.getState()
  assert.deepEqual(clearCalls, [{ parentSessionKey: mainA, cwd: '/repo/demo' }])
  assert.equal(state.sideSessionKey, sideB)
  assert.deepEqual(state.sideByMainKey, { [mainA]: freshA, [mainB]: sideB })
  assert.deepEqual(state.sideParentByKey, { [freshA]: mainA, [sideB]: mainB })
})

test('dual-stream 60fps rAF coalescing isolates Main and Side deltas with zero cross-talk', () => {
  resetTestState()
  const rafQueue: { id: number; cb: FrameRequestCallback }[] = []
  let nextRafId = 1
  Object.assign(globalThis, {
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      const id = nextRafId++
      rafQueue.push({ id, cb })
      return id
    },
    cancelAnimationFrame: (id: number) => {
      const idx = rafQueue.findIndex((entry) => entry.id === id)
      if (idx >= 0) rafQueue.splice(idx, 1)
    }
  })
  const flushFrame = () => {
    const batch = rafQueue.splice(0)
    for (const entry of batch) entry.cb(performance.now())
  }

  const mainKey = '/sessions/main-stream.jsonl'
  const sideKey = '/sessions/_side-chats/side-stream.jsonl'
  useAppStore.setState({
    activeSessionFile: mainKey,
    sideChatOpen: true,
    sideSessionKey: sideKey,
    sideByMainKey: { [mainKey]: sideKey },
    sideParentByKey: { [sideKey]: mainKey }
  })

  // Unmaterialized Side Chat falls back to module-frozen IDLE_SIDE_THREAD (zero allocations)
  const coldSliceA = readSessionViewSlice(useAppStore.getState(), 'side', sideKey)
  const coldSliceB = readSessionViewSlice(useAppStore.getState(), 'side', sideKey)
  assert.equal(coldSliceA.items, IDLE_SIDE_THREAD.items)
  assert.equal(coldSliceA.items, coldSliceB.items)

  // Start both runs concurrently
  emit({ ownerId: mainKey, event: { type: 'agent_start' } })
  emit({ ownerId: mainKey, event: { type: 'turn_start' } })
  emit({ ownerId: mainKey, event: { type: 'message_start', message: { role: 'assistant', content: [] } } })

  emit({ ownerId: sideKey, event: { type: 'agent_start' } })
  emit({ ownerId: sideKey, event: { type: 'turn_start' } })
  emit({ ownerId: sideKey, event: { type: 'message_start', message: { role: 'assistant', content: [] } } })
  flushFrame()

  // Simultaneous Main + Side text deltas coalesce into ONE rAF flush and ONE store notification
  let storeCommits = 0
  const unsub = useAppStore.subscribe(() => {
    storeCommits += 1
  })
  try {
    emit({
      ownerId: mainKey,
      event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Main ' } }
    })
    emit({
      ownerId: mainKey,
      event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'reply' } }
    })
    emit({
      ownerId: sideKey,
      event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Side ' } }
    })
    emit({
      ownerId: sideKey,
      event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'answer' } }
    })
    assert.equal(rafQueue.length, 1, 'both streams share one animation frame handle')
    storeCommits = 0
    flushFrame()
    assert.equal(storeCommits, 1, 'simultaneous Main + Side deltas commit in one atomic store update')

    const afterDual = useAppStore.getState()
    const assistantText = (items: typeof afterDual.items) => {
      const msg = items.find((i) => i.kind === 'assistant')
      if (!msg || msg.kind !== 'assistant') return ''
      return msg.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
    }
    assert.equal(assistantText(afterDual.items), 'Main reply')
    assert.equal(assistantText(afterDual.threads[sideKey].items), 'Side answer')

    // Side-only text delta must NOT touch Main state.items, activeToolsRevision, threadsMetaVersion, or sideToolsRevision
    const mainItemsBefore = afterDual.items
    const mainToolsBefore = afterDual.activeToolsRevision
    const metaBefore = afterDual.threadsMetaVersion
    const sideToolsBefore = afterDual.sideToolsRevision
    emit({
      ownerId: sideKey,
      event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '!' } }
    })
    flushFrame()
    const afterSideDelta = useAppStore.getState()
    assert.equal(afterSideDelta.items, mainItemsBefore, 'Side delta preserves Main items reference')
    assert.equal(afterSideDelta.activeToolsRevision, mainToolsBefore)
    assert.equal(afterSideDelta.threadsMetaVersion, metaBefore)
    assert.equal(afterSideDelta.sideToolsRevision, sideToolsBefore)

    // Main-only text delta must NOT touch Side thread reference or sideToolsRevision
    const sideThreadBefore = afterSideDelta.threads[sideKey]
    emit({
      ownerId: mainKey,
      event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '!' } }
    })
    flushFrame()
    const afterMainDelta = useAppStore.getState()
    assert.equal(afterMainDelta.threads[sideKey], sideThreadBefore, 'Main delta preserves Side thread reference')
    assert.equal(afterMainDelta.sideToolsRevision, sideToolsBefore)

    // Side-only tool call bumps ONLY sideToolsRevision (not Main activeToolsRevision or threadsToolsRevision)
    const threadsToolsBefore = afterMainDelta.threadsToolsRevision
    emit({
      ownerId: sideKey,
      event: { type: 'tool_execution_start', toolCallId: 'side-read-1', toolName: 'read', args: { path: 'a.ts' } }
    })
    const afterSideTool = useAppStore.getState()
    assert.equal(afterSideTool.sideToolsRevision, sideToolsBefore + 1)
    assert.equal(afterSideTool.activeToolsRevision, mainToolsBefore)
    assert.equal(afterSideTool.threadsToolsRevision, threadsToolsBefore)
  } finally {
    unsub()
  }
})

test('enforceSessionLru protects both active Main and open Side Chat while evicting older threads', () => {
  resetTestState()
  const mainActive = '/sessions/main-active.jsonl'
  const sideActive = '/sessions/_side-chats/side-active.jsonl'
  const makeLoadedThread = (text: string) => ({
    items: [
      { id: `u-${text}`, kind: 'user' as const, text, images: [], timestamp: 1, order: 1 }
    ],
    historyLoaded: true,
    run: { phase: 'idle' as const, turns: 1, settled: true },
    isStreaming: false,
    transport: 'connected' as const,
    uiRequests: [],
    clientKey: `client-${text}`,
    uiStatuses: [],
    uiWidgets: [],
    queue: { steering: [], followUp: [] },
    status: { phase: 'ready' as const },
    forkTargets: [],
    agentMode: 'default' as const,
    models: [],
    thinkingLevels: [],
    commands: APP_COMMANDS,
    submitSeq: 1,
    version: 3
  })

  const threads: Record<string, ReturnType<typeof makeLoadedThread>> = {}
  // Touch active Main and active Side first (making them the oldest in LRU!)
  threads[mainActive] = makeLoadedThread('main-active')
  touchSessionLru(mainActive)
  threads[sideActive] = makeLoadedThread('side-active')
  touchSessionLru(sideActive)

  for (let i = 1; i <= 12; i += 1) {
    const file = `/sessions/old-${i}.jsonl`
    threads[file] = makeLoadedThread(`old-${i}`)
    touchSessionLru(file)
  }

  const evicted = enforceSessionLru(threads, new Set([mainActive, sideActive]), 10)
  assert.equal(evicted[mainActive].items.length, 1, 'active Main is protected from LRU eviction')
  assert.equal(evicted[sideActive].items.length, 1, 'open Side Chat is protected from LRU eviction')
  assert.equal(evicted['/sessions/old-1.jsonl'].items.length, 0, 'oldest inactive session is evicted')
  assert.equal(evicted['/sessions/old-2.jsonl'].items.length, 0, 'second oldest inactive session is evicted')
  assert.equal(evicted['/sessions/old-3.jsonl'].items.length, 1, 'within-cap inactive session survives')
})

test('Side Chat model and thinking isolation: rememberDefaults false, zero cold boot, parent Main inheritance, independent lock', async () => {
  resetTestState()
  const mainKey = '/sessions/main-model.jsonl'
  const sideDraft = 'draft:side:model-1'
  const sidePersisted = '/sessions/_side-chats/side-persisted.jsonl'

  useAppStore.setState({
    activeSessionFile: mainKey,
    sideChatOpen: true,
    sideSessionKey: sideDraft,
    sideByMainKey: { [mainKey]: sideDraft },
    sideParentByKey: { [sideDraft]: mainKey, [sidePersisted]: mainKey },
    threads: {
      [mainKey]: {
        ...useAppStore.getState().threads[mainKey],
        items: [],
        run: { phase: 'idle', turns: 0, settled: true },
        isStreaming: false,
        transport: 'connected',
        uiRequests: [],
        clientKey: 'c-main',
        uiStatuses: [],
        uiWidgets: [],
        queue: { steering: [], followUp: [] },
        status: { phase: 'ready', cwd: '/repo/demo' },
        forkTargets: [],
        agentMode: 'default',
        models: SAMPLE_MODELS,
        thinkingLevels: ['low', 'medium', 'high'],
        commands: APP_COMMANDS,
        piState: {
          model: SAMPLE_MODELS[1], // anthropic/claude-opus-4-6 (differs from global openai/gpt-5!)
          thinkingLevel: 'high',
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'one-at-a-time',
          followUpMode: 'one-at-a-time',
          sessionId: 'm1',
          autoCompactionEnabled: true,
          messageCount: 1,
          pendingMessageCount: 0
        },
        version: 1
      }
    }
  })

  // Before any Side override, Side inherits parent Main's effective model & effort (not global settings)
  assert.equal(resolveEffectiveSessionModel(useAppStore.getState(), sideDraft, SAMPLE_MODELS)?.id, 'claude-opus-4-6')
  assert.equal(resolveEffectiveThinkingLevel(useAppStore.getState(), sideDraft), 'high')

  // Cold Side picker click stores overrides ONLY in sideModelOverrides / sideThinkingOverrides
  runtimeHasImpl = async () => false
  const ok = await useAppStore.getState().setModel(SAMPLE_MODELS[2], {
    sessionKey: sideDraft,
    rememberDefaults: false
  })
  assert.equal(ok, true)
  await useAppStore.getState().setThinkingLevel('medium', {
    sessionKey: sideDraft,
    rememberDefaults: false
  })

  assert.equal(settingsPatchCalls.length, 0, 'Side model/thinking change must NEVER patch global settings')
  assert.equal(ensureCalls.length, 0, 'Cold Side picker click must NEVER boot Pi')
  assert.equal(useAppStore.getState().settings.model, 'openai/gpt-5')
  assert.equal(useAppStore.getState().settings.thinkingLevel, 'low')
  assert.equal(resolveEffectiveSessionModel(useAppStore.getState(), sideDraft, SAMPLE_MODELS)?.id, 'claude-haiku-4-5')
  assert.equal(resolveEffectiveThinkingLevel(useAppStore.getState(), sideDraft), 'medium')

  // Launching Side draft passes its override, role and Main conversation key.
  await useAppStore.getState().ensureRuntime(sideDraft, 'side-prompt-send')
  assert.equal(ensureCalls.length, 1)
  assert.equal(ensureCalls[0].role, 'side')
  assert.equal(ensureCalls[0].parentSessionKey, mainKey)
  assert.equal(ensureCalls[0].model, 'anthropic/claude-haiku-4-5')
  assert.equal(ensureCalls[0].thinkingLevel, 'medium')

  // Cold persisted Side session queues pending model/thinking and applies them via RPC on ensureRuntime
  ensureCalls.length = 0
  rpcCalls.length = 0
  await useAppStore.getState().setModel(SAMPLE_MODELS[2], { sessionKey: sidePersisted, rememberDefaults: false })
  await useAppStore.getState().setThinkingLevel('high', { sessionKey: sidePersisted, rememberDefaults: false })
  assert.equal(ensureCalls.length, 0)
  assert.equal(settingsPatchCalls.length, 0)

  await useAppStore.getState().ensureRuntime(sidePersisted, 'side-prompt-send')
  assert.ok(rpcCalls.some((c) => c.command === 'set_model' && c.key === sidePersisted && c.payload?.modelId === 'claude-haiku-4-5'))
  assert.ok(rpcCalls.some((c) => c.command === 'set_thinking_level' && c.key === sidePersisted && c.payload?.level === 'high'))

  // Per-session picker lock: an in-flight Main model change does NOT block Side Chat picker
  let releaseMain!: () => void
  const mainBlocked = new Promise<void>((resolve) => {
    releaseMain = resolve
  })
  runtimeHasImpl = async (k) => k === mainKey
  rpcImpl = async (command, _payload, key) => {
    if (command === 'set_model' && key === mainKey) {
      await mainBlocked
      return {}
    }
    if (command === 'get_state') return {
      sessionFile: key,
      isStreaming: false,
      model: SAMPLE_MODELS[0],
      thinkingLevel: 'low'
    }
    if (command === 'get_available_models') return { models: SAMPLE_MODELS }
    return {}
  }
  const { refreshState } = useAppStore.getState()
  let refreshed: Promise<void> | undefined
  useAppStore.setState({ refreshState: (...args) => (refreshed = refreshState(...args)) })
  const mainChange = useAppStore.getState().setModel(SAMPLE_MODELS[0], { sessionKey: mainKey })
  try {
    const sideChangedWhileMainInFlight = await useAppStore.getState().setModel(SAMPLE_MODELS[1], {
      sessionKey: sideDraft,
      rememberDefaults: false
    })
    assert.equal(sideChangedWhileMainInFlight, true, 'Side Chat picker is not blocked by Main picker lock')
  } finally {
    releaseMain()
    await mainChange
    await refreshed
    useAppStore.setState({ refreshState })
  }
})

test('handoffSideToMain strictly never steers Main (draft insert = 0 RPCs, queue-followup only while Main runs)', async () => {
  resetTestState()
  const mainKey = '/sessions/main-handoff.jsonl'
  const sideKey = '/sessions/_side-chats/side-handoff.jsonl'
  const focusEvents: Event[] = []
  window.addEventListener('pi:focus-composer', (event) => focusEvents.push(event))

  useAppStore.setState({
    activeSessionFile: mainKey,
    sideChatOpen: true,
    sideSessionKey: sideKey,
    sideByMainKey: { [mainKey]: sideKey },
    sideParentByKey: { [sideKey]: mainKey },
    // Even if piState reports steering mode settings, handoff must NEVER steer!
    piState: {
      isStreaming: false,
      isCompacting: false,
      steeringMode: 'all',
      followUpMode: 'all',
      sessionId: 'm-handoff',
      autoCompactionEnabled: true,
      messageCount: 1,
      pendingMessageCount: 0
    },
    isStreaming: false,
    run: { phase: 'idle', turns: 1, settled: true }
  })

  // 1. draft-append makes 0 RPCs and focuses Main composer
  const r1 = await useAppStore.getState().handoffSideToMain({
    sideSessionKey: sideKey,
    text: 'Check auth.ts line 42',
    mode: 'draft-append'
  })
  assert.equal(r1, 'inserted')
  assert.deepEqual(rpcCalls, [])
  assert.equal(useAppStore.getState().drafts[mainKey]?.text, 'Check auth.ts line 42')
  assert.equal(useAppStore.getState().composerInserts[mainKey]?.text, 'Check auth.ts line 42')
  assert.equal(focusEvents.length, 1)

  // 2. draft-replace replaces text with 0 RPCs
  const r2 = await useAppStore.getState().handoffSideToMain({
    sideSessionKey: sideKey,
    text: 'Run npm test after fixing auth.ts',
    mode: 'draft-replace'
  })
  assert.equal(r2, 'inserted')
  assert.deepEqual(rpcCalls, [])
  assert.equal(useAppStore.getState().drafts[mainKey]?.text, 'Run npm test after fixing auth.ts')

  // 3. queue-followup while Main is IDLE returns 'noop' and makes 0 RPCs
  const r3 = await useAppStore.getState().handoffSideToMain({
    sideSessionKey: sideKey,
    text: 'Should not send while idle',
    mode: 'queue-followup'
  })
  assert.equal(r3, 'noop')
  assert.deepEqual(rpcCalls, [])

  // 4. A running Main receives only the native follow-up RPC.
  emit({ ownerId: mainKey, event: { type: 'agent_start' } })
  rpcImpl = async () => ({ disposition: 'queued' })
  const r4 = await useAppStore.getState().handoffSideToMain({
    sideSessionKey: sideKey,
    text: 'Follow up with regression tests',
    mode: 'queue-followup'
  })
  assert.equal(r4, 'queued')
  assert.deepEqual(rpcCalls, [{
    command: 'follow_up', key: mainKey, payload: { message: 'Follow up with regression tests' }
  }])
  assert.deepEqual(ensureCalls, [])

  // 5. Main settled before the supervisor could forward the follow-up.
  useAppStore.setState({ toast: undefined })
  rpcImpl = async () => ({ disposition: 'handled', cancelled: true })
  assert.equal(await useAppStore.getState().handoffSideToMain({
    sideSessionKey: sideKey,
    text: 'Main just finished',
    mode: 'queue-followup'
  }), 'noop')
  assert.equal(useAppStore.getState().toast, undefined)
})

test('a stale side chat card cannot insert or queue a prompt in the currently viewed conversation', async () => {
  resetTestState()
  const mainKey = '/sessions/current-main.jsonl'
  const currentSideKey = 'draft:side:current'
  const staleSideKey = 'draft:side:cleared'
  useAppStore.setState({
    activeSessionFile: mainKey,
    sideChatOpen: true,
    sideSessionKey: currentSideKey,
    sideByMainKey: { [mainKey]: currentSideKey },
    sideParentByKey: { [currentSideKey]: mainKey },
    drafts: { [mainKey]: { text: 'Keep this draft', images: [] } }
  })
  emit({ ownerId: mainKey, event: { type: 'agent_start' } })
  rpcImpl = async () => ({ disposition: 'queued' })

  const { handoffSideToMain } = useAppStore.getState()
  const insert = await handoffSideToMain({ sideSessionKey: staleSideKey, text: 'Stale draft', mode: 'draft-replace' })
  const queue = await handoffSideToMain({ sideSessionKey: staleSideKey, text: 'Stale request', mode: 'queue-followup' })

  assert.deepEqual([insert, queue], ['noop', 'noop'])
  assert.equal(useAppStore.getState().drafts[mainKey]?.text, 'Keep this draft')
  assert.deepEqual(ensureCalls, [])
  assert.deepEqual(rpcCalls, [])
})

test('reference chip lifecycle, failed-send preservation, live/hydrated sideRefs, and parallel side commands', async () => {
  resetTestState()
  const mainKey = '/sessions/main-refs.jsonl'
  const sideKey = 'draft:side:refs-1'
  useAppStore.setState({
    activeSessionFile: mainKey,
    sideChatOpen: true,
    sideSessionKey: sideKey,
    sideByMainKey: { [mainKey]: sideKey },
    sideParentByKey: { [sideKey]: mainKey }
  })

  // Clamp long snippet + dedupe identical target + enforce MAX_SIDE_CHAT_REFERENCES (6)
  const hugeSnippet = 'x'.repeat(MAX_SIDE_CHAT_SNIPPET_CHARS + 500)
  const firstRef = useAppStore.getState().attachSideReference(
    { kind: 'selection', source: 'assistant', snippet: hugeSnippet, turnId: 't-1' },
    sideKey
  )
  assert.ok(firstRef && firstRef.kind === 'selection')
  assert.equal(firstRef.snippet.length, MAX_SIDE_CHAT_SNIPPET_CHARS)

  // Deduplicating same target replaces instead of adding duplicate
  const sameRef = useAppStore.getState().attachSideReference(
    { kind: 'selection', source: 'assistant', snippet: hugeSnippet, turnId: 't-1' },
    sideKey
  )
  assert.equal(sameRef?.id, firstRef.id)
  assert.equal(useAppStore.getState().sideQuotes[sideKey]?.length, 1)

  // Fill up to cap (6 total)
  for (let i = 2; i <= MAX_SIDE_CHAT_REFERENCES; i += 1) {
    const added = useAppStore.getState().attachSideReference(
      { kind: 'turn', turnId: `t-${i}`, turnOrdinal: i, preview: `Turn ${i}` },
      sideKey
    )
    assert.ok(added)
  }
  assert.equal(useAppStore.getState().sideQuotes[sideKey]?.length, MAX_SIDE_CHAT_REFERENCES)

  // 7th reference rejected with toast
  const overflow = useAppStore.getState().attachSideReference(
    { kind: 'turn', turnId: 't-7', turnOrdinal: 7, preview: 'Turn 7' },
    sideKey
  )
  assert.equal(overflow, undefined)
  assert.equal(useAppStore.getState().sideQuotes[sideKey]?.length, MAX_SIDE_CHAT_REFERENCES)

  // Remove one chip & clear works
  useAppStore.getState().removeSideReference(firstRef.id, sideKey)
  assert.equal(useAppStore.getState().sideQuotes[sideKey]?.length, MAX_SIDE_CHAT_REFERENCES - 1)
  useAppStore.getState().clearSideReferences(sideKey)
  assert.equal(useAppStore.getState().sideQuotes[sideKey], undefined)

  // Re-attach 1 ref: Main-only commands stay blocked on Side Chat, while !bash, /image, /compact, kind, and scoped mode work
  const ref = useAppStore.getState().attachSideReference(
    { kind: 'tool', toolCallId: 'tc-1', toolName: 'edit', summary: 'Edited auth.ts', status: 'ok' },
    sideKey
  )!
  assert.equal(await useAppStore.getState().sendSidePrompt('/branch'), false)
  assert.equal(await useAppStore.getState().sendSidePrompt('/duplicate'), false)
  assert.equal(await useAppStore.getState().sendSidePrompt('/new'), false)
  assert.equal(await useAppStore.getState().sendSidePrompt('/side'), false)
  assert.equal(rpcCalls.length, 0)
  assert.equal(useAppStore.getState().sideQuotes[sideKey]?.length, 1)

  // `/image` targets Side Composer without switching Main Composer
  const imageEvents: CustomEvent[] = []
  const onImageMode = (event: Event) => imageEvents.push(event as CustomEvent)
  window.addEventListener('pi:enter-image-mode', onImageMode)
  try {
    assert.equal(await useAppStore.getState().sendSidePrompt('/image draw architecture'), true)
    assert.equal(imageEvents.length, 1)
    assert.deepEqual(imageEvents[0]?.detail, { prompt: 'draw architecture', target: 'side' })
  } finally {
    window.removeEventListener('pi:enter-image-mode', onImageMode)
  }

  // Inline bash (`!` and `!!`) runs on Side Chat via Pi's bash RPC and leaves Main untouched
  rpcImpl = async (command) => {
    if (command === 'bash') return { output: 'ok', exitCode: 0 }
    if (command === 'prompt') throw new Error('Network error')
    return {}
  }
  assert.equal(await useAppStore.getState().sendSidePrompt('!echo hello'), true)
  assert.equal(await useAppStore.getState().sendSidePrompt('!!pwd'), true)
  const bashCalls = rpcCalls.filter((c) => c.command === 'bash')
  assert.equal(bashCalls.length, 2)
  assert.equal(bashCalls[0]?.key, sideKey)
  assert.equal(bashCalls[0]?.payload?.command, 'echo hello')
  assert.equal(bashCalls[0]?.payload?.excludeFromContext, false)
  assert.equal(bashCalls[1]?.key, sideKey)
  assert.equal(bashCalls[1]?.payload?.command, 'pwd')
  assert.equal(bashCalls[1]?.payload?.excludeFromContext, true)

  // `/compact` compacts Side Chat's own context
  rpcCalls.length = 0
  rpcImpl = async (command) => {
    if (command === 'get_commands') return { commands: [] }
    if (command === 'compact') return {}
    if (command === 'prompt') throw new Error('Network error')
    return {}
  }
  assert.equal(await useAppStore.getState().sendSidePrompt('/compact focus diffs'), true)
  const compactRpc = rpcCalls.find((c) => c.command === 'compact' && c.key === sideKey)
  assert.equal(compactRpc?.payload?.customInstructions, 'focus diffs')

  // Scoped setAgentMode switches only Side Chat's mode without mutating Main
  rpcCalls.length = 0
  rpcImpl = async () => ({})
  await useAppStore.getState().setAgentMode('plan', sideKey)
  assert.equal(useAppStore.getState().threads[sideKey]?.agentMode, 'plan')
  assert.equal(useAppStore.getState().agentMode, 'default')
  assert.equal(
    rpcCalls.some((c) => c.command === 'prompt' && c.key === sideKey && c.payload?.message === '/desktop-mode plan'),
    true
  )
  rpcCalls.length = 0

  // Failed send MUST preserve sideQuotes!
  rpcImpl = async (command) => {
    if (command === 'prompt') throw new Error('Network error')
    return {}
  }
  const failed = await useAppStore.getState().sendSidePrompt('Explain this edit')
  assert.equal(failed, false)
  assert.equal(useAppStore.getState().sideQuotes[sideKey]?.length, 1, 'failed send keeps attached chips')

  // Successful send calls stagePrompt, sends clean prompt, attaches sideRefs to echoed UserItem, clears quotes
  rpcImpl = async (command) => {
    if (command === 'prompt') return { disposition: 'started' }
    return {}
  }
  stagePromptCalls.length = 0
  rpcCalls.length = 0
  const sent = await useAppStore.getState().sendSidePrompt('Explain this edit')
  assert.equal(sent, true)
  assert.equal(stagePromptCalls.length, 1)
  assert.equal(stagePromptCalls[0].sideSessionKey, sideKey)
  assert.equal(stagePromptCalls[0].parentSessionKey, mainKey)
  assert.equal(stagePromptCalls[0].references?.length, 1)
  assert.equal(stagePromptCalls[0].references?.[0].id, ref.id)

  const promptRpc = rpcCalls.find((c) => c.command === 'prompt' && c.key === sideKey)
  assert.equal(promptRpc?.payload?.message, 'Explain this edit', 'user message stays clean without injected markdown')
  assert.equal(useAppStore.getState().sideQuotes[sideKey], undefined, 'sent reference chips cleared on accepted')

  // Echoed user message receives staged sideRefs automatically
  emit({
    ownerId: sideKey,
    event: {
      type: 'message_start',
      message: { role: 'user', content: 'Explain this edit', timestamp: 1234 }
    }
  })
  emit({
    ownerId: sideKey,
    event: {
      type: 'message_end',
      message: { role: 'user', content: 'Explain this edit', timestamp: 1234 }
    }
  })
  const liveUser = useAppStore.getState().threads[sideKey]?.items.find((i): i is UserItem => i.kind === 'user')
  assert.equal(liveUser?.sideRefs?.length, 1)
  assert.equal(liveUser?.sideRefs?.[0].id, ref.id)

  // submitComposerDraft forwards kind ('steer') and image options (/desktop-image) to Side Chat
  rpcCalls.length = 0
  const imageSent = await useAppStore.getState().submitComposerDraft(sideKey, {
    draft: { text: 'Draw module graph', images: [] },
    text: 'Draw module graph',
    kind: 'steer',
    sendImage: { model: 'gpt-image-1.5', size: '1024x1024', quality: 'medium', count: 2 }
  })
  assert.equal(imageSent, true)
  const sideImageSetup = rpcCalls.find(
    (c) => c.command === 'prompt' && c.key === sideKey && String(c.payload?.message ?? '').startsWith('/desktop-image ')
  )
  assert.ok(sideImageSetup, 'submitComposerDraft must forward image options to Side Chat')
  const sideSteerPrompt = rpcCalls.find(
    (c) => c.command === 'prompt' && c.key === sideKey && c.payload?.message === 'Draw module graph'
  )
  assert.equal(sideSteerPrompt?.payload?.streamingBehavior, 'steer', 'submitComposerDraft must preserve queue kind on Side Chat')

  // Live entry_appended `pi-desktop-side-turn-meta` also attaches sideRefs retroactively
  const secondRef = { ...ref, id: 'sref-retro' }
  emit({
    ownerId: sideKey,
    event: {
      type: 'message_start',
      message: { role: 'user', content: 'Second question', timestamp: 2345 }
    }
  })
  emit({
    ownerId: sideKey,
    event: {
      type: 'entry_appended',
      entry: {
        type: 'custom',
        customType: SIDE_CHAT_TURN_META_ENTRY_TYPE,
        data: { userText: 'Second question', references: [secondRef], timestamp: 2345 }
      }
    }
  })
  const users = useAppStore.getState().threads[sideKey]?.items.filter((i): i is UserItem => i.kind === 'user') ?? []
  assert.equal(users[1]?.sideRefs?.[0].id, 'sref-retro')

  // Replay hydration + mergeHydratedItems preserve sideRefs
  const replayed = itemsFromMessages([
    { role: 'user', content: 'Explain this edit', timestamp: 1234, sideRefs: [ref] }
  ])
  assert.equal((replayed[0] as UserItem).sideRefs?.[0].id, ref.id)
  const merged = mergeHydratedItems(replayed, [
    { id: 'live-u', kind: 'user', text: 'Explain this edit', images: [], timestamp: 1234, order: 1 }
  ])
  assert.equal((merged[0] as UserItem).sideRefs?.[0].id, ref.id)
})

test('rekeyThread migrates Main and Side drafts independently, resets Side on Main fork, and isolates notices/sidebar/tray/drafts', async () => {
  resetTestState()
  const mainDraft = 'draft:main-1'
  const mainFile = '/sessions/main-1.jsonl'
  const mainFork = '/sessions/main-1-fork.jsonl'
  const sideDraft = 'draft:side:side-1'
  const sideFile = '/sessions/_side-chats/side-1.jsonl'

  useAppStore.setState({
    draftId: mainDraft,
    activeSessionFile: undefined,
    sideChatOpen: true,
    sideSessionKey: sideDraft,
    sideByMainKey: { [mainDraft]: sideDraft },
    sideParentByKey: { [sideDraft]: mainDraft },
    sideModelOverrides: { [sideDraft]: { provider: 'anthropic', id: 'claude-haiku-4-5', spec: 'anthropic/claude-haiku-4-5' } },
    sideThinkingOverrides: { [sideDraft]: 'medium' },
    threads: {
      [mainDraft]: {
        items: [],
        run: { phase: 'idle', turns: 0, settled: true },
        isStreaming: false,
        transport: 'connected',
        uiRequests: [],
        clientKey: 'cm',
        uiStatuses: [],
        uiWidgets: [],
        queue: { steering: [], followUp: [] },
        status: { phase: 'ready', cwd: '/repo/demo' },
        forkTargets: [],
        agentMode: 'default',
        models: [],
        thinkingLevels: [],
        commands: APP_COMMANDS,
        version: 1
      },
      [sideDraft]: {
        items: [],
        run: { phase: 'idle', turns: 0, settled: true },
        isStreaming: true,
        transport: 'connected',
        uiRequests: [{ id: 'ui-side-1', method: 'confirm', title: 'Allow?', message: 'Test' }],
        uiRequest: { id: 'ui-side-1', method: 'confirm', title: 'Allow?', message: 'Test' },
        clientKey: 'cs',
        uiStatuses: [],
        uiWidgets: [],
        queue: { steering: [], followUp: [] },
        status: { phase: 'ready', cwd: '/repo/demo' },
        forkTargets: [],
        agentMode: 'default',
        models: [],
        thinkingLevels: [],
        commands: APP_COMMANDS,
        version: 1
      }
    }
  })
  useAppStore.getState().attachSideReference(
    { kind: 'turn', turnId: 't-1', turnOrdinal: 1, preview: 'Draft main turn' },
    sideDraft
  )

  // Sidebar & Tray projections exclude Side Chat; pending UI list INCLUDES Side Chat
  const stateBefore = useAppStore.getState()
  assert.equal(liveConversationRows([], stateBefore.threads, '/repo/demo').some((r) => r.file === sideDraft), false)
  assert.equal(conversationRows([], stateBefore.threads, '/repo/demo').some((r) => r.file === sideDraft), false)
  assert.equal(streamingProjectPaths([], stateBefore.threads).length, 0)
  assert.equal(trayConversations([], stateBefore.threads, '/repo/demo').some((r) => r.key === sideDraft), false)
  assert.equal(listPendingUiSessions(stateBefore.threads).some((u) => u.sessionKey === sideDraft), true)

  // lastDraftKeys strips draft:side: on both save and load
  saveComposerDrafts({
    drafts: { [sideDraft]: { text: 'side draft', images: [] } },
    lastDraftKeys: { 'ws-1': sideDraft, 'ws-2': mainDraft }
  })
  const reloadedDrafts = loadComposerDrafts()
  assert.equal(reloadedDrafts.lastDraftKeys['ws-1'], undefined)
  assert.equal(reloadedDrafts.lastDraftKeys['ws-2'], mainDraft)

  // 1. Main draft promotes to mainFile
  rekey({ from: mainDraft, to: mainFile })
  const afterMainRekey = useAppStore.getState()
  assert.equal(afterMainRekey.activeSessionFile, mainFile)
  assert.equal(afterMainRekey.sideByMainKey[mainFile], sideDraft)
  assert.equal(afterMainRekey.sideParentByKey[sideDraft], mainFile)
  assert.equal(afterMainRekey.sideQuotes[sideDraft]?.[0].sourceMainKey, mainFile)

  // 2. Side draft promotes to sideFile without disturbing Main activeSessionFile
  rekey({ from: sideDraft, to: sideFile })
  const afterSideRekey = useAppStore.getState()
  assert.equal(afterSideRekey.activeSessionFile, mainFile, 'Side rekey must NOT overwrite Main activeSessionFile')
  assert.equal(afterSideRekey.sideSessionKey, sideFile)
  assert.equal(afterSideRekey.sideByMainKey[mainFile], sideFile)
  assert.equal(afterSideRekey.sideParentByKey[sideFile], mainFile)
  assert.equal(afterSideRekey.sideModelOverrides[sideFile]?.id, 'claude-haiku-4-5')
  assert.equal(afterSideRekey.sideThinkingOverrides[sideFile], 'medium')
  assert.equal(afterSideRekey.sideQuotes[sideFile]?.length, 1)

  // 3. Side Chat settles while panel is closed -> sets sideNotices ONLY (never sessionNotices, toast, sessions.list, or git.status)
  useAppStore.getState().setSideChatOpen(false)
  sessionsListCalls = 0
  gitStatusCalls = 0
  emit({ ownerId: sideFile, event: { type: 'agent_settled', aborted: false } })
  const afterSideSettle = useAppStore.getState()
  assert.equal(afterSideSettle.sideNotices[sideFile], 'unread')
  assert.equal(afterSideSettle.sessionNotices[sideFile], undefined)
  assert.equal(afterSideSettle.toast, undefined)
  assert.equal(sessionsListCalls, 0)
  assert.equal(gitStatusCalls, 0)

  // Opening Side Chat clears sideNotices for the active Side session
  useAppStore.getState().setSideChatOpen(true)
  assert.equal(useAppStore.getState().sideNotices[sideFile], undefined)

  // 4. Main fork (replace: false) resets sideSessionKey to clean slot for the new branch
  rekey({ from: mainFile, to: mainFork, replace: false })
  const afterFork = useAppStore.getState()
  assert.equal(afterFork.activeSessionFile, mainFork)
  assert.equal(afterFork.sideSessionKey, undefined)
})

test('/side command, shortcuts, presets, prompt extraction, and main sync summary', async () => {
  resetTestState()
  const dispatched: SideChatOpenRequest[] = []
  window.addEventListener(OPEN_SIDE_CHAT_EVENT, (event) => {
    dispatched.push((event as CustomEvent<SideChatOpenRequest>).detail)
  })

  // /side and /side <question> never boot Main runtime
  assert.equal(await useAppStore.getState().send('/side', []), true)
  assert.equal(await useAppStore.getState().send('/side Why did tests fail?', []), true)
  await useAppStore.getState().runAppCommand('side')
  assert.equal(ensureCalls.length, 0)
  assert.equal(rpcCalls.length, 0)
  assert.equal(dispatched.length, 3)
  assert.equal(dispatched[0].mode, 'open')
  assert.equal(dispatched[1].prompt, 'Why did tests fail?')
  assert.equal(dispatched[1].autoSubmit, true)

  // Shortcut & App Command registry
  const shortcut = SHORTCUTS.find((s) => s.id === 'toggle-side-chat')
  assert.deepEqual(shortcut?.keys, ['Ctrl', 'Shift', 'L'])
  assert.equal(shortcut?.group, 'Workspace')
  assert.ok(APP_COMMANDS.some((c) => c.name === 'side' && c.takesArgument === true))
  assert.equal(APP_COMMAND_ZH_NAMES.side, '侧边对话')

  // Prompt extraction & handoff cleanup
  const md = [
    'Here is a suggestion:',
    '```prompt',
    'Fix the race condition in auth.ts',
    '```',
    'And another:',
    '~~~prompt',
    'Add unit test for token refresh',
    '~~~'
  ].join('\n')
  assert.deepEqual(extractActionablePrompts(md), [
    'Fix the race condition in auth.ts',
    'Add unit test for token refresh'
  ])
  assert.equal(cleanReplyForHandoff(md), 'Fix the race condition in auth.ts\n\nAdd unit test for token refresh')
  assert.deepEqual(extractActionablePrompts('Plain text reply'), [])
  assert.equal(cleanReplyForHandoff('  Plain text reply  '), 'Plain text reply')

  // Preset prompts & Main Sync Summary
  assert.match(buildPresetPrompt('breakdown-plan', { stepText: 'Refactor auth', language: 'en' }), /Refactor auth/)
  assert.match(buildPresetPrompt('review-session', { language: 'zh-CN' }), /改动/)
  const summary = buildMainSyncSummary({
    items: [
      { id: 'u1', kind: 'user', text: 'Hi', images: [], timestamp: 1, order: 1 },
      { id: 't1', kind: 'tool', toolCallId: 'tc1', toolName: 'edit', args: { path: 'src/a.ts' }, status: 'running', order: 2 }
    ],
    isStreaming: true,
    run: { phase: 'tool_running', turns: 1, settled: false },
    git: {
      isRepo: true,
      branch: 'main',
      dirty: 2,
      files: [
        { path: 'src/a.ts', status: 'modified', staged: false, unstaged: true, added: 1, removed: 0 },
        { path: 'src/b.ts', status: 'modified', staged: false, unstaged: true, added: 2, removed: 1 }
      ]
    }
  })
  assert.equal(summary.mode, 'streaming')
  assert.equal(summary.turnCount, 1)
  assert.equal(summary.dirtyWorktreeCount, 2)
  assert.equal(summary.activeVerb, 'Editing a file')
})
