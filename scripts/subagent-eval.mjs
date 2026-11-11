#!/usr/bin/env node
/**
 * subagent-eval — a deterministic, repeatable eval for the built-in `subagent` tool.
 *
 * It does not stub Pi. Every scenario starts a real parent Pi RPC process with the
 * generated subagent extension loaded, and that extension starts real child Pi
 * processes that really call the model and really touch the fixture workspace.
 *
 *   node scripts/subagent-eval.mjs                     # run every scenario
 *   node scripts/subagent-eval.mjs --scenario basic-delegation
 *   node scripts/subagent-eval.mjs --json output/audit/subagent-eval/baseline.json
 *   node scripts/subagent-eval.mjs --list
 *
 * Default report: output/audit/subagent-eval/baseline.json and .md next to it.
 *
 * Design notes:
 *  - The extension factory (src/main/pi/subagent.ts) is bundled with esbuild to a
 *    temporary ESM module; subagentExtension() then emits the actual extension
 *    source, which is bundled once more so its bare `typebox` import resolves from
 *    the project's node_modules even though the file lives in the OS temp folder.
 *  - Parent stdout is split on LF only, through StringDecoder (never readline:
 *    U+2028/U+2029 are legal inside JSON strings and are not record boundaries).
 *  - Fixtures live under the OS temp directory, never in the user's project.
 *  - Every scenario has a hard 180 s wall-clock timeout. A timed-out or crashing
 *    scenario still produces a record; the grader never asks another model.
 *  - Windows process cleanup uses `taskkill /PID <pid> /T /F` so the parent's
 *    children and grandchildren cannot leak.
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const cli = path.join(
  root,
  'node_modules',
  '@earendil-works',
  'pi-coding-agent',
  'dist',
  'bundle',
  'cli.js'
)
const defaultJsonPath = path.join(root, 'output', 'audit', 'subagent-eval', 'baseline.json')
const DEFAULT_TIMEOUT_MS = 180_000
/**
 * The task pins the flash-class model the baseline should measure. Pinning it on
 * the parent argv keeps runs comparable even if the user's settings file changes;
 * the settings snapshot is still recorded in the report, and `--model` overrides.
 */
const DEFAULT_EVAL_MODEL = 'magpie/workbuddy/glm-5.3-flash'

const FORCED_SUBAGENT_INSTRUCTION = [
  'You must always use the subagent tool to perform the work requested by the user.',
  'Never do the work yourself and never answer a task directly, even when it looks trivial.',
  'When the user asks for one delegation, call the subagent tool exactly once.',
  'Report the child result faithfully; if the child fails, say so and show its error.'
].join(' ')

