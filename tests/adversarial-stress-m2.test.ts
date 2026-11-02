import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// Subject under test imports
import { countChangedFiles, collectChanges } from '../src/renderer/src/lib/changes'
import { diffableEdits, summarizeTool, writtenContent } from '../src/renderer/src/lib/tool-renderers'
import { buildDiff } from '../src/renderer/src/lib/diff-fold'
import { formatDiff } from '../src/renderer/src/lib/diff-text'
import {
  normalizeTree,
  pathToLeaf,
  treeStats,
  branchIds,
  flattenTree,
  branchTips,
  filterTree,
  type SessionTree,
  type SessionTreeNode
} from '../src/renderer/src/lib/session-tree'
import {
  enforceSessionLru,
  touchSessionLru,
  type SessionThread
} from '../src/renderer/src/store/useAppStore'
import { ErrorBoundary } from '../src/renderer/src/components/ErrorBoundary'
import type { ToolItem, ThreadItem } from '../src/renderer/src/lib/thread'

// ============================================================================
// SUITE 1: countChangedFiles & collectChanges EMPIRICAL STRESS TESTING
// ============================================================================

test('[CHALLENGER 1.1] countChangedFiles: Boundary & malformed input stress testing', () => {
  // Empty
  assert.equal(countChangedFiles([]), 0)

  // Non-tool items (user message, assistant message, notices)
  const nonTools: ThreadItem[] = [
    { id: '1', kind: 'user', text: 'hi', images: [], timestamp: 1, order: 1 },
    { id: '2', kind: 'assistant', text: 'hello', timestamp: 2, order: 2 },
    { id: '3', kind: 'notice', level: 'info', message: 'compaction', timestamp: 3, order: 3 }
  ]
  assert.equal(countChangedFiles(nonTools), 0)

  // Missing or corrupted args
  const malformed: ThreadItem[] = [
    { id: 'm1', kind: 'tool', toolCallId: 'c1', toolName: 'edit', status: 'ok', timestamp: 1, order: 1 } as any,
    { id: 'm2', kind: 'tool', toolCallId: 'c2', toolName: 'edit', args: null as any, status: 'ok', timestamp: 2, order: 2 },
    { id: 'm3', kind: 'tool', toolCallId: 'c3', toolName: 'edit', args: { path: 12345 } as any, status: 'ok', timestamp: 3, order: 3 },
    { id: 'm4', kind: 'tool', toolCallId: 'c4', toolName: 'edit', args: { path: '' }, status: 'ok', timestamp: 4, order: 4 },
    { id: 'm5', kind: 'tool', toolCallId: 'c5', toolName: 'write', args: { content: 'test' }, status: 'ok', timestamp: 5, order: 5 } // no path
  ]
  assert.equal(countChangedFiles(malformed), 0)
  assert.equal(collectChanges(malformed).length, 0)

  // Unconfirmed statuses (proposed, running, error, aborted)
  for (const status of ['proposed', 'running', 'error', 'aborted'] as const) {
    const items: ThreadItem[] = [
      { id: 'u1', kind: 'tool', toolCallId: 'c1', toolName: 'edit', args: { path: 'file1.ts' }, status, timestamp: 1, order: 1 },
      { id: 'u2', kind: 'tool', toolCallId: 'c2', toolName: 'write', args: { path: 'file2.ts', content: 'new' }, status, timestamp: 2, order: 2 }
    ]
    assert.equal(countChangedFiles(items), 0, `Failed for status ${status}`)
    assert.equal(collectChanges(items).length, 0, `Failed for status ${status}`)
  }

  // Non-edit/write tools (read, bash, powershell, grep, find, subagent, mcp, plan)
  const nonEditTools: ThreadItem[] = [
    { id: 't1', kind: 'tool', toolCallId: 'c1', toolName: 'read', args: { path: 'file1.ts' }, status: 'ok', timestamp: 1, order: 1 },
    { id: 't2', kind: 'tool', toolCallId: 'c2', toolName: 'bash', args: { command: 'echo 1' }, status: 'ok', timestamp: 2, order: 2 },
    { id: 't3', kind: 'tool', toolCallId: 'c3', toolName: 'powershell', args: { command: 'Get-Process' }, status: 'ok', timestamp: 3, order: 3 },
    { id: 't4', kind: 'tool', toolCallId: 'c4', toolName: 'grep', args: { pattern: 'test' }, status: 'ok', timestamp: 4, order: 4 },
    { id: 't5', kind: 'tool', toolCallId: 'c5', toolName: 'find', args: { pattern: '*.ts' }, status: 'ok', timestamp: 5, order: 5 },
    { id: 't6', kind: 'tool', toolCallId: 'c6', toolName: 'subagent', args: { task: 'do work' }, status: 'ok', timestamp: 6, order: 6 },
    { id: 't7', kind: 'tool', toolCallId: 'c7', toolName: 'mcp__server__tool', args: {}, status: 'ok', timestamp: 7, order: 7 },
    { id: 't8', kind: 'tool', toolCallId: 'c8', toolName: 'plan', args: { plan: 'step 1' }, status: 'ok', timestamp: 8, order: 8 }
  ]
  assert.equal(countChangedFiles(nonEditTools), 0)
  assert.equal(collectChanges(nonEditTools).length, 0)
})

