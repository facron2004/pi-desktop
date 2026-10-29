import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RETRY_FLOOR, ensurePatientRetrySettings, raiseRetryBudget } from '../src/main/pi/retry-policy'
import { isRateLimitError, rateLimitRetryText } from '../src/renderer/src/lib/provider-error'

const RPM =
  'sensetime API error (429): {"message":"RPM (Requests Per Minute) limit of the model deepseek-v4-1-flash is exceeded. Please try again later","code":"ModelAccountRpmRateLimitExceeded"}'

test('a per-minute 429 is a rate limit, a quota error is not', () => {
  assert.equal(isRateLimitError(RPM), true)
  assert.equal(isRateLimitError('HTTP 500 overloaded'), false)
  assert.equal(isRateLimitError('429 insufficient_quota'), false)
  const line = rateLimitRetryText(RPM, 20_000)
  assert.equal(
    line,
    'Rate limit reached. Waiting 20s before retrying — this conversation stays open.'
  )
})

test('retry budget is raised to the floor and never lowered', () => {
  const missing = raiseRetryBudget({ theme: 'dark' })
  assert.equal(missing.changed, true)
  assert.deepEqual((missing.settings.retry as { maxRetries: number }).maxRetries, RETRY_FLOOR.maxRetries)
  assert.equal((missing.settings as { theme: string }).theme, 'dark')

  const alreadyHigher = raiseRetryBudget({
    retry: { enabled: false, maxRetries: 20, baseDelayMs: 30_000, maxAgentDelayMs: 180_000 }
  })
  assert.equal(alreadyHigher.changed, false)
  assert.equal((alreadyHigher.settings.retry as { enabled: boolean }).enabled, false)

  const partial = raiseRetryBudget({ retry: { enabled: true, maxRetries: 2, provider: { maxRetries: 0 } } })
  assert.equal(partial.changed, true)
  const retry = partial.settings.retry as {
    enabled: boolean
    maxRetries: number
    baseDelayMs: number
    provider: { maxRetries: number }
  }
  assert.equal(retry.enabled, true)
  assert.equal(retry.maxRetries, RETRY_FLOOR.maxRetries)
  assert.equal(retry.baseDelayMs, RETRY_FLOOR.baseDelayMs)
  assert.equal(retry.provider.maxRetries, 0)
})

test('patient retry settings are written before Pi starts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-retry-'))
  const file = path.join(dir, 'settings.json')
  try {
    writeFileSync(file, JSON.stringify({ retry: { enabled: true, maxRetries: 3 } }))
    ensurePatientRetrySettings(file)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      retry: { enabled: boolean; maxRetries: number; baseDelayMs: number; maxAgentDelayMs: number }
    }
    assert.equal(saved.retry.enabled, true)
    assert.equal(saved.retry.maxRetries, RETRY_FLOOR.maxRetries)
    assert.equal(saved.retry.baseDelayMs, RETRY_FLOOR.baseDelayMs)
    assert.equal(saved.retry.maxAgentDelayMs, RETRY_FLOOR.maxAgentDelayMs)

    ensurePatientRetrySettings(file)
    const again = JSON.parse(readFileSync(file, 'utf8')) as { retry: { maxRetries: number } }
    assert.equal(again.retry.maxRetries, RETRY_FLOOR.maxRetries)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
