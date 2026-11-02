import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const cache = new Map<string, string>()

/**
 * Where each setting's program actually lives, so the menu can show that
 * program's own icon instead of a drawn stand-in.
 */
function candidates(id: string): string[] {
  const local = process.env.LOCALAPPDATA ?? ''
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const win = process.env.SystemRoot ?? 'C:\\Windows'
  const sys = path.join(win, 'System32')
  switch (id) {
    case 'vscode':
      return [
        path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'),
        path.join(pf, 'Microsoft VS Code', 'Code.exe'),
        path.join(pf86, 'Microsoft VS Code', 'Code.exe')
      ]
    case 'cursor':
      return [
        path.join(local, 'Programs', 'cursor', 'Cursor.exe'),
        path.join(local, 'Programs', 'Cursor', 'Cursor.exe'),
        path.join(pf, 'cursor', 'Cursor.exe')
      ]
    case 'windsurf':
      return [
        path.join(local, 'Programs', 'Windsurf', 'Windsurf.exe'),
        path.join(pf, 'Windsurf', 'Windsurf.exe')
      ]
    case 'system':
      return [path.join(sys, 'openwith.exe')]
    case 'windows':
      return [path.join(sys, 'winver.exe')]
    case 'wsl':
      return [path.join(sys, 'wsl.exe')]
    case 'powershell':
      return [path.join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe')]
    case 'cmd':
      return [path.join(sys, 'cmd.exe')]
    case 'gitbash':
      return [
        // Git for Windows ships its own logo as an .ico; the launcher exe
        // reports only the generic console icon through the shell.
        path.join(pf, 'Git', 'mingw64', 'share', 'git', 'git-for-windows.ico'),
        path.join(pf86, 'Git', 'mingw64', 'share', 'git', 'git-for-windows.ico'),
        path.join(pf, 'Git', 'git-bash.exe'),
        path.join(pf86, 'Git', 'git-bash.exe'),
        path.join(pf, 'Git', 'bin', 'bash.exe')
      ]
    default:
      return []
  }
}

async function whereExe(name: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('where.exe', [name], { windowsHide: true })
    const lines = stdout
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter((item) => item && existsSync(item))
    // `where cursor` lists the extensionless shell script before the .cmd
    // launcher; the script has no program icon, so start with a real .exe and
    // fall back to the launcher file the caller knows how to resolve.
    const withExtension = (ext: string): string | undefined =>
      lines.find((item) => item.toLowerCase().endsWith(ext))
    return (
      withExtension('.exe') ??
      withExtension('.cmd') ??
      withExtension('.bat') ??
      lines[0]
    )
  } catch {
    return undefined
  }
}

/**
 * A .cmd launcher is not the program.
 *
 * Some editors (Cursor among them) put a `cursor.cmd` on PATH and keep the
 * real `Cursor.exe` beside the install folder. Asking the shell for the icon
 * of a .cmd returns the generic script icon, which is exactly the wrong
 * answer. The launcher names its executable (`%~dp0..\..\..\Cursor.exe`), so
 * follow that path instead.
 */
function exeFromLauncher(file: string): string | undefined {
  try {
    const text = readFileSync(file, 'utf8')
    const match = /"([^"\r\n]+\.exe)"/i.exec(text) ?? /([^\s"']+\.exe)/i.exec(text)
    if (!match) return undefined
    const raw = match[1].replace(/%~dp0/gi, `${path.dirname(file)}${path.sep}`)
    const resolved = path.resolve(path.dirname(file), raw)
    return existsSync(resolved) ? resolved : undefined
  } catch {
    return undefined
  }
}

/**
 * An .ico file can carry a PNG frame. Electron's file-icon lookup treats the
 * .ico as a document and returns a blank page, so read the frame directly:
 * the largest PNG entry is the icon Git for Windows ships.
 */
function pngFromIco(file: string): string | undefined {
  try {
    const data = readFileSync(file)
    if (data.length < 6 || data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1) return undefined
    const count = data.readUInt16LE(4)
    let best: { size: number; offset: number; length: number } | undefined
    for (let index = 0; index < count; index += 1) {
      const entry = 6 + index * 16
      const width = data[entry] === 0 ? 256 : data[entry]
      const length = data.readUInt32LE(entry + 8)
      const offset = data.readUInt32LE(entry + 12)
      if (
        offset + length <= data.length &&
        data.readUInt32LE(offset) === 0x474e5089 // PNG signature
      ) {
        if (!best || width > best.size) best = { size: width, offset, length }
      }
    }
    if (!best) return undefined
    return `data:image/png;base64,${data.subarray(best.offset, best.offset + best.length).toString('base64')}`
  } catch {
    return undefined
  }
}

async function iconFor(id: string): Promise<string | undefined> {
  const cached = cache.get(id)
  if (cached) return cached
  let file = candidates(id).find((item) => existsSync(item))
  if (!file && (id === 'vscode' || id === 'cursor' || id === 'windsurf')) {
    file = await whereExe(id === 'vscode' ? 'code' : id)
  }
  if (!file) return undefined
  if (/\.ico$/i.test(file)) {
    const fromIco = pngFromIco(file)
    if (fromIco) {
      cache.set(id, fromIco)
      return fromIco
    }
  }
  if (/\.(cmd|bat)$/i.test(file)) file = exeFromLauncher(file) ?? file
  try {
    // `normal` is 32×32: the menu draws it at 14 CSS px, so the larger source
    // stays sharp on a 150% display instead of the 16px `small` icon.
    const image = await app.getFileIcon(file, { size: 'normal' })
    if (image.isEmpty()) return undefined
    const url = image.toDataURL()
    cache.set(id, url)
    return url
  } catch {
    return undefined
  }
}

const IDS = ['vscode', 'cursor', 'windsurf', 'system', 'windows', 'wsl', 'powershell', 'cmd', 'gitbash']

/** Data URLs of the installed programs' own icons. Missing programs are omitted. */
export async function nativeAppIcons(): Promise<Record<string, string>> {
  const entries = await Promise.all(
    IDS.map(async (id) => [id, await iconFor(id)] as const)
  )
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry[1])))
}
