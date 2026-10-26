/**
 * Verify that replaying a real session restores the tool calls, not just the
 * final text.
 *
 * This is the H01 check: it reads a real session file off disk, projects it
 * through the same reducer the app uses, and reports what came back. A
 * projection that only recovered assistant text would show zero tools here.
 */
import { readFileSync, mkdtempSync } from 'node:fs'
import { build } from 'esbuild'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const session = process.argv[2]
if (!session) {
  console.error('usage: node scripts/verify-replay.mjs <session.jsonl>')
  process.exit(2)
}

const out = join(mkdtempSync(join(tmpdir(), 'replay-')), 'bundle.mjs')
await build({
  entryPoints: ['src/renderer/src/lib/thread.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  alias: { '@shared': join(process.cwd(), 'src', 'shared') }
})

const { itemsFromMessages } = await import(pathToFileURL(out).href)

// Pi writes one JSON record per line. Split on \n only: U+2028/U+2029 are
// legal inside JSON strings, which is exactly why the main process does not
// use readline either.
const records = readFileSync(session, 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line))

const entry = records.find((record) => record.type === 'session')
const messages = records.filter((record) => record.type === 'message').map((r) => r.message)
const items = itemsFromMessages(messages, entry?.cwd ?? process.cwd())

const tools = items.filter((item) => item.kind === 'tool')
const bash = items.filter((item) => item.kind === 'bash')
const users = items.filter((item) => item.kind === 'user')
const assistants = items.filter((item) => item.kind === 'assistant')

const statuses = tools.reduce((acc, tool) => {
  acc[tool.status] = (acc[tool.status] ?? 0) + 1
  return acc
}, {})

console.log('session          :', session.split('\\').pop())
console.log('records          :', records.length)
console.log('messages         :', messages.length)
console.log('projected items  :', items.length)
console.log('  user           :', users.length)
console.log('  assistant      :', assistants.length)
console.log('  tool           :', tools.length, JSON.stringify(statuses))
console.log('  bash           :', bash.length)
console.log('distinct tool ids:', new Set(tools.map((tool) => tool.id)).size)

const withResult = tools.filter((tool) => tool.result !== undefined).length
const withDiff = tools.filter((tool) => (tool.diffs?.length ?? 0) > 0).length
const withArgs = tools.filter((tool) => tool.args && Object.keys(tool.args).length > 0).length
console.log('  tools w/ args  :', withArgs)
console.log('  tools w/ result:', withResult)
console.log('  tools w/ diff  :', withDiff)

const names = [...new Set(tools.map((tool) => tool.toolName))]
console.log('tool names       :', names.join(', '))

const ok = tools.length > 0 && tools.length === new Set(tools.map((t) => t.id)).size
console.log(ok ? '\nPASS: replay restores tool calls with stable ids' : '\nFAIL')
process.exit(ok ? 0 : 1)
