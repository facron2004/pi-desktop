// Verify the packaged asar carries the 0.10.2 build: version, the main bundle
// and the new marketplace / project-order code paths.
const asar = require('@electron/asar')
const archive = 'release/win-unpacked/resources/app.asar'
const raw = asar.listPackage(archive)
const normalized = raw.map((entry) => entry.replace(/\\/g, '/'))
const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString())
console.log('packaged version:', pkg.version)
if (pkg.version !== '0.10.2') throw new Error(`expected package version 0.10.2, got ${pkg.version}`)
// `listPackage` reports Windows separators; `extractFile` wants the same spelling
// without its leading root separator, so use the normalized relative path.
const mainEntry = normalized.find((entry) => entry === '/out/main/index.js')
if (!mainEntry) throw new Error('the packaged asar has no out/main/index.js')
console.log('main bundle:', mainEntry)
const mainPath = mainEntry.slice(1).split('/').join(require('node:path').sep)
const main = asar.extractFile(archive, mainPath).toString()
for (const needle of ['marketplace:install', 'installMarketplaceEntry', 'projectOrder']) {
  const present = main.includes(needle)
  console.log(`  ${needle}:`, present ? 'present' : 'MISSING')
  if (!present) throw new Error(`the packaged main bundle is missing ${needle}`)
}
console.log('renderer files:', normalized.filter((entry) => entry.startsWith('/out/renderer/')).length)
const remoteFiles = normalized.filter((entry) => entry.startsWith('/out/remote/'))
console.log('remote files:', remoteFiles.length)
if (!remoteFiles.some((entry) => entry.endsWith('/index.html'))) {
  throw new Error('the packaged asar is missing the remote companion entry page')
}
console.log('asar entries:', raw.length)
