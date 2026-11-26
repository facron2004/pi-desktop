import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Type } from 'typebox'
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  SIDE_CHAT_DIR_NAME,
  SIDE_CHAT_META_ENTRY_TYPE,
  SIDE_CHAT_STATUS_KEY,
  SIDE_DRAFT_PREFIX,
  isSideSessionKey,
  mintSideDraftKey,
  type ExtensionUiResponse,
  type PiEvent,
  type RpcTraceHint,
  type RuntimeStartOptions,
  type RuntimeStatus
} from '@shared/types'
import { SessionSupervisor, MAX_IDLE_RUNTIMES, type ManagedSessionRuntime } from '../src/main/pi/supervisor'
import { isPreSendRpcError } from '../src/main/pi/rpc-client'
import { buildRpcArgs } from '../src/main/pi/rpc-args'
import { canAutoApprove, permissionExtension } from '../src/main/pi/permissions'
import { sideChatExtension } from '../src/main/pi/side-chat'
import { SideChatBindingService } from '../src/main/side-chats'
import { AutoTitleService } from '../src/main/auto-title'
import { MemoryService } from '../src/main/memory/service'
import { MemoryStore } from '../src/main/memory/store'
import { encodeWorkspaceDir } from '../src/main/sessions'

class FakeRuntime extends EventEmitter implements ManagedSessionRuntime {
  isRunning = false
  currentStatus: RuntimeStatus = { phase: 'stopped' }
  startOptions: RuntimeStartOptions[] = []
  requests: Array<{ command: string; payload?: Record<string, unknown> }> = []
  stops = 0
  sessionFileOnStart?: string
  sessionFileOnState?: string
  promptHandler?: (payload?: Record<string, unknown>) => Promise<unknown> | unknown

  async start(options: RuntimeStartOptions): Promise<{ ok: boolean; error?: string }> {
    this.startOptions.push(options)
    this.isRunning = true
    const sessionFile = this.sessionFileOnStart ?? options.sessionFile
    this.currentStatus = {
      phase: 'ready',
      cwd: options.cwd,
      ...(sessionFile ? { sessionFile } : {})
    }
    this.emit('status', this.currentStatus)
    return { ok: true }
  }

  async request<T = unknown>(
    command: string,
    payload?: Record<string, unknown>,
    _timeoutMs?: number,
    _trace?: RpcTraceHint
  ): Promise<T> {
    this.requests.push({ command, payload })
    if (command === 'get_state') {
      const file = this.sessionFileOnState ?? this.currentStatus.sessionFile
      return { isStreaming: false, isCompacting: false, ...(file ? { sessionFile: file } : {}) } as T
    }
    if (command === 'prompt' && this.promptHandler) {
      return (await this.promptHandler(payload)) as T
    }
    if (command === 'prompt') {
      return { disposition: 'started' } as T
    }
    return {} as T
  }

  respondUi(_id: string, _response: ExtensionUiResponse): boolean {
    return true
  }

  async stop(): Promise<void> {
    this.stops += 1
    this.isRunning = false
    this.currentStatus = { phase: 'stopped' }
  }
}

function makeSupervisor(runtimes: FakeRuntime[]): SessionSupervisor {
  let i = 0
  return new SessionSupervisor(() => {
    const rt = runtimes[i++]
    if (!rt) throw new Error('Ran out of FakeRuntime instances')
    return rt
  })
}

test('isSideSessionKey and mintSideDraftKey classify Side Chat keys accurately', () => {
  const draft = mintSideDraftKey()
  assert.equal(draft.startsWith(SIDE_DRAFT_PREFIX), true)
  assert.equal(draft.startsWith('draft:'), true)
  assert.equal(isSideSessionKey(draft), true)
  assert.equal(isSideSessionKey('C:/sessions/_side-chats/--proj--/a.jsonl'), true)
  assert.equal(isSideSessionKey('/home/u/.pi/agent/sessions/_side-chats/--proj--/a.jsonl'), true)
  assert.equal(isSideSessionKey('draft:regular-main-id'), false)
  assert.equal(isSideSessionKey('C:/sessions/--proj--/main.jsonl'), false)
  assert.equal(isSideSessionKey(null), false)
  assert.equal(isSideSessionKey(undefined), false)
})