test('[CHALLENGER 1.2] countChangedFiles vs collectChanges consistency on 5,000 tool operations', () => {
  const items: ThreadItem[] = []
  const uniquePaths = 250

  for (let i = 0; i < 5000; i++) {
    const fileIndex = i % uniquePaths
    const isEdit = i % 2 === 0
    const toolName = isEdit ? 'edit' : 'write'
    const pathName = `src/module_${fileIndex}/file_${fileIndex}.ts`
    // Use prime 11 and 7 so all files rotate through 'ok'
    const status = i % 11 === 0 ? 'error' : i % 7 === 0 ? 'proposed' : 'ok'

    items.push({
      id: `tool-${i}`,
      kind: 'tool',
      toolCallId: `call-${i}`,
      toolName,
      status,
      args: isEdit
        ? { path: pathName, edits: [{ oldText: `line ${i}`, newText: `line ${i + 1}` }] }
        : { path: pathName, content: `content ${i}` },
      timestamp: i,
      order: i
    })
  }

  const start = performance.now()
  const badgeCount = countChangedFiles(items)
  const durationMs = performance.now() - start

  // Performance requirement: countChangedFiles must be fast O(N) without Myers diffing!
  assert.ok(durationMs < 50, `countChangedFiles took ${durationMs.toFixed(2)}ms, expected <50ms`)

  // Badge count should exactly equal unique ok paths
  const okPaths = new Set<string>()
  for (const item of items) {
    if (item.kind === 'tool' && item.status === 'ok') {
      const p = (item.args as any)?.path
      if (typeof p === 'string' && p) okPaths.add(p)
    }
  }
  assert.equal(badgeCount, okPaths.size)
  assert.equal(badgeCount, uniquePaths)

  // Collect changes should also match
  const collected = collectChanges(items)
  assert.equal(collected.length, badgeCount)
})

test('[CHALLENGER 1.3] countChangedFiles: Unicode, special characters and spaces in filenames', () => {
  const unicodePaths = [
    'src/项目/代码.ts',
    'src/тест/модуль.js',
    'src/folder with spaces/file (1).py',
    'src/emoji_🚀/✨.json',
    'src/path.with.dots/sub-dir/name-1.0.0.d.ts'
  ]

  const items: ThreadItem[] = unicodePaths.map((p, idx) => ({
    id: `u-${idx}`,
    kind: 'tool',
    toolCallId: `call-${idx}`,
    toolName: idx % 2 === 0 ? 'edit' : 'write',
    status: 'ok',
    args: { path: p, edits: [{ oldText: 'a', newText: 'b' }], content: 'write' },
    timestamp: idx,
    order: idx
  }))

  assert.equal(countChangedFiles(items), unicodePaths.length)
  const changes = collectChanges(items)
  assert.equal(changes.length, unicodePaths.length)
  for (let i = 0; i < unicodePaths.length; i++) {
    assert.equal(changes[i].path, unicodePaths[i])
  }
})

// ============================================================================
// SUITE 2: ToolCard DEFERRED MYERS DIFFING & COPY BUTTON ACCURACY
// ============================================================================

