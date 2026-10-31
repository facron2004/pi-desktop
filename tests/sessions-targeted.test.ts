import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  clearSessionCache,
  encodeWorkspaceDir,
  findWorkspaceSessionDir,
  getSessionCacheSize,
  listSessions,
  pathsEqual
} from '../src/main/sessions'

test('encodeWorkspaceDir: normalizes paths across Windows drive letters, separators, and Unicode', () => {
  // 1. Separators: forward vs backward slashes normalize identically
  const slashFwd = encodeWorkspaceDir('C:/Users/TestUser/Project')
  const slashBack = encodeWorkspaceDir('C:\\Users\\TestUser\\Project')
  assert.equal(slashFwd, slashBack)
  assert.ok(slashFwd.startsWith('--'))
  assert.ok(slashFwd.endsWith('--'))
  assert.ok(!slashFwd.includes('/'))
  assert.ok(!slashFwd.includes('\\'))
  assert.ok(!slashFwd.includes(':'))

  // 2. Trailing separators and redundant dot segments normalize to identical encoding
  const trailing = encodeWorkspaceDir('C:/Users/TestUser/Project/')
  const redundant = encodeWorkspaceDir('C:/Users/TestUser/./Project/../Project')
  assert.equal(trailing, slashFwd)
  assert.equal(redundant, slashFwd)

  // 3. Unicode workspace path support
  const unicodeDir = 'C:\\Project\\开源项目\\π-desktop'
  const unicodeEncoded = encodeWorkspaceDir(unicodeDir)
  assert.ok(unicodeEncoded.startsWith('--'))
  assert.ok(unicodeEncoded.endsWith('--'))
  assert.ok(unicodeEncoded.includes('开源项目'))
  assert.ok(!unicodeEncoded.includes('\\'))
  assert.ok(!unicodeEncoded.includes(':'))

  // 4. POSIX paths
  if (process.platform !== 'win32') {
    const posix = encodeWorkspaceDir('/home/developer/workspace')
    assert.equal(posix, '--home-developer-workspace--')
  }
})

test('pathsEqual: cross-platform path equivalence, normalization, and case sensitivity', () => {
  // Identical paths
  assert.equal(pathsEqual('C:/foo/bar', 'C:/foo/bar'), true)

  // Slashes vs backslashes
  assert.equal(pathsEqual('C:/foo/bar', 'C:\\foo\\bar'), true)

  // Redundant dot segments
  assert.equal(pathsEqual('C:/foo/./bar/../bar', 'C:/foo/bar'), true)
  assert.equal(pathsEqual('C:/foo/bar/', 'C:/foo/bar'), true)

  // Windows case insensitivity
  if (process.platform === 'win32') {
    assert.equal(pathsEqual('c:/foo/bar', 'C:/foo/bar'), true)
    assert.equal(pathsEqual('C:/FOO/BAR', 'c:/foo/bar'), true)
    assert.equal(pathsEqual('e:\\Project\\Sub', 'E:\\project\\sub'), true)
  }

  // Different paths must return false
  assert.equal(pathsEqual('C:/foo/bar', 'C:/foo/baz'), false)
  assert.equal(pathsEqual('C:/foo/bar', 'D:/foo/bar'), false)
})

