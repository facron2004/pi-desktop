import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { open, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  appendSessionName,
  clearSessionCache,
  configureSessionSearchIndex,
  encodeWorkspaceDir,
  getAggregatedUsage,
  getSessionSearchIndexCacheStats,
  getUsageCacheStats,
  getSessionCacheSize,
  getSessionMeta,
  invalidateSessionCache,
  listSessions,
  openSessionFile,
  parseLargeSessionMeta,
  parseSession,
  pruneSessionSearchIndexFiles,
  readJsonlLines,
  readSessionConversation,
  readSessionMessages,
  resolveSessionFilePath,
  searchSessions
} from '../src/main/sessions'
import { canonicalSessionFile } from '../src/main/pi/session-file'
import {
  EXTERNAL_CONTEXT_CHECKED_ENTRY,
  EXTERNAL_CONTEXT_CLASSIFICATION_VERSION,
  EXTERNAL_CONTEXT_UNKNOWN_ENTRY
} from '../src/main/memory/policy'

test('small legacy sessions with local tool calls need a current branch classification', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-session-context-check-'))
  const file = path.join(root, 'session.jsonl')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const entries = [
    { type: 'session', id: 'context-check', version: 3, cwd: root },
    {
      type: 'message', id: 'user-1', parentId: null,
      message: { role: 'user', content: 'Review the project setup.', timestamp: 1 }
    },
    {
      type: 'message', id: 'assistant-1', parentId: 'user-1',
      message: {
        role: 'assistant', timestamp: 2,
        content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'README.md' } }]
      }
    }
  ]
  const writeEntries = () => writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)

  writeEntries()
  await parseSession(file)
  assert.equal((await readSessionConversation(file)).contextChecked, false)

  entries.push({
    type: 'custom', id: 'old-check', parentId: 'assistant-1',
    customType: EXTERNAL_CONTEXT_CHECKED_ENTRY, data: {}
  })
  writeEntries()
  clearSessionCache()
  assert.equal((await readSessionConversation(file)).contextChecked, false)

  entries[3] = {
    type: 'custom', id: 'current-check', parentId: 'assistant-1',
    customType: EXTERNAL_CONTEXT_CHECKED_ENTRY,
    data: { version: EXTERNAL_CONTEXT_CLASSIFICATION_VERSION }
  }
  writeEntries()
  clearSessionCache()
  assert.equal((await readSessionConversation(file)).contextChecked, true)

  entries.push({
    type: 'custom', id: 'unknown-check', parentId: 'current-check',
    customType: EXTERNAL_CONTEXT_UNKNOWN_ENTRY, data: {}
  })
  writeEntries()
  clearSessionCache()
  assert.equal((await readSessionConversation(file)).contextChecked, false)

  entries.push({
    type: 'message', id: 'user-2', parentId: 'unknown-check',
    message: { role: 'user', content: 'Continue the review.', timestamp: 3 }
  })
  writeEntries()
  clearSessionCache()
  assert.equal((await readSessionConversation(file)).contextChecked, false)

  const plainFile = path.join(root, 'session-plain.jsonl')
  writeFileSync(plainFile, [
    JSON.stringify({ type: 'session', id: 'plain', version: 3, cwd: root }),
    JSON.stringify({
      type: 'message', id: 'plain-user', parentId: null,
      message: { role: 'user', content: 'A plain old conversation.', timestamp: 1 }
    })
  ].join('\n') + '\n')
  assert.equal((await readSessionConversation(plainFile)).contextChecked, true)
})

test('session paths are restricted to regular JSONL files under the session root', async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), 'pi-session-path-'))
  const root = path.join(parent, 'sessions')
  const workspace = path.join(root, '--C--project--')
  try {
    mkdirSync(workspace, { recursive: true })
    const session = path.join(workspace, 'session.jsonl')
    const outside = path.join(parent, 'private.jsonl')
    writeFileSync(session, '{}\n', 'utf8')
    writeFileSync(outside, 'private data\n', 'utf8')
    assert.equal(await resolveSessionFilePath(session, root), session)
    assert.equal(await resolveSessionFilePath(outside, root), null)
    assert.equal(await resolveSessionFilePath(path.join(root, '..', 'private.jsonl'), root), null)
    assert.equal(await resolveSessionFilePath(path.join(workspace, 'settings.json'), root), null)
    assert.equal(await resolveSessionFilePath(workspace, root), null)

    const hardLink = path.join(workspace, 'linked.jsonl')
    try {
      linkSync(outside, hardLink)
      assert.equal(await openSessionFile(hardLink, root), null)
      assert.equal(await resolveSessionFilePath(hardLink, root), null)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'EXDEV') {
        t.diagnostic(`hard links are unavailable (${code})`)
      } else {
        throw error
      }
    }

    const link = path.join(root, 'external')
    try {
      symlinkSync(parent, link, process.platform === 'win32' ? 'junction' : 'dir')
      assert.equal(await resolveSessionFilePath(path.join(link, 'private.jsonl'), root), null)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        t.diagnostic(`directory links are unavailable (${code})`)
      } else {
        throw error
      }
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('session listing ignores JSONL symlinks that escape the session root', async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), 'pi-session-list-link-'))
  const root = path.join(parent, 'sessions')
  const project = path.join(parent, 'project')
  const workspace = path.join(root, encodeWorkspaceDir(project))
  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  try {
    mkdirSync(workspace, { recursive: true })
    mkdirSync(project)
    const makeSession = (id: string, text: string) => [
      JSON.stringify({ type: 'session', version: 3, id, cwd: project }),
      JSON.stringify({
        type: 'message', id: 'm1', parentId: null,
        message: { role: 'user', content: text, timestamp: 1 }
      })
    ].join('\n') + '\n'
    writeFileSync(path.join(workspace, 'inside.jsonl'), makeSession('inside', 'visible prompt'), 'utf8')
    const outside = path.join(parent, 'outside.jsonl')
    writeFileSync(outside, makeSession('outside', 'private prompt'), 'utf8')
    assert.equal(await getSessionMeta(outside, root), null)
    try {
      symlinkSync(outside, path.join(workspace, 'linked.jsonl'), 'file')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        t.diagnostic(`file links are unavailable (${code})`)
      } else {
        throw error
      }
    }

    process.env.PI_CODING_AGENT_SESSION_DIR = root
    const sessions = await listSessions(project)
    assert.deepEqual(sessions.map((session) => session.id), ['inside'])
  } finally {
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    rmSync(parent, { recursive: true, force: true })
  }
})