test('MAX_IDLE_RUNTIMES stays 4 while Main+Side pair co-touching protects counterparts from evicting each other', async () => {
  assert.equal(MAX_IDLE_RUNTIMES, 4)
  const rMain = new FakeRuntime()
  const rSide = new FakeRuntime()
  const rB = new FakeRuntime()
  const rC = new FakeRuntime()
  const rD = new FakeRuntime()
  const rE = new FakeRuntime()
  const supervisor = makeSupervisor([rMain, rB, rC, rD, rSide, rE])

  await supervisor.ensure({ sessionKey: 'draft:main-1', cwd: 'C:/proj' })
  await supervisor.ensure({ sessionKey: 'draft:other-B', cwd: 'C:/b' })
  await supervisor.ensure({ sessionKey: 'draft:other-C', cwd: 'C:/c' })
  await supervisor.ensure({ sessionKey: 'draft:other-D', cwd: 'C:/d' })

  // Opening Side Chat for main-1 brings idle count to 5; main-1 is oldest overall,
  // but because it is paired with side-1, it MUST be protected and B evicted instead.
  const sideKey = mintSideDraftKey()
  await supervisor.ensure({
    sessionKey: sideKey,
    cwd: 'C:/proj',
    role: 'side',
    parentSessionKey: 'draft:main-1'
  })

  assert.equal(rMain.stops, 0, 'paired Main runtime must not be evicted when its Side runtime starts')
  assert.equal(rSide.stops, 0, 'newly started Side runtime stays alive')
  assert.equal(rB.stops, 1, 'oldest unprotected standalone idle runtime B should be evicted')

  // Active running Main protects its idle Side counterpart even when another session E starts
  await supervisor.request('draft:main-1', 'prompt')
  rMain.emit('event', { type: 'agent_start' })
  // Now touch C and D so sideKey has older lastAccessed than C/D if not co-touched
  await supervisor.ensure({ sessionKey: 'draft:other-C', cwd: 'C:/c' })
  await supervisor.ensure({ sessionKey: 'draft:other-D', cwd: 'C:/d' })
  await supervisor.ensure({ sessionKey: 'draft:other-E', cwd: 'C:/e' })

  assert.equal(rMain.stops, 0)
  assert.equal(rSide.stops, 0, 'idle Side runtime paired with running Main must not be evicted')

  rMain.emit('event', { type: 'agent_settled' })
  await supervisor.stop()
})

test('Main and Side run prompts concurrently in the same cwd while exclusive Git lock blocks both', async () => {
  const rMain = new FakeRuntime()
  const rSide = new FakeRuntime()
  const supervisor = makeSupervisor([rMain, rSide])
  const cwd = 'C:/shared-project'
  const mainKey = 'draft:main-concurrent'
  const sideKey = mintSideDraftKey()

  await supervisor.ensure({ sessionKey: mainKey, cwd })
  await supervisor.ensure({ sessionKey: sideKey, cwd, role: 'side', parentSessionKey: mainKey })

  // Both Main and Side start prompts simultaneously in the exact same cwd without blocking each other
  const [resMain, resSide] = await Promise.all([
    supervisor.request(mainKey, 'prompt', { message: 'edit files' }),
    supervisor.request(sideKey, 'prompt', { message: 'explain live' })
  ])
  assert.deepEqual(resMain, { disposition: 'started' })
  assert.deepEqual(resSide, { disposition: 'started' })
  rMain.emit('event', { type: 'agent_start' })
  rSide.emit('event', { type: 'agent_start' })

  // Exclusive Git lock must reject while Main/Side hold shared claims
  await assert.rejects(
    () => supervisor.withCwdLock(cwd, async () => 'git-commit'),
    /working in this folder/i
  )

  // Settle Main only -> Side still running -> Git lock still rejects
  rMain.emit('event', { type: 'agent_settled' })
  await new Promise((r) => setImmediate(r))
  await assert.rejects(
    () => supervisor.withCwdLock(cwd, async () => 'git-commit'),
    /working in this folder/i
  )

  // Settle Side -> Git lock now succeeds and queues new prompts until released
  rSide.emit('event', { type: 'agent_settled' })
  await new Promise((r) => setImmediate(r))

  let releaseGit!: () => void
  const gitLock = supervisor.withCwdLock(
    cwd,
    () => new Promise<string>((resolve) => {
      releaseGit = () => resolve('git-done')
    })
  )

  const queuedSidePrompt = supervisor.request(sideKey, 'prompt', { message: 'after git' })
  await new Promise((r) => setImmediate(r))
  // Prompt is queued, not dispatched to FakeRuntime yet
  assert.equal(rSide.requests.filter((r) => r.command === 'prompt').length, 1)

  releaseGit()
  assert.equal(await gitLock, 'git-done')
  await queuedSidePrompt
  assert.equal(rSide.requests.filter((r) => r.command === 'prompt').length, 2)

  rSide.emit('event', { type: 'agent_settled' })
  await supervisor.stop()
})

