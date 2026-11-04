import test from 'node:test'
import assert from 'node:assert/strict'
import { Type } from 'typebox'
import { taskModesExtension, type TaskModeSeed } from '../src/main/pi/task-modes'

type Entry = { type: string; customType: string; data: unknown }
type StatusValue = string | undefined
type GoalStatus = { text: string; status: 'active' | 'paused' | 'blocked' | 'complete'; summary?: string }
type Context = {
  isIdle: () => boolean
  sessionManager: { getBranch: () => Entry[] }
  ui: {
    setStatus: (key: string, value: StatusValue) => void
    confirm: (title: string, message: string) => Promise<boolean | undefined>
  }
}
type Handler = (event: Record<string, unknown>, ctx: Context) => unknown
type ToolResult = { content: { type: string; text: string }[]; details?: unknown; isError?: boolean }
type Tool = {
  name: string
  execute: (
    id: string,
    input: Record<string, unknown>,
    signal: undefined,
    update: undefined,
    ctx: Context
  ) => Promise<ToolResult>
}
type Command = { handler: (value: string, ctx: Context) => Promise<void> }

function fixture(entries: Entry[] = [], computerUse = false, defaultMode: TaskModeSeed = 'default') {
  const handlers = new Map<string, Handler>()
  const commands = new Map<string, Command>()
  const tools = new Map<string, Tool>()
  const base = ['read', 'write', 'edit', 'powershell', 'mcp__custom']
  const registeredExtras = ['grep', 'find', 'ls', 'subagent', 'computer']
  let active = [...base]
  let idle = true
  let confirmResult: boolean | undefined = true
  const statuses = new Map<string, StatusValue>()
  const sent: string[] = []
  const confirms: { title: string; message: string }[] = []
  const ctx: Context = {
    isIdle: () => idle,
    sessionManager: { getBranch: () => entries },
    ui: {
      setStatus: (key, value) => { statuses.set(key, value) },
      confirm: async (title, message) => {
        confirms.push({ title, message })
        return confirmResult
      }
    }
  }
  const api = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = [...names] },
    getAllTools: () => [...base, ...registeredExtras, ...tools.keys()].map(name => ({ name })),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    registerTool: (tool: Tool) => { tools.set(tool.name, tool); active.push(tool.name) },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data }),
    sendUserMessage: (text: string) => sent.push(text)
  }
  const source = taskModesExtension(computerUse, defaultMode).replace("import { Type } from 'typebox';", '').replace('export default function', 'return function')
  const install = new Function('Type', source)(Type) as (extensionApi: typeof api) => void
  install(api)
  const parseGoal = (): GoalStatus | undefined => {
    const raw = statuses.get('pi-desktop-goal')
    return raw ? (JSON.parse(raw) as GoalStatus) : undefined
  }
  return {
    ctx,
    base,
    entries,
    sent,
    confirms,
    active: () => active,
    mode: () => statuses.get('pi-desktop-mode'),
    goal: () => parseGoal(),
    idle: (value: boolean) => { idle = value },
    confirm: (value: boolean | undefined) => { confirmResult = value },
    emit: (name: string, event: Record<string, unknown> = {}) => handlers.get(name)?.(event, ctx),
    command: (name: string, value: string) => {
      const command = commands.get(name)
      assert.ok(command, `missing command ${name}`)
      return command.handler(value, ctx)
    },
    modeCommand: (value: string) => commands.get('desktop-mode')!.handler(value, ctx),
    exitPlan: (plan: string) => tools.get('exit_plan_mode')!.execute('exit-plan', { plan }, undefined, undefined, ctx),
    finish: (status: 'complete' | 'blocked') =>
      tools.get('desktop_goal_finish')!.execute('goal', { status, summary: 'Verified outcome' }, undefined, undefined, ctx)
  }
}

// A completed assistant response needs the new custom message before Pi can continue.
const boundary = { outcome: 'completed', continue: false, context: { canContinue: false } }

