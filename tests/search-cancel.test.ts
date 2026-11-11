import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const read = (file: string): string => readFileSync(path.resolve(process.cwd(), file), 'utf8')

test('file search drops stale results on query changes and cleared searches stop their walks', () => {
  const component = read('src/renderer/src/components/TextSearch.tsx')
  const fileTree = read('src/renderer/src/components/FileTree.tsx')
  const composer = read('src/renderer/src/components/Composer.tsx')
  const ipc = read('src/main/ipc.ts')

  assert.match(component, /if \(requestStarted\) void window\.pi\.fs\.searchText\('', HIT_LIMIT\)/)
  assert.match(fileTree, /\.search\(needle, undefined, 'file-tree'\)/)
  assert.match(fileTree, /const updateQuery = \(next: string\) => \{\s*searchVersion\.current \+= 1/)
  assert.match(fileTree, /const hasQuery = Boolean\(next\.trim\(\)\)[\s\S]*?setMatches\(hasQuery \? \{ entries: \[\], truncated: false \} : null\)[\s\S]*?setSearching\(hasQuery\)/)
  assert.match(fileTree, /setMatches\(\{ entries: \[\], truncated: false \}\)\s*setSearching\(true\)/)
  assert.match(fileTree, /if \(requestStarted\) void window\.pi\.fs\.search\('', 0, 'file-tree'\)/)
  assert.match(fileTree, /setSearchError\(true\)/)
  assert.match(fileTree, /The file search failed\./)
  assert.match(composer, /\.search\(mention\.query, 12, 'composer-mention'\)/)
  assert.match(composer, /if \(requestStarted\) void window\.pi\.fs\.search\('', 0, 'composer-mention'\)/)
  assert.match(ipc, /senderSearches\.set\(searchScope, token\)/)
  assert.match(ipc, /if \(!root \|\| limit === 0\) return \{ entries: \[\], truncated: false \}/)
  assert.match(ipc, /latestTextSearches\.set\(event\.sender, token\)/)
  assert.match(ipc, /if \(typeof query !== 'string' \|\| query\.length > MAX_SEARCH_QUERY_LENGTH\) \{\s*return \{ hits: \[\], truncated: false \}\s*\}[\s\S]*?const needle = query\.trim\(\)\.toLowerCase\(\)[\s\S]*?if \(!root \|\| !needle\) return \{ hits: \[\], truncated: false \}/)
  assert.match(ipc, /readBoundedHandle\(\s*opened\.handle,\s*Math\.min\(MAX_FILE_BYTES, remainingBytes\),\s*\(totalRead\) => \{\s*bytesRead = totalRead/)
  assert.match(ipc, /if \(result\.truncated\) \{\s*\/\/ The file may have changed during the read\.[\s\S]*?return \{ hits: \[\], bytesRead, budgetExceeded: false, incomplete: true \}/)
})
