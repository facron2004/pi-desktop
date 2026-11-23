import type { AgentMessage } from '@shared/types'

/** Pi's agent_end contains the messages produced by the attempt. */
export function lastRunAssistantMessage(messages: unknown): AgentMessage | undefined {
  return Array.isArray(messages)
    ? (messages as AgentMessage[]).findLast((message) => message?.role === 'assistant')
    : undefined
}
