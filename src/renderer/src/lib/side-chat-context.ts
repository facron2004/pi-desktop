import {
  GOAL_STATUS_KEY,
  MAX_SIDE_CHAT_SNIPPET_CHARS,
  type GitStatus,
  type SideChatPresetKind,
  type SideChatReference
} from '@shared/types'
import { readGoalStatus } from '@shared/task-mode-state'
import { countChangedFiles } from './changes'
import { extractPlan } from './plan'
import { nextId, type ThreadItem } from './thread'
import { buildTurns } from './turns'
import type { RunState } from '../store/useAppStore'

export type { SideChatPresetKind, SideChatReference }

export const OPEN_SIDE_CHAT_EVENT = 'pi:open-side-chat'
export const JUMP_MAIN_TURN_EVENT = 'pi:jump-main-turn'

/**
 * Distributive reference input so callers can pass discriminated object literals
 * (`{ kind: 'turn', turnId, turnOrdinal, preview }`) without `id` or `sourceMainKey`.
 */
export type SideChatReferenceInput =
  | (Omit<Extract<SideChatReference, { kind: 'selection' }>, 'id' | 'sourceMainKey'> & {
      id?: string
      sourceMainKey?: string
    })
  | (Omit<Extract<SideChatReference, { kind: 'turn' }>, 'id' | 'sourceMainKey'> & {
      id?: string
      sourceMainKey?: string
    })
  | (Omit<Extract<SideChatReference, { kind: 'tool' }>, 'id' | 'sourceMainKey'> & {
      id?: string
      sourceMainKey?: string
    })
  | (Omit<Extract<SideChatReference, { kind: 'error' }>, 'id' | 'sourceMainKey'> & {
      id?: string
      sourceMainKey?: string
    })
  | (Omit<Extract<SideChatReference, { kind: 'file-diff' }>, 'id' | 'sourceMainKey'> & {
      id?: string
      sourceMainKey?: string
    })

export interface SideChatOpenRequest {
  seq: number
  mode?: 'open' | 'toggle'
  focus?: boolean
  reference?: SideChatReferenceInput | Omit<SideChatReference, 'id' | 'sourceMainKey'>
  preset?: SideChatPresetKind
  stepText?: string
  prompt?: string
  autoSubmit?: boolean
}

export interface SideChatJumpTurnDetail {
  turnId: string
  seq: number
}

let openSideChatSeq = 0
let jumpMainTurnSeq = 0

export function dispatchOpenSideChat(detail: Omit<SideChatOpenRequest, 'seq'> = {}): void {
  openSideChatSeq += 1
  const request: SideChatOpenRequest = {
    ...detail,
    seq: openSideChatSeq
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent<SideChatOpenRequest>(OPEN_SIDE_CHAT_EVENT, { detail: request }))
  }
}

export function dispatchJumpMainTurn(turnId: string): void {
  const trimmed = turnId.trim()
  if (!trimmed) return
  jumpMainTurnSeq += 1
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(
      new CustomEvent<SideChatJumpTurnDetail>(JUMP_MAIN_TURN_EVENT, {
        detail: { turnId: trimmed, seq: jumpMainTurnSeq }
      })
    )
  }
}

export function readJumpMainTurnId(event: Event): string | undefined {
  const detail = (event as CustomEvent<SideChatJumpTurnDetail | string | undefined>).detail
  if (typeof detail === 'string') return detail.trim() || undefined
  if (detail && typeof detail === 'object' && typeof detail.turnId === 'string') {
    return detail.turnId.trim() || undefined
  }
  return undefined
}

