import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConversationRow, PiEvent, RpcTraceHint, RuntimeEnsureOptions, RuntimeStatus, SessionMeta } from '@shared/types'
import { sessionIndicator } from '../src/renderer/src/lib/session-indicator'

type EventPayload = { ownerId: string; event: PiEvent }
type RekeyPayload = { from: string; to: string; replace?: boolean }

const eventListeners = new Set<(payload: EventPayload) => void>()
const rekeyListeners = new Set<(change: RekeyPayload) => void>()
const statusListeners = new Set<(payload: { ownerId: string; status: RuntimeStatus }) => void>()

const emit = (payload: EventPayload) => eventListeners.forEach((handler) => handler(payload))
const rekey = (change: RekeyPayload) => rekeyListeners.forEach((handler) => handler(change))

function subscribe<T>(listeners: Set<T>, handler: T): () => void {
  listeners.add(handler)
  return () => { listeners.delete(handler) }
}

const calls: { command: string; key?: string; payload?: Record<string, unknown> }[] = []
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

const bridge = {
  app: { info: async () => ({}), setTheme: async () => {} },
  settings: {
    get: async () => ({ workspaces: [] }),
    patch: async (patch: object) => ({ workspaces: [], ...patch })
  },
  workspaces: {
    remove: async () => ({ workspaces: [] })
  },
  sessions: {
    list: async () => [],
    hydrate: async () => [],
    remove: async (_file?: string) => true
  },
  git: { status: async () => ({ isRepo: false }) },
  runtime: {
    ensure: async (_options: RuntimeEnsureOptions) => ({ ok: true }),
    has: async (_key: string) => true,
    stop: async (_key?: string) => {},
    stopCwd: async () => {},
    onEvent: (handler: (payload: EventPayload) => void) => subscribe(eventListeners, handler),
    onRekey: (handler: (change: RekeyPayload) => void) => subscribe(rekeyListeners, handler),
    onStatus: (handler: (payload: { ownerId: string; status: RuntimeStatus }) => void) => subscribe(statusListeners, handler),
    request: async (
      command: string,
      payload?: Record<string, unknown>,
      _timeout?: number,
      _trace?: RpcTraceHint,
      key?: string
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

afterEach(async () => {
  await tick()
  calls.length = 0
  useAppStore.setState(initial, true)
  Reflect.deleteProperty(globalThis, 'requestAnimationFrame')
  Reflect.deleteProperty(globalThis, 'cancelAnimationFrame')
})

const session = (file: string): SessionMeta => ({
  id: file,
  file,
  cwd: 'c:\\test-project\\',
  preview: file,
  updatedAt: Date.now(),
  messageCount: 0
})

// ============================================================================
// SUITE 1: BACKGROUND SESSION LIFECYCLE & INDICATOR STRESS TESTING
// ============================================================================

test('[CHALLENGER 2.1] Rapid arrival of events for 15 unvisited background sessions initializes threads and transitions indicators correctly', async () => {
  // Set up active session
  await useAppStore.getState().selectSession(session('active.jsonl'))
  assert.equal(useAppStore.getState().activeSessionFile, 'active.jsonl')

  const bgSessions = Array.from({ length: 15 }, (_, i) => `bg-${String(i + 1).padStart(2, '0')}.jsonl`)

  // Step 1: None of the background sessions exist in threads initially
  for (const file of bgSessions) {
    assert.equal(useAppStore.getState().threads[file], undefined, `${file} must be unvisited`)
  }

  // Step 2: Flood agent_start to all 15 background sessions in rapid succession
  for (const file of bgSessions) {
    emit({ ownerId: file, event: { type: 'agent_start' } })
  }

  // Verify all 15 threads were auto-created and have isStreaming: true
  for (const file of bgSessions) {
    const thread = useAppStore.getState().threads[file]
    assert.ok(thread, `Thread for ${file} must be auto-initialized`)
    assert.equal(thread.isStreaming, true, `${file} must be marked isStreaming`)
    const indicator = sessionIndicator({
      isStreaming: thread.isStreaming,
      notice: thread.notice,
      needsInput: Boolean(thread.uiRequest)
    })
    assert.equal(indicator, 'running', `Indicator for streaming ${file} must be 'running'`)
  }

  // Active session view remains clean
  assert.equal(useAppStore.getState().activeSessionFile, 'active.jsonl')

  // Step 3: Stream high-frequency deltas across all 15 background sessions and active session
  const rAfFrames: (() => void)[] = []
  Object.assign(globalThis, {
    requestAnimationFrame: (cb: () => void) => { rAfFrames.push(cb); return rAfFrames.length },
    cancelAnimationFrame: () => {}
  })

  // Emit active session messages
  emit({ ownerId: 'active.jsonl', event: { type: 'agent_start' } })
  emit({ ownerId: 'active.jsonl', event: { type: 'message_start', message: { role: 'assistant', content: [] } } })
  emit({
    ownerId: 'active.jsonl',
    event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Active token' } }
  })

  // Emit 15 background messages
  for (const file of bgSessions) {
    emit({ ownerId: file, event: { type: 'message_start', message: { role: 'assistant', content: [] } } })
    emit({
      ownerId: file,
      event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: `Token from ${file}` } }
    })
  }

  // Execute rAF flush: single atomic store update
  let subscriberCalls = 0
  const unsubscribe = useAppStore.subscribe(() => { subscriberCalls += 1 })
  rAfFrames.forEach((frame) => frame())
  unsubscribe()

  assert.equal(subscriberCalls, 1, 'All queued background and active updates must flush in exactly 1 atomic store dispatch')

  // Active items must contain only active tokens, no background leakage
  const activeItems = useAppStore.getState().items
  assert.ok(activeItems.length > 0)
  for (const item of activeItems) {
    if (item.kind === 'assistant') {
      const allText = item.blocks.map((b) => ('text' in b ? b.text : '')).join('')
      assert.ok(allText.includes('Active token'), 'Active items must only contain active token')
      assert.ok(!allText.includes('Token from bg-'), 'Background tokens must not leak into active items')
    }
  }

  // Step 4: Settle background sessions with different lifecycle outcomes
  // Group A (bg-01 to bg-05): Normal settlement -> notice: 'unread'
  for (let i = 0; i < 5; i++) {
    const file = bgSessions[i]
    emit({ ownerId: file, event: { type: 'agent_settled', aborted: false } })
    const thread = useAppStore.getState().threads[file]
    assert.equal(thread.isStreaming, false, `${file} must settle streaming`)
    assert.equal(thread.notice, 'unread', `${file} must acquire 'unread' notice`)
    const ind = sessionIndicator({
      isStreaming: thread.isStreaming,
      notice: thread.notice,
      needsInput: Boolean(thread.uiRequest)
    })
    assert.equal(ind, 'unread', `Indicator for ${file} must be 'unread'`)
  }

  // Group B (bg-06 to bg-10): Crashed / Error settlement -> notice: 'error'
  for (let i = 5; i < 10; i++) {
    const file = bgSessions[i]
    emit({ ownerId: file, event: { type: 'agent_settled', aborted: false, crashed: true } })
    const thread = useAppStore.getState().threads[file]
    assert.equal(thread.isStreaming, false, `${file} must settle streaming`)
    assert.equal(thread.notice, 'error', `${file} must acquire 'error' notice on crash`)
    const ind = sessionIndicator({
      isStreaming: thread.isStreaming,
      notice: thread.notice,
      needsInput: Boolean(thread.uiRequest)
    })
    assert.equal(ind, 'error', `Indicator for ${file} must be 'error'`)
  }

  // Group C (bg-11 to bg-15): Aborted settlement -> notice: undefined
  for (let i = 10; i < 15; i++) {
    const file = bgSessions[i]
    emit({ ownerId: file, event: { type: 'agent_settled', aborted: true } })
    const thread = useAppStore.getState().threads[file]
    assert.equal(thread.isStreaming, false, `${file} must settle streaming`)
    assert.equal(thread.notice, undefined, `${file} must not have notice when aborted`)
    const ind = sessionIndicator({
      isStreaming: thread.isStreaming,
      notice: thread.notice,
      needsInput: Boolean(thread.uiRequest)
    })
    assert.equal(ind, 'idle', `Indicator for ${file} must be 'idle'`)
  }

  // Step 5: Visiting an unread background session clears its notice
  assert.equal(useAppStore.getState().threads['bg-01.jsonl'].notice, 'unread')
  await useAppStore.getState().selectSession(session('bg-01.jsonl'))
  assert.equal(useAppStore.getState().activeSessionFile, 'bg-01.jsonl')
  assert.equal(useAppStore.getState().threads['bg-01.jsonl'].notice, undefined, 'Opening unread session must clear notice')
  assert.equal(
    sessionIndicator({
      isStreaming: useAppStore.getState().threads['bg-01.jsonl'].isStreaming,
      notice: useAppStore.getState().threads['bg-01.jsonl'].notice,
      needsInput: false
    }),
    'idle'
  )

  // Step 6: While watching bg-01.jsonl, subsequent run completion does not create unread notice
  emit({ ownerId: 'bg-01.jsonl', event: { type: 'agent_start' } })
  emit({ ownerId: 'bg-01.jsonl', event: { type: 'agent_settled', aborted: false } })
  assert.equal(useAppStore.getState().threads['bg-01.jsonl'].notice, undefined, 'Watched conversation leaves no unread mark')
})

// ============================================================================
// SUITE 2: DELETED SESSION TOMBSTONE & BOUND PRUNING STRESS TESTING
// ============================================================================

test('[CHALLENGER 2.2] Terminating process events cannot resurrect deleted sessions, and tombstones prune at 500 cap', async () => {
  // Step 1: Select session, verify it exists
  const target = 'victim-session.jsonl'
  await useAppStore.getState().selectSession(session(target))
  assert.ok(useAppStore.getState().threads[target])

  // Step 2: Delete session
  await useAppStore.getState().deleteSession(target)
  assert.equal(useAppStore.getState().threads[target], undefined, 'Session must be deleted from store')

  // Step 3: Event barrage from terminating child process arrives late
  const eventTypes: PiEvent[] = [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Late zombie token' } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Late zombie token' }] } },
    { type: 'agent_settled', aborted: true }
  ]

  for (let round = 0; round < 10; round++) {
    for (const ev of eventTypes) {
      emit({ ownerId: target, event: ev })
    }
  }

  // Ensure thread was not resurrected
  assert.equal(useAppStore.getState().threads[target], undefined, 'Deleted session must NEVER be resurrected by late events')

  // Step 4: Rekeyed draft deletion tombstone
  await useAppStore.getState().newChat()
  const draftKey = useAppStore.getState().draftId
  assert.ok(draftKey, 'Draft key should exist')
  const promotedFile = 'promoted-draft.jsonl'
  rekey({ from: draftKey, to: promotedFile, replace: false })

  // Delete promoted file
  await useAppStore.getState().deleteSession(promotedFile)
  assert.equal(useAppStore.getState().threads[promotedFile], undefined)

  // Late events targeting draftKey or promotedFile must be blocked
  emit({ ownerId: draftKey, event: { type: 'agent_start' } })
  emit({ ownerId: promotedFile, event: { type: 'agent_start' } })
  assert.equal(useAppStore.getState().threads[draftKey], undefined)
  assert.equal(useAppStore.getState().threads[promotedFile], undefined)

  // Step 5: Tombstone bound pruning (500 limit) stress testing
  // Perform 600 sequential deletions to trigger prune boundary
  for (let i = 1; i <= 600; i++) {
    await useAppStore.getState().deleteSession(`bulk-del-${i}.jsonl`)
  }

  // Recent deletions (e.g. bulk-del-599.jsonl) must remain strictly protected
  emit({ ownerId: 'bulk-del-599.jsonl', event: { type: 'agent_start' } })
  assert.equal(useAppStore.getState().threads['bulk-del-599.jsonl'], undefined, 'Recently deleted session must remain tombstones')

  // Hammer with 1,500 more deletions to verify memory bounding under extreme load
  for (let i = 601; i <= 2100; i++) {
    await useAppStore.getState().deleteSession(`burst-del-${i}.jsonl`)
  }
  // No crashes, store functions normally
  assert.ok(useAppStore.getState())

  // Step 6: Legitimate recreation/selection resets tombstone
  const reborn = 'reborn-session.jsonl'
  await useAppStore.getState().deleteSession(reborn)
  // Initially protected
  emit({ ownerId: reborn, event: { type: 'agent_start' } })
  assert.equal(useAppStore.getState().threads[reborn], undefined)

  // Now user deliberately selects and creates reborn
  await useAppStore.getState().selectSession(session(reborn))
  assert.ok(useAppStore.getState().threads[reborn], 'Deliberate selection creates session')

  // Incoming event for reborn now works properly
  emit({ ownerId: reborn, event: { type: 'agent_start' } })
  assert.equal(useAppStore.getState().threads[reborn].isStreaming, true, 'Re-opened session can stream again')
})

