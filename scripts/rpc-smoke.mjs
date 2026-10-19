/**
 * Smoke test: spawn the bundled Pi CLI in RPC mode and exercise the protocol.
 * Run with: node scripts/rpc-smoke.mjs [cwd]
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

const cwd = process.argv[2] ?? root
const child = spawn(process.execPath, [cli, '--mode', 'rpc'], {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env }
})

let buffer = ''
const seen = []
const pending = new Map()
let seq = 0

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
        console.log('UNPARSABLE:', line.slice(0, 160))
        index = buffer.indexOf('\n')
        continue
      }
      if (record.type === 'response' && record.id) {
        const resolver = pending.get(record.id)
        pending.delete(record.id)
        if (resolver) resolver(record)
      } else {
        seen.push(record.type)
        if (seen.length <= 12) {
          console.log('EVENT:', record.type, JSON.stringify(record).slice(0, 220))
        }
      }
    }
    index = buffer.indexOf('\n')
  }
})

child.stderr.on('data', (chunk) => {
  const text = chunk.toString('utf8').trim()
  if (text) console.log('STDERR:', text.slice(0, 300))
})

child.on('exit', (code, signal) => {
  console.log(`EXIT code=${code} signal=${signal}`)
})

function request(payload, timeout = 20000) {
  const id = `test-${++seq}`
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

try {
  console.log('spawning:', cli, 'cwd:', cwd)
  const state = await request({ type: 'get_state' })
  console.log('\nget_state success =', state.success)
  console.log(JSON.stringify(state.data, null, 2).slice(0, 900))

  const models = await request({ type: 'get_available_models' })
  const list = models.data?.models ?? []
  console.log(`\nmodels: ${list.length}`)
  for (const model of list.slice(0, 6)) {
    console.log(` - ${model.provider}/${model.id} (${model.name}) ctx=${model.contextWindow}`)
  }

  const commands = await request({ type: 'get_commands' })
  console.log('\ncommands:', (commands.data?.commands ?? []).length)

  const stats = await request({ type: 'get_session_stats' })
  console.log('stats ok =', stats.success, JSON.stringify(stats.data ?? {}).slice(0, 300))

  // Session management: the desktop app relies on these to browse history.
  const sessionFile = state.data?.sessionFile
  const switched = await request({ type: 'switch_session', sessionPath: sessionFile })
  console.log('switch_session ok =', switched.success, JSON.stringify(switched.data ?? {}))

  const forked = await request({ type: 'get_fork_messages' })
  console.log('get_fork_messages ok =', forked.success)

  const fresh = await request({ type: 'new_session' })
  console.log('new_session ok =', fresh.success, JSON.stringify(fresh.data ?? {}))

  const after = await request({ type: 'get_state' })
  console.log('new session id =', after.data?.sessionId, '| file =', after.data?.sessionFile)
} catch (error) {
  console.error('SMOKE FAILED:', error.message)
  process.exitCode = 1
} finally {
  child.stdin.end()
  setTimeout(() => child.kill(), 1500)
}
