import test from 'node:test'
import assert from 'node:assert/strict'
import type { AgentMessage, PiEvent } from '../src/shared/types'
import { applyEvent, type ThreadItem } from '../src/renderer/src/lib/thread'
import { beginStream } from '../src/renderer/src/lib/stream-events'
import {
  beginRemoteSendRequest,
  finishRemoteSendRequest,
  restoreRemoteSessionItems
} from '../src/remote/src/session-state'

const sessionKey = 'remote-session-state-test'

function textOf(item: ThreadItem): string {
  return item.kind === 'assistant'
    ? item.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
    : ''
}

function assistantEvents(message: AgentMessage): PiEvent[] {
  const text = Array.isArray(message.content)
    ? message.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
    : String(message.content)
  return [
    { type: 'message_start', message: { role: 'assistant', content: [], timestamp: message.timestamp } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: text } },
    { type: 'message_end', message }
  ]
}

test('remote reconnect restores completed messages written while the stream was disconnected', () => {
  const messages: AgentMessage[] = [
    { role: 'user', content: 'question', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'completed while offline' }], timestamp: 2, stopReason: 'stop' }
  ]

  beginStream(sessionKey)
  const restored = restoreRemoteSessionItems(messages, [], sessionKey, [])
  const assistants = restored.filter((item) => item.kind === 'assistant')
  assert.equal(assistants.length, 1)
  assert.equal(textOf(assistants[0]), 'completed while offline')
})

test('remote reconnect applies a snapshot and avoids replaying the same message buffered during the fetch', () => {
  const completed: AgentMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'finished during snapshot fetch' }],
    timestamp: 42,
    stopReason: 'stop'
  }

  beginStream(sessionKey)
  const restored = restoreRemoteSessionItems(
    [completed],
    assistantEvents(completed),
    sessionKey,
    []
  )
  const assistants = restored.filter((item) => item.kind === 'assistant')
  assert.equal(assistants.length, 1)
  assert.equal(textOf(assistants[0]), 'finished during snapshot fetch')
})

test('remote snapshot matching keeps identical assistant text with a distinct message identity', () => {
  const snapshotMessage: AgentMessage = {
    role: 'assistant', content: [{ type: 'text', text: 'same body' }], timestamp: 100, stopReason: 'stop'
  }
  const newMessage: AgentMessage = {
    role: 'assistant', content: [{ type: 'text', text: 'same body' }], timestamp: 200, stopReason: 'stop'
  }

  beginStream(sessionKey)
  const restored = restoreRemoteSessionItems(
    [snapshotMessage],
    assistantEvents(newMessage),
    sessionKey,
    []
  )
  const assistants = restored.filter((item) => item.kind === 'assistant')
  assert.equal(assistants.length, 2)
  assert.deepEqual(assistants.map(textOf), ['same body', 'same body'])
})

test('remote reconnect does not match a different partial assistant only because its timestamp collides', () => {
  beginStream(sessionKey)
  const previousItems = [
    { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 100 } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'new answer' } }
  ].reduce((items, event) => applyEvent(items, event, { sessionKey }), [] as ThreadItem[])

  const restored = restoreRemoteSessionItems(
    [{ role: 'assistant', content: [{ type: 'text', text: 'other answer' }], timestamp: 100, stopReason: 'stop' }],
    [],
    sessionKey,
    previousItems
  )
  const assistants = restored.filter((item) => item.kind === 'assistant')
  assert.equal(assistants.length, 2)
  assert.deepEqual(assistants.map(textOf), ['other answer', 'new answer'])
})

test('remote reconnect matches a partial tool call by call identity without comparing incomplete arguments', () => {
  beginStream(sessionKey)
  const previousEvents: PiEvent[] = [
    { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 150 } },
    {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_start', contentIndex: 0, id: 'partial-call', toolName: 'search'
      }
    },
    {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_delta', contentIndex: 0, delta: '{"query":'
      }
    }
  ]
  const previousItems = previousEvents.reduce(
    (items, event) => applyEvent(items, event, { sessionKey }),
    [] as ThreadItem[]
  )
  const snapshotMessage: AgentMessage = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'partial-call', name: 'search', arguments: { query: 'latest' } }],
    timestamp: 150,
    stopReason: 'toolUse'
  }

  const restored = restoreRemoteSessionItems([snapshotMessage], [], sessionKey, previousItems)
  const assistants = restored.filter((item) => item.kind === 'assistant')
  assert.equal(assistants.length, 1)
  assert.equal(assistants[0].kind === 'assistant' && assistants[0].blocks[0]?.type, 'toolCall')
})

