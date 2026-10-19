/**
 * Smoke test: exercise Pi's extension UI sub-protocol over RPC.
 *
 * Runs a temporary project extension that asks for every kind of user
 * interaction, answers each dialog the way Pi Desktop does, and checks that
 * the agent keeps working afterwards.
 *
 * Run with: node scripts/rpc-ui-smoke.mjs [cwd]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

const EXTENSION = `
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function (pi: ExtensionAPI) {
  pi.registerCommand('uismoke', {
    description: 'Exercise the extension UI protocol',
    handler: async (_name, ctx) => {
      const choice = await ctx.ui.select('Pick', ['alpha', 'beta'])
      const confirmed = await ctx.ui.confirm('Sure?', 'A destructive thing.')
      const name = await ctx.ui.input('Name')
      const text = await ctx.ui.editor('Describe', 'draft')
      ctx.ui.notify('done', 'info')
      ctx.ui.setStatus('smoke', 'running')
      ctx.ui.setWidget('smoke', ['line one'], { placement: 'aboveEditor' })
      pi.sendUserMessage(
        \`RESULT choice=\${choice} confirmed=\${confirmed} name=\${name} text=\${text}\`
      )
    }
  })
}
`

const workspace = mkdtempSync(path.join(tmpdir(), 'pi-ui-smoke-'))
const extensionDir = path.join(workspace, '.pi', 'extensions')
mkdirSync(extensionDir, { recursive: true })
writeFileSync(path.join(extensionDir, 'uismoke.ts'), EXTENSION, 'utf8')

// Pi writes its session into the user's real session store by default. The
// smoke run would then leave a throwaway project behind in the sidebar.
const sessionDir = path.join(workspace, '.smoke-sessions')
mkdirSync(sessionDir, { recursive: true })

const child = spawn(
  process.execPath,
  [cli, '--mode', 'rpc', '--approve', '--session-dir', sessionDir],
  {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe']
  }
)

let buffer = ''
const pending = new Map()
const seen = []
let sequence = 0
const dialogs = []

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
        seen.push(record)
        if (record.type === 'extension_ui_request') {
          dialogs.push(record)
          answer(record)
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

function request(payload, timeout = 30000) {
  const id = `smoke-${++sequence}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout waiting for ${payload.type}`))
    }, timeout)
    pending.set(id, (record) => {
      clearTimeout(timer)
      resolve(record)
    })
    child.stdin.write(JSON.stringify({ ...payload, id }) + '\n')
  })
}

/** Answer a dialog exactly the way the desktop client does. */
function answer(request_) {
  const id = request_.id
  switch (request_.method) {
    case 'select':
      child.stdin.write(
        JSON.stringify({ type: 'extension_ui_response', id, value: request_.options[1] }) + '\n'
      )
      break
    case 'confirm':
      child.stdin.write(
        JSON.stringify({ type: 'extension_ui_response', id, confirmed: true }) + '\n'
      )
      break
    case 'input':
      child.stdin.write(
        JSON.stringify({ type: 'extension_ui_response', id, value: 'typed-value' }) + '\n'
      )
      break
    case 'editor':
      child.stdin.write(
        JSON.stringify({ type: 'extension_ui_response', id, value: 'edited-value' }) + '\n'
      )
      break
    default:
      break
  }
}

function waitFor(predicate, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const found = seen.find(predicate)
      if (found) {
        resolve(found)
        return
      }
      if (Date.now() - started > timeout) {
        reject(new Error('timeout waiting for event'))
        return
      }
      setTimeout(tick, 100)
    }
    tick()
  })
}

let failed = false
function check(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failed = true
}

try {
  const state = await request({ type: 'get_state' })
  check('get_state', state.success === true)

  const commands = await request({ type: 'get_commands' })
  const names = (commands.data?.commands ?? []).map((command) => command.name)
  check('project extension loaded', names.includes('uismoke'), names.join(', '))

  const prompt = await request({ type: 'prompt', message: '/uismoke' })
  check('prompt accepted', prompt.success === true, JSON.stringify(prompt.data))
  check(
    'prompt was handled by the extension',
    prompt.data?.disposition === 'handled',
    prompt.data?.disposition
  )

  const message = await waitFor((record) => {
    if (record.type !== 'message_end') return false
    return JSON.stringify(record.message?.content ?? '').includes('RESULT')
  })
  const text = JSON.stringify(message.message?.content ?? '')
  check(
    'answers reached the extension',
    text.includes('choice=beta') &&
      text.includes('confirmed=true') &&
      text.includes('name=typed-value') &&
      text.includes('text=edited-value'),
    text.slice(0, 220)
  )

  const methods = dialogs.map((dialog) => dialog.method)
  check(
    'four blocking dialogs were raised',
    methods.filter((method) =>
      ['select', 'confirm', 'input', 'editor'].includes(method)
    ).length === 4,
    methods.join(', ')
  )
  check(
    'the fire-and-forget methods arrived too',
    ['notify', 'setStatus', 'setWidget'].every((method) => methods.includes(method)),
    methods.join(', ')
  )
} catch (error) {
  failed = true
  console.log('FAIL  ', error.message)
} finally {
  child.stdin.end()
  child.kill()
  // Give the child a moment to release the workspace before removing it.
  await new Promise((resolve) => setTimeout(resolve, 300))
  try {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A leftover temp directory is not worth failing the run over.
  }
}

process.exit(failed ? 1 : 0)
