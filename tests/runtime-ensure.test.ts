import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { registerIpc } from '../src/main/ipc'
import type { IpcContext } from '../src/main/ipc'
import { piVersion } from '../src/main/pi/cli'
import { SessionSupervisor } from '../src/main/pi/supervisor'
import { properLockfile } from '../src/main/proper-lockfile'
import { SettingsStore } from '../src/main/settings'
import type { AppSettings, GitFileDiff, GitPatch, GitStatus, PiCliUpgradeProgress, RuntimeEnsureOptions } from '../src/shared/types'

test('saving Automatic reasoning clears the Pi startup override before returning', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pi-automatic-reasoning-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = directory
  t.after(() => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir
  })
  t.mock.method(app, 'getPath', () => directory)
  const agentFile = path.join(directory, 'settings.json')
  const desktopFile = path.join(directory, 'desktop.json')
  writeFileSync(agentFile, JSON.stringify({ defaultThinkingLevel: 'high', theme: 'dark' }))
  writeFileSync(desktopFile, JSON.stringify({ thinkingLevel: 'high' }))
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  t.mock.method(ipcMain, 'handle', (channel, handler) => handlers.set(channel, handler))
  registerIpc({
    settings: new SettingsStore('desktop.json'),
    supervisor: {},
    getWindow: () => null,
    terminals: {},
    memory: {}
  } as unknown as IpcContext)

  const patch = handlers.get('settings:patch')
  assert.ok(patch)
  await patch({}, { theme: 'light' })
  assert.equal(JSON.parse(readFileSync(agentFile, 'utf8')).defaultThinkingLevel, 'high')
  await patch({}, { thinkingLevel: undefined })
  assert.equal(new SettingsStore('desktop.json').get().thinkingLevel, undefined)
  assert.deepEqual(JSON.parse(readFileSync(agentFile, 'utf8')), { theme: 'dark' })
  await patch({}, { thinkingLevel: 'off' })
  assert.equal(JSON.parse(readFileSync(agentFile, 'utf8')).defaultThinkingLevel, 'off')
})

test('an older settings save cannot restore superseded Pi defaults or return a stale snapshot', { timeout: 10_000 }, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pi-concurrent-defaults-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = directory
  t.after(() => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir
  })
  t.mock.method(app, 'getPath', () => directory)

  const agentFile = path.join(directory, 'settings.json')
  writeFileSync(agentFile, JSON.stringify({ theme: 'dark' }))
  const settings = new SettingsStore('desktop.json')
  const peer = new SettingsStore('desktop.json')
  const lockEntered = Promise.withResolvers<void>()
  const releaseOlder = Promise.withResolvers<void>()
  const lock = properLockfile.lock.bind(properLockfile)
  let delayNextLock = true
  t.mock.method(properLockfile, 'lock', async (file: string, options?: Parameters<typeof lock>[1]) => {
    if (file === agentFile && delayNextLock) {
      delayNextLock = false
      lockEntered.resolve()
      await releaseOlder.promise
    }
    return lock(file, options)
  })

  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  t.mock.method(ipcMain, 'handle', (channel, handler) => handlers.set(channel, handler))
  registerIpc({ settings, supervisor: {}, getWindow: () => null, terminals: {}, memory: {} } as unknown as IpcContext)
  const patch = handlers.get('settings:patch')
  assert.ok(patch)

  const older = patch({}, { model: 'old/model', thinkingLevel: 'low' }) as Promise<AppSettings>
  try {
    await lockEntered.promise
    peer.patch({ model: 'new/chosen-model', thinkingLevel: 'high', theme: 'light' })
    await peer.waitForPiDefaults()
  } finally {
    releaseOlder.resolve()
  }

  const response = await older
  assert.deepEqual({
    agent: JSON.parse(readFileSync(agentFile, 'utf8')),
    response: { model: response.model, thinkingLevel: response.thinkingLevel, theme: response.theme }
  }, {
    agent: { defaultProvider: 'new', defaultModel: 'chosen-model', defaultThinkingLevel: 'high', theme: 'dark' },
    response: { model: 'new/chosen-model', thinkingLevel: 'high', theme: 'light' }
  })
})

