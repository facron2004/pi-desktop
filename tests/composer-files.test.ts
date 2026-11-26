import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  composerFileToken,
  extractFilePathMentions,
  fileNameFromPath,
  makeComposerFile,
  mentionEmptyLine,
  mergeComposerFiles
} from '../src/renderer/src/lib/composer-files'
import {
  COMPOSER_DRAFTS_STORAGE_KEY,
  MAX_HISTORY_ONLY_DRAFTS,
  clearedPromotedDraftSnapshot,
  composerDraftAfterSend,
  forgetLastDraftKey,
  loadComposerDrafts,
  promotedDraftSnapshot,
  pruneComposerDrafts,
  saveComposerDrafts
} from '../src/renderer/src/lib/composer-drafts'

test('an absolute path line becomes a file attachment, not visible text', () => {  const result = extractFilePathMentions(
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

test('POSIX files that differ only in case both stay attached', () => {
  const upper = makeComposerFile('/workspace/README.md')
  const lower = makeComposerFile('/workspace/readme.md')
  const duplicate = makeComposerFile(lower.path)
  assert.deepEqual(mergeComposerFiles([upper], [lower, duplicate]), [upper, lower])
})

test('a literal POSIX backslash survives file naming, sending and draft restoration', () => {
  const file = makeComposerFile('/workspace/a\\b.md')
  const nested = makeComposerFile('/workspace/a/b.md')
  const token = composerFileToken(file)
  assert.equal(file.name, 'a\\b.md')
  assert.equal(token, '@"/workspace/a\\\\b.md"')
  assert.equal(extractFilePathMentions(token).files[0]?.path, file.path)
  assert.deepEqual(mergeComposerFiles([file], [nested]), [file, nested])
})

test('equivalent Windows network paths still keep one attachment chip', () => {
  const file = makeComposerFile('\\\\server\\share\\Docs\\Report.md')
  const alternate = makeComposerFile('//SERVER/SHARE/docs/report.md')
  const token = composerFileToken(file)
  assert.equal(file.name, 'Report.md')
  assert.equal(token, '@"//server/share/Docs/Report.md"')
  assert.equal(extractFilePathMentions(token).files[0]?.path, '//server/share/Docs/Report.md')
  assert.deepEqual(mergeComposerFiles([file], [alternate]), [file])
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

test('quota pressure drops sent-prompt history before unsent draft images', () => {
  const storage = memoryStorage()
  const setItem = storage.setItem
  storage.setItem = (key, value) => {
    if (value.length > 1_000) throw new Error('quota exceeded')
    setItem(key, value)
  }
  const image = { id: 'saved', type: 'image' as const, name: 'saved.png', bytes: 3, data: 'YWJj', mimeType: 'image/png' }
  const other = { text: 'Earlier unsent draft', images: [image] }
  const lastDraftKeys = { other: 'draft:other', current: 'draft:current' }
  assert.equal(saveComposerDrafts({ drafts: { 'draft:other': other }, lastDraftKeys }, storage), 'saved')

  const current = { text: 'New unsent draft', images: [{ ...image, id: 'new' }] }
  const file = { id: 'file', path: 'C:/project/example.txt', name: 'example.txt' }
  const withoutHistory = { ...current, files: [file] }
  const save = (newImageData?: string) => saveComposerDrafts({
    drafts: {
      'draft:other': other,
      'draft:current': {
        ...withoutHistory,
        images: newImageData
          ? [{ ...image, id: 'oversized', bytes: newImageData.length * 3 / 4, data: newImageData }]
          : current.images,
        history: ['H'.repeat(1200)]
      }
    },
    lastDraftKeys
  }, storage)

  assert.equal(save(), 'partial')
  assert.deepEqual(loadComposerDrafts(storage), {
    drafts: { 'draft:other': other, 'draft:current': withoutHistory }, lastDraftKeys
  })

  assert.equal(save('A'.repeat(2000)), 'partial')
  assert.deepEqual(loadComposerDrafts(storage), {
    drafts: { 'draft:other': other, 'draft:current': { ...withoutHistory, images: [] } }, lastDraftKeys
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

test('a draft too large to save does not block updates or removals in other conversations', () => {
  const storage = memoryStorage()
  const setItem = storage.setItem
  storage.setItem = (key, value) => {
    if (value.length > 1000) throw new Error('quota exceeded')
    setItem(key, value)
  }
  const image = { id: 'kept', type: 'image' as const, name: 'kept.png', bytes: 3, data: 'YWJj', mimeType: 'image/png' }
  const previous = { text: 'Earlier version of the long draft', images: [image] }
  const other = { text: 'Older work in the other conversation', images: [{ ...image, id: 'other' }] }
  const lastDraftKeys = { other: 'draft:other', long: 'draft:long' }
  assert.equal(saveComposerDrafts({
    drafts: {
      'draft:long': previous,
      'draft:other': other,
      'draft:sent': { text: 'Already sent', images: [] }
    },
    lastDraftKeys
  }, storage), 'saved')

  const updated = { ...other, text: 'This edit should survive a restart' }
  const result = saveComposerDrafts({
    drafts: { 'draft:long': { ...previous, text: 'L'.repeat(2000) }, 'draft:other': updated },
    lastDraftKeys
  }, storage)
  assert.equal(result, 'partial-drafts')
  assert.deepEqual(loadComposerDrafts(storage), {
    drafts: { 'draft:long': previous, 'draft:other': updated },
    lastDraftKeys
  })
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

test('saveComposerDrafts skips redundant setItem writes and drops history on quota pressure', () => {
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

test('the @ list names why it has no rows instead of always blaming the name', () => {
  // A chat with no project never searched at all; the file name was not wrong.
  assert.equal(
    mentionEmptyLine({ noProject: true, searching: false }),
    'Open a project to reference its files.'
  )
  assert.equal(
    mentionEmptyLine({ noProject: true, searching: true }),
    'Open a project to reference its files.',
    'a projectless chat is never searching'
  )
  assert.equal(
    mentionEmptyLine({ noProject: true, queryTooLong: true }),
    'Open a project to reference its files.',
    'the project is the bigger problem'
  )
  // Inside a project: a request in flight must not read as "no match".
  assert.equal(mentionEmptyLine({ noProject: false, searching: true }), 'Searching files…')
  assert.equal(mentionEmptyLine({ noProject: false, searching: false }), 'No file matches that name.')
  // A query too long for the search never ran.
  assert.equal(
    mentionEmptyLine({ noProject: false, queryTooLong: true, searching: false }),
    'That name is too long to search.'
  )
  assert.equal(
    mentionEmptyLine({ noProject: false, queryTooLong: true, searching: true }),
    'That name is too long to search.',
    'no search runs for a query over the limit'
  )
  // A failed search is not an empty result; editing the text retries it.
  assert.equal(
    mentionEmptyLine({ noProject: false, failed: true }),
    'The file search failed. Type to try again.'
  )
  assert.equal(
    mentionEmptyLine({ noProject: false, failed: true, searching: true }),
    'Searching files…',
    'a running retry outranks the failure it follows'
  )
})

test('the @ list says when its search stopped at the limit', () => {
  const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), 'utf8')
  const composer = read('src/renderer/src/components/Composer.tsx')
  const mention = read('src/renderer/src/components/FileMention.tsx')
  // The main process already reports whether the walk stopped early; the
  // composer used to drop that flag, so twelve rows read as the whole answer.
  assert.match(
    composer,
    /setMentionTruncated\(result\.truncated\)/,
    'the @ search drops the truncation the main process reports'
  )
  assert.match(composer, /truncated=\{mentionTruncated\}/, 'the @ list does not receive the flag')
  assert.match(
    mention,
    /Search stopped at its limit; results may be incomplete\./,
    'the @ list shows no note when the search stopped early'
  )
  assert.match(mention, /className="mention__note"/, 'the note lost its own row')
})

/**
 * A draft chat is promoted to a session file when the composer starts Pi, and
 * that empty session never reaches the session index. The copy under the draft
 * key is what keeps the reader's unsent text reachable, and it has to follow the
 * typing (the promotion usually happens before the first keystroke).
 */
test('a promoted draft keeps a live copy, and clearing drops it', () => {
  const storage = memoryStorage()
  const workspace = 'env-test'
  const session = 'C:/sessions/a.jsonl'
  const draftKey = 'draft:old'

  // Promotion with nothing typed yet still links and points: the first keystroke
  // mirrors the text under the draft key.
  const empty = { drafts: {}, lastDraftKeys: {}, promotedDrafts: {} }
  const early = promotedDraftSnapshot(empty, draftKey, session, workspace)
  assert.equal(early.lastDraftKeys[workspace], draftKey)
  assert.equal(early.promotedDrafts?.[session], draftKey)
  assert.equal(early.drafts[draftKey], undefined)

  // Typed later: the store mirrors it. The round trip keeps the copy and the
  // link, and the pointer survives the sanitizer, which only accepts draft: keys.
  const typed = { text: 'typed after the promotion', images: [] }
  const mirrored = { ...early, drafts: { [session]: typed, [draftKey]: typed } }
  assert.equal(saveComposerDrafts(mirrored, storage), 'saved')
  const reloaded = loadComposerDrafts(storage)
  assert.equal(reloaded.lastDraftKeys[workspace], draftKey)
  assert.equal(reloaded.drafts[draftKey]?.text, 'typed after the promotion')
  assert.equal(reloaded.promotedDrafts?.[session], draftKey)

  // Clearing (what accepting a send does) drops the copy, the link and the
  // pointer together, so a restart cannot resurrect a message already sent.
  const cleared = clearedPromotedDraftSnapshot(reloaded, session, workspace)
  assert.equal(cleared.drafts[draftKey], undefined)
  assert.equal(cleared.lastDraftKeys[workspace], undefined)
  assert.equal(cleared.promotedDrafts?.[session], undefined)
  // A key with no link is left alone.
  assert.deepEqual(clearedPromotedDraftSnapshot(cleared, 'draft:other', workspace), cleared)
})