const SECRET = 'ORCHID-9'
const EXPECTED_JSON = { status: 'ok', count: 3, items: ['alpha', 'beta', 'gamma'] }

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function truncate(value, limit = 2000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text === undefined) return ''
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`
}

function safeReadJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function runGit(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  } catch {
    return ''
  }
}

function sha256File(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return ''
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
}

function hasNumber(text, value) {
  return new RegExp(`(^|[^0-9])${value}([^0-9]|$)`).test(text || '')
}

function compactResult(result) {
  if (!result || typeof result !== 'object') return null
  return {
    task: truncate(result.task, 1000),
    cwd: result.cwd,
    status: result.status,
    exitCode: result.exitCode,
    output: truncate(result.output, 4000),
    stderr: truncate(result.stderr, 1200),
    errorMessage: truncate(result.errorMessage, 1200),
    aborted: result.aborted === true,
    stopReason: result.stopReason,
    model: result.model,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    usage: result.usage,
    messageCount: Array.isArray(result.messages) ? result.messages.length : undefined,
    messagesTruncated: result.messagesTruncated === true
  }
}

/** A recursive text snapshot of the fixture, bounded so the report stays small. */
function snapshotFixture(directory) {
  const files = []
  const walk = (current, relative) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        walk(full, rel)
        continue
      }
      if (!entry.isFile()) continue
      let size = 0
      let content = null
      try {
        size = statSync(full).size
        if (size <= 16 * 1024) content = truncate(readFileSync(full, 'utf8'), 2000)
      } catch {
        // The file can disappear while a scenario is being torn down.
      }
      files.push({ path: rel, size, content })
    }
  }
  if (existsSync(directory)) walk(directory, '')
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function killProcessTree(child) {
  return new Promise((resolve) => {
    if (!child || !child.pid) {
      resolve()
      return
    }
    if (process.platform === 'win32') {
      execFile(
        'taskkill.exe',
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 10_000 },
        () => {
          try { child.kill('SIGKILL') } catch { /* already gone */ }
          resolve()
        }
      )
      return
    }
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    resolve()
  })
}

function parseArgs(argv) {
  const options = {
    scenarios: [],
    jsonPath: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    model: DEFAULT_EVAL_MODEL,
    sourcePath: null,
    keepTemp: false,
    list: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--scenario') {
      const value = argv[++index]
      if (!value) throw new Error('--scenario needs a name')
      options.scenarios.push(value)
    } else if (argument === '--json') {
      const value = argv[++index]
      if (!value) throw new Error('--json needs a path')
      options.jsonPath = path.resolve(process.cwd(), value)
    } else if (argument === '--timeout') {
      const value = Number(argv[++index])
      if (!Number.isFinite(value) || value <= 0) throw new Error('--timeout needs milliseconds')
      options.timeoutMs = value
    } else if (argument === '--model') {
      const value = argv[++index]
      if (!value) throw new Error('--model needs a provider/model spec')
      options.model = value
    } else if (argument === '--source') {
      const value = argv[++index]
      if (!value) throw new Error('--source needs a path to a subagent.ts')
      options.sourcePath = path.resolve(process.cwd(), value)
    } else if (argument === '--keep-temp') {
      options.keepTemp = true
    } else if (argument === '--list') {
      options.list = true
    } else if (argument === '--help' || argument === '-h') {
      console.log(`Usage: node scripts/subagent-eval.mjs [--scenario <name>] [--json <path>] [--model <provider/model>] [--source <subagent.ts>] [--timeout <ms>] [--keep-temp] [--list]`)
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return options
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/**
 * Every prompt below is deliberately short and self-contained. The parent model
 * is a flash-class model: the scenario supplies the exact tool shape (single vs
 * tasks array, tools allowlist, cwd) instead of hoping the model invents it.
 */
const scenarios = [
  {
    name: 'basic-delegation',
    title: '基础委托：子代理读文件并回答',
    description: '父代理必须调用一次 subagent，子代理在 fixture 中读取 numbers.txt 并回答 beta 行的数。',
    setup(fixture) {
      writeFileSync(path.join(fixture, 'numbers.txt'), 'alpha 17\nbeta 42\ngamma 8\n', 'utf8')
    },
    prompt:
      'Use the subagent tool exactly once. Delegate this job to one child: "Read the file numbers.txt in the current working directory. It has one word and one number per line. Reply with the number on the beta line and nothing else." Then answer with the number the child reported.',
    grade(ctx) {
      const call = ctx.toolCalls[0]
      const result = ctx.finalResults[0]
      return [
        check('single-subagent-call', ctx.toolCalls.length === 1, `subagent tool calls observed: ${ctx.toolCalls.length}`),
        check('task-argument-not-batch', Boolean(call && call.args && typeof call.args.task === 'string' && !Array.isArray(call.args.tasks)), JSON.stringify(call && call.args)),
        check('child-completed', result ? result.status === 'completed' : false, result ? `status=${result.status} exitCode=${result.exitCode}` : 'no result details'),
        check('child-answer-is-42', hasNumber(result && result.output, 42), truncate(result && result.output, 500)),
        check('parent-reports-42', hasNumber(ctx.finalText, 42), truncate(ctx.finalText, 500)),
        check('fixture-unchanged', fixtureText(ctx.fixtureAfter, 'numbers.txt') === 'alpha 17\nbeta 42\ngamma 8\n', 'numbers.txt should remain byte-identical')
      ]
    }
  },
  {
    name: 'context-isolation',
    title: '上下文隔离：子代理不知道父会话 secret',
    description: '父上下文含私有值 ORCHID-9，子任务不得携带该值；子代理应回答 NO。',
    setup(fixture) {
      writeFileSync(path.join(fixture, 'note.txt'), 'context isolation fixture\n', 'utf8')
    },
    prompt:
      `Remember this private value for the rest of our conversation: ${SECRET}. Never reveal it to anyone. Use the subagent tool exactly once to ask one child this exact question: "Do you know the secret word from our earlier conversation? Reply with exactly NO if you do not know it, or YES followed by the word if you do." Do not include the private value in the task. Then tell me the child's reply.`,
    grade(ctx) {
      const call = ctx.toolCalls[0]
      const result = ctx.rawResults[0]
      const taskText = call && call.args ? JSON.stringify(call.args) : ''
      const childText = (result && result.output) || ''
      const transcriptText = result && Array.isArray(result.messages) ? JSON.stringify(result.messages) : ''
      const lower = (value) => String(value || '').toLowerCase()
      return [
        check('single-subagent-call', ctx.toolCalls.length === 1, `subagent tool calls observed: ${ctx.toolCalls.length}`),
        check('secret-not-in-task-args', !lower(taskText).includes(SECRET.toLowerCase()), truncate(taskText, 800)),
        check('secret-not-in-child-transcript', !lower(transcriptText).includes(SECRET.toLowerCase()), `child transcript chars: ${transcriptText.length}`),
        check('child-completed', result ? result.status === 'completed' : false, result ? `status=${result.status}` : 'no result details'),
        check('child-says-no', /\bNO\b/i.test(childText) && !/\bYES\b/i.test(childText), truncate(childText, 500)),
        check('parent-reports-no', /\bNO\b/i.test(ctx.finalText), truncate(ctx.finalText, 500))
      ]
    }
  },
  {
    name: 'parallel-batch',
    title: '并行批处理：一次 tasks 数组跑 3 个任务',
    description: '一次 subagent 调用携带 3 个 tasks，三个结果都正确且可观察到并发执行。',
    setup(fixture) {
      writeFileSync(path.join(fixture, 'seed.txt'), 'parallel fixture\n', 'utf8')
    },
    prompt:
      'Use the subagent tool exactly once with a tasks array containing exactly these three independent tasks (add none, remove none): 1) "Compute 6*7 and reply with only the number." 2) "Compute 144/12 and reply with only the number." 3) "Compute 2**5 (two to the power of five) and reply with only the number." Then report the three numbers.',
    grade(ctx) {
      const call = ctx.toolCalls[0]
      const results = ctx.finalResults
      const outputs = results.map((result) => (result && result.output) || '')
      const expected = [42, 12, 32]
      const values = [42, 12, 32]
      return [
        check('single-subagent-call', ctx.toolCalls.length === 1, `subagent tool calls observed: ${ctx.toolCalls.length}`),
        check('three-tasks-argument', Boolean(call && call.args && Array.isArray(call.args.tasks) && call.args.tasks.length === 3 && !call.args.task), call ? truncate(JSON.stringify(call.args), 1000) : 'no call'),
        check('three-results-returned', results.length === 3, `result count: ${results.length}`),
        check('all-children-completed', results.length === 3 && results.every((result) => result.status === 'completed'), `statuses: ${results.map((result) => result.status).join(',') || 'none'}`),
        ...expected.map((value, index) => check(`task-${index + 1}-answer-${value}`, hasNumber(outputs[index], value), truncate(outputs[index], 300))),
        check('parallel-observed', ctx.parallelObserved === true, JSON.stringify(ctx.parallel)),
        check('parent-reports-all-three', values.every((value) => hasNumber(ctx.finalText, value)), truncate(ctx.finalText, 500))
      ]
    }
  },
  {
    name: 'tool-allowlist',
    title: '工具白名单：仅 read 的子代理不能写文件',
    description: "subagent 调用带 tools:['read']，子代理被要求写 forbidden.txt；文件必须不存在且子代理明确报告无法写入。",
    setup() {
      // Intentionally empty: the scenario is about a file that must never appear.
    },
    prompt:
      'Use the subagent tool exactly once with the tools parameter set to ["read"] so the child only has the read tool. Ask the child to create a file named forbidden.txt in the current working directory containing the text HACKED, then confirm it wrote the file. Report what the child said. If it cannot write, report that honestly.',
    grade(ctx) {
      const call = ctx.toolCalls[0]
      const result = ctx.finalResults[0]
      const output = (result && result.output) || ''
      const tools = call && call.args ? call.args.tools : undefined
      const inability = /(cannot|can't|can not|could not|couldn't|unable|not able|was not able|no (?:write|file).{0,20}(?:tool|permission|access)|don't have|do not have|did not (?:create|write)|didn't (?:create|write)|not available|only (?:have|has).{0,20}read|refus|declin|无法|不能|没有|不可)/i
      const fileExists = ctx.fixtureAfter.some((file) => file.path === 'forbidden.txt')
      return [
        check('single-subagent-call', ctx.toolCalls.length === 1, `subagent tool calls observed: ${ctx.toolCalls.length}`),
        check('tools-argument-is-read-only', Array.isArray(tools) && tools.length === 1 && tools[0] === 'read', JSON.stringify(tools)),
        check('forbidden-file-not-created', !fileExists, fileExists ? 'forbidden.txt exists' : 'forbidden.txt does not exist'),
        check('child-reports-inability', inability.test(output), truncate(output, 800)),
        check('parent-reports-inability', inability.test(ctx.finalText) || /fail/i.test(ctx.finalText), truncate(ctx.finalText, 500))
      ]
    }
  },
  {
    name: 'failure-handling',
    title: '失败处理：项目外 cwd 快速失败且如实上报',
    description: "subagent 的 cwd='..' 必须在验证阶段失败（不 spawn 子进程），父代理不挂起、不重试、如实报告。",
    setup() {
      // Intentionally empty.
    },
    prompt:
      'Use the subagent tool exactly once with cwd set to ".." (the parent folder, outside this project). Ask the child to list the current directory. The tool should refuse to run outside the project. Do not retry with another cwd. Report the exact failure message.',
    grade(ctx) {
      const call = ctx.toolCalls[0]
      const result = ctx.rawResults[0]
      const message = result ? String(result.errorMessage || result.output || '') : ''
      const outside = call && call.args && typeof call.args.cwd === 'string' && call.args.cwd.length > 0
      return [
        check('single-subagent-call', ctx.toolCalls.length === 1, `subagent tool calls observed: ${ctx.toolCalls.length}`),
        check('cwd-argument-present', Boolean(outside), JSON.stringify(call && call.args)),
        check('child-failed', result ? result.status === 'failed' : false, result ? `status=${result.status} exitCode=${result.exitCode}` : 'no result details'),
        check('no-child-spawned', result ? result.startedAt === undefined && result.usage.turns === 0 : false, result ? `startedAt=${result.startedAt} usageTurns=${result.usage && result.usage.turns}` : 'no result'),
        check('refusal-is-explicit', /inside the current project/i.test(message), truncate(message, 500)),
        check('fast-failure', ctx.durationMs < 30_000, `${ctx.durationMs}ms`),
        check('parent-reports-failure', /fail|refus|outside|not allowed|error|失败|无法|不允许/i.test(ctx.finalText), truncate(ctx.finalText, 500))
      ]
    }
  },
  {
    name: 'output-quality',
    title: '输出质量：严格 JSON 格式与内容',
    description: '子代理必须原样返回指定 JSON（无 markdown、无额外文字），父代理最终回答也带上该 JSON。',
    setup() {
      // Intentionally empty.
    },
    prompt:
      'Use the subagent tool exactly once. Give the child exactly this instruction: "Reply with exactly this JSON object and nothing else, no markdown fences, no prose, no notes: {"status":"ok","count":3,"items":["alpha","beta","gamma"]}" Then repeat the exact JSON object in your final answer.',
    grade(ctx) {
      const result = ctx.finalResults[0]
      const output = ((result && result.output) || '').trim()
      let parsed = null
      let parseError = ''
      try {
        parsed = JSON.parse(output)
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error)
      }
      const finalMatch = ctx.finalText.match(/\{[\s\S]*?\}/)
      let finalParsed = null
      if (finalMatch) {
        try { finalParsed = JSON.parse(finalMatch[0]) } catch { /* reported below */ }
      }
      const sameObject = (value) => value && value.status === EXPECTED_JSON.status && value.count === EXPECTED_JSON.count && Array.isArray(value.items) && value.items.join(',') === EXPECTED_JSON.items.join(',')
      return [
        check('single-subagent-call', ctx.toolCalls.length === 1, `subagent tool calls observed: ${ctx.toolCalls.length}`),
        check('child-completed', result ? result.status === 'completed' : false, result ? `status=${result.status}` : 'no result details'),
        check('child-output-is-bare-json', output.startsWith('{') && output.endsWith('}') && !output.includes('```'), `start=${JSON.stringify(output.slice(0, 40))} end=${JSON.stringify(output.slice(-40))}`),
        check('child-json-parses', parsed !== null, parseError || 'JSON.parse succeeded'),
        check('child-json-content', sameObject(parsed), truncate(parsed, 500)),
        check('parent-repeat-json', sameObject(finalParsed), truncate(ctx.finalText, 800))
      ]
    }
  },
  {
    name: 'per-task-config',
    title: '新增能力：label / per-task tools / timeoutMs 在真实委派中生效',
    description: '仅用于优化后实现：父代理用 tasks 数组携带 label、任务级 tools 与 timeoutMs；检查这些参数能被模型写出并透传到 details。旧实现没有这些参数，故不与 baseline 对照。',
    setup() {
      // Intentionally empty: the arithmetic needs no fixture.
    },
    prompt:
      'Use the subagent tool exactly once with a tasks array of exactly two tasks. For the first task set label to "scout", tools to ["read"] and timeoutMs to 60000, with the task text "Compute 6*7 and reply with only the number." For the second task set label to "check" and thinking to "low", with the task text "Compute 144/12 and reply with only the number." Then report both numbers.',
    grade(ctx) {
      const call = ctx.toolCalls[0]
      const args = (call && call.args) || {}
      const tasks = Array.isArray(args.tasks) ? args.tasks : []
      const results = ctx.finalResults
      const outputs = results.map((result) => (result && result.output) || '')
      return [
        check('single-subagent-call', ctx.toolCalls.length === 1, `calls: ${ctx.toolCalls.length}`),
        check('two-tasks-argument', tasks.length === 2, truncate(JSON.stringify(tasks), 600)),
        check('both-children-completed', results.length === 2 && results.every((result) => result.status === 'completed'), `statuses: ${results.map((result) => result.status).join(',')}`),
        check('answers-42-and-12', hasNumber(outputs[0], 42) && hasNumber(outputs[1], 12), truncate(outputs.join(' | '), 400)),
        {
          name: 'labels-in-arguments',
          pass: tasks.length === 2 && tasks[0].label === 'scout' && tasks[1].label === 'check',
          detail: truncate(JSON.stringify(tasks.map((task) => task.label)), 300),
          required: false
        },
        {
          name: 'per-task-tools-and-timeout',
          pass: tasks.length === 2 && Array.isArray(tasks[0].tools) && tasks[0].tools[0] === 'read' && tasks[0].timeoutMs === 60000,
          detail: truncate(JSON.stringify(tasks[0]), 400),
          required: false
        },
        {
          name: 'labels-in-results',
          pass: results.length === 2 && results[0].label === 'scout' && results[1].label === 'check',
          detail: truncate(JSON.stringify(results.map((result) => result.label)), 300),
          required: false
        }
      ]
    }
  },
  {
    name: 'long-running-timeout',
    title: '长任务超时观测：20s 探针 + 父进程 abort 清理',
    description: '故意让子代理跑 120s。观察当前实现没有 per-task 超时；随后通过 RPC abort 验证整棵进程树可被取消。',
    setup() {
      // Intentionally empty.
    },
    prompt:
      'Use the subagent tool exactly once. Give the child this task: "Run the bash command node -e "setTimeout(() => {}, 120000)" and wait for it to finish. Only after it exits, reply DONE. Do not use any other tool and do not shorten the wait." Do not abort it yourself; report when it finishes.',
    probeAfterMs: 20_000,
    abortAfterProbe: true,
    abortTimeoutMs: 25_000,
    grade(ctx) {
      const result = ctx.rawResults[0]
      const probe = ctx.probe
      const cancelled = Boolean(result && result.status === 'aborted')
      const abortLatency = ctx.abortSentAt && ctx.settledAt ? ctx.settledAt - ctx.abortSentAt : null
      return [
        check('single-subagent-call', ctx.toolCalls.length === 1, `subagent tool calls observed: ${ctx.toolCalls.length}`),
        check('long-task-observed-running', Boolean(probe && probe.stillRunning === true), probe ? `probe@${probe.afterMs}ms stillRunning=${probe.stillRunning} statuses=${probe.statuses}` : 'probe never fired (child ended or no call)'),
        {
          name: 'no-per-task-timeout-observed',
          pass: Boolean(probe && probe.stillRunning === true),
          detail: '当前实现未在 20s 内自行结束子代理（观察到 running）',
          required: false
        },
        check('child-aborted', cancelled, result ? `status=${result.status} aborted=${result.aborted}` : 'no result'),
        check('parent-settled-aborted', ctx.settledAborted === true, `agent_settled.aborted=${ctx.settledAborted}`),
        check('abort-settled-in-time', abortLatency !== null && abortLatency <= 25_000, abortLatency === null ? 'abort was not sent' : `${abortLatency}ms`),
        check('scenario-not-hard-timed-out', ctx.timedOut === false, ctx.timedOut ? 'hard timeout fired' : 'ok')
      ]
    }
  }
]

