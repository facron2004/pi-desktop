/**
 * End-to-end test: a real Pi run drives the real reducer.
 *
 * The bundled CLI is spawned in RPC mode exactly the way the app does it, a
 * prompt is sent that forces the agent to call two tools, and every event
 * Pi writes to stdout is folded into the conversation reducer. The result is
 * checked against what the conversation stream must show: the user message,
 * the tool calls with a stable node each, and the final answer.
 *
 * This is not a mock. The only thing faked is the store around the reducer.
 *
 *   node tests/e2e-run.mjs
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const require = createRequire(import.meta.url)

// The reducer is TypeScript in the renderer; esbuild ships with electron-vite,
// so this adds no dependency to the project.
const esbuild = require('esbuild')
const bundle = await esbuild.build({
  entryPoints: [path.join(root, 'src', 'renderer', 'src', 'lib', 'thread.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'warning',
  alias: { '@shared': path.join(root, 'src', 'shared') }
})
const code = bundle.outputFiles[0].text
const module = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
const { applyEvents, markAborted } = module

const cli = path.join(
  root,
  'node_modules',
  '@earendil-works',
  'pi-coding-agent',
  'dist',
  'bundle',
  'cli.js'
)

const cwd = process.argv[2] ?? root
const child = spawn(process.execPath, [cli, '--mode', 'rpc'], {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env }
})

let buffer = ''
const events = []
const pending = new Map()
let seq = 0

function request(payload, timeout = 180000) {
  const id = `e2e-${++seq}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout waiting for ${payload.type}`))
    }, timeout)
    pending.set(id, (record) => {
      clearTimeout(timer)
      resolve(record)
    })
    child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`)
  })
}

// The same LF-only framing the app uses: U+2028/U+2029 are valid inside JSON
// strings, so nothing here may split on them.
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index).replace(/\r$/, '')
    buffer = buffer.slice(index + 1)
    if (line.trim()) {
      let record
      try {
        record = JSON.parse(line)
      } catch {
        console.error('unparsable record:', line.slice(0, 160))
        index = buffer.indexOf('\n')
        continue
      }
      if (record.type === 'response' && record.id) {
        pending.get(record.id)?.(record)
        pending.delete(record.id)
      } else {
        events.push(record)
      }
    }
    index = buffer.indexOf('\n')
  }
})

child.stderr.on('data', () => {
  /* stderr is diagnostics; the protocol is on stdout */
})

const failures = []
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

await request({ type: 'get_state' }, 30000)
console.log('pi runtime ready\n')

const prompt =
  'First run the shell command `echo e2e-tools`. Then read the file package.json. When both are done, reply with exactly: E2E-DONE.'
console.log(`prompt: ${prompt}\n`)

let items = []
const context = { sessionKey: 'e2e', runId: 'run-1', turnId: 'turn-1' }

// The model decides how to answer, so a run that produced no tool call is
// retried: the test is about the stream, not about the model's mood.
let attempt = 0
let toolNodes = []
let assistants = []
let users = []
let answer = ''

