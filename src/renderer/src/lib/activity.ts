import type { ToolItem } from './thread'
import { summarizeTool, type ToolSummaryTone } from './tool-renderers'

/**
 * What the agent is doing, phrased as a state rather than as model prose.
 *
 * The label comes from the tool's tone — the registry already knows whether a
 * call reads, searches, edits or runs a command. It is never inferred from the
 * assistant's text, because the text is a claim about the work while the tool
 * call is the work.
 */
export interface ToolActivity {
  /** The state word, e.g. "Reading a file". */
  label: string
  /** The concrete target: a path, a pattern, a command. */
  detail: string
  /** The tone that drives the icon and styling. */
  tone: ToolSummaryTone
}

const LABELS: Record<ToolSummaryTone, string> = {
  read: 'Reading a file',
  search: 'Searching files',
  edit: 'Editing a file',
  command: 'Running a command',
  generic: 'Working'
}

/**
 * Describe the tool call that is in flight.
 *
 * A call the model named but never started is not "running": it is waiting to
 * start, so it gets the waiting state instead of borrowing the tool's verb.
 */
export function activityOf(tool: ToolItem | undefined): ToolActivity {
  if (!tool) return { label: 'Waiting', detail: '', tone: 'generic' }

  const summary = summarizeTool(tool)
  if (tool.status === 'proposed') {
    return { label: 'Waiting', detail: summary.detail, tone: summary.tone }
  }

  return {
    label: LABELS[summary.tone],
    detail: summary.detail,
    tone: summary.tone
  }
}
