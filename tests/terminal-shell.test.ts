import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty'
import { resolveShellSpec } from '../src/main/shell'
import { assertTerminalWorkingDirectory } from '../src/main/terminal-path'
import { TerminalManager } from '../src/main/terminal'
import type { TerminalDataPayload } from '../src/shared/types'

test('the integrated terminal defaults to PowerShell', () => {
  assert.equal(resolveShellSpec(undefined).label, 'PowerShell')
  assert.equal(resolveShellSpec('powershell').label, 'PowerShell')
})

test('cmd uses the Windows command processor', () => {
  const spec = resolveShellSpec('cmd')
  assert.equal(spec.label, 'Command Prompt')
  assert.match(spec.file, /cmd\.exe$/i)
})

test('git bash is resolved from the usual install locations', () => {
  const spec = resolveShellSpec('gitbash')
  assert.equal(spec.label, 'Git Bash')
  assert.ok(spec.args.length > 0)
})

test('wsl runs the wsl executable', () => {
  assert.equal(resolveShellSpec('wsl').label, 'WSL')
  assert.equal(resolveShellSpec('wsl').file, 'wsl.exe')
})

test('terminal creation does not recreate a missing working directory', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'pi-terminal-cwd-'))
  const missing = path.join(parent, 'deleted-project')
  try {
    assert.throws(
      () => assertTerminalWorkingDirectory(missing),
      /working directory does not exist or is inaccessible/i
    )
    assert.equal(existsSync(missing), false)

    const file = path.join(parent, 'file.txt')
    writeFileSync(file, '')
    assert.throws(
      () => assertTerminalWorkingDirectory(file),
      /working directory is not a directory/i
    )

    assert.doesNotThrow(() => assertTerminalWorkingDirectory(parent))
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('terminal output pauses the PTY until the renderer acknowledges buffered data', async () => {
  let emitData: (data: string) => void = () => undefined
  let pauses = 0
  let resumes = 0
  const fakePty = {
    pid: 123,
    onData(listener: (data: string) => void) {
      emitData = listener
      return { dispose() {} }
    },
    onExit() {
      return { dispose() {} }
    },
    write() {},
    resize() {},
    clear() {},
    kill() {},
    pause() {
      pauses += 1
    },
    resume() {
      resumes += 1
    }
  } as unknown as IPty
  const outputs: TerminalDataPayload[] = []
  const manager = new TerminalManager((channel, payload) => {
    if (channel === 'terminal:data') outputs.push(payload as TerminalDataPayload)
  }, () => fakePty, 'linux')
  const session = manager.create({ cols: 80, rows: 24, cwd: process.cwd() })

  emitData('a'.repeat(128 * 1024))
  emitData('b'.repeat(128 * 1024))
  assert.equal(pauses, 1)
  assert.deepEqual(outputs.map(({ sequence }) => sequence), [1, 2])

  manager.acknowledgeOutput(session.id, outputs[0].sequence)
  manager.acknowledgeOutput(session.id, outputs[0].sequence)
  assert.equal(resumes, 0)
  manager.acknowledgeOutput(session.id, outputs[1].sequence)
  assert.equal(resumes, 1)

  for (let index = 0; index < 1024; index += 1) emitData('x')
  assert.equal(pauses, 2)
  for (let sequence = 3; sequence <= 769; sequence += 1) {
    manager.acknowledgeOutput(session.id, sequence)
  }
  assert.equal(resumes, 1)
  manager.acknowledgeOutput(session.id, 770)
  assert.equal(resumes, 2)

  await manager.kill(session.id)
})

test('disposing terminal sessions kills their PTYs and ignores late output', async () => {
  let emitData: (data: string) => void = () => undefined
  let kills = 0
  const outputs: TerminalDataPayload[] = []
  const fakePty = {
    pid: 123,
    onData(listener: (data: string) => void) {
      emitData = listener
      return { dispose() {} }
    },
    onExit() {
      return { dispose() {} }
    },
    write() {},
    resize() {},
    clear() {},
    kill() {
      kills += 1
    },
    pause() {},
    resume() {}
  } as unknown as IPty
  const manager = new TerminalManager((channel, payload) => {
    if (channel === 'terminal:data') outputs.push(payload as TerminalDataPayload)
  }, () => fakePty, 'linux')

  manager.create({ cols: 80, rows: 24, cwd: process.cwd() })
  await manager.disposeAll()
  emitData('late output')
  await manager.disposeAll()

  assert.equal(kills, 1)
  assert.deepEqual(outputs, [])
})

function disposablePty(): IPty {
  return {
    pid: 123,
    onData() { return { dispose() {} } },
    onExit() { return { dispose() {} } },
    write() {},
    resize() {},
    clear() {},
    kill() {},
    pause() {},
    resume() {}
  } as unknown as IPty
}

test('Windows retries only a ConPTY launch failure once with Winpty', async () => {
  const attempts: Array<boolean | undefined> = []
  const manager = new TerminalManager(
    () => undefined,
    (_file, _args, options: IPtyForkOptions | IWindowsPtyForkOptions) => {
      attempts.push('useConpty' in options ? options.useConpty : undefined)
      if (attempts.length === 1) throw new Error('Cannot launch conpty')
      return disposablePty()
    },
    'win32',
    async () => true
  )

  const session = manager.create({ cols: 80, rows: 24, cwd: process.cwd(), shell: 'cmd' })
  assert.ok(session.id)
  assert.deepEqual(attempts, [undefined, false])
  await manager.disposeAll()
})

test('terminal startup does not retry other errors or non-Windows platforms', () => {
  for (const { platform, message } of [
    { platform: 'win32' as const, message: 'spawn cmd.exe ENOENT' },
    { platform: 'linux' as const, message: 'Cannot launch conpty' }
  ]) {
    let attempts = 0
    const manager = new TerminalManager(
      () => undefined,
      () => {
        attempts += 1
        throw new Error(message)
      },
      platform
    )
    assert.throws(
      () => manager.create({ cols: 80, rows: 24, cwd: process.cwd(), shell: 'cmd' }),
      new Error(message)
    )
    assert.equal(attempts, 1)
  }
})

test('Windows terminal shutdown joins a pending tab close and waits for the tree cleanup', async () => {
  const treeFinished = Promise.withResolvers<boolean>()
  const treeStarts: number[] = []
  let nativeStops = 0
  let writes = 0
  const process = disposablePty()
  process.kill = () => { nativeStops += 1 }
  process.write = () => { writes += 1 }
  const manager = new TerminalManager(() => undefined, () => process, 'win32', pid => {
    treeStarts.push(pid)
    return treeFinished.promise
  })
  const terminal = manager.create({ cols: 80, rows: 24 })
  const closing = manager.kill(terminal.id)
  let disposed = false
  const shutdown = manager.disposeAll().then(() => { disposed = true })
  manager.write(terminal.id, 'ignored')
  await Promise.resolve()
  assert.deepEqual(treeStarts, [process.pid])
  assert.equal(writes, 0)
  assert.equal(nativeStops, 0)
  assert.equal(disposed, false)
  treeFinished.resolve(true)
  await Promise.all([closing, shutdown])
  assert.equal(nativeStops, 1)
  assert.equal(disposed, true)
})

test('a failed terminal close retains its PTY for a later disposal pass', async () => {
  let attempts = 0
  const process = disposablePty()
  process.kill = () => {
    if (++attempts === 1) throw new Error('PTY is temporarily unavailable')
  }
  const manager = new TerminalManager(() => undefined, () => process, 'linux')
  const terminal = manager.create({ cols: 80, rows: 24 })
  await manager.kill(terminal.id)
  await manager.disposeAll()
  await manager.disposeAll()
  assert.equal(attempts, 2)
})