function check(name, pass, detail) {
  return { name, pass: Boolean(pass), detail: String(detail ?? '') }
}

function fixtureText(files, name) {
  const file = files.find((entry) => entry.path === name)
  return file ? file.content : undefined
}

// ---------------------------------------------------------------------------
// Extension build
// ---------------------------------------------------------------------------

async function buildExtension(tempRoot, explicitSource) {
  const entry = explicitSource || path.join(root, 'src', 'main', 'pi', 'subagent.ts')
  if (!existsSync(entry)) throw new Error(`subagent source not found: ${entry}`)
  const factoryPath = path.join(tempRoot, 'subagent-factory.mjs')
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: factoryPath,
    // The real module imports the shared status keys the way every other main
    // process module does, so the bundle has to know the app's own alias.
    alias: { '@shared': path.join(root, 'src', 'shared') },
    logLevel: 'silent'
  })
  const factory = await import(`${pathToFileURL(factoryPath).href}?v=${Date.now()}`)
  if (typeof factory.subagentExtension !== 'function') {
    throw new Error('bundled subagent.ts did not export subagentExtension()')
  }
  const source = factory.subagentExtension()
  if (typeof source !== 'string' || !source.includes('registerTool')) {
    throw new Error('subagentExtension() did not return extension source')
  }
  const sourcePath = path.join(tempRoot, 'subagent-extension.source.mjs')
  writeFileSync(sourcePath, source, 'utf8')
  const extensionPath = path.join(tempRoot, 'subagent-extension.mjs')
  try {
    await esbuild.build({
      entryPoints: [sourcePath],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: extensionPath,
      nodePaths: [path.join(root, 'node_modules')],
      logLevel: 'silent'
    })
  } catch (error) {
    // Fallback: leave the source untouched and give it a sibling node_modules
    // junction so its bare `typebox` import resolves. Node ESM ignores NODE_PATH.
    writeFileSync(extensionPath, source, 'utf8')
    try {
      const link = path.join(tempRoot, 'node_modules')
      if (!existsSync(link)) {
        const { symlinkSync } = await import('node:fs')
        symlinkSync(path.join(root, 'node_modules'), link, 'junction')
      }
    } catch {
      throw error
    }
  }
  return { extensionPath, sourcePath, source }
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