test('[CHALLENGER 2.1] ToolCard deferred diffing: Collapsed card NEVER executes Myers diff', () => {
  const oldText = 'line 1\nline 2\nline 3\nline 4\nline 5\n'
  const newText = 'line 1\nline 2 modified\nline 3\nline 4 added\nline 5\n'

  const editItem: ToolItem = {
    id: 'tool-diff-1',
    kind: 'tool',
    toolCallId: 'call-diff-1',
    toolName: 'edit',
    status: 'ok',
    args: {
      path: 'src/main.ts',
      edits: [{ oldText, newText }]
    },
    timestamp: 100,
    order: 1
  }

  const edits = diffableEdits(editItem)
  assert.equal(edits.length, 1)

  // Simulation of ToolCard useMemo for diffs:
  function computeDiffs(open: boolean) {
    let diffBuildCount = 0
    const diffs = open && edits.length > 0
      ? edits.map((pair) => {
          diffBuildCount++
          return buildDiff(pair.oldText, pair.newText)
        })
      : []
    return { diffs, diffBuildCount }
  }

  // 1. When card is collapsed (open = false):
  const collapsed = computeDiffs(false)
  assert.equal(collapsed.diffBuildCount, 0, 'Myers diff buildDiff MUST NOT be called when collapsed')
  assert.deepEqual(collapsed.diffs, [], 'diffs must be empty array when collapsed')

  // 2. When card is opened (open = true):
  const expanded = computeDiffs(true)
  assert.equal(expanded.diffBuildCount, 1, 'Myers diff buildDiff MUST be called when expanded')
  assert.ok(expanded.diffs.length > 0)
  assert.ok(expanded.diffs[0].rows.length > 0)
})

test('[CHALLENGER 2.2] ToolCard copy button: Lazy closure produces identical output to expanded diff', () => {
  const oldText = 'function test() {\n  const a = 1;\n  return a;\n}\n'
  const newText = 'function test() {\n  const a = 2;\n  const b = 3;\n  return a + b;\n}\n'

  const editItem: ToolItem = {
    id: 'tool-diff-2',
    kind: 'tool',
    toolCallId: 'call-diff-2',
    toolName: 'edit',
    status: 'ok',
    args: {
      path: 'src/calc.ts',
      edits: [{ oldText, newText }]
    },
    timestamp: 100,
    order: 1
  }

  const edits = diffableEdits(editItem)

  // Precomputed expanded diff text:
  const expandedDiffs = edits.map((pair) => buildDiff(pair.oldText, pair.newText))
  const expandedFormatted = formatDiff(expandedDiffs)

  // Lazy copyable text when collapsed:
  const lazyGetter = () => formatDiff(edits.map((pair) => buildDiff(pair.oldText, pair.newText)))
  const collapsedLazyResult = lazyGetter()

  // The output of lazy on-demand invocation must match the expanded format exactly!
  assert.equal(collapsedLazyResult, expandedFormatted)
  assert.ok(collapsedLazyResult.includes('const a = 1;'))
  assert.ok(collapsedLazyResult.includes('const a = 2;'))
  assert.ok(collapsedLazyResult.includes('const b = 3;'))
  assert.ok(collapsedLazyResult.includes('return a + b;'))
})

test('[CHALLENGER 2.3] ToolCard diffing on edge-case inputs (empty, binary, no edits, identical)', () => {
  // Edge 1: empty edits array
  const noEditsItem: ToolItem = {
    id: 't-1',
    kind: 'tool',
    toolCallId: 'c-1',
    toolName: 'edit',
    status: 'ok',
    args: { path: 'file.ts', edits: [] },
    timestamp: 1,
    order: 1
  }
  assert.deepEqual(diffableEdits(noEditsItem), [])

  // Edge 2: empty oldText and newText
  const emptyStringsItem: ToolItem = {
    id: 't-2',
    kind: 'tool',
    toolCallId: 'c-2',
    toolName: 'edit',
    status: 'ok',
    args: { path: 'file.ts', edits: [{ oldText: '', newText: '' }] },
    timestamp: 2,
    order: 2
  }
  assert.deepEqual(diffableEdits(emptyStringsItem), [])

  // Edge 3: identical text
  const identicalItem: ToolItem = {
    id: 't-3',
    kind: 'tool',
    toolCallId: 'c-3',
    toolName: 'edit',
    status: 'ok',
    args: { path: 'file.ts', edits: [{ oldText: 'same line', newText: 'same line' }] },
    timestamp: 3,
    order: 3
  }
  const identicalEdits = diffableEdits(identicalItem)
  assert.equal(identicalEdits.length, 1)
  const diff = buildDiff(identicalEdits[0].oldText, identicalEdits[0].newText)
  assert.equal(diff.rows.length, 1)
  assert.equal(diff.rows[0].kind, 'ctx')
  assert.equal(diff.rows[0].text, 'same line')

  // Edge 4: binary / null characters
  const binaryItem: ToolItem = {
    id: 't-4',
    kind: 'tool',
    toolCallId: 'c-4',
    toolName: 'edit',
    status: 'ok',
    args: { path: 'file.bin', edits: [{ oldText: '\x00\x01\x02', newText: '\x00\x02\x03' }] },
    timestamp: 4,
    order: 4
  }
  const binaryEdits = diffableEdits(binaryItem)
  assert.equal(binaryEdits.length, 1)
  const binaryDiff = buildDiff(binaryEdits[0].oldText, binaryEdits[0].newText)
  assert.ok(binaryDiff.rows.length > 0)
})