test('session export preserves an existing destination until Pi finishes', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pi-export-html-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const target = path.join(directory, 'conversation.html')
  const sessionKey = 'test-session.jsonl'
  writeFileSync(target, 'original export', 'utf8')
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  t.mock.method(ipcMain, 'handle', (channel, handler) => handlers.set(channel, handler))
  let cancelled = true
  t.mock.method(dialog, 'showSaveDialog', async () => ({ canceled: cancelled, filePath: cancelled ? undefined : target }))
  const opened: string[] = []
  t.mock.method(shell, 'openPath', async (file) => {
    opened.push(file)
    return 'No associated HTML viewer'
  })
  let requests = 0
  let exportFails = true
  let afterWrite: (() => void | Promise<void>) | undefined
  registerIpc({
    supervisor: {
      has: (key: string) => key === sessionKey,
      request: async (key: string, command: string, payload: { outputPath: string }) => {
        requests += 1
        assert.equal(key, sessionKey)
        assert.equal(command, 'export_html')
        assert.equal(path.dirname(path.dirname(payload.outputPath)), directory)
        assert.notEqual(payload.outputPath, target)
        writeFileSync(payload.outputPath, exportFails ? 'partial export' : 'complete export', 'utf8')
        if (exportFails) throw new Error('Export interrupted')
        await afterWrite?.()
        return { path: payload.outputPath }
      }
    },
    settings: { get: () => ({ workspaces: [] }) },
    getWindow: () => null,
    terminals: { create: () => ({}) },
    memory: { promptFor: () => '' }
  } as unknown as IpcContext)

  const exportHtml = handlers.get('sessions:exportHtml')
  assert.ok(exportHtml)
  const request = handlers.get('runtime:request')
  assert.ok(request)
  await assert.rejects(async () => request({}, 'export_html', {}, undefined, undefined, sessionKey), /sessions:exportHtml/)
  assert.deepEqual(await exportHtml({}, sessionKey), { cancelled: true })
  assert.equal(requests, 0)
  cancelled = false
  await assert.rejects(async () => exportHtml({}, sessionKey), /Export interrupted/)
  assert.equal(readFileSync(target, 'utf8'), 'original export')
  assert.deepEqual(opened, [])
  assert.deepEqual(readdirSync(directory), [path.basename(target)])

  exportFails = false
  const replacement = 'new content saved by a different writer'
  afterWrite = () => writeFileSync(target, replacement, 'utf8')
  for (const existing of [true, false]) {
    if (!existing) rmSync(target)
    await assert.rejects(async () => exportHtml({}, sessionKey), /export destination changed/i)
    assert.equal(readFileSync(target, 'utf8'), replacement)
    assert.deepEqual(opened, [])
    assert.deepEqual(readdirSync(directory), [path.basename(target)])
  }
  const exportWritten = Promise.withResolvers<void>()
  const finishExport = Promise.withResolvers<void>()
  afterWrite = () => {
    exportWritten.resolve()
    return finishExport.promise
  }
  const exporting = exportHtml({}, sessionKey)
  await exportWritten.promise
  try {
    await assert.rejects(async () => exportHtml({}, sessionKey), /export to this file is already in progress/i)
    assert.equal(readFileSync(target, 'utf8'), replacement)
  } finally {
    finishExport.resolve()
    await exporting
  }
  assert.deepEqual(await exporting, {
    cancelled: false, path: target, openError: 'No associated HTML viewer'
  })
  assert.equal(readFileSync(target, 'utf8'), 'complete export')
  assert.deepEqual(opened, [target])
  assert.deepEqual(readdirSync(directory), [path.basename(target)])
})

test('pasted image uses the original project after switching workspaces', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pi-paste-project-'))
  const source = path.join(directory, 'source')
  const other = path.join(directory, 'other')
  mkdirSync(source)
  mkdirSync(other)
  const otherWorkspace = { id: 'other', path: other }
  let workspaces = [{ id: 'source', path: source }, otherWorkspace]
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const handleDescriptor = Object.getOwnPropertyDescriptor(ipcMain, 'handle')
  Object.defineProperty(ipcMain, 'handle', {
    configurable: true,
    value: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler)
  })

  try {
    registerIpc({
      supervisor: {},
      settings: { get: () => ({ activeWorkspaceId: 'other', workspaces }) },
      getWindow: () => null,
      terminals: { create: () => ({}) },
      memory: { promptFor: () => '' }
    } as unknown as IpcContext)

    const save = handlers.get('fs:savePastedImage')!
    const saved = await save({}, 'AA==', 'image/png', source) as { path: string; root: string } | null
    assert.ok(saved)
    assert.equal(saved.root, realpathSync(source))
    assert.equal(path.dirname(saved.path), saved.root)
    assert.deepEqual(readFileSync(saved.path), Buffer.from([0]))

    const pending = save({}, 'AA==', 'image/png', source)
    workspaces = [otherWorkspace]
    assert.equal(await pending, null, 'removing the source during validation must prevent the write')
    assert.equal(await save({}, 'AA==', 'image/png', source), null)
    assert.equal(await save({}, 'AA==', 'image/png'), null)
    assert.deepEqual(readdirSync(source), [path.basename(saved.path)])
    assert.deepEqual(readdirSync(other), [])
  } finally {
    if (handleDescriptor) Object.defineProperty(ipcMain, 'handle', handleDescriptor)
    else delete (ipcMain as unknown as { handle?: unknown }).handle
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Git writes reject a stale project and registration does not select a folder', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pi-worktree-project-guard-'))
  const source = path.join(directory, 'source')
  const other = path.join(directory, 'other')
  const target = path.join(directory, 'target')
  const fileName = `settings-worktree-guard-${process.pid}.json`
  const settings = new SettingsStore(fileName)
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const handleDescriptor = Object.getOwnPropertyDescriptor(ipcMain, 'handle')
  const claimed: string[] = []
  Object.defineProperty(ipcMain, 'handle', {
    configurable: true,
    value: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler)
  })

  try {
    const workspace = (id: string, path: string) => ({ id, path, name: id, lastOpenedAt: 0 })
    settings.addWorkspace(workspace('source', source))
    settings.addWorkspace(workspace('other', other))
    registerIpc({
      supervisor: { withCwdLock: async (root: string) => { claimed.push(root); return { ok: true } } },
      settings,
      getWindow: () => null,
      terminals: { create: () => ({}) },
      memory: { promptFor: () => '' }
    } as unknown as IpcContext)

    const branches = handlers.get('git:branches')!
    const create = handlers.get('git:addWorktree')!
    assert.throws(() => branches({}, source), /active project changed/)
    await assert.rejects(async () => handlers.get('git:patch')!({}, 'notes.md', source), /active project changed/)
    assert.deepEqual(await create({}, '', 'main-wt', true, source), {
      ok: false, error: 'The active project changed before Git could start.'
    })
    const writes: [string, ...unknown[]][] = [
      ['git:revertFile', 'notes.md', source],
      ['git:applyPatch', 'diff from the original checkout', true, source],
      ['git:commit', 'Commit for the original checkout', true, source],
      ['git:stageFile', 'notes.md', source],
      ['git:unstageFile', 'notes.md', source],
      ['git:stageAll', source],
      ['git:unstageAll', source],
      ['git:switchBranch', 'feature', source],
      ['git:createBranch', 'feature', true, source],
      ['git:removeWorktree', target, source],
      ['git:push', source],
      ['git:pull', source],
      ['git:revertFile', 'notes.md']
    ]
    for (const [channel, ...args] of writes) {
      const result = await handlers.get(channel)!({}, ...args)
      assert.deepEqual(result, { ok: false, error: 'The active project changed before Git could start.' }, channel)
    }
    assert.deepEqual(claimed, [])

    await handlers.get('workspaces:add')!({}, target)
    assert.equal(settings.get().activeWorkspaceId, 'other')
    assert.ok(settings.get().workspaces.some((workspace) => workspace.path === target))

    mkdirSync(source)
    execFileSync('git', ['-C', source, 'init', '-q'])
    settings.patch({ activeWorkspaceId: 'source' })
    assert.deepEqual(await create({}, '', 'main-wt', true, source), { ok: true })
    assert.deepEqual(claimed, [source])
  } finally {
    if (handleDescriptor) Object.defineProperty(ipcMain, 'handle', handleDescriptor)
    else delete (ipcMain as unknown as { handle?: unknown }).handle
    rmSync(path.join(app.getPath('userData'), fileName), { force: true })
    rmSync(directory, { recursive: true, force: true })
  }
})

