import test from 'node:test'
import assert from 'node:assert/strict'
import {
  itemsFromMessages,
  type AssistantItem,
  type ToolItem
} from '../src/renderer/src/lib/thread'
import { subagentUsage } from '../src/renderer/src/lib/subagent-usage'
import { sessionMetrics } from '../src/renderer/src/lib/session-metrics'

function tool(patch: Partial<ToolItem> = {}): ToolItem {
  return {
    id: 'node',
    kind: 'tool',
    toolCallId: 'batch',
    toolName: 'subagent',
    args: { tasks: [{ task: 'Inspect' }] },
    status: 'ok',
    timestamp: 1,
    order: 1,
    ...patch
  }
}

function assistant(): AssistantItem {
  return {
    id: 'assistant',
    kind: 'assistant',
    blocks: [{ type: 'text', text: 'Done' }],
    usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, totalTokens: 130 },
    streaming: false,
    timestamp: 2,
    order: 2
  }
}

test('one subagent call sums the usage of its single task', () => {
  const usage = subagentUsage([tool({
    args: { task: 'Inspect' },
    details: {
      results: [{
        task: 'Inspect',
        status: 'completed',
        usage: { input: 120, output: 30, cacheRead: 40, cacheWrite: 10, cost: 0.0123 }
      }]
    }
  })])
  assert.equal(usage.tokens, 200)
  assert.equal(usage.cost, 0.0123)
  assert.equal(usage.tasks, 1)
  assert.equal(usage.settled, 1)
})

test('a batch adds every task, and only terminal states count as settled', () => {
  const usage = subagentUsage([tool({
    status: 'running',
    args: { tasks: [{ task: 'A' }, { task: 'B' }, { task: 'C' }, { task: 'D' }] },
    details: {
      results: [
        {
          task: 'A',
          status: 'completed',
          usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.25 }
        },
        { task: 'B', status: 'failed', usage: { input: 20, output: 10 } },
        { task: 'C', status: 'timed_out', usage: { input: 4, output: 1 } },
        // Still running: its tokens count, but it has not settled.
        { task: 'D', status: 'running' }
      ]
    }
  })])
  assert.equal(usage.tokens, 18 + 30 + 5)
  assert.equal(usage.cost, 0.25)
  assert.equal(usage.tasks, 4)
  assert.equal(usage.settled, 3)
})

test('a conversation without subagents reports zeros and no cost', () => {
  const empty = subagentUsage([])
  assert.equal(empty.tokens, 0)
  assert.equal(empty.cost, undefined)
  assert.equal(empty.tasks, 0)
  assert.equal(empty.settled, 0)
  assert.deepEqual(subagentUsage([tool({ toolName: 'read', details: { results: [] } })]), empty)
})

test('a replayed session reports the usage its tool result recorded', () => {
  const items = itemsFromMessages([
    {
      role: 'assistant',
      timestamp: 1,
      content: [{
        type: 'toolCall',
        id: 'batch',
        name: 'subagent',
        arguments: { tasks: [{ task: 'Inspect' }] }
      }]
    },
    {
      role: 'toolResult',
      timestamp: 2,
      toolCallId: 'batch',
      toolName: 'subagent',
      isError: false,
      content: [],
      details: {
        results: [{
          task: 'Inspect',
          status: 'completed',
          usage: { input: 7, output: 3, cacheRead: 1, cacheWrite: 1, cost: 0.5 }
        }]
      }
    }
  ])
  const usage = subagentUsage(items)
  assert.equal(usage.tokens, 12)
  assert.equal(usage.cost, 0.5)
  assert.equal(usage.tasks, 1)
  assert.equal(usage.settled, 1)
})

test('subagent tokens stay out of the parent conversation totals', () => {
  const metrics = sessionMetrics(
    [assistant(), tool({ order: 3, timestamp: 3, details: {
      results: [{
        task: 'Inspect',
        status: 'completed',
        usage: { input: 120, output: 80, cacheRead: 0, cacheWrite: 0, cost: 0.0123 }
      }]
    } })],
    undefined,
    {}
  )
  assert.equal(metrics.totalTokens, 130)
  assert.equal(metrics.inputTokens, 100)
  assert.equal(metrics.outputTokens, 20)
  assert.equal(metrics.subagentTokens, 200)
  assert.equal(metrics.subagentCost, 0.0123)
  assert.equal(metrics.subagentTaskCount, 1)
})
