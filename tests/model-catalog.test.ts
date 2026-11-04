import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  getModelThinkingLevels,
  invalidateModelThinkingLevels,
  supportedThinkingLevels
} from '../src/main/pi/model-catalog'

const root = mkdtempSync(path.join(tmpdir(), 'pi-desktop-model-catalog-'))
const builtinDirectory = path.join(root, 'builtin')
const modelsFile = path.join(root, 'models.json')
mkdirSync(builtinDirectory)

writeFileSync(
  path.join(builtinDirectory, 'anthropic.json'),
  JSON.stringify({
    'anthropic-messages': {
      'chat:claude-x': {
        id: 'claude-x',
        provider: 'anthropic',
        reasoning: true,
        thinkingLevelMap: { xhigh: 'xhigh' }
      },
      'chat:claude-off': { id: 'claude-off', provider: 'anthropic', reasoning: false }
    }
  })
)

function writeModels(providers: unknown): void {
  writeFileSync(modelsFile, JSON.stringify({ providers }))
}

beforeEach(() => {
  invalidateModelThinkingLevels()
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

test('a custom provider uses its own thinkingLevelMap', async () => {
  writeModels({
    magpie: {
      models: [
        {
          id: 'codex/gpt-6.1-terra',
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: 'low',
            medium: 'medium',
            high: 'high',
            xhigh: 'xhigh',
            max: 'max'
          }
        }
      ]
    }
  })
  assert.deepEqual(
    await getModelThinkingLevels('magpie', 'codex/gpt-6.1-terra', { builtinDirectory, modelsFile }),
    ['low', 'medium', 'high', 'xhigh', 'max']
  )
})

test('a built-in provider falls back to the bundled catalog', async () => {
  writeModels({})
  assert.deepEqual(
    await getModelThinkingLevels('anthropic', 'claude-x', { builtinDirectory, modelsFile }),
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
  )
})

test('modelOverrides merge over the base model field by field', async () => {
  writeModels({
    anthropic: {
      modelOverrides: {
        'claude-x': { thinkingLevelMap: { minimal: null } }
      }
    }
  })
  assert.deepEqual(
    await getModelThinkingLevels('anthropic', 'claude-x', { builtinDirectory, modelsFile }),
    ['off', 'low', 'medium', 'high', 'xhigh']
  )
})

test('a non-reasoning model only offers off', async () => {
  writeModels({
    magpie: { models: [{ id: 'plain', reasoning: false }] }
  })
  assert.deepEqual(
    await getModelThinkingLevels('magpie', 'plain', { builtinDirectory, modelsFile }),
    ['off']
  )
  assert.deepEqual(supportedThinkingLevels({ reasoning: false }), ['off'])
})

test('an unknown model reports no levels instead of guessing', async () => {
  writeModels({})
  assert.deepEqual(
    await getModelThinkingLevels('nobody', 'nothing', { builtinDirectory, modelsFile }),
    []
  )
})

test('invalidation re-reads models.json', async () => {
  writeModels({
    magpie: {
      models: [
        {
          id: 'm',
          reasoning: true,
          thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high' }
        }
      ]
    }
  })
  assert.deepEqual(await getModelThinkingLevels('magpie', 'm', { builtinDirectory, modelsFile }), [
    'low',
    'high'
  ])
  writeModels({ magpie: { models: [{ id: 'm', reasoning: false }] } })
  assert.deepEqual(await getModelThinkingLevels('magpie', 'm', { builtinDirectory, modelsFile }), [
    'low',
    'high'
  ])
  invalidateModelThinkingLevels()
  assert.deepEqual(await getModelThinkingLevels('magpie', 'm', { builtinDirectory, modelsFile }), ['off'])
})
