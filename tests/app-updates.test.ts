import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { downloadAppInstaller, launchAppInstaller, supportsAppUpdate } from '../src/main/app-update-installer'
import { APP_UPDATE_NOTICE, checkForAppUpdates, showAppUpdate } from '../src/renderer/src/lib/app-update'
import {
  APP_RELEASE_PAGE_URL,
  checkAppVersion,
  fetchLatestAppVersion,
  isNewerVersion
} from '../src/main/app-updates'

test('reads and normalizes the latest GitHub release redirect', async () => {
  const version = await fetchLatestAppVersion(async (url, options) => {
    assert.equal(url, APP_RELEASE_PAGE_URL)
    assert.equal(options?.method, 'HEAD')
    assert.equal(options?.redirect, 'manual')
    return new Response(null, {
      status: 302,
      headers: { location: 'https://github.com/facron2004/pi-desktop/releases/tag/v0.10.8' }
    })
  })

  assert.equal(version, '0.10.8')
})

test('compares numeric version segments', () => {
  assert.equal(isNewerVersion('0.10.10', '0.10.9'), true)
  assert.equal(isNewerVersion('0.10.7', '0.10.7'), false)
  assert.equal(isNewerVersion('0.10.6', '0.10.7'), false)
})

test('compares semantic versions with prereleases and build metadata', () => {
  assert.equal(isNewerVersion('1.5.0', '1.5.0-beta.1'), true)
  assert.equal(isNewerVersion('1.5.0-beta.11', '1.5.0-beta.2'), true)
  assert.equal(isNewerVersion('1.5.0-beta.2', '1.5.0-beta.11'), false)
  assert.equal(isNewerVersion('1.5.0+build.2', 'v1.5.0+build.1'), false)
  assert.equal(isNewerVersion('1.5.0-01', '1.5.0-beta'), false)
})

test('reports a newer app release', async () => {
  const status = await checkAppVersion('0.10.7', async () =>
    new Response(null, {
      status: 302,
      headers: { location: 'https://github.com/facron2004/pi-desktop/releases/tag/v0.10.8' }
    })
  )

  assert.deepEqual(status, { current: '0.10.7', latest: '0.10.8', hasUpdate: true })
})

test('keeps the current version and surfaces GitHub errors', async () => {
  const status = await checkAppVersion('0.10.7', async () => new Response(null, { status: 403 }))

  assert.equal(status.current, '0.10.7')
  assert.equal(status.hasUpdate, false)
  assert.match(status.error ?? '', /HTTP 403/)
})

test('rejects malformed GitHub release tags', async () => {
  await assert.rejects(
    fetchLatestAppVersion(async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://github.com/facron2004/pi-desktop/releases/tag/latest' }
      })
    ),
    /invalid latest release tag/
  )
})

test('rejects redirects away from the trusted GitHub host', async () => {
  await assert.rejects(
    fetchLatestAppVersion(async () =>
      new Response(null, { status: 302, headers: { location: 'https://example.com/releases/tag/v0.10.8' } })
    ),
    /unexpected release host/
  )
})

test('opens the public latest release page', () => {
  assert.equal(APP_RELEASE_PAGE_URL, 'https://github.com/facron2004/pi-desktop/releases/latest')
})

const updateBytes = Buffer.from('MZ fixture installer bytes; never executed')
const updateVersion = '0.11.2'
const fixtureAsset = (name = 'Pi.Desktop-0.11.2-x64.exe') => ({
  name, size: updateBytes.length, digest: `sha256:${createHash('sha256').update(updateBytes).digest('hex')}`
})
const fixtureRelease = (assets = [fixtureAsset()]) => ({ tag_name: 'v0.11.2', draft: false, prerelease: false, assets })
const downloadOptions = (directory: string, fetcher: typeof fetch, onProgress = (_progress: unknown) => {}) => ({
  directory, fetcher, currentVersion: '0.11.1', arch: 'x64', onProgress
})

