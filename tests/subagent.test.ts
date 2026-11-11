import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
      status: 'queued' | 'running' | 'completed' | 'failed' | 'aborted' | 'timed_out'
      label?: string
      cancelled?: boolean
      stopReason?: string
      progressText?: string
      errorMessage?: string
      activity?: string
      toolName?: string
      startedAt?: number
      finishedAt?: number
      attempts?: number
      retriesUsed?: number
      structured?: unknown
      schemaError?: string
      messages?: unknown[]
      messagesTruncated?: boolean
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
type RegisteredCommand = {
  description: string
  handler: (args: string) => unknown
}
type ExtensionApi = {
  registerTool: (tool: Tool) => void
  registerCommand: (name: string, command: RegisteredCommand) => void
}

// The generated extension imports typebox, so it has to live inside the
// project tree where Node can resolve the dependency.
const dir = mkdtempSync(path.join(process.cwd(), '.tmp-subagent-test-'))
const fakeScript = path.join(dir, 'fake-pi.mjs')
const extensionFile = path.join(dir, 'subagent-extension.mjs')
const fallbackExtensionFile = path.join(dir, 'subagent-extension-fallback.mjs')
const logFile = path.join(dir, 'args.jsonl')
const promptFile = path.join(dir, 'prompts.jsonl')
const responseFile = path.join(dir, 'responses.jsonl')
const childPidFile = path.join(dir, 'child.pid')
const childStartedFile = path.join(dir, 'child-started')
const permissionExtensionFile = path.join(dir, 'permission-extension.mjs')
const permissionTitle = 'test-private-permission-title'
const counterFile = path.join(dir, 'attempts.count')

