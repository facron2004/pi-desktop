import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeHtml, parsePiCatalogHtml } from '../src/main/pi-catalog'
import { formatDownloads } from '../src/shared/marketplace'

const CARD = `
<article class="surface-panel content-card" data-package-card="true"
  data-package-name="pi-web-access"
  data-package-search="pi-web-access web search"
  data-package-types="extension"
  data-package-downloads="1328209"
  data-package-date="1793840727574"
  data-package-sort-name="pi-web-access">
  <div class="packages-card-body">
    <h3 class="packages-name"><a href="/packages/pi-web-access" data-package-link="true">pi-web-access</a></h3>
    <p class="packages-desc">Web search, URL fetching &amp; more for Pi.</p>
    <div class="packages-meta"><span>nicopreme</span><span>1.3M/mo</span><span>8d ago</span></div>
    <div class="packages-badges"><span class="meta-chip packages-badge" data-type="extension">extension</span></div>
    <div class="packages-links">
      <a href="https://www.npmjs.com/package/pi-web-access" target="_blank">npm</a>
      <a href="https://github.com/nicobailon/pi-web-access" target="_blank">repo</a>
    </div>
    <div class="packages-install"><code>$ pi install npm:pi-web-access</code></div>
  </div>
</article>`

test('a catalog card becomes one installable package entry', () => {
  const parsed = parsePiCatalogHtml(`<span class="packages-count">1-50 / 5398</span>${CARD}`)
  assert.equal(parsed.total, 5398)
  assert.equal(parsed.entries.length, 1)
  const entry = parsed.entries[0]
  assert.equal(entry.id, 'pi-web-access')
  assert.equal(entry.kind, 'plugin')
  assert.equal(entry.packageType, 'extension')
  assert.equal(entry.downloads, 1328209)
  assert.equal(entry.author, 'nicopreme')
  assert.equal(entry.repo, 'nicobailon/pi-web-access')
  assert.equal(entry.install, 'npm:pi-web-access')
  assert.equal(entry.npmPackage, 'pi-web-access')
  assert.equal(entry.source, 'pi')
  assert.equal(entry.description, 'Web search, URL fetching & more for Pi.')
  assert.equal(entry.updatedAt, new Date(1793840727574).toISOString())
  assert.equal(entry.url, 'https://pi.dev/packages/pi-web-access')
})

test('a filtered catalog count reports the filtered total', () => {
  const parsed = parsePiCatalogHtml(
    `<span class="packages-count">1-14 / 14 (of 5398)</span>${CARD}`
  )
  assert.equal(parsed.total, 14)
})

test('a skill card maps to the skill tab', () => {
  const parsed = parsePiCatalogHtml(
    CARD.replace('data-package-name="pi-web-access"', 'data-package-name="my-skill"')
      .replace('data-type="extension"', 'data-type="skill"')
  )
  assert.equal(parsed.entries[0].kind, 'skill')
  assert.equal(parsed.entries[0].packageType, 'skill')
})

test('html entities in descriptions and attributes are decoded', () => {
  assert.equal(decodeHtml('A &amp; B &#39;quoted&#39;'), "A & B 'quoted'")
  const parsed = parsePiCatalogHtml(CARD.replace('data-package-name="pi-web-access"', 'data-package-name="a&amp;b"'))
  assert.equal(parsed.entries[0].id, 'a&b')
})

test('downloads are formatted the way the catalog states them', () => {
  assert.equal(formatDownloads(3_257_276), '3.3M/mo')
  assert.equal(formatDownloads(173_700), '174k/mo')
  assert.equal(formatDownloads(900), '900/mo')
  assert.equal(formatDownloads(0), '—')
})
