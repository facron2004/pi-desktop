// Verify the packaged asar carries the current build: version, the main bundle
// and the expected application code paths.
const asar = require('@electron/asar')
const path = require('node:path')
const expectedVersion = require('../package.json').version
const archive = path.resolve(process.argv[2] ?? 'release/win-unpacked/resources/app.asar')
const raw = asar.listPackage(archive)
const normalized = raw.map((entry) => entry.replace(/\\/g, '/'))
const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString())
console.log('packaged version:', pkg.version)
if (pkg.version !== expectedVersion) {
  throw new Error(`expected package version ${expectedVersion}, got ${pkg.version}`)
}
// The entry loads separate app and setup chunks. Verify the bundles together.
const mainEntry = normalized.find((entry) => entry === '/out/main/index.js')
if (!mainEntry) throw new Error('the packaged asar has no out/main/index.js')
console.log('main bundle:', mainEntry)
const main = normalized
  .filter((entry) => entry.startsWith('/out/main/') && entry.endsWith('.js'))
  .map((entry) => asar.extractFile(archive, entry.slice(1).split('/').join(path.sep)).toString())
  .join('\n')
for (const needle of ['marketplace:install', 'installMarketplaceEntry', 'projectOrder']) {
  const present = main.includes(needle)
  console.log(`  ${needle}:`, present ? 'present' : 'MISSING')
  if (!present) throw new Error(`the packaged main bundle is missing ${needle}`)
}
for (const entry of ['/out/renderer/index.html', '/out/preload/setup.js', '/setup/index.html']) {
  if (!normalized.includes(entry)) throw new Error(`the packaged asar is missing ${entry}`)
}
console.log('renderer files:', normalized.filter((entry) => entry.startsWith('/out/renderer/')).length)
const remoteFiles = normalized.filter((entry) => entry.startsWith('/out/remote/'))
console.log('remote files:', remoteFiles.length)
if (!remoteFiles.some((entry) => entry.endsWith('/index.html'))) {
  throw new Error('the packaged asar is missing the remote companion entry page')
}
console.log('asar entries:', raw.length)
