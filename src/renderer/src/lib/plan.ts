import type { AssistantBlock, AssistantItem, ThreadItem } from './thread'

export interface PlanEntry {
  text: string
  done: boolean
}

export interface Plan {
  entries: PlanEntry[]
  done: number
  total: number
  sourceId: string
}

/**
 * A checklist line, as markdown writes it: up to three spaces of indentation,
 * a bullet (`-`, `*`, `+`) or a numbered marker (`1.` / `1)`), a checkbox —
 * `[ ]` open, `[x]` / `[X]` done — and the step itself.
 *
 * Anything deeper is a nested list or an indented code block, and either way
 * not a step of the plan, so it does not match.
 */
const CHECKLIST_LINE = /^ {0,3}(?:[-*+]|\d{1,3}[.)])[ \t]+\[([ xX])\][ \t]+(\S.*?)[ \t]*$/

/** A single checkbox is a sentence with a box in it, not a plan. */
const MIN_ENTRIES = 2

/** A fence opens and closes a code block, where a checklist is an example. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/

function assistantText(item: AssistantItem): string {
  return item.blocks
    .filter((block): block is Extract<AssistantBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/**
 * The step as it is shown, without the inline markdown an agent wraps around
 * it. Only the unambiguous marks are dropped — a backticked path, a bolded
 * verb and a link all read as their own text. Underscores are left alone,
 * because `__init__` is a name and not emphasis.
 */
function stepText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)\s]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .trim()
}

/** Every checklist entry in a piece of markdown, in the order it is written. */
export function parseChecklist(markdown: string): PlanEntry[] {
  const entries: PlanEntry[] = []
  let fence: string | null = null

  for (const line of markdown.split(/\r?\n/)) {
    const open = FENCE.exec(line)
    if (open) {
      // A checklist inside a fence is an example of one, not the plan itself.
      if (!fence) fence = open[1][0]
      else if (open[1][0] === fence) fence = null
      continue
    }
    if (fence) continue

    const match = CHECKLIST_LINE.exec(line)
    if (!match) continue
    const text = stepText(match[2])
    if (!text) continue
    entries.push({ text, done: match[1] !== ' ' })
  }

  return entries
}

/**
 * The plan the agent is working through: the checklist of the most recent
 * assistant message that carries one.
 *
 * This is a projection of the thread and not a piece of state — a conversation
 * switch, a branch or a compaction shows the plan of whatever is on screen,
 * and nothing has to keep two copies of it in step.
 */
export function extractPlan(items: ThreadItem[]): Plan | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind !== 'assistant') continue
    const entries = parseChecklist(assistantText(item))
    // The answer after a plan is prose, not a second plan; keep looking back
    // until a message actually carries one.
    if (entries.length < MIN_ENTRIES) continue
    return {
      entries,
      done: entries.filter((entry) => entry.done).length,
      total: entries.length,
      sourceId: item.id
    }
  }
  return null
}
