import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { listBackgroundCommands, listDeliverables, listSubagentTasks, summariseDiff } from '../src/renderer/src/lib/task-panel'
import { extractPlan } from '../src/renderer/src/lib/plan'
import { isImageName } from '../src/renderer/src/lib/files'
import type { GitStatus } from '../src/shared/types'
import type { AssistantItem, ToolItem } from '../src/renderer/src/lib/thread'

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

test('a live shell command is listed by command name after a two-second grace period', () => {
  const bashCommand = 'cd "C:/project" && npm run build'
  assert.deepEqual(listBackgroundCommands([
    tool({ id: 'b1', toolName: 'bash', args: { command: bashCommand }, startedAt: 10 }),
    tool({ id: 'p1', toolName: 'powershell', args: { command: 'pnpm test' }, startedAt: 12 })
  ]), [
    { id: 'b1', command: bashCommand, label: 'npm run build', visibleAt: 2010 },
    { id: 'p1', command: 'pnpm test', label: 'pnpm test', visibleAt: 2012 }
  ])
})

test('background commands omit proposed, finished and non-shell tools', () => {
  const command = { command: 'npm run build' }
  assert.deepEqual(listBackgroundCommands([
    tool({ id: 'proposed', toolName: 'bash', args: command, status: 'proposed' }),
    tool({ id: 'completed', toolName: 'bash', args: command, status: 'ok', startedAt: 10 }),
    tool({ id: 'failed', toolName: 'powershell', args: command, status: 'error', startedAt: 10 }),
    tool({ id: 'stopped', toolName: 'bash', args: command, status: 'aborted', startedAt: 10 }),
    tool({ id: 'missing-command', toolName: 'bash', startedAt: 11 }),
    tool({ id: 'g1', toolName: 'grep', args: { pattern: 'TODO' }, startedAt: 11 }),
    tool({ id: 's1', toolName: 'subagent', args: { task: 'Verify startup' }, startedAt: 11 })
  ]), [])
})

test('subagent rows preserve child identities, titles and separate outcomes in one parallel call', () => {
  const rows = listSubagentTasks([
    tool({
      id: 's1',
      toolName: 'subagent',
      args: { tasks: [
        { task: 'Run the full test suite', label: 'Run tests' },
        { task: 'Inspect startup' },
        { task: 'Review screenshots' },
        { task: 'Check mobile layout' }
      ] },
      details: { results: [{ status: 'running' }, { status: 'completed' }, { status: 'failed' }] }
    }),
    tool({ id: 'b1', toolName: 'bash', args: { command: 'npm test' } })
  ])
  assert.deepEqual(rows.map(({ id, label, task, status }) => [id, label || task, status]), [
    ['s1:0', 'Run tests', 'running'],
    ['s1:1', 'Inspect startup', 'completed'],
    ['s1:2', 'Review screenshots', 'failed'],
    ['s1:3', 'Check mobile layout', 'queued']
  ])
})

test('only dispatched subagents count and recorded results from older sessions still appear', () => {
  const rows = listSubagentTasks([
    tool({ id: 's1', toolName: 'subagent', args: { task: 'Planned' }, status: 'proposed' }),
    tool({ id: 's2', toolName: 'subagent', args: { task: 'Verified' }, status: 'ok',
      details: { results: [{ exitCode: 0 }] }
    }),
    tool({ id: 's3', toolName: 'subagent', args: { task: 'Cancelled' }, status: 'aborted' })
  ])
  assert.deepEqual(rows.map(({ id, status }) => [id, status]), [
    ['s2:0', 'completed'], ['s3:0', 'aborted']
  ])
})

test('the task rail keeps the eight most recent dispatched subagents in transcript order', () => {
  const items = Array.from({ length: 10 }, (_, index) =>
    tool({ id: `sub-${index}`, toolName: 'subagent', args: { task: `Task ${index}` }, status: 'ok' })
  )
  assert.deepEqual(
    listSubagentTasks(items).map(({ task }) => task),
    items.slice(-8).map(({ args }) => args.task)
  )
})

test('image deliverables are routed to the renderer, not the Files viewer', () => {
  // The set has to match IMAGE_MIME in main so a picture the viewer can draw
  // never falls through to a text tab.
  for (const name of ['shot.png', 'a.JPG', 'frame.jpeg', 'anim.gif', 'pic.webp', 'raw.bmp', 'vector.svg', 'fav.ico', 'next.avif']) {
    assert.equal(isImageName(name), true, name)
  }
  for (const name of ['note.md', 'code.ts', 'data.json', 'no-extension']) {
    assert.equal(isImageName(name), false, name)
  }
  const source = readFileSync(path.resolve(process.cwd(), 'src/renderer/src/components/TaskPanel.tsx'), 'utf8')
  assert.match(source, /isImageName\(file\.name\)/)
  assert.match(source, /tab: 'images', image: target/)
  assert.match(source, /tab: 'files', file: target/)
})

test('TaskPanel gates tool derivations behind activeToolsRevision and isolates plan checklist streaming', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/renderer/src/components/TaskPanel.tsx'), 'utf8')
  assert.match(source, /state\.activeToolsRevision/)
  assert.match(source, /TaskProgressSection/)
  assert.match(source, /lazy\(\(\) =>/)
  assert.equal(source.includes('useShallow'), false)
})

test('extractPlan keeps stable object identity across prose deltas and SubagentPanel avoids state.threads subscriptions', () => {
  const planMessage: AssistantItem = {
    id: 'a-plan',
    kind: 'assistant',
    blocks: [{ type: 'text', text: '- [x] Inspect\n- [ ] Fix' }],
    timestamp: 1,
    order: 1,
    streaming: false
  }
  const prose1: AssistantItem = {
    id: 'a-prose',
    kind: 'assistant',
    blocks: [{ type: 'text', text: 'Working on it' }],
    timestamp: 2,
    order: 2,
    streaming: true
  }
  const prose2: AssistantItem = {
    ...prose1,
    blocks: [{ type: 'text', text: 'Working on it with more streaming prose' }]
  }
  const first = extractPlan([planMessage, prose1])
  const second = extractPlan([planMessage, prose2])
  assert.ok(first)
  assert.equal(second, first, 'unchanged prior plan keeps the same object reference during prose streaming')

  const subagentPanel = readFileSync(path.resolve(process.cwd(), 'src/renderer/src/components/SubagentPanel.tsx'), 'utf8')
  assert.match(subagentPanel, /state\.threadsToolsRevision/)
  assert.match(subagentPanel, /subagentCallOf/)
  assert.equal(/useAppStore\(\s*\(?state\)?\s*=>\s*state\.threads\s*\)/.test(subagentPanel), false)
})
