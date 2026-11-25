import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ThreadItem, ToolItem } from '../src/renderer/src/lib/thread'
import {
  assignmentsByWorker,
  countAssignments,
  displayStatusOf,
  filterAssignments,
  filterWorkers,
  swarmAssignments,
  swarmFeed,
  swarmPreview,
  swarmRosterLine,
  swarmSituation,
  swarmSpawnPending,
  rosterForPage,
  swarmStartedAt,
  type SwarmWorkerState
} from '../src/renderer/src/lib/swarm'

/**
 * The Swarm page's projections.
 *
 * The page must tell three different stories from one roster: who is working
 * right now, what each worker was handed over the session, and what happened
 * after a turn when nothing is live any more. These helpers are that reading,
 * kept out of the component so the readings can be asserted.
 */

function swarmTool(id: string, toolName: 'swarm_task' | 'swarm_message', args: Record<string, unknown>, overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    id,
    kind: 'tool',
    toolCallId: id,
    toolName,
    args,
    status: 'ok',
    timestamp: 1,
    order: 1,
    finishedAt: 200,
    ...overrides
  }
}

const items: ThreadItem[] = [
  swarmTool('a', 'swarm_task', { name: 'math-reason', task: 'expand the math direction' }, { startedAt: 100, finishedAt: 200 }),
  swarmTool('b', 'swarm_task', { name: 'code', task: 'add boundary cases', wait: false }, { startedAt: 300, finishedAt: 400 }),
  swarmTool('c', 'swarm_message', { name: 'code', message: 'ping about the report' }, { startedAt: 500, finishedAt: 600 })
]

function worker(overrides: Partial<SwarmWorkerState>): SwarmWorkerState {
  return { name: 'w', status: 'idle', ...overrides }
}

test('a replayed roster says "previously active", a live queued one says "queued"', () => {
  assert.equal(displayStatusOf(worker({ status: 'working' }), true), 'working')
  // The same record after the turn: the process is gone, it did work.
  assert.equal(displayStatusOf(worker({ status: 'working' }), false), 'history')
  assert.equal(displayStatusOf(worker({ status: 'idle', queued: 2 }), true), 'queued')
  // A queued count in a replayed roster is history too: there is no live queue.
  assert.equal(displayStatusOf(worker({ status: 'idle', queued: 2 }), false), 'history')
  assert.equal(displayStatusOf(worker({ status: 'failed' }), true), 'failed')
})

test('dispatch history is projected newest first, one entry per hand-over', () => {
  const assignments = swarmAssignments(items)
  assert.deepEqual(assignments.map((assignment) => assignment.id), ['c:0', 'b:0', 'a:0'])
  assert.equal(assignments[0]?.worker, 'code')
  assert.equal(assignments[0]?.task, 'ping about the report')
  // wait:false answers "dispatched", not "completed".
  assert.equal(assignments[1]?.status, 'dispatched')
  assert.equal(assignments[2]?.status, 'completed')
})

test('assignments group into per-worker lanes in the order the work happened', () => {
  const lanes = assignmentsByWorker(swarmAssignments(items))
  assert.deepEqual([...lanes.keys()], ['math-reason', 'code'])
  assert.deepEqual(lanes.get('code')?.map((assignment) => assignment.id), ['b:0', 'c:0'])
  assert.deepEqual(lanes.get('math-reason')?.map((assignment) => assignment.id), ['a:0'])
})

test('counts and filters separate work in flight from finished work', () => {
  const assignments = swarmAssignments(items)
  assert.deepEqual(countAssignments(assignments), { total: 3, active: 0, queued: 1, completed: 2, failed: 0 })
  assert.deepEqual(filterAssignments(assignments, 'done').map((entry) => entry.id), ['c:0', 'a:0'])
  assert.deepEqual(filterAssignments(assignments, 'active').map((entry) => entry.id), ['b:0'])
  assert.deepEqual(filterAssignments(assignments, 'failed'), [])

  const roster = [worker({ name: 'a', status: 'working' }), worker({ name: 'b', status: 'failed' }), worker({ name: 'c', status: 'stopped' })]
  assert.deepEqual(filterWorkers(roster, true, 'active').map((entry) => entry.name), ['a'])
  assert.deepEqual(filterWorkers(roster, true, 'failed').map((entry) => entry.name), ['b'])
  assert.deepEqual(filterWorkers(roster, true, 'idle').map((entry) => entry.name), ['c'])
  assert.equal(filterWorkers(roster, true, 'all').length, 3)
})

