# Conversation Stream V2 — Phase 1 Audit

Date: 2026-10-30
Scope: the main conversation area (`src/renderer/src/components/Thread.tsx` and every layer it depends on).
Method: source read-through of the real call chain, cross-checked against the installed Pi
package documentation (`node_modules/@earendil-works/pi-coding-agent/docs/json.md`,
`rpc-commands.md`) and exercised by the existing reducer/store tests. File names alone were
not trusted: every statement below was confirmed in the code path that actually runs.

## 1. Current architecture (verified call chain)

```
Pi child process (RPC, JSONL on stdout)
  src/main/pi/rpc-client.ts        byte/StringDecoder LF splitter, no readline
  src/main/pi/runtime.ts           per-session runtime, emits {ownerId, event}
  src/main/pi/supervisor.ts        one runtime per hot conversation, cwd gate
        │  IPC: runtime:event
        ▼
  src/preload/index.ts             window.pi.runtime.onEvent
        │
  src/renderer/src/store/useAppStore.ts
    bootstrap()                    onEvent → scopeEvent(payload) → ownerId
    handleEvent()                  run state (RunPhase), uiRequest, notices
    scheduleItems()                 one pending batch per owner thread
    drainPending()                  fold the batch into SessionThread.items
        │
  SessionThread[threadId].items    per-conversation projection, keyed by JSONL path/draft id
        │
  src/renderer/src/components/Thread.tsx
    buildTurns(items)              user message + everything it produced
    ThreadTurnView (memo)          one turn; reference-equality guard
    renderTurn()                   text / thinking / tools segmented into process folds
    ToolCard / BashCard / ...      leaf renderers
```

Key facts:

- **One reducer, two entry paths.** Live events (`applyEvent` in
  `src/renderer/src/lib/thread.ts`) and a replayed session (`itemsFromMessages`) produce the
  same `ThreadItem` union. This is what makes a reopened conversation render like a live one.
- **Tool call = one node.** `patchTool` keys by `toolCallId`, keeps the position of first
  appearance and merges patches instead of replacing. `proposed → running → ok | error |
  aborted` is the tool state machine (`ToolStatus`).
- **The run identity is client-minted.** Pi has no run/turn id. `handleEvent` mints `runId` on
  `agent_start` and `turnId` on `turn_start`; `runContextOf` stamps every projected item with
  them. Only `agent_settled` settles a run; `agent_end` explicitly does not.
- **Threads are isolated by the store.** `SessionThread` is keyed by session file (or
  `draft:…`); runtime events are already stamped `ownerId`, and `bindSet/bindGet` project one
  thread. `Thread` only ever reads the active projection.
- **Paint is batched per animation frame.** The reducer runs immediately into the pending
  batch; `drainPending()` applies it on the next `requestAnimationFrame`. Session switches,
  settle, and new chats drain first so a delta cannot land in the wrong thread.
- **Scrolling is local to `Thread`.** `stickRef` follows only while the reader is within
  `FOLLOW_RANGE` (80 px) of the bottom; scrolling up freezes follow and shows the
  “scroll to latest” button.
- **Styling is token-only.** `styles/tokens.css` holds the type/spacing/color scales;
  `styles/conversation-stream.css` holds the stream-specific rules; `prefers-reduced-motion`
  is honoured globally.

## 2. Issue list (what still fails the V2 brief)

### P1 — architecture

| ID | Finding | Evidence | Impact |
|---|---|---|---|
| A1 | There is **no explicit coarse event adapter**. `thread.ts` switches on raw Pi event names mixed with `assistantMessageEvent` sub-types; there is no single typed record carrying `threadId / runId / turnId / messageId / toolCallId / sequence / status`. | `src/renderer/src/lib/thread.ts:398-741`; `store/useAppStore.ts:2113-2146` | Every new consumer has to re-learn Pi's wire shape; identity rules are implicit and easy to break. |
| A2 | `StreamContext.sessionKey` is never validated against the event source. Isolation is enforced by the store binding alone. | `thread.ts:14-19`, `useAppStore.ts:522-524` | Safe today, but a reducer called with the wrong context silently accepts foreign events. |
| A3 | `Thread.tsx` is a 1,045-line file owning scroll, search, history folding, turn grouping, process segmentation, run status, error banner and per-turn rendering. Leaf pieces such as the assistant body cannot be reused or tested in isolation. | `src/renderer/src/components/Thread.tsx` | Hard to evolve; the V2 component boundaries do not exist as real modules. |
| A4 | Message/assistant blocks are not exposed through a dedicated `AssistantMessage` / `StreamingText` component; `AssistantText` lives inside `MessageItem.tsx` while the turn-body composition lives in `Thread.tsx`. | `MessageItem.tsx:84-91`, `Thread.tsx:922-1045` | The “document, not bubble” unit has no stable seam; streaming optimisations would have to touch the container. |