test('findWorkspaceSessionDir: multi-tier resolution across direct candidate, casing flip, realpath, and shallow scan', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-target-root-'))
  const wsDir = mkdtempSync(path.join(tmpdir(), 'pi-target-ws-'))
  try {
    // 1. Tier 1: Direct candidate match
    const ws1 = path.join(wsDir, 'DirectProject')
    mkdirSync(ws1, { recursive: true })
    const enc1 = encodeWorkspaceDir(ws1)
    const sessionDir1 = path.join(root, enc1)
    mkdirSync(sessionDir1, { recursive: true })

    const foundDirect = await findWorkspaceSessionDir(root, ws1)
    assert.equal(foundDirect, sessionDir1)

    // 2. Tier 2: Windows drive letter casing flip (e.g. e: vs E:)
    if (process.platform === 'win32') {
      const match = ws1.match(/^([a-zA-Z]):[\\/]/)
      if (match) {
        const origDrive = match[1]
        const flippedDrive = origDrive === origDrive.toUpperCase() ? origDrive.toLowerCase() : origDrive.toUpperCase()
        const flippedWs = flippedDrive + ws1.slice(1)

        const foundFlipped = await findWorkspaceSessionDir(root, flippedWs)
        assert.ok(foundFlipped)
        assert.equal(pathsEqual(foundFlipped, sessionDir1), true)
      }
    }

    // 3. Tier 3: Realpath / symlink / junction resolution
    const realTarget = path.join(wsDir, 'RealTargetFolder')
    mkdirSync(realTarget, { recursive: true })
    const junctionLink = path.join(wsDir, 'JunctionLink')
    try {
      symlinkSync(realTarget, junctionLink, process.platform === 'win32' ? 'junction' : 'dir')
      // Session dir was recorded under the real canonical path
      const realEnc = encodeWorkspaceDir(realTarget)
      const sessionDirReal = path.join(root, realEnc)
      mkdirSync(sessionDirReal, { recursive: true })

      // Querying with junctionLink resolves to sessionDirReal
      const foundJunction = await findWorkspaceSessionDir(root, junctionLink)
      assert.ok(foundJunction)
      assert.equal(pathsEqual(foundJunction, sessionDirReal), true)
    } catch {
      // Symlink permission might be restricted on some platforms
    }

    // 4. Tier 4: Shallow case-insensitive match
    const shallowWs = path.join(wsDir, 'CaseMismatch')
    mkdirSync(shallowWs, { recursive: true })
    const directEncName = encodeWorkspaceDir(shallowWs)
    // Create folder with lowercased name in sessionRoot
    const lowerEncName = directEncName.toLowerCase()
    const sessionDirLower = path.join(root, lowerEncName)
    if (!sessionDirLower.includes(directEncName)) {
      mkdirSync(sessionDirLower, { recursive: true })
      const foundLower = await findWorkspaceSessionDir(root, shallowWs)
      assert.ok(foundLower)
    }

    // 5. Non-existent workspace returns null
    const notFound = await findWorkspaceSessionDir(root, path.join(wsDir, 'NonExistentProject'))
    assert.equal(notFound, null)

    // 6. Non-existent or invalid session root returns null gracefully
    const invalidRoot = await findWorkspaceSessionDir(path.join(root, 'non-existent-root'), ws1)
    assert.equal(invalidRoot, null)

    const fileAsRoot = path.join(root, 'dummy-file.txt')
    writeFileSync(fileAsRoot, 'not a directory', 'utf8')
    const fileRootRes = await findWorkspaceSessionDir(fileAsRoot, ws1)
    assert.equal(fileRootRes, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(wsDir, { recursive: true, force: true })
  }
})