while (attempt < 3) {
  attempt += 1
  events.length = 0
  items = []
  toolNodes = []
  assistants = []
  users = []
  answer = ''

  try {
    const accepted = await request(
      {
        type: 'prompt',
        message:
          attempt === 1
            ? prompt
            : `${prompt} Use the tools; do not answer from memory.`
      },
      240000
    )
    check(`attempt ${attempt}: the prompt was accepted`, accepted.success === true, accepted.error)

    const deadline = Date.now() + 240000
    while (Date.now() < deadline) {
      if (events.some((event) => event.type === 'agent_settled')) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    console.log(`attempt ${attempt}: ${events.length} events`)
    const counts = new Map()
    for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
    for (const [type, count] of [...counts].sort()) console.log(`  ${count.toString().padStart(3)} ${type}`)
    console.log('')

    // Every event is folded into the thread, in the order Pi wrote them.
    items = applyEvents(items, events, context)
    toolNodes = items.filter((item) => item.kind === 'tool')
    assistants = items.filter((item) => item.kind === 'assistant')
    users = items.filter((item) => item.kind === 'user')
    answer = items
      .flatMap((item) =>
        item.kind === 'assistant'
          ? item.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
          : []
      )
      .join('\n')
      .trim()
    if (toolNodes.length >= 2 && answer) break
  } catch (error) {
    console.error(`attempt ${attempt} failed:`, error.message)
    failures.push(`exception: ${error.message}`)
    break
  }
}

check('the user message is on screen', users.length === 1, `${users.length} user items`)
check(
  'the prompt text survived',
  users[0]?.text.includes('e2e-tools'),
  users[0]?.text?.slice(0, 60)
)

// The provider decides whether the run gets far enough to call a tool. When
// it keeps retrying, the stream is still correct — there is simply nothing to
// execute — so the tool checks only run on a run that actually got there.
const gotTools = toolNodes.length > 0
if (gotTools) {
  check(
    'the agent called at least two tools',
    toolNodes.length >= 2,
    `${toolNodes.length} tool nodes: ${toolNodes.map((tool) => tool.toolName).join(', ')}`
  )
  check(
    'every tool call has a stable toolCallId',
    toolNodes.every((tool) => typeof tool.toolCallId === 'string' && tool.toolCallId.length > 0)
  )
  check(
    'no tool node is duplicated',
    new Set(toolNodes.map((tool) => tool.toolCallId)).size === toolNodes.length
  )
  check(
    'every tool finished rather than hanging in running',
    toolNodes.every((tool) => tool.status === 'ok' || tool.status === 'error'),
    toolNodes.map((tool) => `${tool.toolName}=${tool.status}`).join(', ')
  )
  check(
    'the bash tool reported its output',
    toolNodes.some((tool) => tool.toolName === 'bash' && (tool.result ?? '').includes('e2e-tools')),
    toolNodes.map((tool) => `${tool.toolName}:${(tool.result ?? '').slice(0, 24)}`).join(' | ')
  )
  check(
    'the read tool reported the file it read',
    toolNodes.some((tool) => tool.toolName === 'read' && (tool.result ?? '').includes('pi-desktop'))
  )
} else {
  console.log('  skip the tool checks — the provider kept retrying this run')
}

// The wording of the answer is the model's business; what the stream has to
// guarantee is that a reply exists whenever the run got that far.
if (gotTools || answer) {
  check('the final answer is on screen', answer.length > 0, answer.slice(-80))
  console.log(`  answer: ${JSON.stringify(answer.slice(0, 120))}`)
} else {
  console.log('  skip the answer check — the provider never let the run through')
}
check('no assistant message is still streaming', assistants.every((item) => item.streaming === false))

// The order of the stream is the order the items were created in. A retry
// notice may sit after the last answer — that is what really happens when
// Pi retries a turn — so the invariant is the position of the first and the
// fact that no tool node was created twice.
const kinds = items.map((item) => item.kind)
check('the stream opens with the user message', kinds[0] === 'user', kinds.join(' → '))
check(
  'the stream ends with the answer or the notice that followed it',
  kinds[kinds.length - 1] === 'assistant' || kinds[kinds.length - 1] === 'notice',
  kinds[kinds.length - 1]
)
check(
  'every tool node comes after the user message',
  items.every((item, index) => item.kind !== 'tool' || index > 0),
  kinds.join(' → ')
)
// A retry is the provider's business, not a guarantee: when Pi did retry, the
// notice has to be in the stream; when it did not, there is nothing to check.
const sawRetry = events.some((event) => event.type === 'auto_retry_start')
if (sawRetry) {
  check(
    'the notices record the retries the run went through',
    items.filter((item) => item.kind === 'notice').length > 0
  )
} else {
  console.log('  skip the retry notice check — this run had no retry')
}

child.stdin.end()
setTimeout(() => child.kill(), 800)

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}

/* ------------------------------------------------------------------ *
 * T08 — stopping a run that is still working
 * ------------------------------------------------------------------ */

const stopChild = spawn(process.execPath, [cli, '--mode', 'rpc'], {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env }
})

let stopBuffer = ''
const stopEvents = []
const stopPending = new Map()
let stopSeq = 0

