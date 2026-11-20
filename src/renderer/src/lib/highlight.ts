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
const languageLoadPromises = new WeakMap<Highlighter, Map<Grammar, Promise<void>>>()

const MAX_HIGHLIGHT_CHARS = 250_000
const CHUNKED_HIGHLIGHT_LINE_THRESHOLD = 80
const CHUNKED_HIGHLIGHT_LINES = 50
const HIGHLIGHT_SLICE_BUDGET_MS = 10

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

function yieldFrame(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

async function loadGrammarOnce(highlighter: Highlighter, grammar: Grammar): Promise<void> {
  if (highlighter.getLoadedLanguages().includes(grammar)) return
  let map = languageLoadPromises.get(highlighter)
  if (!map) {
    map = new Map()
    languageLoadPromises.set(highlighter, map)
  }
  const inFlight = map.get(grammar)
  if (inFlight) return inFlight
  const task = highlighter
    .loadLanguage(grammar)
    .then(() => undefined)
    .catch(() => {
      // A grammar that refuses to load is not worth breaking the block over.
    })
    .finally(() => {
      if (map?.get(grammar) === task) map.delete(grammar)
    })
  map.set(grammar, task)
  return task
}

function plainShikiHtml(code: string, isDark: boolean): string {
  const theme = themeName(isDark)
  const bg = isDark ? '#121212' : '#ffffff'
  const fg = isDark ? '#dbd7caee' : '#393a34'
  const lines = code.split(/\r?\n/)
  const body = lines.map((line) => `<span class="line">${escapeHtml(line)}</span>`).join('\n')
  return `<pre class="shiki ${theme}" style="background-color:${bg};color:${fg}" tabindex="0"><code>${body}</code></pre>`
}

function formatTokenLine(tokens: readonly { content: string; color?: string; fontStyle?: number }[]): string {
  if (tokens.length === 0) return '<span class="line"></span>'
  let inner = ''
  for (const token of tokens) {
    const styles: string[] = []
    if (token.color) styles.push(`color:${token.color}`)
    if (token.fontStyle) {
      if (token.fontStyle & 1) styles.push('font-style:italic')
      if (token.fontStyle & 2) styles.push('font-weight:bold')
      if (token.fontStyle & 4) styles.push('text-decoration:underline')
    }
    const text = escapeHtml(token.content)
    inner += styles.length ? `<span style="${styles.join(';')}">${text}</span>` : text
  }
  return `<span class="line">${inner}</span>`
}

async function highlightInChunks(
  highlighter: Highlighter,
  code: string,
  lang: Grammar | typeof PLAIN,
  theme: Theme
): Promise<string> {
  const lines = code.split(/\r?\n/)
  if (lines.length <= CHUNKED_HIGHLIGHT_LINE_THRESHOLD) {
    return highlighter.codeToHtml(code, { lang, theme })
  }

  let grammarState: ReturnType<Highlighter['getLastGrammarState']> | undefined
  let bg = theme === DARK ? '#121212' : '#ffffff'
  let fg = theme === DARK ? '#dbd7caee' : '#393a34'
  let themeClass = theme
  const lineHtml: string[] = []
  let sliceStart = nowMs()

  for (let start = 0; start < lines.length; start += CHUNKED_HIGHLIGHT_LINES) {
    const chunk = lines.slice(start, start + CHUNKED_HIGHLIGHT_LINES).join('\n')
    const result = highlighter.codeToTokens(chunk, {
      lang,
      theme,
      ...(grammarState ? { grammarState } : {})
    })
    grammarState = result.grammarState
    if (start === 0) {
      if (result.bg) bg = result.bg
      if (result.fg) fg = result.fg
      if (result.themeName) themeClass = result.themeName as Theme
    }
    for (const row of result.tokens) {
      lineHtml.push(formatTokenLine(row))
    }
    if (start + CHUNKED_HIGHLIGHT_LINES < lines.length && nowMs() - sliceStart >= HIGHLIGHT_SLICE_BUDGET_MS) {
      await yieldFrame()
      sliceStart = nowMs()
    }
  }

  return `<pre class="shiki ${themeClass}" style="background-color:${bg};color:${fg}" tabindex="0"><code>${lineHtml.join('\n')}</code></pre>`
}

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

export function highlightCode(
  code: string,
  language: string,
  isDark: boolean,
  options?: { cache?: boolean }
): Promise<string> {
  const useCache = options?.cache !== false
  const key = highlightCacheKey(code, language, isDark)
  if (key !== undefined) {
    const html = resolvedHighlightCache.get(key)
    if (html !== undefined) return Promise.resolve(html)
  }
  const cached = useCache && key !== undefined ? highlightCache.get(key) : undefined
  if (cached) return cached

  if (code.length > MAX_HIGHLIGHT_CHARS) {
    return Promise.resolve(plainShikiHtml(code, isDark))
  }

  const pending = (async () => {
    const highlighter = await getHighlighter()
    const grammar = resolveHighlightLanguage(language)

    if (grammar) {
      await loadGrammarOnce(highlighter, grammar)
    }

    const lang = grammar && highlighter.getLoadedLanguages().includes(grammar) ? grammar : PLAIN
    const html = await highlightInChunks(highlighter, code, lang, themeName(isDark))
    if (useCache && key !== undefined) resolvedHighlightCache.set(key, code.length, html)
    return html
  })()

  if (useCache && key !== undefined) {
    highlightCache.set(key, code.length, pending)
    void pending.finally(() => highlightCache.deleteIfValue(key, pending)).catch(() => {})
  }
  return pending
}
