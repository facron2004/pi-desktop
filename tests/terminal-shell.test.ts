import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveShellSpec } from '../src/main/shell'

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
