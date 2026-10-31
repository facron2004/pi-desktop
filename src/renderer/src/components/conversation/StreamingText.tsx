import { memo } from 'react'
import { Markdown } from '../Markdown'

export interface StreamingTextProps {
  text: string
  /** Draws the blinking caret while the model is still writing. */
  streaming?: boolean
}

/**
 * The assistant's spoken text.
 *
 * It is a document block, not a chat bubble: the reply keeps the conversation
 * column and the trace indents beneath it. Memoised because a streaming turn
 * re-renders often and only the text itself changes.
 */
export const StreamingText = memo(function StreamingText({ text, streaming }: StreamingTextProps) {
  return (
    <div className="assistant__text">
      <Markdown>{text}</Markdown>
      {streaming ? <span className="caret-blink" aria-hidden="true" /> : null}
    </div>
  )
})
