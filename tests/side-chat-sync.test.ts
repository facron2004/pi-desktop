import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Type } from 'typebox'
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  GOAL_STATUS_KEY,
  SIDE_CHAT_DIR_NAME,
  SIDE_CHAT_META_ENTRY_TYPE,
  SIDE_CHAT_STATUS_KEY,
  SIDE_CHAT_TURN_META_ENTRY_TYPE,
  TASK_MODE_STATUS_KEY,
  mintSideDraftKey,
  type ExtensionUiResponse,
  type PiEvent,
  type RuntimeStartOptions,
  type RuntimeStatus,
  type SideChatReference
} from '@shared/types'
import {
  MAX_DIGEST_CHARS,
  MainConversationMirror
} from '../src/main/pi/main-mirror'
import { SideChatBridgeServer } from '../src/main/pi/side-chat-bridge'
import { SIDE_CHAT_STATIC_SECTION, sideChatExtension } from '../src/main/pi/side-chat'
import { SideChatBindingService } from '../src/main/side-chats'
import { SessionSupervisor, type ManagedSessionRuntime } from '../src/main/pi/supervisor'
import {
  encodeWorkspaceDir,
  findSideChatFilesForParent,
  getAggregatedUsage,
  listSessions,
  openSessionFile,
  readSessionConversation,
  searchSessions
} from '../src/main/sessions'
import { removeSessionFile } from '../src/main/ipc'

class FakeRuntime extends EventEmitter implements ManagedSessionRuntime {
  isRunning = false
  currentStatus: RuntimeStatus = { phase: 'stopped' }
  async start(options: RuntimeStartOptions) {
    this.isRunning = true
    this.currentStatus = { phase: 'ready', cwd: options.cwd, sessionFile: options.sessionFile }
    return { ok: true }
  }
  async request<T = unknown>() {
    return {} as T
  }
  respondUi(_id: string, _response: ExtensionUiResponse) {
    return true
  }
  async stop() {
    this.isRunning = false
    this.currentStatus = { phase: 'stopped' }
  }
}