test('remote reconnect preserves a partial assistant when a resumed tool update has no new message_start', () => {
  beginStream(sessionKey)
  const initialEvents: PiEvent[] = [
    { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 300 } },
    {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_start', contentIndex: 0, id: 'remote-tool-1', toolName: 'search'
      }
    },
    {
      type: 'tool_execution_start',
      toolCallId: 'remote-tool-1', toolName: 'search', args: { query: 'status' }
    }
  ]
  const previousItems = initialEvents.reduce(
    (items, event) => applyEvent(items, event, { sessionKey }),
    [] as ThreadItem[]
  )

  const restored = restoreRemoteSessionItems(
    [{ role: 'user', content: 'find status', timestamp: 299 }],
    [{ type: 'tool_execution_update', toolCallId: 'remote-tool-1', partialResult: 'new result' }],
    sessionKey,
    previousItems
  )
  const assistant = restored.find((item) => item.kind === 'assistant')
  const tool = restored.find((item) => item.kind === 'tool' && item.toolCallId === 'remote-tool-1')
  assert.ok(assistant)
  assert.ok(tool && tool.kind === 'tool')
  assert.equal(assistant.streaming, true)
  assert.equal(tool.progress, 'new result')
})

test('remote reconnect keeps an observed running tool when its parent assistant is already settled', () => {
  beginStream(sessionKey)
  const assistant: AgentMessage = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'remote-running-tool', name: 'search', arguments: { query: 'status' } }],
    timestamp: 500,
    stopReason: 'toolUse'
  }
  const initialEvents: PiEvent[] = [
    { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 500 } },
    {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_start', contentIndex: 0, id: 'remote-running-tool', toolName: 'search'
      }
    },
    {
      type: 'tool_execution_start',
      toolCallId: 'remote-running-tool', toolName: 'search', args: { query: 'status' }
    },
    { type: 'tool_execution_update', toolCallId: 'remote-running-tool', partialResult: 'first progress' },
    { type: 'message_end', message: assistant }
  ]
  const previousItems = initialEvents.reduce(
    (items, event) => applyEvent(items, event, { sessionKey }),
    [] as ThreadItem[]
  )
  const previousTool = previousItems.find((item) => item.kind === 'tool')
  assert.ok(previousTool && previousTool.kind === 'tool')
  previousTool.durationMs = 321
  previousTool.startedAt = 1234

  const restored = restoreRemoteSessionItems(
    [assistant],
    [{ type: 'tool_execution_update', toolCallId: 'remote-running-tool', partialResult: 'latest progress' }],
    sessionKey,
    previousItems
  )
  const assistants = restored.filter((item) => item.kind === 'assistant')
  const tool = restored.find((item) => item.kind === 'tool' && item.toolCallId === 'remote-running-tool')
  assert.equal(assistants.length, 1)
  assert.ok(tool && tool.kind === 'tool')
  assert.equal(tool.status, 'running')
  assert.equal(tool.progress, 'latest progress')
  assert.equal(tool.durationMs, 321)
  assert.equal(tool.startedAt, 1234)
})

test('remote send completion only clears the request owned by its conversation', () => {
  let pending = beginRemoteSendRequest({}, 'conversation-A', 1)
  pending = beginRemoteSendRequest(pending, 'conversation-B', 2)
  assert.deepEqual(pending, { 'conversation-A': 1, 'conversation-B': 2 })

  const afterA = finishRemoteSendRequest(pending, 'conversation-A', 1)
  assert.deepEqual(afterA, { 'conversation-B': 2 })
  assert.equal(finishRemoteSendRequest(afterA, 'conversation-B', 99), afterA)
  assert.deepEqual(finishRemoteSendRequest(afterA, 'conversation-B', 2), {})
})
