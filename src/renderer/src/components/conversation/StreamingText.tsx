import { memo, useMemo, useRef } from 'react'
import {
  appendStreamingMarkdown,
  splitStreamingMarkdown,
  type StreamingMarkdownSplit
} from '../../lib/streaming-markdown'
import { Markdown } from '../Markdown'

export interface StreamingTextProps {
  text: string
  /** Whether this text block is still streaming (used to defer code highlighting). */
  streaming?: boolean
  /** Progress spoken before a tool call uses quieter ink than the reply. */
  commentary?: boolean
}

/**
 * The assistant's spoken text.
 *
 * It is a document block, not a chat bubble: the reply keeps the conversation
 * column and the trace indents beneath it.
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
  const previous = useRef<{ text: string; streaming: boolean; split: StreamingMarkdownSplit } | null>(null)
  const split = useMemo(() => {
    const cached = previous.current
    const next = cached && streaming && cached.streaming && text.startsWith(cached.text)
      ? appendStreamingMarkdown(cached.split, text.slice(cached.text.length))
      : splitStreamingMarkdown(text)
    previous.current = { text, streaming: Boolean(streaming), split: next }
    return next
  }, [text, streaming])
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
          <Markdown key="tail" bare streaming={streaming}>
            {split.tail}
          </Markdown>
        ) : null}
      </div>
    </div>
  )
})