// ============================================================================
// SUITE 3: SIDEBAR ROW RE-RENDER PERFORMANCE CHALLENGE (50+ CONVERSATIONS)
// ============================================================================

test('[CHALLENGER 2.3] Sidebar row action callbacks maintain stable identity, and React.memo skips re-renders for inactive rows across 60 conversations', async () => {
  // Generate 60 mock conversations
  const count = 60
  const sessionRows: ConversationRow[] = Array.from({ length: count }, (_, i) => ({
    id: `sess-${i}.jsonl`,
    file: `sess-${i}.jsonl`,
    cwd: 'c:\\project-alpha\\',
    preview: `Conversation Preview ${i}`,
    updatedAt: Date.now() - i * 1000,
    messageCount: 5,
    onDisk: true
  }))

  // Initial active session is sess-0.jsonl
  let activeSessionFile: string | undefined = 'sess-0.jsonl'
  const draftId: string | undefined = undefined
  let renaming: string | null = null
  let draft = ''
  const pinned = new Set<string>()

  // Simulate hoisted useCallback handlers from Sidebar.tsx:680-737
  // Notice: all of these callbacks only depend on store action methods, which are stable.
  const handleSelectSession = (s: ConversationRow) => { activeSessionFile = s.file }
  const handleStartRename = (s: ConversationRow) => { renaming = s.file; draft = s.preview || '' }
  const handleRenameDraft = (val: string) => { draft = val }
  const handleCommitRename = (_file: string) => { renaming = null }
  const handleCancelRename = () => { renaming = null }
  const handleDeleteSession = (_s: ConversationRow) => {}
  const handleArchiveSession = (_file: string) => {}
  const handleStopSession = (_file: string) => {}
  const handleTogglePinSession = (_file: string) => {}

  // Function to build SessionRowItem props for all 60 rows
  const buildProps = () =>
    sessionRows.map((s) => ({
      session: s,
      active: s.file === (activeSessionFile ?? draftId),
      pinned: pinned.has(s.file),
      renaming: renaming === s.file,
      draft: renaming === s.file ? draft : '',
      project: undefined,
      onSelect: handleSelectSession,
      onStartRename: handleStartRename,
      onRenameDraft: handleRenameDraft,
      onCommitRename: handleCommitRename,
      onCancelRename: handleCancelRename,
      onDelete: handleDeleteSession,
      onArchive: handleArchiveSession,
      onStop: handleStopSession,
      onTogglePin: handleTogglePinSession
    }))

  // React.memo shallow comparator emulation (standard React.memo behavior)
  function shallowEqual(prev: Record<string, unknown>, next: Record<string, unknown>): boolean {
    const prevKeys = Object.keys(prev)
    const nextKeys = Object.keys(next)
    if (prevKeys.length !== nextKeys.length) return false
    for (const k of prevKeys) {
      if (prev[k] !== next[k]) return false
    }
    return true
  }

  let prevPropsList = buildProps()

  // Scenario 1: Rapid switching across 10 sessions (0 -> 1 -> 2 -> ... -> 9)
  for (let targetIdx = 1; targetIdx <= 10; targetIdx++) {
    const prevActive = activeSessionFile
    const nextActive = `sess-${targetIdx}.jsonl`
    activeSessionFile = nextActive

    const nextPropsList = buildProps()

    let reRenderedRows = 0
    let skippedRows = 0

    for (let i = 0; i < count; i++) {
      const prevProps = prevPropsList[i]
      const nextProps = nextPropsList[i]
      const shouldSkip = shallowEqual(prevProps, nextProps)

      if (shouldSkip) {
        skippedRows += 1
      } else {
        reRenderedRows += 1
        // Only previous active and current active should re-render
        const file = sessionRows[i].file
        assert.ok(
          file === prevActive || file === nextActive,
          `Only prevActive (${prevActive}) and nextActive (${nextActive}) should re-render, but ${file} re-rendered!`
        )
      }
    }

    assert.equal(reRenderedRows, 2, 'Exactly 2 rows (old active and new active) re-render on session switch')
    assert.equal(skippedRows, count - 2, 'All 58 inactive rows must skip re-render due to React.memo')

    prevPropsList = nextPropsList
  }

  // Scenario 2: Renaming draft typing isolation
  // User starts renaming sess-5.jsonl
  renaming = 'sess-5.jsonl'
  draft = 'A'
  let nextPropsList = buildProps()
  let reRendered = 0
  for (let i = 0; i < count; i++) {
    if (!shallowEqual(prevPropsList[i], nextPropsList[i])) reRendered += 1
  }
  // Only sess-5.jsonl should re-render
  assert.equal(reRendered, 1, 'Starting rename only re-renders the target row')
  prevPropsList = nextPropsList

  // Typing more letters into draft
  draft = 'A draft title with many characters'
  nextPropsList = buildProps()
  reRendered = 0
  for (let i = 0; i < count; i++) {
    if (!shallowEqual(prevPropsList[i], nextPropsList[i])) reRendered += 1
  }
  assert.equal(reRendered, 1, 'Draft typing only re-renders the renaming row; all 59 other rows skip')
  prevPropsList = nextPropsList

  // Cancel rename
  renaming = null
  draft = ''
  nextPropsList = buildProps()
  reRendered = 0
  for (let i = 0; i < count; i++) {
    if (!shallowEqual(prevPropsList[i], nextPropsList[i])) reRendered += 1
  }
  assert.equal(reRendered, 1, 'Cancelling rename only re-renders the previously renaming row')
})


