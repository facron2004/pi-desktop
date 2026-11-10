import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { IPty } from 'node-pty'
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

test('terminal output pauses the PTY until the renderer acknowledges buffered data', () => {
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
  }, () => fakePty)
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

  manager.kill(session.id)
})

test('disposing terminal sessions kills their PTYs and ignores late output', () => {
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
  }, () => fakePty)

  manager.create({ cols: 80, rows: 24, cwd: process.cwd() })
  manager.disposeAll()
  emitData('late output')
  manager.disposeAll()

  assert.equal(kills, 1)
  assert.deepEqual(outputs, [])
})