for (const nested of [true, false]) {
  test(`worktree removal holds runtime admission closed while Git waits (${nested ? 'nested' : 'sibling'})`, async (t) => {
    const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'pi-remove-worktree-admission-'))
    const root = path.join(directory, 'repo')
    const target = path.join(nested ? root : directory, 'other-tree')
    mkdirSync(root)
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    })
    const supervisor = new SessionSupervisor(() => { throw new Error('Pi runtime factory reached') })
    t.after(async () => {
      await supervisor.stop()
      rmSync(directory, { recursive: true, force: true })
    })
    git('init', '-q')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'initial')
    git('worktree', 'add', '-qb', 'other-tree', target)
    const workspaces = [
      { id: 'source', path: root },
      { id: 'target', path: target }
    ]
    let activeWorkspaceId = 'source'
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const withCwdLock = supervisor.withCwdLock.bind(supervisor)
    supervisor.withCwdLock = (cwd, action) => withCwdLock(cwd, async () => {
      if (cwd === (nested ? root : target)) {
        entered.resolve()
        await resume.promise
      }
      return action()
    })

    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    t.mock.method(ipcMain, 'handle', (channel, handler) => handlers.set(channel, handler))
    registerIpc({
      supervisor,
      settings: { get: () => ({ workspaces, activeWorkspaceId }) },
      getWindow: () => null,
      terminals: {},
      memory: {}
    } as unknown as IpcContext)
    const removing = handlers.get('git:removeWorktree')!({}, target, root)
    await Promise.race([
      entered.promise,
      Promise.resolve(removing).then(result => assert.fail(`Removal finished before taking the lock: ${JSON.stringify(result)}`))
    ])
    try {
      assert.deepEqual(await supervisor.ensure({ sessionKey: 'draft:target', cwd: target }), {
        ok: false, error: 'Working folder is being closed.'
      })
      // A user selecting the target before the delayed write reaches Git
      // should not have the worktree removed from under the new view.
      if (!nested) activeWorkspaceId = 'target'
    } finally {
      resume.resolve()
      await removing
    }
    assert.deepEqual(await removing, nested
      ? { ok: true }
      : { ok: false, error: 'The active project changed before Git could start.' })
    assert.equal(existsSync(target), !nested)
    assert.ok(git('branch', '--list', 'other-tree').trim())
    if (!nested) {
      await assert.rejects(supervisor.ensure({ sessionKey: 'draft:retry', cwd: target }), /Pi runtime factory reached/)
    }
  })
}

