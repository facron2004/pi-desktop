import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  APP_RELEASE_PAGE_URL,
  checkAppVersion,
  fetchLatestAppVersion,
  isNewerVersion
} from '../src/main/app-updates'

test('reads and normalizes the latest GitHub release redirect', async () => {
  const version = await fetchLatestAppVersion(async (url, options) => {
    assert.equal(url, APP_RELEASE_PAGE_URL)
    assert.equal(options?.method, 'HEAD')
    assert.equal(options?.redirect, 'manual')
    return new Response(null, {
      status: 302,
      headers: { location: 'https://github.com/facron2004/pi-desktop/releases/tag/v0.10.8' }
    })
  })

  assert.equal(version, '0.10.8')
})

test('compares numeric version segments', () => {
  assert.equal(isNewerVersion('0.10.10', '0.10.9'), true)
  assert.equal(isNewerVersion('0.10.7', '0.10.7'), false)
  assert.equal(isNewerVersion('0.10.6', '0.10.7'), false)
})

test('compares semantic versions with prereleases and build metadata', () => {
  assert.equal(isNewerVersion('1.5.0', '1.5.0-beta.1'), true)
  assert.equal(isNewerVersion('1.5.0-beta.11', '1.5.0-beta.2'), true)
  assert.equal(isNewerVersion('1.5.0-beta.2', '1.5.0-beta.11'), false)
  assert.equal(isNewerVersion('1.5.0+build.2', 'v1.5.0+build.1'), false)
  assert.equal(isNewerVersion('1.5.0-01', '1.5.0-beta'), false)
})

test('reports a newer app release', async () => {
  const status = await checkAppVersion('0.10.7', async () =>
    new Response(null, {
      status: 302,
      headers: { location: 'https://github.com/facron2004/pi-desktop/releases/tag/v0.10.8' }
    })
  )

  assert.deepEqual(status, { current: '0.10.7', latest: '0.10.8', hasUpdate: true })
})

test('keeps the current version and surfaces GitHub errors', async () => {
  const status = await checkAppVersion('0.10.7', async () => new Response(null, { status: 403 }))

  assert.equal(status.current, '0.10.7')
  assert.equal(status.hasUpdate, false)
  assert.match(status.error ?? '', /HTTP 403/)
})

test('rejects malformed GitHub release tags', async () => {
  await assert.rejects(
    fetchLatestAppVersion(async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://github.com/facron2004/pi-desktop/releases/tag/latest' }
      })
    ),
    /invalid latest release tag/
  )
})

test('rejects redirects away from the trusted GitHub host', async () => {
  await assert.rejects(
    fetchLatestAppVersion(async () =>
      new Response(null, { status: 302, headers: { location: 'https://example.com/releases/tag/v0.10.8' } })
    ),
    /unexpected release host/
  )
})

test('opens the public latest release page', () => {
  assert.equal(APP_RELEASE_PAGE_URL, 'https://github.com/facron2004/pi-desktop/releases/latest')
})
