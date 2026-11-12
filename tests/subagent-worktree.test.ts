import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { subagentExtension } from '../src/main/pi/subagent'

const root = process.cwd()
// The generated extension imports typebox, so the scratch directory has to
// live inside the project tree for Node to resolve the dependency.
const scratch = mkdtempSync(path.join(root, '.tmp-subagent-worktree-test-'))
const extensionFile = path.join(scratch, 'subagent-extension.mjs')
const fakeScript = path.join(scratch, 'fake-pi.mjs')
const argsLog = path.join(scratch, 'args.jsonl')
const promptLog = path.join(scratch, 'prompts.jsonl')

// The fake child echoes its cwd as its final answer, so the test can prove
// the child really ran inside the worktree rather than the project root.
writeFileSync(extensionFile, subagentExtension(), 'utf8')
writeFileSync(fakeScript, `import { appendFileSync, writeFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
const log = process.env.PI_FAKE_LOG;
if (log) appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n');
const promptLog = process.env.PI_FAKE_PROMPT_LOG;
const cwd = process.cwd();
const mode = process.env.PI_FAKE_MODE || 'ok';
function emit(event) { process.stdout.write(JSON.stringify(event) + '\\n'); }
if (mode === 'write') {
  writeFileSync(process.env.PI_FAKE_WRITE || 'made-by-child.txt', 'child work\\n', 'utf8');
}
const decoder = new StringDecoder('utf8');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += decoder.write(chunk);
  while (true) {
    const newline = buffer.indexOf('\\n');
    if (newline === -1) break;
    const line = buffer.slice(0, newline).replace(/\\r$/, '');
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type !== 'prompt') continue;
    if (promptLog) appendFileSync(promptLog, JSON.stringify(record) + '\\n');
    emit({ type: 'response', id: record.id, command: 'prompt', success: true, data: { disposition: 'started' } });
    emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: cwd }], usage: { input: 1, output: 1 }, stopReason: 'stop' } });
    emit({ type: 'agent_settled', aborted: false });
  }
});
process.stdin.on('end', () => process.exit(0));
`, 'utf8')

