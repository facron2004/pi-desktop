import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * A UTF-8 BOM is invisible in review and poisonous to the tools that read the
 * file raw. One was written into `package.json` by an editor that adds a BOM;
 * `npm run build` then failed inside Vite's PostCSS config lookup with
 * "Unexpected token '\uFEFF'" — the app could not be built from a file whose
 * first byte was wrong.
 *
 * PowerShell scripts carry a BOM by convention, so they are the one exception.
 */

const root = process.cwd()
const SKIP = new Set(['node_modules', 'out', '.git', '.agents', 'output', 'release', 'dist', '.tmp-build'])
const EXTENSIONS = /\.(json|mjs|cjs|js|ts|tsx|css|md|yml|yaml|html)$/

function files(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Ignore dot-paths (editor scratch files such as `.tmp-*`, and the VCS data
    // itself) except `.github`, which is real configuration.
    if (entry.name.startsWith('.') && entry.name !== '.github') continue
    if (SKIP.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...files(full))
    else if (EXTENSIONS.test(entry.name)) found.push(full)
  }
  return found
}

test('no source or configuration file starts with a byte-order mark', () => {
  const offenders = files(root)
    .filter((file) => {
      const bytes = readFileSync(file)
      return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    })
    .map((file) => path.relative(root, file))
  assert.deepEqual(offenders, [], `files with a UTF-8 BOM: ${offenders.join(', ')}`)
})

test('package.json is readable as plain JSON', () => {
  // The build reads it raw; a BOM (or a stray comment) here is a build failure.
  const raw = readFileSync(path.join(root, 'package.json'))
  assert.notEqual(raw[0], 0xef, 'package.json starts with a BOM')
  const parsed = JSON.parse(raw.toString('utf8')) as { name?: string; scripts?: Record<string, string> }
  assert.equal(parsed.name, 'pi-desktop')
})
