import {
  SIDE_CHAT_META_ENTRY_TYPE,
  SIDE_CHAT_STATUS_KEY,
  SIDE_CHAT_TURN_META_ENTRY_TYPE
} from '@shared/types'
import { WORKSPACE_TOOL_HOOKS } from './workspace-tools'

/**
 * Constant system-prompt section injected via `sections['pi-desktop-side-chat']`.
 * Kept byte-identical across every turn so providers retain full KV-cache prefix hits.
 *
 * A side chat is a **second, equal conversation**: it works in the same
 * workspace with the same tools as the main one. It is not a read-only
 * observer — the only thing that makes it "side" is that it runs beside the
 * conversation the reader is steering, and that it can read that conversation
 * through the two inspect tools instead of sharing its transcript.
 */
export const SIDE_CHAT_STATIC_SECTION = [
  'You are Pi Desktop Side Chat — a second working conversation running alongside the user\'s Main Conversation in the same workspace.',
  'Capabilities & guardrails:',
  '- You have the same tools as the Main Conversation: you can read, edit and create files and run commands in this workspace.',
  '- The Main Conversation may be editing the same files at the same time. Before you change a file it is also working on, re-read it; never overwrite work you did not do.',
  '- Before each turn, a fresh `<main_conversation_digest>` snapshot is placed right before the user message. It is ephemeral and reflects the live state of the Main Conversation.',
  '- Use `inspect_main_conversation` to fetch full turn transcripts, search earlier turns, inspect a tool call output by `toolCallId`, or inspect the full goal/todo plan.',
  '- Use `inspect_main_changes` to inspect files edited by the Main Conversation (`scope: "session"`), uncommitted git changes (`scope: "worktree"`), or both (`scope: "all"`), and pass `file` for unified diffs.',
  '- When suggesting concrete prompts or next steps the user can hand off to the Main Conversation, wrap each ready-to-send prompt in a fenced ```prompt block so the UI renders one-click handoff buttons.',
  '- Cite code locations as `path/to/file.ts:line` so the user can jump straight to them in the workspace.'
].join('\n')

export interface SideChatExtensionConfig {
  bridgeUrl: string
  bridgeToken: string
  extensionPath: string
  parentSessionKey?: string
  parentSessionId?: string
}

/**
 * Generates the per-process Pi extension that registers
 * `inspect_main_conversation` / `inspect_main_changes` and injects ephemeral
 * KV-cache-safe Main Conversation digests via `pi.on('context')`.
 *
 * It deliberately installs **no tool policy**: the side conversation is a
 * normal working conversation, so leaving the loadout alone is what keeps it
 * equal to the main one instead of a second, weaker agent.
 */
