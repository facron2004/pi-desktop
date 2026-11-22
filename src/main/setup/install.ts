import { app, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { SetupProgress } from '@shared/setup'
import { cleanAppEnv } from './args'

const execFileAsync = promisify(execFile)

const APP_EXE = 'Pi Desktop.exe'
const MARKER = 'install.json'
const SHORTCUT = 'Pi Desktop.lnk'
const REGISTRY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PiDesktop'
const LEGACY_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\8cddbf46-9994-5396-9c61-1e6d6be69598'
]
const RETRY_DELAYS = 40
const RETRY_INTERVAL = 750

/**
 * An asar archive is one file, but the install process runs inside Electron,
 * whose patched `fs` reports it as a directory and lists the archive's
 * contents. Descending into it makes the copy try to read virtual entries and
 * fail with `ENOENT, not found in …app.asar`, which aborted every silent update
 * after the old app had already quit. The archive is copied as one opaque file.
 */
const ASAR_ARCHIVE = /\.asar$/i

interface Marker {
  version: string
  installDir: string
  installedAt: number
}

export interface InstallOptions {
  targetDir: string
  launchAfterInstall: boolean
  onProgress?: (progress: SetupProgress) => void
}

export function sourceRoot(): string {
  // A harness or a dry run can point the installer at a staged payload.
  return process.env.PI_SETUP_SOURCE ?? path.dirname(process.execPath)
}

export function defaultInstallDir(): string {
  return path.join(process.env.LOCALAPPDATA ?? app.getPath('home'), 'Programs', 'Pi Desktop')
}

/**
 * Every chosen folder receives a Pi Desktop subfolder, so picking a drive or a
 * general programs folder never scatters the app files into it. A path that
 * already names the app folder is left alone.
 */
export function installTargetFor(choice: string): string {
  const resolved = path.resolve(choice)
  return path.basename(resolved).toLowerCase() === 'pi desktop'
    ? resolved
    : path.join(resolved, 'Pi Desktop')
}

export function readMarker(directory: string): Marker | null {
  try {
    const value = JSON.parse(readFileSync(path.join(directory, MARKER), 'utf8')) as Partial<Marker>
    if (typeof value.version === 'string' && typeof value.installDir === 'string') {
      return { version: value.version, installDir: value.installDir, installedAt: Number(value.installedAt) || 0 }
    }
  } catch {
    /* not an installed copy */
  }
  return null
}

/** Where the previous copy lives, so an update does not ask again. */
export async function existingInstallDir(): Promise<string | null> {
  const candidates = [defaultInstallDir()]
  for (const directory of candidates) {
    if (readMarker(directory)) return directory
  }
  try {
    const { stdout } = await execFileAsync('reg.exe', ['query', REGISTRY_KEY])
    const match = stdout.match(/InstallLocation\s+REG_SZ\s+(.+)/i)
    if (match?.[1]?.trim()) return match[1].trim()
  } catch {
    /* no registry entry */
  }
  for (const key of LEGACY_KEYS) {
    try {
      const { stdout } = await execFileAsync('reg.exe', ['query', key])
      const match = stdout.match(/UninstallString\s+REG_SZ\s+"?([^"\r\n]+?\.exe)/i)
      if (match?.[1]) return path.dirname(match[1].trim())
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

export function isSamePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

export function validateTarget(targetDir: string): string | null {
  const target = path.resolve(targetDir)
  const source = path.resolve(sourceRoot())
  if (!target) return '请选择安装位置。'
  if (isSamePath(target, source)) return '安装位置不能是安装程序的临时目录。'
  if (target.toLowerCase().startsWith(`${source.toLowerCase()}${path.sep}`)) {
    return '安装位置不能位于安装程序临时目录内。'
  }
  if (source.toLowerCase().startsWith(`${target.toLowerCase()}${path.sep}`)) {
    return '安装位置不能包含安装程序的临时目录。'
  }
  if (path.parse(target).root === target) return '请不要直接安装到磁盘根目录。'
  if (existsSync(target)) {
    const entries = readdirSyncSafe(target)
    if (entries.length > 0 && !existsSync(path.join(target, APP_EXE)) && !existsSync(path.join(target, MARKER))) {
      return '该文件夹不是空的，请选择一个新文件夹。'
    }
  }
  return null
}

function readdirSyncSafe(directory: string): string[] {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}

interface SourceEntry {
  relative: string
  size: number
}

/**
 * Every file the install has to copy, without ever entering an asar archive.
 * Exported so the skip rule can be tested without an Electron process.
 */
export async function listSource(root: string): Promise<{ entries: SourceEntry[]; files: number }> {
  const entries: SourceEntry[] = []
  const walk = async (directory: string): Promise<void> => {
    const items = await readdir(directory, { withFileTypes: true })
    for (const item of items) {
      const absolute = path.join(directory, item.name)
      const relative = path.relative(root, absolute)
      if (ASAR_ARCHIVE.test(item.name)) {
        // One opaque file, whatever `isDirectory()` claims.
        entries.push({ relative, size: 0 })
        continue
      }
      if (item.isDirectory()) {
        await walk(absolute)
      } else if (item.isFile()) {
        entries.push({ relative, size: statSync(absolute).size })
      }
    }
  }
  await walk(root)
  return { entries, files: entries.length }
}

/** Install programs are in use while the previous copy exits; retry briefly. */
async function copyFileWhenFree(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(path.dirname(to), { recursive: true })
      await copyFile(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= RETRY_DELAYS || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw error
      await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL))
    }
  }
}