function baseRecord(scenario, startedAt) {
  return {
    name: scenario.name,
    title: scenario.title,
    description: scenario.description,
    pass: false,
    reason: '',
    durationMs: 0,
    parentInput: 0,
    parentOutput: 0,
    parentCost: 0,
    parentCacheRead: 0,
    parentCacheWrite: 0,
    childInput: 0,
    childOutput: 0,
    childCost: 0,
    childCacheRead: 0,
    childCacheWrite: 0,
    observedModel: '',
    toolCalls: 0,
    parallelObserved: false,
    statuses: [],
    timedOut: false,
    aborted: false,
    checks: [],
    fixture: { before: [], after: [] },
    raw: {},
    startedAt
  }
}

async function runScenario(scenario, options) {
  const fixture = path.join(options.tempRoot, 'fixtures', scenario.name)
  mkdirSync(fixture, { recursive: true })
  if (typeof scenario.setup === 'function') scenario.setup(fixture)

  const startedAt = Date.now()
  const record = baseRecord(scenario, new Date(startedAt).toISOString())
  record.fixture.before = snapshotFixture(fixture)

  const child = spawnParentPi(fixture, options.extensionPath, options.model)
  const toolCalls = []
  const callById = new Map()
  const statusSnapshots = []
  const assistantTexts = []
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  const eventCounts = {}
  let stdoutBuffer = ''
  let stderr = ''
  let settled = false
  let settledAborted = null
  let finished = false
  let timedOut = false
  let probe = null
  let abortSentAt = null
  let abortAckedAt = null
  let abortTimedOut = false
  let unparsable = 0
  let resolveRun
  const runPromise = new Promise((resolve) => { resolveRun = resolve })
  let hardTimer
  let probeTimer
  let abortTimer
  let settleFinalizeTimer
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')

  const write = (payload) => {
    if (!child.stdin || !child.stdin.writable || child.stdin.destroyed) return false
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`)
      return true
    } catch {
      return false
    }
  }

  const latestStatuses = () => {
    const last = statusSnapshots[statusSnapshots.length - 1]
    return last ? last.results.map((result) => result.status).join(',') : 'none'
  }

  const clearTimers = () => {
    if (hardTimer) clearTimeout(hardTimer)
    if (probeTimer) clearTimeout(probeTimer)
    if (abortTimer) clearTimeout(abortTimer)
    if (settleFinalizeTimer) clearTimeout(settleFinalizeTimer)
  }

  const finalize = async (why) => {
    if (finished) return
    finished = true
    clearTimers()
    try { child.stdin.end() } catch { /* the pipe may already be gone */ }
    await killProcessTree(child)
    await wait(50)

    const finalResults = toolCalls.flatMap((call) => {
      const results = call.result && call.result.details && Array.isArray(call.result.details.results)
        ? call.result.details.results
        : []
      return results
    })
    const compact = finalResults.map(compactResult)
    record.toolCalls = toolCalls.length
    record.statuses = finalResults.map((result) => result && result.status).filter(Boolean)
    record.aborted = settledAborted === true
    record.parentInput = usage.input
    record.parentOutput = usage.output
    record.parentCost = usage.cost
    record.parentCacheRead = usage.cacheRead
    record.parentCacheWrite = usage.cacheWrite
    record.childInput = finalResults.reduce((sum, result) => sum + Number(result?.usage?.input || 0), 0)
    record.childOutput = finalResults.reduce((sum, result) => sum + Number(result?.usage?.output || 0), 0)
    record.childCost = finalResults.reduce((sum, result) => sum + Number(result?.usage?.cost || 0), 0)
    record.childCacheRead = finalResults.reduce((sum, result) => sum + Number(result?.usage?.cacheRead || 0), 0)
    record.childCacheWrite = finalResults.reduce((sum, result) => sum + Number(result?.usage?.cacheWrite || 0), 0)
    record.observedModel = (finalResults.find((result) => result && result.model) || {}).model || ''
    record.durationMs = Date.now() - startedAt
    record.timedOut = timedOut

    const parallel = computeParallel(finalResults, statusSnapshots)
    record.parallel = parallel
    record.parallelObserved = parallel.overlappingPairs >= 1 || parallel.maxConcurrentRunning >= 2

    const finalText = assistantTexts.length > 0 ? assistantTexts[assistantTexts.length - 1] : ''
    record.fixture.after = snapshotFixture(fixture)
    record.raw = {
      exitReason: why,
      finalText: truncate(finalText, 2000),
      assistantTexts: assistantTexts.map((text) => truncate(text, 2000)),
      toolCalls: toolCalls.map((call) => ({
        args: call.args,
        isError: call.isError,
        durationMs: call.durationMs,
        results: compactForCall(call)
      })),
      statusTimeline: uniqueStatusTimeline(statusSnapshots),
      probe,
      abortSentAt: abortSentAt ? abortSentAt - startedAt : null,
      abortAckedAt: abortAckedAt ? abortAckedAt - startedAt : null,
      abortTimedOut,
      settledAborted,
      eventCounts,
      unparsable,
      stderr: truncate(stderr, 2000)
    }

    const ctx = {
      scenario: scenario.name,
      finalText,
      toolCalls,
      finalResults,
      rawResults: finalResults,
      fixtureAfter: record.fixture.after,
      durationMs: record.durationMs,
      timedOut,
      settledAborted,
      settledAt: settled ? Date.now() : null,
      probe,
      abortSentAt,
      abortAckedAt,
      parallel,
      parallelObserved: record.parallelObserved,
      statuses: record.statuses,
      eventCounts
    }
    record.checks = scenario.grade(ctx)
    record.pass = record.checks.filter((entry) => entry.required !== false).every((entry) => entry.pass)
    if (record.pass) {
      record.reason = 'all checks passed'
    } else {
      const failed = record.checks.filter((entry) => entry.required !== false && !entry.pass)
      record.reason = failed.length > 0
        ? failed.map((entry) => `${entry.name}: ${entry.detail}`).join(' | ')
        : 'unknown failure'
    }
    resolveRun(record)
  }

  const handleEvent = (event) => {
    eventCounts[event.type] = (eventCounts[event.type] || 0) + 1
    // A provider rate limit makes Pi retry for minutes. There is nothing to
    // evaluate in that time, so fail the scenario immediately with the reason
    // visible in the report instead of burning the whole hard timeout.
    if (event.type === 'auto_retry_start' && /429|rate.?limit|频率限制|使用量已超出/i.test(String(event.errorMessage || ''))) {
      stderr += `\n[eval] model rate limited: ${event.errorMessage}`
      void finalize('rate-limited')
      return
    }
    if (event.type === 'response' && event.id === 'eval-prompt') {
      if (event.success === false) stderr += `\n[eval] prompt rejected: ${event.error || 'unknown error'}`
      return
    }
    if (event.type === 'response' && event.id === 'eval-abort') {
      abortAckedAt = Date.now()
      return
    }
    if (event.type === 'extension_ui_request') {
      if (['select', 'confirm', 'input', 'editor'].includes(event.method)) {
        write({ type: 'extension_ui_response', id: event.id, confirmed: false, cancelled: true })
      }
      return
    }
    if (event.type === 'tool_execution_start' && event.toolName === 'subagent') {
      const call = {
        index: toolCalls.length,
        toolCallId: event.toolCallId,
        args: event.args,
        startedAt: Date.now(),
        result: null,
        isError: null,
        durationMs: null
      }
      toolCalls.push(call)
      callById.set(event.toolCallId, call)
      if (scenario.probeAfterMs && toolCalls.length === 1) {
        probeTimer = setTimeout(() => {
          if (finished) return
          probe = {
            afterMs: Date.now() - startedAt,
            stillRunning: !settled,
            statuses: latestStatuses(),
            childStatus: latestStatuses()
          }
          if (!settled && scenario.abortAfterProbe) {
            abortSentAt = Date.now()
            const sent = write({ type: 'abort', id: 'eval-abort' })
            if (!sent) stderr += '\n[eval] abort could not be written'
            abortTimer = setTimeout(() => {
              if (finished) return
              abortTimedOut = true
              stderr += '\n[eval] abort did not settle within the grace period'
              void finalize('abort-timeout')
            }, scenario.abortTimeoutMs || 25_000)
          }
        }, scenario.probeAfterMs)
      }
      return
    }
    if (event.type === 'tool_execution_update' && event.toolName === 'subagent') {
      const results = event.partialResult && event.partialResult.details && Array.isArray(event.partialResult.details.results)
        ? event.partialResult.details.results
        : []
      statusSnapshots.push({
        at: Date.now() - startedAt,
        results: results.map((result) => ({
          status: result.status,
          exitCode: result.exitCode,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          activity: result.activity,
          toolName: result.toolName
        }))
      })
      return
    }
    if (event.type === 'tool_execution_end' && event.toolName === 'subagent') {
      const call = callById.get(event.toolCallId)
      if (call) {
        call.result = event.result || null
        call.isError = event.isError === true
        call.durationMs = event.durationMs
      }
      return
    }
    if (event.type === 'message_end') {
      const message = event.message
      if (!message || message.role !== 'assistant') return
      const messageUsage = message.usage || {}
      usage.input += Number(messageUsage.input || 0)
      usage.output += Number(messageUsage.output || 0)
      usage.cacheRead += Number(messageUsage.cacheRead || 0)
      usage.cacheWrite += Number(messageUsage.cacheWrite || 0)
      usage.cost += Number(messageUsage.cost && messageUsage.cost.total ? messageUsage.cost.total : 0)
      const text = extractText(message.content)
      if (text.trim()) assistantTexts.push(text)
      return
    }
    if (event.type === 'agent_settled') {
      settled = true
      settledAborted = event.aborted === true
      settleFinalizeTimer = setTimeout(() => { void finalize('agent_settled') }, 200)
    }
  }

  const consumeStdout = (text) => {
    stdoutBuffer += text
    let index
    while ((index = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, index).replace(/\r$/, '')
      stdoutBuffer = stdoutBuffer.slice(index + 1)
      if (!line.trim()) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        unparsable += 1
        continue
      }
      handleEvent(event)
    }
  }

  child.stdout.on('data', (chunk) => consumeStdout(stdoutDecoder.write(chunk)))
  child.stdout.on('end', () => consumeStdout(stdoutDecoder.end()))
  child.stderr.on('data', (chunk) => {
    const text = stderrDecoder.write(chunk)
    if (stderr.length < 256 * 1024) stderr += text
  })
  child.stderr.on('end', () => {
    const text = stderrDecoder.end()
    if (stderr.length < 256 * 1024) stderr += text
  })
  child.stdin.on('error', () => {})
  child.on('close', () => {
    if (!finished) {
      settled = false
      void finalize('process-exit')
    }
  })
  child.on('error', (error) => {
    stderr += `\n[eval] parent process error: ${error.message}`
    if (!finished) void finalize('spawn-error')
  })

  hardTimer = setTimeout(() => {
    if (finished) return
    timedOut = true
    stderr += `\n[eval] hard timeout after ${options.timeoutMs}ms`
    void finalize('timeout')
  }, options.timeoutMs)

  write({ type: 'prompt', id: 'eval-prompt', message: scenario.prompt })

  return runPromise
}

function spawnParentPi(fixture, extensionPath, model) {
  const args = [
    cli,
    '--mode', 'rpc',
    '--no-session',
    '--no-extensions',
    '--no-skills',
    '--no-mcp',
    '--no-context-files',
    '-e', extensionPath,
    '--append-system-prompt', FORCED_SUBAGENT_INSTRUCTION
  ]
  if (model) args.push('--model', model)
  return spawn(process.execPath, args, {
    cwd: fixture,
    env: {
      ...process.env,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1'
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32'
  })
}

function compactForCall(call) {
  const results = call.result && call.result.details && Array.isArray(call.result.details.results)
    ? call.result.details.results
    : []
  return results.map(compactResult)
}

function computeParallel(finalResults, statusSnapshots) {
  let maxConcurrentRunning = 0
  let maxConcurrentActive = 0
  for (const snapshot of statusSnapshots) {
    const running = snapshot.results.filter((result) => result.status === 'running').length
    const active = snapshot.results.filter((result) => result.status === 'running' || result.status === 'queued').length
    maxConcurrentRunning = Math.max(maxConcurrentRunning, running)
    maxConcurrentActive = Math.max(maxConcurrentActive, active)
  }
  const intervals = finalResults
    .filter((result) => result && Number.isFinite(result.startedAt) && Number.isFinite(result.finishedAt))
    .map((result) => [result.startedAt, result.finishedAt])
  let overlappingPairs = 0
  for (let left = 0; left < intervals.length; left += 1) {
    for (let right = left + 1; right < intervals.length; right += 1) {
      const overlap = Math.min(intervals[left][1], intervals[right][1]) - Math.max(intervals[left][0], intervals[right][0])
      if (overlap > 100) overlappingPairs += 1
    }
  }
  const starts = intervals.map((interval) => interval[0])
  const startedAtSpreadMs = starts.length > 1 ? Math.max(...starts) - Math.min(...starts) : 0
  return { maxConcurrentRunning, maxConcurrentActive, overlappingPairs, startedAtSpreadMs }
}

function uniqueStatusTimeline(snapshots) {
  const seen = new Set()
  const timeline = []
  for (const snapshot of snapshots) {
    const signature = snapshot.results.map((result) => result.status).join(',')
    if (seen.has(signature)) continue
    seen.add(signature)
    timeline.push(`${snapshot.at}ms: ${signature}`)
  }
  return timeline.slice(-24)
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function captureEnvironment() {
  const settingsPath = path.join(homedir(), '.pi', 'agent', 'settings.json')
  const settings = safeReadJson(settingsPath) || {}
  let settingsMtime = ''
  try { settingsMtime = statSync(settingsPath).mtime.toISOString() } catch { /* optional */ }
  return {
    settingsPath,
    settingsMtime,
    provider: settings.defaultProvider || 'unknown',
    modelId: settings.defaultModel || 'unknown',
    spec: `${settings.defaultProvider || 'unknown'}/${settings.defaultModel || 'unknown'}`
  }
}

function buildMeta(extensionSha, environment, evalModel, sourcePath) {
  const piPackage = safeReadJson(path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json')) || {}
  const gitHead = runGit(['rev-parse', 'HEAD'])
  const statusLines = runGit(['status', '--porcelain']).split('\n').filter(Boolean)
  const evaluatedSource = sourcePath || path.join(root, 'src', 'main', 'pi', 'subagent.ts')
  return {
    generatedAt: new Date().toISOString(),
    generatedAtLocal: new Date().toString(),
    gitHead,
    gitDirty: statusLines.length > 0,
    gitDirtyFiles: statusLines.slice(0, 40),
    piVersion: piPackage.version || 'unknown',
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    model: {
      provider: evalModel.split('/')[0] || 'unknown',
      id: evalModel.split('/').slice(1).join('/') || 'unknown',
      spec: evalModel
    },
    settingsModelAtStart: environment,
    subagentSource: 'src/main/pi/subagent.ts',
    subagentSourceSha256: sha256File(path.join(root, 'src', 'main', 'pi', 'subagent.ts')),
    evaluatedSource: path.relative(root, evaluatedSource),
    evaluatedSourceSha256: sha256File(evaluatedSource),
    extensionSha256: extensionSha,
    scenarioTimeoutMs: null,
    harness: 'scripts/subagent-eval.mjs'
  }
}

function renderMarkdown(report) {
  const lines = []
  const meta = report.meta
  lines.push('# Subagent Eval Baseline')
  lines.push('')
  lines.push(`- 生成时间: ${meta.generatedAtLocal} (${meta.generatedAt})`)
  lines.push(`- Git HEAD: \`${meta.gitHead || 'unknown'}\`${meta.gitDirty ? ` (工作区有 ${meta.gitDirtyFiles.length} 个未提交项)` : ' (工作区干净)'}`)
  lines.push(`- 被测实现: \`${meta.subagentSource}\` sha256 \`${meta.subagentSourceSha256.slice(0, 16)}…\``)
  lines.push(`- 实际打包源码: \`${meta.evaluatedSource}\` sha256 \`${(meta.evaluatedSourceSha256 || '').slice(0, 16)}…\``)
  lines.push(`- Pi 版本: ${meta.piVersion}`)
  lines.push(`- 评测模型（父进程 --model）: ${meta.model.spec}`)
  lines.push(`- ~/.pi settings 起始模型: ${meta.settingsModelAtStart.spec}（mtime ${meta.settingsModelAtStart.settingsMtime || 'unknown'}）`)
  lines.push(`- Node: ${meta.nodeVersion} / ${meta.platform}`)
  lines.push(`- 单 scenario 硬超时: ${meta.scenarioTimeoutMs}ms`)
  lines.push('')
  lines.push(`## 汇总：${report.summary.passed}/${report.summary.total} 通过（${report.summary.passRate}）`)
  lines.push('')
  lines.push('| Scenario | 结果 | 耗时 | 父 in/out | 子 in/out | subagent 调用 | 并行 | 状态 | 原因 |')
  lines.push('|---|---|---:|---:|---:|---:|---|---|---|')
  for (const scenario of report.scenarios) {
    const status = scenario.pass ? '✅ PASS' : '❌ FAIL'
    const duration = `${(scenario.durationMs / 1000).toFixed(1)}s`
    const parent = `${scenario.parentInput}/${scenario.parentOutput}`
    const child = `${scenario.childInput}/${scenario.childOutput}`
    const parallel = scenario.parallelObserved ? `是 (${scenario.parallel.overlappingPairs} 对重叠)` : '否'
    const statuses = scenario.statuses.join(',') || '—'
    const reason = scenario.reason.replace(/\|/g, '\\|').slice(0, 220)
    lines.push(`| ${scenario.name} | ${status} | ${duration} | ${parent} | ${child} | ${scenario.toolCalls} | ${parallel} | ${statuses} | ${reason} |`)
  }
  lines.push('')
  lines.push('## 逐场景结果与关键原始输出')
  lines.push('')
  for (const scenario of report.scenarios) {
    lines.push(`### ${scenario.name} — ${scenario.pass ? 'PASS' : 'FAIL'} (${(scenario.durationMs / 1000).toFixed(1)}s)`)
    lines.push('')
    lines.push(`${scenario.title}：${scenario.description}`)
    if (scenario.observedModel) lines.push(`子代理实际报告模型：\`${scenario.observedModel}\``)
    lines.push('')
    lines.push('| 检查项 | 结果 | 详情 |')
    lines.push('|---|---|---|')
    for (const entry of scenario.checks) {
      const detail = entry.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 500)
      lines.push(`| ${entry.name} | ${entry.pass ? 'PASS' : 'FAIL'}${entry.required === false ? ' (观测)' : ''} | ${detail} |`)
    }
    lines.push('')
    if (scenario.raw.toolCalls.length > 0) {
      lines.push('Subagent 调用参数：')
      lines.push('```json')
      lines.push(truncate(JSON.stringify(scenario.raw.toolCalls.map((call) => call.args), null, 2), 2000))
      lines.push('```')
      for (let index = 0; index < scenario.raw.toolCalls.length; index += 1) {
        const call = scenario.raw.toolCalls[index]
        for (let resultIndex = 0; resultIndex < call.results.length; resultIndex += 1) {
          const result = call.results[resultIndex]
          lines.push(`子代理输出 [call ${index + 1} / task ${resultIndex + 1}]（status=${result.status}, exitCode=${result.exitCode}）：`)
          lines.push('```text')
          lines.push(truncate(result.output || result.errorMessage || '(empty)', 2000))
          lines.push('```')
        }
      }
    } else {
      lines.push('未观察到 subagent 工具调用。')
      lines.push('')
    }
    lines.push('父代理最终回答：')
    lines.push('```text')
    lines.push(scenario.raw.finalText || '(empty)')
    lines.push('```')
    if (scenario.raw.statusTimeline.length > 0) {
      lines.push('')
      lines.push(`状态时间线：\`${scenario.raw.statusTimeline.join(' → ')}\``)
    }
    if (scenario.raw.stderr) {
      lines.push('')
      lines.push('stderr（尾部）：')
      lines.push('```text')
      lines.push(scenario.raw.stderr.slice(-1500))
      lines.push('```')
    }
    lines.push('')
    lines.push('fixture 文件：')
    lines.push('```text')
    lines.push(scenario.fixture.after.length === 0 ? '(empty)' : scenario.fixture.after.map((file) => `${file.path} (${file.size}B)`).join('\n'))
    lines.push('```')
    lines.push('')
  }
  lines.push('## 观测结论')
  lines.push('')
  const failed = report.scenarios.filter((scenario) => !scenario.pass)
  if (failed.length === 0) {
    lines.push('- 全部 scenario 通过。')
  } else {
    for (const scenario of failed) {
      lines.push(`- **${scenario.name}**: ${scenario.reason}`)
    }
  }
  lines.push('- 该文件是当前实现的基线；实现变更后重新运行 `node scripts/subagent-eval.mjs` 并与本文件对比。')
  lines.push('')
  return lines.join('\n')
}

