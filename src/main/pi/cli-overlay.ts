import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * A newer copy of the bundled Pi CLI, installed beside the app's own data.
 *
 * `app.asar.unpacked` cannot be the target of an in-place upgrade: npm reifies
 * the folder it is given, and the app's unpacked `node_modules` also holds
 * packages the app itself needs (`node-pty` and its native binary, `jiti`,
 * `quickjs-wasi`) which the CLI package does not declare. Installing there
 * removed them, and a portable copy may not be writable at all. So a packaged
 * app installs the CLI into its own data folder and launches that copy instead:
 * the shipped files stay exactly as the installer verified them.
 *
 * The record is a version, not a path. The entry is always derived from it
 * under this folder, so a tampered record cannot point the app at an executable
 * elsewhere, and a stale version whose files have been removed reads as "no
 * overlay" and falls back to the CLI the app ships.
 */

export const PI_CLI_PACKAGE_NAME = '@earendil-works/pi-coding-agent'

const PACKAGE_RELATIVE = path.join('node_modules', '@earendil-works', 'pi-coding-agent')
const ENTRY_RELATIVE = path.join(PACKAGE_RELATIVE, 'dist', 'bundle', 'cli.js')

/** A version that can name a folder. Prereleases are allowed; paths are not. */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/

export interface PiCliOverlay {
  version: string
  entry: string
}

export function isPiCliOverlayVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION.test(value)
}

/** Where a packaged app keeps the CLI it installed for itself. */
export function piCliOverlayRoot(): string {
  return path.join(app.getPath('userData'), 'pi-cli')
}

/** The installation folder for one version. The caller owns its contents. */
export function piCliOverlaySite(version: string): string {
  if (!isPiCliOverlayVersion(version)) throw new Error('Invalid Pi CLI version')
  return path.join(piCliOverlayRoot(), 'installed', version)
}

/** The CLI entry inside an installation folder. */
export function piCliOverlayEntry(site: string): string {
  return path.join(site, ENTRY_RELATIVE)
}

function recordFile(): string {
  return path.join(piCliOverlayRoot(), 'current.json')
}

/** The version in a CLI package folder, when that folder names this package. */
function readPiCliPackageVersion(packageDir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
      name?: unknown
      version?: unknown
    }
    if (parsed.name === PI_CLI_PACKAGE_NAME && isPiCliOverlayVersion(parsed.version)) {
      return parsed.version
    }
  } catch {
    /* a missing or unreadable manifest is "not installed", not an error */
  }
  return undefined
}

/** The version in an installed CLI package folder. */
export function piCliVersionAtEntry(entry: string): string | undefined {
  return readPiCliPackageVersion(path.resolve(path.dirname(entry), '..', '..'))
}

function readRecordedVersion(): string | undefined {
  try {
    const record = JSON.parse(readFileSync(recordFile(), 'utf8')) as { version?: unknown } | null
    const version = record?.version
    return isPiCliOverlayVersion(version) ? version : undefined
  } catch {
    return undefined
  }
}

/**
 * The active overlay, if its files are still there.
 *
 * Every answer is derived from the record's version, and a version is checked
 * against the package it names, so a half-copied tree or an edited record never
 * becomes the executable the app launches.
 */
export function readPiCliOverlay(): PiCliOverlay | undefined {
  const version = readRecordedVersion()
  if (!version) return undefined
  const site = piCliOverlaySite(version)
  const entry = piCliOverlayEntry(site)
  if (!existsSync(entry)) return undefined
  if (piCliVersionAtEntry(entry) !== version) return undefined
  return { version, entry }
}

/** Keep the shipped CLI selected while a missing or incomplete overlay is reinstalled. */
export function clearUnavailablePiCliOverlay(version: string): void {
  if (readRecordedVersion() === version && !readPiCliOverlay()) {
    rmSync(recordFile(), { force: true })
  }
}

/**
 * Make an installed overlay the copy the app launches.
 *
 * The record is written beside itself and renamed into place: a process killed
 * mid-write leaves the previous reading, never half a JSON document.
 */
export function activatePiCliOverlay(version: string): PiCliOverlay {
  const site = piCliOverlaySite(version)
  const entry = piCliOverlayEntry(site)
  const root = piCliOverlayRoot()
  mkdirSync(root, { recursive: true })
  const target = recordFile()
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ version, installedAt: Date.now() }), 'utf8')
  renameSync(temporary, target)
  return { version, entry }
}

/** Remove one installation folder. */
export function removePiCliOverlaySite(version: string): void {
  if (!isPiCliOverlayVersion(version)) return
  try {
    rmSync(piCliOverlaySite(version), { recursive: true, force: true })
  } catch {
    /* a file may still be mapped by a process that is exiting; retry later */
  }
}

/**
 * Delete the installations that are not the active one.
 *
 * A successful upgrade makes every older copy unreachable — the record names
 * the version the app launches — and each copy is a full npm tree.
 */
export function prunePiCliOverlaySites(keep: string): void {
  const installed = path.join(piCliOverlayRoot(), 'installed')
  let names: string[]
  try {
    names = readdirSync(installed)
  } catch {
    return
  }
  for (const name of names) {
    if (name === keep || !isPiCliOverlayVersion(name)) continue
    removePiCliOverlaySite(name)
  }
}