/**
 * The copy command for one payload.
 *
 * A separate process is what makes `app.asar` copyable: robocopy sees the
 * archive as the file it is, while the installer's own Electron `fs` would try
 * to walk into it. It also retries locked files itself (`/R`), which is what an
 * update over a still-exiting app needs.
 */
export function payloadCopyCommand(source: string, target: string): { file: string; args: string[] } {
  return {
    file: 'robocopy.exe',
    args: [
      source,
      target,
      '/E',
      `/R:${RETRY_DELAYS}`,
      `/W:${Math.round(RETRY_INTERVAL / 1000)}`,
      '/NP',
      '/NDL',
      '/NJH',
      '/NJS',
      '/NC',
      '/NS'
    ]
  }
}

/**
 * Copy the payload into `target`.
 *
 * On Windows robocopy does the work in a plain process; elsewhere the files are
 * copied one by one, which only has to serve the development entry point.
 * `onCopied(files, detail)` reports how far the copy has come.
 */
export async function copyPayload(options: {
  source: string
  target: string
  entries: readonly SourceEntry[]
  onCopied: (files: number, detail: string) => void
}): Promise<void> {
  const { source, target, entries, onCopied } = options
  await mkdir(target, { recursive: true })
  if (process.platform === 'win32') {
    await copyWithRobocopy(source, target, entries.length, onCopied)
    return
  }
  let copied = 0
  for (const entry of entries) {
    await copyFileWhenFree(path.join(source, entry.relative), path.join(target, entry.relative))
    copied += 1
    onCopied(copied, entry.relative)
  }
}

function copyWithRobocopy(
  source: string,
  target: string,
  files: number,
  onCopied: (files: number, detail: string) => void
): Promise<void> {
  const { file, args } = payloadCopyCommand(source, target)
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true })
    let copied = 0
    let pending = ''
    const flush = (): void => {
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const detail = line.trim()
        if (!detail) continue
        copied += 1
        onCopied(Math.min(copied, files), detail)
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      pending += chunk
      flush()
    })
    child.once('error', (error) => reject(error))
    child.once('close', (code) => {
      flush()
      // robocopy reports 0 (nothing to do) through 7 (several copies) as success.
      if (code === null || code >= 8) {
        reject(new Error(`复制安装文件失败（robocopy 返回 ${code ?? 'unknown'}）。请关闭正在运行的 Pi Desktop 后重试。`))
        return
      }
      resolve()
    })
  })
}

