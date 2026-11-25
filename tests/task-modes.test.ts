import test from 'node:test'
import assert from 'node:assert/strict'
import { Type } from 'typebox'
import { AGENT_MODES } from '@shared/types'
import {
  PROGRESS_COMMENTARY_GUIDELINE,
  taskModesExtension,
  type TaskModeSeed
} from '../src/main/pi/task-modes'
import {
  EXTERNAL_CONTEXT_CLASSIFICATION_VERSION,
  EXTERNAL_CONTEXT_CHECKED_ENTRY,
  EXTERNAL_CONTEXT_ENTRY,
  EXTERNAL_CONTEXT_UNKNOWN_ENTRY,
  EXTERNAL_TOOL_OVERRIDE_ENTRY
} from '../src/main/memory/policy'

type Entry = {
  type: string
  id?: string
  parentId?: string | null
  customType: string
  data: unknown
  message?: { role?: string; content?: string | { type?: string; name?: unknown }[] }
}
type StatusValue = string | undefined
type GoalStatus = { text: string; status: 'active' | 'paused' | 'blocked' | 'complete'; summary?: string }
type Context = {
  hasUI: boolean
  isIdle: () => boolean
  abort: () => void
  sessionManager: { getBranch: () => Entry[]; getEntry: (id: string) => Entry | undefined; getLeafId: () => string | null }
  navigateTree: (
    targetId: string,
    options?: { summarize?: boolean }
  ) => Promise<{ cancelled: boolean }>
  ui: {
    setStatus: (key: string, value: StatusValue) => void
    confirm: (title: string, message: string, options?: { signal?: AbortSignal }) => Promise<boolean | undefined>
    select: (title: string, labels: string[], options?: { signal?: AbortSignal }) => Promise<string | undefined>
  }
}
type Handler = (event: Record<string, unknown>, ctx: Context) => unknown
type ToolResult = { content: { type: string; text: string }[]; details?: unknown; isError?: boolean; terminate?: boolean }
type Tool = {
  name: string
  promptGuidelines?: string[]
  execute: (
    id: string,
    input: Record<string, unknown>,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: Context
  ) => Promise<ToolResult>
}
type Command = { handler: (value: string, ctx: Context) => Promise<void> }

function fixture(
  entries: Entry[] = [],
  computerUse = false,
  defaultMode: TaskModeSeed = 'default',
  toolSettings: { active?: string[]; defaultTools?: string[] } = {}
) {
  const handlers = new Map<string, Handler>()
  const commands = new Map<string, Command>()
  const tools = new Map<string, Tool>()
  const base = toolSettings.active ?? ['read', 'write', 'edit', 'powershell', 'mcp__custom']
  const builtin = [...new Set([...base, 'grep', 'find', 'ls', 'powershell'])]
  const registered = [...builtin, 'subagent', 'computer']
  const modeExtensionPath = 'pi-desktop-task-modes-test'
  let active = [...base]
  let idle = true
  let aborts = 0
  let confirmResult: boolean | undefined | Promise<boolean | undefined> = true
  let selectResult: string | undefined | Promise<string | undefined>
  const statuses = new Map<string, StatusValue>()
  const toolSources = new Map<string, string>([
    ...builtin.map((name) => [name, 'builtin'] as const),
    ...['subagent', 'computer'].map((name) => [name, 'cli'] as const)
  ])
  const toolPaths = new Map<string, string>(
    builtin.map((name) => [name, `builtin:${name}`] as const)
  )
  const sent: string[] = []
  const sentMessages: {
    message: { customType?: string; content?: string; display?: boolean }
    options?: { triggerTurn?: boolean }
  }[] = []
  const confirms: { title: string; message: string; signal?: AbortSignal }[] = []
  const selections: { question: string; options: string[]; signal?: AbortSignal }[] = []
  const navigations: { targetId: string; options?: { summarize?: boolean } }[] = []
  // Pi's leaf pointer: an append lands on it, navigation moves it. The rewind
  // and its undo are both defined by where it is, so the fixture models it.
  let leafId: string | null = null
  let appended = 0
  const ctx: Context = {
    hasUI: true,
    isIdle: () => idle,
    abort: () => { aborts += 1 },
    sessionManager: {
      getBranch: () => entries,
      getEntry: (id) => entries.find((entry) => entry.id === id),
      getLeafId: () => leafId
    },
    navigateTree: async (targetId, options) => {
      navigations.push({ targetId, options })
      // Mirrors Pi: a user message stops *before* itself, anything else is a
      // position the leaf can rest on.
      const entry = entries.find((candidate) => candidate.id === targetId)
      leafId = entry?.type === 'message' && entry.message?.role === 'user'
        ? entry.parentId ?? null
        : targetId
      return { cancelled: false }
    },
    ui: {
      setStatus: (key, value) => { statuses.set(key, value) },
      confirm: async (title, message, options) => {
        confirms.push({ title, message, ...(options?.signal ? { signal: options.signal } : {}) })
        return confirmResult
      },
      select: async (question, options, control) => {
        selections.push({ question, options, signal: control?.signal })
        return selectResult
      }
    }
  }
  const api = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getActiveTools: () => active,
    getSettings: () => ({ defaultTools: toolSettings.defaultTools }),
    setActiveTools: (names: string[]) => { active = [...names] },
    getAllTools: () => [...registered, ...tools.keys()].map(name => {
      const source = toolSources.get(name) ?? (tools.has(name) ? 'local' : 'project')
      return {
        name,
        sourceInfo: {
          source,
          path: toolPaths.get(name) ?? (tools.has(name) ? modeExtensionPath : `${source}:${name}`)
        }
      }
    }),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    registerTool: (tool: Tool) => {
      tools.set(tool.name, tool)
      toolSources.set(tool.name, 'local')
      toolPaths.set(tool.name, modeExtensionPath)
      active.push(tool.name)
    },
    appendEntry: (customType: string, data: unknown) => {
      appended += 1
      const id = `appended-${appended}`
      entries.push({ id, parentId: leafId, type: 'custom', customType, data })
      leafId = id
      return id
    },
    sendUserMessage: (text: string) => sent.push(text),
    sendMessage: (message: { customType?: string; content?: string; display?: boolean }, options?: { triggerTurn?: boolean }) => {
      sentMessages.push({ message, options })
    }
  }
  const source = taskModesExtension(computerUse, defaultMode, modeExtensionPath)
    .replace("import { Type } from 'typebox';", '')
    .replace('export default function', 'return function')
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
    sentMessages,
    confirms,
    selections,
    navigations,
    active: () => active,
    mode: () => statuses.get('pi-desktop-mode'),
    goal: () => parseGoal(),
    aborts: () => aborts,
    idle: (value: boolean) => { idle = value },
    toolSource: (name: string, source: string) => {
      toolSources.set(name, source)
      toolPaths.set(name, `${source}:${name}`)
    },
    confirm: (value: typeof confirmResult) => { confirmResult = value },
    select: (value: string | undefined | Promise<string | undefined>) => { selectResult = value },
    emit: (name: string, event: Record<string, unknown> = {}) => handlers.get(name)?.(event, ctx),
    command: (name: string, value: string) => {
      const command = commands.get(name)
      assert.ok(command, `missing command ${name}`)
      return command.handler(value, ctx)
    },
    modeCommand: (value: string) => commands.get('desktop-mode')!.handler(value, ctx),
    askUser: (question: string, options: string[], signal?: AbortSignal) =>
      tools.get('desktop_ask_user')!.execute('ask', { question, options }, signal, undefined, ctx),
    exitPlan: (plan: string, signal?: AbortSignal) => tools.get('exit_plan_mode')!.execute('exit-plan', { plan }, signal, undefined, ctx),
    finish: (status: 'complete' | 'blocked') =>
      tools.get('desktop_goal_finish')!.execute('goal', { status, summary: 'Verified outcome' }, undefined, undefined, ctx),
    todo: (items: { text: string; status: string }[]) =>
      tools.get('desktop_todo')!.execute('todo', { items }, undefined, undefined, ctx),
    toolGuidelines: (name: string) => tools.get(name)?.promptGuidelines ?? []
  }
}