test('MainConversationMirror tracks live mid-stream events, bounds digest <= 3200 chars, and supports all inspect views', async () => {
  const supervisor = new SessionSupervisor(() => new FakeRuntime())
  const mirror = new MainConversationMirror({ supervisor })
  const mainKey = 'draft:live-main-1'

  mirror.applyEvent(mainKey, { type: 'agent_start' })
  mirror.applyEvent(mainKey, {
    type: 'extension_ui_request',
    method: 'setStatus',
    statusKey: TASK_MODE_STATUS_KEY,
    statusText: 'goal'
  })
  mirror.applyEvent(mainKey, {
    type: 'extension_ui_request',
    method: 'setStatus',
    statusKey: GOAL_STATUS_KEY,
    statusText: JSON.stringify({ text: 'Ship read-only Side Chat cleanly', status: 'active' })
  })
  mirror.applyEvent(mainKey, {
    type: 'message_start',
    message: { role: 'user', content: 'Refactor supervisor.ts and inspect tests', timestamp: Date.now() }
  })
  mirror.applyEvent(mainKey, {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Checking ' }
  })
  mirror.applyEvent(mainKey, {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'supervisor.ts now.' }
  })
  mirror.applyEvent(mainKey, {
    type: 'tool_execution_start',
    toolCallId: 'call_todo',
    toolName: 'desktop_todo',
    args: {
      items: [
        { text: 'Inspect CwdGate', status: 'done' },
        { text: 'Update supervisor pairing', status: 'in_progress' }
      ]
    }
  })
  mirror.applyEvent(mainKey, {
    type: 'tool_execution_end',
    toolCallId: 'call_todo',
    toolName: 'desktop_todo',
    result: { content: [{ type: 'text', text: 'Recorded 2 items' }] },
    isError: false,
    durationMs: 12
  })
  mirror.applyEvent(mainKey, {
    type: 'tool_execution_start',
    toolCallId: 'call_edit_1',
    toolName: 'edit',
    args: { path: 'src/main/pi/supervisor.ts' }
  })
  // `partialResult` MUST replace previous partial output, never append!
  mirror.applyEvent(mainKey, {
    type: 'tool_execution_update',
    toolCallId: 'call_edit_1',
    toolName: 'edit',
    partialResult: { content: [{ type: 'text', text: 'first-partial' }] }
  })
  const manyLines = Array.from({ length: 260 }, (_, idx) => `log-line-${idx + 1}`).join('\n')
  mirror.applyEvent(mainKey, {
    type: 'tool_execution_update',
    toolCallId: 'call_edit_1',
    toolName: 'edit',
    partialResult: { content: [{ type: 'text', text: manyLines }] }
  })

  // Verify live mid-stream digest
  const ref: SideChatReference = {
    id: 'ref-1',
    kind: 'tool',
    sourceMainKey: mainKey,
    toolCallId: 'call_edit_1',
    toolName: 'edit',
    summary: 'edit src/main/pi/supervisor.ts',
    status: 'running'
  }
  const { digestXml } = await mirror.buildDigest(mainKey, {
    sideSessionKey: mintSideDraftKey(),
    parentSessionKey: mainKey,
    references: [ref],
    preset: 'explain-live'
  })

  assert.equal(digestXml.length <= MAX_DIGEST_CHARS, true, `digest length ${digestXml.length} must be <= ${MAX_DIGEST_CHARS}`)
  assert.match(digestXml, /status="running"/)
  assert.match(digestXml, /Ship read-only Side Chat cleanly/)
  assert.match(digestXml, /Inspect CwdGate/)
  assert.match(digestXml, /Checking supervisor\.ts now\./)
  assert.match(digestXml, /call_edit_1/)

  // Verify tool output replacement + 200-line paging
  const page1 = await mirror.inspectConversation(mainKey, { view: 'tool', toolCallId: 'call_edit_1', outputOffsetLines: 0 })
  assert.equal(page1.text.includes('first-partial'), false, 'partialResult must replace rather than append')
  assert.equal(page1.text.includes('log-line-1'), true)
  assert.equal(page1.text.includes('log-line-200'), true)
  assert.equal(page1.text.includes('log-line-201'), false)
  assert.equal(page1.details.nextOutputOffsetLines, 200)

  const page2 = await mirror.inspectConversation(mainKey, { view: 'tool', toolCallId: 'call_edit_1', outputOffsetLines: 200 })
  assert.equal(page2.text.includes('log-line-201'), true)
  assert.equal(page2.text.includes('log-line-260'), true)
  assert.equal(page2.details.nextOutputOffsetLines, undefined)

  // Verify terminal tool immutability and sessionChangedFiles tracking
  mirror.applyEvent(mainKey, {
    type: 'tool_execution_end',
    toolCallId: 'call_edit_1',
    toolName: 'edit',
    result: { content: [{ type: 'text', text: 'Edited successfully' }] },
    isError: false,
    durationMs: 42
  })
  // Late update must NOT turn terminal 'ok' back into 'running'
  mirror.applyEvent(mainKey, {
    type: 'tool_execution_update',
    toolCallId: 'call_edit_1',
    toolName: 'edit',
    partialResult: { content: [{ type: 'text', text: 'late-stale-update' }] }
  })
  const terminalInspect = await mirror.inspectConversation(mainKey, { view: 'tool', toolCallId: 'call_edit_1' })
  assert.equal(terminalInspect.details.status, 'ok')
  assert.equal(terminalInspect.text.includes('late-stale-update'), false)

  const planInspect = await mirror.inspectConversation(mainKey, { view: 'plan' })
  assert.match(planInspect.text, /Ship read-only Side Chat cleanly/)
  assert.match(planInspect.text, /src\/main\/pi\/supervisor\.ts/)

  const searchInspect = await mirror.inspectConversation(mainKey, { view: 'search', query: 'supervisor.ts' })
  assert.equal(Number(searchInspect.details.hitCount) > 0, true)

  mirror.dispose()
  await supervisor.stop()
})

