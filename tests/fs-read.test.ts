import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { MAX_FILE_BYTES, readBoundedFile } from '../src/main/ipc'

test('readBoundedFile reads entire small file without truncation', () => {
  const temp = realpathSync(os.tmpdir())
  const dir = mkdtempSync(path.join(temp, 'pi-desktop-fs-test-'))
  try {
    const file = path.join(dir, 'small.txt')
    const sampleText = 'This is a small file content for testing.\nLine 2.\n'
    writeFileSync(file, sampleText, 'utf8')

    const result = readBoundedFile(file)
    assert.ok(result)
    assert.equal(result.truncated, false)
    assert.equal(result.size, Buffer.byteLength(sampleText, 'utf8'))
    assert.equal(result.content, sampleText)
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

test('readBoundedFile on large file (> 512KB) reads only MAX_FILE_BYTES without loading full file', () => {
  const temp = realpathSync(os.tmpdir())
  const dir = mkdtempSync(path.join(temp, 'pi-desktop-fs-test-'))
  try {
    const file = path.join(dir, 'large.bin')
    // Create a 1MB file
    const oneMb = 1024 * 1024
    const largeBuffer = Buffer.alloc(oneMb, 0x41) // 'A'
    // Put a distinct marker at the beginning and past the 512KB mark
    largeBuffer.write('START_MARKER', 0, 'utf8')
    largeBuffer.write('PAST_LIMIT_MARKER', MAX_FILE_BYTES + 100, 'utf8')
    writeFileSync(file, largeBuffer)

    const result = readBoundedFile(file)
    assert.ok(result)
    assert.equal(result.truncated, true)
    assert.equal(result.size, oneMb)
    // The returned content byte length must be at most MAX_FILE_BYTES
    assert.equal(Buffer.byteLength(result.content, 'utf8'), MAX_FILE_BYTES)
    // Must contain start marker
    assert.ok(result.content.startsWith('START_MARKER'))
    // Must NOT contain marker past 512KB limit
    assert.equal(result.content.includes('PAST_LIMIT_MARKER'), false)
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

test('readBoundedFile on 0-byte file returns empty content with truncated: false', () => {
  const temp = realpathSync(os.tmpdir())
  const dir = mkdtempSync(path.join(temp, 'pi-desktop-fs-test-'))
  try {
    const file = path.join(dir, 'empty.txt')
    writeFileSync(file, '')

    const result = readBoundedFile(file)
    assert.ok(result)
    assert.equal(result.truncated, false)
    assert.equal(result.size, 0)
    assert.equal(result.content, '')
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

test('readBoundedFile returns null on missing file or directory', () => {
  const temp = realpathSync(os.tmpdir())
  const dir = mkdtempSync(path.join(temp, 'pi-desktop-fs-test-'))
  try {
    assert.equal(readBoundedFile(path.join(dir, 'nonexistent.txt')), null)
    // Testing on a directory should return null
    assert.equal(readBoundedFile(dir), null)
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})
