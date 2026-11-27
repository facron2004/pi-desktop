import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { app, BrowserWindow, ipcMain } from 'electron'
import { registerIpc } from '../src/main/ipc'
import type { IpcContext } from '../src/main/ipc'
import { piVersion } from '../src/main/pi/cli'
import {
  activatePiCliOverlay,
  isPiCliOverlayVersion,
  piCliOverlayEntry,
  piCliOverlaySite,
  readPiCliOverlay
} from '../src/main/pi/cli-overlay'
import { findBundledCli, forgetPiLaunchCache, resolvePiLaunch } from '../src/main/pi/locate'
import type { PiCliUpgradeProgress, UpgradeResult } from '../src/shared/types'

/**
 * The bundled CLI is a component the app owns, and an installed build must be
 * able to keep it current without shipping a new Pi Desktop. Two rules follow:
 * the packaged check asks the registry instead of answering "current" from its
 * own files, and an upgrade lands in the app's data folder — never in
 * `app.asar.unpacked`, where npm would reify the tree and remove packages the
 * app itself loads.
 */

const PACKAGE_NAME = '@earendil-works/pi-coding-agent'

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

function writeCliSite(site: string, version: string): string {
  const dir = path.join(site, 'node_modules', '@earendil-works', 'pi-coding-agent')
  mkdirSync(path.join(dir, 'dist', 'bundle'), { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version }))
  const cli = path.join(dir, 'dist', 'bundle', 'cli.js')
  writeFileSync(cli, `console.log(${JSON.stringify(version)})\n`)
  return cli
}

function installOverlay(version: string): string {
  const site = piCliOverlaySite(version)
  const entry = writeCliSite(site, version)
  activatePiCliOverlay(version)
  return entry
}

/** A registry that answers one published version, without the network. */
function stubRegistry(version: string): { calls: () => number; restore: () => void } {
  const descriptor = Object.getOwnPropertyDescriptor(https, 'get')
  const packument = JSON.stringify({
    name: PACKAGE_NAME,
    'dist-tags': { latest: version },
    versions: { [version]: { name: PACKAGE_NAME, version } }
  })
  let calls = 0
  Object.defineProperty(https, 'get', {
    configurable: true,
    value: (
      _url: string,
      _options: unknown,
      callback: (response: EventEmitter & Record<string, unknown>) => void
    ) => {
      calls += 1
      const request = new EventEmitter() as EventEmitter & {
        setTimeout: () => void
        destroy: () => void
      }
      request.setTimeout = () => {}
      request.destroy = () => {}
      const response = new EventEmitter() as EventEmitter & Record<string, unknown>
      response.statusCode = 200
      response.setEncoding = () => {}
      response.resume = () => {}
      process.nextTick(() => {
        callback(response)
        process.nextTick(() => {
          response.emit('data', packument)
          response.emit('end')
        })
      })
      return request
    }
  })
  syncBuiltinESMExports()
  return {
    calls: () => calls,
    restore: () => {
      if (descriptor) Object.defineProperty(https, 'get', descriptor)
      else Reflect.deleteProperty(https, 'get')
      syncBuiltinESMExports()
    }
  }
}

/** An npm that writes the package tree the upgrade would have downloaded. */
function fakeNpm(version: string, failure?: 'install' | 'probe'): string {
  const directory = tempDir('pi-cli-fake-npm-')
  const script = path.join(directory, 'fake-npm.mjs')
  const cli = failure === 'probe' ? 'process.exit(1)\n' : `console.log(${JSON.stringify(version)})\n`
  writeFileSync(
    script,
    [
      "import { mkdirSync, writeFileSync } from 'node:fs'",
      "import path from 'node:path'",
      `const version = ${JSON.stringify(version)}`,
      'const root = process.cwd()',
      'if (!process.argv.includes(`--prefix=${root}`) || !process.argv.includes("--global=false")) {',
      '  throw new Error(`Expected npm to install locally in ${root}`)',
      '}',
      "const dir = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent')",
      "mkdirSync(path.join(dir, 'dist', 'bundle'), { recursive: true })",
      "writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version }))",
      `writeFileSync(path.join(dir, 'dist', 'bundle', 'cli.js'), ${JSON.stringify(cli)})`,
      failure === 'install' ? 'process.exitCode = 1' : ''
    ].join('\n')
  )
  if (process.platform === 'win32') {
    writeFileSync(
      path.join(directory, 'npm.cmd'),
      `@echo off\r\n"${process.execPath}" "%~dp0fake-npm.mjs" %*\r\n`
    )
  } else {
    const wrapper = path.join(directory, 'npm')
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
    chmodSync(wrapper, 0o755)
  }
  return directory
}

function rememberPath(): () => void {
  const previous = process.env.PATH
  return () => {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
  }
}

function rememberPackaged(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(app, 'isPackaged')
  Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
  return () => {
    if (descriptor) Object.defineProperty(app, 'isPackaged', descriptor)
    else Reflect.deleteProperty(app, 'isPackaged')
  }
}