test('SideChatBridgeServer enforces bearer auth, tracks live rekey, enforces openWorkspaceFile security, and preserves KV-cache prefix in sideChatExtension', async () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'pi-side-bridge-'))
  const userData = path.join(temp, 'userData')
  const sessionRoot = path.join(temp, 'sessions')
  const workspace = path.join(temp, 'workspace')
  const outside = path.join(temp, 'outside')
  mkdirSync(userData, { recursive: true })
  mkdirSync(path.join(sessionRoot, encodeWorkspaceDir(workspace)), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  mkdirSync(outside, { recursive: true })

  writeFileSync(path.join(workspace, 'app.ts'), 'export const greeting = "hello"\n')
  writeFileSync(path.join(outside, 'secret.txt'), 'top-secret-outside\n')
  linkSync(path.join(outside, 'secret.txt'), path.join(workspace, 'hardlink.txt'))
  symlinkSync(outside, path.join(workspace, 'escape-link'), 'junction')

  const supervisor = new SessionSupervisor(() => new FakeRuntime())
  const bindings = new SideChatBindingService({ userData, supervisor, getSessionRoots: () => [sessionRoot] })
  const mirror = new MainConversationMirror({ supervisor, getSessionRoots: () => [sessionRoot] })
  const bridge = new SideChatBridgeServer({ mirror, bindings, supervisor, getSessionRoots: () => [sessionRoot] })

  try {
    const draftMain = 'draft:main-kv'
    const draftSide = mintSideDraftKey()
    bindings.noteSideAssociation(draftSide, draftMain, workspace)

    const { bridgeUrl, bridgeToken, revoke } = await bridge.registerRuntime(draftSide, draftMain, workspace)
    assert.equal(bridgeUrl.startsWith('http://127.0.0.1:'), true)

    // 1. Unauthorized requests must return 401
    const unauth = await fetch(`${bridgeUrl}/v1/digest`, { method: 'POST', body: '{}' })
    assert.equal(unauth.status, 401)
    const wrongTok = await fetch(`${bridgeUrl}/v1/digest`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
      body: '{}'
    })
    assert.equal(wrongTok.status, 401)

    // 2. Non-negotiable #9: inspect_main_changes rejects traversal, symlink escape, and hard links
    const traversal = await fetch(`${bridgeUrl}/v1/inspect-changes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bridgeToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: '../outside/secret.txt' })
    }).then((r) => r.json() as Promise<{ text: string; details: { rejected?: boolean } }>)
    assert.equal(traversal.details.rejected, true)
    assert.equal(traversal.text.includes('top-secret-outside'), false)

    const symEscape = await fetch(`${bridgeUrl}/v1/inspect-changes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bridgeToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'escape-link/secret.txt' })
    }).then((r) => r.json() as Promise<{ text: string; details: { rejected?: boolean } }>)
    assert.equal(symEscape.details.rejected, true)
    assert.equal(symEscape.text.includes('top-secret-outside'), false)

    const hardLink = await fetch(`${bridgeUrl}/v1/inspect-changes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bridgeToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'hardlink.txt' })
    }).then((r) => r.json() as Promise<{ text: string; details: { rejected?: boolean } }>)
    assert.equal(hardLink.details.rejected, true)
    assert.equal(hardLink.text.includes('top-secret-outside'), false)

    const legitFile = await fetch(`${bridgeUrl}/v1/inspect-changes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bridgeToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'app.ts' })
    }).then((r) => r.json() as Promise<{ text: string }>)
    assert.equal(legitFile.text.includes('export const greeting = "hello"'), true)

    // 3. Verify sideChatExtension KV-cache prefix stability & zero digest bloat across turns + intra-run tool loops
    mirror.applyEvent(draftMain, { type: 'agent_start' })
    mirror.applyEvent(draftMain, {
      type: 'message_start',
      message: { role: 'user', content: 'Initial main prompt', timestamp: Date.now() }
    })
    mirror.applyEvent(draftMain, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Initial answer' }
    })

    const sideExtPath = path.resolve('side-chat-kv-test.mjs')
    const extSource = sideChatExtension({
      bridgeUrl,
      bridgeToken,
      extensionPath: sideExtPath,
      parentSessionKey: draftMain
    })
      .replace("import { Type } from 'typebox';", '')
      .replace('export default function', 'return function')
    const loadSideExt = new Function('Type', extSource)(Type) as (api: unknown) => void
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    const appended: Array<{ type: string; data: unknown }> = []
    loadSideExt({
      registerTool: () => {},
      getAllTools: () => [
        { name: 'read', sourceInfo: { source: 'builtin' } },
        { name: 'inspect_main_conversation', sourceInfo: { source: 'local', path: sideExtPath } }
      ],
      setActiveTools: () => {},
      appendEntry: (type: string, data: unknown) => { appended.push({ type, data }) },
      on: (name: string, fn: (...a: unknown[]) => unknown) => { handlers.set(name, fn) }
    })

    await handlers.get('session_start')!({}, {
      sessionManager: { getBranch: () => [] },
      ui: { setStatus: () => {} }
    })

    // Stage reference chips for Turn 1
    const stagedRef: SideChatReference = {
      id: 'ref-sel-1',
      kind: 'selection',
      sourceMainKey: draftMain,
      source: 'assistant',
      snippet: 'Initial answer'
    }
    bridge.stagePrompt({
      sideSessionKey: draftSide,
      parentSessionKey: draftMain,
      references: [stagedRef],
      preset: 'explain-live'
    })

    // Turn 1: before_agent_start sets static section + appends turn meta (NOT digest!)
    const promptOpts1: { sections: Record<string, string>; selectedTools: string[] } = { sections: {}, selectedTools: [] }
    const beforeRes1 = await handlers.get('before_agent_start')!(
      { prompt: 'What is main doing?', systemPromptOptions: promptOpts1 },
      { signal: undefined }
    )
    assert.equal(beforeRes1, undefined, 'before_agent_start must not return a persistent { message }')
    assert.equal(promptOpts1.sections[SIDE_CHAT_STATUS_KEY], SIDE_CHAT_STATIC_SECTION)

    const turnMetaEntries = appended.filter((e) => e.type === SIDE_CHAT_TURN_META_ENTRY_TYPE)
    assert.equal(turnMetaEntries.length, 1)
    assert.equal(
      appended.some((e) => JSON.stringify(e).includes('<main_conversation_digest')),
      false,
      'zero bytes of digest XML may ever be persisted to .jsonl'
    )

    // Intra-run step 1 & step 2 in `pi.on('context')` must produce byte-identical frozen digest
    const user1 = { role: 'user', content: 'What is main doing?', timestamp: 1000 }
    const ctx1a = handlers.get('context')!({ messages: [user1] }) as { messages: Array<{ role: string; customType?: string; content: string; display?: boolean }> }
    assert.equal(ctx1a.messages.length, 2)
    assert.equal(ctx1a.messages[0]?.customType, 'desktop-side-main-digest')
    assert.equal(ctx1a.messages[0]?.display, false)
    assert.equal(ctx1a.messages[1], user1)

    // Mutate Main mirror mid-run; step 2 of SAME Side run must keep the EXACT frozen digest from before_agent_start
    mirror.applyEvent(draftMain, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' + more mid-run text' }
    })
    const ctx1b = handlers.get('context')!({
      messages: [user1, { role: 'assistant', content: 'Calling read...' }, { role: 'toolResult', content: 'file content' }]
    }) as { messages: Array<{ content: string }> }
    assert.equal(ctx1b.messages[0]?.content, ctx1a.messages[0]?.content, 'intra-run tool loop keeps byte-identical digest prefix')

    // Live Main rekey (`draft:main-kv -> main-kv.jsonl`) while Side runtime stays live
    const persistedMain = path.join(sessionRoot, encodeWorkspaceDir(workspace), 'main-kv.jsonl')
    writeFileSync(persistedMain, `{"type":"session","version":3,"id":"mk","timestamp":"2026-01-01T00:00:00.000Z","cwd":${JSON.stringify(workspace)}}\n`)
    supervisor.emit('rekey', { from: draftMain, to: persistedMain })

    // Turn 2: prefix [Turn 0..k-1] before user_2 stays byte-identical, fresh digest inserted right before user_2
    const promptOpts2: { sections: Record<string, string>; selectedTools: string[] } = { sections: {}, selectedTools: [] }
    await handlers.get('before_agent_start')!(
      { prompt: 'Follow-up question', systemPromptOptions: promptOpts2 },
      { signal: undefined }
    )
    assert.equal(promptOpts2.sections[SIDE_CHAT_STATUS_KEY], promptOpts1.sections[SIDE_CHAT_STATUS_KEY], 'static section is byte-identical across turns')

    const settledTurn1 = [user1, { role: 'assistant', content: 'Main is doing initial work.' }]
    const user2 = { role: 'user', content: 'Follow-up question', timestamp: 2000 }
    const ctx2 = handlers.get('context')!({ messages: [...settledTurn1, user2] }) as {
      messages: Array<{ role: string; customType?: string; content: string }>
    }
    assert.deepEqual(ctx2.messages.slice(0, 2), settledTurn1, 'prior Side turns 0..k-1 are 100% byte-identical for KV-cache hit')
    assert.equal(ctx2.messages[2]?.customType, 'desktop-side-main-digest')
    assert.equal(ctx2.messages[2]?.content.includes('more mid-run text'), true, 'Turn 2 picks up live Main update across rekey')
    assert.equal(ctx2.messages[3], user2)

    // 4. Token revocation immediately rejects further calls
    revoke()
    const afterRevoke = await fetch(`${bridgeUrl}/v1/digest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bridgeToken}` },
      body: '{}'
    })
    assert.equal(afterRevoke.status, 401)
  } finally {
    await bridge.dispose()
    bindings.dispose()
    mirror.dispose()
    await supervisor.stop()
    rmSync(temp, { recursive: true, force: true })
  }
})