test('Plan Mode exposes only read tools plus exit_plan_mode, blocks writes and restores the prior loadout', async () => {
  const f = fixture()
  f.emit('session_start')
  assert.deepEqual(f.active(), f.base)
  await f.modeCommand('plan')
  assert.deepEqual(f.active(), ['read', 'grep', 'find', 'ls', 'exit_plan_mode'])
  for (const toolName of ['write', 'edit', 'powershell', 'mcp__custom', 'subagent']) {
    assert.equal((f.emit('tool_call', { toolName }) as { block: boolean }).block, true)
  }
  assert.equal(f.emit('tool_call', { toolName: 'read' }), undefined)
  assert.equal(f.emit('tool_call', { toolName: 'exit_plan_mode' }), undefined)
  await f.modeCommand('default')
  assert.deepEqual(f.active(), f.base)
  assert.equal(f.mode(), 'default')
})

test('exit_plan_mode asks for approval and leaves Plan Mode only when the plan is approved', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.modeCommand('plan')
  f.confirm(true)
  const approved = await f.exitPlan('1. Edit the file\n2. Run the tests')
  assert.equal(approved.content[0].text, 'Plan approved. Implement it now.')
  assert.deepEqual(f.confirms.at(-1), { title: 'Approve this plan?', message: '1. Edit the file\n2. Run the tests' })
  assert.equal(f.mode(), 'default')
  assert.deepEqual(f.active(), f.base)
  assert.equal((f.entries.at(-1)!.data as { mode: string }).mode, 'default')

  const rejected = fixture()
  rejected.emit('session_start')
  await rejected.modeCommand('plan')
  rejected.confirm(false)
  const answer = await rejected.exitPlan('The plan')
  assert.match(answer.content[0].text, /keep planning/i)
  assert.equal(rejected.mode(), 'plan')
  assert.deepEqual(rejected.active(), ['read', 'grep', 'find', 'ls', 'exit_plan_mode'])

  const cancelled = fixture()
  cancelled.emit('session_start')
  await cancelled.modeCommand('plan')
  cancelled.confirm(undefined)
  const cancelledAnswer = await cancelled.exitPlan('The plan')
  assert.match(cancelledAnswer.content[0].text, /keep planning/i)
  assert.equal(cancelled.mode(), 'plan')
})

test('exit_plan_mode is only available in Plan Mode', async () => {
  const f = fixture()
  f.emit('session_start')
  await assert.rejects(() => f.exitPlan('A plan'), /only available in Plan Mode/)
})

test('Goal Mode requests continuation until the goal is explicitly completed or blocked', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.modeCommand('goal')
  f.emit('input', { source: 'rpc', text: 'Finish and verify the task' })
  assert.equal(f.goal()?.status, 'active')
  const next = f.emit('agent_before_settle', boundary) as { continue: boolean; entries: { display: boolean; content: string }[] }
  assert.equal(next.continue, true)
  assert.equal(next.entries[0].display, false)
  assert.match(next.entries[0].content, /Finish and verify the task/)
  assert.equal(f.emit('agent_before_settle', { ...boundary, continue: true }), undefined)
  await f.finish('complete')
  assert.equal(f.goal()?.status, 'complete')
  assert.equal(f.emit('agent_before_settle', boundary), undefined)
  f.emit('input', { source: 'rpc', text: 'A new goal' })
  await f.finish('blocked')
  assert.equal(f.emit('agent_before_settle', boundary), undefined)
})

test('Goal Mode never resumes an aborted, failed or unapproved operation', async () => {
  for (const outcome of ['aborted', 'error', 'denied']) {
    const f = fixture()
    f.emit('session_start')
    await f.modeCommand('goal')
    f.emit('input', { source: 'rpc', text: 'User goal' })
    if (outcome === 'denied') {
      f.emit('turn_end', { toolResults: [{ isError: true, content: [{ type: 'text', text: 'The user did not approve this tool operation' }] }] })
    }
    assert.equal(f.emit('agent_before_settle', { ...boundary, outcome: outcome === 'denied' ? 'completed' : outcome }), undefined)
    assert.equal((f.entries.at(-1)!.data as { goal: { status: string } }).goal.status, 'blocked')
  }
})

