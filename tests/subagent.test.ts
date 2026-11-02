import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { subagentExtension } from '../src/main/pi/subagent'

type ToolResult = {
  content: { type: string; text: string }[]
  details?: {
    mode: 'single' | 'parallel'
    results: {
      task: string
      cwd: string
      exitCode: number
      output: string
      stderr: string
      aborted: boolean
      status: 'queued' | 'running' | 'completed' | 'failed' | 'aborted'
      activity?: string
      toolName?: string
      startedAt?: number
      finishedAt?: number
      usage: { turns: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens: number }
    }[]
  }
  isError?: boolean
}
type Update = { content: { type: string; text: string }[]; details?: ToolResult['details'] }
type Tool = {
  name: string
  defaultActive?: boolean
  annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean; openWorldHint?: boolean }
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: Update) => void) | undefined,
    ctx: { cwd: string; model?: { provider: string; id: string }; thinkingLevel?: string }
  ) => Promise<ToolResult>
}

// The generated extension imports typebox, so it has to live inside the
// project tree where Node can resolve the dependency.
const dir = mkdtempSync(path.join(process.cwd(), '.tmp-subagent-test-'))
const fakeScript = path.join(dir, 'fake-pi.mjs')
const extensionFile = path.join(dir, 'subagent-extension.mjs')
const logFile = path.join(dir, 'args.jsonl')

writeFileSync(
  fakeScript,
  `import { appendFileSync } from 'node:fs';
const log = process.env.PI_FAKE_LOG;
if (log) appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n');
const mode = process.env.PI_FAKE_MODE || 'ok';
if (mode === 'fail') {
  process.stderr.write('boom from fake pi\\n');
  process.exit(3);
}
if (mode === 'slow') {
  setTimeout(() => {}, 60000);
} else {
  if (mode === 'progress') {
    for (const event of [
      { type: 'message_start', message: { role: 'assistant' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'PRIVATE_REASONING_SHOULD_NOT_LEAK' } },
      { type: 'tool_execution_start', toolCallId: 'read', toolName: 'read' },
      { type: 'tool_execution_end', toolCallId: 'read', toolName: 'read' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_start' } }
    ]) process.stdout.write(JSON.stringify(event) + '\\n');
  }
  const text = mode === 'cwd' ? process.cwd() : process.env.PI_FAKE_TEXT || 'done';
  process.stdout.write(JSON.stringify({ type: 'session', version: 3, id: 'fake' }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 17, cost: { total: 0.25 } },
      model: 'test/model',
      stopReason: 'stop'
    }
  }) + '\\n');
}
`,
  'utf8'
)
writeFileSync(extensionFile, subagentExtension(), 'utf8')

after(() => rmSync(dir, { recursive: true, force: true }))

async function loadFactory(): Promise<(pi: { registerTool: (tool: Tool) => void }) => void> {
  const module = (await import(pathToFileURL(extensionFile).href)) as {
    default: (pi: { registerTool: (tool: Tool) => void }) => void
  }
  return module.default
}

function createApi(factory: (pi: { registerTool: (tool: Tool) => void }) => void): { tool: Tool; updates: Update[] } {
  let tool: Tool | undefined
  const updates: Update[] = []
  factory({ registerTool: (definition) => { tool = definition } })
  assert.ok(tool, 'extension did not register a tool')
  return { tool, updates }
}

type FakeOptions = {
  mode?: 'ok' | 'fail' | 'slow' | 'cwd' | 'progress'
  text?: string
  onUpdate?: (update: Update) => void
}

function withFakePi<T>(options: FakeOptions, run: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
  const previousArgv = process.argv[1]
  const previousLog = process.env.PI_FAKE_LOG
  const previousMode = process.env.PI_FAKE_MODE
  const previousText = process.env.PI_FAKE_TEXT
  process.argv[1] = fakeScript
  process.env.PI_FAKE_LOG = logFile
  process.env.PI_FAKE_MODE = options.mode ?? 'ok'
  process.env.PI_FAKE_TEXT = options.text ?? 'done'
  const restore = (): void => {
    process.argv[1] = previousArgv
    if (previousLog === undefined) delete process.env.PI_FAKE_LOG
    else process.env.PI_FAKE_LOG = previousLog
    if (previousMode === undefined) delete process.env.PI_FAKE_MODE
    else process.env.PI_FAKE_MODE = previousMode
    if (previousText === undefined) delete process.env.PI_FAKE_TEXT
    else process.env.PI_FAKE_TEXT = previousText
  }
  return run(undefined).finally(restore)
}

function readArgs(): string[][] {
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[])
}

function resetArgs(): void {
  writeFileSync(logFile, '', 'utf8')
}

