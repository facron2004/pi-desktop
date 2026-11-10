import test from 'node:test'
import assert from 'node:assert/strict'
import { linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { canAutoApprove, parseToolApproval, permissionExtension } from '../src/main/pi/permissions'

test('automatic approval keeps commands, external paths and sensitive files behind confirmation', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'pi-permissions-'))
  const cwd = path.join(temp, 'project')
  const childCwd = path.join(cwd, 'child-project')
  const outside = path.join(temp, 'outside')
  const sshRoot = path.join(temp, '.ssh')
  mkdirSync(cwd)
  mkdirSync(childCwd)
  mkdirSync(outside)
  mkdirSync(sshRoot)
  writeFileSync(path.join(cwd, 'notes.txt'), 'notes')
  writeFileSync(path.join(childCwd, 'child-notes.txt'), 'child notes')
  writeFileSync(path.join(outside, 'sensitive.txt'), 'secret')
  writeFileSync(path.join(sshRoot, 'known_hosts'), 'host key')
  linkSync(path.join(outside, 'sensitive.txt'), path.join(cwd, 'alias.txt'))
  try {
    const allowed = (toolName: string, file: string) => canAutoApprove({ toolName, toolSource: 'builtin', input: { path: file } }, cwd)
    for (const tool of ['read', 'write', 'edit']) {
      assert.equal(allowed(tool, 'notes.txt'), true)
      assert.equal(allowed(tool, 'new/directory/notes.txt'), true)
      assert.equal(allowed(tool, '.cache/huggingface/hub/models/gpt2/config.json'), true)
      assert.equal(allowed(tool, '../outside/notes.txt'), false)
      assert.equal(allowed(tool, path.join(outside, 'notes.txt')), false)
    }
    for (const tool of ['read', 'write', 'edit']) {
      assert.equal(allowed(tool, 'alias.txt'), false, `${tool} hard links must require approval`)
    }
    for (const file of [
      '.env', '.env.local', '.envrc', '.git/config', '.pi/extensions/agent.ts',
      '.agents/skills/a.md', 'node_modules/pkg/index.js', 'secret.pem', 'auth.json',
      '.docker/config.json', '.azure/azureProfile.json', '.kube/config', '.gnupg/private-keys-v1.d',
      '.config/gcloud/application_default_credentials.json', '.config/gh/hosts.yml',
      '.cache/huggingface/token', '.cache/huggingface/stored_tokens',
      '.git-credentials', 'credentials.json', 'service-account.json', 'secrets.yaml',
      'id_ed25519', 'client.p12', 'client.pfx', 'release.jks',
      '@../outside/a', '~/secret', 'file:///tmp/secret'
    ]) {
      for (const tool of ['read', 'write', 'edit']) {
        assert.equal(allowed(tool, file), false, `${tool}: ${file}`)
      }
    }
    for (const [tool, file, env] of [
      ['read', 'custom-auth/hf-token', { HF_TOKEN_PATH: path.join(cwd, 'custom-auth', 'hf-token') }],
      ['write', 'custom-auth/stored_tokens', { HF_HOME: path.join(cwd, 'custom-auth') }]
    ] as const) {
      assert.equal(
        canAutoApprove({ toolName: tool, toolSource: 'builtin', input: { path: file } }, cwd, env),
        false,
        `${tool}: configured Hugging Face credential path`
      )
    }
    assert.equal(canAutoApprove({ toolName: 'bash', input: { command: 'echo hi' } }, cwd), false)
    assert.equal(
      canAutoApprove({ toolName: 'read', toolSource: 'builtin', input: { path: 'known_hosts' } }, sshRoot),
      false,
      'sensitive ancestor directories remain protected when selected as the project root'
    )
    assert.equal(canAutoApprove({ toolName: 'powershell', input: { command: 'Get-Content notes.txt' } }, cwd), false)
    assert.equal(canAutoApprove({ toolName: 'mcp__server__write', input: { path: 'notes.txt' } }, cwd), false)
    assert.equal(canAutoApprove({ toolName: 'read', toolSource: 'extension', input: { path: 'notes.txt' } }, cwd), false)
    assert.equal(canAutoApprove({ toolName: 'read', input: { path: 'notes.txt' } }, cwd), false)
    assert.equal(canAutoApprove({ toolName: 'write', toolSource: 'builtin', input: { path: 'child-notes.txt' }, cwd: childCwd }, cwd), true)
    assert.equal(canAutoApprove({ toolName: 'write', input: { path: '../project/notes.txt' }, cwd: childCwd }, cwd), false)
    assert.equal(
      canAutoApprove({ toolName: 'write', input: { path: 'sensitive.txt' }, cwd: outside }, cwd),
      false,
      'a subagent cannot widen automatic approval to a working directory outside the session project'
    )

    symlinkSync(outside, path.join(cwd, 'linked'), 'junction')
    assert.equal(allowed('write', 'linked/new.txt'), false, 'new files must not escape through an ancestor link')
    assert.equal(
      canAutoApprove({ toolName: 'write', input: { path: 'sensitive.txt' }, cwd: path.join(cwd, 'linked') }, cwd),
      false,
      'a symlinked subagent working directory cannot widen automatic approval'
    )
    symlinkSync(path.join(outside, 'missing'), path.join(cwd, 'dangling'), 'junction')
    assert.equal(allowed('write', 'dangling/new.txt'), false, 'dangling links must also require approval')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('permission messages reject malformed requests', () => {
  assert.deepEqual(parseToolApproval('{"toolName":"write","input":{"path":"a.txt"},"toolSource":"builtin"}'), {
    toolName: 'write', input: { path: 'a.txt' }, toolSource: 'builtin'
  })
  const cwd = path.resolve('child-project')
  assert.deepEqual(
    parseToolApproval(JSON.stringify({ toolName: 'write', input: { path: 'a.txt' }, cwd })),
    { toolName: 'write', input: { path: 'a.txt' }, cwd }
  )
  for (const message of [undefined, '{}', 'null', '{', '{"toolName":"write","input":[]}', '{"toolName":"read","input":{"path":"a.txt"},"toolSource":7}']) {
    assert.equal(parseToolApproval(message), undefined)
  }
  assert.equal(parseToolApproval('{"toolName":"write","input":{"path":"a.txt"},"cwd":"relative"}'), undefined)
})

test('subagent permission extensions do not exempt desktop-only tools', () => {
  assert.match(permissionExtension('private-title', false), /new Set\(\[\]\)/)
  assert.match(permissionExtension('private-title'), /desktop_goal_finish/)
})

test('the real extension serializes confirmations and blocks denied or aborted tool calls', async () => {
  type Context = { cwd: string; hasUI: boolean; signal: AbortSignal; ui: { confirm: (title: string, message: string) => Promise<boolean>; setStatus: (key: string, value: string) => void } }
  type Handler = (event: { toolName: string; input: Record<string, unknown> }, ctx: Context) => unknown
  const handlers = new Map<string, Handler>()
  const { default: extension } = await import(`data:text/javascript,${encodeURIComponent(permissionExtension('private-title'))}`)
  extension({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getAllTools: () => [{ name: 'write', sourceInfo: { source: 'extension' } }]
  })
  const answers: ((answer: boolean) => void)[] = []
  const approvalMessages: string[] = []
  const controller = new AbortController()
  let ready = ''
  const ctx: Context = { cwd: path.resolve('permission-project'), hasUI: true, signal: controller.signal, ui: {
    confirm: (_title, message) => {
      approvalMessages.push(message)
      return new Promise((resolve) => answers.push(resolve))
    },
    setStatus: (key, value) => { ready = `${key}:${value}` }
  } }
  const call = handlers.get('tool_call')!
  const event = { toolName: 'write', input: { path: 'notes.txt', options: { encoding: 'utf8' } } }
  handlers.get('session_start')!(event, ctx)
  assert.equal(ready, 'private-title:ready')
  const first = call(event, ctx)
  const second = call(event, ctx)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(answers.length, 1, 'parallel tools cannot replace each other in the approval dialog')
  assert.equal(JSON.parse(approvalMessages[0]).toolSource, 'extension')
  assert.equal(JSON.parse(approvalMessages[0]).cwd, ctx.cwd, 'approval uses Pi’s current working directory')
  answers[0](true)
  assert.equal(await first, undefined)
  assert.equal(Object.isFrozen(event), true)
  assert.equal(Object.isFrozen(event.input), true)
  assert.equal(Object.isFrozen(event.input.options), true)
  assert.equal(Reflect.set(event.input, 'path', 'outside.txt'), false)
  assert.equal(event.input.path, 'notes.txt', 'later hooks cannot change the approved operation')
  assert.equal(Reflect.set(event.input.options, 'encoding', 'binary'), false)
  assert.equal(Reflect.set(event, 'input', { path: 'outside.txt' }), false)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(answers.length, 2)
  answers[1](false)
  assert.equal((await second as { block: boolean }).block, true)
  controller.abort()
  assert.equal((await call(event, ctx) as { block: boolean }).block, true)
  assert.equal(answers.length, 2, 'aborted work never opens another confirmation')
  assert.equal(await call({ toolName: 'computer', input: { action: 'screenshot' } }, ctx), undefined)
  assert.equal(answers.length, 2, 'Computer Use does not open another confirmation')
})
