import test from 'node:test'
import assert from 'node:assert/strict'
import { looksLikeUrl, normalizeExternalUrl } from '../src/renderer/src/lib/url-link'

test('explicit schemes are links', () => {
  assert.equal(looksLikeUrl('https://example.com'), true)
  assert.equal(looksLikeUrl('http://localhost:3000/app'), true)
  assert.equal(looksLikeUrl('ftp://files.example.com/x'), true)
  assert.equal(looksLikeUrl('//cdn.example.com/lib.js'), true)
})

test('a bare domain with a known suffix is a link', () => {
  assert.equal(looksLikeUrl('example.com'), true)
  assert.equal(looksLikeUrl('docs.example.com/guide/intro'), true)
  assert.equal(looksLikeUrl('example.com:8080/health'), true)
  // The bug this guards: a URL ending in a source-file extension was matched
  // by the file-reference parser and opened the files panel instead.
  assert.equal(looksLikeUrl('example.com/index.html'), true)
  assert.equal(looksLikeUrl('example.com/readme.md'), true)
})

test('source files and relative paths are not links', () => {
  assert.equal(looksLikeUrl('src/main/ipc.ts'), false)
  assert.equal(looksLikeUrl('docs/guide.md'), false)
  assert.equal(looksLikeUrl('foo.test.ts'), false)
  assert.equal(looksLikeUrl('package.json'), false)
  assert.equal(looksLikeUrl('C:/work/demo/src/index.ts'), false)
  assert.equal(looksLikeUrl(''), false)
  assert.equal(looksLikeUrl('two words.md'), false)
})

test('mailto and unknown suffixes are not treated as web links', () => {
  assert.equal(looksLikeUrl('mailto:someone@example.com'), false)
  assert.equal(looksLikeUrl('example.zzz'), false)
})

test('normalizeExternalUrl makes every accepted form absolute', () => {
  assert.equal(normalizeExternalUrl('https://example.com/a'), 'https://example.com/a')
  assert.equal(normalizeExternalUrl('//cdn.example.com/lib.js'), 'https://cdn.example.com/lib.js')
  assert.equal(normalizeExternalUrl('example.com/index.html'), 'https://example.com/index.html')
  assert.equal(normalizeExternalUrl('src/main/ipc.ts'), null)
  assert.equal(normalizeExternalUrl(''), null)
})
