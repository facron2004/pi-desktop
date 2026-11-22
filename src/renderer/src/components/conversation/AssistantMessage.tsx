import { memo, type ReactNode } from 'react'
import type { ToolItem } from '../../lib/thread'
import { replyStartOf, type Turn } from '../../lib/turns'
import { AssistantImage, ThinkingBlock } from '../MessageItem'
import { ProcessTrail } from '../ProcessTrail'
import { ToolCard } from '../ToolCard'
import { StreamingText } from './StreamingText'
import { stripEchoedPrompt } from '../../lib/image-echo'

interface ProcessBuffer {
  key: string
  tools: ToolItem[]
  children: ReactNode[]
}

type TurnSegment = { kind: 'node'; node: ReactNode } | { kind: 'process'; buffer: ProcessBuffer }

/**
 * The agent's body of one turn.
 *
 * Commentary, tool groups and reply text stay in their original order. A group
 * spans assistant messages until text or an image interrupts it. ProcessTrail
 * owns the expansion of each group, and the run summary can hide the process.
 */
export const AssistantMessage = memo(function AssistantMessage({
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
  const thinkingParts: string[] = []
  let thinkingStreaming = false
  // A generated picture is the answer, and it reads best under the words that
  // explain it. The cards are collected here and appended after the turn's
  // text, so the image always sits at the bottom of the reply.
  const imageCards: ReactNode[] = []
  // An older run was told to quote its prompt in the reply, and a current one
  // sometimes does it anyway. The card's fold keeps the prompt, so the reply's
  // copy is dropped there instead of here — one copy, and it is the collapsible
  // one.
  const imagePrompts = turn.tools
    .filter((tool) => tool.toolName === 'generate_image')
    .map((tool) => (typeof tool.args?.prompt === 'string' ? tool.args.prompt.trim() : ''))
    .filter(Boolean)
  const replyStart = replyStartOf(turn)
  let beforeReply = Boolean(replyStart) || turn.tools.length > 0
  let group: ToolItem[] = []
  let trace: ProcessBuffer | null = null

  const ensureProcess = (key: string) => {
    if (!trace) {
      trace = { key, tools: [], children: [] }
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
      if (block === replyStart) beforeReply = false
      if (block.type === 'text') {
        // The picture card keeps the prompt in its fold, so a reply that quotes
        // it would print the same paragraph twice. Keep the copy the reader can
        // collapse and drop the one in the answer column.
        const text = stripEchoedPrompt(block.text, imagePrompts)
        if (!text.trim()) return
        flushProcess()
        if (beforeReply && replyStart && !processOpen) return
        segments.push({
          kind: 'node',
          node: (
            <StreamingText
              key={`${assistant.id}-${index}`}
              text={text}
              streaming={assistant.streaming && index === lastTextIndex}
              commentary={beforeReply}
            />
          )
        })
        return
      }
      if (block.type === 'thinking') {
        if (processOpen && !block.redacted && block.text.trim()) {
          thinkingParts.push(block.text)
          if (assistant.streaming && index === assistant.blocks.length - 1) thinkingStreaming = true
        }
        return
      }
      if (block.type === 'image') {
        flushProcess()
        if (beforeReply && replyStart && !processOpen) return
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
      // A generated picture is the answer, not a step inside the process fold:
      // it stays on the reading column as its own card so the image is visible
      // without opening anything. The card is appended after the text below.
      if (tool.toolName === 'generate_image') {
        flushTools()
        flushProcess()
        imageCards.push(
          <ToolCard key={tool.id} item={tool} presentation="card" />
        )
        return
      }
      group.push(tool)
    })
  }
  flushProcess()

  return (
    <>
      {thinkingParts.length > 0 ? (
        <ThinkingBlock turnId={turn.id} parts={thinkingParts} streaming={thinkingStreaming} />
      ) : null}
      {segments.map((segment, index) => {
        if (segment.kind === 'node') return segment.node
        const { buffer } = segment
        return (
          <ProcessTrail
            key={buffer.key}
            tools={buffer.tools}
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
      {imageCards}
    </>
  )
})
