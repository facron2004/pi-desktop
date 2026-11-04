import { memo, useMemo } from 'react'
import { splitStreamingMarkdown } from '../../lib/streaming-markdown'
import { Markdown } from '../Markdown'

export interface StreamingTextProps {
  text: string
  /** Whether this text block is still streaming (used to defer code highlighting). */
  streaming?: boolean
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
export const StreamingText = memo(function StreamingText({ text, streaming }: StreamingTextProps) {
  const split = useMemo(() => splitStreamingMarkdown(text), [text])

  if (split.blocks.length > 0) {
    return (
      <div className="assistant__text">
        <div className="md">
          {split.blocks.map((block, index) => (
            <Markdown key={`block-${index}`} bare>
              {block}
            </Markdown>
          ))}
          {split.tail ? (
            <Markdown key="tail" bare streaming={streaming}>
              {split.tail}
            </Markdown>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="assistant__text">
      <Markdown streaming={streaming}>{text}</Markdown>
    </div>
  )
})
