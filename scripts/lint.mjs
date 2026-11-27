#!/usr/bin/env node
// Lint the repository's development conventions.
//
// This is deliberately dependency-free: the conventions it enforces are the
// ones AGENTS.md already states, and none of them need a parser. A new rule
// belongs here when it can be checked by reading bytes or lines; the moment a
// rule needs a syntax tree, add a real tool instead of growing this one.
//
//   npm run lint
//
// Exits non-zero with one line per violation.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const violations = []
const report = (file, line, message) => {
  const where = line ? `${path.relative(root, file)}:${line}` : path.relative(root, file)
  violations.push(`${where} ${message}`)
}

// ---------------------------------------------------------------- helpers --

const textFilesByExtension = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx',
  '.css', '.html', '.json', '.md', '.yml', '.yaml', '.svg', '.sh', '.ps1'
])

// Byte-order marks only broke the production build once; they are never
// intended in a source tree that is UTF-8 throughout (.editorconfig).
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

function walk(dir, files = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (IGNORED_DIRS.has(name)) continue
      walk(full, files)
    } else {
      files.push(full)
    }
  }
  return files
}

// ------------------------------------------------------------------ rules --

const IGNORED_DIRS = new Set([
  'node_modules', 'out', 'dist', 'release', 'build', 'output',
  '.git', '.vite', '.idea', '.vscode', '.playwright-cli', '.playwright-mcp',
  '.pi-desktop-build', '.agents', 'session-media', 'updates'
])

// Directories whose files may never be linted for code conventions but whose
// text hygiene (BOM, CRLF, trailing spaces) still applies where text is read.
const vendoredDirs = ['packages', 'vendor']

function lintFile(file, bytes, isSource) {
  const rel = path.relative(root, file)

  if (bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]) {
    report(file, 0, 'has a UTF-8 byte-order mark')
  }

  if (!textFilesByExtension.has(path.extname(file))) return
  const text = bytes.toString('utf8')

  if (text.includes('\r')) {
    const line = text.slice(0, text.indexOf('\r')).split('\n').length
    report(file, line, 'uses CR (expected LF line endings)')
  }
  if (!text.endsWith('\n') && text.length > 0) {
    report(file, 0, 'has no final newline')
  }

  if (!isSource) return

  // Trailing whitespace, and tabs used for indentation. Spaces are the
  // project's indent (.editorconfig); a tab inside a line (alignment of
  // markdown tables, say) is not an indent, so only leading tabs count.
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line !== line.trimEnd() && line.trimEnd().length > 0) {
      report(file, i + 1, 'has trailing whitespace')
    }
    if (/^\t+/.test(line)) {
      report(file, i + 1, 'is indented with tabs (expected spaces)')
    }
  }
}

// Rules that need the file's role, not just its bytes. Each takes the resolved
// file and its text; each is free to skip what it does not own.
const rules = [
  {
    name: 'AGENTS.md: never parse the Pi protocol with readline',
    owns: (rel) => /^src\/(main|preload)\/.*\.(ts|tsx|mjs|cjs|js)$/.test(rel),
    check(file, text) {
      // Comments that state the rule itself (rpc-client's framing rules,
      // sessions' "never uses readline") are documentation, not violations.
      const codeWithoutComments = text
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\/\*|\*|\#\s)/.test(line))
        .join('\n')
      if (/readline/.test(codeWithoutComments)) {
        const line = codeWithoutComments.slice(0, codeWithoutComments.indexOf('readline')).split('\n').length
        report(file, line, 'uses readline — the Pi protocol is split on bytes in rpc-client.ts, never with readline')
      }
    }
  },
  {
    name: 'AGENTS.md: the renderer has no Node access',
    owns: (rel) => /^src\/renderer\/(?!tray).*\.(ts|tsx)$/.test(rel),
    check(file, text) {
      for (const forbidden of ['node:fs', 'node:path', 'node:child_process', "require('fs", "require('path"]) {
        if (text.includes(forbidden)) {
          const line = text.slice(0, text.indexOf(forbidden)).split('\n').length
          report(file, line, `uses ${forbidden} — the renderer reaches main only through the preload bridge`)
        }
      }
      if (/process\.platform/.test(text)) {
        const line = text.slice(0, text.indexOf('process.platform')).split('\n').length
        report(file, line, 'reads process.platform — the renderer gets the platform through the typed bridge')
      }
    }
  },
  {
    name: 'AGENTS.md: stdout is protocol, stderr is diagnostics',
    owns: (rel) => /^src\/main\/pi\/.*\.ts$/.test(rel),
    check(file, text) {
      if (/process\.stdout\.write/.test(text)) {
        const line = text.slice(0, text.indexOf('process.stdout.write')).split('\n').length
        report(file, line, 'writes to stdout — that channel is the Pi protocol; diagnostics go to stderr')
      }
    }
  }
]

// ------------------------------------------------------------------- main --

const files = walk(root)
for (const file of files) {
  const rel = path.relative(root, file).replaceAll('\\', '/')
  if (rel.startsWith('.tmp')) continue // scratch logs, ignored in .gitignore too
  const isVendored = vendoredDirs.some((dir) => rel.startsWith(`${dir}/`))
  const bytes = readFileSync(file)
  lintFile(file, bytes, !isVendored)
  if (isVendored) continue
  for (const rule of rules) {
    if (rule.owns(rel)) rule.check(file, bytes.toString('utf8'))
  }
}

if (violations.length > 0) {
  console.error(`lint: ${violations.length} violation${violations.length === 1 ? '' : 's'}`)
  for (const line of violations) console.error(line)
  process.exit(1)
}
console.log('lint: clean')
