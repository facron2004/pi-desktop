import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  normalizeTree,
  pathToLeaf,
  treeStats,
  branchIds,
  flattenTree,
  branchTips,
  filterTree,
  type SessionTree,
  type SessionTreeNode,
  type TreeRow
} from '../src/renderer/src/lib/session-tree'
import { treeNavAction } from '../src/renderer/src/lib/tree-nav'

function makeNode(
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

test('treeStats counts entries and branch split points correctly', () => {
  // Tree with 1 root and 2 branches:
  // r1 -> [c1 -> [c1_1], c2]
  const tree: SessionTree = {
    roots: [
      makeNode('r1', 'message', 'user', 'hello', [
        makeNode('c1', 'message', 'assistant', 'branch 1', [
          makeNode('c1_1', 'message', 'user', 'branch 1 child')
        ]),
        makeNode('c2', 'message', 'assistant', 'branch 2')
      ])
    ],
    leafId: 'c1_1'
  }

  const stats = treeStats(tree)
  assert.equal(stats.entries, 4)
  assert.equal(stats.forkPoints, 1) // r1 has 2 children
})

test('pathToLeaf tracks path from active leaf to root and branchIds finds parent nodes', () => {
  const tree: SessionTree = {
    roots: [
      makeNode('r1', 'message', 'user', 'root', [
        makeNode('b1', 'message', 'assistant', 'ans1', [
          makeNode('b1_leaf', 'message', 'user', 'leaf1')
        ]),
        makeNode('b2', 'message', 'assistant', 'ans2')
      ])
    ],
    leafId: 'b1_leaf'
  }

  const path = pathToLeaf(tree)
  assert.equal(path.has('b1_leaf'), true)
  assert.equal(path.has('b1'), true)
  assert.equal(path.has('r1'), true)
  assert.equal(path.has('b2'), false)

  const branches = branchIds(tree)
  assert.equal(branches.has('r1'), true)
  assert.equal(branches.has('b1'), true)
  assert.equal(branches.has('b1_leaf'), false)
  assert.equal(branches.has('b2'), false)
})

test('branchTips identifies tips of all branches and handles bookkeeping entries gracefully', () => {
  // r1 -> [b1 -> meta_leaf (custom_meta), b2]
  const tree: SessionTree = {
    roots: [
      makeNode('r1', 'message', 'user', 'prompt', [
        makeNode('b1', 'message', 'assistant', 'reply', [
          makeNode('meta1', 'custom_meta') // bookkeeping leaf without row
        ]),
        makeNode('b2', 'message', 'assistant', 'reply2')
      ])
    ],
    leafId: 'meta1'
  }

  const tips = branchTips(tree)
  assert.deepEqual(tips, ['b1', 'b2'])
})

test('flattenTree flattens visible rows with correct depth and respect for expanded set', () => {
  const tree: SessionTree = {
    roots: [
      makeNode('r1', 'message', 'user', 'prompt', [
        makeNode('a1', 'message', 'assistant', 'reply', [
          makeNode('u2', 'message', 'user', 'next prompt')
        ])
      ])
    ],
    leafId: 'u2'
  }

  // Fully expanded
  const allRows = flattenTree(tree, new Set(['r1', 'a1']))
  assert.equal(allRows.length, 3)
  assert.equal(allRows[0].id, 'r1')
  assert.equal(allRows[0].depth, 0)
  assert.equal(allRows[1].id, 'a1')
  assert.equal(allRows[1].depth, 1)
  assert.equal(allRows[2].id, 'u2')
  assert.equal(allRows[2].depth, 2)
  assert.equal(allRows[2].leaf, true)

  // Collapsed at a1
  const collapsedRows = flattenTree(tree, new Set(['r1']))
  assert.equal(collapsedRows.length, 2)
  assert.equal(collapsedRows[0].id, 'r1')
  assert.equal(collapsedRows[1].id, 'a1')
  assert.equal(collapsedRows[1].childrenOpen, false)
})

test('filterTree matches rows and keeps ancestor paths open', () => {
  const tree: SessionTree = {
    roots: [
      makeNode('r1', 'message', 'user', 'general question', [
        makeNode('a1', 'message', 'assistant', 'specific unique keyword answer')
      ])
    ],
    leafId: 'a1'
  }

  const view = filterTree(tree, new Set(), 'unique keyword')
  assert.equal(view.matched, true)
  assert.equal(view.rows.length, 2)
  assert.equal(view.rows[0].id, 'r1') // Ancestor kept
  assert.equal(view.rows[1].id, 'a1') // Matched entry
})

test('iterative traversals handle extremely deep trees without call-stack overflow', () => {
  // Construct a tree of depth 2,000
  // In recursive implementation, depth > 1000 throws RangeError: Maximum call stack size exceeded.
  const depth = 2000
  let leaf: SessionTreeNode = makeNode(`node-${depth}`, 'message', 'assistant', `reply ${depth}`)
  const leafId = `node-${depth}`

  for (let i = depth - 1; i >= 1; i--) {
    const parent: SessionTreeNode = makeNode(
      `node-${i}`,
      i % 2 === 1 ? 'message' : 'message',
      i % 2 === 1 ? 'user' : 'assistant',
      `text ${i}`,
      [leaf]
    )
    leaf = parent
  }

  const deepTree: SessionTree = {
    roots: [leaf],
    leafId
  }

  // Verify none of the 5 traversals throw RangeError
  const stats = treeStats(deepTree)
  assert.equal(stats.entries, depth)
  assert.equal(stats.forkPoints, 0)

  const path = pathToLeaf(deepTree)
  assert.equal(path.size, depth)
  assert.equal(path.has('node-1'), true)
  assert.equal(path.has(leafId), true)

  const branches = branchIds(deepTree)
  assert.equal(branches.size, depth - 1)

  const tips = branchTips(deepTree)
  assert.deepEqual(tips, [leafId])

  const rows = flattenTree(deepTree, branches)
  assert.equal(rows.length, depth)
  assert.equal(rows[0].id, 'node-1')
  assert.equal(rows[rows.length - 1].id, leafId)
})

test('normalizeTree parses raw deeply nested tree structures iteratively', () => {
  // Build raw JSON tree of depth 1,500
  let currentRaw: Record<string, unknown> = {
    entry: { type: 'message', id: 'leaf', message: { role: 'user', content: 'deep' } },
    children: []
  }

  for (let i = 1499; i >= 1; i--) {
    currentRaw = {
      entry: { type: 'message', id: `raw-${i}`, message: { role: 'assistant', content: `step ${i}` } },
      children: [currentRaw]
    }
  }

  const rawTree = {
    tree: [currentRaw],
    leafId: 'leaf'
  }

  const normalized = normalizeTree(rawTree)
  assert.equal(normalized.roots.length, 1)
  assert.equal(normalized.leafId, 'leaf')
  const stats = treeStats(normalized)
  assert.equal(stats.entries, 1500)
})

function navRow(id: string, depth: number, hasChildren = false, childrenOpen = false): TreeRow {
  return {
    id,
    depth,
    role: 'user',
    title: id,
    active: false,
    leaf: false,
    hasChildren,
    childrenOpen,
    branch: false
  }
}

test('the session tree walks visible rows and opens or closes branches', () => {
  const rows = [
    navRow('root', 0, true, true),
    navRow('a', 1, true, true),
    navRow('a1', 2),
    navRow('b', 1, true, false),
    navRow('c', 1)
  ]

  assert.deepEqual(treeNavAction(rows, 0, 'ArrowDown'), { kind: 'focus', index: 1 })
  assert.deepEqual(treeNavAction(rows, 1, 'ArrowUp'), { kind: 'focus', index: 0 })
  assert.deepEqual(treeNavAction(rows, 0, 'ArrowUp'), { kind: 'filter' })
  assert.equal(treeNavAction(rows, rows.length - 1, 'ArrowDown'), null)
  assert.deepEqual(treeNavAction(rows, 3, 'Home'), { kind: 'focus', index: 0 })
  assert.deepEqual(treeNavAction(rows, 1, 'End'), { kind: 'focus', index: rows.length - 1 })

  // Right opens a closed branch, steps into an open one, and does nothing on a
  // leaf. Left closes an open branch and otherwise climbs to the parent.
  assert.deepEqual(treeNavAction(rows, 3, 'ArrowRight'), { kind: 'toggle', id: 'b' })
  assert.deepEqual(treeNavAction(rows, 0, 'ArrowRight'), { kind: 'focus', index: 1 })
  assert.equal(treeNavAction(rows, 4, 'ArrowRight'), null)
  assert.deepEqual(treeNavAction(rows, 1, 'ArrowLeft'), { kind: 'toggle', id: 'a' })
  assert.deepEqual(treeNavAction(rows, 2, 'ArrowLeft'), { kind: 'focus', index: 1 })
  assert.deepEqual(treeNavAction(rows, 3, 'ArrowLeft'), { kind: 'focus', index: 0 })
  assert.deepEqual(treeNavAction(rows, 0, 'ArrowLeft'), { kind: 'toggle', id: 'root' })
  assert.equal(treeNavAction([navRow('leaf', 0)], 0, 'ArrowLeft'), null)

  // A collapsed branch's children are not in the visible list, so Right on it
  // toggles instead of stepping into a row that is not there.
  assert.deepEqual(treeNavAction([navRow('only', 0, true, false)], 0, 'ArrowRight'), {
    kind: 'toggle',
    id: 'only'
  })
  assert.equal(treeNavAction(rows, -1, 'ArrowDown'), null)
  assert.equal(treeNavAction(rows, rows.length, 'ArrowUp'), null)
})

/**
 * The dialog's filter field clears before the dialog closes.
 *
 * `useDialogFocus` claims Escape in the capture phase, so a plain input could
 * never clear itself: the filter's text stayed on screen only until the whole
 * dialog vanished. A field marked `data-escape-clears` owns the key while it
 * has text, and the tree filter clears itself on the same event.
 */
test('the tree filter clears on Escape before the dialog closes', () => {
  const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), 'utf8')
  const hook = read('src/renderer/src/hooks/useDialogFocus.ts')
  const dialog = read('src/renderer/src/components/SessionTreeDialog.tsx')
  assert.match(hook, /data-escape-clears/, 'the dialog hook does not let a marked filter own Escape')
  assert.match(dialog, /data-escape-clears=""/, 'the tree filter is not marked as clearing itself')
  assert.match(dialog, /event\.key === 'Escape' && query/, 'the tree filter does not clear on Escape')
  // A controlled `type="search"` input never receives the browser's native
  // cancel, so the hook must not keep a special case for it: such a field could
  // only stop the dialog from closing while doing nothing itself.
  assert.doesNotMatch(hook, /type === 'search'/, 'the dialog hook still special-cases search inputs')
  const settings = read('src/renderer/src/components/SettingsDialog.tsx')
  assert.match(settings, /data-escape-clears=""/, 'the settings search does not claim Escape')
})
