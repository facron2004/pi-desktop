import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { PiRuntime } from '../src/main/pi/runtime'

test('runtime rejects a session file outside the session root before launch', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'pi-runtime-session-path-'))
  const root = path.join(parent, 'sessions')
  const workspace = path.join(root, '--C--project--')
  const outside = path.join(parent, 'outside.jsonl')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(outside, '{"type":"session","id":"outside"}\n')

  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  const runtime = new PiRuntime()
  try {
    process.env.PI_CODING_AGENT_SESSION_DIR = root
    const result = await runtime.start({ cwd: workspace, sessionFile: outside })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'Conversation file changed before Pi could reopen it.')
    assert.equal(runtime.currentStatus.phase, 'error')
  } finally {
    await runtime.stop()
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    rmSync(parent, { recursive: true, force: true })
  }
})

test('runtime refuses a missing session file instead of silently starting a blank chat', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'pi-runtime-session-deleted-'))
  const root = path.join(parent, 'sessions')
  const workspace = path.join(root, '--C--project--')
  const missing = path.join(workspace, 'deleted.jsonl')
  mkdirSync(workspace, { recursive: true })

  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  const runtime = new PiRuntime()
  try {
    process.env.PI_CODING_AGENT_SESSION_DIR = root
    const result = await runtime.start({ cwd: workspace, sessionFile: missing })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'Conversation file changed before Pi could reopen it.')
    assert.equal(runtime.currentStatus.phase, 'error')
  } finally {
    await runtime.stop()
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    rmSync(parent, { recursive: true, force: true })
  }
})
