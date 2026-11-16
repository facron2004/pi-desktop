import { languageForFilePath } from '@shared/file-languages'
import type { createBundledHighlighter } from 'shiki/core'
import { HighlightCache, ResolvedHighlightCache, highlightCacheKey } from './highlight-cache'

/**
 * Syntax highlighting for code blocks and the file viewer.
 *
 * The languages are imported one by one instead of using `shiki/bundle/web`:
 * that bundle only ships 80 grammars and rejects the rest outright, and it
 * would pull every grammar into the build even though a conversation rarely
 * shows more than a couple of languages.
 */
const LANGUAGES = {
  awk: () => import('@shikijs/langs/awk'),
  bat: () => import('@shikijs/langs/bat'),
  c: () => import('@shikijs/langs/c'),
  cmake: () => import('@shikijs/langs/cmake'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  css: () => import('@shikijs/langs/css'),
  dart: () => import('@shikijs/langs/dart'),
  diff: () => import('@shikijs/langs/diff'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  dotenv: () => import('@shikijs/langs/dotenv'),
  elixir: () => import('@shikijs/langs/elixir'),
  fish: () => import('@shikijs/langs/fish'),
  go: () => import('@shikijs/langs/go'),
  graphql: () => import('@shikijs/langs/graphql'),
  groovy: () => import('@shikijs/langs/groovy'),
  hcl: () => import('@shikijs/langs/hcl'),
  html: () => import('@shikijs/langs/html'),
  ini: () => import('@shikijs/langs/ini'),
  java: () => import('@shikijs/langs/java'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  jsx: () => import('@shikijs/langs/jsx'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  lua: () => import('@shikijs/langs/lua'),
  makefile: () => import('@shikijs/langs/makefile'),
  markdown: () => import('@shikijs/langs/markdown'),
  nix: () => import('@shikijs/langs/nix'),
  nushell: () => import('@shikijs/langs/nushell'),
  perl: () => import('@shikijs/langs/perl'),
  php: () => import('@shikijs/langs/php'),
  powershell: () => import('@shikijs/langs/powershell'),
  proto: () => import('@shikijs/langs/proto'),
  python: () => import('@shikijs/langs/python'),
  r: () => import('@shikijs/langs/r'),
  reg: () => import('@shikijs/langs/reg'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  scala: () => import('@shikijs/langs/scala'),
  scss: () => import('@shikijs/langs/scss'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  sql: () => import('@shikijs/langs/sql'),
  svelte: () => import('@shikijs/langs/svelte'),
  swift: () => import('@shikijs/langs/swift'),
  terraform: () => import('@shikijs/langs/terraform'),
  toml: () => import('@shikijs/langs/toml'),
  tsx: () => import('@shikijs/langs/tsx'),
  typescript: () => import('@shikijs/langs/typescript'),
  vue: () => import('@shikijs/langs/vue'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
  zig: () => import('@shikijs/langs/zig')
} as const

type Grammar = keyof typeof LANGUAGES

/** Fence tags and file extensions that name a grammar differently. */
const ALIASES: Record<string, Grammar> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  ps1xml: 'powershell',
  pssc: 'powershell',
  psrc: 'powershell',
  pwsh: 'powershell',
  posh: 'powershell',
  'powershell-ise': 'powershell',
  powershell_ise: 'powershell',
  'powershell-core': 'powershell',
  'powershell.exe': 'powershell',
  'pwsh.exe': 'powershell',
  cmd: 'bat',
  'cmd.exe': 'bat',
  batch: 'bat',
  dos: 'bat',
  nt: 'bat',
  btm: 'bat',
  regedit: 'reg',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  ash: 'shellscript',
  dash: 'shellscript',
  ksh: 'shellscript',
  mksh: 'shellscript',
  csh: 'shellscript',
  tcsh: 'shellscript',
  shell: 'shellscript',
  console: 'shellscript',
  'shell-session': 'shellscript',
  'sh-session': 'shellscript',
  terminal: 'shellscript',
  bashrc: 'shellscript',
  zshrc: 'shellscript',
  'sh.exe': 'shellscript',
  'bash.exe': 'shellscript',
  nu: 'nushell',
  docker: 'dockerfile',
  containerfile: 'dockerfile',
  make: 'makefile',
  mk: 'makefile',
  gnumakefile: 'makefile',
  justfile: 'makefile',
  tf: 'terraform',
  tfvars: 'terraform',
  protobuf: 'proto',
  yml: 'yaml',
  env: 'dotenv',
  cfg: 'ini',
  conf: 'ini',
  cnf: 'ini',
  properties: 'ini',
  editorconfig: 'ini',
  gitconfig: 'ini',
  jsonl: 'json',
  json5: 'jsonc',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  python3: 'python',
  py3: 'python',
  rb: 'ruby',
  rs: 'rust',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  'c#': 'csharp',
  golang: 'go',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  h: 'c',
  htm: 'html',
  svg: 'xml',
  patch: 'diff',
  gql: 'graphql',
  pl: 'perl',
  pm: 'perl',
  gradle: 'groovy',
  jenkinsfile: 'groovy',
  ex: 'elixir',
  exs: 'elixir',
  rlang: 'r',
  sc: 'scala'
}

const THEMES = {
  'vitesse-dark': () => import('@shikijs/themes/vitesse-dark'),
  'vitesse-light': () => import('@shikijs/themes/vitesse-light')
} as const

type Theme = keyof typeof THEMES

type Highlighter = Awaited<
  ReturnType<ReturnType<typeof createBundledHighlighter<Grammar, Theme>>>
>

const DARK: Theme = 'vitesse-dark'
const LIGHT: Theme = 'vitesse-light'
/** Shiki renders plain text without loading a grammar. */
const PLAIN = 'text'

let highlighterPromise: Promise<Highlighter> | null = null

/**
 * Recently highlighted snippets.
 *
 * The same code block can appear several times in one answer (an example
 * repeated per section) or while a stable block is reassembled; Shiki's
 * tokenizer is deterministic for `(code, language, theme)`, so the HTML can be
 * reused instead of re-tokenising the same text. The cache is deliberately
 * small: code can be large, and stale snippets are not worth keeping for the
 * life of the window.
 */
const highlightCache = new HighlightCache()
const resolvedHighlightCache = new ResolvedHighlightCache()

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    // The highlighter itself is a separate chunk, so the app starts without
    // paying for a grammar engine it may never need.
    highlighterPromise = (async () => {
      const [{ createBundledHighlighter }, { createJavaScriptRegexEngine }] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript')
      ])
      const createHighlighter = createBundledHighlighter({
        langs: LANGUAGES,
        themes: THEMES,
        // The JavaScript engine keeps the renderer free of WebAssembly, which
        // the app's content security policy does not allow.
        engine: () => createJavaScriptRegexEngine({ forgiving: true })
      })
      // The themes load up front; grammars are pulled in on demand.
      return createHighlighter({ themes: [DARK, LIGHT], langs: [] })
    })().catch((error) => {
      highlighterPromise = null
      throw error
    })
  }
  return highlighterPromise
}

function themeName(isDark: boolean): Theme {
  return isDark ? DARK : LIGHT
}

function lookupDirectGrammar(key: string): Grammar | null {
  if (!key) return null
  if (Object.hasOwn(LANGUAGES, key)) return key as Grammar
  return Object.hasOwn(ALIASES, key) ? ALIASES[key] : null
}

/**
 * Resolve a fence info tag, alias, filename, path, or `lang:file` qualifier into
 * a bundled Shiki grammar id, or `null` for plain text.
 */
export function resolveHighlightLanguage(name: string): Grammar | null {
  const key = name.trim().toLowerCase()
  if (!key) return null

  const direct = lookupDirectGrammar(key)
  if (direct) return direct

  const fromFile = languageForFilePath(key)
  if (fromFile) {
    const resolved = lookupDirectGrammar(fromFile)
    if (resolved) return resolved
  }

  // Handle `lang:path` or `file:deploy.ps1` without splitting `C:\scripts\run.ps1`.
  if (!/^[a-z]:[\\/]/.test(key)) {
    const colon = key.indexOf(':')
    if (colon !== -1) {
      const left = key.slice(0, colon).trim()
      const right = key.slice(colon + 1).trim()
      const fromColon =
        lookupDirectGrammar(left) ??
        lookupDirectGrammar(right) ??
        lookupDirectGrammar(languageForFilePath(right))
      if (fromColon) return fromColon
    }
  }

  // Handle fence tags with attached range metadata such as `powershell{1,3}`.
  const metaMatch = /^([^{[\s]+)[{[]/.exec(key)
  if (metaMatch?.[1] && metaMatch[1] !== key) {
    return resolveHighlightLanguage(metaMatch[1])
  }

  return null
}

/** Return previously highlighted HTML synchronously when cached. */
export function readHighlightedCodeSync(code: string, language: string, isDark: boolean): string | null {
  const key = highlightCacheKey(code, language, isDark)
  if (key === undefined) return null
  return resolvedHighlightCache.get(key) ?? null
}

export function highlightCode(code: string, language: string, isDark: boolean): Promise<string> {
  const key = highlightCacheKey(code, language, isDark)
  if (key !== undefined) {
    const html = resolvedHighlightCache.get(key)
    if (html !== undefined) return Promise.resolve(html)
  }
  const cached = key === undefined ? undefined : highlightCache.get(key)
  if (cached) return cached

  const pending = (async () => {
    const highlighter = await getHighlighter()
    const grammar = resolveHighlightLanguage(language)

    if (grammar && !highlighter.getLoadedLanguages().includes(grammar)) {
      try {
        await highlighter.loadLanguage(grammar)
      } catch {
        // A grammar that refuses to load is not worth breaking the block over.
      }
    }

    const lang = grammar && highlighter.getLoadedLanguages().includes(grammar) ? grammar : PLAIN

    const html = highlighter.codeToHtml(code, {
      lang: lang as Grammar | typeof PLAIN,
      theme: themeName(isDark)
    })
    if (key !== undefined) resolvedHighlightCache.set(key, code.length, html)
    return html
  })()

  if (key !== undefined) {
    highlightCache.set(key, code.length, pending)
    pending.catch(() => highlightCache.deleteIfValue(key, pending))
  }
  return pending
}
