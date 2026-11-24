import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Documentation points at real files.
 *
 * AGENTS.md is the project's specification and the docs are read by
 * contributors and users; a renamed or deleted file leaves a backticked path
 * that looks authoritative and 404s on the reader. Release notes and the
 * changelog are history and are deliberately not scanned: they describe files
 * as they were at that release.
 */

const root = process.cwd()
const files = [
  'AGENTS.md',
  'README.md',
  ...readdirSync(path.join(root, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => path.join('docs', name))
]

const REPOSITORY_PATH = /^(?:src|scripts|tests|plugins|build|setup|\.github)\//
/** A reference to another project's build output, not this tree. */
const EXTERNAL = /^out\/_next\//

function referencedPaths(text: string): string[] {
  const paths: string[] = []
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1].trim()
    if (!REPOSITORY_PATH.test(token) || EXTERNAL.test(token)) continue
    // Skip patterns, placeholders and prose: only a concrete path is checkable.
    if (/[*?<>{}|$]|\s/.test(token)) continue
    // `src/main/pi/runtime.ts:224` and `component.tsx(9,3)` are still a file.
    const file = token.replace(/:\d+$/, '').replace(/\(\d+(?:,\d+)?$/, '')
    paths.push(file)
  }
  return paths
}

test('every file path named in the current documentation exists', () => {
  const missing: string[] = []
  for (const file of files) {
    const text = readFileSync(path.join(root, file), 'utf8')
    for (const referenced of referencedPaths(text)) {
      if (!existsSync(path.join(root, referenced))) missing.push(`${file}: ${referenced}`)
    }
  }
  assert.deepEqual(missing, [], `documentation names files that do not exist:\n  ${missing.join('\n  ')}`)
})

test('the scan is looking at the documentation it claims to', () => {
  // A guard against the test silently passing because the glob found nothing.
  assert.ok(files.length >= 15, `expected the current docs, found ${files.length} files`)
  const agentsPaths = referencedPaths(readFileSync(path.join(root, 'AGENTS.md'), 'utf8'))
  assert.ok(agentsPaths.length >= 10, `AGENTS.md should name many files, found ${agentsPaths.length}`)
})
