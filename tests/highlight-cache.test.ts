import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HIGHLIGHT_CACHE_LIMIT,
  HighlightCache,
  MAX_CACHED_HIGHLIGHT_CODE_UNITS,
  highlightCacheKey
} from '../src/renderer/src/lib/highlight-cache'

test('highlight cache skips oversized source and bounds retained entries', () => {
  assert.equal(highlightCacheKey('small', 'typescript', true), 'dark\u0000typescript\u0000small')
  assert.equal(highlightCacheKey('x'.repeat(MAX_CACHED_HIGHLIGHT_CODE_UNITS + 1), 'text', false), undefined)

  const cache = new HighlightCache()
  const tooLarge = Promise.resolve('large')
  cache.set('large', MAX_CACHED_HIGHLIGHT_CODE_UNITS + 1, tooLarge)
  assert.equal(cache.get('large'), undefined)

  const values = Array.from({ length: HIGHLIGHT_CACHE_LIMIT + 1 }, (_, index) => Promise.resolve(String(index)))
  for (let index = 0; index < HIGHLIGHT_CACHE_LIMIT; index += 1) {
    cache.set(`entry-${index}`, 1, values[index]!)
  }
  assert.equal(cache.get('entry-0'), values[0])
  cache.set('newest', 1, values[HIGHLIGHT_CACHE_LIMIT]!)

  assert.equal(cache.get('entry-0'), values[0])
  assert.equal(cache.get('entry-1'), undefined)
  assert.equal(cache.get('newest'), values[HIGHLIGHT_CACHE_LIMIT])
})

test('a rejected old highlighter request cannot evict a newer request for the same key', () => {
  const cache = new HighlightCache()
  const oldValue = Promise.resolve('old')
  const newValue = Promise.resolve('new')
  cache.set('same', 4, oldValue)
  cache.set('same', 4, newValue)
  cache.deleteIfValue('same', oldValue)
  assert.equal(cache.get('same'), newValue)
})
