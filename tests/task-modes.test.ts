import test from 'node:test'
import assert from 'node:assert/strict'
import { Type } from 'typebox'
import { taskModesExtension } from '../src/main/pi/task-modes'

type Entry = { type: string; customType: string; data: unknown }
type Context = { isIdle: () => boolean; sessionManager: { getBranch: () => Entry[] }; ui: { setStatus: (key: string, value: string) => void } }
type Handler = (event: Record<string, unknown>, ctx: Context) => unknown
type GoalTool = { name: string; execute: (id: string, input: { status: 'complete' | 'blocked'; summary: string }, signal: undefined, update: undefined, ctx: Context) => Promise<unknown> }

function fixture(entries: Entry[] = []) {
  const handlers = new Map<string, Handler>()
  const commands = new Map<string, { handler: (value: string, ctx: Context) => Promise<void> }>()
  const tools = new Map<string, GoalTool>()
  const base = ['read', 'write', 'edit', 'powershell', 'mcp__custom']
  let active = [...base]
  let status = ''
  const ctx: Context = {
    isIdle: () => true,
    sessionManager: { getBranch: () => entries },
    ui: { setStatus: (_key, value) => { status = value } }
  }
  const api = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = [...names] },
    getAllTools: () => [...base, 'grep', 'find', 'ls', ...tools.keys()].map(name => ({ name })),
    registerCommand: (name: string, command: { handler: (value: string, ctx: Context) => Promise<void> }) => commands.set(name, command),
    registerTool: (tool: GoalTool) => { tools.set(tool.name, tool); active.push(tool.name) },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data })
  }
  const source = taskModesExtension().replace("import { Type } from 'typebox';", '').replace('export default function', 'return function')
  const install = new Function('Type', source)(Type) as (extensionApi: typeof api) => void
  install(api)
  return {
    ctx, base, entries,
    active: () => active,
    status: () => status,
    emit: (name: string, event: Record<string, unknown> = {}) => handlers.get(name)?.(event, ctx),
    mode: (value: string) => commands.get('desktop-mode')!.handler(value, ctx),
    finish: (status: 'complete' | 'blocked') => tools.get('desktop_goal_finish')!.execute('goal', { status, summary: 'Verified outcome' }, undefined, undefined, ctx)
  }
}

// A completed assistant response needs the new custom message before Pi can continue.
const boundary = { outcome: 'completed', continue: false, context: { canContinue: false } }

test('Plan Mode exposes only read tools, blocks writes and restores the prior loadout', async () => {
  const f = fixture()
  f.emit('session_start')
  assert.deepEqual(f.active(), f.base)
  await f.mode('plan')
  assert.deepEqual(f.active(), ['read', 'grep', 'find', 'ls'])
  for (const toolName of ['write', 'edit', 'powershell', 'mcp__custom']) {
    assert.equal((f.emit('tool_call', { toolName }) as { block: boolean }).block, true)
  }
  assert.equal(f.emit('tool_call', { toolName: 'read' }), undefined)
  await f.mode('default')
  assert.deepEqual(f.active(), f.base)
  assert.equal(f.status(), 'default')
})

test('Goal Mode requests continuation until the goal is explicitly completed or blocked', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.mode('goal')
  f.emit('input', { source: 'rpc', text: 'Finish and verify the task' })
  const next = f.emit('agent_before_settle', boundary) as { continue: boolean; entries: { display: boolean; content: string }[] }
  assert.equal(next.continue, true)
  assert.equal(next.entries[0].display, false)
  assert.match(next.entries[0].content, /Finish and verify the task/)
  assert.equal(f.emit('agent_before_settle', { ...boundary, continue: true }), undefined)
  await f.finish('complete')
  assert.equal(f.emit('agent_before_settle', boundary), undefined)
  f.emit('input', { source: 'rpc', text: 'A new goal' })
  await f.finish('blocked')
  assert.equal(f.emit('agent_before_settle', boundary), undefined)
})

test('Goal Mode never resumes an aborted, failed or unapproved operation', async () => {
  for (const outcome of ['aborted', 'error', 'denied']) {
    const f = fixture()
    f.emit('session_start')
    await f.mode('goal')
    f.emit('input', { source: 'rpc', text: 'User goal' })
    if (outcome === 'denied') {
      f.emit('turn_end', { toolResults: [{ isError: true, content: [{ type: 'text', text: 'The user did not approve this tool operation' }] }] })
    }
    assert.equal(f.emit('agent_before_settle', { ...boundary, outcome: outcome === 'denied' ? 'completed' : outcome }), undefined)
    assert.equal((f.entries.at(-1)!.data as { goal: { status: string } }).goal.status, 'blocked')
  }
})

test('Modes restore from the session branch and a new chat starts with the original tools', async () => {
  const first = fixture()
  first.emit('session_start')
  await first.mode('plan')
  const resumed = fixture([...first.entries])
  resumed.emit('session_start')
  assert.equal(resumed.status(), 'plan')
  assert.deepEqual(resumed.active(), ['read', 'grep', 'find', 'ls'])
  resumed.entries.length = 0
  resumed.emit('session_start', { reason: 'new' })
  assert.equal(resumed.status(), 'default')
  assert.deepEqual(resumed.active(), resumed.base)
})

test('A stop that goes directly to final settlement records the goal as blocked', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.mode('goal')
  f.emit('input', { source: 'rpc', text: 'A running goal' })
  f.emit('agent_settled', { aborted: true })
  assert.equal((f.entries.at(-1)!.data as { goal: { status: string } }).goal.status, 'blocked')
  assert.equal(f.emit('agent_before_settle', boundary), undefined)
})