test('session search and usage ignore JSONL symlinks that escape their scan root', async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), 'pi-session-scan-link-'))
  const root = path.join(parent, 'sessions')
  const project = path.join(parent, 'project')
  const workspace = path.join(root, encodeWorkspaceDir(project))
  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  const insideFile = path.join(workspace, 'inside.jsonl')
  const outsideFile = path.join(parent, 'outside.jsonl')
  try {
    mkdirSync(workspace, { recursive: true })
    mkdirSync(project)
    const makeSession = (id: string, text: string, tokens: number) => [
      JSON.stringify({ type: 'session', version: 3, id, cwd: project }),
      JSON.stringify({
        type: 'message', id: `${id}-user`, parentId: null,
        message: { role: 'user', content: text, timestamp: Date.now() }
      }),
      JSON.stringify({
        type: 'message', id: `${id}-assistant`, parentId: `${id}-user`,
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', model: 'test/model', usage: { input: tokens, totalTokens: tokens } }
      })
    ].join('\n') + '\n'
    writeFileSync(insideFile, makeSession('inside', 'ordinary prompt', 7), 'utf8')
    writeFileSync(outsideFile, makeSession('outside', 'secretmarker prompt', 900), 'utf8')
    process.env.PI_CODING_AGENT_SESSION_DIR = root
    clearSessionCache()

    try {
      symlinkSync(outsideFile, path.join(workspace, 'linked.jsonl'), 'file')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        t.diagnostic(`file links are unavailable (${code})`)
      } else {
        throw error
      }
    }

    assert.equal(await openSessionFile(outsideFile, root), null)
    assert.deepEqual(await searchSessions('secretmarker'), [])
    const usage = await getAggregatedUsage(root)
    assert.equal(usage.allTime.tokens.totalTokens, 7)
  } finally {
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    clearSessionCache()
    rmSync(parent, { recursive: true, force: true })
  }
})

test('session search keeps JSONL symlinks whose target stays inside the root', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-session-search-internal-link-'))
  const workspace = path.join(root, '--C--proj--')
  const target = path.join(workspace, 'target.jsonl')
  const link = path.join(workspace, 'linked.jsonl')
  mkdirSync(workspace, { recursive: true })
  configureSessionSearchIndex(null)
  try {
    writeFileSync(target, [
      JSON.stringify({ type: 'session', version: 3, id: 'linked', cwd: 'C:/proj' }),
      JSON.stringify({
        type: 'message', id: 'user', parentId: null,
        message: { role: 'user', content: 'inrootmarker', timestamp: 1 }
      })
    ].join('\n') + '\n', 'utf8')
    try {
      symlinkSync(target, link, 'file')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        t.diagnostic(`file links are unavailable (${code})`)
        return
      }
      throw error
    }

    const hits = await searchSessions('inrootmarker', 10, { sessionRoots: [root] })
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.snippet.includes('inrootmarker'), true)
  } finally {
    configureSessionSearchIndex(null)
    clearSessionCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('usage cache stays within its source-byte budget across large sessions', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'pi-usage-cache-budget-'))
  const root = path.join(parent, 'sessions')
  const workspace = path.join(root, encodeWorkspaceDir('C:/usage-cache'))
  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  mkdirSync(workspace, { recursive: true })
  clearSessionCache()
  process.env.PI_CODING_AGENT_SESSION_DIR = root
  const content = 'x'.repeat(16 * 1024 * 1024)

  try {
    for (const id of ['first', 'second']) {
      const file = path.join(workspace, `${id}.jsonl`)
      writeFileSync(file, [
        JSON.stringify({ type: 'session', version: 3, id, cwd: 'C:/usage-cache' }),
        JSON.stringify({
          type: 'message',
          id: `${id}-assistant`,
          message: { role: 'assistant', model: 'test/model', content, timestamp: Date.now(), usage: { input: 1, totalTokens: 1 } }
        })
      ].join('\n') + '\n')
    }

    const usage = await getAggregatedUsage(root)
    assert.equal(usage.allTime.tokens.totalTokens, 2)
    const cache = getUsageCacheStats()
    assert.equal(cache.entries, 1)
    assert.ok(cache.sourceBytes <= 32 * 1024 * 1024)
  } finally {
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    clearSessionCache()
    rmSync(parent, { recursive: true, force: true })
  }
})

test('aggregated usage includes sessions larger than the cache budget', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'pi-usage-long-session-'))
  const root = path.join(parent, 'sessions')
  const workspace = path.join(root, encodeWorkspaceDir('C:/usage-long'))
  const file = path.join(workspace, 'long.jsonl')
  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  mkdirSync(workspace, { recursive: true })
  clearSessionCache()
  process.env.PI_CODING_AGENT_SESSION_DIR = root

  try {
    writeFileSync(file, [
      JSON.stringify({ type: 'session', version: 3, id: 'long', cwd: 'C:/usage-long' }),
      JSON.stringify({
        type: 'message',
        id: 'long-assistant',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', model: 'test/model', usage: { input: 4, output: 5, totalTokens: 9 } }
      })
    ].join('\n') + '\n')
    truncateSync(file, 33 * 1024 * 1024)

    const usage = await getAggregatedUsage(root)
    assert.equal(usage.allTime.tokens.totalTokens, 9)
    assert.equal(usage.allTime.conversationsCount, 1)
    assert.equal(usage.byModel[0]?.totalTokens, 9)
    assert.deepEqual(getUsageCacheStats(), { entries: 0, sourceBytes: 0 })
  } finally {
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    clearSessionCache()
    rmSync(parent, { recursive: true, force: true })
  }
})