test('listSessions(targetCwd): targeted isolation reads ONLY target workspace and ignores unrelated workspaces', async () => {
  clearSessionCache()
  const sessionRoot = mkdtempSync(path.join(tmpdir(), 'pi-sessions-targeted-root-'))
  const workDir = mkdtempSync(path.join(tmpdir(), 'pi-workspaces-'))
  const originalEnv = process.env.PI_CODING_AGENT_SESSION_DIR
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionRoot

  try {
    const targetWs = path.join(workDir, 'target-project')
    const otherWs1 = path.join(workDir, 'other-project-1')
    const otherWs2 = path.join(workDir, 'other-project-2')
    mkdirSync(targetWs, { recursive: true })
    mkdirSync(otherWs1, { recursive: true })
    mkdirSync(otherWs2, { recursive: true })

    const targetSessionDir = path.join(sessionRoot, encodeWorkspaceDir(targetWs))
    const otherSessionDir1 = path.join(sessionRoot, encodeWorkspaceDir(otherWs1))
    const otherSessionDir2 = path.join(sessionRoot, encodeWorkspaceDir(otherWs2))
    mkdirSync(targetSessionDir, { recursive: true })
    mkdirSync(otherSessionDir1, { recursive: true })
    mkdirSync(otherSessionDir2, { recursive: true })

    // 1. Populate target workspace with 3 session files
    for (let i = 1; i <= 3; i++) {
      writeFileSync(
        path.join(targetSessionDir, `target_${i}.jsonl`),
        [
          JSON.stringify({ type: 'session', version: 3, id: `target-s${i}`, cwd: targetWs }),
          JSON.stringify({
            type: 'message',
            id: 'm1',
            parentId: null,
            message: { role: 'user', content: `Target query ${i}`, timestamp: 1000 + i }
          })
        ].join('\n') + '\n',
        'utf8'
      )
    }

    // 2. Populate unrelated workspace 1 with 5 session files
    for (let i = 1; i <= 5; i++) {
      writeFileSync(
        path.join(otherSessionDir1, `other1_${i}.jsonl`),
        [
          JSON.stringify({ type: 'session', version: 3, id: `other1-s${i}`, cwd: otherWs1 }),
          JSON.stringify({
            type: 'message',
            id: 'm1',
            parentId: null,
            message: { role: 'user', content: `Other 1 query ${i}`, timestamp: 2000 + i }
          })
        ].join('\n') + '\n',
        'utf8'
      )
    }

    // 3. Populate unrelated workspace 2 with 5 session files, including one intentionally unparseable corrupt file
    for (let i = 1; i <= 4; i++) {
      writeFileSync(
        path.join(otherSessionDir2, `other2_${i}.jsonl`),
        [
          JSON.stringify({ type: 'session', version: 3, id: `other2-s${i}`, cwd: otherWs2 }),
          JSON.stringify({
            type: 'message',
            id: 'm1',
            parentId: null,
            message: { role: 'user', content: `Other 2 query ${i}`, timestamp: 3000 + i }
          })
        ].join('\n') + '\n',
        'utf8'
      )
    }
    // Corrupt file in unrelated workspace
    writeFileSync(path.join(otherSessionDir2, 'corrupt.jsonl'), 'INVALID_NON_JSON_DATA_THAT_WOULD_CORRUPT\n', 'utf8')

    // 4. Test targeted query: listSessions(targetWs)
    clearSessionCache()
    assert.equal(getSessionCacheSize(), 0)

    const targetSessions = await listSessions(targetWs)
    assert.equal(targetSessions.length, 3)
    for (const session of targetSessions) {
      assert.ok(pathsEqual(session.cwd, targetWs))
      assert.ok(session.id.startsWith('target-s'))
    }

    // Verification of targeted isolation:
    // Only the 3 files of target workspace were read and added to cache.
    // None of the 10 files in otherSessionDir1 or otherSessionDir2 were touched.
    assert.equal(getSessionCacheSize(), 3, 'cache must only hold metadata for the targeted workspace files')

    // 5. Query for non-existent workspace returns [] immediately without inspecting unrelated directories
    const emptySessions = await listSessions(path.join(workDir, 'non-existent-workspace'))
    assert.equal(emptySessions.length, 0)
    assert.equal(getSessionCacheSize(), 3, 'cache size must remain unchanged when querying non-existent workspace')

    // 6. Global listSessions() without cwd scans all workspaces
    const allSessions = await listSessions()
    // 3 from target + 5 from other1 + 4 from other2 = 12 valid sessions
    assert.equal(allSessions.length, 12)
  } finally {
    if (originalEnv !== undefined) {
      process.env.PI_CODING_AGENT_SESSION_DIR = originalEnv
    } else {
      delete process.env.PI_CODING_AGENT_SESSION_DIR
    }
    clearSessionCache()
    rmSync(sessionRoot, { recursive: true, force: true })
    rmSync(workDir, { recursive: true, force: true })
  }
})