// A completed assistant response needs the new custom message before Pi can continue.
const boundary = { outcome: 'completed', continue: false, context: { canContinue: false } }
const PLAN_TOOLS = ['read', 'grep', 'find', 'ls', 'exit_plan_mode', 'desktop_ask_user']
const DESKTOP_TOOLS = ['subagent', 'desktop_todo', 'desktop_ask_user']

test('the user question is available in every desktop task mode and returns the exact selected option', async () => {
  const f = fixture()
  f.emit('session_start')
  for (const mode of AGENT_MODES) {
    await f.modeCommand(mode)
    assert.ok(f.active().includes('desktop_ask_user'), `missing question tool in ${mode}`)
  }
  await f.modeCommand('plan')
  const question = 'Which scope should the plan cover?'
  const options = ['Current module', 'Whole workspace']
  const controller = new AbortController()
  f.select('Whole workspace')
  const result = await f.askUser(question, options, controller.signal)
  assert.deepEqual(f.selections, [{ question, options, signal: controller.signal }])
  assert.deepEqual(result.details, { question, options, answer: 'Whole workspace' })
  assert.match(result.content[0].text, /Whole workspace/)
  assert.equal(result.terminate, undefined)
  assert.equal(f.mode(), 'plan')
})

test('a user question holds the other tool calls and duplicate questions in its batch', async () => {
  const f = fixture()
  f.emit('session_start')
  f.emit('message_end', { message: { role: 'assistant', content: [
    { type: 'toolCall', id: 'sibling-write', name: 'write' },
    { type: 'toolCall', id: 'ask', name: 'desktop_ask_user' },
    { type: 'toolCall', id: 'ask-twice', name: 'desktop_ask_user' }
  ] } })
  assert.equal(f.emit('tool_call', { toolCallId: 'ask', toolName: 'desktop_ask_user' }), undefined)
  for (const [toolCallId, toolName] of [['sibling-write', 'write'], ['ask-twice', 'desktop_ask_user']]) {
    const result = f.emit('tool_call', { toolCallId, toolName }) as { block: boolean; terminate: boolean }
    assert.equal(result.block, true)
    assert.equal(result.terminate, true)
  }
  f.emit('turn_end')
  assert.equal(f.emit('tool_call', { toolCallId: 'next-turn', toolName: 'write' }), undefined)
})

test('cancelling a user question settles the turn and pauses an active goal for a human reply', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.modeCommand('goal')
  f.emit('input', { source: 'rpc', text: 'Review the fixture' })
  const question = 'Which scope should I use?'
  const options = ['Review one test', 'Review all tests']
  const result = await f.askUser(question, options)
  assert.deepEqual(result.details, { question, options, answer: null })
  assert.equal(result.terminate, true)
  assert.equal(f.goal()?.status, 'blocked')
  assert.equal(f.goal()?.summary, question)
  assert.equal(f.emit('agent_before_settle', boundary), undefined)
  assert.equal((f.emit('tool_call', { toolCallId: 'retry', toolName: 'desktop_ask_user' }) as { block: boolean }).block, true)
  f.emit('agent_settled', { aborted: false })
  f.emit('input', { source: 'rpc', text: 'Review one test' })
  assert.equal(f.goal()?.status, 'active')
})

test('a user question rejects blank or duplicate choices and cannot answer after abort', async () => {
  const f = fixture()
  f.emit('session_start')
  await assert.rejects(() => f.askUser(' ', ['A', 'B']), /question/i)
  await assert.rejects(() => f.askUser('Which?', ['A', ' A ']), /distinct/i)
  await assert.rejects(() => f.askUser('Which?', ['A', ' ']), /distinct/i)
  assert.deepEqual(f.selections, [])

  const controller = new AbortController()
  const selection = Promise.withResolvers<string>()
  f.select(selection.promise)
  const asking = f.askUser('Which?', ['A', 'B'], controller.signal)
  controller.abort()
  selection.resolve('B')
  const result = await asking
  assert.equal(result.terminate, true)
  assert.equal((result.details as { answer: string | null }).answer, null)
})

test('Plan Mode exposes read tools, questions and plan review, then restores the prior loadout', async () => {
  const f = fixture()
  f.emit('session_start')
  assert.deepEqual(f.active(), [...f.base, ...DESKTOP_TOOLS])
  await f.modeCommand('plan')
  assert.deepEqual(f.active(), PLAN_TOOLS)
  for (const toolName of ['write', 'edit', 'powershell', 'mcp__custom', 'subagent']) {
    assert.equal((f.emit('tool_call', { toolName }) as { block: boolean }).block, true)
  }
  assert.equal(f.emit('tool_call', { toolName: 'read' }), undefined)
  assert.equal(f.emit('tool_call', { toolName: 'exit_plan_mode' }), undefined)
  assert.equal(f.emit('tool_call', { toolName: 'desktop_ask_user' }), undefined)
  await f.modeCommand('default')
  assert.deepEqual(f.active(), [...f.base, ...DESKTOP_TOOLS])
  assert.equal(f.mode(), 'default')
})