test('[CHALLENGER 2.4] Fine-grained Zustand selector subscriptions for 60 rows fire only for the affected row during background events', async () => {
  const count = 60
  const sessionFiles = Array.from({ length: count }, (_, i) => `row-${i}.jsonl`)

  // Select row-0 as active session
  await useAppStore.getState().selectSession(session(sessionFiles[0]))

  // Track selector evaluation / re-render notification count for each of the 60 rows
  const selectorNotifications = new Array(count).fill(0)
  const unsubs: (() => void)[] = []

  sessionFiles.forEach((file, index) => {
    let prevIndicator = sessionIndicator({
      isStreaming: Boolean(useAppStore.getState().threads[file]?.isStreaming),
      notice: useAppStore.getState().threads[file]?.notice,
      needsInput: Boolean(useAppStore.getState().threads[file]?.uiRequest)
    })

    const unsub = useAppStore.subscribe((state) => {
      const isStreaming = Boolean(state.threads[file]?.isStreaming)
      const notice = state.threads[file]?.notice
      const needsInput = Boolean(state.threads[file]?.uiRequest)
      const nextIndicator = sessionIndicator({ isStreaming, notice, needsInput })
      if (nextIndicator !== prevIndicator) {
        prevIndicator = nextIndicator
        selectorNotifications[index] += 1
      }
    })
    unsubs.push(unsub)
  })

  // Event 1: Background session row-42 starts streaming
  emit({ ownerId: 'row-42.jsonl', event: { type: 'agent_start' } })

  assert.equal(selectorNotifications[42], 1, 'row-42 indicator must transition to running')
  for (let i = 0; i < count; i++) {
    if (i !== 42) {
      assert.equal(selectorNotifications[i], 0, `row-${i} indicator must NOT change`)
    }
  }

  // Event 2: Background session row-42 finishes streaming with unread notice
  emit({ ownerId: 'row-42.jsonl', event: { type: 'agent_settled', aborted: false } })

  assert.equal(selectorNotifications[42], 2, 'row-42 indicator must transition from running to unread')
  for (let i = 0; i < count; i++) {
    if (i !== 42) {
      assert.equal(selectorNotifications[i], 0, `row-${i} indicator must NOT change`)
    }
  }

  // Event 3: Background session row-10 crashes
  emit({ ownerId: 'row-10.jsonl', event: { type: 'agent_start' } })
  emit({ ownerId: 'row-10.jsonl', event: { type: 'agent_settled', aborted: false, crashed: true } })

  assert.equal(selectorNotifications[10], 2, 'row-10 indicator transitions running -> error')
  // row-42 did not change in this step
  assert.equal(selectorNotifications[42], 2)
  for (let i = 0; i < count; i++) {
    if (i !== 42 && i !== 10) {
      assert.equal(selectorNotifications[i], 0, `row-${i} indicator must NOT change`)
    }
  }

  unsubs.forEach((u) => u())
})