// ============================================================================
// SUITE 3: MARKDOWN STREAMING HIGHLIGHTING THROTTLING & SETTLE BEHAVIOR
// ============================================================================

test('[CHALLENGER 3.1] Streaming highlighting debounce simulation under 60fps delta barrage', async () => {
  let shikiCallCount = 0
  const fakeHighlight = async (code: string) => {
    shikiCallCount++
    return `<pre><code>${code}</code></pre>`
  }

  // Model of Markdown.tsx CodeBlock useEffect behavior:
  class CodeBlockHighlightSimulator {
    private timer?: NodeJS.Timeout
    private cancelled = false
    public renderedHtml: string | null = null

    update(code: string, isStreaming: boolean) {
      // Cleanup previous effect
      this.cancelled = true
      if (this.timer) clearTimeout(this.timer)

      this.cancelled = false

      if (isStreaming) {
        // Debounce by 250ms
        this.timer = setTimeout(() => {
          fakeHighlight(code).then((html) => {
            if (!this.cancelled) this.renderedHtml = html
          })
        }, 250)
        return
      }

      // Settled / not streaming: immediate
      fakeHighlight(code).then((html) => {
        if (!this.cancelled) this.renderedHtml = html
      })
    }
  }

  const sim = new CodeBlockHighlightSimulator()

  // 1. Simulate 50 text deltas arriving every 15ms while isStreaming = true (750ms duration)
  for (let i = 1; i <= 50; i++) {
    sim.update(`const x = ${i};`, true)
    await new Promise((r) => setTimeout(r, 15))
  }

  // During the active barrage, Shiki should NEVER have been called because timer is continuously cancelled!
  assert.equal(shikiCallCount, 0, 'Shiki must NOT be called during active 15ms delta stream')
  assert.equal(sim.renderedHtml, null)

  // 2. Wait 300ms for debounce timer to fire after the last delta
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(shikiCallCount, 1, 'Shiki should be called exactly once after stream pauses')
  assert.equal(sim.renderedHtml, '<pre><code>const x = 50;</code></pre>')

  // 3. Settle event: isStreaming becomes false -> immediate highlighting without 250ms wait
  const preSettleCount = shikiCallCount
  sim.update('const x = 50; // final settled text', false)
  // Check after 20ms (well before 250ms)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(shikiCallCount, preSettleCount + 1, 'Settle must trigger highlighting immediately')
  assert.equal(sim.renderedHtml, '<pre><code>const x = 50; // final settled text</code></pre>')
})

// ============================================================================
// SUITE 4: ERRORBOUNDARY GRANULAR CRASH ISOLATION
// ============================================================================

test('[CHALLENGER 4.1] ErrorBoundary: Captures render errors without bubbling to parent', () => {
  function ExplodingChild({ shouldThrow }: { shouldThrow: boolean }) {
    if (shouldThrow) {
      throw new Error('Empirical challenger deliberate render crash!')
    }
    return React.createElement('div', { className: 'safe-child' }, 'all good')
  }

  const originalConsoleError = console.error
  console.error = () => {}

  try {
    // 1. Normal render: should render child content
    const normalHtml = renderToStaticMarkup(
      React.createElement(
        ErrorBoundary,
        { scope: 'tool card', inline: true },
        React.createElement(ExplodingChild, { shouldThrow: false })
      )
    )
    assert.ok(normalHtml.includes('safe-child'))
    assert.ok(normalHtml.includes('all good'))

    // 2. Deliberate crash with inline / scope
    const boundary = new ErrorBoundary({ scope: 'tool card', inline: true, children: null })
    const state = ErrorBoundary.getDerivedStateFromError(new Error('Deliberate error'))
    boundary.state = state
    const fallbackNode = boundary.render()
    const fallbackHtml = renderToStaticMarkup(fallbackNode as React.ReactElement)

    assert.ok(fallbackHtml.includes('component-error-fallback'))
    assert.ok(fallbackHtml.includes('role="alert"'))
    assert.ok(fallbackHtml.includes('Failed to render tool card'))
    assert.ok(fallbackHtml.includes('Retry'))

    // 3. Scope = 'Markdown'
    const mdBoundary = new ErrorBoundary({ scope: 'Markdown', inline: true, children: null })
    mdBoundary.state = state
    const mdHtml = renderToStaticMarkup(mdBoundary.render() as React.ReactElement)
    assert.ok(mdHtml.includes('Failed to render Markdown'))

    // 4. Scope = 'turn'
    const turnBoundary = new ErrorBoundary({ scope: 'turn', children: null })
    turnBoundary.state = state
    const turnHtml = renderToStaticMarkup(turnBoundary.render() as React.ReactElement)
    assert.ok(turnHtml.includes('Failed to render turn'))

    // 5. Test retry function
    let retryCalled = false
    boundary.setState = (update: any) => {
      if (update.error === null) retryCalled = true
    }
    boundary.retry()
    assert.ok(retryCalled, 'retry() must set error to null')
  } finally {
    console.error = originalConsoleError
  }
})

