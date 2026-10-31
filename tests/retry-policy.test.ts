import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RETRY_FLOOR, ensurePatientRetrySettings, forgetDefaultModel, raiseRetryBudget, rememberDefaultModel, rememberDefaultThinkingLevel } from '../src/main/pi/retry-policy'
import { isRateLimitError } from '../src/renderer/src/lib/provider-error'

const RPM =
  'sensetime API error (429): {"message":"RPM (Requests Per Minute) limit of the model deepseek-v4-1-flash is exceeded. Please try again later","code":"ModelAccountRpmRateLimitExceeded"}'

test('a per-minute 429 is a rate limit, a quota error is not', () => {
  assert.equal(isRateLimitError(RPM), true)
  assert.equal(isRateLimitError('HTTP 500 overloaded'), false)
  assert.equal(isRateLimitError('429 insufficient_quota'), false)
  for (const error of ['429 billing limit reached', '429 GoUsageLimitError', '429 FreeUsageLimitError', '429 enable available balance']) {
    assert.equal(isRateLimitError(error), false, error)
  }
})

test('the previous 20-second budget is upgraded to wait out an RPM window', () => {
  const { settings } = raiseRetryBudget({
    retry: { enabled: true, maxRetries: 8, baseDelayMs: 20_000, maxAgentDelayMs: 120_000 }
  })
  const retry = settings.retry as { baseDelayMs: number; maxAgentDelayMs: number }
  assert.equal(retry.baseDelayMs, 60_000)
  assert.ok(retry.maxAgentDelayMs >= retry.baseDelayMs)
  const longer = raiseRetryBudget({
    retry: { enabled: true, maxRetries: 20, baseDelayMs: 90_000, maxAgentDelayMs: 180_000 }
  })
  assert.equal(longer.changed, false)
})

test('retry budget is raised to the floor and never lowered', () => {
  const missing = raiseRetryBudget({ theme: 'dark' })
  assert.equal(missing.changed, true)
  assert.deepEqual((missing.settings.retry as { maxRetries: number }).maxRetries, RETRY_FLOOR.maxRetries)
  assert.equal((missing.settings as { theme: string }).theme, 'dark')

  const alreadyHigher = raiseRetryBudget({
    retry: { enabled: false, maxRetries: 20, baseDelayMs: 30_000, maxAgentDelayMs: 180_000 }
  })
  assert.equal(alreadyHigher.changed, true)
  const kept = alreadyHigher.settings.retry as { enabled: boolean; maxRetries: number }
  assert.equal(kept.enabled, true)
  assert.equal(kept.maxRetries, 20)

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

test('raising the retry budget keeps the saved provider and model', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-retry-provider-'))
  const file = path.join(dir, 'settings.json')
  try {
    writeFileSync(file, JSON.stringify({
      defaultProvider: 'sensetime',
      defaultModel: 'deepseek-flash',
      retry: { enabled: false, maxRetries: 1 }
    }))
    ensurePatientRetrySettings(file)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      defaultProvider: string
      defaultModel: string
      retry: { enabled: boolean; maxRetries: number }
    }
    assert.equal(saved.defaultProvider, 'sensetime')
    assert.equal(saved.defaultModel, 'deepseek-flash')
    assert.equal(saved.retry.enabled, true)
    assert.equal(saved.retry.maxRetries, RETRY_FLOOR.maxRetries)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a saved model is written into Pi settings and a cleared one is removed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-default-model-'))
  const file = path.join(dir, 'settings.json')
  try {
    writeFileSync(file, JSON.stringify({ theme: 'dark', retry: { enabled: false } }))
    rememberDefaultModel('sensetime/deepseek-flash', file)
    rememberDefaultModel('sensetime/deepseek-flash', file)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      theme: string
      defaultProvider: string
      defaultModel: string
      retry: { enabled: boolean }
    }
    assert.equal(saved.theme, 'dark')
    assert.equal(saved.defaultProvider, 'sensetime')
    assert.equal(saved.defaultModel, 'deepseek-flash')
    assert.equal(saved.retry.enabled, false)

    forgetDefaultModel(file)
    const cleared = JSON.parse(readFileSync(file, 'utf8')) as { theme: string; defaultProvider?: string; defaultModel?: string }
    assert.equal(cleared.theme, 'dark')
    assert.equal(cleared.defaultProvider, undefined)
    assert.equal(cleared.defaultModel, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a saved reasoning level is written into Pi settings and an unknown one is ignored', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-thinking-'))
  const file = path.join(dir, 'settings.json')
  try {
    writeFileSync(file, JSON.stringify({ defaultModel: 'deepseek-flash' }))
    rememberDefaultThinkingLevel('high', file)
    rememberDefaultThinkingLevel('nope', file)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { defaultModel: string; defaultThinkingLevel: string }
    assert.equal(saved.defaultModel, 'deepseek-flash')
    assert.equal(saved.defaultThinkingLevel, 'high')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
