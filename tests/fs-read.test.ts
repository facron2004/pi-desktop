import assert from 'node:assert/strict'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  MAX_FILE_BYTES,
  listProjectImages,
  openWorkspaceFile,
  readBoundedFile,
  readImageDataUrl,
  resolveWorkspacePath
} from '../src/main/ipc'
import type { IpcContext } from '../src/main/ipc'

test('readBoundedFile reads entire small file without truncation', async () => {
  const temp = realpathSync(os.tmpdir())
  const dir = mkdtempSync(path.join(temp, 'pi-desktop-fs-test-'))
  try {
    const file = path.join(dir, 'small.txt')
    const sampleText = 'This is a small file content for testing.\nLine 2.\n'
    writeFileSync(file, sampleText, 'utf8')

    const result = await readBoundedFile(file)
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

test('readBoundedFile on large file (> 512KB) reads only MAX_FILE_BYTES without loading full file', async () => {
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

    const result = await readBoundedFile(file)
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

test('readBoundedFile on 0-byte file returns empty content with truncated: false', async () => {
  const temp = realpathSync(os.tmpdir())
  const dir = mkdtempSync(path.join(temp, 'pi-desktop-fs-test-'))
  try {
    const file = path.join(dir, 'empty.txt')
    writeFileSync(file, '')

    const result = await readBoundedFile(file)
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

test('readBoundedFile returns null on missing file or directory', async () => {
  const temp = realpathSync(os.tmpdir())
  const dir = mkdtempSync(path.join(temp, 'pi-desktop-fs-test-'))
  try {
    assert.equal(await readBoundedFile(path.join(dir, 'nonexistent.txt')), null)
    // Testing on a directory should return null
    assert.equal(await readBoundedFile(dir), null)
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

test('openWorkspaceFile reads from the verified handle after the pathname is replaced', async () => {
  const temp = realpathSync(os.tmpdir())
  const workspace = mkdtempSync(path.join(temp, 'pi-desktop-stable-handle-'))
  const file = path.join(workspace, 'notes.txt')
  const moved = path.join(workspace, 'original.txt')
  try {
    writeFileSync(file, 'workspace content')
    const opened = await openWorkspaceFile(workspace, 'notes.txt')
    assert.ok(opened)
    assert.equal(opened.target, realpathSync(file))

    renameSync(file, moved)
    writeFileSync(file, 'replacement content')
    try {
      assert.equal(await opened.handle.readFile('utf8'), 'workspace content')
    } finally {
      await opened.handle.close()
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('listProjectImages finds every picture in one walk and skips excluded folders', async () => {
  const temp = realpathSync(os.tmpdir())
  const dir = mkdtempSync(path.join(temp, 'pi-desktop-images-'))
  try {
    mkdirSync(path.join(dir, 'assets'), { recursive: true })
    mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
    writeFileSync(path.join(dir, 'assets', 'logo.PNG'), 'png')
    writeFileSync(path.join(dir, 'assets', 'photo.jpg'), 'jpg')
    writeFileSync(path.join(dir, 'readme.md'), 'text')
    writeFileSync(path.join(dir, 'node_modules', 'dependency.png'), 'png')

    const result = await listProjectImages(dir)
    assert.deepEqual(
      result.entries.map((entry) => entry.path),
      [
        path.join(dir, 'assets', 'logo.PNG'),
        path.join(dir, 'assets', 'photo.jpg')
      ]
    )
    assert.equal(result.entries.every((entry) => entry.kind === 'file'), true)
    assert.equal(result.truncated, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listProjectImages stops when its caller supersedes the walk', async () => {
  const temp = realpathSync(os.tmpdir())
  const dir = mkdtempSync(path.join(temp, 'pi-desktop-images-cancel-'))
  try {
    for (let index = 0; index < 8; index += 1) {
      writeFileSync(path.join(dir, `image-${index}.png`), 'png')
    }
    const complete = await listProjectImages(dir)
    let checks = 0
    const cancelled = await listProjectImages(dir, 100, () => ++checks > 3)

    assert.equal(complete.entries.length, 8)
    assert.ok(checks >= 4)
    assert.ok(cancelled.entries.length < complete.entries.length)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listProjectImages reports when its result limit is reached', async () => {
  const temp = realpathSync(os.tmpdir())
  const dir = mkdtempSync(path.join(temp, 'pi-desktop-images-limit-'))
  try {
    for (let index = 0; index < 3; index += 1) {
      writeFileSync(path.join(dir, `image-${index}.png`), 'png')
    }
    const result = await listProjectImages(dir, 2)
    assert.equal(result.entries.length, 2)
    assert.equal(result.truncated, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listProjectImages reports when the depth limit omits deeper folders', async () => {
  const temp = realpathSync(os.tmpdir())
  const dir = mkdtempSync(path.join(temp, 'pi-desktop-images-depth-'))
  try {
    let nested = dir
    for (let depth = 0; depth <= 12; depth += 1) {
      nested = path.join(nested, `level-${depth}`)
      mkdirSync(nested)
    }
    writeFileSync(path.join(nested, 'hidden.png'), 'png')

    const result = await listProjectImages(dir)
    assert.deepEqual(result.entries, [])
    assert.equal(result.truncated, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readImageDataUrl applies a caller byte limit and never exceeds the full-image limit', async () => {
  const temp = realpathSync(os.tmpdir())
  const dir = mkdtempSync(path.join(temp, 'pi-desktop-image-size-'))
  const file = path.join(dir, 'small.png')
  const oversized = path.join(dir, 'oversized.png')
  try {
    writeFileSync(file, '12345')
    writeFileSync(oversized, '')
    truncateSync(oversized, 24 * 1024 * 1024 + 1)
    const context = {
      settings: {
        get: () => ({
          activeWorkspaceId: 'test-workspace',
          workspaces: [{ id: 'test-workspace', path: dir }]
        })
      }
    } as unknown as IpcContext

    assert.equal(await readImageDataUrl(context, 'small.png', 4), null)
    assert.equal(await readImageDataUrl(context, 'small.png', 5), 'data:image/png;base64,MTIzNDU=')
    assert.equal(await readImageDataUrl(context, 'small.png', Number.MAX_SAFE_INTEGER), 'data:image/png;base64,MTIzNDU=')
    assert.equal(await readImageDataUrl(context, 'oversized.png', Number.MAX_SAFE_INTEGER), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('workspace reads reject symlink targets outside the workspace', async (t) => {
  const parent = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'pi-desktop-workspace-link-'))
  const workspace = path.join(parent, 'workspace')
  const outside = path.join(parent, 'outside')
  mkdirSync(workspace)
  mkdirSync(outside)
  const image = path.join(outside, 'private.png')
  writeFileSync(image, 'private image bytes')
  const link = path.join(workspace, 'external')

  try {
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        t.skip(`directory links are unavailable (${code})`)
        return
      }
      throw error
    }

    const context = {
      settings: {
        get: () => ({
          activeWorkspaceId: 'test-workspace',
          workspaces: [{ id: 'test-workspace', path: workspace }]
        })
      }
    } as unknown as IpcContext
    assert.equal(await resolveWorkspacePath(workspace, path.join('external', 'private.png')), null)
    assert.equal(await openWorkspaceFile(workspace, path.join('external', 'private.png')), null)
    assert.equal(await readImageDataUrl(context, path.join('external', 'private.png')), null)
    assert.equal(await resolveWorkspacePath(workspace, ''), realpathSync(workspace))
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('workspace reads reject hard links to files outside the workspace', async (t) => {
  const parent = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'pi-desktop-workspace-hardlink-'))
  const workspace = path.join(parent, 'workspace')
  mkdirSync(workspace)
  const outside = path.join(parent, 'private.png')
  const alias = path.join(workspace, 'alias.png')
  writeFileSync(outside, 'private image bytes')

  try {
    try {
      linkSync(outside, alias)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'EXDEV') {
        t.skip(`hard links are unavailable (${code})`)
        return
      }
      throw error
    }

    assert.equal(await openWorkspaceFile(workspace, 'alias.png'), null)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