export async function installApp(options: InstallOptions): Promise<void> {
  const report = (progress: SetupProgress) => options.onProgress?.(progress)
  const target = path.resolve(options.targetDir)
  const source = path.resolve(sourceRoot())
  const problem = validateTarget(target)
  if (problem) throw new Error(problem)
  if (!existsSync(path.join(source, APP_EXE))) {
    throw new Error('找不到要安装的应用程序文件，请重新下载安装程序。')
  }

  report({ phase: 'copying', percent: 0, detail: '正在准备文件…' })

  const { entries, files } = await listSource(source)
  let lastPercent = -1
  let lastReport = 0
  await copyPayload({
    source,
    target,
    entries,
    onCopied: (copied, detail) => {
      const percent = files > 0 ? Math.min(99, Math.floor((copied / files) * 100)) : 50
      const now = Date.now()
      if (percent !== lastPercent && now - lastReport > 40) {
        lastPercent = percent
        lastReport = now
        report({ phase: 'copying', percent, detail })
      }
    }
  })

  report({ phase: 'shortcuts', percent: 99, detail: '正在创建快捷方式…' })
  await createShortcuts(target)
  await removeLegacyInstall(target)

  report({ phase: 'registry', percent: 99, detail: '正在注册应用…' })
  await writeRegistry(target)

  const marker: Marker = { version: app.getVersion(), installDir: target, installedAt: Date.now() }
  await writeFile(path.join(target, MARKER), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')

  report({ phase: 'finishing', percent: 100, detail: '安装完成' })
  report({ phase: 'done', percent: 100 })
}

export async function uninstallApp(targetDir: string, removeUserData: boolean): Promise<void> {
  const target = path.resolve(targetDir)
  await removeShortcuts(target)
  await deleteRegistry()
  if (removeUserData) await removeAppData()
  const script = await writeCleanupScript(target)
  const { spawn } = await import('node:child_process')
  const child = spawn('cmd.exe', ['/c', script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()
}

function shortcutPaths(): { desktop: string; startMenu: string; startMenuFolder: string } {
  const desktop = path.join(app.getPath('desktop'), SHORTCUT)
  const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  return {
    desktop,
    startMenu: path.join(programs, SHORTCUT),
    startMenuFolder: path.join(programs, 'Pi Desktop', SHORTCUT)
  }
}

async function createShortcuts(targetDir: string): Promise<void> {
  const exe = path.join(targetDir, APP_EXE)
  const links = shortcutPaths()
  const details = {
    target: exe,
    cwd: targetDir,
    description: 'Pi Desktop',
    icon: exe,
    iconIndex: 0,
    appUserModelId: 'dev.pi.desktop.v3'
  }
  shell.writeShortcutLink(links.desktop, 'create', details)
  shell.writeShortcutLink(links.startMenu, 'create', details)
  // A previous installer kept its shortcut inside a folder of the same name.
  shell.writeShortcutLink(links.startMenuFolder, 'create', details)
}

async function removeShortcuts(targetDir: string): Promise<void> {
  const links = shortcutPaths()
  for (const link of [links.desktop, links.startMenu, links.startMenuFolder]) {
    try {
      if (!existsSync(link)) continue
      const details = shell.readShortcutLink(link)
      if (isSamePath(path.dirname(details.target), targetDir)) await rm(link, { force: true })
    } catch {
      await rm(link, { force: true }).catch(() => undefined)
    }
  }
}

async function writeRegistry(targetDir: string): Promise<void> {
  const exe = path.join(targetDir, APP_EXE)
  const values: [string, string, 'REG_SZ' | 'REG_DWORD'][] = [
    ['DisplayName', `Pi Desktop ${app.getVersion()}`, 'REG_SZ'],
    ['DisplayVersion', app.getVersion(), 'REG_SZ'],
    ['Publisher', 'Facron', 'REG_SZ'],
    ['InstallLocation', targetDir, 'REG_SZ'],
    ['DisplayIcon', `${exe},0`, 'REG_SZ'],
    ['UninstallString', `"${exe}" --uninstall`, 'REG_SZ'],
    ['QuietUninstallString', `"${exe}" --uninstall --silent`, 'REG_SZ'],
    ['NoModify', '1', 'REG_DWORD'],
    ['NoRepair', '1', 'REG_DWORD']
  ]
  for (const [name, value, type] of values) {
    await execFileAsync('reg.exe', ['add', REGISTRY_KEY, '/v', name, '/t', type, '/d', value, '/f'])
  }
}

async function deleteRegistry(): Promise<void> {
  for (const key of [REGISTRY_KEY, ...LEGACY_KEYS]) {
    await execFileAsync('reg.exe', ['delete', key, '/f']).catch(() => undefined)
  }
}

async function removeLegacyInstall(targetDir: string): Promise<void> {
  // The old NSIS build shipped an uninstaller that would delete files our own
  // uninstaller is responsible for. Its registry entry is removed as well.
  await rm(path.join(targetDir, 'Uninstall Pi Desktop.exe'), { force: true }).catch(() => undefined)
  for (const key of LEGACY_KEYS) {
    await execFileAsync('reg.exe', ['delete', key, '/f']).catch(() => undefined)
  }
}

async function removeAppData(): Promise<void> {
  const roaming = path.join(app.getPath('appData'), 'Pi Desktop')
  const local = path.join(process.env.LOCALAPPDATA ?? app.getPath('home'), 'Pi Desktop')
  await rm(roaming, { recursive: true, force: true }).catch(() => undefined)
  await rm(local, { recursive: true, force: true }).catch(() => undefined)
}

async function writeCleanupScript(targetDir: string): Promise<string> {
  const file = path.join(os.tmpdir(), `pi-desktop-uninstall-${Date.now()}.cmd`)
  const exe = path.join(targetDir, APP_EXE)
  const content = [
    '@echo off',
    'setlocal',
    'set /a tries=0',
    ':wait',
    'set /a tries+=1',
    `if not exist "${exe}" goto remove`,
    'if %tries% GEQ 120 goto remove',
    'timeout /t 1 /nobreak >nul',
    'goto wait',
    ':remove',
    `rmdir /s /q "${targetDir}"`,
    'del /f /q "%~f0"'
  ].join('\r\n')
  await writeFile(file, content, 'utf8')
  return file
}

export function launchInstalled(targetDir: string, args: string[] = []): void {
  const exe = path.join(targetDir, APP_EXE)
  const child = spawn(exe, args, {
    cwd: targetDir,
    env: cleanAppEnv(),
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  })
  child.unref()
}

export async function revealFolder(directory: string): Promise<void> {
  await shell.openPath(directory)
}

export function readInstalledVersion(targetDir: string): string | null {
  return readMarker(targetDir)?.version ?? null
}
