import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  appendStreamingMarkdown,
  splitSettledMarkdown,
  splitStreamingMarkdown,
  type StreamingMarkdownSplit
} from '../../lib/streaming-markdown'
import { advanceReveal } from '../../lib/streaming-reveal'
import { prefersReducedMotion } from '../../lib/motion'
import { Markdown } from '../Markdown'

export interface StreamingTextProps {
  text: string
  /** Whether this text block is still streaming (used to defer code highlighting). */
  streaming?: boolean
  /** Progress spoken before a tool call uses quieter ink than the reply. */
  commentary?: boolean
}

/**
 * How much of a growing block to paint.
 *
 * The store owns the complete text; this is only a presentation cursor. It
 * matters when a provider hands over a paragraph in one delta — without it
 * the whole paragraph appears in a single frame. The cursor advances toward
 * `text.length`; once it catches up there is no timer left running, so a
 * normally streaming provider pays no extra work.
 *
 * The cursor is clamped to a line-safe cut when the block is still growing,
 * so a half-written Markdown construct is never parsed as a finished block.
 */
function useRevealedText(text: string, streaming: boolean): string {
  const reduceMotion = useMemo(() => prefersReducedMotion(), [])
  // A block that mounts already settled is a history message: show it whole.
  const [shown, setShown] = useState(() => (streaming && !reduceMotion ? 0 : text.length))
  const shownRef = useRef(shown)
  shownRef.current = shown
  const target = text.length
  const targetRef = useRef(target)
  targetRef.current = target
  const frameRef = useRef(0)
  const lastRef = useRef(0)

  useEffect(
    () => () => {
      if (frameRef.current !== 0) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = 0
      }
      lastRef.current = 0
    },
    []
  )

  useEffect(() => {
    if (reduceMotion) {
      if (frameRef.current !== 0) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = 0
      }
      lastRef.current = 0
      shownRef.current = target
      setShown(target)
      return
    }
    // A shorter text is a replacement (text_end is authoritative), not a delta.
    if (shownRef.current > target) {
      shownRef.current = 0
      lastRef.current = 0
      setShown(0)
    }
    // A settled block that is already fully revealed needs no timer at all.
    if (!streaming && shownRef.current >= target) return
    // Keep the running animation frame loop alive as deltas arrive so `lastRef`
    // measures real inter-frame elapsed time instead of resetting to 0 each frame.
    if (shownRef.current >= target || frameRef.current !== 0) return

    const tick = (now: number) => {
      frameRef.current = 0
      const currentTarget = targetRef.current
      if (shownRef.current > currentTarget) {
        shownRef.current = 0
        lastRef.current = 0
      }
      const elapsed = lastRef.current === 0 ? 16 : now - lastRef.current
      lastRef.current = now
      const next = advanceReveal(shownRef.current, currentTarget, elapsed)
      if (next !== shownRef.current) {
        shownRef.current = next
        setShown(next)
      }
      // Keep revealing even after streaming flips false: text_end and
      // message_end land in quick succession, and stopping here would make
      // a big chunk jump to its end just as it started appearing.
      if (next < currentTarget) {
        frameRef.current = requestAnimationFrame(tick)
      } else {
        lastRef.current = 0
      }
    }
    frameRef.current = requestAnimationFrame(tick)
  }, [streaming, reduceMotion, target])

  if (reduceMotion || (!streaming && shown >= target)) return text
  return text.slice(0, Math.min(shown, target))
}

/**
 * The assistant's spoken text.
 *
 * It is a document block, not a chat bubble: the reply keeps the conversation
 * column and the trace shares its left edge.
 *
 * While the block is still growing it is split into finished Markdown blocks
 * and a live tail, so a delta re-parses only the paragraph being written
 * instead of the whole reply. The finished blocks are wrapped in one `.md`
 * container, which keeps block spacing identical to a single document.
 */
export const StreamingText = memo(function StreamingText({
  text,
  streaming,
  commentary = false
}: StreamingTextProps) {
  const visible = useRevealedText(text, Boolean(streaming))
  // Keep code highlighting and settled-cache writes deferred while the
  // typewriter cursor is still moving, including the brief tail after
  // streaming flips false.
  const revealing = Boolean(streaming) || visible.length < text.length
  const previous = useRef<{ text: string; revealing: boolean; split: StreamingMarkdownSplit } | null>(null)
  const split = useMemo(() => {
    const cached = previous.current
    const next = cached && visible === cached.text && cached.revealing === revealing
      ? cached.split
      : cached && cached.revealing && revealing && visible.startsWith(cached.text)
        ? appendStreamingMarkdown(cached.split, visible.slice(cached.text.length))
        : revealing
          ? splitStreamingMarkdown(visible)
          : splitSettledMarkdown(visible)
    previous.current = { text: visible, revealing, split: next }
    return next
  }, [visible, revealing])
  const finishedBlocks = useMemo(
    () => split.blocks.map((block, index) => (
      <Markdown key={`block-${index}`} bare>
        {block}
      </Markdown>
    )),
    [split.blocks]
  )

  return (
    <div className="assistant__text" data-commentary={commentary || undefined}>
      <div className="md">
        {finishedBlocks}
        {split.tail ? (
          <Markdown key="tail" bare streaming={revealing}>
            {split.tail}
          </Markdown>
        ) : null}
      </div>
    </div>
  )
})
