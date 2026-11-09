import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveShellSpec } from '../src/main/shell'
import { assertTerminalWorkingDirectory } from '../src/main/terminal-path'

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
