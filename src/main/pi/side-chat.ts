import {
  SIDE_CHAT_META_ENTRY_TYPE,
  SIDE_CHAT_STATUS_KEY,
  SIDE_CHAT_TURN_META_ENTRY_TYPE
} from '@shared/types'
import { WORKSPACE_TOOL_HOOKS } from './workspace-tools'

export const SIDE_CHAT_ALLOWED_TOOLS = [
  'read',
  'grep',
  'find',
  'ls',
  'inspect_main_conversation',
  'inspect_main_changes'
] as const

export const SIDE_CHAT_EXCLUDED_TOOLS = [
  'write',
  'edit',
  'bash',
  'powershell',
  'codemode',
  'tool_search',
  'subagent',
  'computer',
  'generate_image',
  'mcp__*'
] as const

/**
 * Constant system-prompt section injected via `sections['pi-desktop-side-chat']`.
 * Kept byte-identical across every turn so providers retain full KV-cache prefix hits.
 */
export const SIDE_CHAT_STATIC_SECTION = [
  'You are Pi Desktop Side Chat — a strictly read-only companion running alongside the user\'s Main Conversation in the same workspace.',
  'Capabilities & guardrails:',
  '- You CANNOT modify files, run shell commands, invoke MCP servers, or spawn subagents. Never claim you edited files or executed commands.',
  '- Before each turn, a fresh `<main_conversation_digest>` snapshot is placed right before the user message. It is ephemeral and reflects the live state of the Main Conversation.',
  '- Use `inspect_main_conversation` to fetch full turn transcripts, search earlier turns, inspect a tool call output by `toolCallId`, or inspect the full goal/todo plan.',
  '- Use `inspect_main_changes` to inspect files edited by the Main Conversation (`scope: "session"`), uncommitted git changes (`scope: "worktree"`), or both (`scope: "all"`), and pass `file` for unified diffs.',
  '- Use built-in `read`, `grep`, `find`, and `ls` to verify workspace code directly.',
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
 * Generates the per-process Pi extension that enforces Layer-3 read-only
 * tool clamping, registers `inspect_main_conversation` / `inspect_main_changes`,
 * and injects ephemeral KV-cache-safe Main Conversation digests via `pi.on('context')`.
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
  const builtinReadTools = new Set(['read', 'grep', 'find', 'ls']);
  const sideInspectTools = new Set(['inspect_main_conversation', 'inspect_main_changes']);

  let currentRunDigest;
  let currentRunStartedAt = 0;

  ${WORKSPACE_TOOL_HOOKS}

  function isAllowedSideTool(name) {
    const tool = pi.getAllTools().find(t => t.name === name);
    if (!tool) return false;
    if (builtinReadTools.has(name)) return tool.sourceInfo?.source === 'builtin';
    if (sideInspectTools.has(name)) return tool.sourceInfo?.path === sideChatExtensionPath;
    return false;
  }

  function clampSideTools() {
    const allowed = pi.getAllTools()
      .filter(t =>
        (builtinReadTools.has(t.name) && t.sourceInfo?.source === 'builtin') ||
        (sideInspectTools.has(t.name) && t.sourceInfo?.path === sideChatExtensionPath)
      )
      .map(t => t.name);
    pi.setActiveTools(allowed);
    return allowed;
  }

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
    clampSideTools();
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
    const allowed = clampSideTools();
    if (event.systemPromptOptions) {
      if (!event.systemPromptOptions.sections || typeof event.systemPromptOptions.sections !== 'object') {
        event.systemPromptOptions.sections = {};
      }
      event.systemPromptOptions.sections[statusKey] = staticSection;
      if (Array.isArray(event.systemPromptOptions.selectedTools)) {
        event.systemPromptOptions.selectedTools.splice(0, event.systemPromptOptions.selectedTools.length, ...allowed);
      }
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
    if (!isAllowedSideTool(event.toolName)) {
      return {
        block: true,
        reason: 'Side Chat is strictly read-only and cannot modify files or execute commands.',
        terminate: true
      };
    }
  });

  pi.on('user_bash', () => ({
    result: {
      output: 'Side Chat is read-only; shell execution is disabled.',
      exitCode: 1,
      cancelled: true,
      truncated: false
    }
  }));
}
`
}
