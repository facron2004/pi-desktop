import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { translate } from '../src/renderer/src/lib/i18n'

/**
 * Every user-facing string a component asks for must have a Chinese reading.
 *
 * The UI is built in English and translated by looking up the exact English
 * text (`translate`/`useT`), so a missing key does not fail: the English string
 * simply stays on screen in the Chinese UI. The terminal panel and the
 * marketplace toast shipped that way. This test walks the renderer's literal
 * `t('…')` calls and compares them with the map, so the next one is caught here
 * rather than by a reader who cannot read the screen.
 */

/** Text that is deliberately identical in both languages. */
const SAME_IN_BOTH = new Set(['MCP', 'Pi CLI', 'tok/s', '简体中文'])

// The suite is bundled into a temp folder before it runs, so the repository is
// found through the process cwd (tests/run.mjs runs it from the project root),
// not through import.meta.url.
const renderer = path.resolve(process.cwd(), 'src', 'renderer', 'src')

function translationKeys(): Set<string> {
  const source = readFileSync(path.join(renderer, 'lib', 'i18n.ts'), 'utf8')
  const start = source.indexOf('const zhCN')
  const end = source.indexOf('export function translate', start)
  assert.ok(start >= 0 && end > start, 'the zh-CN map moved; update this test')
  const keys = new Set<string>()
  for (const line of source.slice(start, end).split('\n')) {
    const match = /^\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|([A-Za-z_$][\w$]*))\s*:/.exec(line)
    const raw = match?.[1] ?? match?.[2] ?? match?.[3]
    if (raw) keys.add(raw.replace(/\\(['"\\])/g, '$1'))
  }
  return keys
}

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry.name) && entry.name !== 'i18n.ts') files.push(full)
  }
  return files
}

/** Literal keys passed to `t(...)`; a variable or template key cannot be checked here. */
function usedKeys(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const keys: string[] = []
  for (const match of source.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1)[^\\])*?)\1\s*[,)]/g)) {
    const key = match[2].replace(/\\(['"\\])/g, '$1')
    if (key) keys.push(key)
  }
  return keys
}

test('every literal UI string has a Chinese translation', () => {
  const translated = translationKeys()
  assert.ok(translated.size > 1500, `the zh-CN map looks truncated (${translated.size} keys)`)
  const missing = new Map<string, string[]>()
  for (const file of sourceFiles(renderer)) {
    for (const key of usedKeys(file)) {
      if (translated.has(key) || SAME_IN_BOTH.has(key)) continue
      const files = missing.get(key) ?? []
      if (!files.includes(path.relative(renderer, file))) files.push(path.relative(renderer, file))
      missing.set(key, files)
    }
  }
  const report = [...missing.entries()]
    .map(([key, files]) => `  ${JSON.stringify(key)} (${files.join(', ')})`)
    .join('\n')
  assert.equal(missing.size, 0, `UI strings with no Chinese translation:\n${report}`)
})

test('a translated string is never left as its own English key', () => {
  // A key mapped to itself is a silent "translation" that changes nothing.
  const source = readFileSync(path.join(renderer, 'lib', 'i18n.ts'), 'utf8')
  const entries = [...source.matchAll(/^\s*'((?:\\.|[^'\\])*)':\s*'((?:\\.|[^'\\])*)',?$/gm)]
  const identical = entries
    .filter(([, key, value]) => key === value && !SAME_IN_BOTH.has(key))
    .map(([, key]) => key)
    .slice(0, 10)
  assert.deepEqual(identical, [], 'these keys translate to themselves')
})

test('main-process messages that reach the UI have a Chinese reading', () => {
  // The main process sends its guard messages as plain English text. They land
  // in toasts and settings that already call translate(), so the map is the
  // only thing that makes them readable — a missing key leaves English text in
  // the middle of a Chinese screen.
  const samples: [string, string][] = [
    ['No project is open.', '当前没有打开的项目。'],
    ['Nothing is staged. Stage a file or include unstaged changes.', '没有已暂存的更改。请先暂存文件，或勾选包含未暂存更改。'],
    ['Fill in the Feishu App ID.', '请填写飞书 App ID。'],
    ['Image prompt is required', '请填写图片提示词']
  ]
  for (const [english, chinese] of samples) assert.equal(translate(english, 'zh-CN'), chinese)
  // Text this project does not own (git, Pi, a provider) is passed through.
  assert.equal(translate('fatal: not a git repository', 'zh-CN'), 'fatal: not a git repository')
  assert.equal(translate('No project is open.', 'en'), 'No project is open.')
})
