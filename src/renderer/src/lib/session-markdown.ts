/**
 * A conversation as a Markdown file.
 *
 * The transcript projection already writes the messages (`transcriptOf`), so
 * this module only owns the document around them: a title and the facts a
 * reader needs to know where the file came from. It is deliberately plain
 * Markdown — no HTML wrapper — so it pastes into an issue, a note or a chat.
 */

import { transcriptOf, type ThreadItem } from './thread'

export interface SessionMarkdownMeta {
  /** The name the sidebar shows; a cold draft has none. */
  title?: string
  /** The folder the agent worked in. */
  project?: string
  /** When the file was written, for the reader who opens it later. */
  exportedAt?: number
}

/** One line, whatever the session name carried. */
function heading(title: string | undefined): string {
  const text = (title ?? '').replace(/\s+/g, ' ').trim()
  return (text || 'Conversation').slice(0, 200)
}

/**
 * The Markdown a reader gets from "Export as Markdown".
 *
 * A conversation with no messages still produces the heading: the file says
 * which conversation it is, and an empty export is better than a failed one
 * after the reader has picked a path. Tool output is not part of the document
 * — `transcriptOf` already drops it — because an export is what was said, not
 * a build log.
 */
export function sessionMarkdown(items: ThreadItem[], meta: SessionMarkdownMeta = {}): string {
  const facts: string[] = []
  const project = meta.project?.trim()
  if (project) facts.push(`- Project: \`${project.replace(/`/g, "'")}\``)
  if (meta.exportedAt !== undefined) {
    const date = new Date(meta.exportedAt)
    if (Number.isFinite(date.getTime())) facts.push(`- Exported: ${date.toISOString()}`)
  }
  const head = `# ${heading(meta.title)}${facts.length ? `\n\n${facts.join('\n')}` : ''}`
  const body = transcriptOf(items).trim()
  return body ? `${head}\n\n${body}\n` : `${head}\n`
}
