import { AGENT_MODES, type AgentMode, type GoalState } from './types'

export function isAgentMode(value: unknown): value is AgentMode {
  return AGENT_MODES.some((mode) => mode === value)
}

export function readGoalState(value: unknown): GoalState | undefined {
  if (!value || typeof value !== 'object') return
  const { text, status, summary } = value as Record<string, unknown>
  if (typeof text !== 'string' || !text.trim()) return
  if (status !== 'active' && status !== 'paused' && status !== 'blocked' && status !== 'complete') return

  return {
    text: text.trim(),
    status,
    ...(typeof summary === 'string' && summary.trim() ? { summary } : {})
  }
}

/**
 * The goal published on the extension's status line, or undefined.
 *
 * The extension publishes it as JSON, so a malformed or partial value is a
 * normal cold-start state, not an error to show. Both the goal bar and the
 * composer read it through here so they cannot disagree about whether a goal
 * exists.
 */
export function readGoalStatus(raw: string | undefined): GoalState | undefined {
  if (!raw) return
  try {
    return readGoalState(JSON.parse(raw))
  } catch {
    return undefined
  }
}
