import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compareTriplet,
  describeCheckFailure,
  fetchLatestCliVersionFromRegistry,
  packumentUrl,
  parseTriplet,
  pickLatestVersion,
  readBundledCliStatus,
  type JsonGetter
} from '../src/main/pi/cli-version'

const PUBLISHED = ['1.4.0', '1.5.0', '1.5.2', '1.6.0', '2.0.0', '1.7.0-beta.1']
const packument = (versions: string[], latest?: string) => ({
  ...(latest ? { 'dist-tags': { latest } } : { 'dist-tags': {} }),
  versions: Object.fromEntries(versions.map((v) => [v, {}]))
})

test('parseTriplet reads a plain version and refuses tags or prereleases', () => {
  assert.deepEqual(parseTriplet('1.6.0'), [1, 6, 0])
  assert.deepEqual(parseTriplet('v1.6.0'), [1, 6, 0])
  assert.equal(parseTriplet('1.7.0-beta.1'), null)
  assert.equal(parseTriplet('latest'), null)
  assert.equal(parseTriplet(''), null)
})

test('compareTriplet orders by major, then minor, then patch', () => {
  assert.equal(compareTriplet([1, 5, 2], [1, 6, 0]), -1)
  assert.equal(compareTriplet([2, 0, 0], [1, 9, 9]), 1)
  assert.equal(compareTriplet([1, 5, 2], [1, 5, 2]), 0)
})

// The rule this module exists for: what upstream calls current is the answer,
// not the greatest version some local range happens to allow.
test('the published latest tag wins over any local range idea', () => {
  assert.equal(pickLatestVersion(packument(PUBLISHED, '2.0.0')), '2.0.0')
  assert.equal(pickLatestVersion(packument(PUBLISHED, '1.6.0')), '1.6.0')
})

test('a latest tag naming a prerelease is still upstream\u2019s answer', () => {
  assert.equal(pickLatestVersion(packument(PUBLISHED, '2.0.0-rc.1')), '2.0.0-rc.1')
})

test('without a usable tag the greatest stable version stands in', () => {
  assert.equal(pickLatestVersion(packument(PUBLISHED)), '2.0.0')
  assert.equal(pickLatestVersion(packument(PUBLISHED, 'not-a-version')), '2.0.0')
  // A prerelease is never picked by the fallback.
  assert.equal(pickLatestVersion(packument(['1.6.0', '1.7.0-beta.1'])), '1.6.0')
  assert.equal(pickLatestVersion({}), null)
  assert.equal(pickLatestVersion(null), null)
})

test('the packument URL keeps the scope and escapes its slash', () => {
  assert.equal(
    packumentUrl('@earendil-works/pi-coding-agent'),
    'https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent'
  )
})

function fakeJson(body: unknown, init: { throw?: boolean } = {}): JsonGetter {
  return async () => {
    if (init.throw) throw new Error('network down')
    return body
  }
}

test('the registry lookup answers the published latest version', async () => {
  const latest = await fetchLatestCliVersionFromRegistry('@earendil-works/pi-coding-agent', {
    getJson: fakeJson(packument(PUBLISHED, '2.0.0'))
  })
  assert.equal(latest, '2.0.0')
})

test('a registry that cannot answer falls back to npm instead of throwing', async () => {
  assert.equal(
    await fetchLatestCliVersionFromRegistry('p', { getJson: fakeJson(null, { throw: true }) }),
    null
  )
  assert.equal(await fetchLatestCliVersionFromRegistry('p', { getJson: fakeJson({}) }), null)
  assert.equal(await fetchLatestCliVersionFromRegistry('p', { getJson: fakeJson(null) }), null)
})

test('the lookup asks the packument URL with npm\u2019s own accept header', async () => {
  let seen: { url?: string; headers?: Record<string, string> } = {}
  await fetchLatestCliVersionFromRegistry('@scope/pkg', {
    getJson: async (url, headers) => {
      seen = { url, headers }
      return packument(PUBLISHED, '1.6.0')
    }
  })
  assert.equal(seen.url, 'https://registry.npmjs.org/@scope%2Fpkg')
  assert.match(seen.headers?.accept ?? '', /application\/vnd\.npm\.install-v1\+json/)
})

test('only an unanswered check is described as a failure', () => {
  assert.equal(describeCheckFailure({ current: '1.5.2', hasUpdate: false }), null)
  assert.equal(describeCheckFailure({ current: '1.5.2', hasUpdate: false, error: '  ' }), null)
  assert.equal(
    describeCheckFailure({ current: '1.5.2', hasUpdate: false, error: 'npm view timed out after 8000ms' }),
    'npm view timed out after 8000ms'
  )
})

test('a bundled CLI is compared with the registry, and an update names both versions', async () => {
  const latestIs = (version: string) => async () => version
  assert.deepEqual(await readBundledCliStatus('1.6.0', 'bundled', latestIs('1.6.1')), {
    current: '1.6.0',
    latest: '1.6.1',
    hasUpdate: true
  })
  assert.deepEqual(await readBundledCliStatus('1.6.1', 'bundled', latestIs('1.6.1')), {
    current: '1.6.1',
    latest: '1.6.1',
    hasUpdate: false
  })
  assert.deepEqual(await readBundledCliStatus('1.7.0', 'bundled', latestIs('1.6.1')), {
    current: '1.7.0',
    latest: '1.6.1',
    hasUpdate: false
  })
})

test('a CLI the app does not own is never offered an update', async () => {
  let asked = 0
  const latest = async () => {
    asked += 1
    return '99.0.0'
  }
  for (const source of ['custom', 'path', 'none'] as const) {
    assert.deepEqual(await readBundledCliStatus('1.6.0', source, latest), {
      current: '1.6.0',
      hasUpdate: false
    })
  }
  assert.equal(asked, 0, 'a custom, PATH or missing CLI must not reach the registry')
})

test('a check that could not answer is named instead of reading as current', async () => {
  const status = await readBundledCliStatus('1.6.0', 'bundled', async () => {
    throw new Error('registry down')
  })
  assert.deepEqual(status, { current: '1.6.0', hasUpdate: false, error: 'registry down' })
  assert.equal(describeCheckFailure(status), 'registry down')
})