function clampText(text: string | undefined, maxChars = MAX_SIDE_CHAT_SNIPPET_CHARS): string {
  if (!text) return ''
  const normalized = text.trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`
}

export function normalizeSideReference(
  input: SideChatReferenceInput | Omit<SideChatReference, 'id' | 'sourceMainKey'>,
  sourceMainKey: string
): SideChatReference {
  const raw = input as Record<string, unknown>
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : nextId('sref')
  const owner =
    typeof raw.sourceMainKey === 'string' && raw.sourceMainKey.trim()
      ? raw.sourceMainKey.trim()
      : sourceMainKey

  switch (input.kind) {
    case 'selection': {
      const source =
        raw.source === 'user' || raw.source === 'assistant' || raw.source === 'tool' || raw.source === 'thinking'
          ? raw.source
          : 'assistant'
      return {
        id,
        kind: 'selection',
        sourceMainKey: owner,
        ...(typeof raw.turnId === 'string' && raw.turnId ? { turnId: raw.turnId } : {}),
        ...(typeof raw.messageId === 'string' && raw.messageId ? { messageId: raw.messageId } : {}),
        source,
        snippet: clampText(typeof raw.snippet === 'string' ? raw.snippet : '')
      }
    }
    case 'turn': {
      return {
        id,
        kind: 'turn',
        sourceMainKey: owner,
        turnId: typeof raw.turnId === 'string' ? raw.turnId : '',
        turnOrdinal: typeof raw.turnOrdinal === 'number' && Number.isFinite(raw.turnOrdinal) ? raw.turnOrdinal : 1,
        ...(typeof raw.assistantMessageId === 'string' && raw.assistantMessageId
          ? { assistantMessageId: raw.assistantMessageId }
          : {}),
        preview: clampText(typeof raw.preview === 'string' ? raw.preview : '', 240)
      }
    }
    case 'tool': {
      const status =
        raw.status === 'proposed' ||
        raw.status === 'running' ||
        raw.status === 'ok' ||
        raw.status === 'error' ||
        raw.status === 'aborted'
          ? raw.status
          : 'ok'
      return {
        id,
        kind: 'tool',
        sourceMainKey: owner,
        ...(typeof raw.turnId === 'string' && raw.turnId ? { turnId: raw.turnId } : {}),
        toolCallId: typeof raw.toolCallId === 'string' ? raw.toolCallId : '',
        toolName: typeof raw.toolName === 'string' && raw.toolName ? raw.toolName : 'tool',
        summary: clampText(typeof raw.summary === 'string' ? raw.summary : '', 240),
        status
      }
    }
    case 'error': {
      return {
        id,
        kind: 'error',
        sourceMainKey: owner,
        ...(typeof raw.turnId === 'string' && raw.turnId ? { turnId: raw.turnId } : {}),
        ...(typeof raw.title === 'string' && raw.title.trim() ? { title: clampText(raw.title, 160) } : {}),
        message: clampText(typeof raw.message === 'string' ? raw.message : '')
      }
    }
    case 'file-diff': {
      const range = raw.lineRange as { start?: unknown; end?: unknown } | undefined
      const validRange =
        range &&
        typeof range.start === 'number' &&
        Number.isFinite(range.start) &&
        typeof range.end === 'number' &&
        Number.isFinite(range.end)
          ? { start: Math.max(1, Math.trunc(range.start)), end: Math.max(1, Math.trunc(range.end)) }
          : undefined
      const snippet = typeof raw.snippet === 'string' && raw.snippet.trim() ? clampText(raw.snippet) : undefined
      return {
        id,
        kind: 'file-diff',
        sourceMainKey: owner,
        filePath: typeof raw.filePath === 'string' ? raw.filePath : '',
        ...(validRange ? { lineRange: validRange } : {}),
        ...(snippet ? { snippet } : {})
      }
    }
  }
}

export function sameSideReferenceTarget(a: SideChatReference, b: SideChatReference): boolean {
  if (a.kind !== b.kind || a.sourceMainKey !== b.sourceMainKey) return false
  switch (a.kind) {
    case 'selection':
      return b.kind === 'selection' && a.turnId === b.turnId && a.source === b.source && a.snippet === b.snippet
    case 'turn':
      return b.kind === 'turn' && a.turnId === b.turnId && a.turnOrdinal === b.turnOrdinal
    case 'tool':
      return b.kind === 'tool' && a.toolCallId === b.toolCallId
    case 'error':
      return b.kind === 'error' && a.turnId === b.turnId && a.message === b.message
    case 'file-diff':
      return (
        b.kind === 'file-diff' &&
        a.filePath === b.filePath &&
        a.lineRange?.start === b.lineRange?.start &&
        a.lineRange?.end === b.lineRange?.end
      )
  }
}

export function describeSideReference(ref: SideChatReference, language = 'en'): string {
  const zh = language === 'zh-CN'
  switch (ref.kind) {
    case 'selection': {
      const oneLine = ref.snippet.replace(/\s+/g, ' ').trim()
      const preview = oneLine.length > 42 ? `${oneLine.slice(0, 41)}…` : oneLine
      return preview ? `“${preview}”` : zh ? '引用片段' : 'Selected text'
    }
    case 'turn': {
      const oneLine = ref.preview.replace(/\s+/g, ' ').trim()
      const preview = oneLine.length > 36 ? `${oneLine.slice(0, 35)}…` : oneLine
      const head = zh ? `第 ${ref.turnOrdinal} 轮` : `Turn ${ref.turnOrdinal}`
      return preview ? `${head} · ${preview}` : head
    }
    case 'tool':
      return ref.summary ? `${ref.toolName} · ${ref.summary}` : ref.toolName
    case 'error': {
      const oneLine = (ref.title || ref.message).replace(/\s+/g, ' ').trim()
      return oneLine.length > 44 ? `${oneLine.slice(0, 43)}…` : oneLine || (zh ? '报错信息' : 'Error')
    }
    case 'file-diff':
      return ref.lineRange
        ? `${ref.filePath}:${ref.lineRange.start}-${ref.lineRange.end}`
        : ref.filePath
  }
}

export function buildPresetPrompt(
  preset: SideChatPresetKind,
  options?: { stepText?: string; language?: string }
): string {
  const zh = options?.language === 'zh-CN'
  const step = options?.stepText?.trim()

  switch (preset) {
    case 'explain-live':
      return zh
        ? '请结合主对话的最新上下文，简要解释主对话当前正在做什么、进展到了哪一步，以及有哪些关键操作需要关注。'
        : 'Explain what the main conversation is currently doing, how far it has progressed, and any key actions worth watching.'
    case 'summarize-main':
      return zh
        ? '请总结主对话目前的整体进展、关键技术决策，以及尚未完成的事项。'
        : 'Summarize the main conversation’s progress so far, key technical decisions, and remaining open items.'
    case 'diagnose-error':
      return zh
        ? '请诊断主对话中最新的报错或失败原因，结合相关代码定位根因，并给出可在主对话执行的修复建议（在合适处使用 ```prompt 代码块提供下一步指令）。'
        : 'Diagnose the latest error or failure in the main conversation, inspect the relevant code to pinpoint the root cause, and suggest actionable fixes (include ready-to-send instructions in ```prompt fenced blocks where helpful).'
    case 'breakdown-plan':
      if (step) {
        return zh
          ? `请结合当前代码库拆解主对话中的这一待办步骤：「${step}」。说明涉及的文件、前置依赖与边界风险，并用 \`\`\`prompt 代码块给出可直接在主对话发送的具体执行指令。`
          : `Break down this ongoing step from the main conversation against the codebase: "${step}". Identify the relevant files, dependencies, and edge cases, and provide concrete ready-to-send instructions in \`\`\`prompt fenced blocks.`
      }
      return zh
        ? '请结合主对话当前目标与待办进行项，梳理阻塞点与执行顺序，拆解出具体可落地的子步骤，并用 ```prompt 代码块给出每一步可直接发回主对话的提示词。'
        : 'Break down the ongoing items and active goal in the main conversation into concrete, ordered sub-steps, identifying blockers and relevant files, and emit ready-to-send instructions in ```prompt fenced blocks.'
    case 'review-session':
      return zh
        ? '请独立审查主对话在本次会话中修改的文件（使用只读工具检查改动与上下文），按严重程度指出潜在 Bug、回归风险或遗漏测试，标注具体 `文件路径:行号`，并用 ```prompt 代码块附上可直接发回主对话的修复指令。'
        : 'Perform an independent code review of the files changed in this conversation (using read-only tools to inspect diffs and context). Flag bugs, regressions, or missing tests by severity with exact `path:line` references, and include a ```prompt block with actionable fix instructions for the main chat.'
    case 'review-worktree':
      return zh
        ? '请独立审查当前工作区尚未提交的 Git 变更，按严重程度指出潜在 Bug、边界情况或遗漏测试，标注具体 `文件路径:行号`，并用 ```prompt 代码块附上可直接发回主对话的修复指令。'
        : 'Perform an independent code review of the uncommitted working-tree changes. Flag bugs, edge cases, or missing tests by severity with exact `path:line` references, and include a ```prompt block with actionable fix instructions for the main chat.'
  }
}

