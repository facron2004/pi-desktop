import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ThreadItem } from '../src/renderer/src/lib/thread'
import { sessionMarkdown } from '../src/renderer/src/lib/session-markdown'

function user(text: string): ThreadItem {
  return { id: 'user', kind: 'user', text, images: [], timestamp: 1, order: 1 }
}

function assistant(text: string): ThreadItem {
  return {
    id: 'reply',
    kind: 'assistant',
    streaming: false,
    timestamp: 2,
    order: 2,
    blocks: [{ type: 'text', text }]
  }
}

test('an export names the conversation and says where it came from', () => {
  const markdown = sessionMarkdown([user('Ship it'), assistant('Done.')], {
    title: 'Release\nnotes',
    project: 'C:\\work\\shop',
    exportedAt: Date.UTC(2026, 10, 26, 8, 0, 0)
  })
  assert.equal(
    markdown,
    '# Release notes\n\n' +
      '- Project: `C:\\work\\shop`\n' +
      '- Exported: 2026-11-26T08:00:00.000Z\n\n' +
      '## You\n\nShip it\n\n## Pi\n\nDone.\n'
  )
})

test('an empty conversation still names itself', () => {
  assert.equal(sessionMarkdown([], { title: '   ' }), '# Conversation\n')
})

test('tool output is not part of the document', () => {
  const tool = {
    id: 'tool',
    kind: 'tool',
    toolCallId: 'call',
    toolName: 'bash',
    args: {},
    status: 'ok',
    result: 'THE_BUILD_LOG',
    timestamp: 2,
    order: 3
  } as ThreadItem
  const markdown = sessionMarkdown([user('Run it'), tool, assistant('It ran.')], {})
  assert.ok(!markdown.includes('THE_BUILD_LOG'))
  assert.ok(markdown.includes('## Pi\n\nIt ran.'))
})

test('a path cannot break out of its code span', () => {
  const markdown = sessionMarkdown([], { project: 'C:\\a`b' })
  assert.ok(markdown.includes('- Project: `C:\\a\'b`'))
})

test('an invalid export timestamp is left out instead of printing Invalid Date', () => {
  const markdown = sessionMarkdown([user('Hi')], { exportedAt: Number.NaN })
  assert.ok(!markdown.includes('Exported'))
  assert.ok(markdown.startsWith('# Conversation'))
})