test('the subagent tool is registered as an active destructive tool', async () => {
  const factory = await loadFactory()
  const { tool } = createApi(factory)
  assert.equal(tool.name, 'subagent')
  assert.equal(tool.defaultActive, true)
  assert.deepEqual(tool.annotations, { destructiveHint: true, readOnlyHint: false, openWorldHint: true })
})

test('a single task spawns Pi in JSON mode and collects its text, usage and details', async () => {
  resetArgs()
  const factory = await loadFactory()
  const { tool, updates } = createApi(factory)
  const text = 'first line\u2028second line\u2029done'
  const result = await withFakePi({ text }, () =>
    tool.execute('call-1', { task: 'Inspect the repo', model: 'openai/gpt', thinking: 'high', tools: ['read', 'grep'] }, undefined, (update) => updates.push(update), { cwd: process.cwd() })
  )
  assert.equal(result.isError, false)
  assert.equal(result.content[0].text, text)
  assert.equal(result.details?.mode, 'single')
  assert.equal(result.details?.results.length, 1)
  const single = result.details!.results[0]
  assert.equal(single.exitCode, 0)
  assert.equal(single.output, text)
  assert.equal(single.stderr, '')
  assert.deepEqual(single.usage, { turns: 1, input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.25, contextTokens: 17 })
  assert.equal(updates[0].details?.results[0].status, 'running')
  assert.equal(updates[0].details?.results[0].output, '', 'publish before the first model response')
  assert.equal(updates.at(-1)?.details?.results[0].status, 'completed')
  assert.equal(single.status, 'completed')
  assert.ok(single.finishedAt! >= single.startedAt!)

  const args = readArgs()[0]
  assert.deepEqual(args.slice(0, 5), ['--mode', 'json', '-p', '--no-session', '--no-approve'])
  assert.deepEqual(args.slice(5, 11), ['--model', 'openai/gpt', '--thinking', 'high', '--tools', 'read,grep'])
  assert.equal(args[11], '--append-system-prompt')
  assert.ok(args[12].length > 0)
  assert.equal(args[13], 'Task: Inspect the repo')
})

test('omitted model and thinking inherit the dispatching session', async () => {
  resetArgs()
  const factory = await loadFactory()
  const { tool } = createApi(factory)
  await withFakePi({ text: 'inherited' }, () =>
    tool.execute('call-inherit', { task: 'Inherit settings' }, undefined, undefined, {
      cwd: process.cwd(),
      model: { provider: 'anthropic', id: 'claude-sonnet' },
      thinkingLevel: 'medium'
    })
  )
  const args = readArgs()[0]
  assert.deepEqual(args.slice(5, 9), ['--model', 'anthropic/claude-sonnet', '--thinking', 'medium'])
})

test('a failing subagent reports its stderr and exit code', async () => {
  resetArgs()
  const factory = await loadFactory()
  const { tool } = createApi(factory)
  const result = await withFakePi({ mode: 'fail' }, () =>
    tool.execute('call-2', { task: 'Break something' }, undefined, undefined, { cwd: process.cwd() })
  )
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /boom from fake pi/)
  assert.equal(result.details?.results[0].exitCode, 3)
  assert.equal(result.details?.results[0].status, 'failed')
  assert.match(result.details!.results[0].stderr, /boom from fake pi/)
})