test('a packaged build checks the bundled CLI against the registry', async (t) => {
  const userData = tempDir('pi-cli-packaged-check-')
  const registry = stubRegistry('99.0.0')
  const restorePackaged = rememberPackaged()
  t.after(() => {
    registry.restore()
    restorePackaged()
    rmSync(userData, { recursive: true, force: true })
  })
  t.mock.method(app, 'getPath', () => userData)
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  t.mock.method(ipcMain, 'handle', (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
    handlers.set(channel, handler)
  })
  forgetPiLaunchCache()
  registerIpc({
    supervisor: {},
    settings: { get: () => ({ workspaces: [] }) },
    getWindow: () => null,
    terminals: { create: () => ({}) },
    memory: { promptFor: () => '' }
  } as unknown as IpcContext)
  const check = handlers.get('app:checkPiCliUpdate')
  assert.ok(check, 'app:checkPiCliUpdate handler was registered')
  const current = (await piVersion()) || '1.4.0'
  assert.deepEqual(await check({}), { current, latest: '99.0.0', hasUpdate: true })
  assert.equal(registry.calls(), 1, 'the packaged build must ask the registry, not answer from its own files')
})

function packagedUpgrade(
  t: TestContext, prepare: () => Promise<boolean> = async () => true,
  onProgress?: (progress: PiCliUpgradeProgress) => void
) {
  const userData = tempDir('pi cli packaged install-')
  const registry = stubRegistry('9.9.9')
  const restorePackaged = rememberPackaged()
  const restorePath = rememberPath()
  t.after(() => {
    registry.restore()
    restorePackaged()
    restorePath()
    rmSync(userData, { recursive: true, force: true })
  })
  t.mock.method(app, 'getPath', () => userData)
  const fromWebContents = Object.getOwnPropertyDescriptor(BrowserWindow, 'fromWebContents')
  Object.defineProperty(BrowserWindow, 'fromWebContents', {
    configurable: true,
    value: () => ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (_channel: string, progress: PiCliUpgradeProgress) => onProgress?.(progress) }
    })
  })
  t.after(() => {
    if (fromWebContents) Object.defineProperty(BrowserWindow, 'fromWebContents', fromWebContents)
    else Reflect.deleteProperty(BrowserWindow, 'fromWebContents')
  })
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  t.mock.method(ipcMain, 'handle', (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
    handlers.set(channel, handler)
  })
  let finished = 0
  forgetPiLaunchCache()
  registerIpc({
    supervisor: {
      prepareForCliUpgrade: prepare,
      finishCliUpgrade: () => {
        finished += 1
      }
    },
    settings: { get: () => ({ workspaces: [] }) },
    getWindow: () => null,
    terminals: { create: () => ({}) },
    memory: { promptFor: () => '' }
  } as unknown as IpcContext)

  const upgrade = handlers.get('app:upgradePiCli')
  assert.ok(upgrade, 'app:upgradePiCli handler was registered')
  return { upgrade: () => upgrade({ sender: {} }) as Promise<UpgradeResult>, finished: () => finished }
}

