/**
 * The title bar and the sidebar must read the same conversation row, and a
 * rename made in the main process must reach the session list. Both halves
 * have been dropped by "cleanups" before, so the wiring is guarded here: a
 * full renderer DOM is not available in this suite, but the source edges are.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const read = (file: string): string =>
  readFileSync(path.resolve(process.cwd(), file), 'utf8')

test('the title bar resolves the active conversation from live threads too', () => {
  const app = read('src/renderer/src/App.tsx')
  // Disk sessions alone are not enough: a chat Pi has not flushed yet has a
  // row in the sidebar, and the title bar must read the same row.
  assert.match(app, /activeConversationTitle\(state\.sessions, state\.threads/)
  assert.match(app, /sessionName \|\| conversationTitle \|\| workspace\?\.name/)
})

test('a rename in the main process is pushed to the session list', () => {
  // Hot renames publish on the runtime stream and cold ones only append to
  // the JSONL; neither re-reads the index on its own.
  assert.match(read('src/main/pi/supervisor.ts'), /this\.emit\('rename', \{ file, name \}\)/)
  assert.match(read('src/main/ipc.ts'), /sendToWindow\(getWindow\(\), 'sessions:changed', payload\)/)
  assert.match(read('src/preload/index.ts'), /subscribe<SessionNameChange>\('sessions:changed', handler\)/)
  const store = read('src/renderer/src/store/useAppStore.ts')
  assert.match(store, /window\.pi\.sessions\.onChanged/)
  assert.match(store, /threads: updateThreadSessionName\(state\.threads, file, name\)/)
  assert.match(store, /void get\(\)\.refreshSessions\(\)/)
})
