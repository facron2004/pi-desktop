/**
 * Generate the platform-neutral application icon.
 *
 * `build/icon-geometric.png` is the 1254px master (the supplied geometric Pi
 * mark on its square canvas). This downsamples that same artwork into
 * `build/icon.png`, the 512px image electron-builder uses for platforms that
 * do not take the Windows `.ico`.
 *
 * Run with: npm run icon
 */
import { app, nativeImage } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outDir = path.join(root, 'build')
const sourceFile = path.join(outDir, 'icon-geometric.png')
const outFile = path.join(outDir, 'icon.png')

const SIZE = 512

app.whenReady().then(() => {
  const source = nativeImage.createFromPath(sourceFile)
  if (source.isEmpty()) {
    console.error(`icon source missing: ${sourceFile}`)
    app.exit(1)
    return
  }

  const image = source.resize({ width: SIZE, height: SIZE, quality: 'best' })
  const png = image.toPNG()

  mkdirSync(outDir, { recursive: true })
  writeFileSync(outFile, png)
  console.log(`icon written: ${outFile} (${png.length} bytes)`)

  app.exit(0)
})
