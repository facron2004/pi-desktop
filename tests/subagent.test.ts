import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { subagentExtension } from '../src/main/pi/subagent'
import { permissionExtension } from '../src/main/pi/permissions'

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
    ctx: {
      cwd: string
      model?: { provider: string; id: string }
      thinkingLevel?: string
      ui?: {
        confirm: (title: string, message: string, options?: { timeout?: number }) => Promise<boolean | undefined>
        select: (title: string, options: string[], config?: { timeout?: number }) => Promise<string | undefined>
        input: (title: string, placeholder: string, config?: { timeout?: number }) => Promise<string | undefined>
        editor: (title: string, prefill: string) => Promise<string | undefined>
      }
    }
  ) => Promise<ToolResult>
}

// The generated extension imports typebox, so it has to live inside the
// project tree where Node can resolve the dependency.
const dir = mkdtempSync(path.join(process.cwd(), '.tmp-subagent-test-'))
const fakeScript = path.join(dir, 'fake-pi.mjs')
const extensionFile = path.join(dir, 'subagent-extension.mjs')
const logFile = path.join(dir, 'args.jsonl')
const promptFile = path.join(dir, 'prompts.jsonl')
const responseFile = path.join(dir, 'responses.jsonl')
const childPidFile = path.join(dir, 'child.pid')
const childStartedFile = path.join(dir, 'child-started')
const permissionExtensionFile = path.join(dir, 'permission-extension.mjs')
const permissionTitle = 'test-private-permission-title'

writeFileSync(
  fakeScript,
  `import { appendFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
const log = process.env.PI_FAKE_LOG;
if (log) appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n');
const mode = process.env.PI_FAKE_MODE || 'ok';
const promptLog = process.env.PI_FAKE_PROMPT_LOG;
const responseLog = process.env.PI_FAKE_RESPONSE_LOG;
if (mode === 'fail') {
  process.stderr.write('boom from fake pi\\n');
  process.exit(3);
}
if (mode === 'spawn-child') {
  const descendantSource = ${JSON.stringify(`const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(childStartedFile)}, 'started'); setTimeout(() => {}, 60000);`)};
  const descendant = spawn(process.execPath, ['-e', descendantSource], { stdio: 'ignore', windowsHide: true });
  writeFileSync(${JSON.stringify(childPidFile)}, String(descendant.pid));
}
if (mode === 'ignore-sigterm') process.on('SIGTERM', () => {});
if (mode === 'slow' || mode === 'ignore-sigterm' || mode === 'spawn-child') {
  setTimeout(() => {}, 60000);
}
const decoder = new StringDecoder('utf8');
let buffer = '';
function emit(event) { process.stdout.write(JSON.stringify(event) + '\\n'); }
if (process.argv.includes('--extension') && mode !== 'approval-unavailable') {
  emit({ type: 'extension_ui_request', id: 'permission-ready', method: 'setStatus', statusKey: process.env.PI_FAKE_PERMISSION_TITLE, statusText: 'ready' });
}
if (mode === 'approval-unavailable') setTimeout(() => process.exit(0), 20);
function emitResult() {
  if (mode === 'progress') {
    for (const event of [
      { type: 'message_start', message: { role: 'assistant' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'PRIVATE_REASONING_SHOULD_NOT_LEAK' } },
      { type: 'tool_execution_start', toolCallId: 'read', toolName: 'read' },
      { type: 'tool_execution_end', toolCallId: 'read', toolName: 'read' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_start' } }
    ]) emit(event);
  }
  const text = mode === 'cwd' ? process.cwd() : process.env.PI_FAKE_TEXT || 'done';
  const content = mode === 'multi-text'
    ? [{ type: 'text', text: 'first part ' }, { type: 'text', text: 'second part' }]
    : [{ type: 'text', text }];
  emit({ type: 'session', version: 3, id: 'fake' });
  emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      content,
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 17, cost: { total: 0.25 } },
      model: 'test/model',
      stopReason: 'stop'
    }
  });
  emit({ type: 'agent_settled', aborted: false });
}
function handle(record) {
  if (record.type === 'extension_ui_response') {
    if (responseLog) appendFileSync(responseLog, JSON.stringify(record) + '\\n');
    if (mode === 'approval') emitResult();
    return;
  }
  if (record.type !== 'prompt') return;
  if (promptLog) appendFileSync(promptLog, JSON.stringify(record) + '\\n');
  emit({ type: 'response', id: record.id, command: 'prompt', success: true, data: { disposition: 'started' } });
  if (mode === 'slow' || mode === 'ignore-sigterm' || mode === 'spawn-child') return;
  if (mode === 'approval') {
    emit({
      type: 'extension_ui_request',
      id: 'child-approval-' + process.pid,
      method: 'confirm',
      title: process.env.PI_FAKE_PERMISSION_TITLE,
      message: JSON.stringify({ toolName: 'write', input: { path: 'notes.txt' } })
    });
    return;
  }
  emitResult();
}
process.stdin.on('data', chunk => {
  buffer += decoder.write(chunk);
  while (true) {
    const newline = buffer.indexOf('\\n');
    if (newline === -1) break;
    const line = buffer.slice(0, newline).replace(/\\r$/, '');
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      try { handle(JSON.parse(line)); } catch {}
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`,
  'utf8'
)
writeFileSync(extensionFile, subagentExtension(), 'utf8')
writeFileSync(permissionExtensionFile, permissionExtension(permissionTitle, false), 'utf8')
const approvalExtensionFile = path.join(dir, 'subagent-extension-approval.mjs')
writeFileSync(approvalExtensionFile, subagentExtension({}, permissionExtensionFile, permissionTitle), 'utf8')
const trustedExtensionFile = path.join(dir, 'subagent-extension-trusted.mjs')
writeFileSync(trustedExtensionFile, subagentExtension({}, '', '', true), 'utf8')
// The same tool with the Settings choices baked in: the spawn contract must show
// them winning over the dispatching session and losing to the call's own argument.
const settingsExtensionFile = path.join(dir, 'subagent-extension-settings.mjs')
writeFileSync(settingsExtensionFile, subagentExtension({ model: 'x/y', thinking: 'low' }), 'utf8')