test('session hydration and rename stay on the verified handle after path replacement', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'pi-session-stable-handle-'))
  const root = path.join(parent, 'sessions')
  const workspace = path.join(root, '--C--project--')
  mkdirSync(workspace, { recursive: true })
  const file = path.join(workspace, 'chat.jsonl')
  const moved = path.join(parent, 'original.jsonl')
  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  clearSessionCache()
  process.env.PI_CODING_AGENT_SESSION_DIR = root
  const makeSession = (text: string, output: number) => [
    JSON.stringify({ type: 'session', version: 3, id: 'stable', cwd: 'C:/project' }),
    JSON.stringify({
      type: 'message', id: 'm1', parentId: null,
      message: { role: 'user', content: text, timestamp: 1 }
    }),
    JSON.stringify({
      type: 'message', id: 'm2', parentId: 'm1',
      message: {
        role: 'assistant', content: 'answer', timestamp: 2,
        usage: { input: 1, output, cacheRead: 0, cacheWrite: 0, totalTokens: output + 1 }
      }
    })
  ].join('\n') + '\n'

  try {
    writeFileSync(file, makeSession('alpha prompt', 2), 'utf8')
    const replacementTime = new Date(1_700_000_000_000)
    utimesSync(file, replacementTime, replacementTime)
    assert.equal((await getSessionMeta(file, root))?.preview, 'alpha prompt')
    assert.equal((await readSessionMessages(file))[0]?.content, 'alpha prompt')
    assert.equal((await getAggregatedUsage(root)).allTime.tokens.totalTokens, 3)
    const originalStats = statSync(file)
    const opened = await openSessionFile(file, root, true)
    assert.ok(opened)
    assert.equal(opened.target, realpathSync(file))

    renameSync(file, moved)
    writeFileSync(file, makeSession('bravo prompt', 4), 'utf8')
    utimesSync(file, originalStats.atime, originalStats.mtime)
    assert.equal(statSync(file).size, originalStats.size)
    assert.equal(statSync(file).mtimeMs, originalStats.mtimeMs)
    try {
      const messages = await readSessionMessages(opened.target, opened.handle)
      assert.equal(messages[0]?.content, 'alpha prompt')
      assert.equal(await appendSessionName(opened.target, 'Original chat', opened.handle), true)
      assert.match(readFileSync(moved, 'utf8'), /"name":"Original chat"/)
      assert.doesNotMatch(readFileSync(file, 'utf8'), /"name":"Original chat"/)
    } finally {
      await opened.handle.close()
    }
    assert.equal((await readSessionMessages(file))[0]?.content, 'bravo prompt')
    assert.equal((await getSessionMeta(file, root))?.preview, 'bravo prompt')
    assert.equal((await getAggregatedUsage(root)).allTime.tokens.totalTokens, 5)
  } finally {
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    clearSessionCache()
    rmSync(parent, { recursive: true, force: true })
  }
})

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

test('canonicalSessionFile: resolves one path once and reuses the answer', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-canonical-'))
  const file = path.join(dir, 'session.jsonl')
  writeFileSync(file, '', 'utf8')
  const originalNative = realpathSync.native
  let calls = 0
  // The module imports the same `realpathSync` object, so counting its
  // `native` method measures exactly the resolutions the cache does not avoid.
  realpathSync.native = ((value: string | Buffer | URL) => {
    calls += 1
    return originalNative(value)
  }) as typeof realpathSync.native
  try {
    assert.equal(canonicalSessionFile(file), canonicalSessionFile(file))
    // The other separator spelling is the same file on every platform here.
    assert.equal(canonicalSessionFile(file.replace(/\\/g, '/')), canonicalSessionFile(file))
    assert.equal(calls, 1)
  } finally {
    realpathSync.native = originalNative
    rmSync(dir, { recursive: true, force: true })
  }
})

test('searchSessions: a superseded query stops during candidate enumeration', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-search-superseded-'))
  const folder = path.join(root, '--C--proj--')
  mkdirSync(folder)
  const newest = path.join(folder, 'new.jsonl')
  const older = path.join(folder, 'old.jsonl')
  const message = (id: string, text: string): string =>
    JSON.stringify({
      type: 'message',
      id,
      parentId: null,
      message: { role: 'user', content: text, timestamp: 100 }
    })
  const filler = 'x'.repeat(40_000)
  writeFileSync(
    newest,
    [
      JSON.stringify({ type: 'session', id: 'new', cwd: 'C:/proj' }),
      message('new-1', `nothing here ${filler}`)
    ].join('\n') + '\n',
    'utf8'
  )
  writeFileSync(
    older,
    [
      JSON.stringify({ type: 'session', id: 'old', cwd: 'C:/proj' }),
      message('old-1', `the needle is here ${filler}`)
    ].join('\n') + '\n',
    'utf8'
  )
  utimesSync(older, new Date(2020, 0, 1), new Date(2020, 0, 1))

  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  process.env.PI_CODING_AGENT_SESSION_DIR = root
  try {
    let checks = 0
    const stopped = await searchSessions('needle', 10, {
      // Cancellation arrives while bounded candidate workers are active; no
      // text-search work should continue after the worker pool settles.
      shouldStop: () => {
        checks += 1
        return checks > 7
      }
    })
    assert.deepEqual(stopped, [], 'the superseded scan must not read further files')
    assert.ok(checks > 7, 'the query was cancelled during candidate enumeration')
  } finally {
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
})

