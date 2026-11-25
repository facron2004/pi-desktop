import { fileBasenameLower, languageForFilePath } from '@shared/file-languages'

/** Visual grouping for file names, used to tint the tree and search results. */
export type FileTone =
  | 'ts' | 'js' | 'json' | 'style' | 'html' | 'xml' | 'vue' | 'svelte'
  | 'python' | 'rust' | 'go' | 'c' | 'cpp' | 'csharp' | 'java' | 'kotlin'
  | 'swift' | 'ruby' | 'php' | 'sql' | 'code' | 'markdown' | 'shell' | 'image' | 'plain'

// These file types have a visual treatment independent of syntax highlighting.
const BY_EXTENSION: Record<string, FileTone> = {
  tsbuildinfo: 'json',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  svg: 'image',
  ico: 'image',
  avif: 'image'
}

const BY_LANGUAGE: Record<string, FileTone> = {
  typescript: 'ts',
  tsx: 'ts',
  javascript: 'js',
  jsx: 'js',
  json: 'json',
  jsonc: 'json',
  yaml: 'json',
  toml: 'json',
  ini: 'json',
  css: 'style',
  scss: 'style',
  sass: 'style',
  less: 'style',
  stylus: 'style',
  html: 'html',
  xml: 'xml',
  vue: 'vue',
  svelte: 'svelte',
  python: 'python',
  rust: 'rust',
  go: 'go',
  c: 'c',
  cpp: 'cpp',
  csharp: 'csharp',
  java: 'java',
  kotlin: 'kotlin',
  swift: 'swift',
  ruby: 'ruby',
  php: 'php',
  sql: 'sql',
  markdown: 'markdown',
  dockerfile: 'shell',
  makefile: 'shell',
  dotenv: 'shell',
  bash: 'shell',
  fish: 'shell',
  nushell: 'shell',
  awk: 'shell',
  powershell: 'shell',
  bat: 'shell',
  reg: 'shell'
}

export function fileTone(name: string): FileTone {
  const lower = fileBasenameLower(name)
  if (lower === 'readme') return 'markdown'
  const dot = lower.lastIndexOf('.')
  const extension = dot === -1 ? '' : lower.slice(dot + 1)
  if (Object.hasOwn(BY_EXTENSION, extension)) return BY_EXTENSION[extension]

  const language = languageForFilePath(lower)
  if (Object.hasOwn(BY_LANGUAGE, language)) return BY_LANGUAGE[language]
  return language ? 'code' : 'plain'
}

/** The picture types the Images page can draw, aligned with `IMAGE_MIME` in main. */
export function isImageName(name: string): boolean {
  return fileTone(name) === 'image'
}

/** The grammar for a file, or an empty string when there is none. */
export function languageOf(name: string): string {
  return languageForFilePath(name)
}