writeFileSync(
  fakeScript,
  `import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
const log = process.env.PI_FAKE_LOG;
if (log) appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n');
const mode = process.env.PI_FAKE_MODE || 'ok';
const counterFile = process.env.PI_FAKE_COUNTER;
function nextAttempt() {
  let count = 0;
  if (counterFile) {
    try { count = Number(readFileSync(counterFile, 'utf8')) || 0; } catch {}
    count += 1;
    try { writeFileSync(counterFile, String(count)); } catch {}
  }
  return count;
}
const attempt = nextAttempt();
if (mode === 'flaky' && attempt <= Number(process.env.PI_FAKE_FLAKY || '0')) {
  process.stderr.write('flaky spawn failure ' + attempt + '\\n');
  process.exit(7);
}
if (mode === 'exit-zero') process.exit(0);
if (mode === 'unterminated-settle') {
  process.stdout.write(JSON.stringify({ type: 'agent_settled', aborted: false }), () => process.exit(0));
}
const activeDirectory = process.env.PI_FAKE_ACTIVE_DIR;
let activeMarker;
if (activeDirectory) {
  mkdirSync(activeDirectory, { recursive: true });
  activeMarker = path.join(activeDirectory, String(process.pid));
  writeFileSync(activeMarker, 'running');
  process.on('exit', () => { try { unlinkSync(activeMarker); } catch {} });
}
const promptLog = process.env.PI_FAKE_PROMPT_LOG;
const responseLog = process.env.PI_FAKE_RESPONSE_LOG;
if (mode === 'fail') {
  process.stderr.write('boom from fake pi\\n');
  process.exit(3);
}
if (mode === 'oversized') {
  const chunk = Buffer.alloc(64 * 1024, 0x78);
  let remaining = 64 * 1024 * 1024 + 1;
  function writeOversizedRecord() {
    while (remaining > 0) {
      const size = Math.min(chunk.length, remaining);
      remaining -= size;
      if (!process.stdout.write(size === chunk.length ? chunk : chunk.subarray(0, size))) {
        process.stdout.once('drain', writeOversizedRecord);
        return;
      }
    }
  }
  writeOversizedRecord();
}
if (mode === 'noisy-stderr') process.stderr.write('x'.repeat(1024 * 1024 + 1));
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
      { type: 'message_update', assistantMessageEvent: { type: 'text_start' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'LIVE-' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'PROGRESS' } }
    ]) emit(event);
  }
  if (mode === 'many-messages') {
    for (let index = 0; index < 240; index++) {
      emit({
        type: 'message_end',
        message: {
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: [{ type: 'text', text: 'message-' + index + '-' + 'x'.repeat(128) }]
        }
      });
    }
    emit({ type: 'agent_settled', aborted: false });
    return;
  }
  if (mode === 'large-message') {
    const text = 'x'.repeat(300 * 1024);
    emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });
    emit({ type: 'agent_settled', aborted: false });
    return;
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
  if (mode === 'unterminated-settle') return;
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
  if (mode === 'fail-after-message') {
    emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial work' }],
        usage: { input: 10, output: 5, totalTokens: 15 },
        stopReason: 'stop'
      }
    });
    setTimeout(() => process.exit(9), 5);
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
writeFileSync(
  fallbackExtensionFile,
  subagentExtension({}, '', '', false, { command: process.execPath, prefixArgs: [fakeScript] }),
  'utf8'
)
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
): Promise<(pi: ExtensionApi) => void> {
  const module = (await import(pathToFileURL(file).href)) as {
    default: (pi: ExtensionApi) => void
  }
  return module.default
}

function createApi(factory: (pi: ExtensionApi) => void): { tool: Tool; updates: Update[]; commands: Map<string, RegisteredCommand> } {
  let tool: Tool | undefined
  const updates: Update[] = []
  const commands = new Map<string, RegisteredCommand>()
  factory({
    registerTool: (definition) => { tool = definition },
    registerCommand: (name, command) => { commands.set(name, command) }
  })
  assert.ok(tool, 'extension did not register a tool')
  return { tool, updates, commands }
}

type FakeOptions = {
  mode?: 'ok' | 'fail' | 'slow' | 'ignore-sigterm' | 'spawn-child' | 'cwd' | 'progress' | 'many-messages' | 'large-message' | 'approval' | 'approval-unavailable' | 'oversized' | 'noisy-stderr'
  activeDirectory?: string
  text?: string
  currentScript?: string
  onUpdate?: (update: Update) => void
}

function withFakePi<T>(options: FakeOptions, run: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
  const previousArgv = process.argv[1]
  const previousLog = process.env.PI_FAKE_LOG
  const previousPromptLog = process.env.PI_FAKE_PROMPT_LOG
  const previousResponseLog = process.env.PI_FAKE_RESPONSE_LOG
  const previousPermissionTitle = process.env.PI_FAKE_PERMISSION_TITLE
  const previousActiveDirectory = process.env.PI_FAKE_ACTIVE_DIR
  const previousMode = process.env.PI_FAKE_MODE
  const previousText = process.env.PI_FAKE_TEXT
  process.argv[1] = options.currentScript ?? fakeScript
  process.env.PI_FAKE_LOG = logFile
  process.env.PI_FAKE_PROMPT_LOG = promptFile
  process.env.PI_FAKE_RESPONSE_LOG = responseFile
  process.env.PI_FAKE_PERMISSION_TITLE = permissionTitle
  if (options.activeDirectory) process.env.PI_FAKE_ACTIVE_DIR = options.activeDirectory
  else delete process.env.PI_FAKE_ACTIVE_DIR
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
    if (previousActiveDirectory === undefined) delete process.env.PI_FAKE_ACTIVE_DIR
    else process.env.PI_FAKE_ACTIVE_DIR = previousActiveDirectory
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

test('the subagent fallback uses the resolved Pi executable when its script path is unavailable', async () => {
  resetArgs()
  const { tool } = createApi(await loadFactory(fallbackExtensionFile))
  const result = await withFakePi({ currentScript: path.join(dir, 'missing-pi-script.mjs') }, () =>
    tool.execute('call-fallback', { task: 'Use the configured Pi' }, undefined, undefined, { cwd: process.cwd() })
  )
  assert.equal(result.isError, false)
  assert.deepEqual(readArgs()[0].slice(0, 4), ['--mode', 'rpc', '--no-session', '--no-approve'])
})

test('the extension command cancels one active subagent task by id', async () => {
  resetArgs()
  const { tool, commands } = createApi(await loadFactory())
  const cancel = commands.get('desktop-subagent-cancel')
  assert.ok(cancel, 'extension did not register its task cancel command')

  await withFakePi({ mode: 'slow' }, async () => {
    const call = tool.execute('call-cancel-one', { task: 'Keep running until stopped' }, undefined, undefined, { cwd: process.cwd() })
    const deadline = Date.now() + 5000
    while (readArgs().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(readArgs().length, 1, 'the child should be running before cancellation')

    await cancel.handler('call-cancel-one:0')
    const result = await call
    const child = result.details!.results[0]!
    assert.equal(child.status, 'aborted')
    assert.equal(child.cancelled, true)
    assert.match(child.errorMessage ?? '', /stopped by the user/i)
    assert.equal(readArgs().length, 1, 'cancellation should stop the existing child without restarting it')
  })
})

test('a task can retry a failure that happened before the model received its prompt', async () => {
  resetArgs()
  const { tool } = createApi(await loadFactory())
  const result = await withFakePi({ mode: 'fail' }, () =>
    tool.execute('call-retry', { task: 'Retry only if no model turn started', retries: 2 }, undefined, undefined, { cwd: process.cwd() })
  )
  const child = result.details!.results[0]!
  assert.equal(result.isError, true)
  assert.equal(child.status, 'failed')
  assert.equal(child.attempts, 3)
  assert.equal(child.retriesUsed, 2)
  assert.equal(readArgs().length, 3)
})

test('outputSchema accepts a matching JSON answer and rejects a mismatch', async () => {
  const schema = {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false
  }
  const { tool } = createApi(await loadFactory())
  const valid = await withFakePi({ text: '{"ok":true}' }, () =>
    tool.execute('call-schema-valid', { task: 'Return JSON', outputSchema: schema }, undefined, undefined, { cwd: process.cwd() })
  )
  assert.equal(valid.isError, false)
  assert.equal(valid.details!.results[0]!.status, 'completed')
  assert.deepEqual(valid.details!.results[0]!.structured, { ok: true })

  const invalid = await withFakePi({ text: '{"ok":"yes"}' }, () =>
    tool.execute('call-schema-invalid', { task: 'Return JSON', outputSchema: schema }, undefined, undefined, { cwd: process.cwd() })
  )
  assert.equal(invalid.isError, true)
  assert.equal(invalid.details!.results[0]!.status, 'failed')
  assert.equal(invalid.details!.results[0]!.stopReason, 'schema')
  assert.match(invalid.details!.results[0]!.schemaError ?? '', /\.ok must be boolean/)

  let deepSchema: Record<string, unknown> = { type: 'string' }
  let deepValue: unknown = 'done'
  for (let depth = 0; depth < 10; depth++) {
    deepSchema = { type: 'object', properties: { value: deepSchema }, required: ['value'] }
    deepValue = { value: deepValue }
  }
  const tooDeep = await withFakePi({ text: JSON.stringify(deepValue) }, () =>
    tool.execute('call-schema-deep', { task: 'Return deeply nested JSON', outputSchema: deepSchema }, undefined, undefined, { cwd: process.cwd() })
  )
  assert.equal(tooDeep.isError, true)
  assert.match(tooDeep.details!.results[0]!.schemaError ?? '', /maximum supported outputSchema depth/)

  const wideProperties = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`property${index}`, { type: 'boolean' }]))
  const tooWide = await withFakePi({ text: '{}' }, () =>
    tool.execute('call-schema-wide', {
      task: 'Return JSON with bounded schema width',
      outputSchema: { type: 'object', properties: wideProperties }
    }, undefined, undefined, { cwd: process.cwd() })
  )
  assert.equal(tooWide.isError, true)
  assert.match(tooWide.details!.results[0]!.schemaError ?? '', /too many outputSchema properties/)
})

test('concurrent subagent calls share one process limit and queued calls can be cancelled', async () => {
  resetArgs()
  const { tool } = createApi(await loadFactory())
  const activeDirectory = path.join(dir, 'active-subagents')
  mkdirSync(activeDirectory, { recursive: true })

  await withFakePi({ mode: 'slow', activeDirectory }, async () => {
    const controllers = Array.from({ length: 8 }, () => new AbortController())
    const calls = controllers.map((controller, index) => tool.execute(
      `call-concurrent-${index}`,
      { task: `Task ${index}` },
      controller.signal,
      undefined,
      { cwd: process.cwd() }
    ))
    try {
      const deadline = Date.now() + 10000
      while (readdirSync(activeDirectory).length < 4 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(readdirSync(activeDirectory).length, 4, 'exactly four child processes should occupy the shared slots')
      assert.equal(readArgs().length, 4, 'the remaining calls should wait before spawning Pi')

      for (const controller of controllers.slice(5)) controller.abort()
      const queuedResults = await Promise.all(calls.slice(5))
      assert.ok(queuedResults.every((result) => result.details?.results[0]?.status === 'aborted'))
      assert.equal(readArgs().length, 4, 'cancelled queued calls must not spawn Pi')

      controllers[0]!.abort()
      assert.equal((await calls[0]!).details?.results[0]?.status, 'aborted')
      const releasedDeadline = Date.now() + 5000
      while (readArgs().length < 5 && Date.now() < releasedDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(readArgs().length, 5, 'the oldest queued call should start when a slot is released')

      for (const controller of controllers.slice(1, 5)) controller.abort()
      const remainingResults = await Promise.all(calls.slice(1, 5))
      assert.ok(remainingResults.every((result) => result.details?.results[0]?.status === 'aborted'))
    } finally {
      for (const controller of controllers) controller.abort()
      await Promise.allSettled(calls)
    }
  })
})

test('subagent transcript snapshots retain a bounded tail and report omitted messages', async () => {
  const { tool, updates } = createApi(await loadFactory())
  const result = await withFakePi({ mode: 'many-messages' }, () =>
    tool.execute('call-transcript-limit', { task: 'Emit many messages' }, undefined, (update) => updates.push(update), { cwd: process.cwd() })
  )
  const child = result.details!.results[0]
  assert.equal(child.status, 'completed')
  assert.equal(child.messages!.length, 200)
  assert.equal(child.messagesTruncated, true)
  assert.match(result.content[0].text, /^message-239-/)
  for (const update of updates) {
    const snapshot = update.details?.results[0]
    if (!snapshot?.messages) continue
    assert.ok(snapshot.messages.length <= 200)
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot.messages), 'utf8') <= 256 * 1024)
  }
})

test('oversized transcript messages and final output are capped with visible notices', async () => {
  const { tool, updates } = createApi(await loadFactory())
  const result = await withFakePi({ mode: 'large-message' }, () =>
    tool.execute('call-large-message', { task: 'Emit a large final message' }, undefined, (update) => updates.push(update), { cwd: process.cwd() })
  )
  const child = result.details!.results[0]
  assert.equal(child.messages!.length, 0)
  assert.equal(child.messagesTruncated, true)
  const finalNotice = '\n[Subagent final output truncated at 262144 characters]'
  assert.equal(result.content[0].text.length, 256 * 1024)
  assert.ok(result.content[0].text.endsWith(finalNotice))
  assert.equal(child.output, result.content[0].text)
  const progressNotice = '\n[Progress output truncated; see the final result below]'
  assert.ok(updates.some((update) => update.content[0].text.endsWith(progressNotice)))
  assert.ok(updates.every((update) => update.content[0].text.length <= 16 * 1024 + progressNotice.length))
  assert.ok(updates.every((update) => (update.details?.results[0].output?.length ?? 0) <= 16 * 1024 + progressNotice.length))
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

test('a zero exit without agent_settled is not reported as a successful task', async () => {
  const { tool } = createApi(await loadFactory())
  const result = await withFakePi({ mode: 'exit-zero' }, () =>
    tool.execute('call-zero-exit', { task: 'Exit before starting' }, undefined, undefined, { cwd: process.cwd() })
  )
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /exited before the subagent task settled/)
  assert.equal(result.details?.results[0].status, 'failed')
})

test('an unterminated final JSON record cannot settle a subagent', async () => {
  const { tool } = createApi(await loadFactory())
  const result = await withFakePi({ mode: 'unterminated-settle' }, () =>
    tool.execute('call-unterminated', { task: 'Emit an unterminated record' }, undefined, undefined, { cwd: process.cwd() })
  )
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /record was not terminated by LF/)
  assert.equal(result.details?.results[0].status, 'failed')
})

test('an oversized subagent RPC record fails the task and stops the child', async () => {
  const { tool } = createApi(await loadFactory())
  const result = await withFakePi({ mode: 'oversized' }, () =>
    tool.execute('call-oversized-record', { task: 'Emit an oversized record' }, undefined, undefined, { cwd: process.cwd() })
  )
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /exceeded the 64 MB limit/)
  assert.equal(result.details?.results[0].status, 'failed')
})

test('subagent stderr retention is capped with a visible truncation note', async () => {
  const { tool } = createApi(await loadFactory())
  const result = await withFakePi({ mode: 'noisy-stderr' }, () =>
    tool.execute('call-noisy-stderr', { task: 'Write too much stderr' }, undefined, undefined, { cwd: process.cwd() })
  )
  const stderr = result.details?.results[0].stderr ?? ''
  assert.match(stderr, /Subagent stderr truncated at 262144 characters/)
  assert.ok(stderr.length <= 256 * 1024)
})

test('parallel subagent outputs stay below the parent RPC record limit', async () => {
  const { tool } = createApi(await loadFactory())
  const result = await withFakePi({ mode: 'large-message' }, () =>
    tool.execute(
      'call-parallel-output-limit',
      { tasks: Array.from({ length: 8 }, (_, index) => ({ task: 'Task ' + (index + 1) })) },
      undefined,
      undefined,
      { cwd: process.cwd() }
    )
  )

  assert.equal(result.details?.results.length, 8)
  assert.ok(result.details?.results.every((child) => child.output.length <= 256 * 1024))
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 64 * 1024 * 1024)
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

test('a subagent cannot run outside the active project working directory', async () => {
  resetArgs()
  const { tool } = createApi(await loadFactory())
  const result = await withFakePi({}, () =>
    tool.execute(
      'call-cwd-outside',
      { task: 'Do not run outside the project', cwd: path.dirname(process.cwd()) },
      undefined,
      undefined,
      { cwd: process.cwd() }
    )
  )

  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /inside the current project/)
  assert.equal(result.details?.results[0].status, 'failed')
  assert.deepEqual(readArgs(), [], 'an out-of-project Pi process must not be spawned')
})

test('a subagent cannot use an in-project symlink to leave the active project', async (t) => {
  resetArgs()
  const { tool } = createApi(await loadFactory())
  const link = path.join(dir, 'outside-project-link')
  try {
    symlinkSync(path.dirname(process.cwd()), link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.skip('directory symlinks are unavailable: ' + (error instanceof Error ? error.message : String(error)))
    return
  }
  const result = await withFakePi({}, () =>
    tool.execute(
      'call-cwd-symlink',
      { task: 'Do not run through the project symlink', cwd: path.relative(process.cwd(), link) },
      undefined,
      undefined,
      { cwd: process.cwd() }
    )
  )

  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /inside the current project/)
  assert.deepEqual(readArgs(), [], 'a symlink escape must not launch Pi')
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
  assert.match(source, /indexOf\('\\n', start\)/)
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

test('the generated source ships the delegation contract, timeouts and per-task schema', () => {
  const source = subagentExtension()
  assert.match(source, /promptSnippet:/)
  assert.match(source, /promptGuidelines: \[/)
  assert.match(source, /const DEFAULT_TIMEOUT_MS = 30 \* 60 \* 1000;/)
  assert.match(source, /const MAX_PROGRESS_TEXT_CHARS = 4096;/)
  assert.match(source, /'timed_out'/)
  assert.match(source, /timeoutMs: Type.Optional/)
  assert.match(source, /concurrency: Type.Optional/)
  assert.match(source, /label: Type.Optional/)
  assert.match(source, /A child cannot see this conversation/)
  assert.match(source, /normalizeConcurrency\(/)
  assert.match(source, /taskParams\(/)
  assert.doesNotMatch(source, /readline/)
})

test('a batch can give each task its own model, thinking and tools', async () => {
  resetArgs()
  const { tool } = createApi(await loadFactory())
  const result = await withFakePi({ text: 'per-task' }, () =>
    tool.execute('call-per-task', {
      tasks: [
        { task: 'Scout the repo', label: 'scout', model: 'anthropic/haiku', thinking: 'low', tools: ['read', 'grep'] },
        { task: 'Build the fix', label: 'build', model: 'openai/gpt', thinking: 'high', tools: ['read', 'write'] },
        { task: 'Follow the batch', label: 'follow' }
      ],
      model: 'x/y', thinking: 'medium', tools: ['read']
    }, undefined, undefined, { cwd: process.cwd() })
  )
  assert.equal(result.isError, false)
  assert.deepEqual(result.details?.results.map((entry) => entry.label), ['scout', 'build', 'follow'])
  const signatures = readArgs().map((args) => {
    const flag = (name: string): string => {
      const index = args.indexOf(name)
      return index === -1 ? '' : args[index + 1] ?? ''
    }
    return [flag('--model'), flag('--thinking'), flag('--tools')].join('|')
  }).sort()
  assert.deepEqual(signatures, [
    'anthropic/haiku|low|read,grep',
    'openai/gpt|high|read,write',
    'x/y|medium|read'
  ].sort())
})

test('invalid per-task overrides fall back to the batch defaults', async () => {
  resetArgs()
  const { tool } = createApi(await loadFactory())
  await withFakePi({ text: 'fallback' }, () =>
    tool.execute('call-per-task-invalid', {
      tasks: [{ task: 'One', model: 'not a model', thinking: 'ultra', tools: [] }, { task: 'Two' }],
      model: 'x/y', thinking: 'medium', tools: ['read']
    }, undefined, undefined, { cwd: process.cwd() })
  )
  const signatures = readArgs().map((args) => {
    const flag = (name: string): string => {
      const index = args.indexOf(name)
      return index === -1 ? '' : args[index + 1] ?? ''
    }
    return [flag('--model'), flag('--thinking'), flag('--tools')].join('|')
  })
  assert.equal(signatures.length, 2)
  assert.ok(signatures.every((signature) => signature === 'x/y|medium|read'))
})

test('a batch concurrency cap limits the number of simultaneous child processes', async () => {
  resetArgs()
  const { tool } = createApi(await loadFactory())
  const activeDirectory = path.join(dir, 'active-concurrency')
  mkdirSync(activeDirectory, { recursive: true })
  await withFakePi({ mode: 'slow', activeDirectory }, async () => {
    const controller = new AbortController()
    // concurrency is a property of ONE batch call, not of several calls in
    // flight: six parallel execute() calls would each contend for the shared
    // process-wide slots and measure the global cap instead.
    const run = tool.execute(
      'call-concurrency-cap',
      { tasks: Array.from({ length: 6 }, (_, index) => ({ task: `Task ${index}` })), concurrency: 2 },
      controller.signal,
      undefined,
      { cwd: process.cwd() }
    )
    try {
      const deadline = Date.now() + 10000
      while (readdirSync(activeDirectory).length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(readdirSync(activeDirectory).length, 2, 'concurrency: 2 starts only two Pi processes')
      assert.equal(readArgs().length, 2)
    } finally {
      controller.abort()
      await Promise.allSettled([run])
    }
  })
})

test('a task that exceeds its timeout is killed and reported as timed_out', async () => {
  resetArgs()
  const { tool } = createApi(await loadFactory())
  const result = await withFakePi({ mode: 'slow' }, () =>
    tool.execute('call-timeout', { task: 'Never finish', timeoutMs: 600 }, undefined, undefined, { cwd: process.cwd() })
  )
  assert.equal(result.isError, true)
  const child = result.details!.results[0]
  assert.equal(child.status, 'timed_out')
  assert.match(result.content[0].text, /timed out/i)
  assert.match(child.errorMessage ?? '', /timed out/i)
})

test('a single task can carry a short label', async () => {
  const { tool } = createApi(await loadFactory())
  const result = await withFakePi({ text: 'labelled' }, () =>
    tool.execute('call-label', { task: 'A very long briefing that should not be the row name', label: 'Scout' }, undefined, undefined, { cwd: process.cwd() })
  )
  assert.equal(result.details?.results[0].label, 'Scout')
})

test('live answer text is published while a subagent runs, without leaking reasoning', async () => {
  const { tool, updates } = createApi(await loadFactory())
  await withFakePi({ mode: 'progress' }, () =>
    tool.execute('call-live-text', { task: 'Stream text' }, undefined, (update) => updates.push(update), { cwd: process.cwd() })
  )
  const snapshots = updates.map((update) => update.details?.results[0]).filter(Boolean)
  assert.ok(snapshots.some((snapshot) => snapshot!.progressText?.startsWith('LIVE-')))
  assert.ok(snapshots.every((snapshot) => (snapshot!.progressText ?? '').length <= 4096))
  assert.doesNotMatch(JSON.stringify(updates), /PRIVATE_REASONING_SHOULD_NOT_LEAK/)
})
