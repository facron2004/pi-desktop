/**
 * Shared filename-to-language detection for both main (`fs:read`) and renderer
 * (`files.ts`, `highlight.ts`), so code snippets, file viewers, and tool panels
 * classify extensions, dotfiles, and extensionless scripts identically.
 */

const LANGUAGE_BY_EXT: Record<string, string> = {
  // PowerShell
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  ps1xml: 'powershell',
  pssc: 'powershell',
  psrc: 'powershell',
  cdxml: 'xml',
  // Windows batch & registry
  bat: 'bat',
  cmd: 'bat',
  btm: 'bat',
  reg: 'reg',
  // POSIX & alternative shells
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ash: 'bash',
  dash: 'bash',
  ksh: 'bash',
  mksh: 'bash',
  csh: 'bash',
  tcsh: 'bash',
  fish: 'fish',
  nu: 'nushell',
  awk: 'awk',
  // TypeScript / JavaScript
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  // Data / config / docs
  json: 'json',
  jsonl: 'json',
  jsonc: 'jsonc',
  json5: 'jsonc',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  cnf: 'ini',
  properties: 'ini',
  env: 'dotenv',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  xml: 'xml',
  svg: 'xml',
  plist: 'xml',
  csproj: 'xml',
  fsproj: 'xml',
  vbproj: 'xml',
  props: 'xml',
  targets: 'xml',
  diff: 'diff',
  patch: 'diff',
  // Web
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  graphql: 'graphql',
  gql: 'graphql',
  // Systems & backend languages
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  rb: 'ruby',
  gemspec: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  php: 'php',
  sql: 'sql',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  groovy: 'groovy',
  gradle: 'groovy',
  r: 'r',
  scala: 'scala',
  sc: 'scala',
  dart: 'dart',
  zig: 'zig',
  nix: 'nix',
  ex: 'elixir',
  exs: 'elixir',
  // Build & IaC
  dockerfile: 'dockerfile',
  mk: 'makefile',
  mak: 'makefile',
  cmake: 'cmake',
  tf: 'terraform',
  tfvars: 'terraform',
  hcl: 'hcl',
  proto: 'proto'
}

const LANGUAGE_BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  justfile: 'makefile',
  'cmakelists.txt': 'cmake',
  jenkinsfile: 'groovy',
  vagrantfile: 'ruby',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  fastfile: 'ruby',
  '.env': 'dotenv',
  dotenv: 'dotenv',
  '.bashrc': 'bash',
  '.bash_profile': 'bash',
  '.bash_login': 'bash',
  '.bash_logout': 'bash',
  '.profile': 'bash',
  '.zshrc': 'bash',
  '.zshenv': 'bash',
  '.zprofile': 'bash',
  '.zlogin': 'bash',
  '.zlogout': 'bash',
  '.kshrc': 'bash',
  '.mkshrc': 'bash',
  '.cshrc': 'bash',
  '.tcshrc': 'bash',
  bashrc: 'bash',
  zshrc: 'bash',
  '.editorconfig': 'ini',
  '.gitconfig': 'ini',
  '.gitattributes': 'ini',
  '.npmrc': 'ini',
  '.yarnrc': 'ini',
  '.pylintrc': 'ini',
  '.eslintrc': 'jsonc',
  '.prettierrc': 'jsonc',
  '.babelrc': 'jsonc',
  '.swcrc': 'jsonc',
  '.jshintrc': 'jsonc'
}

/** Return the lowercase basename, stripping any POSIX or Windows directory prefix. */
export function fileBasenameLower(fileNameOrPath: string): string {
  const trimmed = fileNameOrPath.trim()
  if (!trimmed) return ''
  const sep = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return (sep >= 0 ? trimmed.slice(sep + 1) : trimmed).toLowerCase()
}

/**
 * Guess a language identifier from a filename or path, or return `''` when no
 * known extension, dotfile, or special filename matches.
 */
export function languageForFilePath(fileNameOrPath: string): string {
  const lower = fileBasenameLower(fileNameOrPath)
  if (!lower) return ''
  if (Object.hasOwn(LANGUAGE_BY_NAME, lower)) return LANGUAGE_BY_NAME[lower]
  if (lower.startsWith('dockerfile.') || lower.startsWith('containerfile.')) return 'dockerfile'
  if (lower.startsWith('.env.')) return 'dotenv'
  if (lower.startsWith('makefile.') || lower.startsWith('gnumakefile.')) return 'makefile'
  const dot = lower.lastIndexOf('.')
  if (dot === -1) return ''
  const ext = lower.slice(dot + 1)
  return Object.hasOwn(LANGUAGE_BY_EXT, ext) ? LANGUAGE_BY_EXT[ext] : ''
}