test('searchSessions: a spent byte budget stops the scan before the oldest files', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-search-budget-'))
  const folder = path.join(root, '--C--proj--')
  mkdirSync(folder)
  const newest = path.join(folder, 'new.jsonl')
  const older = path.join(folder, 'old.jsonl')
  const message = (id: string, text: string): string =>
    JSON.stringify({
      type: 'message',
      id,
      parentId: null,
      message: { role: 'user', content: text, timestamp: 100 }
    })
  // Each file is larger than the budget used below, and only the older one
  // carries the query, so the stopped scan has to return no hits.
  const filler = 'x'.repeat(40_000)
  writeFileSync(
    newest,
    [
      JSON.stringify({ type: 'session', id: 'new', cwd: 'C:/proj' }),
      message('new-1', `nothing here ${filler}`)
    ].join('\n') + '\n',
    'utf8'
  )
  writeFileSync(
    older,
    [
      JSON.stringify({ type: 'session', id: 'old', cwd: 'C:/proj' }),
      message('old-1', `the needle is here ${filler}`)
    ].join('\n') + '\n',
    'utf8'
  )
  utimesSync(older, new Date(2020, 0, 1), new Date(2020, 0, 1))

  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  process.env.PI_CODING_AGENT_SESSION_DIR = root
  try {
    const stopped = await searchSessions('needle', 10, { budgetBytes: 20_000 })
    assert.deepEqual(stopped, [], 'the older file must not be read past the budget')

    const scanned = await searchSessions('needle', 10, { budgetBytes: 200_000 })
    assert.equal(scanned.length, 1)
    assert.equal(scanned[0]?.sessionId, 'old')
  } finally {
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
})

