import { useState } from 'react'

/**
 * A value that belongs to one conversation, read before paint.
 *
 * The stream reuses a row when only the conversation key changes. Resetting in
 * an effect paints one frame of the previous conversation — the frame a reader
 * and the UI suite actually see. React restarts this render before painting.
 */
export function useConversationValue<T>(scope: string, read: () => T): [T, (value: T) => void] {
  const [seen, setSeen] = useState(scope)
  const [value, setValue] = useState(read)
  if (seen !== scope) {
    setSeen(scope)
    setValue(read())
  }
  return [value, setValue]
}
