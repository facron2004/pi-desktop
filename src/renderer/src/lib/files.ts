import { languageForFilePath } from '@shared/file-languages'

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
  fish: 'shell',
  nu: 'shell',
  awk: 'shell',
  ps1: 'shell',
  psm1: 'shell',
  psd1: 'shell',
  ps1xml: 'shell',
  bat: 'shell',
  cmd: 'shell',
  btm: 'shell',
  reg: 'shell',
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
  containerfile: 'shell',
  makefile: 'shell',
  gnumakefile: 'shell',
  '.env': 'shell',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.profile': 'shell',
  '.zshrc': 'shell',
  '.zprofile': 'shell',
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

/** The grammar for a file, or an empty string when there is none. */
export function languageOf(name: string): string {
  return languageForFilePath(name)
}