test('readJsonlLines: a window starting mid-line yields whole records only', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-jsonl-window-'))
  const file = path.join(dir, 'session.jsonl')
  try {
    const lines = [
      JSON.stringify({ type: 'session', id: 'h' }),
      JSON.stringify({ n: 1 }),
      JSON.stringify({ n: 2 })
    ]
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')

    // Offset 10 lands inside the header line: its fragment is skipped, and the
    // two whole records after it are still returned.
    const window: string[] = []
    for await (const line of readJsonlLines(file, 4096, 10)) window.push(line)
    assert.deepEqual(window, [JSON.stringify({ n: 1 }), JSON.stringify({ n: 2 })])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readJsonlLines: a short byte window keeps complete records before its boundary', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-jsonl-short-window-'))
  const file = path.join(dir, 'session.jsonl')
  try {
    const first = JSON.stringify({ n: 1 })
    writeFileSync(file, `${first}\n${'x'.repeat(128 * 1024)}\n`, 'utf8')

    const window: string[] = []
    for await (const line of readJsonlLines(file, Buffer.byteLength(first) + 1)) window.push(line)
    assert.deepEqual(window, [first])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseLargeSessionMeta: keeps id, name, model and preview from bounded windows', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-large-meta-'))
  const file = path.join(dir, 'session.jsonl')
  try {
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: 'large-1', cwd: 'C:/proj' }),
      JSON.stringify({
        type: 'model_change',
        id: 'mc1',
        parentId: null,
        timestamp: '2026-11-01T00:00:01.000Z',
        provider: 'p',
        modelId: 'm1'
      }),
      JSON.stringify({
        type: 'message',
        id: 'u1',
        parentId: 'mc1',
        timestamp: '2026-11-01T00:00:02.000Z',
        message: { role: 'user', content: 'first prompt', timestamp: 1 }
      }),
      JSON.stringify({
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-11-01T00:00:03.000Z',
        message: { role: 'assistant', content: 'answer', timestamp: 2 }
      }),
      JSON.stringify({
        type: 'message',
        id: 't1',
        parentId: 'a1',
        timestamp: '2026-11-01T00:00:04.000Z',
        message: { role: 'toolResult', content: 'ok', timestamp: 3 }
      }),
      JSON.stringify({ type: 'session_info', id: 's1', parentId: 't1', name: 'Older name' }),
      JSON.stringify({ type: 'session_info', id: 's2', parentId: 's1', name: 'Newest name' })
    ]
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')

    const meta = await parseLargeSessionMeta(file, statSync(file).size, 123)
    assert.ok(meta)
    assert.equal(meta.id, 'large-1')
    assert.equal(meta.cwd, 'C:/proj')
    assert.equal(meta.name, 'Newest name')
    assert.equal(meta.preview, 'first prompt')
    assert.equal(meta.model, 'p/m1')
    assert.equal(meta.messageCount, 3)
    assert.equal(meta.updatedAt, Date.parse('2026-11-01T00:00:04.000Z'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an oversized session stays visible and opens on its newest window', async () => {
  clearSessionCache()
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-oversize-'))
  const file = path.join(dir, 'session.jsonl')
  try {
    // A single line past the read window: the head never sees it whole and the
    // tail starts inside it, which is the case the old size gate refused.
    const filler = 'x'.repeat(25 * 1024 * 1024)
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'big-1', cwd: 'C:/proj' }),
        JSON.stringify({
          type: 'message',
          id: 'm1',
          parentId: null,
          timestamp: '2026-11-01T00:00:01.000Z',
          message: { role: 'user', content: 'first prompt', timestamp: 1 }
        }),
        JSON.stringify({
          type: 'message',
          id: 'm2',
          parentId: 'm1',
          timestamp: '2026-11-01T00:00:02.000Z',
          message: { role: 'toolResult', content: filler, timestamp: 2 }
        }),
        JSON.stringify({
          type: 'message',
          id: 'm3',
          parentId: 'm2',
          timestamp: '2026-11-01T00:00:03.000Z',
          message: { role: 'assistant', content: 'recent answer', timestamp: 3 }
        }),
        JSON.stringify({
          type: 'message',
          id: 'm4',
          parentId: 'm3',
          timestamp: '2026-11-01T00:00:04.000Z',
          message: { role: 'user', content: 'recent prompt', timestamp: 4 }
        })
      ].join('\n') + '\n',
      'utf8'
    )
    assert.ok(statSync(file).size > 24 * 1024 * 1024)
    // Pin the mtime so `updatedAt` compares against the fixture, not the clock.
    const stamp = new Date('2026-11-01T00:00:05.000Z')
    utimesSync(file, stamp, stamp)

    const meta = await getSessionMeta(file)
    assert.ok(meta, 'an oversized session must still be listed')
    assert.equal(meta.id, 'big-1')
    assert.equal(meta.preview, 'first prompt')
    assert.equal(meta.messageCount, 3)
    assert.equal(meta.updatedAt, Date.parse('2026-11-01T00:00:05.000Z'))

    const messages = await readSessionMessages(file)
    assert.deepEqual(
      messages.map((message) => message.content),
      ['recent answer', 'recent prompt'],
      'the tail window keeps the newest branch records'
    )
  } finally {
    clearSessionCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an oversized trailing record does not make the conversation appear empty', async () => {
  clearSessionCache()
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-oversize-trailing-record-'))
  const file = path.join(dir, 'session.jsonl')
  try {
    const filler = 'x'.repeat(25 * 1024 * 1024)
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'big-trailing', cwd: 'C:/proj' }),
        JSON.stringify({
          type: 'message',
          id: 'user-1',
          parentId: null,
          message: { role: 'user', content: 'keep this conversation visible', timestamp: 1 }
        }),
        JSON.stringify({
          type: 'message',
          id: 'assistant-1',
          parentId: 'user-1',
          message: { role: 'assistant', content: 'recent completed answer', timestamp: 2 }
        }),
        JSON.stringify({
          type: 'message',
          id: 'tool-1',
          parentId: 'assistant-1',
          message: { role: 'toolResult', content: filler, timestamp: 3 }
        })
      ].join('\n') + '\n',
      'utf8'
    )

    const messages = await readSessionMessages(file)
    assert.deepEqual(
      messages.map((message) => message.content),
      ['keep this conversation visible', 'recent completed answer'],
      'an oversized final result is skipped while its preceding conversation remains readable'
    )
  } finally {
    clearSessionCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('appendSessionName expands its tail window to find a large active leaf', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-large-rename-'))
  const file = path.join(dir, 'session.jsonl')
  try {
    const filler = 'x'.repeat(23 * 1024 * 1024)
    const largeAnswer = 'y'.repeat(2 * 1024 * 1024)
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'large-rename', cwd: 'C:/proj' }),
        JSON.stringify({
          type: 'message',
          id: 'user-1',
          parentId: null,
          message: { role: 'user', content: 'rename this conversation', timestamp: 1 }
        }),
        JSON.stringify({
          type: 'message',
          id: 'tool-1',
          parentId: 'user-1',
          message: { role: 'toolResult', content: filler, timestamp: 2 }
        }),
        JSON.stringify({
          type: 'message',
          id: 'answer-1',
          parentId: 'tool-1',
          message: { role: 'assistant', content: largeAnswer, timestamp: 3 }
        })
      ].join('\n') + '\n',
      'utf8'
    )
    assert.ok(statSync(file).size > 24 * 1024 * 1024)

    assert.equal(await appendSessionName(file, 'Large answer session'), true)
    const last = readFileSync(file, 'utf8').trim().split('\n').at(-1)
    assert.ok(last)
    assert.equal(JSON.parse(last).parentId, 'answer-1')
    assert.equal((await getSessionMeta(file))?.name, 'Large answer session')
  } finally {
    clearSessionCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('searchSessions: a long session is searchable through its index', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-search-index-'))
  const indexDir = path.join(root, 'index')
  const folder = path.join(root, '--C--proj--')
  mkdirSync(folder)
  const file = path.join(folder, 'big-search.jsonl')
  const filler = 'x'.repeat(8 * 1024 * 1024 + 512 * 1024)
  const message = (id: string, parentId: string | null, role: string, content: string, second: number): string =>
    JSON.stringify({
      type: 'message',
      id,
      parentId,
      timestamp: `2026-11-02T00:00:0${second}.000Z`,
      message: { role, content, timestamp: second }
    })
  try {
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'big-search', cwd: 'C:/proj' }),
        JSON.stringify({ type: 'session_info', id: 'name-1', parentId: null, name: 'Indexed project chat' }),
        message('u0', null, 'user', 'opening prompt', 0),
        message('t1', null, 'toolResult', filler, 1),
        message('u1', 't1', 'user', 'the zebra question', 2),
        message('a1', 'u1', 'assistant', 'the zebra answer', 3)
      ].join('\n') + '\n',
      'utf8'
    )
    const initialPadding = await open(file, 'a')
    try {
      const chunk = 'y'.repeat(1024 * 1024)
      let parentId = 'a1'
      for (let index = 0; index < 61; index += 1) {
        const id = `t2-${index}`
        await initialPadding.writeFile(`${message(id, parentId, 'toolResult', chunk, 4)}\n`)
        parentId = id
      }
    } finally {
      await initialPadding.close()
    }
    assert.ok(statSync(file).size > 64 * 1024 * 1024)

    const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
    process.env.PI_CODING_AGENT_SESSION_DIR = root
    configureSessionSearchIndex(indexDir)
    try {
      // The needle sits past the 8 MB direct-scan cap, so only the index can see it.
      const first = await searchSessions('zebra', 10)
      assert.equal(first.length, 2, 'both matching messages are reported')
      assert.equal(first[0]?.sessionId, 'big-search')
      assert.equal(first[0]?.file, file)
      assert.equal(first[0]?.cwd, 'C:/proj', 'the cold index keeps the project from the session header')
      assert.equal(first[0]?.name, 'Indexed project chat', 'the cold index keeps a name outside its tail window')
      assert.equal(first[0]?.preview, 'opening prompt', 'the cold index keeps the first prompt from the head')
      assert.equal(first[0]?.snippet.includes('zebra'), true)

      const indexFiles = readdirSync(indexDir)
      assert.equal(indexFiles.length, 1)
      const indexPath = path.join(indexDir, indexFiles[0]!)
      const builtAt = statSync(indexPath).mtimeMs

      // A repeated query reuses the snapshot instead of rebuilding the index.
      await searchSessions('zebra', 10)
      assert.equal(statSync(indexPath).mtimeMs, builtAt)

      // A message appended after the build is indexed from the tail only.
      writeFileSync(file, message('u2', 'a1', 'user', 'a giraffe follow-up', 4) + '\n', {
        flag: 'a',
        encoding: 'utf8'
      })
      const second = await searchSessions('giraffe', 10)
      assert.equal(second.length, 1)
      assert.equal(second[0]?.messageIndex, 3)
      assert.equal(second[0]?.snippet.includes('giraffe'), true)

      // Extending the session must roll the index forward instead of keeping
      // every message ever seen. This delta stays within one incremental read.
      const growth = await open(file, 'a')
      try {
        const chunk = 'x'.repeat(1024 * 1024)
        let parentId = 'u2'
        for (let index = 0; index < 4; index += 1) {
          const id = `growth-tool-${index}`
          await growth.writeFile(`${message(id, parentId, 'toolResult', chunk, 5)}\n`)
          parentId = id
        }
      } finally {
        await growth.close()
      }

      assert.deepEqual(await searchSessions('zebra', 10), [], 'messages outside the newest 64 MB leave the index')
      const newest = await searchSessions('giraffe', 10)
      assert.equal(newest.length, 1, 'recent messages remain searchable after the window rolls')
      assert.equal(newest[0]?.snippet.includes('giraffe'), true)
    } finally {
      configureSessionSearchIndex(null)
      if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    }
  } finally {
    clearSessionCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('searchSessions searches past the newest 240 conversations when its byte budget allows', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-search-many-sessions-'))
  const folder = path.join(root, '--C--proj--')
  mkdirSync(folder)
  const target = path.join(folder, 'oldest-match.jsonl')
  configureSessionSearchIndex(null)
  try {
    for (let index = 0; index <= 240; index += 1) {
      const file = index === 0 ? target : path.join(folder, `recent-${index}.jsonl`)
      const content = index === 0 ? 'oldestmatch' : `recent conversation ${index}`
      writeFileSync(file, [
        JSON.stringify({ type: 'session', version: 3, id: `search-${index}`, cwd: 'C:/proj' }),
        JSON.stringify({
          type: 'message', id: `user-${index}`, parentId: null,
          message: { role: 'user', content, timestamp: index }
        })
      ].join('\n') + '\n', 'utf8')
      const modified = new Date(Date.UTC(2024, 0, 1) + index * 1000)
      utimesSync(file, modified, modified)
    }

    const hits = await searchSessions('oldestmatch', 1, { sessionRoots: [root] })
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.file, target)
  } finally {
    configureSessionSearchIndex(null)
    clearSessionCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('searchSessions: a concurrent append waits for the current index version', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-search-index-concurrent-append-'))
  const indexDir = path.join(root, 'index')
  const folder = path.join(root, '--C--proj--')
  mkdirSync(folder)
  const file = path.join(folder, 'concurrent-append.jsonl')
  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  process.env.PI_CODING_AGENT_SESSION_DIR = root
  configureSessionSearchIndex(indexDir)
  let initialSearch: Promise<Awaited<ReturnType<typeof searchSessions>>> | undefined
  try {
    const message = (id: string, parentId: string | null, content: string): string => JSON.stringify({
      type: 'message',
      id,
      parentId,
      message: { role: 'user', content, timestamp: 1 }
    })
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'concurrent-append', cwd: 'C:/proj' }),
        JSON.stringify({
          type: 'message',
          id: 'large-tool-result',
          parentId: null,
          message: { role: 'toolResult', content: 'x'.repeat(48 * 1024 * 1024), timestamp: 1 }
        }),
        message('first-user', 'large-tool-result', 'firstmarker')
      ].join('\n') + '\n',
      'utf8'
    )

    initialSearch = searchSessions('firstmarker', 10)
    let initialFinished = false
    void initialSearch.then(() => { initialFinished = true }, () => { initialFinished = true })
    const waitDeadline = Date.now() + 5_000
    while (
      getSessionSearchIndexCacheStats().inFlight === 0 &&
      !initialFinished &&
      Date.now() < waitDeadline
    ) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    assert.ok(getSessionSearchIndexCacheStats().inFlight > 0, 'the first query is still building its index')

    writeFileSync(file, `${message('appended-user', 'first-user', 'appendmarker')}\n`, {
      flag: 'a',
      encoding: 'utf8'
    })
    const appendedHits = await searchSessions('appendmarker', 10)
    assert.equal(appendedHits.length, 1)
    assert.equal(appendedHits[0]?.messageIndex, 2)
    assert.equal(appendedHits[0]?.snippet.includes('appendmarker'), true)
    assert.equal((await initialSearch)[0]?.snippet.includes('firstmarker'), true)
  } finally {
    await initialSearch?.catch(() => [])
    configureSessionSearchIndex(null)
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    clearSessionCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('searchSessions: an append completes a record cut by the previous index read', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-search-index-partial-'))
  const indexDir = path.join(root, 'index')
  const folder = path.join(root, '--C--proj--')
  mkdirSync(folder)
  const file = path.join(folder, 'partial-record.jsonl')
  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  process.env.PI_CODING_AGENT_SESSION_DIR = root
  configureSessionSearchIndex(indexDir)
  try {
    const filler = 'x'.repeat(9 * 1024 * 1024)
    const incomplete =
      '{"type":"message","id":"partial-user","parentId":"stable-user",' +
      `"message":{"role":"user","content":"partialmarker${'x'.repeat(64 * 1024)}`
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'partial-search', cwd: 'C:/proj' }),
        JSON.stringify({
          type: 'message',
          id: 'tool-1',
          parentId: null,
          message: { role: 'toolResult', content: filler, timestamp: 1 }
        }),
        JSON.stringify({
          type: 'message',
          id: 'stable-user',
          parentId: 'tool-1',
          message: { role: 'user', content: 'stablemarker', timestamp: 2 }
        }),
        incomplete
      ].join('\n'),
      'utf8'
    )
    assert.deepEqual(await searchSessions('partialmarker', 10), [])

    // The incomplete tail is deliberately larger than this query's work
    // budget. A persisted index must still serve the earlier complete hit.
    clearSessionCache()
    const reused = await searchSessions('stablemarker', 10, { budgetBytes: 20_000 })
    assert.equal(reused.length, 1)
    assert.equal(reused[0]?.snippet.includes('stablemarker'), true)

    writeFileSync(file, '","timestamp":2}}\n', { flag: 'a', encoding: 'utf8' })
    const hits = await searchSessions('partialmarker', 10)
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.sessionId, 'partial-search')
    assert.equal(hits[0]?.messageIndex, 2)
  } finally {
    configureSessionSearchIndex(null)
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    clearSessionCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('searchSessions rebuilds an index when a same-size session path is replaced', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'pi-search-index-replaced-'))
  const root = path.join(parent, 'sessions')
  const indexDir = path.join(parent, 'index')
  const folder = path.join(root, '--C--proj--')
  mkdirSync(folder, { recursive: true })
  const file = path.join(folder, 'chat.jsonl')
  const moved = path.join(parent, 'original.jsonl')
  const makeSession = (marker: string) => [
    JSON.stringify({ type: 'session', version: 3, id: 'replaced-search', cwd: 'C:/proj' }),
    JSON.stringify({
      type: 'message',
      id: 'large-user-message',
      parentId: null,
      message: { role: 'user', content: `${'x'.repeat(9 * 1024 * 1024)}${marker}`, timestamp: 1 }
    })
  ].join('\n') + '\n'
  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  process.env.PI_CODING_AGENT_SESSION_DIR = root
  configureSessionSearchIndex(indexDir)
  try {
    writeFileSync(file, makeSession('oldmarker'), 'utf8')
    const replacementTime = new Date(1_700_000_000_000)
    utimesSync(file, replacementTime, replacementTime)
    const originalStats = statSync(file)
    assert.equal((await searchSessions('oldmarker', 10)).length, 1)

    renameSync(file, moved)
    writeFileSync(file, makeSession('newmarker'), 'utf8')
    utimesSync(file, originalStats.atime, originalStats.mtime)
    assert.equal(statSync(file).size, originalStats.size)
    assert.equal(statSync(file).mtimeMs, originalStats.mtimeMs)

    assert.deepEqual(await searchSessions('oldmarker', 10), [])
    assert.equal((await searchSessions('newmarker', 10)).length, 1)
  } finally {
    configureSessionSearchIndex(null)
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    clearSessionCache()
    rmSync(parent, { recursive: true, force: true })
  }
})

