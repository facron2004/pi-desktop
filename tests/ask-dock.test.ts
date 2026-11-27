import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { askQuestionDetail } from '../src/renderer/src/lib/ask-question'
import {
  askDockHost,
  releaseAskDockHost,
  setAskDockHost,
  subscribeAskDock,
  type AskDockSurface
} from '../src/renderer/src/lib/ask-dock'

/**
 * A blocking question docks on the composer it belongs to.
 *
 * The dialog lives at the app root and the composers live in the conversation
 * branch, so the slot between them is a small store. Two things about it are
 * load-bearing and are checked here without a DOM:
 *
 * - a remount replaces the node inside one React commit, and the card must not
 *   flash back to a modal in between;
 * - the two surfaces (main and side) never answer each other's question.
 */

/** The store only ever holds the node and hands it back; a tag is enough. */
const slot = (name: string) => ({ name } as unknown as HTMLElement)

let cleanup: (() => void) | null = null

function record(surface: AskDockSurface): string[] {
  const seen: string[] = []
  cleanup = subscribeAskDock(() => {
    const host = askDockHost(surface) as unknown as { name: string } | null
    seen.push(host ? host.name : 'none')
  })
  // The test owns the listener for one call at a time.
  return seen
}

function reset(): void {
  cleanup?.()
  cleanup = null
  setAskDockHost('main', null)
  setAskDockHost('side', null)
}

test('a composer publishes its slot and clearing it notifies once', () => {
  reset()
  const main = slot('main-box')
  const seen = record('main')
  setAskDockHost('main', main)
  assert.equal(askDockHost('main'), main, 'the slot was not published')
  setAskDockHost('main', main)
  assert.deepEqual(seen, ['main-box'], 'republishing the same node notified again')
  setAskDockHost('main', null)
  assert.equal(askDockHost('main'), null, 'the slot survived its composer')
  assert.deepEqual(seen, ['main-box', 'none'], 'clearing the slot was not reported')
})

test('a remount swaps the node inside one commit without an empty frame', async () => {
  reset()
  const before = slot('old-box')
  const after = slot('new-box')
  setAskDockHost('main', before)
  const seen = record('main')
  // React detaches the old ref and attaches the new one in the same commit.
  releaseAskDockHost('main', before)
  setAskDockHost('main', after)
  await Promise.resolve()
  assert.equal(askDockHost('main'), after, 'the remounted composer lost the slot')
  assert.deepEqual(seen, ['new-box'], 'the card fell back to a modal mid-remount')
})

test('a composer that really goes away releases its own slot only', async () => {
  reset()
  const main = slot('main-box')
  setAskDockHost('main', main)
  releaseAskDockHost('main', slot('someone-else'))
  await Promise.resolve()
  assert.equal(askDockHost('main'), main, 'another node released a slot it never owned')
  releaseAskDockHost('main', main)
  await Promise.resolve()
  assert.equal(askDockHost('main'), null, 'the unmounted composer kept its slot')
})

test('the main and side composers keep their own slots', async () => {
  reset()
  const main = slot('main-box')
  const side = slot('side-box')
  setAskDockHost('main', main)
  setAskDockHost('side', side)
  assert.equal(askDockHost('main'), main)
  assert.equal(askDockHost('side'), side)
  releaseAskDockHost('side', side)
  await Promise.resolve()
  assert.equal(askDockHost('main'), main, 'the side panel took the main slot with it')
  assert.equal(askDockHost('side'), null)
  reset()
})

/**
 * The presentation itself is pinned where it cannot be measured from Node: the
 * card is portalled into the composer, a question is the only thing that
 * docks, and the dock is not a dimmed layer.
 */
const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), 'utf8')

test('a question is the only request that docks on the composer', () => {
  const dialog = read('src/renderer/src/components/ExtensionDialog.tsx')
  assert.match(dialog, /request\?\.method === 'select'/, 'the dock no longer checks the request method')
  assert.match(dialog, /!request\.approval/, 'a tool approval would dock on the composer')
  assert.match(dialog, /pendingSessions\.length <= 1/, 'several waiting conversations would share one dock')
  assert.match(dialog, /createPortal\(card, dockHost\)/, 'the card is no longer portalled into the composer')
  assert.match(
    dialog,
    /aria-modal=\{docked \? undefined : true\}/,
    'a docked question still announces itself as a modal'
  )
  // The modal contract stays for everything the protocol blocks the app with.
  assert.match(dialog, /<div className="modal-layer">\{card\}<\/div>/, 'the modal presentation is gone')
})