test('Goal state survives mode switches and can be paused, edited, resumed and cleared', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.modeCommand('goal')
  f.emit('input', { source: 'rpc', text: 'Ship the feature' })
  assert.equal(f.goal()?.status, 'active')

  await f.modeCommand('default')
  assert.equal(f.mode(), 'default')
  assert.equal(f.goal()?.text, 'Ship the feature')
  assert.equal(f.goal()?.status, 'active')

  await f.command('desktop-goal', 'pause')
  assert.equal(f.goal()?.status, 'paused')
  assert.equal(f.emit('agent_before_settle', boundary), undefined)

  await f.command('desktop-goal', 'edit Ship it well')
  assert.equal(f.goal()?.text, 'Ship it well')
  assert.equal(f.goal()?.status, 'paused')

  await f.command('desktop-goal', 'resume')
  assert.equal(f.mode(), 'goal')
  assert.equal(f.goal()?.status, 'active')
  assert.equal(f.sent.at(-1), 'Continue toward the active goal: Ship it well')

  await f.command('desktop-goal', 'clear')
  assert.equal(f.goal(), undefined)
  assert.equal(f.mode(), 'default')
  assert.equal(f.entries.at(-1)!.data && (f.entries.at(-1)!.data as { goal: unknown }).goal, undefined)
})

test('/plan and /goal drive the same mode and goal state', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.command('plan', '')
  assert.equal(f.mode(), 'plan')
  await f.command('plan', 'off')
  assert.equal(f.mode(), 'default')

  await f.command('goal', 'Make the tests pass')
  assert.equal(f.mode(), 'goal')
  assert.equal(f.goal()?.text, 'Make the tests pass')
  assert.equal(f.goal()?.status, 'active')
  assert.equal(f.sent.at(-1), 'Make the tests pass')

  await f.command('goal', 'off')
  assert.equal(f.mode(), 'default')
  assert.equal(f.goal(), undefined)
})

test('Computer Use is a setting: on in the normal loadout, off in Plan Mode, and toggled without changing mode', async () => {
  const f = fixture([], true)
  f.emit('session_start')
  assert.equal(f.mode(), 'default')
  assert.deepEqual(f.active(), [...f.base, 'computer'])
  const next = f.emit('before_agent_start') as { message: { customType: string; content: string } }
  assert.equal(next.message.customType, 'desktop-computer-context')
  assert.match(next.message.content, /screenshot/i)

  await f.modeCommand('goal')
  assert.ok(f.active().includes('computer'))
  assert.ok(f.active().includes('desktop_goal_finish'))
  await f.modeCommand('plan')
  assert.equal(f.active().includes('computer'), false)
  assert.equal((f.emit('tool_call', { toolName: 'computer' }) as { block: boolean }).block, true)

  await f.modeCommand('default')
  await f.command('desktop-computer', 'off')
  assert.equal(f.mode(), 'default')
  assert.equal(f.active().includes('computer'), false)
  assert.equal(f.emit('before_agent_start'), undefined)
  await f.command('desktop-computer', 'on')
  assert.deepEqual(f.active(), [...f.base, 'computer'])
})

test('Subagent Mode adds the subagent tool and a delegation instruction', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.modeCommand('subagent')
  assert.deepEqual(f.active(), [...f.base, 'subagent'])
  const next = f.emit('before_agent_start') as { message: { content: string } }
  assert.match(next.message.content, /delegate/i)
  assert.match(next.message.content, /subagent/i)
  await f.modeCommand('default')
  assert.deepEqual(f.active(), f.base)
})

