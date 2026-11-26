import assert from 'node:assert/strict'
import { test } from 'node:test'
import { translate } from '../src/renderer/src/lib/i18n'
import { SETTINGS_PAGE_LABELS, SETTINGS_PAGE_IDS } from '../src/renderer/src/lib/settings-pages'
import { SETTINGS_SEARCH_ENTRIES, searchSettings } from '../src/renderer/src/lib/settings-search'

const pages = SETTINGS_PAGE_IDS.map((id) => ({ id, label: SETTINGS_PAGE_LABELS[id] }))
const zh = (text: string) => translate(text, 'zh-CN')
const en = (text: string) => text

test('a page name finds its page', () => {
  assert.deepEqual(searchSettings(pages, 'appearance', en).map((result) => result.page), ['appearance'])
  assert.deepEqual(searchSettings(pages, 'IM channels', en).map((result) => result.page), ['im-channels'])
})

test('a setting label finds the page that holds it', () => {
  const results = searchSettings(pages, 'auto-generate title', en)
  assert.deepEqual(results.map((result) => result.page), ['agent'])
  assert.equal(results[0].match, 'Auto-generate title')
})

test('a Chinese word finds the page too', () => {
  const results = searchSettings(pages, '字体', zh)
  assert.equal(results[0]?.page, 'appearance')
  assert.equal(results[0]?.match, '字体')
})

test('a translated page name finds its page', () => {
  assert.deepEqual(searchSettings(pages, '外观', zh).map((result) => result.page), ['appearance'])
})

test('the query ignores case and repeated spaces', () => {
  assert.equal(searchSettings(pages, '  TEXT   SIZE ', en)[0]?.page, 'appearance')
  assert.equal(searchSettings(pages, 'FEISHU', en)[0]?.page, 'im-channels')
})

test('an empty query lists every page in navigation order', () => {
  assert.deepEqual(
    searchSettings(pages, '   ', zh).map((result) => result.page),
    [...SETTINGS_PAGE_IDS]
  )
})

test('a query with no hit returns nothing', () => {
  assert.deepEqual(searchSettings(pages, 'quantum flux capacitor', en), [])
})

test('every indexed row points at a real page and has a Chinese label', () => {
  const known = new Set<string>(SETTINGS_PAGE_IDS)
  for (const entry of SETTINGS_SEARCH_ENTRIES) {
    assert.ok(known.has(entry.page), `${entry.page} is not a settings page`)
    assert.notEqual(translate(entry.label, 'zh-CN'), entry.label, `${entry.label} has no Chinese reading`)
    assert.ok(entry.keywords.length > 0, `${entry.label} has no keywords`)
  }
})

test('every page has at least two searchable rows', () => {
  for (const id of SETTINGS_PAGE_IDS) {
    const count = SETTINGS_SEARCH_ENTRIES.filter((entry) => entry.page === id).length
    assert.ok(count >= 2, `${id} has ${count} rows`)
  }
})