export function sideChatExtension(config: SideChatExtensionConfig): string {
  return `import { Type } from 'typebox';

export default function (pi) {
  const bridgeUrl = ${JSON.stringify(config.bridgeUrl)};
  const bridgeToken = ${JSON.stringify(config.bridgeToken)};
  const sideChatExtensionPath = ${JSON.stringify(config.extensionPath)};
  const initialParentSessionKey = ${JSON.stringify(config.parentSessionKey ?? '')};
  const initialParentSessionId = ${JSON.stringify(config.parentSessionId ?? '')};
  const statusKey = ${JSON.stringify(SIDE_CHAT_STATUS_KEY)};
  const metaEntryType = ${JSON.stringify(SIDE_CHAT_META_ENTRY_TYPE)};
  const turnMetaEntryType = ${JSON.stringify(SIDE_CHAT_TURN_META_ENTRY_TYPE)};
  const staticSection = ${JSON.stringify(SIDE_CHAT_STATIC_SECTION)};

  let currentRunDigest;
  let currentRunStartedAt = 0;

  ${WORKSPACE_TOOL_HOOKS}

  async function callBridge(endpoint, body, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const response = await fetch(bridgeUrl + endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + bridgeToken
        },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error('Side chat bridge returned HTTP ' + response.status + (text ? ': ' + text.slice(0, 200) : ''));
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  pi.registerTool({
    name: 'inspect_main_conversation',
    label: 'Inspect main conversation',
    description: 'Read live and historical turns, tool outputs, plan/todos, or search across the bound Main Conversation.',
    parameters: Type.Object({
      view: Type.Optional(Type.Union([
        Type.Literal('turns'),
        Type.Literal('tool'),
        Type.Literal('plan'),
        Type.Literal('search')
      ], { description: 'What to inspect: turns (default), tool, plan, or search.' })),
      turnStart: Type.Optional(Type.Number({ description: '1-based turn index to start from (ignored when fromEnd is true).' })),
      turnCount: Type.Optional(Type.Number({ description: 'Number of turns to return (default 5, clamped 1..15).' })),
      fromEnd: Type.Optional(Type.Boolean({ description: 'Start from the newest turns (default true when turnStart is omitted).' })),
      toolCallId: Type.Optional(Type.String({ description: 'Tool call ID to inspect when view is "tool".' })),
      outputOffsetLines: Type.Optional(Type.Number({ description: '0-based line offset for paging long tool output (200 lines/page).' })),
      query: Type.Optional(Type.String({ description: 'Literal substring query when view is "search".' }))
    }),
    async execute(_toolCallId, params, signal) {
      const data = await callBridge('/v1/inspect-conversation', params, signal);
      return {
        content: [{ type: 'text', text: typeof data?.text === 'string' ? data.text : 'No conversation data available.' }],
        details: data?.details ?? {}
      };
    }
  });

  pi.registerTool({
    name: 'inspect_main_changes',
    label: 'Inspect main changes',
    description: 'Inspect files modified by the Main Conversation and/or uncommitted git working-tree diffs in the bound workspace.',
    parameters: Type.Object({
      scope: Type.Optional(Type.Union([
        Type.Literal('session'),
        Type.Literal('worktree'),
        Type.Literal('all')
      ], { description: 'Change scope: session, worktree, or all (default).' })),
      file: Type.Optional(Type.String({ description: 'Optional workspace-relative file path to inspect unified diff.' })),
      staged: Type.Optional(Type.Boolean({ description: 'When true, limit worktree listing to staged changes.' })),
      offsetLines: Type.Optional(Type.Number({ description: '0-based line offset for paging long diffs (300 lines/page).' }))
    }),
    async execute(_toolCallId, params, signal) {
      const data = await callBridge('/v1/inspect-changes', params, signal);
      return {
        content: [{ type: 'text', text: typeof data?.text === 'string' ? data.text : 'No change data available.' }],
        details: data?.details ?? {}
      };
    }
  });

  pi.on('session_start', (_event, ctx) => {
    ctx.ui.setStatus(statusKey, 'ready');
    const branch = typeof ctx.sessionManager?.getBranch === 'function' ? ctx.sessionManager.getBranch() : [];
    const hasMeta = Array.isArray(branch) && branch.some(
      entry => entry?.type === 'custom' && entry?.customType === metaEntryType
    );
    if (!hasMeta && initialParentSessionKey) {
      pi.appendEntry(metaEntryType, {
        version: 1,
        parentSessionKey: initialParentSessionKey,
        ...(initialParentSessionId ? { parentSessionId: initialParentSessionId } : {}),
        createdAt: Date.now()
      });
    }
  });

  pi.on('before_agent_start', async (event, ctx) => {
    if (event.systemPromptOptions) {
      if (!event.systemPromptOptions.sections || typeof event.systemPromptOptions.sections !== 'object') {
        event.systemPromptOptions.sections = {};
      }
      event.systemPromptOptions.sections[statusKey] = staticSection;
    }
    guideWorkspaceTools(event);

    currentRunDigest = undefined;
    currentRunStartedAt = Date.now();
    try {
      const snapshot = await callBridge('/v1/digest', {}, ctx?.signal);
      if (typeof snapshot?.digestXml === 'string' && snapshot.digestXml) {
        currentRunDigest = snapshot.digestXml;
      }
      if (snapshot?.turnMeta && typeof snapshot.turnMeta === 'object') {
        pi.appendEntry(turnMetaEntryType, {
          ...snapshot.turnMeta,
          ...(typeof event.prompt === 'string' ? { userText: event.prompt } : {}),
          timestamp: currentRunStartedAt
        });
      }
    } catch {
      // If bridge is temporarily unavailable, Side Chat can still proceed using pull tools
    }
  });

  pi.on('context', (event) => {
    if (!currentRunDigest || !Array.isArray(event.messages)) return;
    let lastUserIndex = -1;
    for (let i = event.messages.length - 1; i >= 0; i -= 1) {
      if (event.messages[i]?.role === 'user') {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex < 0) return;
    const digestMessage = {
      role: 'custom',
      customType: 'desktop-side-main-digest',
      content: currentRunDigest,
      display: false,
      timestamp: currentRunStartedAt || Date.now()
    };
    const messages = event.messages.slice();
    messages.splice(lastUserIndex, 0, digestMessage);
    return { messages };
  });

  pi.on('agent_settled', () => {
    currentRunDigest = undefined;
  });

  pi.on('tool_call', (event) => {
    normalizeWorkspaceSearch(event);
  });
}
`
}