test('desktop search and PowerShell defaults survive opening and leaving a saved Plan Mode', async () => {
  const stock = ['read', 'bash', 'edit', 'write']
  const f = fixture([
    { type: 'custom', customType: 'pi-desktop-mode', data: { mode: 'plan', originalTools: stock } }
  ], false, 'default', { active: stock })
  f.emit('session_start')
  assert.deepEqual(f.active(), PLAN_TOOLS)
  const promptGuidelines: string[] = []
  f.emit('before_agent_start', { systemPromptOptions: { selectedTools: f.active(), promptGuidelines } })
  assert.match(promptGuidelines.join('\n'), /find to locate files by glob pattern/)
  assert.doesNotMatch(promptGuidelines.join('\n'), /powershell tool|bash tool/)

  await f.modeCommand('default')
  const shells = process.platform === 'win32' ? ['powershell'] : []
  assert.deepEqual(f.active(), [...stock, 'grep', 'find', 'ls', ...shells, ...DESKTOP_TOOLS])
  promptGuidelines.length = 0
  f.emit('before_agent_start', { systemPromptOptions: { selectedTools: f.active(), promptGuidelines } })
  assert.equal(promptGuidelines.some((line) => line.includes('powershell tool') && line.includes('-Encoding utf8')), shells.length > 0)
})

test('workspace defaults honor an explicit Pi tool selection and skip overrides', () => {
  const stock = ['read', 'bash', 'edit', 'write']
  const explicit = fixture([], false, 'default', { active: stock, defaultTools: stock })
  explicit.emit('session_start')
  assert.deepEqual(explicit.active(), [...stock, ...DESKTOP_TOOLS])

  const custom = fixture([], false, 'default', { active: stock })
  custom.toolSource('grep', 'project')
  custom.emit('session_start')
  assert.ok(custom.active().includes('find'))
  assert.ok(!custom.active().includes('grep'))
})

test('built-in search fixes path glob syntax while keeping file roots and escaped globs', () => {
  const f = fixture()
  const find = { pattern: './src/**/*.ts', path: 'work space' }
  f.emit('tool_call', { toolName: 'find', input: find })
  assert.deepEqual(find, { pattern: 'src/**/*.ts', path: 'work space' })
  find.pattern = './/src/**/*.ts'
  f.emit('tool_call', { toolName: 'find', input: find })
  assert.equal(find.pattern, 'src/**/*.ts')

  const windowsGlob = 'src\\**\\*.ts'
  const grep = { pattern: 'literal[x]', literal: true, glob: windowsGlob }
  f.emit('tool_call', { toolName: 'grep', input: grep })
  assert.deepEqual(grep, { pattern: 'literal[x]', literal: true, glob: process.platform === 'win32' ? 'src/**/*.ts' : windowsGlob })
  const escaped = { pattern: 'test', glob: 'src\\[x\\]\\*.ts' }
  f.emit('tool_call', { toolName: 'grep', input: escaped })
  assert.equal(escaped.glob, 'src\\[x\\]\\*.ts')

  f.toolSource('find', 'project')
  find.pattern = './src/**/*.ts'
  f.emit('tool_call', { toolName: 'find', input: find })
  assert.equal(find.pattern, './src/**/*.ts')
})

test('image options ride on the prompt they were sent with, once', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.command('desktop-image', JSON.stringify({
    prompt: 'a red fox in snow',
    model: 'codex/gpt-image-2',
    size: '1536x1024',
    quality: 'high',
    n: 2
  }))

  const sections: Record<string, string> = {}
  const result = f.emit('before_agent_start', {
    prompt: 'a red fox in snow',
    systemPromptOptions: { sections }
  }) as { message?: { display?: boolean; content?: string } } | undefined
  assert.equal(result?.message, undefined)
  const content = sections['desktop-image'] ?? ''
  assert.match(content, /generate_image exactly once/)
  assert.match(content, /n=2/)
  assert.match(content, /model=codex\/gpt-image-2/)
  assert.match(content, /size=1536x1024/)
  assert.match(content, /quality=high/)
  assert.match(content, /a red fox in snow/)

  // A later prompt must not inherit the image options.
  const laterSections: Record<string, string> = {}
  assert.equal(f.emit('before_agent_start', {
    prompt: 'a red fox in snow',
    systemPromptOptions: { sections: laterSections }
  }), undefined)
  assert.deepEqual(laterSections, {})
})

test('image options include reference guidance and allow generate_image even in Plan Mode', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.modeCommand('plan')
  await f.command('desktop-image', JSON.stringify({
    prompt: 'turn this sketch into a watercolour',
    model: 'codex/gpt-image-2',
    size: '1024x1024',
    quality: 'high',
    n: 1,
    references: 1
  }))

  const sections: Record<string, string> = {}
  const selectedTools = [...PLAN_TOOLS]
  const result = f.emit('before_agent_start', {
    prompt: 'turn this sketch into a watercolour',
    systemPromptOptions: { sections, selectedTools }
  })
  assert.equal(result, undefined, 'an image run in Plan Mode must not inject the read-only plan prompt')
  assert.ok(selectedTools.includes('generate_image'))
  assert.match(sections['desktop-image'] ?? '', /reference image/i)
  assert.equal(f.emit('tool_call', { toolName: 'generate_image' }), undefined)
  assert.equal((f.emit('tool_call', { toolName: 'write' }) as { block: boolean }).block, true)

  f.emit('agent_end')
  assert.equal((f.emit('tool_call', { toolName: 'generate_image' }) as { block: boolean }).block, true)
})

test('image options are discarded when a different prompt starts', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.command('desktop-image', JSON.stringify({ prompt: 'a red fox in snow', n: 1 }))

  const unrelated: Record<string, string> = {}
  assert.equal(f.emit('before_agent_start', {
    prompt: 'unrelated question',
    systemPromptOptions: { sections: unrelated }
  }), undefined)
  assert.deepEqual(unrelated, {})
  const stale: Record<string, string> = {}
  assert.equal(f.emit('before_agent_start', {
    prompt: 'a red fox in snow',
    systemPromptOptions: { sections: stale }
  }), undefined)
  assert.deepEqual(stale, {})
})

test('image options can be cancelled by their matching request id', async () => {
  const f = fixture()
  f.emit('session_start')
  const prompt = 'a red fox in snow'
  await f.command('desktop-image', JSON.stringify({ id: 'first', prompt }))
  await f.command('desktop-image', JSON.stringify({ cancel: 'older' }))

  const active: Record<string, string> = {}
  f.emit('before_agent_start', { prompt, systemPromptOptions: { sections: active } })
  assert.match(active['desktop-image'], /generate_image exactly once/)

  await f.command('desktop-image', JSON.stringify({ id: 'second', prompt }))
  await f.command('desktop-image', JSON.stringify({ cancel: 'second' }))

  const cancelled: Record<string, string> = {}
  f.emit('before_agent_start', { prompt, systemPromptOptions: { sections: cancelled } })
  assert.deepEqual(cancelled, {})
})