test('Git review targets the selected repository-relative file from a nested workspace', async (t) => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'pi-nested-git-review-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'sub')
  const selectedPath = 'sub/notes.txt'
  const selected = path.join(root, selectedPath)
  const shadowPath = 'sub/sub/notes.txt'
  const shadow = path.join(root, shadowPath)
  mkdirSync(path.dirname(shadow), { recursive: true })
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  })
  git('init', '-q')
  git('config', 'user.name', 'Pi Desktop test')
  git('config', 'user.email', 'pi-desktop-test@example.invalid')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(selected, 'Selected baseline\n')
  writeFileSync(shadow, 'Shadow baseline\n')
  git('add', '--', selectedPath, shadowPath)
  git('commit', '-qm', 'baseline')
  writeFileSync(selected, 'Selected workspace edit\n')
  writeFileSync(shadow, 'Shadow file edit\n')
  writeFileSync(path.join(workspace, 'new.txt'), 'one\ntwo\n')

  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  t.mock.method(ipcMain, 'handle', (channel, handler) => handlers.set(channel, handler))
  const locked: string[] = []
  registerIpc({
    settings: { get: () => ({ activeWorkspaceId: 'sub', workspaces: [{ id: 'sub', path: workspace }] }) },
    supervisor: { withCwdLock: async (cwd: string, action: () => Promise<unknown>) => {
      locked.push(cwd)
      return action()
    } },
    getWindow: () => null,
    terminals: {},
    memory: {}
  } as unknown as IpcContext)

  const status = await handlers.get('git:status')!({}, workspace) as GitStatus
  assert.ok(status.files.some(({ path }) => path === selectedPath))
  assert.deepEqual(await handlers.get('git:stageFile')!({}, selectedPath, workspace), { ok: true })
  assert.equal(git('diff', '--cached', '--name-only').trim(), selectedPath)
  assert.deepEqual(await handlers.get('git:unstageFile')!({}, selectedPath, workspace), { ok: true })
  assert.equal(git('diff', '--cached', '--name-only'), '')

  assert.equal(status.files.find(({ path }) => path === 'sub/new.txt')?.added, 2)
  const diff = await handlers.get('git:fileDiff')!({}, selectedPath, workspace) as GitFileDiff
  assert.equal(diff.oldText, 'Selected baseline\n')
  assert.equal(diff.newText, 'Selected workspace edit\n')
  const patch = await handlers.get('git:patch')!({}, selectedPath, workspace) as GitPatch
  assert.match(patch.text, /\+Selected workspace edit/)
  assert.doesNotMatch(patch.text, /Shadow file edit/)

  assert.deepEqual(await handlers.get('git:revertFile')!({}, selectedPath, workspace), { ok: true })
  assert.equal(readFileSync(selected, 'utf8'), 'Selected baseline\n')
  assert.equal(readFileSync(shadow, 'utf8'), 'Shadow file edit\n')
  assert.deepEqual(locked.map(cwd => path.resolve(cwd)), [root, root, root])
})