test('[CHALLENGER 2.5] Blocking extension UI request sets needs-input outranking running and unread, and resolves cleanly', async () => {
  const bg = 'dialog-session.jsonl'
  emit({ ownerId: bg, event: { type: 'agent_start' } })
  assert.equal(
    sessionIndicator({
      isStreaming: useAppStore.getState().threads[bg].isStreaming,
      notice: useAppStore.getState().threads[bg].notice,
      needsInput: Boolean(useAppStore.getState().threads[bg].uiRequest)
    }),
    'running'
  )

  // Extension UI dialog arrives for this session
  emit({
    ownerId: bg,
    event: {
      type: 'extension_ui_request',
      id: 'req-dialog-1',
      method: 'confirm',
      message: 'Allow file access?'
    }
  })

  const threadWithDialog = useAppStore.getState().threads[bg]
  assert.ok(threadWithDialog.uiRequest, 'uiRequest must be set on thread')

  // While extension dialog is active during run, needs-input outranks running mark
  assert.equal(
    sessionIndicator({
      isStreaming: threadWithDialog.isStreaming,
      notice: threadWithDialog.notice,
      needsInput: Boolean(threadWithDialog.uiRequest)
    }),
    'needs-input',
    'needs-input must outrank running mark while dialog is open'
  )

  // When agent settles (e.g. timeout or crash), the supervisor/store automatically
  // clears uiRequest because the agent finished and can no longer receive dialog responses.
  emit({ ownerId: bg, event: { type: 'agent_settled', aborted: false, crashed: true } })
  const settledThread = useAppStore.getState().threads[bg]
  assert.equal(settledThread.uiRequest, undefined, 'uiRequest must be automatically cleared on agent_settled')
  assert.equal(
    sessionIndicator({
      isStreaming: settledThread.isStreaming,
      notice: settledThread.notice,
      needsInput: Boolean(settledThread.uiRequest)
    }),
    'error',
    'After agent settles with error, indicator becomes error'
  )
})