test('image options reject malformed requests', async () => {
  const f = fixture()
  f.emit('session_start')
  await assert.rejects(() => f.command('desktop-image', '{not json'))
  await assert.rejects(() => f.command('desktop-image', '{}'))
})

test('Plan Mode hides and blocks tools that shadow its read, question and review tools', async () => {
  const f = fixture()
  f.toolSource('read', 'project')
  f.emit('session_start')
  f.toolSource('exit_plan_mode', 'project')
  f.toolSource('desktop_ask_user', 'project')
  await f.modeCommand('plan')

  assert.deepEqual(f.active(), ['grep', 'find', 'ls'])
  for (const toolName of ['read', 'exit_plan_mode', 'desktop_ask_user']) {
    assert.deepEqual(f.emit('tool_call', { toolName }), {
      block: true,
      reason: 'Plan Mode only allows read-only file tools, user questions, and exit_plan_mode',
      terminate: true
    })
  }
})

test('memory records an executed extension that overrides a local built-in tool', () => {
  const f = fixture()
  f.emit('session_start')
  f.emit('tool_result', { toolName: 'read' })
  assert.equal(f.entries.some((entry) => entry.customType === EXTERNAL_TOOL_OVERRIDE_ENTRY), false)

  f.toolSource('read', 'project')
  f.emit('tool_result', { toolName: 'read' })
  f.emit('tool_result', { toolName: 'read' })

  const markers = f.entries.filter((entry) => entry.customType === EXTERNAL_TOOL_OVERRIDE_ENTRY)
  assert.equal(markers.length, 2)
  assert.ok(markers.every((entry) => (entry.data as { toolName?: string }).toolName === 'read'))

  f.emit('agent_end')
  assert.deepEqual(f.entries.at(-1)?.data, { toolNames: ['read'] })
})

test('memory records an executed extension that overrides a Pi Desktop tool', () => {
  const f = fixture()
  f.emit('session_start')
  f.toolSource('desktop_todo', 'project')
  f.emit('tool_result', { toolName: 'desktop_todo' })
  f.emit('agent_end')

  assert.ok(f.entries.some((entry) => entry.customType === EXTERNAL_CONTEXT_ENTRY))
  assert.ok(f.entries.some((entry) =>
    entry.customType === EXTERNAL_TOOL_OVERRIDE_ENTRY &&
    (entry.data as { toolName?: string }).toolName === 'desktop_todo'
  ))

  const resumed = fixture([
    { type: 'message', customType: '', data: null, message: { role: 'user', content: 'Review this request.' } },
    {
      type: 'message', customType: '', data: null,
      message: { role: 'assistant', content: [{ type: 'toolCall', name: 'desktop_todo' }] }
    }
  ])
  resumed.toolSource('desktop_todo', 'project')
  resumed.emit('session_start')
  assert.equal(resumed.entries.at(-1)?.customType, EXTERNAL_CONTEXT_ENTRY)
})

test('memory keeps external tool use classified across later turns', () => {
  const first = fixture()
  first.emit('session_start')
  first.entries.push({ type: 'message', customType: '', data: null, message: { role: 'user', content: 'Use the connected tools.' } })
  first.emit('tool_result', { toolName: 'desktop_todo' })
  assert.equal(first.entries.some((entry) => entry.customType === EXTERNAL_CONTEXT_ENTRY), false)
  first.emit('tool_result', { toolName: 'mcp__custom' })
  first.emit('agent_end')
  assert.ok(first.entries.some((entry) => entry.customType === EXTERNAL_CONTEXT_ENTRY))

  const resumed = fixture(first.entries)
  resumed.emit('session_start')
  resumed.emit('agent_end')
  const markers = resumed.entries.filter((entry) => entry.customType === EXTERNAL_CONTEXT_ENTRY)
  assert.equal(markers.length, 4)
})

test('memory classifies legacy active branches when Pi resumes them', () => {
  const external = fixture([
    { type: 'message', customType: '', data: null, message: { role: 'user', content: 'Review this request.' } },
    {
      type: 'message', customType: '', data: null,
      message: { role: 'assistant', content: [{ type: 'toolCall', name: 'mcp__custom' }] }
    }
  ])
  external.emit('session_start')
  assert.equal(external.entries.at(-1)?.customType, EXTERNAL_CONTEXT_ENTRY)

  const local = fixture([
    { type: 'message', customType: '', data: null, message: { role: 'user', content: 'Review this request.' } },
    {
      type: 'message', customType: '', data: null,
      message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read' }] }
    }
  ])
  local.emit('session_start')
  assert.equal(local.entries.at(-1)?.customType, EXTERNAL_CONTEXT_UNKNOWN_ENTRY)
  local.emit('agent_end')
  assert.equal(local.entries.at(-1)?.customType, EXTERNAL_CONTEXT_UNKNOWN_ENTRY)

  const reopened = fixture([...local.entries])
  reopened.emit('session_start')
  assert.equal(reopened.entries.at(-1)?.customType, EXTERNAL_CONTEXT_UNKNOWN_ENTRY)

  const checked = fixture([
    { type: 'message', customType: '', data: null, message: { role: 'user', content: 'Review this request.' } },
    {
      type: 'message', customType: '', data: null,
      message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read' }] }
    },
    {
      type: 'custom', customType: EXTERNAL_CONTEXT_CHECKED_ENTRY,
      data: { version: EXTERNAL_CONTEXT_CLASSIFICATION_VERSION }
    }
  ])
  checked.emit('session_start')
  assert.equal(checked.entries.at(-1)?.customType, EXTERNAL_CONTEXT_CHECKED_ENTRY)
  assert.deepEqual(checked.entries.at(-1)?.data, { version: EXTERNAL_CONTEXT_CLASSIFICATION_VERSION })

  const current = fixture()
  current.emit('session_start')
  current.entries.push({
    type: 'message', customType: '', data: null,
    message: { role: 'user', content: 'Inspect the local configuration.' }
  })
  current.emit('tool_result', { toolName: 'read' })
  current.emit('agent_end')
  assert.equal(current.entries.at(-1)?.customType, EXTERNAL_CONTEXT_CHECKED_ENTRY)
  assert.deepEqual(current.entries.at(-1)?.data, { version: EXTERNAL_CONTEXT_CLASSIFICATION_VERSION })

  const overridden = fixture([
    { type: 'message', customType: '', data: null, message: { role: 'user', content: 'Review this request.' } },
    {
      type: 'message', customType: '', data: null,
      message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read' }] }
    }
  ])
  overridden.toolSource('read', 'project')
  overridden.emit('session_start')
  assert.equal(overridden.entries.at(-1)?.customType, EXTERNAL_CONTEXT_ENTRY)
})

