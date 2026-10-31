import type { ReactNode } from 'react'
import type { ToolItem } from '../../lib/thread'
import type { Turn } from '../../lib/turns'
import type { RunState } from '../../store/useAppStore'
import { AssistantImage, ThinkingBlock } from '../MessageItem'
import { ProcessTrail } from '../ProcessTrail'
import { ToolCard } from '../ToolCard'
import { RunSummary } from './RunSummary'
import { StreamingText } from './StreamingText'

interface ProcessBuffer {
  key: string
  tools: ToolItem[]
  thoughts: number
  searchText: string
  children: ReactNode[]
}

type TurnSegment = { kind: 'node'; node: ReactNode } | { kind: 'process'; buffer: ProcessBuffer }

/**
 * The agent's body of one turn.
 *
 * Spoken text keeps the column. Thinking and tool calls between two stretches
 * of text are one process: open and indented while it is the live tail,
 * collapsed to a single indented line once that stretch has finished. Tools
 * stay grouped inside it until text, thinking or an image interrupts them,
 * even when they span several assistant messages.
 */
export function AssistantMessage({
  turn,
  toolMap,
  replyOutcome,
  liveTail
}: {
  turn: Turn
  toolMap: Map<string, ToolItem>
  /** The settled run summary shown before the final answer, when it is complete. */
  replyOutcome: RunState | undefined
  /** True while this turn is the part of the conversation still being written. */
  liveTail: boolean
}) {
  const segments: TurnSegment[] = []
  let group: ToolItem[] = []
  let trace: ProcessBuffer | null = null
  const lastAssistant = turn.assistants.at(-1)
  let outcomeShown = false

  const ensureProcess = (key: string) => {
    if (!trace) {
      trace = { key, tools: [], thoughts: 0, searchText: '', children: [] }
    }
  }

  const flushTools = () => {
    if (!group.length) return
    const items = group
    group = []
    ensureProcess(`process-${items[0].id}`)
    if (!trace) return
    trace.tools.push(...items)
    // The fold already names the batch. Each call is a link, not another
    // "Activity" row wrapped around a card.
    for (const item of items) {
      trace.children.push(<ToolCard key={item.id} item={item} presentation="link" />)
    }
  }

  const flushProcess = () => {
    flushTools()
    if (!trace || trace.children.length === 0) {
      trace = null
      return
    }
    segments.push({ kind: 'process', buffer: trace })
    trace = null
  }

  for (const assistant of turn.assistants) {
    const lastTextIndex = assistant.blocks.reduce(
      (found, block, index) => (block.type === 'text' ? index : found),
      -1
    )

    assistant.blocks.forEach((block, index) => {
      if (block.type === 'text') {
        if (!block.text.trim()) return
        flushProcess()
        if (replyOutcome && assistant === lastAssistant && !outcomeShown) {
          segments.push({ kind: 'node', node: <RunSummary key="run-outcome" run={replyOutcome} /> })
          outcomeShown = true
        }
        segments.push({
          kind: 'node',
          node: (
            <StreamingText
              key={`${assistant.id}-${index}`}
              text={block.text}
              streaming={assistant.streaming && index === lastTextIndex}
            />
          )
        })
        return
      }
      if (block.type === 'thinking') {
        if (!block.text.trim()) return
        flushTools()
        ensureProcess(`process-${assistant.id}-${index}`)
        if (!trace) return
        trace.thoughts += 1
        trace.searchText += `\n${block.text}`
        trace.children.push(
          <ThinkingBlock
            key={`${assistant.id}-${index}`}
            text={block.text}
            streaming={assistant.streaming && index === assistant.blocks.length - 1}
          />
        )
        return
      }
      if (block.type === 'image') {
        flushProcess()
        segments.push({
          kind: 'node',
          node: (
            <AssistantImage
              key={`${assistant.id}-${index}`}
              data={block.data}
              mimeType={block.mimeType}
            />
          )
        })
        return
      }
      const tool = toolMap.get(block.id)
      if (!tool) return
      group.push(tool)
    })
  }
  flushProcess()

  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === 'node') return segment.node
        const { buffer } = segment
        return (
          <ProcessTrail
            key={buffer.key}
            tools={buffer.tools}
            thoughts={buffer.thoughts}
            searchText={buffer.searchText}
            live={
              liveTail &&
              (index === segments.length - 1 ||
                buffer.tools.some((tool) => tool.status === 'running'))
            }
          >
            {buffer.children}
          </ProcessTrail>
        )
      })}
    </>
  )
}