after(() => {
  if (existsSync(childPidFile)) {
    try { process.kill(Number(readFileSync(childPidFile, 'utf8')), 'SIGKILL') } catch {}
  }
  rmSync(dir, { recursive: true, force: true })
})

async function loadFactory(
  file = extensionFile
): Promise<(pi: { registerTool: (tool: Tool) => void }) => void> {
  const module = (await import(pathToFileURL(file).href)) as {
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
  mode?: 'ok' | 'fail' | 'slow' | 'ignore-sigterm' | 'spawn-child' | 'cwd' | 'progress' | 'approval' | 'approval-unavailable'
  text?: string
  onUpdate?: (update: Update) => void
}

function withFakePi<T>(options: FakeOptions, run: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
  const previousArgv = process.argv[1]
  const previousLog = process.env.PI_FAKE_LOG
  const previousPromptLog = process.env.PI_FAKE_PROMPT_LOG
  const previousResponseLog = process.env.PI_FAKE_RESPONSE_LOG
  const previousPermissionTitle = process.env.PI_FAKE_PERMISSION_TITLE
  const previousMode = process.env.PI_FAKE_MODE
  const previousText = process.env.PI_FAKE_TEXT
  process.argv[1] = fakeScript
  process.env.PI_FAKE_LOG = logFile
  process.env.PI_FAKE_PROMPT_LOG = promptFile
  process.env.PI_FAKE_RESPONSE_LOG = responseFile
  process.env.PI_FAKE_PERMISSION_TITLE = permissionTitle
  process.env.PI_FAKE_MODE = options.mode ?? 'ok'
  process.env.PI_FAKE_TEXT = options.text ?? 'done'
  const restore = (): void => {
    process.argv[1] = previousArgv
    if (previousLog === undefined) delete process.env.PI_FAKE_LOG
    else process.env.PI_FAKE_LOG = previousLog
    if (previousPromptLog === undefined) delete process.env.PI_FAKE_PROMPT_LOG
    else process.env.PI_FAKE_PROMPT_LOG = previousPromptLog
    if (previousResponseLog === undefined) delete process.env.PI_FAKE_RESPONSE_LOG
    else process.env.PI_FAKE_RESPONSE_LOG = previousResponseLog
    if (previousPermissionTitle === undefined) delete process.env.PI_FAKE_PERMISSION_TITLE
    else process.env.PI_FAKE_PERMISSION_TITLE = previousPermissionTitle
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

function readRecords(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
}

function resetArgs(): void {
  writeFileSync(logFile, '', 'utf8')
  writeFileSync(promptFile, '', 'utf8')
  writeFileSync(responseFile, '', 'utf8')
}

test('the subagent tool is registered as an active destructive tool', async () => {
  const factory = await loadFactory()
  const { tool } = createApi(factory)
  assert.equal(tool.name, 'subagent')
  assert.equal(tool.defaultActive, true)
  assert.deepEqual(tool.annotations, { destructiveHint: true, readOnlyHint: false, openWorldHint: true })
})

test('a single task spawns Pi in RPC mode and collects its text, usage and details', async () => {
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
  assert.deepEqual(args.slice(0, 4), ['--mode', 'rpc', '--no-session', '--no-approve'])
  assert.deepEqual(args.slice(4, 10), ['--model', 'openai/gpt', '--thinking', 'high', '--tools', 'read,grep'])
  assert.equal(args[10], '--append-system-prompt')
  assert.ok(args[11].length > 0)
  assert.deepEqual(readRecords(promptFile), [{ type: 'prompt', id: 'subagent-prompt', message: 'Task: Inspect the repo' }])
})

test('a subagent inherits the parent project trust decision', async () => {
  resetArgs()
  const { tool } = createApi(await loadFactory(trustedExtensionFile))
  await withFakePi({}, () =>
    tool.execute('call-trusted-project', { task: 'Use project resources' }, undefined, undefined, { cwd: process.cwd() })
  )
  const args = readArgs()[0]
  assert.ok(args.includes('--approve'))
  assert.ok(!args.includes('--no-approve'))
})

test('subagent output includes every text block from the final assistant message', async () => {
  const { tool } = createApi(await loadFactory())
  const result = await withFakePi({ mode: 'multi-text' }, () =>
    tool.execute('call-multi-text', { task: 'Return split text' }, undefined, undefined, { cwd: process.cwd() })
  )

  assert.equal(result.isError, false)
  assert.equal(result.content[0].text, 'first part second part')
  assert.equal(result.details?.results[0].output, 'first part second part')
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
  assert.deepEqual(args.slice(4, 8), ['--model', 'anthropic/claude-sonnet', '--thinking', 'medium'])
})

test('a Settings model and thinking replace the dispatching session', async () => {
  resetArgs()
  const { tool } = createApi(await loadFactory(settingsExtensionFile))
  await withFakePi({ text: 'from settings' }, () =>
    tool.execute('call-settings', { task: 'Use the configured model' }, undefined, undefined, {
      cwd: process.cwd(),
      model: { provider: 'anthropic', id: 'claude-sonnet' },
      thinkingLevel: 'medium'
    })
  )
  assert.deepEqual(readArgs()[0].slice(4, 8), ['--model', 'x/y', '--thinking', 'low'])
})

test('the model the call names still beats the Settings choice', async () => {
  resetArgs()
  const { tool } = createApi(await loadFactory(settingsExtensionFile))
  await withFakePi({ text: 'override' }, () =>
    tool.execute('call-override', { task: 'Name a model', model: 'openai/gpt', thinking: 'high' }, undefined, undefined, {
      cwd: process.cwd(),
      model: { provider: 'anthropic', id: 'claude-sonnet' },
      thinkingLevel: 'medium'
    })
  )
  assert.deepEqual(readArgs()[0].slice(4, 8), ['--model', 'openai/gpt', '--thinking', 'high'])
})

test('invalid call overrides fall back to Settings', async () => {
  resetArgs()
  const { tool } = createApi(await loadFactory(settingsExtensionFile))
  await withFakePi({ text: 'session defaults' }, () =>
    tool.execute('call-invalid-overrides', {
      task: 'Use session defaults',
      model: 'not a provider/model',
      thinking: 'very-high'
    }, undefined, undefined, {
      cwd: process.cwd(),
      model: { provider: 'anthropic', id: 'claude-sonnet' },
      thinkingLevel: 'medium'
    })
  )
  assert.deepEqual(readArgs()[0].slice(4, 8), ['--model', 'x/y', '--thinking', 'low'])
})

test('only a provider/id model and a plain thinking level are baked into the source', () => {
  const unset = subagentExtension()
  assert.ok(unset.includes('const SETTINGS_MODEL = "";'))
  assert.ok(unset.includes('const SETTINGS_THINKING = "";'))

  const trimmed = subagentExtension({ model: ' openai/gpt-4.1 ', thinking: 'low' })
  assert.ok(trimmed.includes('const SETTINGS_MODEL = "openai/gpt-4.1";'))
  assert.ok(trimmed.includes('const SETTINGS_THINKING = "low";'))

  // A gateway provider's model id holds a second slash, and the catalog splits a
  // saved spec on its FIRST slash only. The picker can choose such a model, so the
  // setting must survive the shape check — or the row would look set and do nothing.
  const gateway = subagentExtension({ model: 'openrouter/anthropic/claude-3.5-sonnet' })
  assert.ok(
    gateway.includes('const SETTINGS_MODEL = "openrouter/anthropic/claude-3.5-sonnet";')
  )

  // A free-text id would land in a shell argv, so it becomes the empty string
  // and the call follows the session again.
  const junk = subagentExtension({ model: 'x"; process.exit(0); //', thinking: 'super' })
  assert.ok(junk.includes('const SETTINGS_MODEL = "";'))
  assert.ok(junk.includes('const SETTINGS_THINKING = "";'))
  assert.doesNotMatch(junk, /process\.exit/)
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
  assert.deepEqual(readRecords(promptFile).map((record) => record.message).sort(), ['Task: First', 'Task: Second'])
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

test('child permission requests use the parent UI and serialize across parallel subagents', async () => {
  resetArgs()
  const firstCwd = path.join(dir, 'first-child')
  const secondCwd = path.join(dir, 'second-child')
  mkdirSync(firstCwd, { recursive: true })
  mkdirSync(secondCwd, { recursive: true })
  const { tool } = createApi(await loadFactory(approvalExtensionFile))
  const approvals: { title: string; approval: Record<string, unknown> }[] = []
  let active = 0
  let maxActive = 0
  const result = await withFakePi({ mode: 'approval' }, () => tool.execute(
    'call-approval',
    { tasks: [{ task: 'First', cwd: firstCwd }, { task: 'Second', cwd: secondCwd }] },
    undefined,
    undefined,
    {
      cwd: process.cwd(),
      ui: {
        confirm: async (title, message) => {
          active += 1
          maxActive = Math.max(maxActive, active)
          await new Promise((resolve) => setTimeout(resolve, 25))
          approvals.push({ title, approval: JSON.parse(message) as Record<string, unknown> })
          active -= 1
          return true
        },
        select: async () => undefined,
        input: async () => undefined,
        editor: async () => undefined
      }
    }
  ))

  assert.equal(result.isError, false)
  assert.deepEqual(result.details?.results.map((entry) => entry.status), ['completed', 'completed'])
  assert.equal(maxActive, 1, 'the parent runtime holds one pending UI request at a time')
  assert.deepEqual(approvals.map(({ title }) => title), [permissionTitle, permissionTitle])
  assert.deepEqual(approvals.map(({ approval }) => approval.cwd).sort(), [firstCwd, secondCwd].sort())
  assert.deepEqual(approvals.map(({ approval }) => approval.toolName), ['write', 'write'])
  assert.deepEqual(readRecords(responseFile).map((response) => response.confirmed), [true, true])
  const args = readArgs()
  assert.equal(args.length, 2)
  assert.ok(args.every((entry) => entry.slice(0, 4).join(' ') === '--mode rpc --no-session --no-approve'))
  assert.ok(args.every((entry) => entry.includes('--extension') && entry.includes(permissionExtensionFile)))
})

test('a subagent never receives its task if the permission extension does not become ready', async () => {
  resetArgs()
  const { tool } = createApi(await loadFactory(approvalExtensionFile))
  const result = await withFakePi({ mode: 'approval-unavailable' }, () => tool.execute(
    'call-without-approval-controls',
    { task: 'Do not run without approval controls' },
    undefined,
    undefined,
    { cwd: process.cwd() }
  ))

  assert.equal(result.isError, true)
  assert.match(result.details!.results[0].errorMessage ?? '', /did not load its tool approval controls/i)
  assert.deepEqual(readRecords(promptFile), [])
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

test('subagent cancellation targets the whole process tree on each platform', () => {
  const source = subagentExtension()
  assert.match(source, /detached: process\.platform !== 'win32'/)
  assert.match(source, /process\.kill\(-child\.pid, signal\)/)
  assert.match(source, /execFile\('taskkill\.exe', args/)
  assert.match(source, /const args = \['\/PID', String\(child\.pid\), '\/T'\]/)
  assert.match(source, /if \(force\) args\.push\('\/F'\)/)
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

test('aborting a subagent also terminates its child processes', async () => {
  resetArgs()
  rmSync(childPidFile, { force: true })
  rmSync(childStartedFile, { force: true })
  const { tool } = createApi(await loadFactory())
  const controller = new AbortController()
  let pid: number | undefined
  try {
    const run = withFakePi({ mode: 'spawn-child' }, () =>
      tool.execute('call-child-process', { task: 'Spawn a child process' }, controller.signal, undefined, { cwd: process.cwd() })
    )
    const startupDeadline = Date.now() + 3000
    while (!existsSync(childStartedFile) && Date.now() < startupDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(existsSync(childStartedFile), true, 'the nested process must start before cancellation')
    pid = Number(readFileSync(childPidFile, 'utf8'))
    assert.ok(Number.isInteger(pid) && pid > 0, 'the nested process must report its pid')
    controller.abort()
    const result = await run
    assert.equal(result.isError, true)
    assert.equal(result.details?.results[0].status, 'aborted')

    const exitDeadline = Date.now() + 2000
    let alive = true
    while (alive && Date.now() < exitDeadline) {
      try {
        process.kill(pid, 0)
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code === 'EPERM'
      }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(alive, false, 'the nested process must be gone when cancellation completes')
  } finally {
    if (pid) {
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
    rmSync(childPidFile, { force: true })
    rmSync(childStartedFile, { force: true })
  }
})

test('an aborted subagent that ignores SIGTERM is force-killed after the grace period', {
  skip: process.platform === 'win32'
}, async () => {
  resetArgs()
  const { tool } = createApi(await loadFactory())
  const controller = new AbortController()
  const startedAt = Date.now()
  const run = withFakePi({ mode: 'ignore-sigterm' }, () =>
    tool.execute('call-ignore-term', { task: 'Ignore SIGTERM' }, controller.signal, undefined, { cwd: process.cwd() })
  )
  setTimeout(() => controller.abort(), 150)
  const result = await run
  assert.equal(result.isError, true)
  assert.equal(result.details?.results[0].status, 'aborted')
  assert.ok(Date.now() - startedAt >= 4_900, 'the child must remain alive until SIGKILL escalation')
  assert.ok(Date.now() - startedAt < 8_000, 'the child must exit shortly after escalation')
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
