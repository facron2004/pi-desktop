import { exec, execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

let fontsRequest: Promise<string[]> | null = null

const FALLBACK_FONTS = [
  'Arial',
  'Cascadia Code',
  'Consolas',
  'DengXian',
  'Fira Code',
  'Helvetica Neue',
  'Inter',
  'JetBrains Mono',
  'KaiTi',
  'Microsoft YaHei',
  'Microsoft YaHei UI',
  'PingFang SC',
  'Roboto',
  'Segoe UI',
  'SimHei',
  'SimSun',
  'Source Code Pro'
]

function execAsync(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    exec(cmd, (err, stdout) => {
      if (err) return resolve('')
      resolve(typeof stdout === 'string' ? stdout : '')
    })
  })
}

async function queryWindowsFonts(): Promise<string[]> {
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
  ]
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-desktop-fonts-'))
  try {
    // Registry exports are UTF-16; querying through a console depends on its
    // code page, and starting chcp just to preserve Chinese names is slow.
    const outputs = await Promise.all(
      keys.map(async (key, index) => {
        const file = path.join(directory, `${index}.reg`)
        const exported = await new Promise<boolean>((resolve) => {
          execFile('reg.exe', ['export', key, file, '/y'], {
            windowsHide: true,
            timeout: 5000
          }, (error) => resolve(!error))
        })
        return exported ? readFile(file, 'utf16le') : ''
      })
    )
    return parseWindowsFontRegistry(outputs.join('\n'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export function parseWindowsFontRegistry(output: string): string[] {
  const names = new Set<string>()
  const weightRegex =
    /\s+(Regular|Bold|Italic|Light|Medium|Semibold|SemiBold|SemiLight|Semilight|Black|ExtraBold|ExtraLight|Thin|Heavy|Oblique)(\s+.*)?$/i
  const cnWeightRegex = /\s*(常规体|粗体|中黑体|细体|特粗|极细|中等|半粗|纤细|常规|加粗|粗|细)$/

  let inFontsKey = false
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('[')) {
      // Exports also include metadata subkeys, whose values are file names.
      inFontsKey = /^\[HKEY_(LOCAL_MACHINE|CURRENT_USER)\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts\]$/i.test(line)
      continue
    }
    if (!inFontsKey) continue
    const match = line.match(/^"((?:\\.|[^"\\])*)"=/)
    if (!match) continue
    const rawName = match[1]
      .replace(/\\(["\\])/g, '$1')
      .replace(/\s*\((TrueType|OpenType)\)$/i, '').trim()
    for (const part of rawName.split('&')) {
      const name = part.trim()
      const family = PINGFANG_ALIAS.test(name)
        ? name
        : name.replace(weightRegex, '').replace(cnWeightRegex, '').trim()
      if (family && !family.startsWith('@')) {
        names.add(family)
      }
    }
  }

  return canonicalizeFontFamilies(names)
}

async function queryMacFonts(): Promise<string[]> {
  const dirs = [
    '/System/Library/Fonts',
    '/Library/Fonts',
    path.join(os.homedir(), 'Library/Fonts')
  ]
  const names = new Set<string>()
  for (const dir of dirs) {
    try {
      const files = readdirSync(dir)
      for (const file of files) {
        const ext = path.extname(file).toLowerCase()
        if (['.ttf', '.otf', '.ttc', '.dfont'].includes(ext)) {
          let base = path.basename(file, ext)
          if (!PINGFANG_ALIAS.test(base)) {
            base = base.replace(/[-_](Regular|Bold|Italic|Light|Medium|Semibold|Black|Thin).*/i, '').trim()
          }
          if (base && !base.startsWith('.')) {
            names.add(base)
          }
        }
      }
    } catch {
      // directory might not exist
    }
  }
  return canonicalizeFontFamilies(names)
}

async function queryLinuxFonts(): Promise<string[]> {
  const output = await execAsync('fc-list : family | sort -u')
  if (!output.trim()) return []
  const names = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    for (const part of trimmed.split(',')) {
      const fam = part.trim()
      if (fam) names.add(fam)
    }
  }
  return canonicalizeFontFamilies(names)
}

/**
 * Keep explicit Regular/Medium/Bold faces alongside the family entry so installed
 * standalone copies can be selected without relying on automatic weight matching.
 * Keep the distinct TC/HK families rather than relabeling them as SC.
 */
const PINGFANG_ALIAS = /^(?:\.?pingfang(?:[\s_-]*sc)?|苹方(?:[\s_-]*简(?:体)?)?)(?:[\s_-]*(regular|bold|light|medium|semibold|thin|heavy|常规体|粗体|中黑体|中等|细体|纤细|极细|常规))?$/i

export function canonicalizeFontFamilies(names: Iterable<string>): string[] {
  const out = new Set<string>()
  let pingfang = false
  for (const name of names) {
    const trimmed = name.trim()
    if (!trimmed) continue
    const pingfangMatch = trimmed.match(PINGFANG_ALIAS)
    if (pingfangMatch) {
      pingfang = true
      const weight = pingfangMatch[1]?.toLowerCase()
      if (weight === 'regular' || weight === '常规体' || weight === '常规') {
        out.add('PingFang SC Regular')
      } else if (weight === 'medium' || weight === '中黑体' || weight === '中等') {
        out.add('PingFang SC Medium')
      } else if (weight === 'bold' || weight === '粗体') {
        out.add('PingFang SC Bold')
      }
      continue
    }
    out.add(trimmed)
  }
  if (pingfang) out.add('PingFang SC')
  return Array.from(out).sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

export function querySystemFonts(): Promise<string[]> {
  // Also share the first scan: remounts or concurrent IPC calls must not
  // launch another pair of registry processes before the cache is ready.
  fontsRequest ??= loadSystemFonts()
  return fontsRequest
}

async function loadSystemFonts(): Promise<string[]> {
  let fonts: string[] = []
  try {
    if (process.platform === 'win32') {
      fonts = await queryWindowsFonts()
    } else if (process.platform === 'darwin') {
      fonts = await queryMacFonts()
    } else if (process.platform === 'linux') {
      fonts = await queryLinuxFonts()
    }
  } catch {
    fonts = []
  }

  if (fonts.length === 0) {
    fonts = [...FALLBACK_FONTS]
  }

  return fonts
}