const OPEN_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\r\n]*)$/

/**
 * Extract concrete next-step prompts written inside fenced ```` ```prompt ```` blocks.
 * Returns `[]` when the reply contains no `prompt` fences.
 */
export function extractActionablePrompts(markdown: string): string[] {
  if (!markdown || (!markdown.includes('`') && !markdown.includes('~'))) return []
  const lines = markdown.split(/\r?\n/)
  const prompts: string[] = []
  let activeFenceChar: string | null = null
  let activeFenceLen = 0
  let capturePrompt = false
  let buffer: string[] = []

  for (const line of lines) {
    if (!activeFenceChar) {
      const match = OPEN_FENCE_RE.exec(line)
      if (!match) continue
      const marker = match[1]
      const info = match[2].trim()
      if (marker[0] === '`' && info.includes('`')) continue
      activeFenceChar = marker[0]
      activeFenceLen = marker.length
      const langToken = info.split(/\s+/)[0]?.toLowerCase() ?? ''
      capturePrompt = langToken === 'prompt'
      buffer = []
      continue
    }

    const closeRe = new RegExp(`^ {0,3}${activeFenceChar}{${activeFenceLen},}[ \\t]*$`)
    if (closeRe.test(line)) {
      if (capturePrompt) {
        const extracted = buffer.join('\n').trim()
        if (extracted) prompts.push(extracted)
      }
      activeFenceChar = null
      activeFenceLen = 0
      capturePrompt = false
      buffer = []
      continue
    }

    if (capturePrompt) {
      buffer.push(line)
    }
  }

  return prompts
}

