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
  forgetLastDraftKey,
  loadComposerDrafts,
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
  assert.equal(result, 'text-only')
  const stored = JSON.parse(saved)
  assert.equal(stored.drafts['draft:one'].text, 'unfinished thought')
  assert.deepEqual(stored.drafts['draft:one'].images, [])
  assert.equal(writes, 2)
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
