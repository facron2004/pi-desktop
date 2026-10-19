/** Visual grouping for file names, used to tint the tree and search results. */
export type FileTone = 'ts' | 'js' | 'json' | 'style' | 'markdown' | 'shell' | 'image' | 'plain'

const BY_EXTENSION: Record<string, FileTone> = {
  ts: 'ts',
  tsx: 'ts',
  mts: 'ts',
  cts: 'ts',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  json: 'json',
  jsonc: 'json',
  css: 'style',
  scss: 'style',
  sass: 'style',
  less: 'style',
  html: 'style',
  vue: 'style',
  svelte: 'style',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  txt: 'plain',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'shell',
  bat: 'shell',
  cmd: 'shell',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  ico: 'image'
}

const BY_NAME: Record<string, FileTone> = {
  dockerfile: 'shell',
  makefile: 'shell',
  license: 'plain',
  readme: 'markdown'
}

export function fileTone(name: string): FileTone {
  const lower = name.toLowerCase()
  const byName = BY_NAME[lower]
  if (byName) return byName
  const dot = lower.lastIndexOf('.')
  if (dot === -1) return 'plain'
  return BY_EXTENSION[lower.slice(dot + 1)] ?? 'plain'
}

/** The grammar a file is highlighted with, guessed from its name. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'html',
  vue: 'vue',
  svelte: 'svelte',
  xml: 'xml',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  php: 'php',
  cs: 'csharp',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  sql: 'sql',
  lua: 'lua',
  dockerfile: 'dockerfile'
}

/** The grammar for a file, or an empty string when there is none. */
export function languageOf(name: string): string {
  const lower = name.toLowerCase()
  if (lower === 'dockerfile') return 'dockerfile'
  const dot = lower.lastIndexOf('.')
  if (dot === -1) return ''
  return LANGUAGE_BY_EXTENSION[lower.slice(dot + 1)] ?? ''
}