/**
 * Produce clean handoff text for Main Chat from a settled Side Chat reply:
 * prefers explicit ```` ```prompt ```` blocks when present, otherwise trims the reply.
 */
export function cleanReplyForHandoff(markdown: string): string {
  const actionable = extractActionablePrompts(markdown)
  if (actionable.length > 0) return actionable.join('\n\n')
  return markdown.trim()
}

export interface MainSyncSummaryInput {
  items: ThreadItem[]
  isStreaming?: boolean
  run?: Pick<RunState, 'phase' | 'settled' | 'compaction' | 'hadError' | 'outcome'>
  error?: string
  uiStatuses?: readonly { key: string; text: string }[]
  git?: Pick<GitStatus, 'files'>
}

export interface MainSyncSummary {
  mode: 'streaming' | 'settled' | 'empty'
  turnCount: number
  activeVerb?: string
  changedFileCount: number
  dirtyWorktreeCount: number
  goalText?: string
  planDone?: number
  planTotal?: number
  hasError?: boolean
}

function activeVerbForMain(state: MainSyncSummaryInput): string | undefined {
  const run = state.run
  if (run?.compaction) return 'Compacting context'
  if (run?.phase === 'retrying') return 'Retrying'
  if (run?.phase === 'waiting_approval') return 'Waiting for your answer'

  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    const item = state.items[index]
    if (item?.kind !== 'tool' || item.status !== 'running') continue
    switch (item.toolName) {
      case 'edit':
        return 'Editing a file'
      case 'write':
        return 'Writing file'
      case 'read':
        return 'Reading a file'
      case 'grep':
      case 'find':
      case 'ls':
        return 'Searching files'
      case 'bash':
      case 'powershell':
        return 'Running a command'
      default:
        return 'Running a tool'
    }
  }

  if (run?.phase === 'generating') return 'Writing a reply…'
  return undefined
}

function hasMainError(state: MainSyncSummaryInput): boolean {
  if (state.error?.trim()) return true
  if (state.run?.hadError || state.run?.outcome === 'failed') return true
  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    const item = state.items[index]
    if (!item) continue
    if (item.kind === 'tool' && item.status === 'error') return true
    if (item.kind === 'assistant' && Boolean(item.error || item.stopReason === 'error')) return true
    if (item.kind === 'notice' && item.level === 'error') return true
  }
  return false
}

export function buildMainSyncSummary(state: MainSyncSummaryInput): MainSyncSummary {
  const runOpen = Boolean(
    state.isStreaming ||
      (state.run && (!state.run.settled || state.run.phase !== 'idle' || Boolean(state.run.compaction)))
  )
  const turns = buildTurns(state.items)
  const turnCount = turns.length
  const mode: MainSyncSummary['mode'] = runOpen
    ? 'streaming'
    : state.items.length > 0
      ? 'settled'
      : 'empty'

  const rawGoal = state.uiStatuses?.find((entry) => entry.key === GOAL_STATUS_KEY)?.text
  const goal = readGoalStatus(rawGoal)
  const plan = extractPlan(state.items)

  return {
    mode,
    turnCount,
    ...(runOpen ? { activeVerb: activeVerbForMain(state) } : {}),
    changedFileCount: countChangedFiles(state.items),
    dirtyWorktreeCount: state.git?.files?.length ?? 0,
    ...(goal?.text ? { goalText: goal.text } : {}),
    ...(plan ? { planDone: plan.done, planTotal: plan.total } : {}),
    hasError: hasMainError(state)
  }
}