test('runtime ensure reuses a live draft before Pi has flushed its session file', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-runtime-ensure-'))
  const otherWorkspace = path.join(root, 'other')
  mkdirSync(root, { recursive: true })
  mkdirSync(otherWorkspace)
  const sessionFile = path.join(root, 'not-yet-written.jsonl')
  const originalSessionRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const handleDescriptor = Object.getOwnPropertyDescriptor(ipcMain, 'handle')
  const ensureCalls: RuntimeEnsureOptions[] = []
  const liveKeys = new Set([sessionFile])
  Object.defineProperty(ipcMain, 'handle', {
    configurable: true,
    value: (channel: string, listener: unknown) => {
      handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown)
    }
  })

  try {
    process.env.PI_CODING_AGENT_SESSION_DIR = root
    registerIpc({
      supervisor: {
        has: (key: string) => liveKeys.has(key),
        sessionInfo: (key: string) => liveKeys.has(key) ? { cwd: root } : undefined,
        ensure: async (options: RuntimeEnsureOptions) => {
          ensureCalls.push(options)
          return { ok: true }
        }
      },
      settings: {
        get: () => ({
          activeWorkspaceId: 'workspace',
          workspaces: [
            { id: 'workspace', path: root },
            { id: 'other', path: otherWorkspace }
          ]
        })
      },
      getWindow: () => null,
      terminals: { create: () => ({}) },
      memory: { promptFor: () => '' }
    } as unknown as IpcContext)

    const invoke = async (options: RuntimeEnsureOptions) => {
      const handler = handlers.get('runtime:ensure')
      assert.ok(handler, 'runtime:ensure handler was registered')
      return await handler({}, options) as { ok: boolean; error?: string }
    }

    const reused = await invoke({ sessionKey: sessionFile, cwd: root, sessionFile })
    assert.equal(reused.ok, true)
    assert.equal(ensureCalls.length, 1)
    assert.equal(ensureCalls[0]?.sessionFile, undefined)

    const wrongCwd = await invoke({ sessionKey: sessionFile, cwd: otherWorkspace, sessionFile })
    assert.equal(wrongCwd.ok, false)
    assert.equal(wrongCwd.error, 'Conversation belongs to a different working folder.')
    assert.equal(ensureCalls.length, 1, 'a live session must not be reused from another workspace')

    const draftKey = 'draft:reused'
    liveKeys.add(draftKey)
    const wrongDraftCwd = await invoke({ sessionKey: draftKey, cwd: otherWorkspace })
    assert.equal(wrongDraftCwd.ok, false)
    assert.equal(wrongDraftCwd.error, 'Conversation belongs to a different working folder.')
    assert.equal(ensureCalls.length, 1, 'a live draft cannot be rebound without a session file')

    liveKeys.clear()
    const rejected = await invoke({ sessionKey: sessionFile, cwd: root, sessionFile })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.error, "Conversation file is not in Pi's session store.")
    assert.equal(ensureCalls.length, 1, 'an unknown path never reaches the supervisor')
  } finally {
    if (originalSessionRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionRoot
    if (handleDescriptor) Object.defineProperty(ipcMain, 'handle', handleDescriptor)
    else delete (ipcMain as unknown as { handle?: unknown }).handle
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime start and ensure reject a workspace removed during path validation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-runtime-workspace-remove-'))
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const handleDescriptor = Object.getOwnPropertyDescriptor(ipcMain, 'handle')
  const ensureCalls: RuntimeEnsureOptions[] = []
  let workspaces = [{ id: 'workspace', path: root }]
  const liveParent = path.join(root, 'pending-parent.jsonl')
  let settingsReads = 0
  Object.defineProperty(ipcMain, 'handle', {
    configurable: true,
    value: (channel: string, listener: unknown) => {
      handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown)
    }
  })

  try {
    registerIpc({
      supervisor: {
        ensure: async (options: RuntimeEnsureOptions) => {
          ensureCalls.push(options)
          return { ok: true }
        },
        has: (key: string) => {
          if (key !== liveParent) return false
          // Pi's live parent has not flushed its file yet. The folder is
          // removed and added again while this request checks that parent.
          workspaces = [{ id: 'replacement', path: root }]
          return true
        },
        sessionInfo: () => ({ cwd: root, role: 'main' })
      },
      settings: {
        get: () => {
          settingsReads += 1
          return { workspaces }
        }
      },
      getWindow: () => null,
      terminals: { create: () => ({}) },
      memory: { promptFor: () => '' }
    } as unknown as IpcContext)

    const cases: [string, RuntimeEnsureOptions][] = [
      ['runtime:start', { cwd: root }],
      ['runtime:ensure', { sessionKey: 'draft:removed', cwd: root }]
    ]
    for (const [channel, options] of cases) {
      workspaces = [{ id: 'workspace', path: root }]
      const handler = handlers.get(channel)
      assert.ok(handler, `${channel} handler was registered`)
      const readsBefore = settingsReads
      const pending = handler({}, options)
      assert.equal(settingsReads, readsBefore + 1, 'the workspace is authorized before async path checks')
      workspaces = []
      assert.deepEqual(await pending, {
        ok: false,
        error: 'Working folder is no longer an available workspace.'
      })
    }

    workspaces = [{ id: 'workspace', path: root }]
    const start = handlers.get('runtime:start')!
    assert.deepEqual(await start({}, { cwd: root, role: 'side', parentSessionKey: liveParent }), {
      ok: false,
      error: 'Working folder is no longer an available workspace.'
    })
    assert.deepEqual(ensureCalls, [], 'a removed workspace must never reach the supervisor')
  } finally {
    if (handleDescriptor) Object.defineProperty(ipcMain, 'handle', handleDescriptor)
    else delete (ipcMain as unknown as { handle?: unknown }).handle
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime stop requires a conversation id and cannot stop every runtime', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const handleDescriptor = Object.getOwnPropertyDescriptor(ipcMain, 'handle')
  const stopped: unknown[] = []
  Object.defineProperty(ipcMain, 'handle', {
    configurable: true,
    value: (channel: string, listener: unknown) => {
      handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown)
    }
  })

  try {
    registerIpc({
      supervisor: { stop: async (key: string) => { stopped.push(key) } },
      settings: { get: () => ({ workspaces: [] }) },
      getWindow: () => null,
      terminals: { create: () => ({}) },
      memory: { promptFor: () => '' }
    } as unknown as IpcContext)

    const handler = handlers.get('runtime:stop')
    assert.ok(handler, 'runtime:stop handler was registered')
    await handler({}, undefined)
    await handler({}, null)
    await handler({}, '   ')
    assert.deepEqual(stopped, [])

    await handler({}, 'conversation-a')
    assert.deepEqual(stopped, ['conversation-a'])
  } finally {
    if (handleDescriptor) Object.defineProperty(ipcMain, 'handle', handleDescriptor)
    else delete (ipcMain as unknown as { handle?: unknown }).handle
  }
})

test('runtime stopCwd is limited to an exact registered project root', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'runtime-stop-scope-'))
  const workspace = path.join(parent, 'workspace')
  mkdirSync(workspace)
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const handleDescriptor = Object.getOwnPropertyDescriptor(ipcMain, 'handle')
  const operations: string[] = []
  Object.defineProperty(ipcMain, 'handle', {
    configurable: true,
    value: (channel: string, listener: unknown) => {
      handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown)
    }
  })

  try {
    registerIpc({
      supervisor: {
        stopCwd: async (cwd: string, afterStop?: () => void) => {
          operations.push(`stop:${cwd}`)
          afterStop?.()
        }
      },
      settings: {
        get: () => ({
          activeWorkspaceId: 'workspace',
          workspaces: [{ id: 'workspace', path: workspace }]
        }),
        removeWorkspace: () => {
          operations.push('remove')
          return { activeWorkspaceId: null, workspaces: [] }
        }
      },
      getWindow: () => null,
      terminals: { create: () => ({}) },
      memory: { promptFor: () => '' }
    } as unknown as IpcContext)

    const stopCwd = handlers.get('runtime:stopCwd')
    const removeWorkspace = handlers.get('workspaces:remove')
    assert.ok(stopCwd, 'runtime:stopCwd handler was registered')
    assert.ok(removeWorkspace, 'workspaces:remove handler was registered')

    await stopCwd({}, parent)
    await stopCwd({}, null)
    assert.deepEqual(operations, [], 'an unregistered parent path cannot stop project runtimes')

    await stopCwd({}, workspace)
    assert.deepEqual(operations, [`stop:${workspace}`])

    operations.length = 0
    await removeWorkspace({}, 'workspace')
    assert.deepEqual(operations, ['remove', `stop:${workspace}`])
  } finally {
    if (handleDescriptor) Object.defineProperty(ipcMain, 'handle', handleDescriptor)
    else delete (ipcMain as unknown as { handle?: unknown }).handle
    rmSync(parent, { recursive: true, force: true })
  }
})