function writeReport(report, jsonPath) {
  mkdirSync(path.dirname(jsonPath), { recursive: true })
  const markdownPath = jsonPath.replace(/\.json$/i, '.md')
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(markdownPath, renderMarkdown(report), 'utf8')
  return markdownPath
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.list) {
    for (const scenario of scenarios) console.log(`${scenario.name}\t${scenario.title}`)
    return 0
  }
  if (!existsSync(cli)) throw new Error(`Pi CLI not found: ${cli}`)

  const selected = options.scenarios.length > 0
    ? options.scenarios.map((name) => {
        const scenario = scenarios.find((candidate) => candidate.name === name)
        if (!scenario) throw new Error(`Unknown scenario: ${name} (choices: ${scenarios.map((item) => item.name).join(', ')})`)
        return scenario
      })
    : scenarios

  const tempRoot = mkdtempSync(path.join(tmpdir(), 'pi-subagent-eval-'))
  const extension = await buildExtension(tempRoot, options.sourcePath)
  const extensionSha = sha256File(extension.extensionPath)
  const environment = captureEnvironment()

  console.log(`[subagent-eval] temp: ${tempRoot}`)
  console.log(`[subagent-eval] extension: ${extension.extensionPath}`)
  console.log(`[subagent-eval] scenarios: ${selected.map((scenario) => scenario.name).join(', ')}`)

  const records = []
  try {
    for (const scenario of selected) {
      const startedAt = Date.now()
      process.stdout.write(`[subagent-eval] ${scenario.name} ... `)
      let record
      try {
        record = await runScenario(scenario, { ...options, tempRoot, extensionPath: extension.extensionPath })
      } catch (error) {
        const message = error instanceof Error ? error.stack || error.message : String(error)
        record = baseRecord(scenario, new Date(startedAt).toISOString())
        record.durationMs = Date.now() - startedAt
        record.reason = `harness error: ${message}`
        record.raw = { exitReason: 'harness-error', error: message }
        record.checks = [check('harness-completed', false, message)]
      }
      records.push(record)
      console.log(`${record.pass ? 'PASS' : 'FAIL'} (${(record.durationMs / 1000).toFixed(1)}s)${record.reason ? ` — ${record.reason}` : ''}`)
    }
  } finally {
    if (!options.keepTemp) {
      try { rmSync(tempRoot, { recursive: true, force: true }) } catch { /* best effort */ }
    } else {
      console.log(`[subagent-eval] kept temp dir: ${tempRoot}`)
    }
  }

  const passed = records.filter((record) => record.pass).length
  const report = {
    meta: {
      ...buildMeta(extensionSha, environment, options.model, options.sourcePath),
      scenarioTimeoutMs: options.timeoutMs
    },
    summary: {
      total: records.length,
      passed,
      failed: records.length - passed,
      passRate: `${passed}/${records.length}`
    },
    scenarios: records
  }

  const jsonPath = options.jsonPath || defaultJsonPath
  const markdownPath = writeReport(report, jsonPath)
  console.log('')
  console.log(`[subagent-eval] summary: ${passed}/${records.length} passed`)
  console.log(`[subagent-eval] report: ${jsonPath}`)
  console.log(`[subagent-eval] markdown: ${markdownPath}`)
  return passed === records.length ? 0 : 1
}

main().then((code) => {
  process.exitCode = code
}).catch((error) => {
  console.error('[subagent-eval] fatal:', error)
  process.exitCode = 2
})
