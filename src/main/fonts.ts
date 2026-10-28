import { exec } from 'node:child_process'
import { readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let cachedFonts: string[] | null = null

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

function execAsync(cmd: string, options: { shell?: string; encoding?: BufferEncoding } = {}): Promise<string> {
  return new Promise((resolve) => {
    exec(cmd, options, (err, stdout) => {
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
  const names = new Set<string>()
  const weightRegex =
    /\s+(Regular|Bold|Italic|Light|Medium|Semibold|SemiBold|SemiLight|Semilight|Black|ExtraBold|ExtraLight|Thin|Heavy|Oblique)(\s+.*)?$/i
  const cnWeightRegex = /\s*(常规体|粗体|中黑体|细体|特粗|极细|中等|半粗|纤细|常规|加粗|粗|细)$/

  const outputs = await Promise.all(
    keys.map((key) =>
      execAsync(`chcp 65001 >nul && reg query "${key}"`, {
        shell: 'cmd.exe',
        encoding: 'utf8'
      })
    )
  )

  for (const output of outputs) {
    for (const line of output.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('HKEY_')) continue
      const match = trimmed.match(/^([^\t\r\n]+?)\s+REG_/i)
      if (match) {
        let rawName = match[1].trim()
        rawName = rawName.replace(/\s*\((TrueType|OpenType)\)$/i, '').trim()
        for (const part of rawName.split('&')) {
          let fam = part.trim()
          fam = fam.replace(weightRegex, '').replace(cnWeightRegex, '').trim()
          if (fam && !fam.startsWith('@')) {
            names.add(fam)
          }
        }
      }
    }
  }

  return Array.from(names).sort((a, b) => a.localeCompare(b, 'zh-CN'))
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
          base = base.replace(/[-_](Regular|Bold|Italic|Light|Medium|Semibold|Black|Thin).*/i, '').trim()
          if (base && !base.startsWith('.')) {
            names.add(base)
          }
        }
      }
    } catch {
      // directory might not exist
    }
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b))
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
  return Array.from(names).sort((a, b) => a.localeCompare(b))
}

export async function querySystemFonts(): Promise<string[]> {
  if (cachedFonts && cachedFonts.length > 0) {
    return cachedFonts
  }

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

  cachedFonts = fonts
  return fonts
}
