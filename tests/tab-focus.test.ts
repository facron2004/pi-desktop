import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { tabIndexAfterClose } from '../src/renderer/src/lib/tab-focus'

/**
 * The keyboard used to fall out of a tab strip when a tab closed.
 *
 * A tab's close button is a Tab stop of its own. Pressing Enter on it removes
 * the node that holds focus, so the browser puts the keyboard on `<body>` and
 * the next Tab starts at the top of the application instead of beside the tab
 * the reader just closed. Both strips — the tools panel's pages and the
 * terminal's shells — keep the keyboard in the strip now, and closing the
 * panel's last page hands it to the corner toggle that opens the panel again.
 */

test('the tab that takes a closed tab\'s place takes the keyboard too', () => {
  // Closing the first of three leaves two: the one now first is the landing spot.
  assert.equal(tabIndexAfterClose(0, 3), 0)
  // A middle tab hands the keyboard to the tab that moves into its place.
  assert.equal(tabIndexAfterClose(1, 3), 1)
  // The last tab has no successor, so the new last tab takes it.
  assert.equal(tabIndexAfterClose(2, 2), 1)
  // Closing the first of two leaves the only one.
  assert.equal(tabIndexAfterClose(0, 1), 0)
  // Nothing left to focus: the caller closes the panel instead.
  assert.equal(tabIndexAfterClose(0, 0), -1)
  // A tab that is not in the strip is not a position to land on.
  assert.equal(tabIndexAfterClose(-1, 3), -1)
  // A stale index past the end still resolves to a real tab.
  assert.equal(tabIndexAfterClose(5, 2), 1)
})

test('both tab strips move the keyboard when a tab closes', () => {
  const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), 'utf8')
  const toolPanel = read('src/renderer/src/components/ToolPanel.tsx')
  const terminal = read('src/renderer/src/components/TerminalPanel.tsx')
  const app = read('src/renderer/src/App.tsx')

  assert.match(
    toolPanel,
    /remaining\[tabIndexAfterClose\(index, remaining\.length\)\]/,
    'the tools panel tab strip no longer finds the tab that takes a closed one\'s place'
  )
  assert.match(
    toolPanel,
    /focusTab\(fallback\)/,
    'closing a tools-panel page drops the keyboard with the button that closed it'
  )
  assert.match(
    terminal,
    /focusIndex = tabIndexAfterClose\(index, next\.length\)/,
    'the terminal tab strip no longer finds the tab that takes a closed one\'s place'
  )
  assert.match(
    terminal,
    /querySelectorAll<HTMLElement>\('\[role="tab"\]'\)/,
    'closing a background terminal tab no longer returns the keyboard to the strip'
  )
  assert.match(
    app,
    /panelToggleRef\.current\?\.focus\(\)/,
    'closing the tools panel no longer returns the keyboard to its corner toggle'
  )
  assert.match(
    app,
    /active\.closest\('\.tool-panel'\)/,
    'a close from outside the panel must not pull the keyboard away from where the reader put it'
  )
})

test('the terminal copies its selection from the keyboard', () => {
  const terminal = readFileSync(
    path.resolve(process.cwd(), 'src/renderer/src/components/TerminalPanel.tsx'),
    'utf8'
  )
  // The pane had a Copy button and no key: a reader without a pointer could
  // not take a command's output anywhere.
  assert.match(terminal, /attachCustomKeyEventHandler/)
  assert.match(terminal, /info\?\.platform === 'darwin'/)
  // With nothing selected the chord keeps its shell meaning (Ctrl+C interrupts).
  assert.match(terminal, /if \(!selected\) return true/)
  assert.match(terminal, /navigator\.clipboard\.writeText\(selected\)/)
  // xterm scrolls a page on its own; the ends of the buffer are ours.
  assert.match(terminal, /term\.scrollToTop\(\)/)
  assert.match(terminal, /term\.scrollToBottom\(\)/)
  assert.match(terminal, /event\.key === 'Home'/)
  // An explicit paste chord: the clipboard read feeds xterm's own paste, and
  // the key is prevented so the browser does not insert the text a second time.
  assert.match(terminal, /navigator\.clipboard\.readText\(\)/)
  assert.match(terminal, /term\.paste\(text\)/)
  assert.match(terminal, /event\.preventDefault\(\)/)
})

test('the terminal right-click menu is keyboard-complete', () => {
  const terminal = readFileSync(
    path.resolve(process.cwd(), 'src/renderer/src/components/TerminalPanel.tsx'),
    'utf8'
  )
  // The pointer had no menu over the shell at all: the only copy and clear
  // controls were icons in the toolbar, and there was no paste.
  assert.match(terminal, /onContextMenu=/)
  assert.match(terminal, /className="terminal__menu"/)
  assert.match(terminal, /role="menu"/)
  // Copy is only offered when there is a selection to copy.
  assert.match(terminal, /disabled=\{!menu\.selection\.trim\(\)\}/)
  // Escape closes it and hands the keyboard back to the shell.
  assert.match(terminal, /event\.key !== 'Escape'/)
  assert.match(terminal, /closeMenu\(true\)/)
})

test('a panel page loads its own stylesheet', () => {
  const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), 'utf8')
  // The images and browser pages are pages of the tools panel now. Their
  // stylesheet was imported by the Inspector, which no longer renders them, so
  // both ran completely unstyled: no checkerboard, no fitted picture, a raw
  // address bar. Each view imports what it draws, like the terminal does.
  for (const file of [
    'src/renderer/src/components/ImageViewer.tsx',
    'src/renderer/src/components/BrowserView.tsx'
  ]) {
    assert.match(read(file), /import '\.\.\/styles\/browser-and-images\.css'/, file)
  }
  assert.doesNotMatch(
    read('src/renderer/src/components/InspectorPanel.tsx'),
    /browser-and-images\.css/
  )
})

test('the picture stage zooms from the keyboard', () => {
  const viewer = readFileSync(
    path.resolve(process.cwd(), 'src/renderer/src/components/ImageViewer.tsx'),
    'utf8'
  )
  // A screenshot whose text is unreadable at panel width: fit, 100%, and the
  // steps between, reachable from the stage's own keys.
  assert.match(viewer, /const ZOOM_STEPS = \[/)
  assert.match(viewer, /data-zoom=\{zoom === 'fit' \? 'fit' : 'custom'\}/)
  assert.match(viewer, /key === '\+' \|\| key === '='/)
  assert.match(viewer, /key === '0'/)
  assert.match(viewer, /setZoom\('fit'\)/)
})