test('downloads the matching architecture, verifies its hash and reports completion', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-app-update-'))
  const calls: string[] = []
  const progress: { percent: number }[] = []
  try {
    const fetcher: typeof fetch = async (url) => {
      calls.push(String(url))
      return calls.length === 1
        ? Response.json(fixtureRelease([fixtureAsset('Pi.Desktop-0.11.2.exe'), fixtureAsset('Pi.Desktop-0.11.2-arm64.exe'), fixtureAsset()]))
        : new Response(updateBytes)
    }
    const installer = await downloadAppInstaller(updateVersion, downloadOptions(directory, fetcher, (value) => progress.push(value as { percent: number })))
    assert.equal(calls[0], 'https://api.github.com/repos/facron2004/pi-desktop/releases/tags/v0.11.2')
    assert.equal(calls[1], 'https://github.com/facron2004/pi-desktop/releases/download/v0.11.2/Pi.Desktop-0.11.2-x64.exe')
    assert.deepEqual(await readFile(installer), updateBytes)
    assert.deepEqual(await readdir(directory), ['installer.exe'])
    assert.equal(progress[0]?.percent, 0)
    assert.equal(progress.at(-1)?.percent, 100)
    assert.ok(progress.every((sample, i) => !i || sample.percent >= progress[i - 1]!.percent))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

for (const [name, bytes, pattern] of [
  ['corrupt', Buffer.from('X'.repeat(updateBytes.length)), /verification/],
  ['truncated', updateBytes.subarray(0, 4), /verification/],
  ['oversized', Buffer.concat([updateBytes, Buffer.from('extra')]), /larger than expected/]
] as const) {
  test(`rejects a ${name} installer without replacing the cached verified file`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pi-app-update-'))
    try {
      await writeFile(path.join(directory, 'installer.exe'), 'previous verified installer')
      let requests = 0
      const fetcher: typeof fetch = async () => ++requests === 1 ? Response.json(fixtureRelease()) : new Response(bytes)
      await assert.rejects(downloadAppInstaller(updateVersion, downloadOptions(directory, fetcher)), pattern)
      assert.equal(await readFile(path.join(directory, 'installer.exe'), 'utf8'), 'previous verified installer')
      assert.deepEqual(await readdir(directory), ['installer.exe'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('rejects old versions, traversal, unsupported architectures and unsigned metadata before downloading', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-app-update-'))
  let requests = 0
  const fetcher: typeof fetch = async () => {
    requests++
    return Response.json(fixtureRelease([{ ...fixtureAsset(), digest: '' }]))
  }
  try {
    for (const version of ['0.11.1', '0.11.0', '../installer', '1.2.3/other', '9'.repeat(100)]) {
      await assert.rejects(downloadAppInstaller(version, downloadOptions(directory, fetcher)), /not a newer release/)
    }
    await assert.rejects(downloadAppInstaller(updateVersion, { ...downloadOptions(directory, fetcher), arch: 'ia32' }), /architecture/)
    assert.equal(requests, 0)
    await assert.rejects(downloadAppInstaller(updateVersion, downloadOptions(directory, fetcher)), /No verified installer/)
    assert.equal(requests, 1)
    assert.deepEqual(await readdir(directory), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects release errors and a mismatched release tag', async () => {
  const options = downloadOptions(tmpdir(), async () => new Response(null, { status: 503 }))
  await assert.rejects(downloadAppInstaller(updateVersion, options), /HTTP 503/)
  await assert.rejects(downloadAppInstaller(updateVersion, { ...options, fetcher: async () => Response.json({ ...fixtureRelease(), tag_name: 'v0.11.3' }) }), /release is invalid/)
})

test('uses the universal installer when an architecture-specific asset is absent', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-app-update-'))
  const urls: string[] = []
  try {
    const fetcher: typeof fetch = async (url) => {
      urls.push(String(url))
      return urls.length === 1 ? Response.json(fixtureRelease([fixtureAsset('Pi.Desktop-0.11.2.exe')])) : new Response(updateBytes)
    }
    await downloadAppInstaller(updateVersion, { ...downloadOptions(directory, fetcher), arch: 'arm64' })
    assert.ok(urls[1]?.endsWith('/Pi.Desktop-0.11.2.exe'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a failed installer response creates no executable', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-app-update-'))
  let requests = 0
  try {
    const fetcher: typeof fetch = async () => ++requests === 1 ? Response.json(fixtureRelease()) : new Response(null, { status: 404 })
    await assert.rejects(downloadAppInstaller(updateVersion, downloadOptions(directory, fetcher)), /HTTP 404/)
    assert.deepEqual(await readdir(directory), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('automatic installation requires an installed Windows build', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-app-update-'))
  try {
    const executable = path.join(directory, 'Pi Desktop.exe')
    assert.equal(supportsAppUpdate(true, 'win32', executable), false)
    await writeFile(path.join(directory, 'Uninstall Pi Desktop.exe'), '')
    assert.equal(supportsAppUpdate(true, 'win32', executable), true)
    assert.equal(supportsAppUpdate(false, 'win32', executable), false)
    assert.equal(supportsAppUpdate(true, 'darwin', executable), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('launches the verified NSIS file without a shell and with restart flags', async () => {
  const child = Object.assign(new EventEmitter(), { unref() {} })
  const spawnProcess = ((file, args, options) => {
    assert.equal(file, 'C:/verified update/installer.exe')
    assert.deepEqual(args, ['--updated', '/S', '--force-run'])
    assert.deepEqual(options, { detached: true, stdio: 'ignore', windowsHide: true })
    queueMicrotask(() => child.emit('spawn'))
    return child
  }) as Parameters<typeof launchAppInstaller>[1]
  await launchAppInstaller('C:/verified update/installer.exe', spawnProcess)
  const failed = ((..._args: unknown[]) => {
    queueMicrotask(() => child.emit('error', new Error('EACCES')))
    return child
  }) as Parameters<typeof launchAppInstaller>[1]
  await assert.rejects(launchAppInstaller('C:/verified update/installer.exe', failed), /EACCES/)
})

test('manual checks share one request and one card; failures remain retryable', async () => {
  const previousWindow = globalThis.window
  const target = new EventTarget()
  const notices: unknown[] = []
  const result = { app: { current: '0.11.1', latest: '0.11.2', hasUpdate: true }, piCli: { current: '1.5.0', hasUpdate: false } }
  let calls = 0
  let resolve!: (value: typeof result) => void
  const pending = new Promise<typeof result>((done) => { resolve = done })
  const bridge = { app: { checkUpdate: () => { calls++; return pending } } }
  Object.assign(globalThis, { window: Object.assign(target, { pi: bridge }) })
  target.addEventListener(APP_UPDATE_NOTICE, (event) => notices.push((event as CustomEvent).detail))
  try {
    const first = checkForAppUpdates()
    assert.equal(checkForAppUpdates(), first)
    resolve(result)
    await first
    assert.equal(calls, 1)
    assert.deepEqual(notices, [{ result }])
    bridge.app.checkUpdate = () => Promise.reject(new Error('offline'))
    await assert.rejects(checkForAppUpdates(), /offline/)
    assert.deepEqual(notices.at(-1), { error: 'offline' })
    bridge.app.checkUpdate = async () => result
    await checkForAppUpdates()
    assert.deepEqual(notices.at(-1), { result })
    const count = calls
    showAppUpdate(result)
    assert.equal(calls, count)
  } finally {
    Object.assign(globalThis, { window: previousWindow })
  }
})
