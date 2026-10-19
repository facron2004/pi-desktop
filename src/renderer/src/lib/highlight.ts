import type { Highlighter } from 'shiki/bundle/web'

const LANGS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'json',
  'jsonc',
  'html',
  'css',
  'scss',
  'bash',
  'sh',
  'powershell',
  'python',
  'go',
  'rust',
  'java',
  'kotlin',
  'swift',
  'ruby',
  'php',
  'sql',
  'yaml',
  'toml',
  'ini',
  'xml',
  'markdown',
  'diff',
  'dockerfile',
  'graphql',
  'vue',
  'svelte',
  'lua',
  'r',
  'zig'
]

const DARK = 'vitesse-dark'
const LIGHT = 'vitesse-light'

let highlighterPromise: Promise<Highlighter> | null = null

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    // Loaded on demand so the first paint does not wait for the grammar bundle.
    highlighterPromise = import('shiki/bundle/web')
      .then(({ createHighlighter }) =>
        createHighlighter({
          themes: [DARK, LIGHT],
          langs: LANGS as never
        })
      )
      .catch((error) => {
        highlighterPromise = null
        throw error
      })
  }
  return highlighterPromise
}

export function themeName(isDark: boolean): string {
  return isDark ? DARK : LIGHT
}

export async function highlightCode(
  code: string,
  language: string,
  isDark: boolean
): Promise<string> {
  const highlighter = await getHighlighter()
  const lang = highlighter.getLoadedLanguages().includes(language)
    ? language
    : highlighter.getLoadedLanguages().includes('text')
      ? 'text'
      : 'text'
  return highlighter.codeToHtml(code, {
    lang,
    theme: themeName(isDark)
  })
}