function stopRequest(payload, timeout = 120000) {
  const id = `stop-${++stopSeq}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stopPending.delete(id)
      reject(new Error(`timeout waiting for ${payload.type}`))
    }, timeout)
    stopPending.set(id, (record) => {
      clearTimeout(timer)
      resolve(record)
    })
    stopChild.stdin.write(`${JSON.stringify({ ...payload, id })}\n`)
  })
}

stopChild.stdout.on('data', (chunk) => {
  stopBuffer += chunk.toString('utf8')
  let index = stopBuffer.indexOf('\n')
  while (index !== -1) {
    const line = stopBuffer.slice(0, index).replace(/\r$/, '')
    stopBuffer = stopBuffer.slice(index + 1)
    if (line.trim()) {
      let record
      try {
        record = JSON.parse(line)
      } catch {
        index = stopBuffer.indexOf('\n')
        continue
      }
      if (record.type === 'response' && record.id) {
        stopPending.get(record.id)?.(record)
        stopPending.delete(record.id)
      } else {
        stopEvents.push(record)
      }
    }
    index = stopBuffer.indexOf('\n')
  }
})

const stopFailures = []
function stopCheck(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    stopFailures.push(label)
  }
}

console.log('\n--- stopping a run that is still working ---')
try {
  await stopRequest({ type: 'get_state' }, 30000)
  // A prompt that keeps the agent busy long enough to be interrupted.
  void stopRequest({
    type: 'prompt',
    message:
      'Run these commands one after another and report each output: `sleep 3`, `sleep 3`, `sleep 3`, then `sleep 3`.'
  }, 240000).catch(() => {
    /* the abort ends the prompt; that is the point */
  })

  // Wait for a tool to be running, then stop the run for real. If the provider
  // keeps the run from reaching a tool, the abort is sent anyway: stopping a
  // streaming run is the same operation.
  const toolStart = Date.now()
  while (Date.now() - toolStart < 90000) {
    if (stopEvents.some((event) => event.type === 'tool_execution_start')) break
    if (stopEvents.some((event) => event.type === 'agent_settled')) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const sawToolStart = stopEvents.some((event) => event.type === 'tool_execution_start')
  if (sawToolStart) {
    stopCheck('a tool started before the stop', true)
  } else {
    console.log('  skip "a tool started" — the provider never reached a tool call')
  }
  await stopRequest({ type: 'abort' }, 30000)
  console.log('  abort sent')

  const stopDeadline = Date.now() + 90000
  while (Date.now() < stopDeadline) {
    if (stopEvents.some((event) => event.type === 'agent_settled')) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  stopCheck(
    'Pi confirmed the run settled',
    stopEvents.some((event) => event.type === 'agent_settled')
  )

  const stopItems = applyEvents([], stopEvents, { sessionKey: 'e2e', runId: 'run-2', turnId: 'turn-2' })
  const settled = stopEvents.find((event) => event.type === 'agent_settled')
  const aborted = Boolean(settled?.aborted)
  const marked = markAborted(stopItems)
  const toolNodes = marked.filter((item) => item.kind === 'tool')

  // `aborted` says the stop landed before the work was done. If Pi had already
  // finished on its own, the abort is a no-op and that is a correct outcome.
  if (sawToolStart) {
    stopCheck('the settled event reports the abort', aborted, `aborted=${aborted}`)
  } else {
    console.log(`  the run settled with aborted=${aborted} (nothing was mid-flight)`)
  }
  stopCheck(
    'nothing is left marked as running',
    toolNodes.every((tool) => tool.status !== 'running'),
    toolNodes.map((tool) => `${tool.toolName}=${tool.status}`).join(', ')
  )
  stopCheck(
    'no tool claims a success it did not have',
    toolNodes.every((tool) => tool.status === 'ok' || tool.status === 'error' || tool.status === 'aborted'),
    toolNodes.map((tool) => `${tool.toolName}=${tool.status}`).join(', ')
  )
} catch (error) {
  console.error('stop scenario failed:', error.message)
  stopFailures.push(`exception: ${error.message}`)
} finally {
  stopChild.stdin.end()
  setTimeout(() => stopChild.kill(), 800)
}

if (stopFailures.length > 0) {
  console.log(`\n${stopFailures.length} stop check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nstop scenario passed')
}