test('parallel tasks run and return one result per task', async () => {
  resetArgs()
  const factory = await loadFactory()
  const { tool } = createApi(factory)
  const result = await withFakePi({ text: 'parallel output' }, () =>
    tool.execute(
      'call-3',
      { tasks: [{ task: 'First' }, { task: 'Second', cwd: process.cwd() }] },
      undefined,
      undefined,
      { cwd: process.cwd() }
    )
  )
  assert.equal(result.isError, false)
  assert.equal(result.details?.mode, 'parallel')
  assert.equal(result.details?.results.length, 2)
  assert.deepEqual(result.details?.results.map((entry) => entry.task), ['First', 'Second'])
  assert.match(result.content[0].text, /Parallel: 2\/2 succeeded/)
  assert.match(result.content[0].text, /### \[1\] completed/)
  assert.equal(readArgs().length, 2)
  assert.equal(readArgs()[0].at(-1), 'Task: First')
  assert.equal(readArgs()[1].at(-1), 'Task: Second')
})

test('parallel tasks inherit the batch cwd and keep per-task overrides', async () => {
  const { tool } = createApi(await loadFactory())
  const result = await withFakePi({ mode: 'cwd' }, () =>
    tool.execute(
      'call-cwd',
      { cwd: dir, tasks: [{ task: 'Use batch directory' }, { task: 'Use own directory', cwd: process.cwd() }] },
      undefined,
      undefined,
      { cwd: process.cwd() }
    )
  )
  assert.equal(result.isError, false)
  assert.deepEqual(result.details?.results.map((entry) => entry.cwd), [dir, process.cwd()])
  assert.deepEqual(result.details?.results.map((entry) => entry.output), [dir, process.cwd()])
})

test('parallel progress distinguishes queued tasks from running tasks', async () => {
  const { tool, updates } = createApi(await loadFactory())
  const result = await withFakePi({}, () =>
    tool.execute('batch-progress', { tasks: Array.from({ length: 6 }, (_, index) => ({ task: `Task ${index}` })) }, undefined, (update) => updates.push(update), { cwd: process.cwd() })
  )
  assert.deepEqual(updates[0].details?.results.map((entry) => entry.status), Array(6).fill('queued'))
  assert.ok(updates.some((update) => update.details?.results.some((entry) => entry.status === 'running')))
  assert.ok(updates.every((update) => update.details!.results.filter((entry) => entry.status === 'running').length <= 4))
  assert.deepEqual(result.details?.results.map((entry) => entry.status), Array(6).fill('completed'))
})

test('child activity reports thinking and tool names without exposing reasoning text', async () => {
  const { tool, updates } = createApi(await loadFactory())
  await withFakePi({ mode: 'progress' }, () =>
    tool.execute('activity', { task: 'Inspect files' }, undefined, (update) => updates.push(update), { cwd: process.cwd() })
  )
  const progress = updates.map((update) => update.details!.results[0])
  assert.ok(progress.some((entry) => entry.activity === 'Thinking'))
  assert.ok(progress.some((entry) => entry.activity === 'Running a tool' && entry.toolName === 'read'))
  assert.ok(progress.some((entry) => entry.activity === 'Responding' && entry.toolName === undefined))
  assert.doesNotMatch(JSON.stringify(updates), /PRIVATE_REASONING_SHOULD_NOT_LEAK/)
})

test('validation rejects both or neither task and more than eight parallel tasks', async () => {
  const factory = await loadFactory()
  const { tool } = createApi(factory)
  const both = await tool.execute('call-4', { task: 'One', tasks: [{ task: 'Two' }] }, undefined, undefined, { cwd: process.cwd() })
  assert.equal(both.isError, true)
  assert.match(both.content[0].text, /exactly one of task or tasks/i)
  const neither = await tool.execute('call-5', {}, undefined, undefined, { cwd: process.cwd() })
  assert.equal(neither.isError, true)
  assert.match(neither.content[0].text, /exactly one of task or tasks/i)
  const tooMany = await tool.execute(
    'call-6',
    { tasks: Array.from({ length: 9 }, (_value, index) => ({ task: `Task ${index}` })) },
    undefined,
    undefined,
    { cwd: process.cwd() }
  )
  assert.equal(tooMany.isError, true)
  assert.match(tooMany.content[0].text, /Too many parallel tasks \(9\). Max is 8/)
})

test('the generated source never uses readline and splits JSONL with StringDecoder', () => {
  const source = subagentExtension()
  assert.doesNotMatch(source, /readline/)
  assert.match(source, /from 'node:string_decoder'/)
  assert.match(source, /new StringDecoder\('utf8'\)/)
  assert.match(source, /indexOf\('\\n'\)/)
  assert.doesNotMatch(source, /\u2028|\u2029/)
})

test('an AbortSignal kills a running subagent', async () => {
  resetArgs()
  const factory = await loadFactory()
  const { tool } = createApi(factory)
  const controller = new AbortController()
  const run = withFakePi({ mode: 'slow' }, () =>
    tool.execute('call-7', { task: 'Slow task' }, controller.signal, undefined, { cwd: process.cwd() })
  )
  setTimeout(() => controller.abort(), 150)
  const result = await run
  assert.equal(result.isError, true)
  assert.equal(result.details?.results[0].aborted, true)
  assert.equal(result.details?.results[0].status, 'aborted')
  assert.match(result.content[0].text, /aborted/i)
})

test('aborting a batch cancels queued tasks without starting their processes', async () => {
  resetArgs()
  const { tool } = createApi(await loadFactory())
  const controller = new AbortController()
  const run = withFakePi({ mode: 'slow' }, () =>
    tool.execute('batch-abort', { tasks: Array.from({ length: 6 }, (_, index) => ({ task: `Task ${index}` })) }, controller.signal, undefined, { cwd: process.cwd() })
  )
  setTimeout(() => controller.abort(), 150)
  const result = await run
  assert.deepEqual(result.details?.results.map((entry) => entry.status), Array(6).fill('aborted'))
  assert.ok(result.details?.results.slice(4).every((entry) => entry.startedAt === undefined))
  assert.ok(readArgs().length <= 4)
})
