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
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  SIDE_CHAT_DIR_NAME,
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
import { SIDE_CHAT_ALLOWED_TOOLS, SIDE_CHAT_EXCLUDED_TOOLS, sideChatExtension } from '../src/main/pi/side-chat'
import { SideChatBindingService } from '../src/main/side-chats'
import { AutoTitleService } from '../src/main/auto-title'
import { MemoryService } from '../src/main/memory/service'
import { MemoryStore } from '../src/main/memory/store'

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
  assert.equal(rSide.startOptions[0]?.rememberDefaults, false, 'Side runtime always forces rememberDefaults: false')

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

test('Layer 1-4 read-only enforcement blocks mutating commands, flags, tools, and squatted extensions', async () => {
  // Layer 1: Supervisor RPC command gate
  const rSide = new FakeRuntime()
  const supervisor = makeSupervisor([rSide])
  const sideKey = mintSideDraftKey()
  await supervisor.ensure({ sessionKey: sideKey, cwd: 'C:/proj', role: 'side', parentSessionKey: 'draft:main' })

  for (const blocked of ['bash', 'fork', 'clone', 'new_session', 'switch_session']) {
    await assert.rejects(
      () => supervisor.request(sideKey, blocked, {}),
      (error: unknown) => isPreSendRpcError(error) && /disabled in read-only Side Chat/i.test(String(error))
    )
  }
  assert.equal(rSide.requests.length, 0, 'blocked commands must never reach Pi stdin')
  assert.equal(supervisor.sessionInfo(sideKey)?.running, false)
  await supervisor.stop()

  // Layer 2: buildRpcArgs read-only flags
  const args = buildRpcArgs(
    { cwd: 'C:/proj', role: 'side', parentSessionKey: 'draft:main' },
    false,
    undefined,
    'perm.mjs',
    undefined,
    'provider.mjs',
    undefined,
    undefined,
    'ctx.mjs',
    'timing.mjs',
    'mermaid.mjs',
    undefined,
    undefined,
    {
      sideChatFile: 'side-chat.mjs',
      noMcp: true,
      tools: SIDE_CHAT_ALLOWED_TOOLS,
      excludeTools: SIDE_CHAT_EXCLUDED_TOOLS
    }
  )
  assert.equal(args.includes('--no-mcp'), true)
  assert.equal(args[args.indexOf('--tools') + 1], 'read,grep,find,ls,inspect_main_conversation,inspect_main_changes')
  const excluded = args[args.indexOf('--exclude-tools') + 1] ?? ''
  for (const forbidden of ['write', 'edit', 'bash', 'powershell', 'codemode', 'tool_search', 'subagent', 'computer', 'generate_image']) {
    assert.equal(excluded.split(',').includes(forbidden), true, `${forbidden} must be in --exclude-tools`)
  }
  assert.equal(args.includes('side-chat.mjs'), true)

  // Layer 3: sideChatExtension active-tool clamp, tool_call block, user_bash block, readiness status
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
    { name: 'grep', sourceInfo: { source: 'builtin' } },
    { name: 'find', sourceInfo: { source: 'builtin' } },
    { name: 'ls', sourceInfo: { source: 'builtin' } },
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

  assert.equal(statuses.get(SIDE_CHAT_STATUS_KEY), 'ready', 'Bug #1 fix: side-chat extension emits ready status')
  assert.deepEqual(
    activeTools.sort(),
    ['find', 'grep', 'inspect_main_changes', 'inspect_main_conversation', 'ls', 'read']
  )
  assert.equal(appendedEntries.length, 1)
  assert.equal(appendedEntries[0]?.type, 'pi-desktop-side-chat')

  // tool_call hard block on mutating tools
  const blockedWrite = handlers.get('tool_call')!({ toolName: 'write', input: { path: 'a.txt' } }) as { block?: boolean; terminate?: boolean }
  assert.equal(blockedWrite?.block, true)
  assert.equal(blockedWrite?.terminate, true)
  const allowedRead = handlers.get('tool_call')!({ toolName: 'read', input: { path: 'a.txt' } })
  assert.equal(allowedRead, undefined)

  // user_bash hard block
  const bashResult = handlers.get('user_bash')!({}) as { result: { exitCode: number; cancelled: boolean } }
  assert.equal(bashResult.result.exitCode, 1)
  assert.equal(bashResult.result.cancelled, true)

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

    // permissionExtension source-path verification for inspect_main_conversation / inspect_main_changes
    const permSrc = permissionExtension('side-perm-title', true, undefined, undefined, undefined, undefined, sideExtPath)
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
      { name: 'inspect_main_conversation', sourceInfo: { source: 'local', path: sideExtPath } },
      { name: 'inspect_main_changes', sourceInfo: { source: 'local', path: sideExtPath } }
    ]
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