test('exit_plan_mode asks for approval and leaves Plan Mode only when the plan is approved', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.modeCommand('plan')
  f.confirm(true)
  const approved = await f.exitPlan('1. Edit the file\n2. Run the tests')
  assert.equal(approved.content[0].text, 'The user approved this plan. Start implementation now, following the reviewed plan.')
  assert.equal(approved.terminate, undefined)
  assert.deepEqual(f.confirms.at(-1), { title: 'Plan ready to review', message: '1. Edit the file\n2. Run the tests' })
  assert.equal(f.mode(), 'default')
  assert.deepEqual(f.active(), [...f.base, ...DESKTOP_TOOLS])
  assert.equal((f.entries.at(-1)!.data as { mode: string }).mode, 'default')

  const rejected = fixture()
  rejected.emit('session_start')
  await rejected.modeCommand('plan')
  rejected.confirm(false)
  const answer = await rejected.exitPlan('The plan')
  assert.match(answer.content[0].text, /keep planning/i)
  assert.equal(answer.terminate, true)
  assert.equal(rejected.mode(), 'plan')
  assert.deepEqual(rejected.active(), PLAN_TOOLS)

  const cancelled = fixture()
  cancelled.emit('session_start')
  await cancelled.modeCommand('plan')
  cancelled.confirm(undefined)
  const cancelledAnswer = await cancelled.exitPlan('The plan')
  assert.match(cancelledAnswer.content[0].text, /keep planning/i)
  assert.equal(cancelledAnswer.terminate, true)
  assert.equal(cancelled.mode(), 'plan')
})

test('one review is shown at a time, and declining waits for the next user prompt', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.modeCommand('plan')
  const confirmation = Promise.withResolvers<boolean>()
  f.confirm(confirmation.promise)
  const review = f.exitPlan('First proposal')
  const duplicate = f.exitPlan('Second proposal in the same batch')
  assert.equal(f.confirms.length, 1)

  confirmation.resolve(false)
  assert.equal((await review).terminate, true)
  assert.equal((await duplicate).terminate, true)
  const blocked = f.emit('tool_call', { toolName: 'read' }) as { terminate?: boolean }
  assert.equal(blocked.terminate, true)
  f.emit('input', { source: 'extension', text: 'Background status' })
  await f.exitPlan('Automatic resubmission')
  assert.equal(f.confirms.length, 1)

  f.emit('input', { source: 'rpc', text: 'Please revise the proposal' })
  f.confirm(true)
  assert.deepEqual((await f.exitPlan('Revised proposal')).details, { approved: true })
  assert.equal(f.confirms.length, 2)
  assert.equal(f.mode(), 'default')
})

test('an aborted review stays in Plan Mode even when approval arrives late', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.modeCommand('plan')
  const controller = new AbortController()
  const confirmation = Promise.withResolvers<boolean>()
  f.confirm(confirmation.promise)
  const review = f.exitPlan('Proposal to cancel', controller.signal)
  controller.abort()
  confirmation.resolve(true)

  assert.equal(f.confirms[0]?.signal, controller.signal)
  assert.equal((await review).terminate, true)
  assert.equal(f.mode(), 'plan')
  assert.deepEqual(f.active(), PLAN_TOOLS)
})

test('a blank plan cannot open the approval dialog', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.modeCommand('plan')
  await assert.rejects(() => f.exitPlan('  \n\t '), /plan text/i)
  assert.deepEqual(f.confirms, [])
})

test('Plan Mode sends only the newest planning guidance to the model', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.modeCommand('plan')
  const previous = { customType: 'desktop-plan-context', content: 'Earlier planning guidance' }
  const current = { customType: 'desktop-plan-context', content: 'Current planning guidance' }
  const prompt = { role: 'user', content: 'Please revise the plan.' }
  const messages = [previous, prompt, current]
  assert.deepEqual(f.emit('context', { messages }), { messages: [prompt, current] })
  await f.exitPlan('Approved plan')
  assert.deepEqual(f.emit('context', { messages }), { messages: [prompt] })
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
  f.emit('turn_end', { toolResults: [{ isError: false, content: [] }] })
  const next = f.emit('agent_before_settle', boundary) as { continue: boolean; entries: { display: boolean; content: string }[] }
  assert.equal(next.continue, true)
  assert.equal(next.entries[0].display, false)
  assert.match(next.entries[0].content, /Continue toward the active goal/)
  assert.doesNotMatch(next.entries[0].content, /Finish and verify the task/)
  assert.equal(f.emit('agent_before_settle', { ...boundary, continue: true }), undefined)
  const outcome = await f.finish('complete')
  assert.equal(f.goal()?.status, 'complete')
  assert.equal(f.mode(), 'default')
  // An outcome ends the turn: no request follows the report, so the model
  // cannot keep talking about work it has just declared finished.
  assert.equal(outcome.terminate, true, 'the finish report did not end the turn')
  assert.equal(f.emit('agent_before_settle', boundary), undefined)
  // The finished goal stays on screen, but an ordinary follow-up no longer
  // becomes a new goal just because Goal Mode was used earlier.
  f.emit('input', { source: 'rpc', text: 'An ordinary follow-up' })
  assert.equal(f.goal()?.status, 'complete')
  assert.equal(f.mode(), 'default')
})

test('Goal Mode stops instead of repeating a round that made no tool calls', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.modeCommand('goal')
  f.emit('input', { source: 'rpc', text: 'Investigate the failure' })
  // The model only wrote prose: it gets one explicit chance to report the
  // outcome, and a second prose-only round ends the goal instead of looping.
  f.emit('turn_end', { toolResults: [] })
  const grace = f.emit('agent_before_settle', boundary) as {
    continue: boolean
    entries: { content: string }[]
  }
  assert.equal(grace.continue, true)
  assert.match(grace.entries[0].content, /call desktop_goal_finish with status complete now/)
  f.emit('turn_end', { toolResults: [] })
  assert.equal(f.emit('agent_before_settle', boundary), undefined)
  assert.equal(f.goal()?.status, 'blocked')
  assert.match(f.goal()?.summary ?? '', /no progress with tools/i)

  await f.command('desktop-goal', 'resume')
  assert.equal(f.goal()?.status, 'active')
  assert.equal(f.sentMessages.at(-1)?.message.customType, 'desktop-goal-continue')
  assert.equal(f.sentMessages.at(-1)?.message.display, false)
  assert.equal(f.sentMessages.at(-1)?.options?.triggerTurn, true)
  assert.match(f.sentMessages.at(-1)?.message.content ?? '', /Continue toward the active goal/)
  assert.deepEqual(f.sent, [])
})

