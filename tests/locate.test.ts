import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { currentNodeVersion, findBundledCli, resolvePiLaunch } from '../src/main/pi/locate'

/**
 * How the app finds the agent it drives. A wrong answer here means no agent
 * starts at all, so the precedence is worth pinning: the user's explicit path,
 * the CLI bundled with the app, then `pi` on PATH, then a clear "none".
 */

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'pi-locate-'))
}

test('the running node version is reported as-is', () => {
  assert.equal(currentNodeVersion(), process.versions.node)
})

test('an explicit JavaScript CLI runs under the current node', () => {
  const dir = tempDir()
  const script = path.join(dir, 'pi.js')
  writeFileSync(script, '// a stand-in for the CLI entry\n')
  try {
    const spec = resolvePiLaunch(script)
    assert.equal(spec.source, 'custom')
    assert.equal(spec.command, process.execPath)
    assert.deepEqual(spec.prefixArgs, [script])
    // The bundled entry is a script, so the app runs it through its own node
    // (Electron's) with ELECTRON_RUN_AS_NODE instead of requiring a system one.
    assert.equal(spec.env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(spec.display, script)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an explicit executable is spawned directly', () => {
  const dir = tempDir()
  const executable = path.join(dir, 'pi.exe')
  writeFileSync(executable, 'not really a binary')
  try {
    const spec = resolvePiLaunch(executable)
    assert.equal(spec.source, 'custom')
    assert.equal(spec.command, executable)
    assert.deepEqual(spec.prefixArgs, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a custom path that no longer exists falls back to the bundled CLI', () => {
  const bundled = findBundledCli()
  assert.ok(bundled, 'the bundled agent must be installed for the suite to run')
  const dir = tempDir()
  try {
    const spec = resolvePiLaunch(path.join(dir, 'uninstalled.js'))
    assert.equal(spec.source, 'bundled')
    assert.deepEqual(spec.prefixArgs, [bundled])
    assert.match(spec.display, /pi-coding-agent/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a cached launch is discarded when its executable disappears', () => {
  const dir = tempDir()
  const executable = path.join(dir, 'pi.exe')
  writeFileSync(executable, 'not really a binary')
  try {
    assert.equal(resolvePiLaunch(executable).source, 'custom')
    rmSync(executable)
    // The cache is keyed by the settings path, so this would answer "custom"
    // forever; the existence re-check is what makes an uninstalled CLI fall back.
    assert.equal(resolvePiLaunch(executable).source, 'bundled')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no CLI anywhere reports none instead of inventing a command', () => {
  const empty = tempDir()
  const originalAppPath = (app as unknown as { getAppPath: () => string }).getAppPath
  const originalPath = process.env.PATH
  try {
    ;(app as unknown as { getAppPath: () => string }).getAppPath = () => empty
    process.env.PATH = ''
    const spec = resolvePiLaunch()
    assert.equal(spec.source, 'none')
    assert.equal(spec.command, '')
    assert.deepEqual(spec.prefixArgs, [])
  } finally {
    ;(app as unknown as { getAppPath: () => string }).getAppPath = originalAppPath
    process.env.PATH = originalPath
    rmSync(empty, { recursive: true, force: true })
  }
})
