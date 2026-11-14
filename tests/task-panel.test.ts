import test from 'node:test'
import assert from 'node:assert/strict'
import { listBackgroundTasks, listDeliverables, summariseDiff } from '../src/renderer/src/lib/task-panel'
import type { GitStatus } from '../src/shared/types'
import type { ToolItem } from '../src/renderer/src/lib/thread'

function tool(overrides: Partial<ToolItem> & Pick<ToolItem, 'id' | 'toolName'>): ToolItem {
  return {
    kind: 'tool',
    toolCallId: overrides.id,
    args: {},
    status: 'running',
    timestamp: 1,
    order: 1,
    ...overrides
  }
}

function repo(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    isRepo: true,
    root: 'C:/project',
    branch: 'main',
    detached: false,
    ahead: 0,
    behind: 0,
    files: [],
    staged: 0,
    unstaged: 0,
    clean: true,
    ...overrides
  }
}

test('the deliverables are one flat list, in the order the run touched them', () => {
  const rows = listDeliverables([
    { path: 'audit/shot.png' },
    { path: 'note.md' },
    { path: 'src/renderer/app.tsx' }
  ])
  assert.deepEqual(
    rows.map((row) => row.name),
    ['shot.png', 'note.md', 'app.tsx']
  )
  // The row shows a name; the path stays on the row for the tooltip and the click.
  assert.deepEqual(
    rows.map((row) => row.path),
    ['audit/shot.png', 'note.md', 'src/renderer/app.tsx']
  )
})

test('a path is never shown, so an absolute one is not a chain of folders', () => {
  const rows = listDeliverables([
    {
      path: 'C:/Users/Facron/AppData/Roaming/pi-desktop/chats/gen_pelican.js',
      target: 'C:/Users/Facron/AppData/Roaming/pi-desktop/chats/gen_pelican.js'
    }
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'gen_pelican.js')
  assert.equal(rows[0].dir, '')
  assert.equal(rows[0].target, 'C:/Users/Facron/AppData/Roaming/pi-desktop/chats/gen_pelican.js')
})

test('only a name two files share has to say which folder it is in', () => {
  const rows = listDeliverables([
    { path: 'server/store.js' },
    { path: 'web/store.js' },
    { path: 'server/routes.js' }
  ])
  assert.deepEqual(
    rows.map((row) => `${row.name} ${row.dir}`),
    ['store.js server', 'store.js web', 'routes.js ']
  )
})

test('a file that was written twice is listed once', () => {
  const rows = listDeliverables([{ path: 'src/app.ts' }, { path: 'src/app.ts' }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].path, 'src/app.ts')
})

test('a file with no path is not a row', () => {
  assert.deepEqual(listDeliverables([{ path: '' }, { path: '/' }]), [])
})

test('the line counts of the working tree add up', () => {
  const summary = summariseDiff(
    repo({
      files: [
        { path: 'a.ts', status: ' M', worktree: 'M', staged: false, untracked: false, added: 12, removed: 3 },
        { path: 'b.ts', status: ' M', worktree: 'M', staged: false, untracked: false, added: 5, removed: 1 }
      ]
    })
  )
  assert.equal(summary?.added, 17)
  assert.equal(summary?.removed, 4)
  assert.equal(summary?.files, 2)
  assert.equal(summary?.hasLineStats, true)
})

test('git reported no line counts, so only the files are known', () => {
  const summary = summariseDiff(
    repo({
      files: [
        { path: 'new.ts', status: '??', worktree: '?', staged: false, untracked: true }
      ]
    })
  )
  assert.equal(summary?.hasLineStats, false)
  assert.equal(summary?.files, 1)
})

test('a folder that is not a repository has no diff to summarise', () => {
  assert.equal(summariseDiff(repo({ isRepo: false })), null)
  assert.equal(summariseDiff(undefined), null)
})

test('background tasks are the running tool calls, named by their tool', () => {
  const rows = listBackgroundTasks([
    tool({ id: 'b1', toolName: 'bash', args: { command: 'npm run build' }, startedAt: 10 }),
    tool({ id: 'g1', toolName: 'grep', args: { pattern: 'TODO' }, startedAt: 11 }),
    tool({ id: 'p1', toolName: 'powershell', args: { command: 'Get-ChildItem' }, startedAt: 12 })
  ])
  assert.deepEqual(
    rows.map((row) => row.toolName),
    ['bash', 'grep', 'powershell']
  )
  assert.deepEqual(
    rows.map((row) => row.label),
    ['Bash', 'Grep', 'PowerShell']
  )
  assert.equal(rows[0].detail, 'npm run build')
  assert.equal(rows[1].detail, 'TODO')
})

test('subagents are not background tasks, and finished calls are gone', () => {
  const rows = listBackgroundTasks([
    tool({ id: 's1', toolName: 'subagent', args: { tasks: [{ task: 'inspect' }] } }),
    tool({ id: 'b1', toolName: 'bash', args: { command: 'sleep 1' }, status: 'ok' }),
    tool({ id: 'b2', toolName: 'bash', args: { command: 'npm test' } })
  ])
  assert.deepEqual(
    rows.map((row) => row.toolName),
    ['bash']
  )
})

test('an unknown tool still names its subject from the usual argument fields', () => {
  const rows = listBackgroundTasks([
    tool({ id: 'g1', toolName: 'glob', args: { pattern: '**/*.ts' } }),
    tool({ id: 'c1', toolName: 'shell', args: { command: 'npm test' } }),
    tool({ id: 'm1', toolName: 'mcp__server__fetch', args: { url: 'https://example.com' } })
  ])
  assert.deepEqual(
    rows.map((row) => row.detail),
    ['**/*.ts', 'npm test', 'https://example.com']
  )
})

test('bookkeeping tools are not listed as background work', () => {
  const rows = listBackgroundTasks([
    tool({ id: 't1', toolName: 'todo', args: { items: [] } }),
    tool({ id: 't2', toolName: 'desktop_todo', args: { items: [] } }),
    tool({ id: 't3', toolName: 'exit_plan_mode', args: {} }),
    tool({ id: 'b1', toolName: 'bash', args: { command: 'ls' } })
  ])
  assert.deepEqual(
    rows.map((row) => row.toolName),
    ['bash']
  )
})