test('a packaged upgrade installs into the app data folder and launches that copy', async (t) => {
  let ready = false
  const { upgrade, finished } = packagedUpgrade(t, async () => ready)
  const fake = fakeNpm('9.9.9')
  t.after(() => rmSync(fake, { recursive: true, force: true }))
  process.env.PATH = fake
  // An older overlay is still on disk; a newer installation must leave only
  // the copy the record names.
  installOverlay('1.0.0')
  assert.deepEqual(await upgrade(), {
    success: false, error: 'Finish or stop active Pi work before upgrading the CLI.'
  })
  assert.equal(readPiCliOverlay()?.version, '1.0.0')
  assert.equal(finished(), 0)
  process.env.PATH = ''
  ready = true
  const result = await upgrade()
  assert.deepEqual(result, { success: true, version: '9.9.9' })
  assert.equal(finished(), 1, 'CLI maintenance is released on success')
  assert.equal(existsSync(piCliOverlaySite('1.0.0')), false, 'an older overlay is pruned')

  const overlay = readPiCliOverlay()
  assert.ok(overlay, 'the installed CLI is named by the app data record')
  assert.equal(overlay.version, '9.9.9')
  assert.equal(overlay.entry, piCliOverlayEntry(piCliOverlaySite('9.9.9')))
  assert.ok(existsSync(path.join(piCliOverlaySite('9.9.9'), 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json')))

  // The launch resolves to the overlay, and the About page's fast version read
  // follows the same record rather than the CLI that shipped with the app.
  assert.equal(findBundledCli(), overlay.entry)
  const launch = resolvePiLaunch()
  assert.equal(launch.source, 'bundled')
  assert.deepEqual(launch.prefixArgs, [overlay.entry])
  assert.equal(await piVersion(), '9.9.9')

  // A second click reuses the verified tree instead of downloading it again:
  // npm is gone from PATH, and the upgrade still succeeds.
  const reapplied = await upgrade()
  assert.deepEqual(reapplied, { success: true, version: '9.9.9' })
  assert.equal(finished(), 2)
  assert.equal(JSON.parse(readFileSync(path.join(piCliOverlaySite('9.9.9'), 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8')).version, '9.9.9')
})

for (const failure of ['install', 'probe'] as const) {
  test(`a failed ${failure} preserves the active CLI and downloads a fresh candidate on retry`, async (t) => {
    const { upgrade, finished } = packagedUpgrade(t)
    const active = installOverlay('8.8.8')
    const brokenNpm = fakeNpm('9.9.9', failure)
    const workingNpm = fakeNpm('9.9.9')
    t.after(() => {
      rmSync(brokenNpm, { recursive: true, force: true })
      rmSync(workingNpm, { recursive: true, force: true })
    })
    process.env.PATH = brokenNpm
    const failed = await upgrade()
    assert.equal(failed.success, false)
    assert.match(failed.error ?? '', failure === 'install' ? /npm install exited/ : /could not start/)
    assert.equal(finished(), 0)
    assert.equal(findBundledCli(), active)
    assert.equal(existsSync(piCliOverlaySite('9.9.9')), false)

    process.env.PATH = workingNpm
    assert.deepEqual(await upgrade(), { success: true, version: '9.9.9' })
    assert.equal(await piVersion(), '9.9.9')
  })
}

test('an unverified candidate from a previous launch is installed again', async (t) => {
  const { upgrade } = packagedUpgrade(t)
  const fake = fakeNpm('9.9.9')
  t.after(() => rmSync(fake, { recursive: true, force: true }))
  process.env.PATH = fake
  const entry = writeCliSite(piCliOverlaySite('9.9.9'), '9.9.9')
  const leftover = "console.log('9.9.9') // leftover from an interrupted install\n"
  writeFileSync(entry, leftover)

  assert.deepEqual(await upgrade(), { success: true, version: '9.9.9' })
  assert.notEqual(readFileSync(entry, 'utf8'), leftover)
})

test('a failed probe of the active version leaves its files and selection intact', async (t) => {
  const { upgrade, finished } = packagedUpgrade(t)
  const entry = installOverlay('9.9.9')
  writeFileSync(entry, 'process.exit(1)\n')
  process.env.PATH = ''

  assert.deepEqual(await upgrade(), {
    success: false, error: 'The bundled Pi CLI could not start after installation.'
  })
  assert.equal(finished(), 0)
  assert.equal(readPiCliOverlay()?.entry, entry)
  assert.equal(readFileSync(entry, 'utf8'), 'process.exit(1)\n')
})

test('reinstalling a missing active version keeps the shipped CLI selected until validation', async (t) => {
  const selectedBeforeProbe: (string | null)[] = []
  const { upgrade } = packagedUpgrade(t, undefined, (progress) => {
    if (progress.stage === 'installing' && progress.percent === 99) selectedBeforeProbe.push(findBundledCli())
  })
  const entry = installOverlay('9.9.9')
  rmSync(entry)
  const shipped = findBundledCli()
  assert.ok(shipped)
  const fake = fakeNpm('9.9.9')
  t.after(() => rmSync(fake, { recursive: true, force: true }))
  process.env.PATH = fake

  assert.deepEqual(await upgrade(), { success: true, version: '9.9.9' })
  assert.deepEqual(selectedBeforeProbe, [shipped])
  assert.equal(findBundledCli(), entry)
})

test('an installed overlay wins only while it is newer than the shipped CLI', (t) => {
  const userData = tempDir('pi-cli-overlay-preference-')
  const restorePackaged = rememberPackaged()
  t.after(() => {
    restorePackaged()
    rmSync(userData, { recursive: true, force: true })
  })
  t.mock.method(app, 'getPath', () => userData)
  forgetPiLaunchCache()

  const shipped = findBundledCli()
  assert.ok(shipped, 'the checkout must carry the bundled CLI for this suite to run')
  assert.match(shipped, /pi-coding-agent/)

  const newer = installOverlay('99.0.0')
  assert.equal(readPiCliOverlay()?.version, '99.0.0')
  assert.equal(findBundledCli(), newer)

  // A release can bring a newer agent than the one the reader installed; the
  // shipped copy is the right one again and the older overlay is ignored.
  installOverlay('0.0.1')
  assert.equal(findBundledCli(), shipped)

  // A record is a version, not a path: anything that is not one reads as no
  // overlay at all, so an edited record cannot name another executable.
  writeFileSync(path.join(userData, 'pi-cli', 'current.json'), JSON.stringify({ version: '../../evil' }))
  assert.equal(readPiCliOverlay(), undefined)
  assert.equal(findBundledCli(), shipped)
  assert.equal(isPiCliOverlayVersion('../../evil'), false)

  // A valid record whose files are gone is not an installation either.
  installOverlay('99.0.0')
  rmSync(newer, { force: true })
  assert.equal(readPiCliOverlay(), undefined)
  assert.equal(findBundledCli(), shipped)

  // A development checkout never uses a packaged app's overlay.
  installOverlay('99.0.0')
  Object.defineProperty(app, 'isPackaged', { configurable: true, value: false })
  assert.equal(findBundledCli(), shipped)
})