test('searchSessions: oversized sidecars stay out of the per-query work budget', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-search-index-sidecar-limit-'))
  const indexDir = path.join(root, 'index')
  const folder = path.join(root, '--C--proj--')
  mkdirSync(folder)
  const file = path.join(folder, 'sidecar-budget.jsonl')
  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  process.env.PI_CODING_AGENT_SESSION_DIR = root
  configureSessionSearchIndex(indexDir)
  try {
    const content = `${'x'.repeat(12 * 1024 * 1024)} sidecarmark`
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'sidecar-budget', cwd: 'C:/proj' }),
        JSON.stringify({
          type: 'message',
          id: 'large-user-message',
          parentId: null,
          message: { role: 'user', content, timestamp: 1 }
        })
      ].join('\n') + '\n',
      'utf8'
    )

    const initial = await searchSessions('sidecarmark', 10)
    assert.equal(initial.length, 1)
    const indexPath = path.join(indexDir, readdirSync(indexDir)[0]!)
    const normalIndexSize = statSync(indexPath).size
    assert.ok(normalIndexSize > 20 * 1024 * 1024)
    assert.ok(normalIndexSize <= 64 * 1024 * 1024)

    clearSessionCache()
    const appended = JSON.stringify({
      type: 'session_info',
      id: 'name-1',
      parentId: 'large-user-message',
      name: 'Budgeted session'
    }) + '\n'
    writeFileSync(file, appended, { flag: 'a', encoding: 'utf8' })
    const appendBytes = Buffer.byteLength(appended)
    const budgeted = await searchSessions('sidecarmark', 10, {
      budgetBytes: normalIndexSize + Math.ceil(appendBytes / 2)
    })
    assert.deepEqual(budgeted, [], 'the sidecar and required source update share the work budget')
    assert.equal(statSync(indexPath).size, normalIndexSize)

    writeFileSync(indexPath, '')
    truncateSync(indexPath, 64 * 1024 * 1024 + 1)
    clearSessionCache()

    const limited = await searchSessions('sidecarmark', 10, { budgetBytes: 20_000 })
    assert.deepEqual(limited, [], 'the small budget only scans the bounded direct window')
    assert.equal(existsSync(indexPath), false, 'the oversized sidecar was discarded without loading it')

    const rebuilt = await searchSessions('sidecarmark', 10)
    assert.equal(rebuilt.length, 1)
    assert.equal(rebuilt[0]?.sessionId, 'sidecar-budget')
    assert.ok(statSync(indexPath).size <= 64 * 1024 * 1024)
  } finally {
    configureSessionSearchIndex(null)
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    clearSessionCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('searchSessions: the index respects the work budget before build and during cached scans', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-search-index-budget-'))
  const indexDir = path.join(root, 'index')
  const folder = path.join(root, '--C--proj--')
  mkdirSync(folder)
  const file = path.join(folder, 'budgeted.jsonl')
  const content = `needle-start${'x'.repeat(9 * 1024 * 1024)}lateword`
  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  process.env.PI_CODING_AGENT_SESSION_DIR = root
  configureSessionSearchIndex(indexDir)
  try {
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'budgeted', cwd: 'C:/proj' }),
        JSON.stringify({
          type: 'message',
          id: 'large-user-message',
          parentId: null,
          message: { role: 'user', content, timestamp: 1 }
        })
      ].join('\n') + '\n',
      'utf8'
    )
    assert.ok(statSync(file).size > 8 * 1024 * 1024)

    const coldBudget = await searchSessions('lateword', 10, { budgetBytes: 20_000 })
    assert.deepEqual(coldBudget, [])
    assert.equal(existsSync(indexDir), false, 'a small budget must not trigger a full index build')

    const nearBudget = await searchSessions('lateword', 10, {
      budgetBytes: statSync(file).size + 1024
    })
    assert.deepEqual(nearBudget, [], 'the cold build must include its bounded metadata reads in the budget')
    assert.equal(existsSync(indexDir), false, 'the estimated head and tail reads can make a build exceed budget')

    const built = await searchSessions('needle-start', 10)
    assert.equal(built.length, 1)
    assert.equal(built[0]?.sessionId, 'budgeted')

    const cachedBudget = await searchSessions('lateword', 10, { budgetBytes: 20_000 })
    assert.deepEqual(cachedBudget, [], 'cached text scanning stops at the remaining budget')
    const complete = await searchSessions('lateword', 10)
    assert.equal(complete.length, 1, 'the same indexed query finds the tail when budget permits')
  } finally {
    configureSessionSearchIndex(null)
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    clearSessionCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('search index cache stays within its estimated memory budget across sessions', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-search-index-cache-budget-'))
  const indexDir = path.join(root, 'index')
  const folder = path.join(root, '--C--proj--')
  mkdirSync(folder)
  const content = `cachemark${'x'.repeat(9 * 1024 * 1024)}`
  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  process.env.PI_CODING_AGENT_SESSION_DIR = root
  configureSessionSearchIndex(indexDir)
  try {
    for (const id of ['first', 'second']) {
      const file = path.join(folder, `${id}.jsonl`)
      writeFileSync(
        file,
        [
          JSON.stringify({ type: 'session', version: 3, id, cwd: 'C:/proj' }),
          JSON.stringify({
            type: 'message',
            id: `${id}-user`,
            parentId: null,
            message: { role: 'user', content, timestamp: 1 }
          })
        ].join('\n') + '\n',
        'utf8'
      )
    }

    const hits = await searchSessions('cachemark', 10)
    assert.equal(hits.length, 2)
    const cache = getSessionSearchIndexCacheStats()
    assert.equal(cache.entries, 1, 'the byte cap evicts one of two individually cacheable indexes')
    assert.ok(cache.estimatedBytes <= 64 * 1024 * 1024)
  } finally {
    configureSessionSearchIndex(null)
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    clearSessionCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('persistent search indexes prune oldest sidecars to honor byte and file limits', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-search-index-prune-'))
  const indexDir = path.join(root, 'index')
  mkdirSync(indexDir)
  configureSessionSearchIndex(indexDir)
  try {
    for (const [name, content, year] of [
      ['old.json', '0123456789', 2020],
      ['middle.json', '01234567890123456789', 2021],
      ['new.json', '012345678901234567890123456789', 2022]
    ] as const) {
      const file = path.join(indexDir, name)
      writeFileSync(file, content)
      const timestamp = new Date(`${year}-01-01T00:00:00.000Z`)
      utimesSync(file, timestamp, timestamp)
    }

    const abandonedTemp = path.join(indexDir, 'abandoned.json.1234.tmp')
    writeFileSync(abandonedTemp, '12345')
    const abandonedAt = new Date('2019-01-01T00:00:00.000Z')
    utimesSync(abandonedTemp, abandonedAt, abandonedAt)
    await pruneSessionSearchIndexFiles(62)
    assert.equal(existsSync(abandonedTemp), false, 'an orphaned write must count toward the disk cap')
    assert.deepEqual(readdirSync(indexDir).sort(), ['middle.json', 'new.json', 'old.json'])
    if (process.platform !== 'win32') {
      assert.equal(statSync(indexDir).mode & 0o777, 0o700)
      for (const name of readdirSync(indexDir)) {
        assert.equal(statSync(path.join(indexDir, name)).mode & 0o777, 0o600)
      }
    }

    await pruneSessionSearchIndexFiles(35)
    assert.deepEqual(readdirSync(indexDir), ['new.json'])

    for (let index = 0; index < 513; index += 1) {
      writeFileSync(path.join(indexDir, `index-${String(index).padStart(3, '0')}.json`), 'x')
    }
    await pruneSessionSearchIndexFiles(Number.MAX_SAFE_INTEGER)
    const remaining = readdirSync(indexDir).sort()
    assert.equal(remaining.length, 512)
    assert.equal(remaining.includes('index-000.json'), false)
  } finally {
    configureSessionSearchIndex(null)
    clearSessionCache()
    rmSync(root, { recursive: true, force: true })
  }
})
