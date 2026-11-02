/**
 * Empirical Adversarial Stress Testing Harness for Milestone 2 (Tasks F8-F15).
 *
 * Verification Objectives:
 * 1. Iterative Session Tree Stress Testing:
 *    - 3,000+ linear nodes (verifying zero call stack overflow across all 8 traversals).
 *    - Complex 64-branch hierarchical tree with 60+ fork points and bookkeeping leaf fallbacks.
 *    - Strict correctness assertion on entries, forkPoints, branchTips, active path, and search filtering.
 * 2. LRU Session Cache Stress Testing:
 *    - Rapid switching across 30 mock sessions.
 *    - Strict verification of 10 inactive cache bounding.
 *    - Active session eviction immunity.
 *    - Seamless rehydration / reloading of evicted sessions.
 *    - Inactive immunity for protected states (streaming, queued, running, UI dialog, draft).
 *    - Non-linear and pseudo-random rapid switching.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

const here = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(here, '..')

const tempHarnessDir = mkdtempSync(path.join(os.tmpdir(), 'pi-challenger-m2-'))
const mockElectronPath = path.join(tempHarnessDir, 'mock-electron.mjs')
const rootDirPosix = rootDir.replace(/\\/g, '/')

writeFileSync(
  mockElectronPath,
  `export const app = { getPath: () => "C:/tmp", getAppPath: () => "${rootDirPosix}", isPackaged: false, getVersion: () => "0.7.3", setAppUserModelId: () => {}, whenReady: () => Promise.resolve(), on: () => {} };
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true, filePath: undefined }) };
export const BrowserWindow = class { static getAllWindows() { return [] } isDestroyed() { return false } };
export const ipcMain = { handle: () => {}, on: () => {} };
export const shell = { showItemInFolder: () => {}, trashItem: async () => {} };
export const Notification = class { show() {} };
`
)

const harnessSourcePath = path.join(tempHarnessDir, 'harness-m2.ts')
const harnessBundlePath = path.join(tempHarnessDir, 'harness-m2.mjs')

const harnessSourceCode = `
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import {
  normalizeTree,
  pathToLeaf,
  treeStats,
  branchIds,
  flattenTree,
  pathToEntry,
  branchTips,
  filterTree,
  type SessionTree,
  type SessionTreeNode
} from '@renderer/lib/session-tree'
import {
  enforceSessionLru,
  touchSessionLru,
  forgetSessionLru,
  getSessionAccessLru,
  MAX_CACHED_INACTIVE_THREADS,
  type SessionThread
} from '@renderer/store/useAppStore'

function makeTreeNode(
  id: string,
  type: string,
  role?: string,
  text?: string,
  children: SessionTreeNode[] = []
): SessionTreeNode {
  return {
    entry: {
      type,
      id,
      message: role ? { role, content: text ?? id } : undefined
    },
    children
  }
}

function makeMockThread(overrides: Partial<SessionThread> = {}): SessionThread {
  return {
    status: { running: false, phase: 'idle' },
    isStreaming: false,
    run: { phase: 'idle', turns: 1, settled: true },
    items: [
      { id: 'item-u1', kind: 'user', text: 'Prompt message', images: [], timestamp: 100, order: 1 },
      { id: 'item-a1', kind: 'assistant', text: 'Model reply with long generated content', images: [], timestamp: 200, order: 2 }
    ],
    queue: { steering: [], followUp: [] },
    forkTargets: [],
    forking: false,
    version: 1,
    ...overrides
  }
}

// =========================================================================
// SECTION 1: ITERATIVE SESSION TREE ALGORITHMS STRESS TESTS
// =========================================================================

console.log('\\n[CHALLENGER STRESS SUITE 1] Iterative Session Tree Algorithm Verification')

// Test 1.1: 3,000-deep Linear Chain (Exceeds 2,500 Requirement)
{
  const LINEAR_DEPTH = 3000
  console.log(\`  Testing linear chain with \${LINEAR_DEPTH} nodes (zero recursion / stack overflow verification)...\`)

  const tStartBuild = performance.now()
  let rawLeaf: Record<string, unknown> = {
    entry: {
      type: 'message',
      id: \`node-\${LINEAR_DEPTH}\`,
      message: { role: 'assistant', content: \`Final response at step \${LINEAR_DEPTH}\` }
    },
    children: []
  }

  for (let i = LINEAR_DEPTH - 1; i >= 1; i--) {
    const isUser = i % 2 === 1
    rawLeaf = {
      entry: {
        type: 'message',
        id: \`node-\${i}\`,
        message: {
          role: isUser ? 'user' : 'assistant',
          content: isUser ? \`User query \${i}\` : \`Assistant explanation \${i}\`
        }
      },
      children: [rawLeaf]
    }
  }

  const rawTree = {
    tree: [rawLeaf],
    leafId: \`node-\${LINEAR_DEPTH}\`
  }
  const buildDuration = (performance.now() - tStartBuild).toFixed(2)
  console.log(\`    Built raw test graph in \${buildDuration}ms\`)

  // 1. normalizeTree: Iterative parsing of 3,000 raw nodes
  const tNormStart = performance.now()
  const tree = normalizeTree(rawTree)
  const normDuration = (performance.now() - tNormStart).toFixed(2)
  assert.equal(tree.roots.length, 1, 'Normalized tree must have 1 root')
  assert.equal(tree.leafId, \`node-\${LINEAR_DEPTH}\`, 'Leaf ID must match')
  console.log(\`    ✔ normalizeTree parsed \${LINEAR_DEPTH} nested entries in \${normDuration}ms without stack overflow\`)

  // 2. treeStats: Iterative traversal
  const tStatsStart = performance.now()
  const stats = treeStats(tree)
  const statsDuration = (performance.now() - tStatsStart).toFixed(2)
  assert.equal(stats.entries, LINEAR_DEPTH, \`Entries must equal \${LINEAR_DEPTH}\`)
  assert.equal(stats.forkPoints, 0, 'Linear chain must have 0 fork points')
  console.log(\`    ✔ treeStats counted \${stats.entries} entries in \${statsDuration}ms\`)

  // 3. pathToLeaf: Iterative active path resolution
  const tPathStart = performance.now()
  const path = pathToLeaf(tree)
  const pathDuration = (performance.now() - tPathStart).toFixed(2)
  assert.equal(path.size, LINEAR_DEPTH, \`Path to leaf must contain all \${LINEAR_DEPTH} nodes\`)
  assert.equal(path.has('node-1'), true, 'Path must contain root node-1')
  assert.equal(path.has('node-1500'), true, 'Path must contain mid node-1500')
  assert.equal(path.has(\`node-\${LINEAR_DEPTH}\`), true, 'Path must contain leaf node')
  console.log(\`    ✔ pathToLeaf resolved \${path.size} path nodes in \${pathDuration}ms\`)

  // 4. branchIds: Iterative branch identification
  const tBranchStart = performance.now()
  const branches = branchIds(tree)
  const branchDuration = (performance.now() - tBranchStart).toFixed(2)
  assert.equal(branches.size, LINEAR_DEPTH - 1, 'All nodes except the leaf have children')
  assert.equal(branches.has('node-1'), true)
  assert.equal(branches.has(\`node-\${LINEAR_DEPTH}\`), false)
  console.log(\`    ✔ branchIds identified \${branches.size} parent nodes in \${branchDuration}ms\`)

  // 5. flattenTree: Iterative DFS flattening
  const tFlattenStart = performance.now()
  const rows = flattenTree(tree, branches)
  const flattenDuration = (performance.now() - tFlattenStart).toFixed(2)
  assert.equal(rows.length, LINEAR_DEPTH, \`Flattened rows count must be \${LINEAR_DEPTH}\`)
  assert.equal(rows[0].id, 'node-1')
  assert.equal(rows[0].depth, 0)
  assert.equal(rows[LINEAR_DEPTH - 1].id, \`node-\${LINEAR_DEPTH}\`)
  assert.equal(rows[LINEAR_DEPTH - 1].depth, LINEAR_DEPTH - 1)
  assert.equal(rows[LINEAR_DEPTH - 1].leaf, true)
  console.log(\`    ✔ flattenTree generated \${rows.length} rows at max depth \${rows[rows.length - 1].depth} in \${flattenDuration}ms\`)

  // 6. pathToEntry: Parent resolution from deep node
  const tPathToEntryStart = performance.now()
  const entryPath = pathToEntry(tree, \`node-\${LINEAR_DEPTH}\`)
  const pathToEntryDuration = (performance.now() - tPathToEntryStart).toFixed(2)
  assert.equal(entryPath.length, LINEAR_DEPTH)
  assert.equal(entryPath[0], 'node-1')
  assert.equal(entryPath[LINEAR_DEPTH - 1], \`node-\${LINEAR_DEPTH}\`)
  console.log(\`    ✔ pathToEntry reconstructed \${entryPath.length} ancestor links in \${pathToEntryDuration}ms\`)

  // 7. branchTips: Single linear branch tip
  const tTipsStart = performance.now()
  const tips = branchTips(tree)
  const tipsDuration = (performance.now() - tTipsStart).toFixed(2)
  assert.deepEqual(tips, [\`node-\${LINEAR_DEPTH}\`])
  console.log(\`    ✔ branchTips correctly returned single tip in \${tipsDuration}ms\`)

  // 8. filterTree: Matching row in deep linear tree
  const tFilterStart = performance.now()
  const filtered = filterTree(tree, branches, 'Assistant explanation 1500')
  const filterDuration = (performance.now() - tFilterStart).toFixed(2)
  assert.equal(filtered.matched, true)
  assert.equal(filtered.rows.length, 1500, 'Filtering node 1500 must retain itself and all 1499 ancestors')
  assert.equal(filtered.rows[0].id, 'node-1')
  assert.equal(filtered.rows[1499].id, 'node-1500')
  console.log(\`    ✔ filterTree preserved 1500-node ancestor chain in \${filterDuration}ms\`)
}

// Test 1.2: Complex Multi-branch Tree (60+ Fork Points, 64 Divergent Branches, 3,200+ Nodes)
{
  console.log('\\n  Testing complex tree with 64 divergent branches, 60+ fork points, and bookkeeping leaf fallbacks...')

  const TOTAL_BRANCHES = 64
  const NODES_PER_BRANCH = 50

  // Construct a trunk with 64 branches splitting off at different heights
  // To create >= 60 fork points, we fork at each trunk node from trunk-1 to trunk-63!
  const rootNode = makeTreeNode('trunk-0', 'message', 'user', 'Initial prompt at trunk 0')
  let currentTrunk = rootNode

  const expectedTips: string[] = []

  for (let b = 0; b < TOTAL_BRANCHES; b++) {
    const branchRoot = makeTreeNode(\`branch-\${b}-0\`, 'message', 'assistant', \`Branch \${b} start\`)
    let currentBranchNode = branchRoot

    for (let step = 1; step < NODES_PER_BRANCH; step++) {
      const isLast = step === NODES_PER_BRANCH - 1
      // For even-numbered branches, make the final node a bookkeeping entry (model_change)
      // to test branchTips fallback to the preceding visible row!
      if (isLast && b % 2 === 0) {
        const bookkeepingNode: SessionTreeNode = {
          entry: {
            type: 'custom_bookkeeping',
            id: \`branch-\${b}-\${step}-meta\`
          },
          children: []
        }
        currentBranchNode.children.push(bookkeepingNode)
        // Expected tip must be the parent row since custom_bookkeeping is not rendered as a row!
        expectedTips.push(currentBranchNode.entry.id!)
      } else {
        const nextNode = makeTreeNode(
          \`branch-\${b}-\${step}\`,
          'message',
          step % 2 === 1 ? 'user' : 'assistant',
          \`Branch \${b} step \${step}\`
        )
        currentBranchNode.children.push(nextNode)
        currentBranchNode = nextNode
        if (isLast) {
          expectedTips.push(nextNode.entry.id!)
        }
      }
    }

    if (b < TOTAL_BRANCHES - 1) {
      const nextTrunk = makeTreeNode(\`trunk-\${b + 1}\`, 'message', 'user', \`Trunk continuation \${b + 1}\`)
      currentTrunk.children = [branchRoot, nextTrunk]
      currentTrunk = nextTrunk
    } else {
      // Last branch
      currentTrunk.children = [branchRoot]
    }
  }

  const complexTree: SessionTree = {
    roots: [rootNode],
    leafId: \`branch-42-\${NODES_PER_BRANCH - 1}-meta\`
  }

  // 1. treeStats
  const stats = treeStats(complexTree)
  assert.equal(stats.forkPoints, TOTAL_BRANCHES - 1, 'Must have exactly 63 fork points')
  // Total entries = trunk (64) + 64 branches * 50 nodes = 64 + 3200 = 3264 entries
  assert.equal(stats.entries, 64 + TOTAL_BRANCHES * NODES_PER_BRANCH)
  console.log(\`    ✔ treeStats correctly identified \${stats.entries} entries and \${stats.forkPoints} fork points\`)

  // 2. branchTips
  const tips = branchTips(complexTree)
  assert.equal(tips.length, TOTAL_BRANCHES, \`Must find all \${TOTAL_BRANCHES} branch tips\`)
  // Verify bookkeeping leaves correctly fell back to visible parent rows
  for (let b = 0; b < TOTAL_BRANCHES; b++) {
    if (b % 2 === 0) {
      // Bookkeeping fallback: tip is branch-{b}-{NODES_PER_BRANCH-2}
      const expectedFallback = \`branch-\${b}-\${NODES_PER_BRANCH - 2}\`
      assert.equal(tips[b], expectedFallback, \`Branch \${b} tip must fall back to visible parent \${expectedFallback}\`)
    } else {
      const expectedDirect = \`branch-\${b}-\${NODES_PER_BRANCH - 1}\`
      assert.equal(tips[b], expectedDirect, \`Branch \${b} tip must be \${expectedDirect}\`)
    }
  }
  console.log(\`    ✔ branchTips resolved all \${TOTAL_BRANCHES} tips with 32 bookkeeping fallbacks\`)

  // 3. pathToLeaf for branch 42
  const path = pathToLeaf(complexTree)
  assert.equal(path.has('trunk-0'), true)
  assert.equal(path.has('trunk-42'), true)
  assert.equal(path.has('branch-42-0'), true)
  assert.equal(path.has(\`branch-42-\${NODES_PER_BRANCH - 1}-meta\`), true)
  assert.equal(path.has(\`branch-42-\${NODES_PER_BRANCH - 2}\`), true)
  assert.equal(path.has('branch-10-0'), false, 'Unrelated branch must not be in active path')
  console.log(\`    ✔ pathToLeaf precisely tracked active path for branch 42\`)

  // 4. flattenTree with branch expansion
  const allBranchIds = branchIds(complexTree)
  assert.ok(allBranchIds.size >= stats.forkPoints)
  const flattened = flattenTree(complexTree, allBranchIds)
  assert.ok(flattened.length > 3000, 'All expanded rows rendered')
  console.log(\`    ✔ flattenTree rendered \${flattened.length} rows across 64 branches\`)

  // 5. filterTree targeting 3 branches simultaneously
  const multiMatchView = filterTree(complexTree, new Set(), 'Branch 17 step 25')
  assert.equal(multiMatchView.matched, true)
  assert.ok(multiMatchView.rows.some((r) => r.id === 'branch-17-25'))
  assert.ok(multiMatchView.rows.some((r) => r.id === 'trunk-0'))
  console.log(\`    ✔ filterTree correctly isolated target branch and ancestors\`)
}


// =========================================================================
// SECTION 2: LRU SESSION CACHE & MEMORY BOUNDING STRESS TESTS
// =========================================================================

console.log('\\n[CHALLENGER STRESS SUITE 2] LRU Session Cache Memory Bounding Verification')

// Test 2.1: Rapid Switching Across 30 Mock Sessions (Strict Bounding at 10)
{
  console.log('  Testing rapid switching across 30 sessions with MAX_CACHED_INACTIVE_THREADS = 10...')

  const TOTAL_SESSIONS = 30
  let threads: Record<string, SessionThread> = {}

  // Rapidly switch through 30 sessions sequentially (simulating user opening/hydrating each session)
  for (let s = 1; s <= TOTAL_SESSIONS; s++) {
    const activeFile = \`C:/sessions/session-\${String(s).padStart(2, '0')}.jsonl\`
    // Opening / hydrating session s
    threads[activeFile] = makeMockThread({ version: 1 })
    touchSessionLru(activeFile)
    threads = enforceSessionLru(threads, activeFile, 10)

    // Verification at EVERY switch step:
    // 1. Active session must have items and version intact (Active Immunity)
    assert.equal(threads[activeFile].version, 1, \`Active session \${activeFile} must maintain version\`)
    assert.ok(threads[activeFile].items.length > 0, \`Active session \${activeFile} must not have items dropped\`)

    // 2. Count inactive loaded sessions
    let inactiveLoadedCount = 0
    for (const [key, t] of Object.entries(threads)) {
      if (key !== activeFile && t.items.length > 0 && t.version > 0) {
        inactiveLoadedCount++
      }
    }
    assert.ok(
      inactiveLoadedCount <= 10,
      \`Inactive loaded sessions count (\${inactiveLoadedCount}) must never exceed bound of 10 at step \${s}\`
    )
  }

  // After switching through all 30 sessions, active is session-30
  // Exactly sessions 20 through 29 should be the 10 loaded inactive sessions
  // Sessions 01 through 19 must be evicted (items: [], version: 0)
  console.log('    Verifying post-switch eviction state...')
  for (let s = 1; s <= 19; s++) {
    const file = \`C:/sessions/session-\${String(s).padStart(2, '0')}.jsonl\`
    assert.equal(threads[file].version, 0, \`Session \${file} must be evicted (version 0)\`)
    assert.equal(threads[file].items.length, 0, \`Session \${file} items must be cleared\`)
  }

  for (let s = 20; s <= 29; s++) {
    const file = \`C:/sessions/session-\${String(s).padStart(2, '0')}.jsonl\`
    assert.equal(threads[file].version, 1, \`Session \${file} must be cached in LRU (version 1)\`)
    assert.equal(threads[file].items.length, 2, \`Session \${file} items must be preserved\`)
  }

  assert.equal(threads['C:/sessions/session-30.jsonl'].version, 1, 'Active session-30 must be loaded')
  console.log('    ✔ Inactive loaded sessions strictly bounded at 10; oldest 19 sessions evicted')

  // Test 2.2: Seamless Reloading / Hydration of Evicted Session
  console.log('  Testing seamless reloading of evicted session-05...')
  const reloadFile = 'C:/sessions/session-05.jsonl'
  assert.equal(threads[reloadFile].version, 0, 'Precondition: session-05 is evicted')

  // Simulate hydrateSession: re-loads items, bumps version, touches LRU, enforces LRU
  threads[reloadFile] = {
    ...threads[reloadFile],
    items: [
      { id: 'reloaded-1', kind: 'user', text: 'Restored message', images: [], timestamp: 500, order: 1 }
    ],
    version: 1
  }
  touchSessionLru(reloadFile)
  threads = enforceSessionLru(threads, reloadFile, 10)

  // Verify session-05 is active and loaded
  assert.equal(threads[reloadFile].version, 1)
  assert.equal(threads[reloadFile].items.length, 1)

  // Verify that the oldest inactive session among 20-29 (session-20) has now been evicted!
  assert.equal(threads['C:/sessions/session-20.jsonl'].version, 0, 'session-20 must be evicted to make room for session-30 in LRU')
  assert.equal(threads['C:/sessions/session-20.jsonl'].items.length, 0)

  // Sessions 21-30 are now the 10 inactive cached sessions!
  for (let s = 21; s <= 30; s++) {
    const file = \`C:/sessions/session-\${String(s).padStart(2, '0')}.jsonl\`
    assert.equal(threads[file].version, 1, \`Session \${file} must remain cached\`)
  }
  console.log('    ✔ Evicted session seamlessly restored; LRU evicted oldest inactive session to maintain bound')

  // Test 2.3: Adversarial Random Switching Across 50 Iterations
  console.log('  Testing 50 adversarial non-linear session switches...')
  for (let iter = 1; iter <= 50; iter++) {
    // Pick pseudo-random session between 1 and 30
    const targetIdx = ((iter * 17 + 7) % TOTAL_SESSIONS) + 1
    const targetFile = \`C:/sessions/session-\${String(targetIdx).padStart(2, '0')}.jsonl\`

    // If evicted, simulate rehydration
    if (threads[targetFile].version === 0) {
      threads[targetFile] = {
        ...threads[targetFile],
        items: [{ id: \`item-\${iter}\`, kind: 'user', text: 'Rehydrated', images: [], timestamp: iter, order: 1 }],
        version: 1
      }
    }

    touchSessionLru(targetFile)
    threads = enforceSessionLru(threads, targetFile, 10)

    // Verify invariants
    assert.ok(threads[targetFile].version >= 1, 'Target session must be loaded')
    let inactiveCount = 0
    for (const [key, t] of Object.entries(threads)) {
      if (key !== targetFile && t.items.length > 0 && t.version > 0) {
        inactiveCount++
      }
    }
    assert.ok(inactiveCount <= 10, \`Inactive count (\${inactiveCount}) <= 10 at switch iteration \${iter}\`)
  }
  console.log('    ✔ Completed 50 adversarial switches with 100% cache invariant preservation')

  // Test 2.4: Active Session Immunity with maxInactive = 0
  console.log('  Testing active session immunity with maxInactive = 0...')
  const activeOnlyFile = 'C:/sessions/session-12.jsonl'
  threads[activeOnlyFile] = makeMockThread({ version: 1 })
  touchSessionLru(activeOnlyFile)
  threads = enforceSessionLru(threads, activeOnlyFile, 0)
  assert.ok(threads[activeOnlyFile].version >= 1, 'Active session must NEVER be evicted even when maxInactive = 0')
  assert.ok(threads[activeOnlyFile].items.length > 0)
  // All inactive sessions must now be evicted
  for (const [key, t] of Object.entries(threads)) {
    if (key !== activeOnlyFile) {
      assert.equal(t.version, 0, \`Inactive session \${key} must be evicted with maxInactive = 0\`)
      assert.equal(t.items.length, 0)
    }
  }
  console.log('    ✔ Active session is strictly immune even when maxInactive = 0')

  // Test 2.5: Protected Inactive Thread Immunity
  console.log('  Testing immunity for streaming, running, queued, dialog, and draft sessions...')
  const protectedThreads: Record<string, SessionThread> = {
    'draft:live-draft': makeMockThread({ isStreaming: false }),
    'C:/sessions/streaming.jsonl': makeMockThread({ isStreaming: true }),
    'C:/sessions/running.jsonl': makeMockThread({ run: { phase: 'generating', turns: 1, settled: false } }),
    'C:/sessions/queued.jsonl': makeMockThread({ queue: { steering: ['next prompt'], followUp: [] } }),
    'C:/sessions/dialog.jsonl': makeMockThread({ uiRequest: { id: 'req-1', method: 'confirm', message: 'Approve?' } as any }),
    'C:/sessions/evictable-1.jsonl': makeMockThread(),
    'C:/sessions/evictable-2.jsonl': makeMockThread()
  }

  touchSessionLru('C:/sessions/evictable-1.jsonl')
  touchSessionLru('C:/sessions/evictable-2.jsonl')

  // Run with maxInactive = 0
  const protectedResult = enforceSessionLru(protectedThreads, undefined, 0)

  // The 5 protected sessions must NEVER be evicted
  assert.equal(protectedResult['draft:live-draft'].version, 1, 'Draft session must not be evicted')
  assert.equal(protectedResult['C:/sessions/streaming.jsonl'].version, 1, 'Streaming session must not be evicted')
  assert.equal(protectedResult['C:/sessions/running.jsonl'].version, 1, 'Running session must not be evicted')
  assert.equal(protectedResult['C:/sessions/queued.jsonl'].version, 1, 'Queued session must not be evicted')
  assert.equal(protectedResult['C:/sessions/dialog.jsonl'].version, 1, 'Dialog session must not be evicted')

  // The 2 unprotected sessions must be evicted
  assert.equal(protectedResult['C:/sessions/evictable-1.jsonl'].version, 0)
  assert.equal(protectedResult['C:/sessions/evictable-1.jsonl'].items.length, 0)
  assert.equal(protectedResult['C:/sessions/evictable-2.jsonl'].version, 0)
  assert.equal(protectedResult['C:/sessions/evictable-2.jsonl'].items.length, 0)
  console.log('    ✔ All 5 protected session states successfully resisted eviction')
}

console.log('\\n=========================================================================')
console.log('ALL EMPIRICAL ADVERSARIAL STRESS TESTS PASSED WITH ZERO FAILURES!')
console.log('=========================================================================\\n')
`

writeFileSync(harnessSourcePath, harnessSourceCode)

try {
  console.log('Bundling Milestone 2 Challenger Stress Harness with esbuild...')
  await esbuild.build({
    entryPoints: [harnessSourcePath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: harnessBundlePath,
    logLevel: 'warning',
    alias: {
      '@shared': path.resolve(rootDir, 'src', 'shared'),
      '@main': path.resolve(rootDir, 'src', 'main'),
      '@renderer': path.resolve(rootDir, 'src', 'renderer', 'src'),
      electron: mockElectronPath
    }
  })

  console.log('Executing Milestone 2 Challenger Stress Harness...')
  execFileSync(process.execPath, [harnessBundlePath], { stdio: 'inherit' })
} finally {
  rmSync(tempHarnessDir, { recursive: true, force: true })
}