### P1 — streaming / behaviour

| ID | Finding | Evidence | Impact |
|---|---|---|---|
| B1 | **Collapsed long output is paginated by characters only (`RESULT_PREVIEW = 1200`), but after “Show more” the full result is rendered at once. `BashCard` renders its complete output immediately.** | `ToolCard.tsx:38-39, 222-225, 336-350`; `ToolCard.tsx:161-169` | A 100k-line command log creates one enormous DOM text node; scrolling becomes unresponsive and the transcript jumps. |
| B2 | **Scroll position is not remembered per conversation.** `initialScrollRef` only knows “current session + done”; a switch always lands at the bottom (or top for collapsed history). | `Thread.tsx:146-152, 231-247` | The reader loses their place every time they glance at another conversation — an explicit V2 acceptance item. |
| B3 | Run activity is one generic sentence plus a tool summary (`Read src/x.ts`). It does not distinguish “reading a file / searching / running a command” even though the tool tone is already known. | `Thread.tsx:206-229`; `RunStatusRow.tsx:86-110` | The brief's “正在读取文件 / 正在执行命令” states are not actually rendered. |
| B4 | Thinking content is rendered verbatim when a thought is expanded. | `MessageItem.tsx:131-196` | V2 says raw internal reasoning must not be surfaced as conversation content; only a lightweight state indicator is required. |
| B5 | Expanding a tool body above the viewport relies on browser scroll anchoring; no explicit `overflow-anchor` / height containment is declared. | `.tool__body` in `styles/global.css:2363-2368` | A tall log can move the reader's viewport when opened/closed (acceptance: “展开工具日志不能造成页面异常跳动”). |

### P2 — polish / maintainability

| ID | Finding | Evidence | Impact |
|---|---|---|---|
| C1 | Turn spacing is 16 px (`--sp-5`), below the V2 24–32 px message rhythm. | `.thread__inner` in `styles/global.css:1778-1788` | Turns read tighter than the V2 density target. |
| C2 | `RunStatusRow`, `RunOutcome`, `BashCard`, `FileChangeRow` are each embedded in an unrelated file, so the component inventory in the brief has no matching seam. | `RunStatusRow.tsx`, `ToolCard.tsx`, `FileChangeSummary.tsx` | Harder to test; naming drifts from the design system. |
| C3 | Long output text has no max-height of its own inside `tool__body--group`; nested tool cards can grow unbounded. | `.tool__body--group` in `global.css:2374-2385` | A grouped batch of long outputs can take over the transcript. |

## 3. Affected files

**Core projection**

- `src/renderer/src/lib/thread.ts` — event switch, item types, `patchTool`, hydration.
- `src/renderer/src/store/useAppStore.ts` — event ingestion, batching, run phases, thread projection.
- `src/shared/types.ts` — `PiEvent`, `AgentMessage`, `ToolApproval`.

**Presentation**

- `src/renderer/src/components/Thread.tsx`
- `src/renderer/src/components/MessageItem.tsx`
- `src/renderer/src/components/ToolCard.tsx`
- `src/renderer/src/components/ToolGroup.tsx`
- `src/renderer/src/components/ProcessTrail.tsx`
- `src/renderer/src/components/RunStatusRow.tsx`
- `src/renderer/src/components/FileChangeSummary.tsx`
- `src/renderer/src/components/Markdown.tsx`
- `src/renderer/src/components/ExtensionDialog.tsx` (approval gate)

**Styles**

- `src/renderer/src/styles/conversation-stream.css`
- `src/renderer/src/styles/global.css` (thread/composer layout, tool body)
- `src/renderer/src/styles/tokens.css`

**Tests**

- `tests/thread.test.ts`, `tests/run-state.test.ts`, `tests/run.mjs`

## 4. Real Pi RPC event → display mapping (current, verified)

