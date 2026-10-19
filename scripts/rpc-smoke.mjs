/**
 * Smoke test: spawn the bundled Pi CLI in RPC mode and exercise the protocol.
 * Run with: node scripts/rpc-smoke.mjs [cwd]
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
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

/** Find the biggest session file for the workspace under test. */
function findPopulatedSession() {
  const root = path.join(os.homedir(), '.pi', 'agent', 'sessions')
  if (!existsSync(root)) return null
  const encoded = `--${path.resolve(cwd).replace(/^[/\\]+/, '').replace(/[/\\:]/g, '-')}--`
  const dir = path.join(root, encoded)
  if (!existsSync(dir)) return null
  let best = null
  let bestSize = 0
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue
    const full = path.join(dir, file)
    const size = statSync(full).size
    if (size > bestSize) {
      bestSize = size
      best = full
    }
  }
  return best
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

  // Export needs a session that actually contains a conversation.
  const populated = findPopulatedSession()
  if (populated) {
    const switched = await request({ type: 'switch_session', sessionPath: populated })
    console.log('switch to populated ok =', switched.success, populated.split(/[\\/]/).pop())
    const exported = await request({ type: 'export_html' }, 60000)
    console.log(
      'export_html ok =',
      exported.success,
      exported.error ? `error: ${exported.error}` : JSON.stringify(exported.data ?? {})
    )

    // Session branching: the app offers a "branch from here" button on every
    // prompt, so the fork point has to be discoverable and usable.
    const forkable = await request({ type: 'get_fork_messages' })
    const targets = forkable.data?.messages ?? []
    console.log('fork targets =', targets.length, 'first =', targets[0]?.entryId ?? 'none')

    const tree = await request({ type: 'get_tree' })
    const roots = tree.data?.tree ?? []
    console.log('get_tree ok =', tree.success, 'roots =', roots.length, 'leaf =', tree.data?.leafId)

    if (targets.length) {
      // A copy of the branch is the other half of the branching story. It
      // needs a session that is already on disk.
      const cloned = await request({ type: 'clone' }, 30000)
      console.log(
        'clone ok =',
        cloned.success,
        cloned.error ? `error: ${cloned.error}` : JSON.stringify(cloned.data ?? {})
      )
      const afterClone = await request({ type: 'get_state' })
      console.log('cloned session =', afterClone.data?.sessionFile?.split(/[\\/]/).pop())
      console.log('clone kept the history:', afterClone.data?.messageCount, 'messages')

      const forked = await request({ type: 'fork', entryId: targets[targets.length - 1].entryId }, 30000)
      console.log('fork ok =', forked.success, 'cancelled =', forked.data?.cancelled)
      const after = await request({ type: 'get_state' })
      console.log('forked session =', after.data?.sessionFile?.split(/[\\/]/).pop())
      console.log('fork kept the earlier history:', after.data?.messageCount, 'messages')
    }
  } else {
    console.log('export_html skipped: no populated session found')
  }
} catch (error) {
  console.error('SMOKE FAILED:', error.message)
  process.exitCode = 1
} finally {
  child.stdin.end()
  setTimeout(() => child.kill(), 1500)
}
