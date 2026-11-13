import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONNECTOR_RECIPES,
  buildConnectorChecklist,
  connectorCatalog,
  connectorRecipe
} from '../plugins/pm-connectors/src/connectors'

test('connector recipes have unique ids and every category', () => {
  assert.ok(CONNECTOR_RECIPES.length >= 10)
  assert.equal(new Set(CONNECTOR_RECIPES.map((recipe) => recipe.id)).size, CONNECTOR_RECIPES.length)
  for (const category of ['planning', 'docs', 'communication', 'analytics', 'support', 'crm']) {
    assert.ok(connectorCatalog(category as never).length > 0, category)
  }
})

test('connector lookup returns a recipe and rejects unknown ids', () => {
  assert.equal(connectorRecipe('jira')?.name, 'Jira')
  assert.equal(connectorRecipe('linear')?.name, 'Linear')
  assert.equal(connectorRecipe('not-a-source'), undefined)
})

test('catalog filters by category', () => {
  const analytics = connectorCatalog('analytics')
  assert.deepEqual(analytics.map((recipe) => recipe.id).sort(), ['amplitude', 'mixpanel'])
})

test('checklist includes read tools, write tools and privacy', () => {
  const jira = connectorRecipe('jira')
  assert.ok(jira)
  const checklist = buildConnectorChecklist(jira)
  assert.match(checklist, /Jira/)
  assert.match(checklist, /读能力/)
  assert.match(checklist, /search issues/)
  assert.match(checklist, /写能力（默认关闭）/)
  assert.match(checklist, /create issue/)
  assert.match(checklist, /隐私与权限/)
})

test('read-only connectors have no write tools', () => {
  for (const id of ['amplitude', 'mixpanel']) {
    const recipe = connectorRecipe(id)
    assert.ok(recipe)
    assert.deepEqual(recipe.writeTools, [])
    assert.match(buildConnectorChecklist(recipe), /只读连接器/)
  }
})

test('every recipe has setup fields and a privacy note', () => {
  for (const recipe of CONNECTOR_RECIPES) {
    assert.ok(recipe.requiredFields.length >= 2, recipe.id)
    assert.ok(recipe.setupSteps.length >= 2, recipe.id)
    assert.ok(recipe.privacy.length > 10, recipe.id)
  }
})
