import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { copyPayload, listSource, payloadCopyCommand } from '../src/main/setup/install'

/**
 * A staged payload that looks like a packaged app.
 *
 * `asarAsDirectory` reproduces how Electron's patched `fs` reports an archive:
 * `stat` says directory and `readdir` lists the archive's contents. The listing
 * must not follow it.
 */
async function fixture(options: { asarAsDirectory: boolean }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-setup-copy-'))
  await writeFile(path.join(root, 'Pi Desktop.exe'), 'exe-bytes')
  await mkdir(path.join(root, 'resources'), { recursive: true })
  const asar = path.join(root, 'resources', 'app.asar')
  if (options.asarAsDirectory) {
    await mkdir(asar, { recursive: true })
    await writeFile(path.join(asar, 'virtual-entry.txt'), 'must not be listed')
  } else {
    await writeFile(asar, 'asar-bytes')
  }
  await mkdir(path.join(root, 'resources', 'app.asar.unpacked'), { recursive: true })
  await writeFile(path.join(root, 'resources', 'app.asar.unpacked', 'native.node'), 'native')
  return root
}

test('the payload listing never walks into an asar archive', async () => {
  const root = await fixture({ asarAsDirectory: true })
  try {
    const { entries } = await listSource(root)
    const relatives = entries.map((entry) => entry.relative.replace(/\\/g, '/'))
    assert.ok(relatives.includes('Pi Desktop.exe'), 'the app executable is missing from the payload')
    assert.ok(relatives.includes('resources/app.asar'), 'the archive itself was not listed as one file')
    assert.ok(
      !relatives.some((relative) => relative.startsWith('resources/app.asar/')),
      'the walk descended into the asar archive'
    )
    assert.ok(
      relatives.includes('resources/app.asar.unpacked/native.node'),
      'the unpacked native modules must still be copied as real files'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the copy command is a plain process with its own retries', () => {
  const { file, args } = payloadCopyCommand('C:/payload', 'C:/target')
  assert.equal(file, 'robocopy.exe')
  assert.deepEqual(args.slice(0, 2), ['C:/payload', 'C:/target'])
  assert.ok(args.includes('/E'), 'subdirectories must be copied')
  assert.ok(args.some((arg) => arg.startsWith('/R:')), 'locked files need a retry budget')
  assert.ok(args.includes('/NDL'), 'the file list is the copy progress, so directory names stay out')
})

test('copying a payload keeps the archive bytes and the unpacked folders', async () => {
  const root = await fixture({ asarAsDirectory: false })
  const parent = await mkdtemp(path.join(tmpdir(), 'pi-setup-target-'))
  const target = path.join(parent, 'Pi Desktop')
  try {
    const { entries } = await listSource(root)
    let reported = 0
    await copyPayload({
      source: root,
      target,
      entries,
      onCopied: (copied) => {
        reported = copied
      }
    })
    assert.equal(await readFile(path.join(target, 'Pi Desktop.exe'), 'utf8'), 'exe-bytes')
    // The whole point: the archive is copied as bytes, never as virtual entries.
    assert.equal(await readFile(path.join(target, 'resources', 'app.asar'), 'utf8'), 'asar-bytes')
    assert.ok((await stat(path.join(target, 'resources', 'app.asar'))).isFile())
    assert.equal(
      await readFile(path.join(target, 'resources', 'app.asar.unpacked', 'native.node'), 'utf8'),
      'native'
    )
    assert.ok(reported > 0, 'the copy did not report progress')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(parent, { recursive: true, force: true })
  }
})
