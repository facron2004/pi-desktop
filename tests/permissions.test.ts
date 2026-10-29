import test from 'node:test'
import assert from 'node:assert/strict'
import { linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { canAutoApprove, parseToolApproval, permissionExtension } from '../src/main/pi/permissions'

test('automatic approval keeps commands, external paths and sensitive files behind confirmation', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'pi-permissions-'))
  const cwd = path.join(temp, 'project')
  const outside = path.join(temp, 'outside')
  mkdirSync(cwd)
  mkdirSync(outside)
  writeFileSync(path.join(cwd, 'notes.txt'), 'notes')
  writeFileSync(path.join(outside, 'sensitive.txt'), 'secret')
  linkSync(path.join(outside, 'sensitive.txt'), path.join(cwd, 'alias.txt'))
  try {
    const allowed = (toolName: string, file: string) => canAutoApprove({ toolName, input: { path: file } }, cwd)
    for (const tool of ['read', 'write', 'edit']) {
      assert.equal(allowed(tool, 'notes.txt'), true)
      assert.equal(allowed(tool, 'new/directory/notes.txt'), true)
      assert.equal(allowed(tool, '../outside/notes.txt'), false)
      assert.equal(allowed(tool, path.join(outside, 'notes.txt')), false)
    }
    for (const tool of ['read', 'write', 'edit']) {
      assert.equal(allowed(tool, 'alias.txt'), false, `${tool} hard links must require approval`)
    }
    for (const file of ['.env', '.env.local', '.git/config', '.pi/extensions/agent.ts', '.agents/skills/a.md', 'node_modules/pkg/index.js', 'secret.pem', 'auth.json', '@../outside/a', '~/secret', 'file:///tmp/secret']) {
      assert.equal(allowed('write', file), false, file)
    }
    assert.equal(canAutoApprove({ toolName: 'bash', input: { command: 'echo hi' } }, cwd), false)
    assert.equal(canAutoApprove({ toolName: 'powershell', input: { command: 'Get-Content notes.txt' } }, cwd), false)
    assert.equal(canAutoApprove({ toolName: 'mcp__server__write', input: { path: 'notes.txt' } }, cwd), false)

    symlinkSync(outside, path.join(cwd, 'linked'), 'junction')
    assert.equal(allowed('write', 'linked/new.txt'), false, 'new files must not escape through an ancestor link')
    symlinkSync(path.join(outside, 'missing'), path.join(cwd, 'dangling'), 'junction')
    assert.equal(allowed('write', 'dangling/new.txt'), false, 'dangling links must also require approval')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('permission messages reject malformed requests', () => {
  assert.deepEqual(parseToolApproval('{"toolName":"write","input":{"path":"a.txt"}}'), { toolName: 'write', input: { path: 'a.txt' } })
  for (const message of [undefined, '{}', 'null', '{', '{"toolName":"write","input":[]}']) {
    assert.equal(parseToolApproval(message), undefined)
  }
})

test('the real extension serializes confirmations and blocks denied or aborted tool calls', async () => {
  type Context = { hasUI: boolean; signal: AbortSignal; ui: { confirm: () => Promise<boolean>; setStatus: (key: string, value: string) => void } }
  type Handler = (event: { toolName: string; input: Record<string, unknown> }, ctx: Context) => unknown
  const handlers = new Map<string, Handler>()
  const { default: extension } = await import(`data:text/javascript,${encodeURIComponent(permissionExtension('private-title'))}`)
  extension({ on: (name: string, handler: Handler) => handlers.set(name, handler) })
  const answers: ((answer: boolean) => void)[] = []
  const controller = new AbortController()
  let ready = ''
  const ctx: Context = { hasUI: true, signal: controller.signal, ui: {
    confirm: () => new Promise((resolve) => answers.push(resolve)),
    setStatus: (key, value) => { ready = `${key}:${value}` }
  } }
  const call = handlers.get('tool_call')!
  const event = { toolName: 'write', input: { path: 'notes.txt' } }
  handlers.get('session_start')!(event, ctx)
  assert.equal(ready, 'private-title:ready')
  const first = call(event, ctx)
  const second = call(event, ctx)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(answers.length, 1, 'parallel tools cannot replace each other in the approval dialog')
  answers[0](true)
  assert.equal(await first, undefined)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(answers.length, 2)
  answers[1](false)
  assert.equal((await second as { block: boolean }).block, true)
  controller.abort()
  assert.equal((await call(event, ctx) as { block: boolean }).block, true)
  assert.equal(answers.length, 2, 'aborted work never opens another confirmation')
})
