import test from 'node:test'
import assert from 'node:assert/strict'
import {
  composerFileToken,
  extractFilePathMentions,
  fileNameFromPath,
  makeComposerFile,
  mergeComposerFiles
} from '../src/renderer/src/lib/composer-files'
import {
  COMPOSER_DRAFTS_STORAGE_KEY,
  MAX_HISTORY_ONLY_DRAFTS,
  composerDraftAfterSend,
  forgetLastDraftKey,
  loadComposerDrafts,
  pruneComposerDrafts,
  saveComposerDrafts
} from '../src/renderer/src/lib/composer-drafts'

test('an absolute path line becomes a file attachment, not visible text', () => {
  const result = extractFilePathMentions(
    '@"C:/Users/Facron/Downloads/AgentBench_Studio_%E5%BC%80%E5%8F%91%E9%9C%80%E6%B1%82.md"\n请阅读并总结'
  )
  assert.equal(result.text, '请阅读并总结')
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].name, 'AgentBench_Studio_开发需求.md')
  assert.equal(result.files[0].path, 'C:/Users/Facron/Downloads/AgentBench_Studio_%E5%BC%80%E5%8F%91%E9%9C%80%E6%B1%82.md')
})

test('a relative @ mention stays in the message', () => {
  const result = extractFilePathMentions('请检查 @src/main/ipc.ts 这段')
  assert.equal(result.files.length, 0)
  assert.equal(result.text, '请检查 @src/main/ipc.ts 这段')
})

test('the file token uses the absolute path Pi already understands', () => {
  const file = makeComposerFile('C:\\Users\\Facron\\Downloads\\需求.md')
  assert.equal(composerFileToken(file), '@"C:/Users/Facron/Downloads/需求.md"')
  assert.equal(file.name, '需求.md')
  assert.equal(fileNameFromPath('C:\\a\\b\\'), 'b')
})

test('adding the same path twice keeps one chip', () => {
  const first = makeComposerFile('C:/Users/Facron/a.md')
  const second = makeComposerFile('c:\\users\\facron\\A.MD')
  const merged = mergeComposerFiles([first], [second])
  assert.equal(merged.length, 1)
  assert.equal(merged[0], first)
})

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) }
  }
}

test('composer drafts survive a snapshot round trip without a transient preview URL', () => {
  const storage = memoryStorage()
  const draft = {
    text: 'unfinished thought',
    images: [{
      id: 'image-1',
      type: 'image' as const,
      name: 'shot.png',
      bytes: 3,
      data: 'YWJj',
      mimeType: 'image/png',
      previewUrl: 'blob:transient'
    }],
    files: [{ id: 'file-1', path: 'C:/project/a.ts', name: 'a.ts' }],
    history: ['first prompt']
  }
  const result = saveComposerDrafts({
    drafts: { 'draft:one': draft },
    lastDraftKeys: { workspace: 'draft:one' }
  }, storage)
  assert.equal(result, 'saved')
  assert.deepEqual(loadComposerDrafts(storage), {
    drafts: {
      'draft:one': {
        ...draft,
        images: [{
          id: 'image-1',
          type: 'image',
          name: 'shot.png',
          bytes: 3,
          data: 'YWJj',
          mimeType: 'image/png'
        }]
      }
    },
    lastDraftKeys: { workspace: 'draft:one' }
  })
})

test('large draft images degrade to text-only persistence instead of losing the draft', () => {
  let writes = 0
  let saved = ''
  const storage = {
    getItem: () => null,
    setItem: (_key: string, value: string) => {
      writes += 1
      if (writes === 1) throw new Error('quota exceeded')
      saved = value
      assert.match(value, /unfinished thought/)
    }
  }
  const result = saveComposerDrafts({
    drafts: {
      'draft:one': {
        text: 'unfinished thought',
        images: [{
          id: 'large',
          type: 'image',
          name: 'large.png',
          bytes: 10,
          data: 'cGF5bG9hZA==',
          mimeType: 'image/png'
        }],
        files: [{ id: 'file-1', path: 'C:/project/a.ts', name: 'a.ts' }]
      }
    },
    lastDraftKeys: { workspace: 'draft:one' }
  }, storage)
  assert.equal(result, 'partial')
  const stored = JSON.parse(saved)
  assert.equal(stored.drafts['draft:one'].text, 'unfinished thought')
  assert.deepEqual(stored.drafts['draft:one'].images, [])
  assert.equal(writes, 2)
})