test('removing a project does not wait for its agent to shut down', async () => {
  // `abort` can spend its whole timeout on a busy run, and the project row used
  // to stay on screen for it. The settings write happens first; the stop drains
  // behind it.
  const parent = mkdtempSync(path.join(tmpdir(), 'runtime-remove-fast-'))
  const workspace = path.join(parent, 'workspace')
  mkdirSync(workspace)
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const handleDescriptor = Object.getOwnPropertyDescriptor(ipcMain, 'handle')
  Object.defineProperty(ipcMain, 'handle', {
    configurable: true,
    value: (channel: string, listener: unknown) => {
      handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown)
    }
  })
  const operations: string[] = []
  let writeFails = true
  let releaseStop: () => void = () => undefined
  try {
    registerIpc({
      supervisor: {
        // A stop that never settles is exactly what a wedged agent looks like.
        stopCwd: (cwd: string) => {
          operations.push(`stop:${cwd}`)
          return new Promise<void>((resolve) => {
            releaseStop = resolve
          })
        }
      },
      settings: {
        get: () => ({
          activeWorkspaceId: 'workspace',
          workspaces: [{ id: 'workspace', path: workspace }]
        }),
        removeWorkspace: () => {
          operations.push('remove')
          if (writeFails) throw new Error('Settings are not writable')
          return { activeWorkspaceId: null, workspaces: [] }
        }
      },
      getWindow: () => null,
      terminals: { create: () => ({}) },
      memory: { promptFor: () => '' }
    } as unknown as IpcContext)

    const removeWorkspace = handlers.get('workspaces:remove')
    assert.ok(removeWorkspace, 'workspaces:remove handler was registered')
    await assert.rejects(removeWorkspace({}, 'workspace'), /Settings are not writable/)
    assert.deepEqual(operations, ['remove'], 'a failed settings write must leave Pi running')

    writeFails = false
    operations.length = 0
    const settings = await removeWorkspace({}, 'workspace')
    assert.deepEqual(operations, ['remove', `stop:${workspace}`], 'the settings write must not wait for the agent')
    assert.deepEqual((settings as { workspaces: unknown[] }).workspaces, [])
    releaseStop()
  } finally {
    if (handleDescriptor) Object.defineProperty(ipcMain, 'handle', handleDescriptor)
    else delete (ipcMain as unknown as { handle?: unknown }).handle
    rmSync(parent, { recursive: true, force: true })
  }
})

test('a packaged build cannot install the Pi CLI into its app directory', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const handleDescriptor = Object.getOwnPropertyDescriptor(ipcMain, 'handle')
  const packagedDescriptor = Object.getOwnPropertyDescriptor(app, 'isPackaged')
  Object.defineProperty(ipcMain, 'handle', {
    configurable: true,
    value: (channel: string, listener: unknown) => {
      handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown)
    }
  })
  Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })

  try {
    registerIpc({
      supervisor: {},
      settings: { get: () => ({ workspaces: [] }) },
      getWindow: () => null,
      terminals: { create: () => ({}) },
      memory: { promptFor: () => '' }
    } as unknown as IpcContext)

    const upgrade = handlers.get('app:upgradePiCli')
    assert.ok(upgrade, 'app:upgradePiCli handler was registered')
    assert.deepEqual(await upgrade({}), {
      success: false,
      error: 'The bundled Pi CLI is updated with Pi Desktop releases.'
    })
  } finally {
    if (handleDescriptor) Object.defineProperty(ipcMain, 'handle', handleDescriptor)
    else delete (ipcMain as unknown as { handle?: unknown }).handle
    if (packagedDescriptor) Object.defineProperty(app, 'isPackaged', packagedDescriptor)
    else delete (app as unknown as { isPackaged?: unknown }).isPackaged
  }
})