test('Goal Mode tolerates a turn boundary without tool results', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.modeCommand('goal')
  f.emit('input', { source: 'rpc', text: 'Investigate the failure' })
  // An older or retried event may carry no results at all; that is an empty
  // round, not a reason for the extension to throw.
  assert.doesNotThrow(() => f.emit('turn_end', {}))
  assert.equal(f.goal()?.status, 'active')
})

test('Goal Mode sends the current objective on every request, including after a running edit', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.modeCommand('goal')
  f.emit('input', { source: 'rpc', text: 'A long goal' })
  const messages = [
    { role: 'user', content: 'A long goal' },
    { role: 'custom', customType: 'desktop-goal-context', content: 'Goal: A long goal' },
    { role: 'custom', customType: 'desktop-goal-continue', content: 'Previous continuation' },
    { role: 'custom', customType: 'desktop-goal-context', content: 'Goal: A long goal' },
    { role: 'custom', customType: 'desktop-goal-continue', content: 'Current continuation' }
  ]
  f.emit('context', { messages })
  f.idle(false)
  await f.command('desktop-goal', 'edit Verify  both branches\n  Keep the tests')
  await assert.rejects(f.finish('complete'), /goal was edited/i)
  const result = f.emit('context', { messages }) as { messages: typeof messages }
  const goals = result.messages.filter((message) => message.customType === 'desktop-goal-context')
  assert.equal(goals.length, 1)
  assert.ok(goals[0].content.endsWith('Verify  both branches\n  Keep the tests'))
  assert.deepEqual(result.messages.filter((message) => message.customType === 'desktop-goal-continue'), [messages[4]])
  assert.equal(messages[1].content, 'Goal: A long goal', 'the saved history is untouched')

  const fresh = f.emit('context', { messages: [messages[0]] }) as { messages: typeof messages }
  assert.equal(fresh.messages.at(-1)?.content, goals[0].content)

  await f.command('desktop-goal', 'pause')
  const paused = f.emit('context', { messages }) as { messages: typeof messages }
  assert.deepEqual(paused.messages, [messages[0]])
})

test('the automatic continuation limit includes the rounds that ask the model to report its outcome', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.modeCommand('goal')
  f.emit('input', { source: 'rpc', text: 'A very long running goal' })
  const worked = { toolResults: [{ toolName: 'read', isError: false, content: [] }] }
  for (let round = 0; round < 40; round += 1) {
    f.emit('turn_end', round % 2 ? worked : { toolResults: [] })
    const next = f.emit('agent_before_settle', boundary) as { continue: boolean } | undefined
    assert.equal(next?.continue, true)
  }
  f.emit('turn_end', { toolResults: [] })
  assert.equal(f.emit('agent_before_settle', boundary), undefined)
  assert.equal(f.goal()?.status, 'blocked')
  assert.match(f.goal()?.summary ?? '', /continuation limit/i)
})

test('failed tools and checklist updates do not extend automatic continuation on their own', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.modeCommand('goal')
  f.emit('input', { source: 'rpc', text: 'Verify the changes' })
  const noProgress = { toolResults: [
    { toolName: 'read', isError: true, content: [{ type: 'text', text: 'File was not found' }] },
    { toolName: 'desktop_todo', isError: false, content: [] }
  ] }
  f.emit('turn_end', noProgress)
  assert.ok(f.emit('agent_before_settle', boundary))
  f.emit('turn_end', noProgress)
  assert.equal(f.emit('agent_before_settle', boundary), undefined)
  assert.equal(f.goal()?.status, 'blocked')
  assert.match(f.goal()?.summary ?? '', /no progress with tools/i)
})

test('the user can complete a goal without waiting for the model', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.modeCommand('goal')
  f.emit('input', { source: 'rpc', text: 'Ship the feature' })
  f.idle(false)
  await f.command('desktop-goal', 'complete')
  assert.equal(f.aborts(), 1)
  assert.equal(f.goal()?.status, 'complete')
  assert.equal(f.goal()?.summary, 'Completed by the user')
  assert.equal(f.mode(), 'default')
  assert.equal(f.emit('agent_before_settle', boundary), undefined)

  const g = fixture()
  g.emit('session_start')
  await g.modeCommand('goal')
  g.emit('input', { source: 'rpc', text: 'Another goal' })
  await g.command('goal', 'complete')
  assert.equal(g.goal()?.status, 'complete')
  assert.equal(g.mode(), 'default')
})

test('pausing or completing a retained goal leaves unrelated runs alone', async () => {
  for (const action of ['pause', 'complete']) {
    const f = fixture()
    f.emit('session_start')
    await f.command('goal', 'Review the implementation')
    await f.modeCommand('plan')
    f.idle(false)
    await f.command('desktop-goal', action)
    assert.equal(f.aborts(), 0)
    assert.equal(f.mode(), 'plan')
  }
})

test('clearing a retained goal preserves Plan Mode and its read-only tools', async () => {
  for (const [command, action] of [['desktop-goal', 'clear'], ['goal', 'off']]) {
    const f = fixture()
    f.emit('session_start')
    await f.command('goal', 'Review the implementation')
    await f.modeCommand('plan')
    const planTools = f.active()
    await f.command(command, action)
    assert.equal(f.goal(), undefined)
    assert.equal(f.mode(), 'plan')
    assert.deepEqual(f.active(), planTools)
  }
})

test('Goal Mode keeps one objective across active, paused and blocked messages', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.modeCommand('goal')
  f.emit('input', { source: 'rpc', text: 'Ship the feature' })
  // A later message is conversation the model already sees, not a new line of
  // the goal: folding it in would grow the objective on every turn.
  const persisted = f.entries.length
  f.emit('input', { source: 'rpc', text: 'Start with the API layer' })
  assert.equal(f.goal()?.text, 'Ship the feature')
  assert.equal(f.goal()?.status, 'active')
  assert.equal(f.entries.length, persisted, 'an unchanged goal is not persisted again')

  await f.command('desktop-goal', 'pause')

  f.emit('input', { source: 'rpc', text: 'What does this error mean?' })
  assert.equal(f.goal()?.text, 'Ship the feature')
  assert.equal(f.goal()?.status, 'paused')

  await f.command('desktop-goal', 'resume')
  f.emit('agent_settled', { aborted: true })
  assert.equal(f.goal()?.status, 'blocked')

  f.emit('input', { source: 'rpc', text: 'Try again with the other provider' })
  assert.equal(f.goal()?.text, 'Ship the feature')
  assert.equal(f.goal()?.status, 'active')
  assert.equal(f.goal()?.summary, undefined)
})

