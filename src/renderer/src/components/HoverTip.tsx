import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  HOVER_TIP_ID,
  NATIVE_TITLE_STASH,
  clipTipText,
  placeHoverTip,
  readTipText,
  windowShellBottom,
  restoreNativeTitle,
  suppressNativeTitle,
  tipIsRedundant,
  tipShape
} from '../lib/hover-tip'
import '../styles/hover-tip.css'

/**
 * One bubble for every native `title` tooltip in the window.
 *
 * The OS tooltip cannot be themed and it appears on its own timer, so the
 * title is lifted off the element while the pointer rests there and drawn
 * here instead. A title that only repeats text the control already shows in
 * full is not drawn — the words are already on the screen — but it is still
 * disarmed, or the OS bubble would answer in its place.
 *
 * The delay is long enough that crossing a toolbar does not flash a bubble,
 * and short once one is already up, so a row of icon buttons reads as one
 * family. The first one waits; the next one follows.
 */

const OPEN_DELAY = 480
const WARM_DELAY = 80
const WARM_WINDOW = 500
const POINTER_FOCUS_WINDOW_MS = 600
const DESCRIBED = 'data-pi-tip-described'

interface ShownTip {
  text: string
  mono: boolean
  wrap: boolean
  left: number
  top: number
  placed: boolean
  key: number
}

interface TipSession {
  host: HTMLElement | null
  /** The host whose tip a click dismissed. It stays down until the pointer leaves. */
  dismissed: HTMLElement | null
  openTimer: number | null
  observer: MutationObserver | null
  cursor: { x: number; y: number } | null
  lastShownAt: number
  /** A click focuses its target too. That focus must not open a second bubble. */
  lastPointerDown: number
  key: number
  fromPointer: boolean
  visible: boolean
  alive: boolean
}

function eventElement(node: EventTarget | null): Element | null {
  if (node instanceof Element) return node
  // A pointer event can report the text node inside a labelled control.
  if (node instanceof Text) return node.parentElement
  return null
}

function findTipHost(node: EventTarget | null): HTMLElement | null {
  const target = eventElement(node)
  if (!target) return null
  const el = target.closest<HTMLElement>(`[title], [${NATIVE_TITLE_STASH}]`)
  if (!(el instanceof HTMLElement)) return null
  if (el.closest('.hover-tip, .sidebar-tip')) return null
  if (el instanceof HTMLOptionElement || el instanceof HTMLOptGroupElement) return null
  if (el.isContentEditable) return null
  if (!readTipText(el)) return null
  return el
}

function overflows(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1
}

function labelState(host: HTMLElement): { text: string; truncated: boolean } {
  if (host.childElementCount > 40) return { text: '', truncated: true }
  let truncated = overflows(host)
  if (!truncated) {
    const nodes = host.querySelectorAll<HTMLElement>('*')
    const limit = Math.min(nodes.length, 24)
    for (let index = 0; index < limit; index += 1) {
      const node = nodes[index]
      if (node && overflows(node)) {
        truncated = true
        break
      }
    }
  }
  return { text: host.innerText.replace(/\s+/g, ' ').trim(), truncated }
}

/** A rich card is already describing this control. A second bubble would cover it. */
function describedElsewhere(host: HTMLElement): boolean {
  const ids = host.getAttribute('aria-describedby')
  if (!ids) return false
  for (const id of ids.split(/\s+/)) {
    if (!id || id === HOVER_TIP_ID) continue
    const node = document.getElementById(id)
    if (node?.getAttribute('role') === 'tooltip' && node.getClientRects().length > 0) return true
  }
  return false
}

/**
 * The file-change row opens its own preview above itself. The row's title is
 * the path, and a second bubble would land on that preview.
 */
function ownedByCustomFloat(host: HTMLElement): boolean {
  return Boolean(host.closest('.file-change') && document.querySelector('.file-change__preview'))
}

function skipVisual(host: HTMLElement, text: string): boolean {
  if (host.getAttribute('aria-expanded') === 'true') return true
  if (host.closest('.popover-wrap[data-open="true"]')) return true
  if (ownedByCustomFloat(host)) return true
  if (describedElsewhere(host)) return true
  const label = labelState(host)
  return tipIsRedundant(text, label.text, label.truncated)
}