test('a side conversation is a working conversation: no tool or command clamp', async () => {
  // A side chat is a second working conversation, not a read-only viewer. The
  // clamp that used to make it weaker is gone at every layer, and this test is
  // what keeps it gone: a mutating command reaches Pi, the runtime is started
  // with no tool policy, and the extension installs none either.
  const rSide = new FakeRuntime()
  const supervisor = makeSupervisor([rSide])
  const sideKey = mintSideDraftKey()
  await supervisor.ensure({ sessionKey: sideKey, cwd: 'C:/proj', role: 'side', parentSessionKey: 'draft:main' })

  await supervisor.request(sideKey, 'bash', { command: 'echo hi' })
  assert.equal(
    rSide.requests.some((request) => request.command === 'bash'),
    true,
    'a side chat must be able to run a shell command'
  )
  await supervisor.stop()

  // The side runtime is launched with the full extension loadout alongside the
  // side-chat digest extension, with no tool or MCP restrictions.
  const args = buildRpcArgs(
    { cwd: 'C:/proj', role: 'side', parentSessionKey: 'draft:main' },
    false,
    undefined,
    'perm.mjs',
    'task-modes.mjs',
    'provider.mjs',
    'subagent.mjs',
    'computer.mjs',
    'ctx.mjs',
    'timing.mjs',
    'mermaid.mjs',
    'image.mjs',
    'swarm.mjs',
    { sideChatFile: 'side-chat.mjs' }
  )
  assert.equal(args.includes('--no-mcp'), false, 'MCP servers must be available to a side chat')
  assert.equal(args.includes('--tools'), false, 'a side chat must not be given a read-only allow-list')
  assert.equal(args.includes('--exclude-tools'), false, 'a side chat must not be given an exclusion list')
  for (const ext of ['task-modes.mjs', 'subagent.mjs', 'computer.mjs', 'image.mjs', 'swarm.mjs', 'side-chat.mjs']) {
    assert.equal(args.includes(ext), true, `side runtime must load ${ext}`)
  }

  // The extension adds the digest and the inspect tools; it must not touch the
  // active tool set, block a tool call, or answer shell commands itself.
  const sideExtPath = path.resolve('pi-desktop-side-chat-test.mjs')
  const source = sideChatExtension({
    bridgeUrl: 'http://127.0.0.1:9999',
    bridgeToken: 'tok',
    extensionPath: sideExtPath,
    parentSessionKey: 'draft:main'
  })
    .replace("import { Type } from 'typebox';", '')
    .replace('export default function', 'return function')
  const loadSideExt = new Function('Type', source)(Type) as (api: unknown) => void
  const handlers = new Map<string, (...a: unknown[]) => unknown>()
  const registeredTools: Array<{ name: string; sourceInfo?: { source?: string; path?: string } }> = [
    { name: 'read', sourceInfo: { source: 'builtin' } },
    { name: 'write', sourceInfo: { source: 'builtin' } },
    { name: 'edit', sourceInfo: { source: 'builtin' } },
    { name: 'bash', sourceInfo: { source: 'builtin' } },
    { name: 'mcp__evil__exec', sourceInfo: { source: 'mcp' } }
  ]
  let activeTools: string[] = []
  const appendedEntries: Array<{ type: string; data: unknown }> = []
  const statuses = new Map<string, string>()

  loadSideExt({
    registerTool: (tool: { name: string }) => {
      registeredTools.push({ name: tool.name, sourceInfo: { source: 'local', path: sideExtPath } })
    },
    getAllTools: () => registeredTools,
    setActiveTools: (list: string[]) => { activeTools = list },
    appendEntry: (type: string, data: unknown) => { appendedEntries.push({ type, data }) },
    on: (name: string, fn: (...a: unknown[]) => unknown) => { handlers.set(name, fn) }
  })

  await handlers.get('session_start')!({}, {
    sessionManager: { getBranch: () => [] },
    ui: { setStatus: (k: string, v: string) => statuses.set(k, v) }
  })

  assert.equal(statuses.get(SIDE_CHAT_STATUS_KEY), 'ready')
  assert.deepEqual(activeTools, [], 'the extension must leave the tool loadout alone')
  assert.equal(appendedEntries.length, 1)
  assert.equal(appendedEntries[0]?.type, 'pi-desktop-side-chat')
  assert.equal(
    handlers.get('tool_call')!({ toolName: 'write', input: { path: 'a.txt' } }),
    undefined,
    'a write call must pass through'
  )
  assert.equal(handlers.has('user_bash'), false, 'shell commands are Pi\'s own, not the extension\'s')


  // Layer 4: permissions.ts — canAutoApprove for grep/find/ls AND source-verified inspect tools
  const temp = mkdtempSync(path.join(tmpdir(), 'pi-side-perms-'))
  const cwd = path.join(temp, 'workspace')
  const outside = path.join(temp, 'outside')
  mkdirSync(cwd)
  mkdirSync(outside)
  writeFileSync(path.join(cwd, 'index.ts'), 'export const x = 1\n')
  writeFileSync(path.join(outside, 'secret.txt'), 'secret\n')
  linkSync(path.join(outside, 'secret.txt'), path.join(cwd, 'hardlink.txt'))
  symlinkSync(outside, path.join(cwd, 'sym-out'), 'junction')
  try {
    // Omitted path defaults to '.' inside workspace
    assert.equal(canAutoApprove({ toolName: 'grep', toolSource: 'builtin', input: { pattern: 'x' } }, cwd), true)
    assert.equal(canAutoApprove({ toolName: 'find', toolSource: 'builtin', input: { pattern: '*.ts' } }, cwd), true)
    assert.equal(canAutoApprove({ toolName: 'ls', toolSource: 'builtin', input: {} }, cwd), true)
    // Sensitive, outside, hardlinked, symlinked, and traversal paths remain rejected
    assert.equal(canAutoApprove({ toolName: 'grep', toolSource: 'builtin', input: { path: '.env', pattern: 'KEY' } }, cwd), false)
    assert.equal(canAutoApprove({ toolName: 'grep', toolSource: 'builtin', input: { path: '../outside', pattern: 'secret' } }, cwd), false)
    assert.equal(canAutoApprove({ toolName: 'ls', toolSource: 'builtin', input: { path: 'sym-out' } }, cwd), false)
    assert.equal(canAutoApprove({ toolName: 'grep', toolSource: 'builtin', input: { path: 'hardlink.txt', pattern: 'secret' } }, cwd), false)
    assert.equal(canAutoApprove({ toolName: 'find', toolSource: 'builtin', input: { pattern: '../outside/*' } }, cwd), false)
    assert.equal(canAutoApprove({ toolName: 'grep', toolSource: 'builtin', input: { glob: '../outside/*.txt', pattern: 'secret' } }, cwd), false)
    assert.equal(canAutoApprove({ toolName: 'grep', toolSource: 'extension', input: { pattern: 'x' } }, cwd), false)

    // permissionExtension source-path verification for desktop tools + inspect_main_*
    const modeExtPath = path.resolve('pi-desktop-task-modes-test.mjs')
    const imageExtPath = path.resolve('pi-desktop-image-test.mjs')
    const permSrc = permissionExtension('side-perm-title', true, modeExtPath, undefined, undefined, imageExtPath, sideExtPath)
    const { default: loadPerm } = await import(`data:text/javascript,${encodeURIComponent(permSrc)}`)
    let permTools: Array<{ name: string; sourceInfo?: { source?: string; path?: string } }> = []
    let onToolCall!: (event: { toolName: string; input: Record<string, unknown> }, ctx: unknown) => Promise<unknown>
    let confirmCalls = 0
    loadPerm({
      on: (name: string, fn: typeof onToolCall) => { if (name === 'tool_call') onToolCall = fn },
      getAllTools: () => permTools
    })
    const permCtx = {
      cwd,
      hasUI: true,
      signal: undefined,
      ui: { confirm: async () => { confirmCalls += 1; return false } }
    }
    permTools = [
      { name: 'desktop_goal_finish', sourceInfo: { source: 'local', path: modeExtPath } },
      { name: 'generate_image', sourceInfo: { source: 'local', path: imageExtPath } },
      { name: 'inspect_main_conversation', sourceInfo: { source: 'local', path: sideExtPath } },
      { name: 'inspect_main_changes', sourceInfo: { source: 'local', path: sideExtPath } }
    ]
    assert.equal(await onToolCall({ toolName: 'desktop_goal_finish', input: {} }, permCtx), undefined)
    assert.equal(await onToolCall({ toolName: 'generate_image', input: { prompt: 'diagram' } }, permCtx), undefined)
    assert.equal(await onToolCall({ toolName: 'inspect_main_conversation', input: {} }, permCtx), undefined)
    assert.equal(await onToolCall({ toolName: 'inspect_main_changes', input: {} }, permCtx), undefined)
    assert.equal(confirmCalls, 0)

    // Squatted foreign tool with identical name MUST prompt confirmation
    permTools = [{ name: 'inspect_main_conversation', sourceInfo: { source: 'local', path: path.resolve('evil-ext.mjs') } }]
    assert.equal(((await onToolCall({ toolName: 'inspect_main_conversation', input: {} }, permCtx)) as { block?: boolean })?.block, true)
    assert.equal(confirmCalls, 1)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('SideChatBindingService handles draft rekey matrix, startup replace, fork/clone clean slot, and corrupt quarantine', async () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'pi-side-bindings-'))
  const userData = path.join(temp, 'userData')
  const sessionRoot = path.join(temp, 'sessions')
  const sideDir = path.join(sessionRoot, SIDE_CHAT_DIR_NAME, '--proj--')
  const mainDir = path.join(sessionRoot, '--proj--')
  mkdirSync(userData, { recursive: true })
  mkdirSync(sideDir, { recursive: true })
  mkdirSync(mainDir, { recursive: true })

  const mainFile = path.join(mainDir, 'main-1.jsonl')
  const mainReplacedFile = path.join(mainDir, 'main-1-replaced.jsonl')
  const mainForkedFile = path.join(mainDir, 'main-1-forked.jsonl')
  const sideFile = path.join(sideDir, 'side-1.jsonl')
  writeFileSync(mainFile, '{"type":"session","version":3,"id":"m1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"C:/proj"}\n')
  writeFileSync(mainReplacedFile, '{"type":"session","version":3,"id":"m1r","timestamp":"2026-01-01T00:00:00.000Z","cwd":"C:/proj"}\n')
  writeFileSync(mainForkedFile, '{"type":"session","version":3,"id":"m1f","timestamp":"2026-01-01T00:00:00.000Z","cwd":"C:/proj"}\n')
  writeFileSync(sideFile, '{"type":"session","version":3,"id":"s1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"C:/proj"}\n')

  try {
    // 1. Corrupt file quarantine on startup
    writeFileSync(path.join(userData, 'side-chats.json'), '{not-valid-json')
    const supervisor = makeSupervisor([])
    const bindings = new SideChatBindingService({
      userData,
      supervisor,
      getSessionRoots: () => [sessionRoot]
    })
    const corruptFiles = readdirSync(userData).filter((f) => f.startsWith('side-chats.corrupt-'))
    assert.equal(corruptFiles.length, 1, 'corrupt side-chats.json must be quarantined')
    assert.deepEqual(bindings.getPersistedBindings(), {})

    // 2. Draft Main + Draft Side stays purely in memory (zero disk write)
    const r1 = await bindings.resolve('draft:main-A', 'C:/proj', [sessionRoot])
    assert.equal(r1.hasPersistedHistory, false)
    assert.equal(r1.activeSideKey.startsWith(SIDE_DRAFT_PREFIX), true)
    assert.equal(existsSync(path.join(userData, 'side-chats.json')), false)

    // Repeated resolve returns the same in-memory draft key
    const r2 = await bindings.resolve('draft:main-A', 'C:/proj', [sessionRoot])
    assert.equal(r2.activeSideKey, r1.activeSideKey)

    // 3. Side flushes FIRST (`draft:side:<s> -> side-1.jsonl`), Main flushes SECOND (`draft:main-A -> main-1.jsonl`)
    supervisor.emit('rekey', { from: r1.activeSideKey, to: sideFile })
    assert.equal(existsSync(path.join(userData, 'side-chats.json')), false, 'still in-memory while parent is draft')

    supervisor.emit('rekey', { from: 'draft:main-A', to: mainFile })
    assert.equal(existsSync(path.join(userData, 'side-chats.json')), true, 'promoted to disk once parent flushes')
    const resolvedAfterPromote = await bindings.resolve(mainFile, 'C:/proj', [sessionRoot])
    assert.equal(resolvedAfterPromote.hasPersistedHistory, true)
    assert.equal(path.resolve(resolvedAfterPromote.activeSideKey), path.resolve(sideFile))

    // 4. Startup replace (`replace: true`) migrates binding to replacement file
    supervisor.emit('rekey', { from: mainFile, to: mainReplacedFile, replace: true })
    const afterReplace = await bindings.resolve(mainReplacedFile, 'C:/proj', [sessionRoot])
    assert.equal(afterReplace.hasPersistedHistory, true)
    assert.equal(path.resolve(afterReplace.activeSideKey), path.resolve(sideFile))

    // 5. Fork / clone (`replace` omitted) keeps original binding on old parent & gives new parent a clean Side slot
    supervisor.emit('rekey', { from: mainReplacedFile, to: mainForkedFile })
    const oldStillBound = await bindings.resolve(mainReplacedFile, 'C:/proj', [sessionRoot])
    assert.equal(oldStillBound.hasPersistedHistory, true)
    assert.equal(path.resolve(oldStillBound.activeSideKey), path.resolve(sideFile))

    const forkedClean = await bindings.resolve(mainForkedFile, 'C:/proj', [sessionRoot])
    assert.equal(forkedClean.hasPersistedHistory, false)
    assert.equal(forkedClean.activeSideKey.startsWith(SIDE_DRAFT_PREFIX), true)
    assert.notEqual(forkedClean.activeSideKey, sideFile)

    // 6. Verify persisted JSON format & reload in a fresh service instance
    const reloaded = new SideChatBindingService({ userData, getSessionRoots: () => [sessionRoot] })
    const fromDisk = await reloaded.resolve(mainReplacedFile, 'C:/proj', [sessionRoot])
    assert.equal(fromDisk.hasPersistedHistory, true)
    assert.equal(path.resolve(fromDisk.activeSideKey), path.resolve(sideFile))
    assert.equal(JSON.parse(readFileSync(path.join(userData, 'side-chats.json'), 'utf8')).version, 1)

    bindings.dispose()
    reloaded.dispose()
    await supervisor.stop()
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

for (const recovery of ['missing active file', 'existing active file', 'history scan'] as const) {
  test(`side chat resolution keeps a binding written by a peer during a check for ${recovery}`, async (t) => {
    const temp = mkdtempSync(path.join(tmpdir(), 'pi-side-resolve-peer-'))
    const sessionRoot = path.join(temp, 'sessions')
    const cwd = path.join(temp, 'project')
    const sideDir = path.join(sessionRoot, SIDE_CHAT_DIR_NAME, encodeWorkspaceDir(cwd))
    mkdirSync(sideDir, { recursive: true })
    const mainFile = path.join(sessionRoot, 'main.jsonl')
    const previous = path.join(sideDir, 'previous.jsonl')
    const current = path.join(sideDir, 'current.jsonl')
    writeFileSync(mainFile, '{"type":"session","id":"main"}\n')
    const options = { userData: path.join(temp, 'userData'), getSessionRoots: () => [sessionRoot] }
    const local = new SideChatBindingService(options)
    const peer = new SideChatBindingService(options)
    t.after(() => rmSync(temp, { recursive: true, force: true }))
    if (recovery !== 'history scan') {
      if (recovery === 'existing active file') writeFileSync(previous, '{"type":"session","id":"old"}\n')
      const key = mintSideDraftKey()
      local.noteSideAssociation(key, mainFile, cwd)
      local.handleRekey({ from: key, to: previous })
    } else {
      writeFileSync(previous, [
        { type: 'session', id: 'old' },
        { type: 'custom', customType: SIDE_CHAT_META_ENTRY_TYPE, data: { parentSessionKey: mainFile } }
      ].map(record => JSON.stringify(record)).join('\n') + '\n')
    }

    const checkingPrevious = Promise.withResolvers<void>()
    const continueCheck = Promise.withResolvers<void>()
    const realpath = fsPromises.realpath
    const mockedRealpath = t.mock.method(fsPromises, 'realpath', async (...args: Parameters<typeof realpath>) => {
      if (args[0] === previous) {
        checkingPrevious.resolve()
        await continueCheck.promise
      }
      return realpath(...args)
    })
    syncBuiltinESMExports()
    try {
      const resolving = local.resolve(mainFile, cwd)
      await checkingPrevious.promise
      try {
        writeFileSync(current, '{"type":"session","id":"current"}\n')
        const key = mintSideDraftKey()
        peer.noteSideAssociation(key, mainFile, cwd)
        peer.handleRekey({ from: key, to: current })
      } finally {
        continueCheck.resolve()
      }
      assert.equal((await resolving).activeSideKey, current)
      assert.equal(Object.values(peer.getPersistedBindings())[0]?.activeSideFile, current)
    } finally {
      mockedRealpath.mock.restore()
      syncBuiltinESMExports()
    }
  })
}

test('clearing a side chat keeps its saved binding until the file is removed', async () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'pi-side-clear-'))
  const sessionRoot = path.join(temp, 'sessions')
  const userData = path.join(temp, 'userData')
  const mainFile = path.join(sessionRoot, 'main.jsonl')
  const sideFile = path.join(sessionRoot, SIDE_CHAT_DIR_NAME, 'side.jsonl')
  mkdirSync(path.dirname(sideFile), { recursive: true })
  writeFileSync(sideFile, '{"type":"session","id":"side"}\n')
  const options = { userData, getSessionRoots: () => [sessionRoot] }
  const bindings = new SideChatBindingService(options)
  const cwd = 'C:/proj'

  try {
    const draft = await bindings.resolve(mainFile, cwd)
    bindings.handleRekey({ from: draft.activeSideKey, to: sideFile })
    const saved = bindings.getPersistedBindings()

    await assert.rejects(bindings.clear(mainFile, cwd, async () => false), /could not clear/i)
    assert.deepEqual(bindings.getPersistedBindings(), saved)
    assert.deepEqual(bindings.parentOfSide(sideFile), { parentSessionKey: mainFile, cwd })
    assert.equal(existsSync(sideFile), true)
    const reloaded = new SideChatBindingService(options)
    assert.equal((await reloaded.resolve(mainFile, cwd)).activeSideKey, sideFile)
    reloaded.dispose()

    const cleared = await bindings.clear(mainFile, cwd, async (file) => {
      assert.equal(file, sideFile)
      rmSync(file)
      return true
    })
    assert.equal(cleared.activeSideKey.startsWith(SIDE_DRAFT_PREFIX), true)
    assert.equal(cleared.hasPersistedHistory, false)
    assert.deepEqual(bindings.getPersistedBindings(), {})
    assert.equal(bindings.parentOfSide(sideFile), undefined)
    assert.equal(existsSync(sideFile), false)
  } finally {
    bindings.dispose()
    rmSync(temp, { recursive: true, force: true })
  }
})

