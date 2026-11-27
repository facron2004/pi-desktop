import { ASK_USER_TOOL_NAME } from '@shared/types'
import type { ToolItem } from './thread'

/**
 * The question a `desktop_ask_user` call asked, and the answer it got.
 *
 * The card that asks it offers the choices *and* a line for answering in the
 * reader's own words (DSH's ask card does the same), and both come back as the
 * select's value. A reply that is not one of the offered labels is therefore
 * still an answer — `custom` says so — and the record has to show it, because
 * the options alone would not say what the reader decided.
 */
export interface AskQuestionDetail {
  question: string
  options: string[]
  /** The chosen label, or the words the reader typed. */
  answer: string | null
  /** The answer was typed rather than picked from the options. */
  custom: boolean
  /** A result exists, so a pending question is never described as declined. */
  answered: boolean
}

/**
 * Read a question call for the transcript.
 *
 * The options come from the call's own arguments when the result carries no
 * details yet — a call that is still waiting, or one whose process died before
 * it answered.
 */
export function askQuestionDetail(item: ToolItem): AskQuestionDetail | null {
  if (item.toolName !== ASK_USER_TOOL_NAME) return null
  const details = item.details && typeof item.details === 'object'
    ? (item.details as { question?: unknown; options?: unknown; answer?: unknown; custom?: unknown })
    : undefined
  const rawOptions = Array.isArray(details?.options)
    ? details.options
    : Array.isArray(item.args?.options)
      ? item.args.options
      : []
  const options = rawOptions.filter(
    (option): option is string => typeof option === 'string' && Boolean(option.trim())
  )
  const question = typeof details?.question === 'string'
    ? details.question.trim()
    : typeof item.args?.question === 'string'
      ? item.args.question.trim()
      : ''
  if (!question && options.length === 0) return null
  const answer = typeof details?.answer === 'string' && details.answer ? details.answer : null
  const answered = details !== undefined && 'answer' in details
  // Older records carry no `custom` flag: an answer outside the offered labels
  // was typed by definition.
  const custom = Boolean(answer) && (details?.custom === true || !options.includes(answer as string))
  return { question, options, answer, custom, answered }
}
