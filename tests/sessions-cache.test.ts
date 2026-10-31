import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  appendSessionName,
  clearSessionCache,
  getSessionCacheSize,
  getSessionMeta,
  invalidateSessionCache,
  listSessions,
  parseSession,
  readJsonlLines,
  readSessionMessages
} from '../src/main/sessions'

test('sessionMetaCache: cache hit returns identical metadata without redundant disk reads', async () => {
  clearSessionCache()
  assert.equal(getSessionCacheSize(), 0)

  const dir = mkdtempSync(path.join(tmpdir(), 'pi-cache-hit-'))
  const file = path.join(dir, 'session.jsonl')
  try {
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'hit-1', cwd: 'C:/test-app' }),
        JSON.stringify({
          type: 'message',
          id: 'm1',
          parentId: null,
          message: { role: 'user', content: 'Initial question for caching', timestamp: 100 }
        }),
        JSON.stringify({
          type: 'message',
          id: 'm2',
          parentId: 'm1',
          message: { role: 'assistant', content: 'Assistant response here', timestamp: 105 }
        })
      ].join('\n') + '\n',
      'utf8'
    )

    // Cold read: reads and parses file, populates cache
    const startCold = performance.now()
    const coldMeta = await getSessionMeta(file)
    const coldDuration = performance.now() - startCold

    assert.ok(coldMeta)
    assert.equal(coldMeta.id, 'hit-1')
    assert.equal(coldMeta.preview, 'Initial question for caching')
    assert.equal(coldMeta.messageCount, 2)
    assert.equal(getSessionCacheSize(), 1)

    // Warm read: must return identical object reference from memory
    const startWarm = performance.now()
    const warmMeta = await getSessionMeta(file)
    const warmDuration = performance.now() - startWarm

    assert.equal(warmMeta, coldMeta, 'warm read must return identical cached reference')
    assert.equal(getSessionCacheSize(), 1)

    // Verify warm read is fast (sub-millisecond or markedly faster than cold parse)
    assert.ok(warmDuration <= Math.max(coldDuration, 5), 'cached read should be practically instantaneous')
  } finally {
    clearSessionCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sessionMetaCache: invalidates and incrementally updates when messages are appended', async () => {
  clearSessionCache()
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-cache-append-'))
  const file = path.join(dir, 'session.jsonl')
  try {
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'append-1', cwd: 'C:/app' }),
        JSON.stringify({
          type: 'message',
          id: 'm1',
          parentId: null,
          message: { role: 'user', content: 'First message', timestamp: 100 }
        })
      ].join('\n') + '\n',
      'utf8'
    )

    // Initial read
    const initialMeta = await getSessionMeta(file)
    assert.ok(initialMeta)
    assert.equal(initialMeta.messageCount, 1)
    assert.equal(initialMeta.preview, 'First message')

    // Append new assistant response and user followup
    const appendLines = [
      JSON.stringify({
        type: 'message',
        id: 'm2',
        parentId: 'm1',
        message: { role: 'assistant', content: 'Response from agent', timestamp: 200 }
      }),
      JSON.stringify({
        type: 'message',
        id: 'm3',
        parentId: 'm2',
        message: { role: 'user', content: 'Second user message', timestamp: 250 }
      })
    ].join('\n') + '\n'

    // Write append
    writeFileSync(file, appendLines, { flag: 'a', encoding: 'utf8' })

    // Read again: must detect size/mtime change and update
    const updatedMeta = await getSessionMeta(file)
    assert.ok(updatedMeta)
    assert.notEqual(updatedMeta, initialMeta, 'updated meta should be a refreshed object')
    assert.equal(updatedMeta.messageCount, 3)
    // Preview must remain the first user message on the active branch
    assert.equal(updatedMeta.preview, 'First message')
    assert.ok(updatedMeta.updatedAt >= initialMeta.updatedAt)
  } finally {
    clearSessionCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sessionMetaCache: appendSessionName updates session_info and immediately invalidates cache', async () => {
  clearSessionCache()
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-cache-rename-'))
  const file = path.join(dir, 'session.jsonl')
  try {
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'rename-1', cwd: 'C:/app' }),
        JSON.stringify({
          type: 'message',
          id: 'm1',
          parentId: null,
          message: { role: 'user', content: 'Un-named conversation', timestamp: 100 }
        })
      ].join('\n') + '\n',
      'utf8'
    )

    // Initial read has no name
    const beforeRename = await getSessionMeta(file)
    assert.ok(beforeRename)
    assert.equal(beforeRename.name, undefined)

    // Execute rename
    const renameOk = await appendSessionName(file, 'Renamed Session Name')
    assert.equal(renameOk, true)

    // Cache should be refreshed with new name
    const afterRename = await getSessionMeta(file)
    assert.ok(afterRename)
    assert.equal(afterRename.name, 'Renamed Session Name')

    // Blank name should be rejected without altering file or cache
    const blankReject = await appendSessionName(file, '    \n  ')
    assert.equal(blankReject, false)
  } finally {
    clearSessionCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sessionMetaCache: recovers gracefully on file truncation / replacement (size < cached.size)', async () => {
  clearSessionCache()
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-cache-trunc-'))
  const file = path.join(dir, 'session.jsonl')
  try {
    // 1. Create a large session with 10 messages
    const lines = [JSON.stringify({ type: 'session', version: 3, id: 'trunc-1', cwd: 'C:/app' })]
    let lastId: string | null = null
    for (let i = 1; i <= 10; i++) {
      const id = `m${i}`
      lines.push(
        JSON.stringify({
          type: 'message',
          id,
          parentId: lastId,
          message: {
            role: i % 2 === 1 ? 'user' : 'assistant',
            content: `Message ${i} with extra padding content to make the file larger`,
            timestamp: 100 + i
          }
        })
      )
      lastId = id
    }
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')

    const initialMeta = await getSessionMeta(file)
    assert.ok(initialMeta)
    assert.equal(initialMeta.messageCount, 10)

    // 2. Truncate / replace file with only 2 messages (significantly smaller byte size)
    const truncatedLines = [
      JSON.stringify({ type: 'session', version: 3, id: 'trunc-1', cwd: 'C:/app' }),
      JSON.stringify({
        type: 'message',
        id: 't1',
        parentId: null,
        message: { role: 'user', content: 'Truncated user message', timestamp: 200 }
      }),
      JSON.stringify({
        type: 'message',
        id: 't2',
        parentId: 't1',
        message: { role: 'assistant', content: 'Truncated response', timestamp: 205 }
      })
    ]
    writeFileSync(file, truncatedLines.join('\n') + '\n', 'utf8')

    // 3. Read again: must re-parse from scratch without crashing or corrupting active branch
    const truncatedMeta = await getSessionMeta(file)
    assert.ok(truncatedMeta)
    assert.equal(truncatedMeta.messageCount, 2)
    assert.equal(truncatedMeta.preview, 'Truncated user message')
    assert.equal(getSessionCacheSize(), 1)
  } finally {
    clearSessionCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sessionMetaCache: in-flight Promise deduplication coalesces concurrent reads', async () => {
  clearSessionCache()
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-cache-dedup-'))
  const file = path.join(dir, 'session.jsonl')
  try {
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'dedup-1', cwd: 'C:/app' }),
        JSON.stringify({
          type: 'message',
          id: 'm1',
          parentId: null,
          message: { role: 'user', content: 'Concurrent deduplication test', timestamp: 100 }
        })
      ].join('\n') + '\n',
      'utf8'
    )

    // Launch 10 simultaneous requests before any finishes
    const promises = Array.from({ length: 10 }, () => getSessionMeta(file))
    const results = await Promise.all(promises)

    assert.equal(results.length, 10)
    const first = results[0]
    assert.ok(first)
    assert.equal(first.id, 'dedup-1')

    // Every promise must resolve to the identical reference coalesced from the in-flight read
    for (let i = 1; i < results.length; i++) {
      assert.equal(results[i], first, `promise ${i} should coalesce to identical instance`)
    }
    assert.equal(getSessionCacheSize(), 1)
  } finally {
    clearSessionCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sessionMetaCache: cache size bounded at 2,000 entries with FIFO eviction', async () => {
  clearSessionCache()
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-cache-bound-'))
  try {
    const fileCount = 2005
    const files: string[] = []
    const writeTasks: Promise<void>[] = []

    for (let i = 0; i < fileCount; i++) {
      const f = path.join(dir, `s_${i}.jsonl`)
      files.push(f)
      const content =
        JSON.stringify({ type: 'session', version: 3, id: `bound-${i}`, cwd: 'C:/app' }) +
        '\n' +
        JSON.stringify({
          type: 'message',
          id: 'm1',
          parentId: null,
          message: { role: 'user', content: `Message ${i}`, timestamp: 1000 + i }
        }) +
        '\n'
      writeTasks.push(writeFile(f, content, 'utf8'))
    }
    await Promise.all(writeTasks)

    // Sequentially populate cache for all 2,005 entries
    for (let i = 0; i < fileCount; i++) {
      const meta = await getSessionMeta(files[i])
      assert.ok(meta)
    }

    // Maximum cache size must remain strictly bounded at 2000
    assert.equal(getSessionCacheSize(), 2000)

    // Oldest entry (files[0]) was evicted
    // Reading files[0] should succeed, re-parse and bring it back into cache
    const reMeta0 = await getSessionMeta(files[0])
    assert.ok(reMeta0)
    assert.equal(reMeta0.id, 'bound-0')
    assert.equal(getSessionCacheSize(), 2000)
  } finally {
    clearSessionCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sessionMetaCache: fault tolerance for empty files, blank lines, and corrupted JSON records', async () => {
  clearSessionCache()
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-cache-corrupt-'))
  const emptyFile = path.join(dir, 'empty.jsonl')
  const whitespaceFile = path.join(dir, 'whitespace.jsonl')
  const corruptFile = path.join(dir, 'corrupt.jsonl')
  try {
    // 1. Empty file (0 bytes) returns null gracefully
    writeFileSync(emptyFile, '', 'utf8')
    const emptyMeta = await getSessionMeta(emptyFile)
    assert.equal(emptyMeta, null)

    // 2. Whitespace-only file returns null gracefully
    writeFileSync(whitespaceFile, '   \n\n\t  \r\n', 'utf8')
    const whitespaceMeta = await getSessionMeta(whitespaceFile)
    assert.equal(whitespaceMeta, null)

    // 3. Corrupted lines interspersed with valid records
    const corruptContent = [
      JSON.stringify({ type: 'session', version: 3, id: 'corrupt-1', cwd: 'C:/app' }),
      '{ this is invalid JSON line that was cut off mid-stream',
      '',
      JSON.stringify({
        type: 'message',
        id: 'm1',
        parentId: null,
        message: { role: 'user', content: 'Valid question despite surrounding corrupt lines', timestamp: 100 }
      }),
      '{"type": "message", "broken": ',
      'null',
      JSON.stringify({
        type: 'message',
        id: 'm2',
        parentId: 'm1',
        message: { role: 'assistant', content: 'Valid answer', timestamp: 110 }
      }),
      '   \r\n'
    ].join('\n')
    writeFileSync(corruptFile, corruptContent, 'utf8')

    // Should skip broken lines and extract valid active branch
    const meta = await getSessionMeta(corruptFile)
    assert.ok(meta)
    assert.equal(meta.id, 'corrupt-1')
    assert.equal(meta.preview, 'Valid question despite surrounding corrupt lines')
    assert.equal(meta.messageCount, 2)

    // readSessionMessages also safely recovers valid messages
    const messages = await readSessionMessages(corruptFile)
    assert.equal(messages.length, 2)
    assert.equal(messages[0].content, 'Valid question despite surrounding corrupt lines')
    assert.equal(messages[1].content, 'Valid answer')
  } finally {
    clearSessionCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readJsonlLines: byte-level streaming preserves U+2028 and U+2029 without readline corruption', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-unicode-lines-'))
  const file = path.join(dir, 'unicode.jsonl')
  try {
    // U+2028: Line Separator, U+2029: Paragraph Separator
    const record = {
      type: 'message',
      text: 'First line\u2028Second line\u2029Paragraph separator line'
    }
    const jsonStr = JSON.stringify(record)
    const content = `line-header\r\n${jsonStr}\nline-footer`
    writeFileSync(file, content, 'utf8')

    const lines: string[] = []
    for await (const line of readJsonlLines(file)) {
      lines.push(line)
    }

    assert.equal(lines.length, 3)
    assert.equal(lines[0], 'line-header')
    assert.equal(lines[1], jsonStr)
    assert.equal(lines[2], 'line-footer')

    const parsed = JSON.parse(lines[1]) as { text: string }
    assert.equal(parsed.text, 'First line\u2028Second line\u2029Paragraph separator line')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sessionMetaCache: manual invalidation and clearSessionCache', async () => {
  clearSessionCache()
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-manual-inv-'))
  const file1 = path.join(dir, 's1.jsonl')
  const file2 = path.join(dir, 's2.jsonl')
  try {
    writeFileSync(file1, JSON.stringify({ type: 'session', id: 's1', cwd: 'C:/app' }) + '\n', 'utf8')
    writeFileSync(file2, JSON.stringify({ type: 'session', id: 's2', cwd: 'C:/app' }) + '\n', 'utf8')

    await getSessionMeta(file1)
    await getSessionMeta(file2)
    assert.equal(getSessionCacheSize(), 2)

    // Invalidate specific file
    invalidateSessionCache(file1)
    assert.equal(getSessionCacheSize(), 1)

    // Clear entire cache
    clearSessionCache()
    assert.equal(getSessionCacheSize(), 0)
  } finally {
    clearSessionCache()
    rmSync(dir, { recursive: true, force: true })
  }
})