test('the orchestration feed shows live workers first, then the newest hand-overs', () => {
  const workers = [
    worker({ name: 'math-reason', status: 'working', startedAt: 10, task: 'expand math', activity: 'reading tests' }),
    worker({ name: 'code', status: 'idle', startedAt: 20 })
  ]
  const assignments = swarmAssignments(items)
  const feed = swarmFeed(workers, assignments, true, 3)
  assert.equal(feed.length, 3)
  assert.equal(feed[0]?.kind, 'worker')
  assert.equal(feed[0]?.name, 'math-reason')
  assert.equal(feed[0]?.activity, 'reading tests')
  // Then the newest completed hand-over, not the oldest.
  assert.equal(feed[1]?.id, 'assignment:c:0')
  assert.equal(feed[2]?.id, 'assignment:b:0')
})

test('the elapsed reading starts at the earliest worker or hand-over', () => {
  assert.equal(swarmStartedAt([worker({ startedAt: 50 }), worker({ startedAt: 20 })]), 20)
  assert.equal(swarmStartedAt([worker({})]), undefined)
  const assignments = swarmAssignments(items)
  assert.equal(assignments[0]?.at, 600)
})

test('the situation sentence prefers live work, then failures, then a snapshot', () => {
  const summary = { total: 3, working: 2, idle: 0, failed: 1, stopped: 0, tokens: 10 }
  assert.deepEqual(swarmSituation(summary, true, true), { key: '{count} workers are working', count: 2 })
  assert.deepEqual(swarmSituation(summary, true, false), {
    key: 'Swarm Mode is off. {count} workers are still finishing.',
    count: 2
  })
  assert.deepEqual(swarmSituation({ ...summary, working: 0 }, true, true), {
    key: '{count} failed, the team is waiting',
    count: 1
  })
  assert.deepEqual(swarmSituation({ ...summary, working: 0, failed: 0 }, true, true), {
    key: 'The team is idle. More work can be assigned.'
  })
  assert.equal(swarmSituation(summary, false, true).key, 'No live connection. This is the last team snapshot.')
})

test('a roster line shows the live tool, the failure, or the previous task', () => {
  assert.deepEqual(swarmRosterLine(worker({ status: 'working', toolName: 'edit', task: 'retry login' }), true), {
    kind: 'tool',
    tool: 'edit'
  })
  assert.deepEqual(swarmRosterLine(worker({ status: 'failed', errorMessage: 'exit 1', task: 'review' }), true), {
    kind: 'error',
    text: 'exit 1'
  })
  assert.deepEqual(swarmRosterLine(worker({ status: 'idle', task: 'check the lock' }), true), {
    kind: 'last',
    text: 'check the lock'
  })
  assert.equal(swarmRosterLine(worker({ status: 'working', task: 'still going' }), false).kind, 'last')
})

test('hand-overs still name a roster when the saved team is empty', () => {
  const named = rosterForPage([], [], swarmAssignments(items), false)
  assert.deepEqual(named.map((entry) => entry.name), ['math-reason', 'code'])
  assert.deepEqual(rosterForPage([worker({ name: 'live' })], [], [], true).map((entry) => entry.name), ['live'])
  assert.deepEqual(rosterForPage([], [worker({ name: 'saved' })], swarmAssignments(items), false).map((entry) => entry.name), ['saved'])
})

test('an in-flight swarm_spawn is pending until it settles', () => {
  const pending = swarmTool('spawn', 'swarm_task', { name: 'a', task: 't' }, { toolName: 'swarm_spawn', status: 'running' })
  assert.equal(swarmSpawnPending([pending]), true)
  assert.equal(swarmSpawnPending([{ ...pending, status: 'ok' }]), false)
})

test('a preview prefers live activity while working and the report once idle', () => {
  assert.equal(swarmPreview(worker({ status: 'working', progressText: 'running tests', task: 't' })), 'running tests')
  assert.equal(swarmPreview(worker({ status: 'idle', output: 'done, 6/6 passed', task: 't' })), 'done, 6/6 passed')
  assert.equal(swarmPreview(worker({ status: 'failed', errorMessage: 'exit 1', task: 't' })), 'exit 1')
})
