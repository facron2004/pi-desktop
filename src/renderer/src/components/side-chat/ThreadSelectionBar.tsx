import { memo, useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { MessagesSquare } from 'lucide-react'
import { MAX_SIDE_CHAT_SNIPPET_CHARS } from '@shared/side-chat'
import { dispatchOpenSideChat } from '../../lib/side-chat-context'
import { useT } from '../../lib/i18n'

interface SelectionTarget {
  snippet: string
  turnId?: string
  source: 'user' | 'assistant' | 'tool' | 'thinking'
  left: number
  top: number
}

function classifySelectionSource(
  node: Element
): 'user' | 'assistant' | 'tool' | 'thinking' | null {
  if (node.closest('.user-msg__bubble')) return 'user'
  if (node.closest('.thinking__body')) return 'thinking'
  if (node.closest('.tool__body')) return 'tool'
  if (node.closest('.assistant__text')) return 'assistant'
  return null
}

function elementOfNode(node: Node | null): Element | null {
  if (!node) return null
  return node instanceof Element ? node : node.parentElement
}

export const ThreadSelectionBar = memo(function ThreadSelectionBar({
  containerRef
}: {
  containerRef: RefObject<HTMLDivElement | null>
}) {
  const t = useT()
  const [target, setTarget] = useState<SelectionTarget | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  const readSelection = useCallback(() => {
    const container = containerRef.current
    const selection = document.getSelection()
    if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      setTarget(null)
      return
    }
    const anchorEl = elementOfNode(selection.anchorNode)
    const focusEl = elementOfNode(selection.focusNode)
    if (!anchorEl || !focusEl) {
      setTarget(null)
      return
    }
    if (!container.contains(anchorEl) || !container.contains(focusEl)) {
      setTarget(null)
      return
    }
    if (anchorEl.closest('input, textarea') || focusEl.closest('input, textarea')) {
      setTarget(null)
      return
    }
    const source = classifySelectionSource(anchorEl) ?? classifySelectionSource(focusEl)
    if (!source) {
      setTarget(null)
      return
    }
    const rawText = selection.toString().trim()
    if (!rawText) {
      setTarget(null)
      return
    }
    const range = selection.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) {
      setTarget(null)
      return
    }
    const containerRect = container.getBoundingClientRect()
    if (rect.bottom < containerRect.top || rect.top > containerRect.bottom) {
      setTarget(null)
      return
    }

    const turnNode =
      anchorEl.closest<HTMLElement>('[data-turn]') ??
      focusEl.closest<HTMLElement>('[data-turn]')
    const turnId = turnNode?.dataset.turn
    const snippet =
      rawText.length > MAX_SIDE_CHAT_SNIPPET_CHARS
        ? `${rawText.slice(0, MAX_SIDE_CHAT_SNIPPET_CHARS - 1)}…`
        : rawText

    const centerX = rect.left + rect.width / 2
    const clampedLeft = Math.min(Math.max(84, centerX), Math.max(84, window.innerWidth - 84))
    const preferredTop = rect.top - 8
    const clampedTop = preferredTop < 48 ? rect.bottom + 36 : preferredTop

    setTarget({
      snippet,
      turnId,
      source,
      left: Math.round(clampedLeft),
      top: Math.round(clampedTop)
    })
  }, [containerRef])

  useEffect(() => {
    let frame = 0
    const scheduleRead = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(readSelection)
    }

    const onPointerDown = (event: PointerEvent) => {
      const node = event.target as Node | null
      if (node && barRef.current?.contains(node)) return
      setTarget(null)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTarget(null)
    }

    const onScroll = () => setTarget(null)

    document.addEventListener('selectionchange', scheduleRead)
    document.addEventListener('pointerup', scheduleRead)
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onScroll)
    const container = containerRef.current
    container?.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', scheduleRead)
      document.removeEventListener('pointerup', scheduleRead)
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onScroll)
      container?.removeEventListener('scroll', onScroll)
    }
  }, [containerRef, readSelection])

  if (!target) return null

  return createPortal(
    <div
      ref={barRef}
      className="thread-selection-bar"
      style={{ left: target.left, top: target.top }}
      onMouseDown={(event) => {
        event.preventDefault()
      }}
    >
      <button
        type="button"
        className="thread-selection-bar__btn"
        onClick={() => {
          const snapshot = target
          setTarget(null)
          document.getSelection()?.removeAllRanges()
          dispatchOpenSideChat({
            mode: 'open',
            focus: true,
            reference: {
              kind: 'selection',
              turnId: snapshot.turnId,
              source: snapshot.source,
              snippet: snapshot.snippet
            }
          })
        }}
      >
        <MessagesSquare size={13} aria-hidden="true" />
        <span>{t('Ask Side Chat')}</span>
      </button>
    </div>,
    document.body
  )
})