test('clearing a side chat removes the file saved while its runtime stops', async () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'pi-side-clear-rekey-'))
  const supervisor = makeSupervisor([])
  const bindings = new SideChatBindingService({
    userData: path.join(temp, 'userData'),
    supervisor,
    getSessionRoots: () => [temp]
  })
  const mainFile = path.join(temp, 'main.jsonl')
  const sideFile = path.join(temp, SIDE_CHAT_DIR_NAME, 'side.jsonl')
  const cwd = 'C:/proj'

  try {
    const draft = await bindings.resolve(mainFile, cwd)
    supervisor.stop = async (key) => {
      assert.equal(key, draft.activeSideKey)
      mkdirSync(path.dirname(sideFile), { recursive: true })
      writeFileSync(sideFile, '{"type":"session","id":"side"}\n')
      supervisor.emit('rekey', { from: key, to: sideFile })
    }
    const removed: string[] = []
    await bindings.clear(mainFile, cwd, async (file) => {
      removed.push(file)
      rmSync(file)
      return true
    })
    assert.deepEqual(removed, [sideFile])
    assert.deepEqual(bindings.getPersistedBindings(), {})
    assert.equal(existsSync(sideFile), false)
  } finally {
    bindings.dispose()
    rmSync(temp, { recursive: true, force: true })
  }
})