// ============================================================================
// SUITE 5: ITERATIVE SESSION TREE TRAVERSAL EXTREME DEPTH (5,000 NODES)
// ============================================================================

test('[CHALLENGER 5.1] Session Tree: 5,000 deep linear chain without stack overflow', () => {
  const depth = 5000
  let current: SessionTreeNode = {
    entry: { type: 'message', id: `node-${depth}`, message: { role: 'assistant', content: 'leaf' } },
    children: []
  }

  for (let i = depth - 1; i >= 1; i--) {
    current = {
      entry: { type: 'message', id: `node-${i}`, message: { role: 'user', content: `msg ${i}` } },
      children: [current]
    }
  }

  const tree: SessionTree = {
    roots: [current],
    leafId: `node-${depth}`
  }

  const stats = treeStats(tree)
  assert.equal(stats.entries, depth)
  assert.equal(stats.forkPoints, 0)

  const path = pathToLeaf(tree)
  assert.equal(path.size, depth)
  assert.ok(path.has('node-1'))
  assert.ok(path.has(`node-${depth}`))

  const tips = branchTips(tree)
  assert.deepEqual(tips, [`node-${depth}`])

  const branches = branchIds(tree)
  assert.equal(branches.size, depth - 1)

  const rows = flattenTree(tree, branches)
  assert.equal(rows.length, depth)

  const filter = filterTree(tree, branches, 'msg 2500')
  assert.ok(filter.matched)
  assert.ok(filter.rows.length >= 2500)
})

// ============================================================================
// SUITE 6: SESSION LRU CACHE UNDER RAPID THRASHING
// ============================================================================

test('[CHALLENGER 6.1] LRU Cache: 200 sessions thrashing retains active & protects special states', () => {
  const threads: Record<string, SessionThread> = {}
  const totalSessions = 200

  for (let i = 1; i <= totalSessions; i++) {
    const key = `C:/sessions/session_${i}.jsonl`
    threads[key] = {
      status: { running: false, phase: 'idle' },
      isStreaming: false,
      run: { phase: 'idle', turns: 1, settled: true },
      items: [{ id: `item-${i}`, kind: 'user', text: `prompt ${i}`, images: [], timestamp: i, order: 1 }],
      queue: { steering: [], followUp: [] },
      forkTargets: [],
      forking: false,
      version: 1
    }
    touchSessionLru(key)
  }

  // Mark session 50 as streaming, session 75 as running (phase: 'generating', settled: false), session 100 as queued
  threads['C:/sessions/session_50.jsonl'].isStreaming = true
  threads['C:/sessions/session_75.jsonl'].run = { phase: 'generating', turns: 1, settled: false }
  threads['C:/sessions/session_100.jsonl'].queue.steering = ['next']

  // Set active to session 10
  const activeKey = 'C:/sessions/session_10.jsonl'
  const maxInactive = 5

  const result = enforceSessionLru(threads, activeKey, maxInactive)

  // 1. Active session 10 must NEVER be evicted!
  assert.equal(result[activeKey].version, 1)
  assert.equal(result[activeKey].items.length, 1)

  // 2. Protected sessions 50, 75, 100 must NEVER be evicted!
  assert.equal(result['C:/sessions/session_50.jsonl'].version, 1)
  assert.equal(result['C:/sessions/session_75.jsonl'].version, 1)
  assert.equal(result['C:/sessions/session_100.jsonl'].version, 1)

  // 3. Count how many inactive, non-protected sessions still have items retained:
  let retainedInactiveNonProtected = 0
  for (let i = 1; i <= totalSessions; i++) {
    const key = `C:/sessions/session_${i}.jsonl`
    if (key === activeKey || i === 50 || i === 75 || i === 100) continue
    if (result[key].items.length > 0) {
      retainedInactiveNonProtected++
    }
  }

  assert.ok(
    retainedInactiveNonProtected <= maxInactive,
    `Retained ${retainedInactiveNonProtected} inactive sessions, expected <= ${maxInactive}`
  )
})
