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
