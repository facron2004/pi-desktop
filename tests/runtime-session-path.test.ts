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

test('runtime requests reserve their command and id fields for the RPC client', async () => {
  const runtime = new PiRuntime()
  const requests: { type: string; id?: string; [key: string]: unknown }[] = []
  const client = {
    running: true,
    request: async <T>(request: { type: string; id?: string; [key: string]: unknown }): Promise<T> => {
      requests.push(request)
      return {} as T
    }
  }
  ;(runtime as unknown as { client: typeof client }).client = client

  await runtime.request('get_tree', {
    type: 'extension_ui_response',
    id: 'pi-owned-dialog-id',
    sessionFile: 'session.jsonl'
  })

  assert.deepEqual(requests, [{ type: 'get_tree', sessionFile: 'session.jsonl' }])
  await assert.rejects(
    runtime.request('extension_ui_response', { id: 'pi-owned-dialog-id', confirmed: true }),
    /runtime:respondUi/
  )
  assert.equal(requests.length, 1)
})
