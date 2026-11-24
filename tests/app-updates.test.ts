import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync, existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  clearDownloadedInstaller,
  clearStaleDownloads,
  downloadAppInstaller,
  findDownloadedInstaller,
  launchAppInstaller,
  pruneDownloadedInstaller,
  readDownloadedInstaller,
  supportsAppUpdate
} from '../src/main/app-update-installer'
import {
  appUpdateInstall,
  applyAppUpdate,
  availableAppUpdate,
  checkForAppUpdates,
  lastAppUpdateCheck,
  noteAppUpdateCheck,
  noteAppUpdateProgress,
  notePiCliUpdate,
  piCliUpdate,
  restoreDownloadedAppUpdate,
  restorePersistedAppUpdate,
  startAppUpdateDownload,
  subscribeAppUpdateCheck,
  subscribeAvailableAppUpdate,
  subscribePiCliUpdate,
  appUpdateResultNotice,
  dismissAppUpdateResult,
  subscribeAppUpdateResult
} from '../src/renderer/src/lib/app-update'
import { clearUpdateState, readUpdateState, readUpdateStateForVersion, writeUpdateState } from '../src/main/update-state'
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
    assert.deepEqual(await readdir(directory), ['installer.exe', 'installer.json'])
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
    await writeFile(path.join(directory, 'install.json'), '{}')
    assert.equal(supportsAppUpdate(true, 'win32', executable), true)
    assert.equal(supportsAppUpdate(false, 'win32', executable), false)
    assert.equal(supportsAppUpdate(true, 'darwin', executable), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('launches the verified setup file without a shell and with restart flags', async () => {
  const child = Object.assign(new EventEmitter(), { unref() {} })
  const spawnProcess = ((file, args, options) => {
    assert.equal(file, 'C:/verified update/installer.exe')
    assert.deepEqual(args, ['--updated', '/S', '--force-run', `--install-dir=${path.dirname(process.execPath)}`])
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

test('a restart with no stored reading adds nothing', async () => {
  const previousWindow = globalThis.window
  const target = new EventTarget()
  Object.assign(globalThis, { window: Object.assign(target, { pi: { app: { updateState: async () => null } } }) })
  try {
    await restorePersistedAppUpdate()
    assert.equal(lastAppUpdateCheck(), null)
    assert.equal(availableAppUpdate(), null)
  } finally {
    Object.assign(globalThis, { window: previousWindow })
  }
})

test('the startup cache restores a release and a late cache read preserves a newer check', async () => {
  const previousWindow = globalThis.window
  const target = new EventTarget()
  const state = {
    app: { current: '0.11.1', latest: '0.11.2', hasUpdate: true },
    piCli: { current: '1.5.0', latest: '1.5.2', hasUpdate: true },
    checkedAt: 1730000000000
  }
  let resolveDelayed!: (value: typeof state) => void
  const delayedState = new Promise<typeof state>((resolve) => { resolveDelayed = resolve })
  let reads = 0
  const bridge = { app: { updateState: async () => ++reads === 1 ? delayedState : state } }
  Object.assign(globalThis, { window: Object.assign(target, { pi: bridge }) })
  try {
    const delayedRestore = restorePersistedAppUpdate()
    await restorePersistedAppUpdate()
    assert.deepEqual(availableAppUpdate(), { current: '0.11.1', latest: '0.11.2' })
    assert.deepEqual(lastAppUpdateCheck()?.app, state.app)
    // The pair the check stored rides along, so the About page's CLI row is the
    // reading that was actually fetched instead of an invented one.
    assert.deepEqual(piCliUpdate(), { current: '1.5.0', latest: '1.5.2', hasUpdate: true })

    const fresh = {
      app: { current: '0.11.1', latest: '0.11.3', hasUpdate: true },
      piCli: { current: '1.5.2', latest: '1.5.3', hasUpdate: true }
    }
    noteAppUpdateCheck(fresh)
    resolveDelayed(state)
    await delayedRestore
    assert.equal(lastAppUpdateCheck(), fresh)
    assert.equal(availableAppUpdate()?.latest, '0.11.3')
    // A late restore must not put yesterday's CLI reading back over the live one.
    assert.deepEqual(piCliUpdate(), fresh.piCli)
    await restorePersistedAppUpdate()
    assert.equal(reads, 2)
  } finally {
    Object.assign(globalThis, { window: previousWindow })
  }
})

test('a manual check says "you are current" once, and an update only lights the button', async () => {
  const previousWindow = globalThis.window
  const current = { app: { current: '0.11.13', hasUpdate: false }, piCli: { current: '1.6.0', hasUpdate: false } }
  const newer = { app: { current: '0.11.13', latest: '0.11.14', hasUpdate: true }, piCli: { current: '1.6.0', hasUpdate: false } }
  let next: unknown = current
  const bridge = { app: { checkUpdate: async () => next } }
  Object.assign(globalThis, { window: Object.assign(new EventTarget(), { pi: bridge }) })
  const notices: unknown[] = []
  const unsubscribe = subscribeAppUpdateResult((notice) => notices.push(notice))
  try {
    dismissAppUpdateResult()
    await checkForAppUpdates()
    assert.deepEqual(appUpdateResultNotice(), { kind: 'current', current: '0.11.13' })
    assert.deepEqual(notices.at(-1), { kind: 'current', current: '0.11.13' })
    dismissAppUpdateResult()
    assert.equal(appUpdateResultNotice(), null)

    // A release to install belongs on the sidebar button: no notice, and one
    // that is already showing is dismissed.
    next = newer
    await checkForAppUpdates()
    assert.equal(appUpdateResultNotice(), null)

    // A check that could not answer says so instead of passing silently.
    next = { app: { current: '0.11.13', hasUpdate: false, error: 'offline' }, piCli: { current: '1.6.0', hasUpdate: false } }
    await checkForAppUpdates()
    assert.deepEqual(appUpdateResultNotice(), { kind: 'error', error: 'offline' })
  } finally {
    unsubscribe()
    dismissAppUpdateResult()
    Object.assign(globalThis, { window: previousWindow })
  }
})

test('a manual check shares one request, publishes the reading and stays retryable', async () => {
  const previousWindow = globalThis.window
  const target = new EventTarget()
  const readings: unknown[] = []
  const result = { app: { current: '0.11.1', latest: '0.11.2', hasUpdate: true }, piCli: { current: '1.5.0', hasUpdate: false } }
  let calls = 0
  let resolve!: (value: typeof result) => void
  const pending = new Promise<typeof result>((done) => { resolve = done })
  const bridge = { app: { checkUpdate: () => { calls++; return pending } } }
  Object.assign(globalThis, { window: Object.assign(target, { pi: bridge }) })
  const unsubscribe = subscribeAvailableAppUpdate((next) => readings.push(next))
  try {
    const first = checkForAppUpdates()
    assert.equal(checkForAppUpdates(), first)
    resolve(result)
    await first
    assert.equal(calls, 1)
    // The answer goes to the sidebar button — no dialog event on the window.
    assert.deepEqual(readings.at(-1), { current: '0.11.1', latest: '0.11.2' })
    // A failed check keeps the last good reading rather than replacing it.
    bridge.app.checkUpdate = () => Promise.reject(new Error('offline'))
    await assert.rejects(checkForAppUpdates(), /offline/)
    assert.deepEqual(availableAppUpdate(), { current: '0.11.1', latest: '0.11.2' })
    bridge.app.checkUpdate = async () => result
    await checkForAppUpdates()
    assert.deepEqual(readings.at(-1), { current: '0.11.1', latest: '0.11.2' })
    // The manual result is kept in full, not just the sidebar's summary.
    assert.equal(lastAppUpdateCheck(), result)
  } finally {
    unsubscribe()
    Object.assign(globalThis, { window: previousWindow })
  }
})

test('a persisted check survives resubscribing and a failed check keeps it', () => {
  const seen: unknown[] = []
  const result = {
    app: { current: '0.11.1', latest: '0.11.2', hasUpdate: true },
    piCli: { current: '1.5.0', hasUpdate: false }
  }
  const stop = subscribeAppUpdateCheck((value) => seen.push(value))
  try {
    noteAppUpdateCheck(result)
    assert.equal(lastAppUpdateCheck(), result)
    // Closing and reopening settings is a fresh subscriber that reads
    // lastAppUpdateCheck() on mount; the version is still there.
    const stopReopened = subscribeAppUpdateCheck(() => {})
    assert.equal(lastAppUpdateCheck(), result)
    stopReopened()
    // A network failure keeps the last good reading; a check that says the
    // running version is current clears it.
    noteAppUpdateCheck({
      app: { current: '0.11.1', hasUpdate: false, error: 'offline' },
      piCli: { current: '1.5.0', hasUpdate: false }
    })
    assert.equal(lastAppUpdateCheck(), result)
    const current = { app: { current: '0.11.2', hasUpdate: false }, piCli: { current: '1.5.0', hasUpdate: false } }
    noteAppUpdateCheck(current)
    assert.equal(lastAppUpdateCheck(), current)
    assert.deepEqual(seen, [result, current])
  } finally {
    stop()
  }
})

test('an app release is remembered for the sidebar and a failed check keeps it', () => {
  const seen: Array<{ latest: string } | null> = []
  const stop = subscribeAvailableAppUpdate((update) => seen.push(update ? { latest: update.latest } : null))
  try {
    noteAppUpdateCheck({
      app: { current: '0.11.5', latest: '0.12.0', hasUpdate: true },
      piCli: { current: '1.5.0', hasUpdate: false }
    })
    assert.deepEqual(availableAppUpdate(), { current: '0.11.5', latest: '0.12.0' })
    noteAppUpdateCheck({
      app: { current: '0.11.5', hasUpdate: false, error: 'offline' },
      piCli: { current: '1.5.0', hasUpdate: false }
    })
    assert.equal(availableAppUpdate()?.latest, '0.12.0')
    noteAppUpdateCheck({
      app: { current: '0.12.0', latest: '0.12.0', hasUpdate: false },
      piCli: { current: '1.5.0', hasUpdate: false }
    })
    assert.equal(availableAppUpdate(), null)
    assert.deepEqual(seen, [{ latest: '0.12.0' }, null])
  } finally {
    stop()
  }
})


test('the bundled CLI keeps its own reading, whatever the app release says', () => {
  // A clean slot: the checks above already filled it.
  notePiCliUpdate({ current: '1.5.0', hasUpdate: false })
  const seen: Array<boolean | undefined> = []
  const stop = subscribePiCliUpdate((status) => seen.push(status?.hasUpdate))
  try {
    notePiCliUpdate({ current: '1.5.0', latest: '1.5.2', hasUpdate: true })
    assert.deepEqual(piCliUpdate(), { current: '1.5.0', latest: '1.5.2', hasUpdate: true })
    // A check that cannot reach npm keeps the reading it already has: the About
    // page must not lose a newer CLI because the machine went offline.
    notePiCliUpdate({ current: '1.5.0', hasUpdate: false, error: 'offline' })
    assert.equal(piCliUpdate()?.hasUpdate, true)
    // A full check answers both questions, so it refreshes this slot too — the
    // app half being current says nothing about the agent.
    noteAppUpdateCheck({
      app: { current: '0.11.5', hasUpdate: false },
      piCli: { current: '1.5.2', hasUpdate: false }
    })
    assert.deepEqual(piCliUpdate(), { current: '1.5.2', hasUpdate: false })
    assert.deepEqual(seen, [true, false])
  } finally {
    stop()
  }
})

test('the update reading survives a restart on disk', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-desktop-update-state-'))
  try {
    // Nothing checked yet: no reading.
    assert.equal(readUpdateState(dir), null)

    writeUpdateState(dir, {
      app: { current: '0.11.1', latest: '0.11.2', hasUpdate: true, installerBytes: 42 },
      checkedAt: 1730000000000
    })
    const stored = readUpdateState(dir)
    assert.deepEqual(stored?.app, { current: '0.11.1', latest: '0.11.2', hasUpdate: true, installerBytes: 42 })
    assert.equal(stored?.checkedAt, 1730000000000)

    // A corrupt file is treated as no reading at all, so a broken file never
    // keeps the app from checking again.
    writeFileSync(path.join(dir, 'update-state.json'), '{ not json', 'utf8')
    assert.equal(readUpdateState(dir), null)

    // A reading without a version is not a reading.
    writeFileSync(path.join(dir, 'update-state.json'), JSON.stringify({ checkedAt: 1 }), 'utf8')
    assert.equal(readUpdateState(dir), null)

    // The running version being the newest one clears the stored reading.
    writeUpdateState(dir, { app: { current: '0.11.1', latest: '0.11.1', hasUpdate: false }, checkedAt: 1 })
    clearUpdateState(dir)
    assert.equal(readUpdateState(dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the stored reading keeps both halves the check reported', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-desktop-update-pair-'))
  try {
    writeUpdateState(dir, {
      app: { current: '0.11.1', latest: '0.11.2', hasUpdate: true },
      piCli: { current: '1.5.0', latest: '1.5.2', hasUpdate: true },
      checkedAt: 1730000000000
    })
    const restored = readUpdateStateForVersion(dir, '0.11.1')
    // A restored app release must not be paired with an invented Pi CLI
    // reading: the About page shows both, and only one of them is a guess.
    assert.deepEqual(restored?.piCli, { current: '1.5.0', latest: '1.5.2', hasUpdate: true })
    // A malformed Pi CLI half is dropped without discarding the app half.
    writeFileSync(
      path.join(dir, 'update-state.json'),
      JSON.stringify({
        app: { current: '0.11.1', latest: '0.11.2', hasUpdate: true },
        piCli: { hasUpdate: true },
        checkedAt: 1
      }),
      'utf8'
    )
    const partial = readUpdateStateForVersion(dir, '0.11.1')
    assert.equal(partial?.app?.latest, '0.11.2')
    assert.equal(partial?.piCli, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a reading from another version is not restored', () => {  const dir = mkdtempSync(path.join(tmpdir(), 'pi-desktop-update-version-'))
  try {
    // A reading taken while 0.11.1 was running.
    writeUpdateState(dir, {
      app: { current: '0.11.1', latest: '0.11.2', hasUpdate: true },
      checkedAt: 1730000000000
    })
    // The same version is still running: the reading applies.
    assert.equal(readUpdateStateForVersion(dir, '0.11.1')?.app?.latest, '0.11.2')
    // The app was updated to 0.11.2: the stored release is now the running
    // one, so there is nothing to offer and the reading must not be restored.
    assert.equal(readUpdateStateForVersion(dir, '0.11.2'), null)
    assert.equal(readUpdateStateForVersion(dir, '0.12.0'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a reading that is not newer than the running version is not restored', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-desktop-update-stale-'))
  try {
    writeUpdateState(dir, {
      app: { current: '0.11.1', latest: '0.11.1', hasUpdate: false },
      checkedAt: 1730000000000
    })
    assert.equal(readUpdateStateForVersion(dir, '0.11.1'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const downloadFixture = () => {
  const calls: string[] = []
  // Route on the URL rather than the call count: a test may download twice,
  // and the release document is only ever the API answer.
  const fetcher: typeof fetch = async (url) => {
    calls.push(String(url))
    return String(url).startsWith('https://api.github.com/')
      ? Response.json(fixtureRelease())
      : new Response(updateBytes)
  }
  return { calls, fetcher }
}

test('a finished download is remembered for the next run', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-app-update-'))
  try {
    const { fetcher } = downloadFixture()
    const installer = await downloadAppInstaller(updateVersion, downloadOptions(directory, fetcher))
    const stored = readDownloadedInstaller(directory, '0.11.1')
    assert.equal(stored?.version, '0.11.2')
    assert.equal(stored?.bytes, updateBytes.length)
    assert.equal(stored?.path, installer)
    // Only an installer newer than the running version is offered, and only
    // for the exact release a check would name.
    assert.equal(findDownloadedInstaller(directory, '0.11.2', '0.11.1')?.path, installer)
    assert.equal(findDownloadedInstaller(directory, '0.11.3', '0.11.1'), undefined)
    // After the update the stored installer is the running one: not offered.
    assert.equal(readDownloadedInstaller(directory, '0.11.2'), undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a finished download is reused without touching the network', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-app-update-'))
  try {
    const { fetcher } = downloadFixture()
    const installer = await downloadAppInstaller(updateVersion, downloadOptions(directory, fetcher))
    const progress: number[] = []
    const offline: typeof fetch = async () => {
      throw new Error('the cached installer must not be downloaded again')
    }
    const reused = await downloadAppInstaller(
      updateVersion,
      downloadOptions(directory, offline, (value) => progress.push((value as { percent: number }).percent))
    )
    assert.equal(reused, installer)
    assert.deepEqual(progress, [100])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a same-size corrupt cached installer is downloaded again', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-app-update-'))
  try {
    const initial = downloadFixture()
    const installer = await downloadAppInstaller(updateVersion, downloadOptions(directory, initial.fetcher))
    await writeFile(installer, Buffer.alloc(updateBytes.length))

    await assert.rejects(downloadAppInstaller(updateVersion, downloadOptions(directory, async () => {
      throw new Error('offline')
    })), /offline/)
    const retry = downloadFixture()
    assert.equal(await downloadAppInstaller(updateVersion, downloadOptions(directory, retry.fetcher)), installer)
    assert.equal(retry.calls.length, 2, 'the corrupt installer must be replaced')
    assert.deepEqual(await readFile(installer), updateBytes)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a legacy installer record is verified once without downloading the file again', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-app-update-'))
  try {
    const installer = path.join(directory, 'installer.exe')
    await writeFile(installer, updateBytes)
    await writeFile(path.join(directory, 'installer.json'), JSON.stringify({
      version: updateVersion, bytes: updateBytes.length
    }))
    const { fetcher, calls } = downloadFixture()
    assert.equal(await downloadAppInstaller(updateVersion, downloadOptions(directory, fetcher)), installer)
    assert.equal(calls.length, 1, 'legacy bytes need the published digest')
    assert.equal(await downloadAppInstaller(updateVersion, downloadOptions(directory, async () => {
      throw new Error('a verified legacy installer must work offline after migration')
    })), installer)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a record and its installer are dropped when they no longer match', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-app-update-'))
  try {
    const { fetcher } = downloadFixture()
    await downloadAppInstaller(updateVersion, downloadOptions(directory, fetcher))
    // A truncated file is not an installer: the record is stale, so a later
    // request downloads again instead of launching a broken setup.
    await writeFile(path.join(directory, 'installer.exe'), 'truncated')
    assert.equal(readDownloadedInstaller(directory, '0.11.1'), undefined)
    await downloadAppInstaller(updateVersion, downloadOptions(directory, fetcher))
    // A record for another release is pruned; the newest release keeps its
    // verified pair.
    pruneDownloadedInstaller(directory, '0.11.3')
    assert.equal(readDownloadedInstaller(directory, '0.11.1'), undefined)
    assert.deepEqual(await readdir(directory), [])
    await downloadAppInstaller(updateVersion, downloadOptions(directory, fetcher))
    pruneDownloadedInstaller(directory, '0.11.2')
    assert.ok(findDownloadedInstaller(directory, '0.11.2', '0.11.1'))
    clearDownloadedInstaller(directory)
    assert.deepEqual(await readdir(directory), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

type FakeAppBridge = {
  downloadedUpdate: () => Promise<{ version: string; bytes?: number } | null>
  downloadUpdate: (version: string) => Promise<{ success: boolean; version?: string; error?: string }>
  installAppUpdate: (version: string) => Promise<{ success: boolean; version?: string; error?: string }>
  openReleasePage: () => Promise<{ success: boolean }>
  onAppUpdateProgress: (handler: (progress: unknown) => void) => () => void
}

/** A renderer window with just the update bridge; returns a restore function. */
function updateHost(overrides: Partial<FakeAppBridge> = {}): () => void {
  const previousWindow = globalThis.window
  const target = new EventTarget()
  const bridge: FakeAppBridge = {
    downloadedUpdate: async () => null,
    downloadUpdate: async (version) => ({ success: true, version }),
    installAppUpdate: async (version) => ({ success: true, version }),
    openReleasePage: async () => ({ success: true }),
    onAppUpdateProgress: () => () => {},
    ...overrides
  }
  Object.assign(globalThis, { window: Object.assign(target, { pi: { app: bridge } }) })
  return () => {
    Object.assign(globalThis, { window: previousWindow })
  }
}

/** A check that finds nothing resets every reading the module keeps. */
function resetDownloadState(): void {
  noteAppUpdateCheck({
    app: { current: '0.11.1', hasUpdate: false },
    piCli: { current: '1.5.0', hasUpdate: false }
  })
}

test('the download record follows a download and installs the stored version', async () => {
  resetDownloadState()
  const downloads: string[] = []
  let installed: string | undefined
  const stop = updateHost({
    downloadUpdate: async (version) => {
      downloads.push(version)
      return { success: true, version }
    },
    installAppUpdate: async (version) => {
      installed = version
      return { success: true, version }
    }
  })
  try {
    const pending = startAppUpdateDownload('0.12.0', { supported: true, bytes: 4096 })
    assert.equal(appUpdateInstall()?.stage, 'downloading')
    // An event from another release must not drive this ring.
    noteAppUpdateProgress({ version: '0.11.9', stage: 'downloading', percent: 90 })
    assert.equal(appUpdateInstall()?.percent, 0)
    noteAppUpdateProgress({
      version: '0.12.0',
      stage: 'downloading',
      percent: 41.6,
      transferredBytes: 1700,
      totalBytes: 4096
    })
    assert.equal(appUpdateInstall()?.percent, 42)
    assert.equal(appUpdateInstall()?.totalBytes, 4096)
    assert.equal((await pending).success, true)
    assert.equal(appUpdateInstall()?.stage, 'ready')
    assert.equal(appUpdateInstall()?.percent, 100)
    // Late events from the finished stream cannot take the ring back down.
    noteAppUpdateProgress({ version: '0.12.0', stage: 'downloading', percent: 99 })
    assert.equal(appUpdateInstall()?.stage, 'ready')
    assert.deepEqual(await applyAppUpdate(), { success: true, version: '0.12.0' })
    assert.deepEqual(downloads, ['0.12.0'])
    assert.equal(installed, '0.12.0')
  } finally {
    stop()
  }
})

test('a failed download is reported and a click can retry it', async () => {
  resetDownloadState()
  let attempts = 0
  const stop = updateHost({
    downloadUpdate: async (version) => {
      attempts += 1
      return attempts === 1 ? { success: false, error: 'offline' } : { success: true, version }
    }
  })
  try {
    const failed = await startAppUpdateDownload('0.12.1', { supported: true })
    assert.equal(failed.success, false)
    assert.equal(appUpdateInstall()?.stage, 'error')
    assert.equal(appUpdateInstall()?.error, 'offline')
    // Nothing verified is on disk, so a click cannot restart into it.
    assert.equal(await applyAppUpdate(), null)
    const retried = await startAppUpdateDownload('0.12.1', { supported: true })
    assert.equal(retried.success, true)
    assert.equal(appUpdateInstall()?.stage, 'ready')
  } finally {
    stop()
  }
})

test('a refused restart keeps the installer ready to retry', async () => {
  resetDownloadState()
  const stop = updateHost({
    installAppUpdate: async () => ({
      success: false,
      error: 'Finish or stop active tasks before updating Pi Desktop.'
    })
  })
  try {
    await startAppUpdateDownload('0.12.2', { supported: true })
    const result = await applyAppUpdate()
    assert.equal(result?.success, false)
    // The installer is still on disk: the record must stay ready, with the
    // reason the restart was refused.
    assert.equal(appUpdateInstall()?.stage, 'ready')
    assert.match(appUpdateInstall()?.error ?? '', /Finish or stop active tasks/)
  } finally {
    stop()
  }
})

test('a restart restores the downloaded installer instead of downloading again', async () => {
  resetDownloadState()
  let downloads = 0
  const stop = updateHost({
    downloadedUpdate: async () => ({ version: '0.12.3', bytes: 2048 }),
    downloadUpdate: async (version) => {
      downloads += 1
      return { success: true, version }
    }
  })
  try {
    await restoreDownloadedAppUpdate()
    assert.deepEqual(appUpdateInstall(), {
      version: '0.12.3',
      stage: 'ready',
      percent: 100,
      transferredBytes: 2048,
      totalBytes: 2048
    })
    // A check that names another release drops the restored installer.
    noteAppUpdateCheck({
      app: { current: '0.11.1', latest: '0.12.4', hasUpdate: true },
      piCli: { current: '1.5.0', hasUpdate: false }
    })
    assert.equal(appUpdateInstall(), null)
    assert.equal(downloads, 0)
  } finally {
    stop()
  }
})

test('a restore racing a live download leaves the download alone', async () => {
  resetDownloadState()
  let finishDownload: ((value: { success: boolean; version?: string }) => void) | undefined
  const stop = updateHost({
    downloadedUpdate: async () => ({ version: '0.12.4', bytes: 1 }),
    downloadUpdate: () => new Promise((resolve) => {
      finishDownload = resolve
    })
  })
  try {
    const pending = startAppUpdateDownload('0.12.5', { supported: true })
    await restoreDownloadedAppUpdate()
    assert.equal(appUpdateInstall()?.version, '0.12.5')
    assert.equal(appUpdateInstall()?.stage, 'downloading')
    finishDownload?.({ success: true, version: '0.12.5' })
    await pending
    assert.equal(appUpdateInstall()?.stage, 'ready')
  } finally {
    stop()
  }
})

test('a build without self-update opens the release page instead of downloading', async () => {
  resetDownloadState()
  let opened = 0
  const stop = updateHost({
    downloadUpdate: async () => {
      throw new Error('a portable build must not download an installer')
    },
    openReleasePage: async () => {
      opened += 1
      return { success: true }
    }
  })
  try {
    const result = await startAppUpdateDownload('0.13.0', { supported: false })
    assert.equal(result.success, true)
    assert.equal(opened, 1)
    assert.equal(appUpdateInstall(), null)
  } finally {
    stop()
  }
})

test('a failed check keeps a downloaded installer the reader can still restart into', async () => {
  resetDownloadState()
  const stop = updateHost({ downloadedUpdate: async () => ({ version: '0.12.0', bytes: 4096 }) })
  try {
    // A verified installer from an earlier run, put back at startup.
    await restoreDownloadedAppUpdate()
    assert.equal(appUpdateInstall()?.stage, 'ready')
    assert.equal(availableAppUpdate(), null, 'no check has offered the release in this run')

    // The check that follows cannot reach GitHub. A failure says nothing about
    // the bytes already on disk, so "restart to install" must survive it.
    noteAppUpdateCheck({
      app: { current: '0.11.1', hasUpdate: false, error: 'offline' },
      piCli: { current: '1.5.0', hasUpdate: false }
    })
    assert.equal(availableAppUpdate(), null)
    assert.equal(appUpdateInstall()?.stage, 'ready', 'a failed check dropped the downloaded installer')
  } finally {
    stop()
    resetDownloadState()
  }
})

test('a staging folder left by a killed download is swept, a live one is kept', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pi-desktop-update-staging-'))
  try {
    const stale = path.join(directory, 'download-killed')
    const live = path.join(directory, 'download-running')
    const slowLive = path.join(directory, 'download-slow-windows')
    mkdirSync(stale)
    mkdirSync(live)
    mkdirSync(slowLive)
    const staleFile = path.join(stale, 'installer.exe')
    const slowLiveFile = path.join(slowLive, 'installer.exe')
    writeFileSync(staleFile, 'half a setup file', 'utf8')
    writeFileSync(path.join(live, 'installer.exe'), 'half a setup file', 'utf8')
    writeFileSync(slowLiveFile, 'streaming bytes', 'utf8')
    // Two hours old: both folder and partial file have stopped updating.
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    utimesSync(staleFile, old, old)
    utimesSync(stale, old, old)
    // Simulate Windows NTFS where folder mtime stays old while installer.exe keeps updating.
    utimesSync(slowLive, old, old)
    // The pair this sweep must not touch.
    writeFileSync(path.join(directory, 'installer.exe'), 'verified', 'utf8')

    clearStaleDownloads(directory)

    assert.equal(existsSync(stale), false, 'the killed download left its staging folder behind')
    assert.equal(existsSync(live), true, 'a download still running had its staging folder swept')
    assert.equal(existsSync(slowLive), true, 'a slow download with a fresh installer.exe mtime must not be swept')
    assert.equal(existsSync(path.join(directory, 'installer.exe')), true, 'the sweep ate the verified installer')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('concurrent downloadAppInstaller calls serialize via lock and reuse the verified cache', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-app-update-concurrent-'))
  try {
    const { fetcher, calls } = downloadFixture()
    const slowFetcher: typeof fetch = async (url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 25))
      return fetcher(url, init)
    }
    const [first, second] = await Promise.all([
      downloadAppInstaller(updateVersion, downloadOptions(directory, slowFetcher)),
      downloadAppInstaller(updateVersion, downloadOptions(directory, slowFetcher))
    ])
    assert.equal(first, second)
    assert.equal(calls.length, 2, 'second concurrent caller must reuse the verified cache after acquiring the lock')
    assert.deepEqual(await readdir(directory), ['installer.exe', 'installer.json'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
