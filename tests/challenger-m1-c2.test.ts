import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { sanitizeUrl } from '../src/main/mcp'
import { readCommitDetail, readCommitFileDiff } from '../src/main/git'
import { registerIpc } from '../src/main/ipc'
import { dialog, ipcMain } from 'electron'

// ---------------------------------------------------------------------------
// 1. Adversarial Tests on MCP `sanitizeUrl`
// ---------------------------------------------------------------------------

test('sanitizeUrl masks Basic Auth credentials with standard and special characters', () => {
  // @ character in password
  const atInPass = 'http://user:p@ss:word@host'
  const sanitizedAt = sanitizeUrl(atInPass)
  assert.equal(sanitizedAt, 'http://user:***@host/')

  // percent-encoded # in password
  const pctHash = 'http://admin:123%23xyz@host:8080/sse'
  const sanitizedPct = sanitizeUrl(pctHash)
  assert.equal(sanitizedPct, 'http://admin:***@host:8080/sse')

  // non-numeric password with # triggers catch block fallback
  const nonNumericHash = 'http://admin:pass#123@host/sse'
  const sanitizedNonNumeric = sanitizeUrl(nonNumericHash)
  assert.equal(sanitizedNonNumeric, 'http://admin:***@host/sse')
})

test('sanitizeUrl handles query strings with multiple sensitive tokens', () => {
  const multiParamUrl =
    'https://api.example.com/stream?token=secret1&apiKey=key123&regularParam=ok&access_token=tok456&auth=auth789&secret=sec999'
  const sanitized = sanitizeUrl(multiParamUrl)
  assert.ok(sanitized)
  const parsed = new URL(sanitized)
  assert.equal(parsed.searchParams.get('token'), '***')
  assert.equal(parsed.searchParams.get('apiKey'), '***')
  assert.equal(parsed.searchParams.get('regularParam'), 'ok')
  assert.equal(parsed.searchParams.get('access_token'), '***')
  assert.equal(parsed.searchParams.get('auth'), '***')
  assert.equal(parsed.searchParams.get('secret'), '***')
})

test('sanitizeUrl leaves URLs with no credentials or sensitive tokens untouched', () => {
  const cleanUrls = [
    'https://mcp.github.com/events?scope=all',
    'http://localhost:3000/sse',
    'http://127.0.0.1:8080/api/v1',
    'https://example.com/path/to/resource'
  ]
  for (const url of cleanUrls) {
    assert.equal(sanitizeUrl(url), url)
  }
})

test('sanitizeUrl does not crash or throw on malformed or adversarial URLs', () => {
  const malformedInputs = [
    undefined,
    '',
    '   ',
    '://broken',
    'http://',
    'http://[',
    'http://example.com:999999',
    '\x00\x01\x02',
    'javascript:alert(1)',
    'data:text/plain;base64,SGVsbG8=',
    'http://foo.bar?token=',
    'http://user:pass@',
    'http://@host',
    'http://:pass@host',
    'http://:::@host',
    'http://%zz@host',
    'http://\\/\\/evil.com'
  ]
  for (const input of malformedInputs) {
    assert.doesNotThrow(() => {
      sanitizeUrl(input)
    })
  }
})

test('sanitizeUrl masks Basic Auth credentials when password begins with digits and contains unencoded #', () => {
  const target = 'http://admin:123#xyz@host:8080/sse'
  const sanitized = sanitizeUrl(target)
  assert.equal(sanitized, 'http://admin:***@host:8080/sse')
  assert.ok(!sanitized?.includes('123#xyz'), 'Password 123#xyz must be masked')

  // When given without scheme:
  const noScheme = 'admin:123#xyz@host:8080/sse'
  const sanitizedNoScheme = sanitizeUrl(noScheme)
  assert.equal(sanitizedNoScheme, 'admin:***@host:8080/sse')
  assert.ok(!sanitizedNoScheme?.includes('123#xyz'), 'Password 123#xyz must be masked')
})

// ---------------------------------------------------------------------------
// 2. Adversarial Tests on Git Non-ASCII Filenames (-c core.quotepath=false)
// ---------------------------------------------------------------------------

