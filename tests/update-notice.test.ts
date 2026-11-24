import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldShowUpdateNotice } from '../src/shared/update-notice'

test('nothing is announced without an offered release', () => {
  assert.equal(shouldShowUpdateNotice({}), false)
  assert.equal(shouldShowUpdateNotice({ latest: null }), false)
  assert.equal(shouldShowUpdateNotice({ latest: '' }), false)
})

test('an offered release shows, dismissed or not', () => {
  assert.equal(shouldShowUpdateNotice({ latest: '0.12.0' }), true)
  assert.equal(
    shouldShowUpdateNotice({ latest: '0.12.0', dismissedVersion: '0.11.0' }),
    true,
    'a dismissal names one release, not every future one'
  )
})

// Codex keeps `dismissed_version` beside the latest it found: saying "not this
// one" silences that release, and the next published one speaks again.
test('a dismissed release stops being announced, a newer one comes back', () => {
  assert.equal(
    shouldShowUpdateNotice({ latest: '0.12.0', dismissedVersion: '0.12.0' }),
    false
  )
  assert.equal(
    shouldShowUpdateNotice({ latest: '0.12.1', dismissedVersion: '0.12.0' }),
    true
  )
})

// A hidden download would leave the reader with an installer they cannot see
// or restart, so work in flight always keeps the control on screen.
test('a download or a ready installer outranks the dismissal', () => {
  assert.equal(
    shouldShowUpdateNotice({ latest: '0.12.0', dismissedVersion: '0.12.0', busy: true }),
    true
  )
  assert.equal(
    shouldShowUpdateNotice({ latest: '0.12.0', dismissedVersion: '0.12.0', ready: true }),
    true
  )
})

test('a blank dismissal is not a dismissal', () => {
  assert.equal(shouldShowUpdateNotice({ latest: '0.12.0', dismissedVersion: '   ' }), true)
  assert.equal(shouldShowUpdateNotice({ latest: '0.12.0', dismissedVersion: null }), true)
})

// A failed download is neither progress nor a ready installer, but the control
// is the only retry: hiding it after a dismissal left the failure invisible and
// the release unretryable.
test('a failed download keeps the control on screen', () => {
  assert.equal(
    shouldShowUpdateNotice({ latest: '0.12.0', dismissedVersion: '0.12.0', failed: true }),
    true
  )
  assert.equal(shouldShowUpdateNotice({ latest: '0.12.0', failed: true }), true)
})