test('MemoryService and AutoTitleService ignore Side Chat runtimes completely', async () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'pi-side-services-'))
  try {
    const rSide = new FakeRuntime()
    const supervisor = makeSupervisor([rSide])
    const sideFile = path.join(temp, SIDE_CHAT_DIR_NAME, '--proj--', 'side.jsonl')
    rSide.sessionFileOnStart = sideFile

    let memoryExtractions = 0
    const memStore = new MemoryStore(path.join(temp, 'memories'))
    const memService = new MemoryService(
      memStore,
      () => ({
        workspaces: [],
        theme: 'dark',
        language: 'en',
        fontScale: 1,
        diffSplit: false,
        drawerWidth: 420,
        trustProject: false,
        memoryGeneration: true
      }),
      {
        settleDelayMs: 5,
        extract: async () => {
          memoryExtractions += 1
          return { status: 'empty' }
        }
      }
    )
    memService.attach(supervisor)

    let titleRuns = 0
    const titleService = new AutoTitleService(
      () => ({
        workspaces: [],
        theme: 'dark',
        language: 'en',
        fontScale: 1,
        diffSplit: false,
        drawerWidth: 420,
        trustProject: false,
        autoTitle: true
      }),
      {
        settleDelayMs: 5,
        run: async () => {
          titleRuns += 1
          return { code: 0, stdout: 'Should Never Run', stderr: '' }
        }
      }
    )
    titleService.attach(supervisor)

    const sideDraft = mintSideDraftKey()
    await supervisor.ensure({ sessionKey: sideDraft, cwd: 'C:/proj', role: 'side', parentSessionKey: 'draft:main' })
    rSide.emit('event', { type: 'agent_start' } as PiEvent)
    rSide.emit('event', { type: 'agent_settled', aborted: false } as PiEvent)

    await new Promise((r) => setTimeout(r, 40))
    assert.equal(memoryExtractions, 0, 'MemoryService must never extract from Side Chat')
    assert.equal(titleRuns, 0, 'AutoTitleService must never auto-title Side Chat')

    memService.dispose()
    titleService.dispose()
    await supervisor.stop()
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

/**
 * A side chat that was typed but never sent has no side .jsonl; only the draft
 * key exists. Recording that key for a persisted parent is what lets the composer
 * bring the text back after a restart, instead of opening a brand-new empty side.
 */
test('a persisted parent keeps its draft side key across a restart, and clear replaces it', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-side-draft-'))
  const parent = path.join(userData, '2026-01-01T00-00-00-000Z_main.jsonl')
  writeFileSync(parent, '{}\n', 'utf8')
  try {
    const first = new SideChatBindingService({ userData, getSessionRoots: () => [userData] })
    const minted = await first.resolve(parent, 'C:/proj', [userData])
    assert.equal(minted.activeSideKey.startsWith(SIDE_DRAFT_PREFIX), true)
    first.dispose()

    // A fresh instance is the next launch: the same draft key comes back.
    const second = new SideChatBindingService({ userData, getSessionRoots: () => [userData] })
    const restored = await second.resolve(parent, 'C:/proj', [userData])
    assert.equal(restored.activeSideKey, minted.activeSideKey, 'the draft key must survive a restart')

    // Clear is the reader asking for a new side chat: a fresh key, recorded too.
    const cleared = await second.clear(parent, 'C:/proj', async () => true, [userData])
    assert.notEqual(cleared.activeSideKey, minted.activeSideKey)
    const third = new SideChatBindingService({ userData, getSessionRoots: () => [userData] })
    const afterClear = await third.resolve(parent, 'C:/proj', [userData])
    assert.equal(afterClear.activeSideKey, cleared.activeSideKey)
    third.dispose()

    // Deleting the parent drops the recorded draft with the rest of its slot.
    third.takeSideFilesForParent(parent)
    const fourth = new SideChatBindingService({ userData, getSessionRoots: () => [userData] })
    const afterDelete = await fourth.resolve(parent, 'C:/proj', [userData])
    assert.notEqual(afterDelete.activeSideKey, cleared.activeSideKey)
    fourth.dispose()
    second.dispose()
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})