test('readCommitDetail and readCommitFileDiff correctly parse UTF-8 filenames with non-ASCII and spaces', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'git-utf8-adversarial-'))
  try {
    execFileSync('git', ['init'], { cwd: tempDir })
    execFileSync('git', ['config', 'user.name', 'Adversarial Tester'], { cwd: tempDir })
    execFileSync('git', ['config', 'user.email', 'challenger@example.com'], { cwd: tempDir })
    // Default core.quotepath is true in git repositories
    try {
      execFileSync('git', ['config', 'core.quotepath', 'true'], { cwd: tempDir })
    } catch {
      /* ignore */
    }

    // Create files with UTF-8 characters: Chinese, spaces, French accents, German umlauts
    const fileChinese = '测试文档-初稿.md'
    const fileSpaces = 'project specs 2026.txt'
    const fileFrench = 'café résumé.md'
    const fileGerman = 'münchen-notiz.txt'

    writeFileSync(path.join(tempDir, fileChinese), '第一行：中文内容\n第二行：测试\n', 'utf8')
    writeFileSync(path.join(tempDir, fileSpaces), 'Specification line 1\nLine 2\n', 'utf8')
    writeFileSync(path.join(tempDir, fileFrench), 'CV de développeur\nExpérience\n', 'utf8')
    writeFileSync(path.join(tempDir, fileGerman), 'Notizen aus München\n', 'utf8')

    execFileSync('git', ['add', '.'], { cwd: tempDir })
    execFileSync('git', ['commit', '-m', 'Add UTF-8 files'], { cwd: tempDir })
    const commit1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tempDir, encoding: 'utf8' }).trim()

    // Inspect commit 1 with readCommitDetail
    const detail1 = await readCommitDetail(tempDir, commit1)
    assert.ok(detail1)
    assert.equal(detail1.files.length, 4)

    // With -c core.quotepath=false, every path must match the raw UTF-8 string and status must be 'A'
    const paths = detail1.files.map((f) => f.path).sort()
    assert.deepEqual(paths, [fileFrench, fileGerman, fileSpaces, fileChinese].sort())

    for (const f of detail1.files) {
      assert.equal(f.status, 'A', `Expected file ${f.path} status to be 'A' instead of falling back to 'M'`)
      assert.equal(f.binary, false)
    }

    // Now test a rename and modification involving UTF-8
    const renamedFrench = 'café résumé (final) 2026.md'
    execFileSync('git', ['mv', fileFrench, renamedFrench], { cwd: tempDir })
    writeFileSync(path.join(tempDir, fileChinese), '第一行：中文内容（已修改）\n第二行：测试新增行\n', 'utf8')
    execFileSync('git', ['commit', '-am', 'Rename and update UTF-8 files'], { cwd: tempDir })
    const commit2 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tempDir, encoding: 'utf8' }).trim()

    const detail2 = await readCommitDetail(tempDir, commit2)
    assert.ok(detail2)

    const renameEntry = detail2.files.find((f) => f.path === renamedFrench)
    assert.ok(renameEntry, 'Renamed UTF-8 file must be present')
    assert.equal(renameEntry.status, 'R')
    assert.equal(renameEntry.oldPath, fileFrench)

    const modEntry = detail2.files.find((f) => f.path === fileChinese)
    assert.ok(modEntry, 'Modified UTF-8 file must be present')
    assert.equal(modEntry.status, 'M')

    // Test readCommitFileDiff with UTF-8 filename
    const diff = await readCommitFileDiff(tempDir, commit2, renamedFrench)
    assert.ok(diff)
    assert.equal(diff.path, renamedFrench)
    assert.equal(diff.oldText.includes('CV de développeur'), true)
    assert.equal(diff.newText.includes('CV de développeur'), true)
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

// ---------------------------------------------------------------------------
// 3. Adversarial Tests on `fs:saveImage` Magic Bytes
// ---------------------------------------------------------------------------

test('fs:saveImage correctly decodes data URLs and raw base64, verifying magic bytes', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'save-image-test-'))
  try {
    // Register IPC handlers
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyIpc = ipcMain as any
    anyIpc._reset()

    const mockContext = {
      supervisor: {} as any,
      settings: { get: () => ({}) } as any,
      getWindow: () => null,
      terminals: { create: () => {} } as any
    }
    registerIpc(mockContext)

    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const jpegBase64 =
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='

    const pngMagic = '89504e470d0a1a0a'
    const jpegMagic = 'ffd8ff'

    // Test 1: data:image/png;base64,...
    const targetFile1 = path.join(tempDir, 'test-1.png')
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: targetFile1 })
    const res1 = await anyIpc._invoke('fs:saveImage', {}, `data:image/png;base64,${pngBase64}`, 'image/png')
    assert.equal(res1, targetFile1)
    const bytes1 = readFileSync(targetFile1)
    assert.equal(bytes1.subarray(0, 8).toString('hex'), pngMagic, 'PNG from data URL must have valid magic bytes')

    // Test 2: data:image/jpeg;base64,...
    const targetFile2 = path.join(tempDir, 'test-2.jpg')
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: targetFile2 })
    const res2 = await anyIpc._invoke('fs:saveImage', {}, `data:image/jpeg;base64,${jpegBase64}`, 'image/jpeg')
    assert.equal(res2, targetFile2)
    const bytes2 = readFileSync(targetFile2)
    assert.equal(bytes2.subarray(0, 3).toString('hex'), jpegMagic, 'JPEG from data URL must have valid magic bytes')

    // Test 3: raw base64 PNG without prefix
    const targetFile3 = path.join(tempDir, 'test-3.png')
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: targetFile3 })
    const res3 = await anyIpc._invoke('fs:saveImage', {}, pngBase64, 'image/png')
    assert.equal(res3, targetFile3)
    const bytes3 = readFileSync(targetFile3)
    assert.equal(bytes3.subarray(0, 8).toString('hex'), pngMagic, 'PNG from raw base64 must have valid magic bytes')

    // Test 4: raw base64 JPEG without prefix
    const targetFile4 = path.join(tempDir, 'test-4.jpg')
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: targetFile4 })
    const res4 = await anyIpc._invoke('fs:saveImage', {}, jpegBase64, 'image/jpeg')
    assert.equal(res4, targetFile4)
    const bytes4 = readFileSync(targetFile4)
    assert.equal(bytes4.subarray(0, 3).toString('hex'), jpegMagic, 'JPEG from raw base64 must have valid magic bytes')

    // Test 5: canceled dialog returns null
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined })
    const res5 = await anyIpc._invoke('fs:saveImage', {}, pngBase64, 'image/png')
    assert.equal(res5, null)

    // Test 6: throwing dialog (window destroyed) returns null without crashing
    dialog.showSaveDialog = async () => {
      throw new Error('Object has been destroyed')
    }
    const res6 = await anyIpc._invoke('fs:saveImage', {}, pngBase64, 'image/png')
    assert.equal(res6, null)
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})