function linkDescribed(host: HTMLElement): void {
  if (host.getAttribute(DESCRIBED)) return
  const existing = host.getAttribute('aria-describedby')
  if (!existing) {
    host.setAttribute('aria-describedby', HOVER_TIP_ID)
    host.setAttribute(DESCRIBED, 'set')
    return
  }
  if (!existing.split(/\s+/).includes(HOVER_TIP_ID)) {
    host.setAttribute('aria-describedby', `${existing} ${HOVER_TIP_ID}`)
    host.setAttribute(DESCRIBED, 'append')
  }
}

function unlinkDescribed(host: HTMLElement): void {
  const mode = host.getAttribute(DESCRIBED)
  if (!mode) return
  host.removeAttribute(DESCRIBED)
  const ids = (host.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter((id) => id && id !== HOVER_TIP_ID)
  if (mode === 'append' && ids.length > 0) host.setAttribute('aria-describedby', ids.join(' '))
  else host.removeAttribute('aria-describedby')
}

export function HoverTip() {
  const [tip, setTip] = useState<ShownTip | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const session = useRef<TipSession>({
    host: null,
    dismissed: null,
    openTimer: null,
    observer: null,
    cursor: null,
    lastShownAt: 0,
    lastPointerDown: 0,
    key: 0,
    fromPointer: false,
    visible: false,
    alive: true
  })

  useLayoutEffect(() => {
    const node = tipRef.current
    const host = session.current.host
    if (!tip || !node || !host || !host.isConnected) return
    const place = () => {
      const currentHost = session.current.host
      const panel = tipRef.current
      if (!currentHost || !panel || !currentHost.isConnected) return
      const rect = currentHost.getBoundingClientRect()
      if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
        return
      }
      const next = placeHoverTip(
        { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        { width: panel.offsetWidth, height: panel.offsetHeight },
        session.current.cursor,
        { width: window.innerWidth, height: window.innerHeight },
        8,
        8,
        windowShellBottom()
      )
      setTip((current) => {
        if (!current) return current
        if (current.placed && current.left === next.left && current.top === next.top) return current
        return { ...current, left: next.left, top: next.top, placed: true }
      })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [tip?.key, tip?.text])

  useEffect(() => {
    const state = session.current
    state.alive = true

    const clearTimer = () => {
      if (state.openTimer !== null) {
        window.clearTimeout(state.openTimer)
        state.openTimer = null
      }
    }

    const unwatch = () => {
      state.observer?.disconnect()
      state.observer = null
    }

    const hideVisual = () => {
      if (state.visible) state.lastShownAt = Date.now()
      state.visible = false
      if (state.host) unlinkDescribed(state.host)
      setTip(null)
    }

    const release = (host: HTMLElement) => {
      unwatch()
      unlinkDescribed(host)
      restoreNativeTitle(host)
      if (state.host === host) {
        state.host = null
        state.fromPointer = false
      }
    }

    const watch = (host: HTMLElement) => {
      unwatch()
      const observer = new MutationObserver(() => {
        if (!state.alive) return
        if (!host.isConnected) {
          clearTimer()
          hideVisual()
          release(host)
          return
        }
        if (state.fromPointer || state.visible) suppressNativeTitle(host)
        if (!state.visible) return
        if (host.getAttribute('aria-expanded') === 'true' || ownedByCustomFloat(host)) {
          hideVisual()
          return
        }
        const text = clipTipText(readTipText(host))
        if (!text) {
          hideVisual()
          return
        }
        const shape = tipShape(text)
        setTip((current) => {
          if (!current || (current.text === text && current.mono === shape.mono && current.wrap === shape.wrap)) {
            return current
          }
          return { ...current, text, mono: shape.mono, wrap: shape.wrap, placed: false }
        })
      })
      observer.observe(host, { attributes: true, attributeFilter: ['title', 'aria-expanded'] })
      state.observer = observer
    }

    const show = () => {
      if (!state.alive) return
      state.openTimer = null
      const host = state.host
      if (!host || !host.isConnected) {
        if (host) release(host)
        return
      }
      suppressNativeTitle(host)
      const text = clipTipText(readTipText(host))
      if (!text || skipVisual(host, text)) {
        hideVisual()
        return
      }
      linkDescribed(host)
      state.visible = true
      state.lastShownAt = Date.now()
      state.key += 1
      const shape = tipShape(text)
      setTip({
        text,
        mono: shape.mono,
        wrap: shape.wrap,
        left: 0,
        top: 0,
        placed: false,
        key: state.key
      })
    }

    const engage = (host: HTMLElement, fromPointer: boolean) => {
      if (host === state.host || host === state.dismissed) return
      const warm = state.visible || Date.now() - state.lastShownAt < WARM_WINDOW
      clearTimer()
      if (state.host) {
        hideVisual()
        release(state.host)
      }
      state.host = host
      state.dismissed = null
      state.fromPointer = fromPointer
      if (!fromPointer) state.cursor = null
      if (fromPointer) suppressNativeTitle(host)
      watch(host)
      state.openTimer = window.setTimeout(show, warm ? WARM_DELAY : OPEN_DELAY)
    }

    const onPointerOver = (event: PointerEvent) => {
      state.cursor = { x: event.clientX, y: event.clientY }
      const host = findTipHost(event.target)
      if (!host) return
      engage(host, true)
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!state.host) return
      state.cursor = { x: event.clientX, y: event.clientY }
    }

    const onPointerOut = (event: PointerEvent) => {
      const host = state.host
      if (!host) return
      const next = event.relatedTarget
      if (next instanceof Node && host.contains(next)) return
      if (!(event.target instanceof Node) || !host.contains(event.target)) return
      clearTimer()
      state.dismissed = null
      hideVisual()
      release(host)
    }

    const onPointerDown = () => {
      state.lastPointerDown = Date.now()
      if (!state.host) return
      clearTimer()
      state.dismissed = state.host
      hideVisual()
    }

    const onFocusIn = (event: FocusEvent) => {
      // A click focuses the control under the pointer, and so does a test that
      // calls `element.click()`. `:focus-visible` is only set for a keyboard
      // focus, which is the one that has no pointer hover to explain the control.
      if (Date.now() - state.lastPointerDown < POINTER_FOCUS_WINDOW_MS) return
      const host = findTipHost(event.target)
      if (!host || !host.matches(':focus-visible')) return
      engage(host, false)
    }

    const onFocusOut = (event: FocusEvent) => {
      const host = state.host
      if (!host || state.fromPointer) return
      const next = event.relatedTarget
      if (next instanceof Node && host.contains(next)) return
      clearTimer()
      state.dismissed = null
      hideVisual()
      release(host)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      clearTimer()
      state.dismissed = state.host
      hideVisual()
    }

    const onScroll = () => {
      if (!state.host && !state.visible) return
      clearTimer()
      hideVisual()
    }

    const onBlur = () => {
      clearTimer()
      state.dismissed = null
      hideVisual()
      if (state.host) release(state.host)
    }

    document.addEventListener('pointerover', onPointerOver, true)
    document.addEventListener('pointermove', onPointerMove, true)
    document.addEventListener('pointerout', onPointerOut, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('focusout', onFocusOut, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', onBlur)

    return () => {
      state.alive = false
      clearTimer()
      hideVisual()
      if (state.host) release(state.host)
      document.removeEventListener('pointerover', onPointerOver, true)
      document.removeEventListener('pointermove', onPointerMove, true)
      document.removeEventListener('pointerout', onPointerOut, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', onFocusOut, true)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  if (!tip) return null

  return createPortal(
    <div
      ref={tipRef}
      id={HOVER_TIP_ID}
      key={tip.key}
      role="tooltip"
      className="hover-tip"
      data-placed={tip.placed ? 'true' : undefined}
      data-wrap={tip.wrap ? 'true' : undefined}
      data-mono={tip.mono ? 'true' : undefined}
      style={{
        left: tip.left,
        top: tip.top,
        visibility: tip.placed ? 'visible' : 'hidden'
      }}
    >
      {tip.text}
    </div>,
    document.body
  )
}