test('the dock rests on the composer and never dims the window', () => {
  const composer = read('src/renderer/src/components/Composer.tsx')
  const slotAt = composer.indexOf('<div className="composer-ask"')
  const boxAt = composer.indexOf('className="composer"', slotAt)
  assert.ok(slotAt > 0, 'the composer has no question slot')
  assert.ok(boxAt > slotAt, 'the question slot sits below the input box instead of on top of it')

  const css = read('src/renderer/src/styles/global.css')
  assert.match(css, /\.composer-ask:empty \{\s*display: none;/, 'an empty dock would hold a row open')
  assert.match(css, /:root \.composer-ask \.modal \{\s*width: 100%;/, 'a docked card keeps the modal width')
  // A question is a paragraph of choices, not a second column: the card narrows
  // to its own reading width and stays centred on the box.
  assert.match(
    css,
    /:root \.composer-ask \.modal \{[^}]*max-width: min\(100%, 560px\)/,
    'the docked card is not the compact sheet'
  )
  assert.match(css, /:root \.composer-ask \.modal \{[^}]*margin-inline: auto/, 'the docked card is not centred on the box')
  // The card wears the input's own surface and radius, one elevation step up,
  // and a dialog's banner rule is taken away: it is a card on the box, not a
  // sheet over the app.
  assert.match(css, /:root \.composer-ask \.modal \{[^}]*background: var\(--surface-raised\)/, 'the card dropped the input surface')
  assert.match(css, /:root \.composer-ask \.modal \{[^}]*border-radius: var\(--composer-radius\)/, 'the card dropped the input radius')
  assert.match(css, /:root \.composer-ask \.modal__icon \{\s*display: none;/, "a dialog's icon tile is still drawn on the card")
  // The dock is inside the page: no full-window layer, no scrim, no blur.
  const dock = css.slice(css.indexOf('* The question dock'), css.indexOf('* Switch'))
  assert.doesNotMatch(dock, /backdrop-filter|filter: blur|position: fixed|inset: 0|--scrim/)
})

test('a question offers numbered choices instead of a tick', () => {
  const dialog = read('src/renderer/src/components/ExtensionDialog.tsx')
  assert.match(
    dialog,
    /className="modal__option-mark" aria-hidden="true">\{index \+ 1\}</,
    'the option rows lost their number chips'
  )
  // The picked row says so with its own fill and hairline, not with a tick in
  // the chip, so the numbers survive the selection.
  const css = read('src/renderer/src/styles/global.css')
  assert.match(css, /\.modal__option-mark \{[^}]*font-variant-numeric: tabular-nums/, 'the number chip is not tabular')
  assert.match(css, /\.modal__option\[data-active='true'\] \.modal__option-mark \{[^}]*color: var\(--accent\)/, 'the picked row does not mark its number')
})

test('a question keeps an answer typed in its own words', () => {
  const dialog = read('src/renderer/src/components/ExtensionDialog.tsx')
  assert.match(dialog, /className="modal__answer-input"/, 'the card lost its own-words answer line')
  assert.match(
    dialog,
    /const typed = custom\.trim\(\)[\s\S]{0,160}?respondUi\(\{ value: typed \}/,
    'the typed answer is not the value the question is answered with'
  )
  assert.match(dialog, /className="modal__option modal__answer"/, 'the answer line is not a row of the card')
  // Typing clears the picked row, so only one of the two is ever set.
  assert.match(dialog, /if \(event\.target\.value\) setSelected\(null\)/, 'typing does not clear the picked choice')
})

test('the transcript shows a typed answer instead of a missing one', () => {
  const item = (details: unknown) => ({
    toolName: 'desktop_ask_user',
    args: { question: 'Which scope?', options: ['A', 'B'] },
    details
  } as unknown as Parameters<typeof askQuestionDetail>[0])
  assert.deepEqual(askQuestionDetail(item(undefined)), {
    question: 'Which scope?',
    options: ['A', 'B'],
    answer: null,
    custom: false,
    answered: false
  })
  assert.deepEqual(askQuestionDetail(item({ question: 'Which scope?', options: ['A', 'B'], answer: 'B' })), {
    question: 'Which scope?',
    options: ['A', 'B'],
    answer: 'B',
    custom: false,
    answered: true
  })
  // A typed answer is not one of the rows, so it carries its own reading.
  assert.deepEqual(
    askQuestionDetail(item({ question: 'Which scope?', options: ['A', 'B'], answer: 'Both, in that order', custom: true })),
    { question: 'Which scope?', options: ['A', 'B'], answer: 'Both, in that order', custom: true, answered: true }
  )
  // A record written before the flag existed still reads as typed: the answer
  // matches no offered label.
  assert.equal(askQuestionDetail(item({ question: 'Which scope?', options: ['A', 'B'], answer: 'Neither' }))?.custom, true)
  assert.deepEqual(askQuestionDetail(item({ question: 'Which scope?', options: ['A', 'B'], answer: null })), {
    question: 'Which scope?',
    options: ['A', 'B'],
    answer: null,
    custom: false,
    answered: true
  })
})