test('an oversized attachment preserves already saved images in other drafts', () => {
  const storage = memoryStorage()
  const write = storage.setItem
  storage.setItem = (key, value) => {
    if (value.length > 2000) throw new Error('quota exceeded')
    write(key, value)
  }
  const kept = { id: 'kept', type: 'image' as const, name: 'kept.png', bytes: 3, data: 'YWJj', mimeType: 'image/png' }
  const removed = { ...kept, id: 'removed' }
  const initial = {
    drafts: { 'draft:other': { text: 'Old draft', images: [kept, removed] } },
    lastDraftKeys: { other: 'draft:other' }
  }
  assert.equal(saveComposerDrafts(initial, storage), 'saved')

  const file = { id: 'file', path: 'C:/project/example.txt', name: 'example.txt' }
  const current = {
    drafts: {
      'draft:other': { text: 'Updated draft', images: [kept] },
      'draft:current': {
        text: 'New draft',
        images: [{ ...kept, id: 'large', bytes: 3000, data: 'A'.repeat(4000) }],
        files: [file]
      }
    },
    lastDraftKeys: { ...initial.lastDraftKeys, current: 'draft:current' }
  }
  assert.equal(saveComposerDrafts(current, storage), 'partial')
  assert.deepEqual(loadComposerDrafts(storage), {
    drafts: { ...current.drafts, 'draft:current': { ...current.drafts['draft:current'], images: [] } },
    lastDraftKeys: current.lastDraftKeys
  })
})

test('a malformed draft store is ignored and a promoted draft loses its new-chat pointer', () => {
  const storage = memoryStorage()
  storage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, '{"version":1,"drafts":"bad"}')
  storage.values.set(COMPOSER_DRAFTS_STORAGE_KEY, `{"version":1,"drafts":{"draft:one":{"text":42}}}`)
  assert.deepEqual(loadComposerDrafts(storage), { drafts: {}, lastDraftKeys: {} })
  const snapshot = forgetLastDraftKey({
    drafts: {},
    lastDraftKeys: { one: 'draft:one', two: 'draft:two' }
  }, 'draft:one')
  assert.deepEqual(snapshot.lastDraftKeys, { two: 'draft:two' })
})

test('pruneComposerDrafts caps sent-history-only sessions while preserving all unsent drafts', () => {
  const drafts: Record<string, ReturnType<typeof composerDraftAfterSend>> = {}
  for (let index = 0; index < MAX_HISTORY_ONLY_DRAFTS + 15; index += 1) {
    drafts[`session-${index}.jsonl`] = composerDraftAfterSend(
      { text: '', images: [] },
      `sent prompt ${index}`,
      undefined
    )
  }
  drafts['active-unsent.jsonl'] = {
    text: 'Work in progress',
    images: [],
    history: ['older']
  }

  const pruned = pruneComposerDrafts(drafts)
  assert.equal(pruned['active-unsent.jsonl']?.text, 'Work in progress')
  assert.equal(pruned['session-0.jsonl'], undefined, 'oldest history-only session is evicted')
  assert.ok(pruned[`session-${MAX_HISTORY_ONLY_DRAFTS + 14}.jsonl`], 'newest history-only session is retained')
  assert.equal(Object.keys(pruned).length, MAX_HISTORY_ONLY_DRAFTS + 1)
})

test('saveComposerDrafts skips redundant setItem writes and drops history as a last resort on quota pressure', () => {
  const storage = memoryStorage()
  let setCount = 0
  const rawSet = storage.setItem
  storage.setItem = (key, value) => {
    setCount += 1
    rawSet(key, value)
  }
  const snapshot = {
    drafts: { 'draft:same': { text: 'unchanged', images: [] } },
    lastDraftKeys: { ws: 'draft:same' }
  }
  assert.equal(saveComposerDrafts(snapshot, storage), 'saved')
  assert.equal(saveComposerDrafts(snapshot, storage), 'saved')
  assert.equal(setCount, 1, 'identical serialized snapshots must not rewrite localStorage')

  // Quota exceeded with large history degrades by dropping history while keeping unsent text.
  const tight = memoryStorage()
  const tightSet = tight.setItem
  tight.setItem = (key, value) => {
    if (value.length > 300) throw new Error('quota exceeded')
    tightSet(key, value)
  }
  const res = saveComposerDrafts({
    drafts: {
      'old-history.jsonl': composerDraftAfterSend({ text: '', images: [] }, 'H'.repeat(400), undefined),
      'draft:live': { text: 'Save me', images: [], history: ['P'.repeat(400)] }
    },
    lastDraftKeys: { ws: 'draft:live' }
  }, tight)
  assert.equal(res, 'partial')
  const restored = loadComposerDrafts(tight)
  assert.equal(restored.drafts['draft:live']?.text, 'Save me')
  assert.equal(restored.drafts['old-history.jsonl'], undefined)
})
