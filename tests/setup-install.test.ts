import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  copyPayload,
  installApp,
  listSource,
  payloadCopyCommand,
  ROBOCOPY_STDIO,
  uninstallCleanupSpec
} from '../src/main/setup/install'

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

test('robocopy discards stderr to prevent pipe-buffer deadlocks', () => {
  assert.deepEqual(ROBOCOPY_STDIO, ['ignore', 'pipe', 'ignore'])
})

test('an interrupted update restores the previous installation even if the retry has no payload', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-setup-recover-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const originalSource = process.env.PI_SETUP_SOURCE
  process.env.PI_SETUP_SOURCE = path.join(root, 'missing-payload')
  t.after(() => {
    if (originalSource === undefined) delete process.env.PI_SETUP_SOURCE
    else process.env.PI_SETUP_SOURCE = originalSource
  })
  const target = path.join(root, 'Pi Desktop')
  const backup = `${target}.old-2c38865a-f356-4353-ad58-2a8fcc380c10`
  await mkdir(path.join(backup, 'resources'), { recursive: true })
  await writeFile(path.join(backup, 'Pi Desktop.exe'), 'old-executable')
  await writeFile(path.join(backup, 'resources', 'app.asar'), 'old-archive')
  const marker = JSON.stringify({ version: '0.11.14', installDir: target, installedAt: 1 })
  await writeFile(path.join(backup, 'install.json'), marker)
  const lock = `${target}.lock`
  await mkdir(lock)
  const expired = new Date(Date.now() - 20_000)
  await utimes(lock, expired, expired)

  await assert.rejects(installApp({ targetDir: target, launchAfterInstall: false }), /找不到要安装的应用程序文件/)

  assert.equal(await readFile(path.join(target, 'Pi Desktop.exe'), 'utf8'), 'old-executable')
  assert.equal(await readFile(path.join(target, 'resources', 'app.asar'), 'utf8'), 'old-archive')
  assert.equal(await readFile(path.join(target, 'install.json'), 'utf8'), marker)
  await assert.rejects(stat(backup), { code: 'ENOENT' })
  await assert.rejects(stat(lock), { code: 'ENOENT' })
})

test('uninstallCleanupSpec passes target via env var with -LiteralPath and waits on PID', () => {
  const trickyDir = 'C:\\Users\\测试用户\\%APPDATA%&calc\\Pi Desktop'
  const spec = uninstallCleanupSpec(trickyDir, 4242)
  assert.equal(spec.file, 'powershell.exe')
  const encodedIndex = spec.args.indexOf('-EncodedCommand')
  assert.ok(encodedIndex >= 0)
  const decoded = Buffer.from(spec.args[encodedIndex + 1] ?? '', 'base64').toString('utf16le')
  assert.equal(spec.env.PI_DESKTOP_UNINSTALL_DIR, path.resolve(trickyDir))
  assert.equal(decoded.includes('%APPDATA%'), false, 'targetDir must never be interpolated into script source')
  assert.equal(decoded.includes('测试用户'), false)
  assert.match(decoded, /Wait-Process -Id 4242/)
  assert.match(decoded, /Remove-Item -LiteralPath \$target -Recurse -Force/)
  assert.equal(decoded.includes('if not exist'), false)
})