test('pausing a running goal stops the current run', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.modeCommand('goal')
  f.emit('input', { source: 'rpc', text: 'Ship it' })
  f.idle(false)
  await f.command('desktop-goal', 'pause')
  assert.equal(f.goal()?.status, 'paused')
  assert.equal(f.aborts(), 1)

  f.idle(true)
  await f.command('desktop-goal', 'pause')
  assert.equal(f.aborts(), 1)
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
  assert.equal(f.sentMessages.at(-1)?.message.customType, 'desktop-goal-continue')
  assert.match(f.sentMessages.at(-1)?.message.content ?? '', /Continue toward the active goal/)

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
  assert.deepEqual(f.active(), [...f.base, ...DESKTOP_TOOLS, 'computer'])
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
  assert.deepEqual(f.active(), [...f.base, ...DESKTOP_TOOLS, 'computer'])
})

test('the edit command persists the new leaf of the same conversation', async () => {
  const f = fixture([{ type: 'message', id: 'entry-1', customType: '', data: undefined, message: { role: 'user' } }])
  f.emit('session_start')
  const entryCount = f.entries.length
  await assert.rejects(f.command('desktop-rewind', 'another-branch'), /active branch/)
  assert.equal(f.entries.length, entryCount)

  // A cancelled navigation leaves the branch where it found it. The marker
  // that remembers the old leaf stays behind, so the session still ends on the
  // branch it started from.
  const navigate = f.ctx.navigateTree
  f.ctx.navigateTree = async (targetId, options) => {
    f.navigations.push({ targetId, options })
    return { cancelled: true }
  }
  await assert.rejects(f.command('desktop-rewind', 'entry-1'), /cancelled/)
  assert.equal(f.entries.length, entryCount + 1)
  assert.equal(f.entries.at(-1)?.customType, 'pi-desktop-rewind-source')
  assert.equal(f.navigations.at(-1)?.targetId, f.entries.at(-1)?.id)
  f.ctx.navigateTree = navigate
  assert.equal(f.ctx.sessionManager.getLeafId(), f.entries.at(-1)?.id)
  const leaf = f.ctx.sessionManager.getLeafId
  f.ctx.sessionManager.getLeafId = () => 'entry-1'
  await assert.rejects(f.command('desktop-rewind', 'entry-1'), /move before this message/)
  f.ctx.sessionManager.getLeafId = leaf

  await f.command('desktop-rewind', 'entry-1')
  const rewindMarker = f.entries.at(-1)
  // Navigation only moves Pi's in-memory leaf, so the command writes a child
  // of the new leaf 閳?and one of the branch it left, for the undo to find.
  assert.equal(rewindMarker?.customType, 'pi-desktop-rewind')
  assert.deepEqual(f.navigations.at(-1), { targetId: 'entry-1', options: { summarize: false } })
  const rewindSource = f.entries.at(-2)
  assert.equal(rewindSource?.customType, 'pi-desktop-rewind-source')
  assert.deepEqual(rewindMarker?.data, { previousLeafId: rewindSource?.id })
  assert.equal(f.ctx.sessionManager.getLeafId(), rewindMarker?.id)
})

test('undoing an edit returns to the branch it hid', async () => {
  const entries: Entry[] = [
    { type: 'message', id: 'entry-1', parentId: null, customType: '', data: undefined, message: { role: 'user', content: 'Plan the release' } },
    { type: 'message', id: 'entry-2', parentId: 'entry-1', customType: '', data: undefined, message: { role: 'assistant', content: 'Here is the plan' } },
    { type: 'message', id: 'entry-3', parentId: 'entry-2', customType: '', data: undefined, message: { role: 'user', content: 'Now ship it' } },
    { type: 'message', id: 'entry-4', parentId: 'entry-3', customType: '', data: undefined, message: { role: 'assistant', content: 'Shipping' } }
  ]
  const f = fixture(entries)
  f.emit('session_start')
  const manager = f.ctx.sessionManager
  manager.getBranch = () => {
    const branch: Entry[] = []
    for (let id = manager.getLeafId(); id;) {
      const entry = manager.getEntry(id)
      if (!entry) break
      branch.push(entry)
      id = entry.parentId ?? null
    }
    return branch.reverse()
  }
  // The conversation stands on its last answer when the reader edits entry-1.
  await f.ctx.navigateTree('entry-4')
  await f.command('desktop-rewind', 'entry-1')
  assert.equal(f.ctx.sessionManager.getLeafId(), f.entries.at(-1)?.id)
  assert.equal(f.entries.at(-1)?.customType, 'pi-desktop-rewind')

  const source = f.entries.find((entry) => entry.customType === 'pi-desktop-rewind-source')
  assert.ok(source)
  assert.equal(manager.getBranch().includes(source), false)
  await f.command('desktop-undo-rewind', '')
  assert.deepEqual(f.navigations.at(-1), { targetId: source?.id, options: { summarize: false } })
  // The restored branch ends on the marker that records the return, and its
  // parent chain runs through the branch the edit had hidden.
  const undoMarker = f.entries.at(-1)
  assert.equal(undoMarker?.customType, 'pi-desktop-undo-rewind')
  assert.equal(undoMarker?.parentId, source?.id)
  assert.equal(source?.parentId, 'entry-4')
  assert.equal(f.ctx.sessionManager.getLeafId(), undoMarker?.id)
})

test('an edit cannot be undone once the conversation has moved on', async () => {
  const f = fixture([
    { type: 'message', id: 'entry-1', parentId: null, customType: '', data: undefined, message: { role: 'user' } },
    { type: 'message', id: 'entry-2', parentId: 'entry-1', customType: '', data: undefined, message: { role: 'assistant' } }
  ])
  f.emit('session_start')
  await f.command('desktop-rewind', 'entry-1')
  // Anything appended after the edit means a return would drop it.
  await f.modeCommand('goal')
  await assert.rejects(f.command('desktop-undo-rewind', ''), /moved on since the edit/)
})

test('undo refuses without an edit to undo, and while a turn is running', async () => {
  const f = fixture()
  f.emit('session_start')
  await assert.rejects(f.command('desktop-undo-rewind', ''), /nothing to undo/)
  f.idle(false)
  await assert.rejects(f.command('desktop-undo-rewind', ''), /Wait for the current turn/)
})

