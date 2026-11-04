import { isValidElement, type ReactNode } from 'react'
import type { ToolItem } from '../../lib/thread'
import type { Turn } from '../../lib/turns'
import { AssistantImage, ThinkingBlock } from '../MessageItem'
import { ProcessTrail } from '../ProcessTrail'
import { ToolCard } from '../ToolCard'
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
 * collapsed to a single indented line once that stretch has finished — or, when
 * `toolCallSummary` is on, one line while it is still working too. That choice
 * is ProcessTrail's; this component only cuts the turn into stretches.
 * Tools stay grouped inside it until text, thinking or an image interrupts them,
 * even when they span several assistant messages.
 */
export function AssistantMessage({
  turn,
  toolMap,
  liveTail,
  processOpen = true
}: {
  turn: Turn
  toolMap: Map<string, ToolItem>
  /** True while this turn is the part of the conversation still being written. */
  liveTail: boolean
  /** Whether the turn's tool/thinking process is visible. */
  processOpen?: boolean
}) {
  const segments: TurnSegment[] = []
  let group: ToolItem[] = []
  let trace: ProcessBuffer | null = null

  const ensureProcess = (key: string) => {
    if (!trace) {
      trace = { key, tools: [], thoughts: 0, searchText: '', children: [] }
    }
  }

  const isThinkingRow = (node: ReactNode) =>
    isValidElement(node) && node.type === ThinkingBlock

  const flushTools = () => {
    if (!group.length) return
    const items = group
    group = []
    ensureProcess(`process-${items[0].id}`)
    if (!trace) return
    trace.tools.push(...items)
    // A thought before a command is already counted on the process. Leaving
    // the "Reasoning hidden" row above every call doubled the list and pushed
    // the reply to the bottom of it.
    trace.children = trace.children.filter((child) => !isThinkingRow(child))
    // The fold already names the batch. Each call is a link, not another
    // "Activity" row wrapped around a card.
    // The rows are built whether or not they are painted: `toolCallSummary`
    // is a presentation choice ProcessTrail makes from `live`, and one call is
    // still one node keyed by the thread's own id at its first appearance.
    for (const item of items) {
      trace.children.push(<ToolCard key={item.id} item={item} presentation="link" />)
    }
  }

  const flushProcess = () => {
    flushTools()
    if (!trace || trace.children.length === 0 || !processOpen) {
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
        // Only the thought still in progress stays on screen. The ones that
        // already turned into a command are a count, not a row each.
        trace.children = trace.children.filter((child) => !isThinkingRow(child))
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
