import test from 'node:test'
import assert from 'node:assert/strict'
import { imagePayloadOf } from '../src/renderer/src/lib/image-data'

/**
 * The stage holds a picture as a `data:` URL, but `fs:saveImage` takes base64
 * bytes and a media type. A save is the one action the Images page could not
 * offer, so the conversion is a function of its own rather than a regex in the
 * component.
 */
test('a picture data URL splits into the bytes fs:saveImage wants', () => {
  const payload = imagePayloadOf('data:image/png;base64,iVBORw0KGgo=')
  assert.deepEqual(payload, { data: 'iVBORw0KGgo=', mimeType: 'image/png' })
})

test('a non-base64 or empty URL has no payload', () => {
  assert.equal(imagePayloadOf('data:image/svg+xml,%3Csvg%3E'), null)
  assert.equal(imagePayloadOf('data:image/png;base64,'), null)
  assert.equal(imagePayloadOf('https://example.com/a.png'), null)
})

test('base64 padding and line breaks survive the split', () => {
  const payload = imagePayloadOf('data:image/jpeg;base64,AAAA\nBBBB==')
  assert.equal(payload?.mimeType, 'image/jpeg')
  assert.equal(payload?.data, 'AAAA\nBBBB==')
})