test('Session isolation excludes _side-chats from list/search, includes in getAggregatedUsage, hydrates sideRefs with LF-only parsing, and cascades delete', async () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'pi-side-sessions-'))
  const userData = path.join(temp, 'userData')
  const sessionRoot = path.join(temp, 'sessions')
  const cwd = path.join(temp, 'my-repo')
  const mainDir = path.join(sessionRoot, encodeWorkspaceDir(cwd))
  const sideDir = path.join(sessionRoot, SIDE_CHAT_DIR_NAME, encodeWorkspaceDir(cwd))
  mkdirSync(userData, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  mkdirSync(mainDir, { recursive: true })
  mkdirSync(sideDir, { recursive: true })

  const nowIso = new Date().toISOString()
  const mainFile = path.join(mainDir, '2026-11-24_main-1.jsonl')
  const sideFile = path.join(sideDir, '2026-11-24_side-1.jsonl')

  const mainJsonl = [
    JSON.stringify({ type: 'session', version: 3, id: 'main-uuid-1', timestamp: nowIso, cwd }),
    JSON.stringify({
      type: 'message',
      id: 'm1',
      parentId: null,
      timestamp: nowIso,
      message: { role: 'user', content: 'UNIQUE_MAIN_SEARCH_TOKEN with \u2028 line sep', timestamp: Date.now() }
    }),
    JSON.stringify({
      type: 'message',
      id: 'm2',
      parentId: 'm1',
      timestamp: nowIso,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Main reply' }],
        model: 'test/main-model',
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { total: 0.01 } },
        timestamp: Date.now()
      }
    })
  ].join('\n') + '\n'

  const ref: SideChatReference = {
    id: 'ref-turn-1',
    kind: 'turn',
    sourceMainKey: mainFile,
    turnId: 'turn-1',
    turnOrdinal: 1,
    preview: 'Main reply'
  }
  const sideJsonl = [
    JSON.stringify({ type: 'session', version: 3, id: 'side-uuid-1', timestamp: nowIso, cwd }),
    JSON.stringify({
      type: 'custom',
      id: 'sc-meta',
      parentId: null,
      timestamp: nowIso,
      customType: SIDE_CHAT_META_ENTRY_TYPE,
      data: { version: 1, parentSessionKey: mainFile, parentSessionId: 'main-uuid-1', createdAt: Date.now() }
    }),
    JSON.stringify({
      type: 'custom',
      id: 'sc-turn-meta',
      parentId: 'sc-meta',
      timestamp: nowIso,
      customType: SIDE_CHAT_TURN_META_ENTRY_TYPE,
      data: { userText: 'Explain UNIQUE_SIDE_SECRET_TOKEN', references: [ref], preset: 'explain-live', timestamp: Date.now() }
    }),
    JSON.stringify({
      type: 'message',
      id: 's1',
      parentId: 'sc-turn-meta',
      timestamp: nowIso,
      message: { role: 'user', content: 'Explain UNIQUE_SIDE_SECRET_TOKEN', timestamp: Date.now() }
    }),
    JSON.stringify({
      type: 'message',
      id: 's2',
      parentId: 's1',
      timestamp: nowIso,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Side explanation' }],
        model: 'test/side-reviewer',
        usage: { input: 200, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 280, cost: { total: 0.02 } },
        timestamp: Date.now()
      }
    })
  ].join('\n') + '\n'

  writeFileSync(mainFile, mainJsonl, 'utf8')
  writeFileSync(sideFile, sideJsonl, 'utf8')

  const prevEnv = process.env.PI_CODING_AGENT_SESSION_DIR
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionRoot
  try {
    // 1. listSessions (global and targeted) MUST exclude _side-chats
    const globalList = await listSessions(undefined, sessionRoot)
    assert.equal(globalList.some((s) => s.id === 'main-uuid-1'), true)
    assert.equal(globalList.some((s) => s.id === 'side-uuid-1'), false, 'global listSessions must exclude Side Chats')

    const cwdList = await listSessions(cwd, sessionRoot)
    assert.equal(cwdList.some((s) => s.id === 'main-uuid-1'), true)
    assert.equal(cwdList.some((s) => s.id === 'side-uuid-1'), false, 'cwd listSessions must exclude Side Chats')

    // 2. searchSessions MUST exclude _side-chats
    const mainHits = await searchSessions('UNIQUE_MAIN_SEARCH_TOKEN', 10, { sessionRoots: [sessionRoot] })
    assert.equal(mainHits.length, 1)
    const sideHits = await searchSessions('UNIQUE_SIDE_SECRET_TOKEN', 10, { sessionRoots: [sessionRoot] })
    assert.equal(sideHits.length, 0, 'searchSessions must exclude Side Chats')

    // 3. getAggregatedUsage MUST descend 2 levels into _side-chats/<workspaceDir>/*.jsonl (#11 Bug #3)
    const usage = await getAggregatedUsage(sessionRoot)
    assert.equal(usage.allTime.tokens.totalTokens, 150 + 280, 'usage must sum both Main and Side tokens')
    assert.equal(usage.byModel.some((m) => m.model === 'test/side-reviewer' && m.totalTokens === 280), true)

    // 4. Cold hydration attaches `AgentMessage.sideRefs` cleanly and preserves U+2028
    const openedMain = await openSessionFile(mainFile, [sessionRoot])
    assert.ok(openedMain)
    try {
      const mainConv = await readSessionConversation(openedMain.target, openedMain.handle)
      assert.equal(mainConv.messages[0]?.content, 'UNIQUE_MAIN_SEARCH_TOKEN with \u2028 line sep')
    } finally {
      await openedMain.handle.close()
    }

    const openedSide = await openSessionFile(sideFile, [sessionRoot])
    assert.ok(openedSide)
    try {
      const sideConv = await readSessionConversation(openedSide.target, openedSide.handle)
      assert.equal(sideConv.messages.length, 2)
      assert.equal(sideConv.messages[0]?.content, 'Explain UNIQUE_SIDE_SECRET_TOKEN')
      assert.deepEqual(sideConv.messages[0]?.sideRefs, [ref])
    } finally {
      await openedSide.handle.close()
    }

    // 5. Self-healing recovery rebuilds binding from `pi-desktop-side-chat` custom entry when side-chats.json is absent
    const recovered = await findSideChatFilesForParent(mainFile, cwd, [sessionRoot], 'main-uuid-1')
    assert.equal(recovered.length, 1)
    assert.equal(path.resolve(recovered[0]!), path.resolve(sideFile))

    const supervisor = new SessionSupervisor(() => new FakeRuntime())
    const bindings = new SideChatBindingService({ userData, supervisor, getSessionRoots: () => [sessionRoot] })
    const resolved = await bindings.resolve(mainFile, cwd, [sessionRoot], 'main-uuid-1')
    assert.equal(resolved.hasPersistedHistory, true)
    assert.equal(path.resolve(resolved.activeSideKey), path.resolve(sideFile))

    // 6. Cascade permanent deletion removes parent + all bound Side JSONLs via removeSessionFile
    const taken = bindings.takeSideFilesForParent(mainFile)
    assert.equal(taken.sideFiles.length, 1)
    assert.equal(await removeSessionFile(mainFile, supervisor, [sessionRoot]), true)
    for (const f of taken.sideFiles) {
      assert.equal(await removeSessionFile(f, supervisor, [sessionRoot]), true)
    }
    assert.equal(existsSync(mainFile), false)
    assert.equal(existsSync(sideFile), false)

    bindings.dispose()
    await supervisor.stop()
  } finally {
    if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = prevEnv
    rmSync(temp, { recursive: true, force: true })
  }
})