| Pi event | Payload used | Projection |
|---|---|---|
| `agent_start` | — | opens `RunState` (`phase: working`, `runId` minted) |
| `turn_start` | — | new `turnId`, run `turns += 1` |
| `message_start` (user) | `message.content/text/timestamp` | `UserItem` |
| `message_start` (assistant) | `message.timestamp` | streaming `AssistantItem` |
| `message_update` → `text_start/delta/end` | `contentIndex`, `delta`, `content` | text block; `text_end` is authoritative |
| `message_update` → `thinking_start/delta/end` | same | thinking block; hidden by default |
| `message_update` → `toolcall_start/delta/end` | `id`, `toolName`, `toolCall.arguments` | `ToolItem` `proposed` + arguments; one node per `toolCallId` |
| `message_end` | full `message` | authoritative assistant content / usage / model / stopReason |
| `tool_execution_start` | `toolCallId`, `toolName`, `args` | node → `running`, records `startedAt` |
| `tool_execution_update` | `toolCallId`, `partialResult` | newest `progress` snapshot (replaced, never appended) |
| `tool_execution_end` | `toolCallId`, `result`, `isError`, `durationMs` | node → `ok` / `error`; exit code from `structuredContent.exit_code` |
| `turn_end` | `message`, `toolResults` | not projected separately (the message/tool events already carry it) |
| `agent_end` | `messages`, `willRetry` | not a settlement; run stays open |
| `agent_settled` | `aborted` | only settlement; `markAborted` turns moving nodes into `aborted` |
| `auto_retry_start/end` | attempt/delay/error | retry state + notice |
| `compaction_start/end` | reason/result/aborted | notice |
| `bash_execution_update` | `id`, `delta` | `BashItem` (terminal- prefixed ids dropped) |
| `extension_ui_request` | method/options/approval | modal `ExtensionDialog`, run phase `waiting_approval` |
| `extension_error` | `error` | error notice |
| `client_notice` | `level`, `text` | notice |

## 5. Refactor plan

**Phase 2 — Event adapter (new module, no protocol change)**

1. Add `src/renderer/src/lib/stream-events.ts`: a typed `StreamEvent` record
   (`message.started | message.block.started | message.delta | message.block.completed |
   message.completed | tool.proposed | tool.args | tool.started | tool.output.delta |
   tool.finished | run.started | run.turn.started | run.status | run.finished |
   approval.requested | approval.resolved | command.output.delta | notice | error`) carrying
   `threadId / runId / turnId / sequence / messageId / toolCallId / status` plus the raw
   `source` record.
2. `thread.ts` keeps its public `applyEvent(items, piEvent, context)` API but delegates the
   wire-shape switch to `normalizePiEvent` and switches the projection on semantic types.
   Behaviour is byte-for-byte compatible; all existing reducer tests must stay green.
3. Record the thread id / event sequence on projected items (`threadId`, `sequence`) so a
   consumer can prove ownership without trusting the view.

**Phase 3 — Component layer (new `components/conversation/` modules)**

| Brief component | Implementation |
|---|---|
| ConversationTimeline | `Thread.tsx` (container; scroll + search + history) |
| UserMessage | `MessageItem.UserMessage` |
| AssistantMessage | `Thread.ThreadTurnView` + `renderTurn` |
| StreamingText | `conversation/StreamingText.tsx` (extracted from `MessageItem.AssistantText`) |
| ToolCallRow | `ToolCard` `presentation="link"` |
| ToolResultPanel | `conversation/ToolResultPanel.tsx` (extracted from `ToolCard`) |
| CommandOutput | `conversation/CommandOutput.tsx` (extracted `BashCard`) |
| FileChangeRow | `conversation/FileChangeRow.tsx` (extracted from `FileChangeSummary`) |
| ThinkingIndicator | `RunStatusRow` |
| ApprovalGate | `ExtensionDialog` (Pi approval is modal by protocol) |
| ErrorNotice | `conversation/ErrorNotice.tsx` |
| RunSummary | `conversation/RunSummary.tsx` (extracted `RunOutcome`) |

**Phase 4 — Streaming / performance**

- `lib/log-output.ts` + `conversation/LogOutput.tsx`: page long output by lines (200 lines per
  page, “show more lines”), use it in tool results and bash output. No virtualisation
  dependency; a page is still one `<pre>` so selection/copy keeps working.
- Per-thread scroll memory in `Thread`: save `{ top, atBottom }` on scroll and restore on
  session switch; follow only when the reader was at the bottom.
- `lib/activity.ts`: map tool tone → “Reading a file / Searching files / Editing a file /
  Running a command”, with the concrete target as secondary text. Never guessed from model
  prose.
- Keep rAF painting; memo boundaries already prevent completed turns from re-rendering.

**Phase 5 — Visual polish**

- Turn rhythm 16 → 24 px, tool body `overflow-anchor: auto`, long-log pagination styles,
  expanded-body containment; all values from existing tokens.

**Phase 6 — Validation**

- `npm run typecheck`, `npm test`, `npm run build`.
- Real Electron capture against a recorded session, light + dark, 1440×900; expanded tool,
  long output, running state and narrow width captured where reachable.
- Reducer tests for the new adapter and pure helpers; existing 169 tests must stay green.

## 6. Non-goals / constraints

- Do not change the Pi RPC protocol, process lifecycle or the supervisor.
- Do not reimplement the agent loop or fabricate missing protocol data.
- Keep `applyEvent`/`itemsFromMessages` contracts stable for existing tests.
- Approval stays a modal: Pi's approval arrives as an `extension_ui_request` and must be
  answered through `runtime:respondUi`; it is not a second inline run state.