test('a Pi CLI upgrade reports completion only after the requested version runs', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-cli-upgrade-verify-'))
  const packageName = '@earendil-works/pi-coding-agent'
  const manifest = path.join(root, 'node_modules', packageName, 'package.json')
  const cli = path.join(path.dirname(manifest), 'dist', 'bundle', 'cli.js')
  mkdirSync(path.dirname(cli), { recursive: true })
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { [packageName]: '^1.5.2' } }))
  const version = '1.5.9'
  const registry = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ name: packageName, 'dist-tags': { latest: version }, versions: {
      [version]: { name: packageName, version, dist: { tarball: `${npmEnvironment.npm_config_registry}pi.tgz` } }
    } }))
  })
  registry.listen(0, '127.0.0.1')
  await once(registry, 'listening')
  const address = registry.address()
  assert.ok(address && typeof address === 'object')
  const npmEnvironment = {
    npm_config_registry: `http://127.0.0.1:${address.port}/`,
    npm_config_userconfig: path.join(root, 'npmrc'),
    npm_config_cache: path.join(root, 'cache'),
    npm_config_fetch_retries: '0',
    npm_config_audit: 'false',
    // Make npm exit successfully without touching the installed CLI.
    npm_config_package_lock_only: 'true'
  }
  const previousEnvironment = Object.keys(npmEnvironment).map(key => [key, process.env[key]] as const)
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const progress: PiCliUpgradeProgress[] = []
  const restore = [
    [ipcMain, 'handle', (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, listener)],
    [app, 'getAppPath', () => root],
    [https, 'get', () => { throw new Error('Use the local npm registry fixture') }],
    [BrowserWindow, 'fromWebContents', () => ({ isDestroyed: () => false, webContents: {
      isDestroyed: () => false, send: (_channel: string, update: PiCliUpgradeProgress) => progress.push(update)
    } })]
  ] as const
  const descriptors = restore.map(([owner, property]) => Object.getOwnPropertyDescriptor(owner, property))
  let finished = 0
  try {
    Object.assign(process.env, npmEnvironment)
    for (const [owner, property, value] of restore) {
      Object.defineProperty(owner, property, { configurable: true, value })
    }
    syncBuiltinESMExports()
    registerIpc({
      supervisor: { prepareForCliUpgrade: async () => true, finishCliUpgrade: () => { finished += 1 } },
      settings: { get: () => ({ workspaces: [] }) },
      getWindow: () => null,
      terminals: { create: () => ({}) },
      memory: { promptFor: () => '' }
    } as unknown as IpcContext)
    const upgrade = handlers.get('app:upgradePiCli')!
    const setCli = (version: string, source: string) => {
      writeFileSync(manifest, JSON.stringify({ name: packageName, version }))
      writeFileSync(cli, source)
    }

    setCli('1.5.2', "console.log('1.5.2')")
    const unchanged = await upgrade({}) as { success: boolean; error?: string }
    assert.equal(unchanged.success, false)
    assert.match(unchanged.error ?? '', /1\.5\.9.*1\.5\.2/)
    assert.equal(progress.some(update => update.percent === 100), false)

    setCli('1.5.9', "console.log('1.5.9'); process.exitCode = 1")
    const broken = await upgrade({}) as { success: boolean }
    assert.equal(broken.success, false)
    assert.equal(progress.some(update => update.percent === 100), false)

    setCli('1.5.9', "console.log('1.5.9')")
    assert.deepEqual(await upgrade({}), { success: true, version: '1.5.9' })
    assert.deepEqual(progress.filter(update => update.percent === 100), [{ stage: 'installing', percent: 100 }])
    assert.equal(finished, 3, 'every outcome releases CLI maintenance')
  } finally {
    restore.forEach(([owner, property], index) => {
      const descriptor = descriptors[index]
      if (descriptor) Object.defineProperty(owner, property, descriptor)
      else Reflect.deleteProperty(owner, property)
    })
    syncBuiltinESMExports()
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    registry.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a packaged build answers for the bundled CLI without asking npm', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const handleDescriptor = Object.getOwnPropertyDescriptor(ipcMain, 'handle')
  const packagedDescriptor = Object.getOwnPropertyDescriptor(app, 'isPackaged')
  const pathEnv = process.env.PATH
  Object.defineProperty(ipcMain, 'handle', {
    configurable: true,
    value: (channel: string, listener: unknown) => {
      handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown)
    }
  })
  Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })

  try {
    // The CLI that ships with the app is released with it, so there is nothing
    // to look up. npm is off the path: a registry request would come back as a
    // failed reading instead of the version the app already carries.
    process.env.PATH = ''
    const expected = (await piVersion()) || '1.4.0'
    registerIpc({
      supervisor: {},
      settings: { get: () => ({ workspaces: [] }) },
      getWindow: () => null,
      terminals: { create: () => ({}) },
      memory: { promptFor: () => '' }
    } as unknown as IpcContext)

    const check = handlers.get('app:checkPiCliUpdate')
    assert.ok(check, 'app:checkPiCliUpdate handler was registered')
    assert.deepEqual(await check({}), { current: expected, hasUpdate: false })
  } finally {
    process.env.PATH = pathEnv
    if (handleDescriptor) Object.defineProperty(ipcMain, 'handle', handleDescriptor)
    else delete (ipcMain as unknown as { handle?: unknown }).handle
    if (packagedDescriptor) Object.defineProperty(app, 'isPackaged', packagedDescriptor)
    else delete (app as unknown as { isPackaged?: unknown }).isPackaged
  }
})


