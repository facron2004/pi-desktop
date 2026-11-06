// Verify the packaged asar carries the 0.9.0 build: version, the main bundle
// and the new marketplace / project-order code paths.
const asar = require('@electron/asar')
const archive = 'release/win-unpacked/resources/app.asar'
const raw = asar.listPackage(archive)
const normalized = raw.map((entry) => entry.replace(/\\/g, '/'))
const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString())
console.log('packaged version:', pkg.version)
// `listPackage` reports Windows separators; `extractFile` wants the same spelling
// it was handed, so the raw entry is what gets read back.
const mainEntry = raw.find((entry) => entry.replace(/\\/g, '/') === '/out/main/index.js')
if (!mainEntry) throw new Error('the packaged asar has no out/main/index.js')
console.log('main bundle:', mainEntry)
const main = asar.extractFile(archive, mainEntry).toString()
for (const needle of ['marketplace:install', 'installMarketplaceEntry', 'projectOrder']) {
  console.log(`  ${needle}:`, main.includes(needle) ? 'present' : 'MISSING')
}
console.log('renderer files:', normalized.filter((entry) => entry.startsWith('/out/renderer/')).length)
console.log('remote files:', normalized.filter((entry) => entry.startsWith('/out/remote/')).length)
console.log('asar entries:', raw.length)
