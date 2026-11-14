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
  tsbuildinfo: 'json',
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
  if (Object.hasOwn(BY_NAME, lower)) return BY_NAME[lower]
  const dot = lower.lastIndexOf('.')
  if (dot === -1) return 'plain'
  const extension = lower.slice(dot + 1)
  return Object.hasOwn(BY_EXTENSION, extension) ? BY_EXTENSION[extension] : 'plain'
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
  const extension = lower.slice(dot + 1)
  return Object.hasOwn(LANGUAGE_BY_EXTENSION, extension) ? LANGUAGE_BY_EXTENSION[extension] : ''
}