test('runtime ensure fast path skips file validation and memory prompt when isReadyMatch is true', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-runtime-fastpath-'))
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const handleDescriptor = Object.getOwnPropertyDescriptor(ipcMain, 'handle')
  const ensureCalls: RuntimeEnsureOptions[] = []
  let promptForCalls = 0
  let readyMatchCalls = 0

  Object.defineProperty(ipcMain, 'handle', {
    configurable: true,
    value: (channel: string, listener: unknown) => {
      handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown)
    }
  })

  try {
    const sessionFile = path.join(root, 'missing-on-disk-but-matched.jsonl')
    registerIpc({
      supervisor: {
        has: () => true,
        isReadyMatch: () => {
          readyMatchCalls += 1
          return true
        },
        ensure: async (options: RuntimeEnsureOptions) => {
          ensureCalls.push(options)
          return { ok: true }
        }
      },
      settings: {
        get: () => ({
          activeWorkspaceId: 'workspace',
          workspaces: [{ id: 'workspace', path: root }]
        })
      },
      getWindow: () => null,
      terminals: { create: () => ({}) },
      memory: {
        promptFor: () => {
          promptForCalls += 1
          return 'memory prompt'
        }
      }
    } as unknown as IpcContext)

    const handler = handlers.get('runtime:ensure')
    assert.ok(handler)
    const res = await handler({}, {
      sessionKey: sessionFile,
      cwd: root,
      sessionFile,
      prewarm: true
    }) as { ok: boolean }

    assert.equal(res.ok, true)
    assert.equal(readyMatchCalls, 1)
    assert.equal(promptForCalls, 0, 'fast path must not rebuild instructions/memory prompt')
    assert.equal(ensureCalls.length, 1)
    assert.equal(ensureCalls[0]?.prewarm, true)
    assert.equal(ensureCalls[0]?.customInstructions, undefined)
  } finally {
    if (handleDescriptor) Object.defineProperty(ipcMain, 'handle', handleDescriptor)
    else delete (ipcMain as unknown as { handle?: unknown }).handle
    rmSync(root, { recursive: true, force: true })
  }
})

test('sessions:hydrate deduplicates concurrent reads and supersedes stale sender switches', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-hydrate-dedup-'))
  const originalSessionRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const handleDescriptor = Object.getOwnPropertyDescriptor(ipcMain, 'handle')

  Object.defineProperty(ipcMain, 'handle', {
    configurable: true,
    value: (channel: string, listener: unknown) => {
      handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown)
    }
  })

  try {
    process.env.PI_CODING_AGENT_SESSION_DIR = root
    const makeSession = (name: string, count: number): string => {
      const file = path.join(root, name)
      const lines = [JSON.stringify({ type: 'session', id: name, version: 3, cwd: root })]
      let parentId: string | null = null
      for (let i = 0; i < count; i += 1) {
        const id = `m-${i}`
        lines.push(JSON.stringify({
          type: 'message',
          id,
          parentId,
          message: { role: i % 2 === 0 ? 'user' : 'assistant', content: `${name}-${i}`, timestamp: 1_000 + i }
        }))
        parentId = id
      }
      writeFileSync(file, `${lines.join('\n')}\n`)
      return file
    }

    const fileA = makeSession('large-a.jsonl', 600)
    const fileB = makeSession('small-b.jsonl', 4)

    registerIpc({
      supervisor: { has: () => false },
      settings: {
        get: () => ({
          activeWorkspaceId: 'workspace',
          workspaces: [{ id: 'workspace', path: root }]
        })
      },
      getWindow: () => null,
      terminals: { create: () => ({}) },
      memory: { promptFor: () => '' }
    } as unknown as IpcContext)

    const hydrate = handlers.get('sessions:hydrate')
    assert.ok(hydrate)

    type Hydration = { messages: unknown[]; historyTruncated: boolean }
    const senderA = { isDestroyed: () => false }
    const [staleA, activeB] = await Promise.all([
      hydrate({ sender: senderA }, fileA) as Promise<Hydration>,
      hydrate({ sender: senderA }, fileB) as Promise<Hydration>
    ])
    assert.deepEqual(staleA, { messages: [], historyTruncated: false }, 'superseded hydration returns an empty structured result')
    assert.equal(activeB.messages.length, 4, 'newest hydration request completes normally')
    assert.equal(activeB.historyTruncated, false)

    const [branchHistory, selectedHistory] = await Promise.all([
      hydrate({ sender: senderA }, fileA, 'branch') as Promise<Hydration>,
      hydrate({ sender: senderA }, fileB) as Promise<Hydration>
    ])
    assert.equal(branchHistory.messages.length, 600, 'leaving a new branch does not cancel its first load')
    assert.equal(selectedHistory.messages.length, 4)

    const senderB = { isDestroyed: () => false }
    const senderC = { isDestroyed: () => false }
    const [resB, resC] = await Promise.all([
      hydrate({ sender: senderB }, fileA) as Promise<Hydration>,
      hydrate({ sender: senderC }, fileA) as Promise<Hydration>
    ])
    assert.equal(resB.messages.length, 600)
    assert.equal(resC.messages.length, 600)
  } finally {
    if (originalSessionRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionRoot
    if (handleDescriptor) Object.defineProperty(ipcMain, 'handle', handleDescriptor)
    else delete (ipcMain as unknown as { handle?: unknown }).handle
    rmSync(root, { recursive: true, force: true })
  }
})
