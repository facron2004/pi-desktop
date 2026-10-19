/**
 * Generate the application icon.
 *
 * Renders the Pi mark in a headless Electron window and writes
 * `build/icon.png` (512x512, transparent outside the rounded square).
 * electron-builder converts it to .ico / .icns for the target platforms.
 *
 * Run with: node scripts/make-icon.mjs
 */
import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outDir = path.join(root, 'build')
const outFile = path.join(outDir, 'icon.png')

const SIZE = 512

const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; padding: 0; background: transparent; }
      .icon {
        width: ${SIZE}px;
        height: ${SIZE}px;
        border-radius: 112px;
        background: linear-gradient(150deg, #f7b878 0%, #f0a868 42%, #cf6f27 100%);
        display: grid;
        place-items: center;
        box-shadow: inset 0 -10px 30px rgba(120, 55, 0, 0.28),
                    inset 0 8px 24px rgba(255, 235, 210, 0.35);
      }
      .mark {
        font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
        font-weight: 700;
        font-size: 300px;
        line-height: 1;
        color: #24160a;
        transform: translateY(-6px);
        text-shadow: 0 3px 0 rgba(255, 240, 220, 0.28);
      }
    </style>
  </head>
  <body>
    <div class="icon"><span class="mark">π</span></div>
  </body>
</html>`

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true }
  })

  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((resolve) => setTimeout(resolve, 600))

  const image = await window.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
  const png = image.toPNG()

  mkdirSync(outDir, { recursive: true })
  writeFileSync(outFile, png)
  console.log(`icon written: ${outFile} (${png.length} bytes)`)

  app.exit(0)
})
