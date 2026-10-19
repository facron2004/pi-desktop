import type { createBundledHighlighter } from 'shiki/core'

/**
 * Syntax highlighting for code blocks and the file viewer.
 *
 * The languages are imported one by one instead of using `shiki/bundle/web`:
 * that bundle only ships 80 grammars and rejects the rest outright, and it
 * would pull every grammar into the build even though a conversation rarely
 * shows more than a couple of languages.
 */
const LANGUAGES = {
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  css: () => import('@shikijs/langs/css'),
  diff: () => import('@shikijs/langs/diff'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  go: () => import('@shikijs/langs/go'),
  graphql: () => import('@shikijs/langs/graphql'),
  html: () => import('@shikijs/langs/html'),
  ini: () => import('@shikijs/langs/ini'),
  java: () => import('@shikijs/langs/java'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  jsx: () => import('@shikijs/langs/jsx'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  lua: () => import('@shikijs/langs/lua'),
  markdown: () => import('@shikijs/langs/markdown'),
  php: () => import('@shikijs/langs/php'),
  powershell: () => import('@shikijs/langs/powershell'),
  python: () => import('@shikijs/langs/python'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  scss: () => import('@shikijs/langs/scss'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  sql: () => import('@shikijs/langs/sql'),
  swift: () => import('@shikijs/langs/swift'),
  svelte: () => import('@shikijs/langs/svelte'),
  toml: () => import('@shikijs/langs/toml'),
  tsx: () => import('@shikijs/langs/tsx'),
  typescript: () => import('@shikijs/langs/typescript'),
  vue: () => import('@shikijs/langs/vue'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml')
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
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  shell: 'shellscript',
  console: 'shellscript',
  ps1: 'powershell',
  yml: 'yaml',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  kt: 'kotlin',
  cs: 'csharp',
  'c++': 'cpp',
  cxx: 'cpp',
  htm: 'html',
  json5: 'json'
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

export function themeName(isDark: boolean): Theme {
  return isDark ? DARK : LIGHT
}

function resolveGrammar(name: string): Grammar | null {
  const key = name.trim().toLowerCase()
  if (!key) return null
  if (key in LANGUAGES) return key as Grammar
  return ALIASES[key] ?? null
}

export async function highlightCode(
  code: string,
  language: string,
  isDark: boolean
): Promise<string> {
  const highlighter = await getHighlighter()
  const grammar = resolveGrammar(language)

  if (grammar && !highlighter.getLoadedLanguages().includes(grammar)) {
    try {
      await highlighter.loadLanguage(grammar)
    } catch {
      // A grammar that refuses to load is not worth breaking the block over.
    }
  }

  const lang = grammar && highlighter.getLoadedLanguages().includes(grammar) ? grammar : PLAIN

  return highlighter.codeToHtml(code, {
    lang: lang as Grammar | typeof PLAIN,
    theme: themeName(isDark)
  })
}