after(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function makeRepo(name) {
  const repo = path.join(scratch, name)
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(path.join(repo, 'README.md'), 'seed\n', 'utf8')
  git(repo, 'add', 'README.md')
  git(repo, 'commit', '-q', '-m', 'seed')
  return repo
}

type ToolResult = {
  content: { type: string; text: string }[]
  details?: {
    mode: string
    results: {
      task: string
      cwd: string
      status: string
      output: string
      errorMessage?: string
      worktree?: { name: string; branch: string; path: string; kept: boolean; reason: string }
    }[]
  }
  isError?: boolean
}
type Api = {
  registerTool: (tool: { execute: (id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: { cwd: string }) => Promise<ToolResult> }) => void
  registerCommand: (name: string, command: { handler: (value: string) => Promise<void> }) => void
}

async function loadApi(): Promise<{ tool: Parameters<Api['registerTool']>[0]; commands: Map<string, { handler: (value: string) => Promise<void> }> }> {
  const module = await import(pathToFileURL(extensionFile).href + '?v=' + Date.now()) as { default: (pi: Api) => void }
  let tool: Parameters<Api['registerTool']>[0] | undefined
  const commands = new Map<string, { handler: (value: string) => Promise<void> }>()
  module.default({
    registerTool: (definition) => { tool = definition },
    registerCommand: (name, command) => { commands.set(name, command) }
  })
  assert.ok(tool, 'the extension did not register a tool')
  return { tool, commands }
}

async function runTask(repo: string, params: Record<string, unknown>, mode = 'ok') {
  const { tool } = await loadApi()
  const previousArgv = process.argv[1]
  const previousLog = process.env.PI_FAKE_LOG
  const previousPromptLog = process.env.PI_FAKE_PROMPT_LOG
  const previousMode = process.env.PI_FAKE_MODE
  const previousWrite = process.env.PI_FAKE_WRITE
  process.argv[1] = fakeScript
  process.env.PI_FAKE_LOG = argsLog
  process.env.PI_FAKE_PROMPT_LOG = promptLog
  process.env.PI_FAKE_MODE = mode
  // A relative name makes the fake child write into its own cwd (the worktree),
  // not the project root that the test created.
  process.env.PI_FAKE_WRITE = 'made-by-child.txt'
  try {
    return await tool.execute('call-worktree', params, undefined, undefined, { cwd: repo })
  } finally {
    process.argv[1] = previousArgv
    if (previousLog === undefined) delete process.env.PI_FAKE_LOG
    else process.env.PI_FAKE_LOG = previousLog
    if (previousPromptLog === undefined) delete process.env.PI_FAKE_PROMPT_LOG
    else process.env.PI_FAKE_PROMPT_LOG = previousPromptLog
    if (previousMode === undefined) delete process.env.PI_FAKE_MODE
    else process.env.PI_FAKE_MODE = previousMode
    if (previousWrite === undefined) delete process.env.PI_FAKE_WRITE
    else process.env.PI_FAKE_WRITE = previousWrite
  }
}

test('a worktree task runs in its own directory and is cleaned up when the child changes nothing', async () => {
  const repo = makeRepo('clean-repo')
  const result = await runTask(repo, { task: 'Report the working directory', worktree: true })
  assert.equal(result.isError, false)
  const child = result.details!.results[0]!
  assert.equal(child.status, 'completed')
  assert.ok(child.worktree, 'the result reports the worktree')
  assert.equal(child.worktree!.kept, false, 'a clean worktree is removed')
  assert.match(child.worktree!.branch, /^pi-subagent\/pi-subagent-/)
  assert.ok(!existsSync(child.worktree!.path), 'the worktree directory is gone')
  assert.notEqual(child.output, repo, 'the child ran somewhere other than the project root')
  assert.ok(child.output.includes('.pi'), 'the child cwd is under the project .pi directory')
  assert.equal(readFileSync(path.join(repo, 'README.md'), 'utf8'), 'seed\n', 'the project file is untouched')
  // info/exclude keeps the worktree root out of git status. The path git
  // reports is relative to the repo, so resolve it before reading.
  const exclude = path.resolve(repo, git(repo, 'rev-parse', '--git-path', 'info/exclude'))
  assert.match(readFileSync(exclude, 'utf8'), /\/\.pi\/worktrees\//)
})

test('a worktree with child changes is kept and its branch is reported', async () => {
  const repo = makeRepo('dirty-repo')
  const result = await runTask(repo, { task: 'Create a file', worktree: true }, 'write')
  assert.equal(result.isError, false)
  const child = result.details!.results[0]!
  assert.equal(child.status, 'completed')
  assert.ok(child.worktree)
  assert.equal(child.worktree!.kept, true, 'a worktree with changes is preserved')
  assert.match(child.worktree!.reason, /uncommitted changes/)
  assert.ok(existsSync(child.worktree!.path), 'the worktree directory remains')
  assert.ok(existsSync(path.join(child.worktree!.path, 'made-by-child.txt')), 'the child wrote inside the worktree')
  assert.ok(!existsSync(path.join(repo, 'made-by-child.txt')), 'the project root was not touched')
  assert.ok(git(repo, 'branch', '--list', child.worktree!.branch).length > 0, 'the branch exists')
})

test('two parallel write tasks get separate worktrees', async () => {
  const repo = makeRepo('parallel-repo')
  const result = await runTask(repo, {
    tasks: [
      { task: 'Create a file', worktree: true },
      { task: 'Create a file', worktree: true }
    ],
    worktree: true
  }, 'write')
  assert.equal(result.isError, false)
  const children = result.details!.results
  assert.equal(children.length, 2)
  assert.ok(children[0]!.worktree && children[1]!.worktree)
  assert.notEqual(children[0]!.worktree!.path, children[1]!.worktree!.path, 'the children ran in different directories')
  assert.notEqual(children[0]!.output, children[1]!.output, 'the children reported different cwds')
})

test('worktree fails fast outside a git repository', async () => {
  // Outside the project tree: the project root itself is a git repository, so
  // a directory inside it would still make git rev-parse succeed by walking up.
  const notRepo = mkdtempSync(path.join(os.tmpdir(), 'pi-not-a-repo-'))
  try {
    const result = await runTask(notRepo, { task: 'Do something', worktree: true })
    assert.equal(result.isError, true)
    const child = result.details!.results[0]!
    assert.equal(child.status, 'failed')
    assert.match(child.errorMessage ?? '', /requires a git repository|not a git repository|git rev-parse/i)
    assert.ok(!existsSync(path.join(notRepo, '.pi', 'worktrees')), 'nothing was created')
  } finally {
    rmSync(notRepo, { recursive: true, force: true })
  }
})

test('the removal command only accepts a generated worktree name', async () => {
  const { commands } = await loadApi()
  const remove = commands.get('desktop-subagent-worktree-remove')!
  await assert.rejects(() => remove.handler('../escape'), /Usage:/)
  await assert.rejects(() => remove.handler(''), /Usage:/)
  await assert.rejects(() => remove.handler('Not A Slug'), /Usage:/)
})

test('worktree is opt-in: a normal task still runs in the project root', async () => {
  const repo = makeRepo('plain-repo')
  const result = await runTask(repo, { task: 'Report the working directory' })
  assert.equal(result.isError, false)
  const child = result.details!.results[0]!
  assert.equal(child.worktree, undefined)
  assert.equal(child.output, repo)
})