test('rewinding restores the selected branch goal and tool restrictions without appending state', async () => {
  const goal = { text: 'Investigate the original issue', status: 'blocked', summary: 'Waiting for input' }
  const branch: Entry[] = [{
    type: 'custom', customType: 'pi-desktop-mode',
    data: { mode: 'plan', goal, originalTools: ['read', 'write', 'edit', 'powershell'] }
  }]
  const f = fixture(branch)
  f.emit('session_start')
  const originalTools = f.active()
  await f.command('goal', 'Follow the later objective')
  assert.equal(f.goal()?.text, 'Follow the later objective')

  branch.splice(1)
  f.emit('session_tree', { type: 'session_tree' })
  assert.deepEqual(f.goal(), goal)
  assert.equal(f.mode(), 'plan')
  assert.deepEqual(f.active(), originalTools)
  assert.equal(branch.length, 1)

  branch.length = 0
  f.emit('session_tree', { type: 'session_tree' })
  assert.equal(f.goal(), undefined)
  assert.equal(f.mode(), 'default')
  assert.ok(f.active().includes('write'))
  assert.deepEqual(branch, [])
})

test('delegation is available in every working mode and stays out of the saved tool baseline', async () => {
  const f = fixture()
  f.emit('session_start')
  for (const mode of AGENT_MODES) {
    await f.modeCommand(mode)
    assert.equal(f.active().includes('subagent'), mode !== 'plan', mode)
    if (mode === 'plan') {
      assert.deepEqual(f.active(), PLAN_TOOLS)
      assert.equal((f.emit('tool_call', { toolName: 'subagent' }) as { block: boolean }).block, true)
    }
    if (mode !== 'default') {
      const saved = f.entries.at(-1)?.data as { originalTools?: string[] }
      assert.deepEqual(saved.originalTools, f.base, mode)
    }
  }
  await assert.rejects(f.modeCommand('subagent'), /Unknown task mode/)
})

test('a legacy Subagent Mode session resumes in Default without stale delegation instructions', () => {
  const f = fixture([{ type: 'custom', customType: 'pi-desktop-mode', data: {
    mode: 'subagent', originalTools: ['read', 'write']
  } }], false, 'plan')
  f.emit('session_start')
  assert.equal(f.mode(), 'default')
  assert.deepEqual(f.active(), ['read', 'write', ...DESKTOP_TOOLS])
  const user = { role: 'user', content: 'Continue the conversation' }
  const messages = [user, { role: 'custom', customType: 'desktop-subagent-context', content: 'Delegate all work' }]
  assert.deepEqual(f.emit('context', { messages }), { messages: [user] })
})

test('restoring a saved working mode removes the managed subagent tool from its baseline', () => {
  const f = fixture([{ type: 'custom', customType: 'pi-desktop-mode', data: {
    mode: 'goal', originalTools: ['read', 'subagent', 'write']
  } }])
  f.emit('session_start')
  assert.deepEqual(f.active(), ['read', 'write', 'desktop_goal_finish', ...DESKTOP_TOOLS])
  assert.deepEqual((f.entries.at(-1)?.data as { originalTools: string[] }).originalTools, ['read', 'write'])
})

test('Plugin Mode keeps the working tools and adds the extension-authoring instruction', async () => {
  const f = fixture()
  f.emit('session_start')
  await f.modeCommand('plugin')
  assert.equal(f.mode(), 'plugin')
  assert.deepEqual(f.active(), [...f.base, ...DESKTOP_TOOLS])
  const next = f.emit('before_agent_start') as { message: { customType: string; content: string } }
  assert.equal(next.message.customType, 'desktop-plugin-context')
  assert.match(next.message.content, /extension/i)
  assert.match(next.message.content, /\.pi\/agent\/extensions/)
  await f.modeCommand('default')
  assert.equal(f.mode(), 'default')

  // `/plugin <text>` enters the mode and sends the request in one step.
  const g = fixture()
  g.emit('session_start')
  await g.command('plugin', 'Add a /hello command extension')
  assert.equal(g.mode(), 'plugin')
  assert.deepEqual(g.sent, ['Add a /hello command extension'])
})

test('desktop_todo records the checklist and is never offered in Plan Mode', async () => {
  const f = fixture()
  f.emit('session_start')
  const result = await f.todo([
    { text: 'Read the requirements', status: 'completed' },
    { text: 'Implement the change', status: 'in_progress' },
    { text: 'Run the tests', status: 'pending' }
  ])
  const text = result.content[0].text
  assert.match(text, /Todo \(1\/3\)/)
  assert.match(text, /- \[x\] Read the requirements/)
  assert.match(text, /- \[ \] Implement the change \(in progress\)/)
  assert.match(text, /- \[ \] Run the tests/)

  await f.modeCommand('plan')
  assert.equal(f.active().includes('desktop_todo'), false)
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
  assert.deepEqual(resumed.active(), PLAN_TOOLS)
  resumed.entries.length = 0
  resumed.emit('session_start', { reason: 'new' })
  assert.equal(resumed.mode(), 'default')
  assert.deepEqual(resumed.active(), [...resumed.base, ...DESKTOP_TOOLS])
})

test('a seeded Plan Mode starts a new conversation read-only and writes the mode down', () => {
  const f = fixture([], false, 'plan')
  f.emit('session_start')
  assert.equal(f.mode(), 'plan')
  assert.deepEqual(f.active(), PLAN_TOOLS)
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
  assert.deepEqual(f.active(), [...f.base, ...DESKTOP_TOOLS])
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
  assert.deepEqual(reopened.active(), PLAN_TOOLS)
})

test('the default seed leaves a new conversation in Default Mode with its original tools', () => {
  const f = fixture()
  f.emit('session_start')
  assert.equal(f.mode(), 'default')
  assert.deepEqual(f.active(), [...f.base, ...DESKTOP_TOOLS])
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

test('every mode carries the visible step-commentary guideline without duplicating it', async () => {
  const f = fixture()
  f.emit('session_start')
  assert.ok(f.toolGuidelines('desktop_todo').includes(PROGRESS_COMMENTARY_GUIDELINE))
  assert.ok(f.toolGuidelines('exit_plan_mode').includes(PROGRESS_COMMENTARY_GUIDELINE))

  const promptGuidelines: string[] = []
  assert.equal(f.emit('before_agent_start', { systemPromptOptions: { promptGuidelines } }), undefined)
  assert.deepEqual(promptGuidelines, [PROGRESS_COMMENTARY_GUIDELINE])

  await f.modeCommand('plan')
  const planEvent = f.emit('before_agent_start', { systemPromptOptions: { promptGuidelines } }) as {
    message: { customType: string }
  }
  assert.equal(planEvent.message.customType, 'desktop-plan-context')
  assert.deepEqual(promptGuidelines, [PROGRESS_COMMENTARY_GUIDELINE])
})



