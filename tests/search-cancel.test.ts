import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const read = (file: string): string => readFileSync(path.resolve(process.cwd(), file), 'utf8')

test('clearing or closing TextSearch invalidates its running main-process walk', () => {
  const component = read('src/renderer/src/components/TextSearch.tsx')
  const ipc = read('src/main/ipc.ts')

  assert.match(component, /if \(requestStarted\) void window\.pi\.fs\.searchText\('', HIT_LIMIT\)/)
  assert.match(ipc, /latestTextSearches\.set\(event\.sender, token\)/)
  assert.match(ipc, /const needle = query\.trim\(\)\.toLowerCase\(\)[\s\S]*?if \(!root \|\| !needle\) return \[\]/)
})