test('Mode changes require an idle run', async () => {
  const f = fixture()
  f.emit('session_start')
  f.idle(false)
  await assert.rejects(() => f.modeCommand('plan'), /Stop the current run/)
  assert.equal(f.mode(), 'default')
})

test('Modes restore from the session branch and a new chat starts with the original tools', async () => {
  const first = fixture()
  first.emit('session_start')
  await first.modeCommand('plan')
  const resumed = fixture([...first.entries])
  resumed.emit('session_start')
  assert.equal(resumed.mode(), 'plan')
  assert.deepEqual(resumed.active(), ['read', 'grep', 'find', 'ls', 'exit_plan_mode'])
  resumed.entries.length = 0
  resumed.emit('session_start', { reason: 'new' })
  assert.equal(resumed.mode(), 'default')
  assert.deepEqual(resumed.active(), resumed.base)
})

test('a seeded Plan Mode starts a new conversation read-only and writes the mode down', () => {
  const f = fixture([], false, 'plan')
  f.emit('session_start')
  assert.equal(f.mode(), 'plan')
  assert.deepEqual(f.active(), ['read', 'grep', 'find', 'ls', 'exit_plan_mode'])
  assert.equal((f.emit('tool_call', { toolName: 'write' }) as { block: boolean }).block, true)
  const next = f.emit('before_agent_start') as { message: { customType: string } }
  assert.equal(next.message.customType, 'desktop-plan-context')
  // Persisting the seed is what keeps this conversation in Plan Mode once the
  // setting is turned off and the session is opened again.
  assert.equal((f.entries.at(-1)!.data as { mode: string }).mode, 'plan')
})

test('a session entry still decides the mode when Plan Mode is the default', () => {
  const f = fixture([{ type: 'custom', customType: 'pi-desktop-mode', data: { mode: 'default' } }], false, 'plan')
  f.emit('session_start')
  assert.equal(f.mode(), 'default')
  assert.deepEqual(f.active(), f.base)
  // Default is the absence of a mode, so session_start writes nothing.
  assert.equal(f.entries.length, 1)

  const restored = fixture(
    [{ type: 'custom', customType: 'pi-desktop-mode', data: { mode: 'goal', goal: { text: 'Stored', status: 'active' } } }],
    false,
    'plan'
  )
  restored.emit('session_start')
  assert.equal(restored.mode(), 'goal')
  assert.equal(restored.goal()?.text, 'Stored')
})

test('a conversation seeded into Plan Mode keeps it after the setting is turned off', () => {
  const started = fixture([], false, 'plan')
  started.emit('session_start')
  const reopened = fixture([...started.entries], false, 'default')
  reopened.emit('session_start')
  assert.equal(reopened.mode(), 'plan')
  assert.deepEqual(reopened.active(), ['read', 'grep', 'find', 'ls', 'exit_plan_mode'])
})

test('the default seed leaves a new conversation in Default Mode with its original tools', () => {
  const f = fixture()
  f.emit('session_start')
  assert.equal(f.mode(), 'default')
  assert.deepEqual(f.active(), f.base)
  assert.equal(f.entries.length, 0)
})

test('A goal restored from the branch republishes its status', async () => {
  const first = fixture()
  first.emit('session_start')
  await first.modeCommand('goal')
  first.emit('input', { source: 'rpc', text: 'Restored goal' })
  const resumed = fixture([...first.entries])
  resumed.emit('session_start')
  assert.equal(resumed.goal()?.text, 'Restored goal')
  assert.equal(resumed.goal()?.status, 'active')
  assert.equal(resumed.mode(), 'goal')
})

test('A stop that goes directly to final settlement records the goal as blocked', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.modeCommand('goal')
  f.emit('input', { source: 'rpc', text: 'A running goal' })
  f.emit('agent_settled', { aborted: true })
  assert.equal((f.entries.at(-1)!.data as { goal: { status: string } }).goal.status, 'blocked')
  assert.equal(f.emit('agent_before_settle', boundary), undefined)
})
