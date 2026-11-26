# AGENTS.md

Rules for agents and humans working in this repository.

## What this is

Pi Desktop is an Electron GUI that drives the [Pi coding agent](https://github.com/earendil-works/pi)
over its RPC protocol. It does **not** reimplement the agent — it is a protocol client.

## Non-negotiables

1. **Never parse the Pi protocol with `readline`.** Pi's JSONL framing splits on `\n`
   only. `U+2028` and `U+2029` are valid inside JSON strings and `readline` treats them
   as line breaks, which corrupts records. Use the byte/`StringDecoder` splitter in
   [`src/main/pi/rpc-client.ts`](src/main/pi/rpc-client.ts).
2. **stdout is protocol, stderr is diagnostics.** Never write to the Pi child's stdout.
3. **Correlate commands by `id`.** Pi processes commands asynchronously; responses do
   not arrive in request order.
4. **The renderer has no Node access.** `contextIsolation: true`, `nodeIntegration: false`.
   Anything the renderer needs goes through the typed bridge in
   [`src/shared/types.ts`](src/shared/types.ts) — including `process.platform`, which
   is not available in the renderer.
5. **Events are the source of truth.** The UI is a projection of Pi's session events
   (`src/renderer/src/lib/thread.ts`). Do not duplicate state that Pi already owns.
6. **Never touch a destroyed window.** Pi keeps emitting records for a moment after
   it is asked to stop, and that can land after the window closed. Accessing
   `window.webContents` on a closed window hangs or throws "Object has been
   destroyed" and kills the main process. Always check `isDestroyed()` first —
   use the `sendToWindow` helper in `src/main/ipc.ts` instead of sending directly.
7. **Answer extension dialogs.** `select`, `confirm`, `input` and `editor` block the
   agent until the client replies with an `extension_ui_response` carrying Pi's own
   request id — mint a new id and Pi waits forever. The answer goes out through
   `runtime:respondUi`; never through `runtime:request`.
8. **Treat session paths from the renderer as untrusted.** Before hydrating,
   resuming, renaming or removing a session, resolve it inside
   `resolveSessionRoot()` and reject traversal, symlink escapes, non-JSONL
   paths and non-files. Hydration and cold renames consume the same verified
   `FileHandle` they opened with.
9. **Read workspace files through the verified handle.** `fs:read`, text search
   and image previews use `openWorkspaceFile()` and consume its same
   `FileHandle`; never reopen a path after checking it resolves inside the workspace.

## Layout

| Path | Role |
|---|---|
| `src/main/` | Electron main process: window, IPC, settings, session index |
| `src/main/pi/` | Pi integration: CLI discovery, RPC client, runtime, one-shot CLI |
| `src/main/window-state.ts` | remembers the size and place of the window |
| `src/main/side-chats.ts` | side-chat bindings: one side session per main conversation |
| `src/renderer/src/components/side-chat/` | the side chat panel: its header, empty state and reference chips (its transcript and composer are the main chat's own) |
| `src/preload/` | `contextBridge` surface — the only renderer↔main channel |
| `src/renderer/` | React UI |
| `src/renderer/src/components/Launcher.tsx` | the palette over the app (`Ctrl+Shift+P`) |
| `src/renderer/src/components/Sidebar.tsx` | the workspace panel: projects and conversations |
| `src/renderer/src/components/TaskPanel.tsx` | the task rail: environment, background tasks, progress, deliverables |
| `src/renderer/src/lib/session-indicator.ts` | the one mark a conversation row carries |
| `src/renderer/src/lib/project-icons.ts` | the emoji and tint a project can wear |
| `src/shared/types.ts` | Protocol and domain types shared by every layer |
| `scripts/rpc-smoke.mjs` | Spawns the bundled CLI and exercises the RPC commands |
| `scripts/rpc-ui-smoke.mjs` | Round-trips the extension UI dialogs over the wire |

## Commands

```bash
npm run dev         # run with hot reload
npm run build       # production build into out/
npm run typecheck   # must pass before committing
npm run dist        # installers into release/
npm test            # unit suites (tests/run.mjs), a couple of minutes
npm run test:ui     # real renderer against the built app (needs `out/`)
npm run test:e2e    # bundled CLI, a real run, stop mid-run
node scripts/rpc-smoke.mjs "C:/some/project"   # protocol smoke test
node scripts/rpc-ui-smoke.mjs                  # extension UI smoke test
```

## Adding a Pi capability

1. Check the upstream docs first: `packages/coding-agent/docs/rpc-commands.md` for
   commands, `json.md` for events.
2. Add the command/event to the shared types.
3. Wire it through `src/main/ipc.ts` → `src/preload/index.ts` → the store.
4. If it changes the conversation, extend the reducer in
   `src/renderer/src/lib/thread.ts` — not the components.
5. Verify with `npm run typecheck` and a real run against the bundled CLI.

## The conversation stream

The transcript is a projection of Pi's events, and the projection is a single
reducer: `lib/thread.ts`. Live events and a replayed session go through the
same code, so a reopened conversation and a running one render identically.
The raw wire shape is handled by `lib/stream-events.ts`: it normalizes every
Pi record into a typed `StreamEvent` carrying `threadId`, `runId`, `turnId`,
`sequence`, `messageId`, `toolCallId` and `status`. `applyEvent` is only the
compatibility door; the projection switch is `applyStreamEvent`. Do not add a
second event switch inside a component. Tool-call message identities are
released when `agent_settled` closes a run; the per-session sequence stays
monotonic across later runs.

What that buys, and what it costs:

- A tool call is **one node**, keyed by `toolCallId`, from the moment the
  model names it (`proposed`) through execution (`running`) to its end
  (`ok` / `error` / `aborted`). A call that never ran stays `proposed` and
  says "not run" — it did not succeed, so it must not look like it did.
- The node keeps the position of its **first appearance**, so parallel tools
  that finish out of order do not reorder the conversation. `patchTool` in
  `lib/thread.ts` is the only writer; it merges a patch rather than
  replacing, which is what stops `tool_execution_start` from wiping the
  arguments `toolcall_end` already delivered.
- A finished tool node (`ok` / `error` / `aborted`) is **terminal**: a late
  `tool_execution_start`, `tool_execution_update` or duplicated `toolcall_end`
  must not turn it back into a spinner or a proposal. Replay creates a
  `proposed` node for a tool call that never produced a `toolResult`, so
  "not run" survives reopening.
- Readable thinking delivered by Pi is grouped into one `ThinkingBlock` per
  turn. The "Thinking content" row starts collapsed and mounts its body on
  demand. Provider-redacted thinking and signatures stay out of the transcript.
- `tool_execution_update.partialResult` is the tool's **newest** partial
  result, not an increment. It replaces the previous one; appending it
  repeats the whole output on every update.
- `text_end` and `message_end` are the authority for content. Deltas are
  replaced by them, not added to.
- `agent_end` is not the end of the work: Pi may retry, compact or continue
  on its own. The run only settles on `agent_settled` (with `aborted`
  saying whether the user stopped it), and `markAborted` is what turns
  everything still moving into `aborted` at that moment. A process that dies
  mid-run never writes that record, so `SessionSupervisor` mints one with
  `crashed` on an unexpected exit and the store settles it as `failed`;
  otherwise the run stays open for the rest of the app's life. A stop on an
  already idle run is skipped for the same reason: Pi answers `abort` but
  publishes no settle.
- The run state lives in the store (`run`, `transport`), not in the thread:
  `runId` / `turnId` are minted by the client because Pi's protocol has
  neither, and `transport` is deliberately separate from the run phase —
  a lost connection is not a failed run.
- Text deltas are folded into the store immediately but **painted once per
  animation frame** (`scheduleItems` in `useAppStore.ts`). The store is the
  truth; the frame is the paint. `drainPending()` runs before anything that
  changes the conversation (session switch, new chat, settle) so a queued
  delta can never land in the wrong session. Adjacent text deltas in one
  pending batch are merged before the reducer, so a fast provider does not
  copy the whole transcript once per token.
- A long streamed text block is parsed as **finished Markdown chunks plus one
  live tail** (`lib/streaming-markdown.ts`); `StreamingText` renders a finished
  chunk once and re-parses only the tail on the next delta. All chunks share
  one outer `.md` container so block spacing still reads as a single document.
  A fence that is still open is the one tail Markdown cannot bound: no block
  boundary exists inside a fence, so a streamed log or diff would re-parse the
  whole growing block on every frame. Its content is literal, so
  `parseOpenFenceTail` reads the opener (marker length, info string,
  indentation, closing rules) and `OpenFenceBlock` draws the same code block
  `Markdown` would, straight from the text; closing the fence swaps in the
  parsed block with identical markup. Mermaid fences stay on the Markdown path
  because they become a diagram rather than a code block.
- **A provider that dumps a paragraph in one delta must not paint it in one
  frame.** `StreamingText` keeps a presentation-only cursor (`useRevealedText`
  + `lib/streaming-reveal.ts`) that advances the visible prefix toward the
  store's full text. The cursor is not state the store owns — the store still
  holds the complete text. It advances with `requestAnimationFrame`, stops
  when it catches up, and resumes after `text_end`/`message_end` flip
  `streaming` false so a big chunk is not cut short. `prefers-reduced-motion`
  shows the full text immediately, and a block that mounts already settled is
  a history message that is never typed out. The split and the reveal use the
  same visible prefix, so a finished block is never revealed before the text
  that would make it a block has appeared.
- **What a turn changed is its closing statement.** `FileChangeSummary` renders
  only once the turn settles — `turnChanges.length > 0 && !liveTail` in
  `Thread.tsx`. A card that counted the files while the agent was still editing
  read as work that had finished; the tool rows above already show each edit as
  it happens.

Tool rows are compact by design: icon, verb, object, state, duration — 32–40
pixels. Everything else (arguments, output, diff) is behind the caret. The
registry is `lib/tool-renderers.ts`; an unknown tool still gets a card,
because an MCP server or a project extension is a normal outcome, not a
reason to drop a call from the stream.

A row in the stream is a link, not a card, so it carries no surface of its
own: the pointer must not paint a gray band across the column. The hover
surface belongs to a card. The lock is
`.tool.tool--link:hover, .tool.tool--link:focus-within` in
`styles/conversation-stream.css`: its specificity (0,3,0) outranks any
`.tool:hover` a later stylesheet adds, and it repaints the link transparent. A
new card hover rule must exclude links itself —
`.tool:hover:not(.tool--link)` — because `.tool--link:hover` on its own is a
lower weight than `.tool:hover` plus whatever else that rule carries.

The stream's leaf components live in `components/conversation/`:
`AssistantMessage` owns process segmentation, `StreamingText` owns the reply
document, `ToolResultPanel`/`CommandOutput`/`LogOutput` own expandable output,
`FileChangeRow`/`RunSummary`/`ErrorNotice` own their rows. Long output is
paged by lines (200 per page) — never render a whole build log at once.

`RunSummary` is the completed turn's top row (label, duration, chevron), not a
divider at the end. Its chevron folds the tool/thinking process; the answer
stays visible. `AssistantMessage` receives `processOpen` so hiding the process
never hides the reply. Retry and compaction notices fold with the tools. The
reason a run failed stays below its summary, including when the process is
folded. With auto-fold enabled, opening a failed run shows its group summaries
first. Each group can then be expanded to inspect the individual tool results.

**A reply is copied from its own row, as Markdown.** The response actions under
a settled answer carry one 20px copy control (`assistant__copy`), revealed on
hover or keyboard focus like the user message's actions. It writes
`replyMarkdownOf(turn)` from `lib/turns.ts`, which starts where `replyStartOf`
starts: progress commentary before the last tool call is not part of the
answer and is not copied. The painted text would lose its code fences, so copy
the source text and never `textContent`. A turn that stopped before writing a
reply copies what it did write, and an image-only reply has no copy control
because its data is not a sentence — the picture is saved from its own card.
The launcher's *Copy the last answer* / *Copy the whole conversation* commands
remain the whole-conversation doors; they are not a second implementation of
this button.

**A conversation leaves as Markdown through the same projection.** The File
menu's *Export as Markdown…* (and the launcher's matching entry, and the
`export-md` app command) call `exportSessionMarkdown`, which wraps
`transcriptOf(items)` with a title and where the file came from
(`lib/session-markdown.ts`) and sends that text to `sessions:exportMarkdown`.
The main process asks for a path, checks the size and the `.md`/`.markdown`
extension, and writes beside the destination through a temporary file so a
failed write never leaves half a conversation where the reader pointed it.
Exporting never starts Pi: the transcript on screen is the document, so a
cold, stopped or still-running conversation exports from what it has, and the
HTML export's `ensureRuntime` is not a precedent here. Tool output is not part
of the file (`transcriptOf` drops it) — the export is what was said, not a
build log.

**"Waiting for model response" describes an empty screen, not a slow request.**
The live label is the only thing on screen while a turn has produced nothing, so
`Thread` passes `showWaitStatus` only while the turn has no output at all —
`turnHasOutput` (assistant blocks, tool rows, shell output) gates it, and
`RunSummary` holds the counter to the current request's clock. A wait for the
*next* block — after a tool, or between text blocks — must not put the label back
on top of an answer the reader can already read; those stretches read `Working`.
Codex draws the line the same way, and `tests/ui-regressions.mjs` guards it.

Manual context compaction refreshes session state and keeps the transcript.
Pi's `compaction_end` supplies the notice. The `get_messages` response is the
compacted model context, so using it here would remove older messages and tool
results from the view.

`Thread` remembers the scroll position per conversation (session file or draft
key) in a process-level map so switching to an empty chat cannot forget it;
`rekeyThread` migrates a draft's entry when Pi writes the session file. It only
follows while the reader is at the bottom. Do not call `scrollToBottom` on
every update; expanding a tool body must not move the reader's viewport.
Per-conversation tool/file/process/history expansion lives in
`lib/view-state.ts`, not in component-local state.

**A folded history opens in one action, one page per frame.** The history row
carries *Up N messages* — one 20-turn page, unchanged — and *Load all*, which
walks the fold to zero with the same `HISTORY_PAGE_TURNS` per step and waits
two animation frames between steps so React commits and the browser paints
each page. Mounting 400 turns in one commit blocks the renderer for about a
second (measured); the chain keeps every frame short and lets the row's count
fall visibly. A session change or unmount cancels it through
`loadAllHistoryToken`, because the chain writes the view state of the session
it started in. Both controls disable while it runs and the row carries
`aria-busy`; opening a hit or a jump still uses `expandHistory`, which writes
zero at once because the reader is waiting for one specific turn.

Tests: `npm test` runs the reducer unit tests (`tests/thread.test.ts`,
against the real RPC event shapes), `npm run test:e2e` spawns the bundled
CLI and drives the real reducer with a real run — including a stop mid-run.
A suite only runs if `tests/run.mjs` lists it; that list is the gate, and
files left off it read as coverage without being any. The bundler compiles
JSX with the automatic runtime (matching the app's tsconfig) and the child
runs with `--test-timeout` plus `--test-force-exit`: a hung test fails on its
own, and a library that leaves a pending handle cannot hold the run open after
its suite has reported.

## The session tree

Pi stores a session as a tree of entries, and two commands move around it:

- `fork` starts a new session from a user message. It forks **before** that
  message: the new branch keeps the earlier history and the message itself comes
  back as text, so the client puts it back in the composer.
- `clone` copies the active branch into a new session at the current position.

Both load the new session's JSONL when the worker switches files. The disk
transcript retains the original history through compaction and keeps loading
if the reader opens another conversation before the copy is ready.

Both need the session to be on disk already, so they fail on a session that has
never received a message. `get_fork_messages` reports prompts from the session
tree, including other branches. An edit uses the displayed message's persisted
entry ID. A live message without an ID resolves by timestamp and exact text
against the saved branch. Pi checks the ID is on the current branch before it
rewinds.

**Editing a user message is not a fork.** The pencil sends the bundled
`desktop-rewind` extension command, which calls Pi's `ctx.navigateTree` on the
message entry: the same session file moves its leaf to the message's parent and
the prompt returns to the composer. The command appends a custom entry there so
Pi reopens at that position even if the edited prompt has yet to be sent.
The transcript keeps the saved history before the edited entry, including
messages and tool results older than the model's most recent compaction.
`forkFrom` stays for the session-tree fork action only.

**An edit can be taken back.** The rewind first appends a
`pi-desktop-rewind-source` marker to the branch it is about to leave and writes
that marker's id into the `pi-desktop-rewind` entry, because the old tip may be
a user message and navigation stops *before* one. `desktop-undo-rewind` moves
the leaf back to that marker and appends a child of it, so reopening the JSONL
follows the restored branch. Both markers are `display: false`: they are
positions, not transcript rows. The undo is only offered while the conversation
still ends on the rewind marker — sending a prompt from the rewound branch
moves the branch on, and going back would silently drop that message — and the
renderer keeps that window in `rewindUndo` (per conversation, cleared by
`sendPrompt`), showing it as a row above the composer. A cancelled or refused
navigation puts the leaf back where it found it before throwing.

A hot conversation is renamed with `set_session_name` on its own process. A cold
one gets a single `session_info` line appended to its JSONL, and only when no
process is writing that file. Naming never switches the conversation on screen.

`SessionTreeDialog` reads `get_tree` and draws the whole tree; `lib/session-tree.ts`
turns the payload into rows, skips bookkeeping entries without losing the depth of
their children, marks the path to the leaf, and falls back to the last visible row
on that path when the leaf itself is a meta entry. A user row's fork action calls
the store's `forkFrom(entryId)` and closes the dialog — the prompt comes back in
the composer, exactly like the `/branch` command.

The dialog also filters rows (ancestors kept, folds untouched so clearing restores
them), remembers collapsed branches in localStorage keyed by `activeSessionFile`,
and walks the branch tips with two header buttons that expand the path, scroll and
flash the row.

## The sidebar is a list, not a switch

A project row in the sidebar **only expands and collapses** its conversations. It
does not make the project active, and it never touches the runtime — so browsing
another project cannot end the conversation Pi is working in. The caret on the
right of the row is what says so; a project becomes active only through a
deliberate action: picking a folder, the launcher, `Ctrl+1…9`, or a worktree row.

A **conversation** row only changes the transcript on screen. It does not call
`switch_session`, `abort`, or kill a process. Every conversation keeps its own
thread in `threads`, keyed by the JSONL path, or by `draft:…` until Pi writes a
file. Events are stamped with the runtime that owns them, so a background run
keeps updating after the view has moved on.

**The list is one keyboard column.** ArrowUp/ArrowDown walk the rows that carry
`data-sidebar-row` — project rows, conversation rows and archived group heads —
in the order they are drawn; Home/End jump to the ends, and ArrowUp at the first
row hands focus to the search button above it. The handler sits on the `<aside>`
and acts only when the event starts on a row itself, so a row's own buttons and
the rename input keep their own keys, and rows without a client rect (folded
away) are skipped. It is an addition to Tab order, not a roving tabindex: every
row is still reachable by Tab.

**The search dialog is keyboard-complete.** Enter in the field opens the top
result — projects first, then conversations, then message hits, in the order
they are drawn — and ArrowDown moves into the results. Inside them the arrows
walk the rows and ArrowUp at the first returns to the field; Escape closes from
either place. Rows carry `data-search-result`, and the dialog's arrow handler
acts only when the event starts on such a row, so the field keeps its own
combobox keys (recents use the same Up/Down when the query is empty).

Opening a conversation does not start Pi. A conversation that stays on screen
for a moment prewarms its own process in the background (`schedulePrewarm`),
and focusing the composer starts a cold runtime; the prompt itself is still sent
only when the user submits it. A prewarmed process carries the speculative mark,
so moving the view on stops it again. Drafts are never prewarmed: Pi writes a
session file as soon as it starts, so a chat that was never written would leave
an empty conversation on disk. `SessionSupervisor` holds one process per hot
conversation, and the same JSONL never has two writers (`fileOwners` and the
per-file lock keep every open session file single-writer). Separate
conversations in the same working directory claim `'shared'` access and run
concurrently; desktop Git writes take `'exclusive'` access via `withCwdLock`
(blocking while any overlapping conversation is working, and queueing new
prompts until the exclusive lock releases). The working-directory gate is shared
across app processes. Parent and nested folders overlap; sibling folders remain
independent. A Git write started during local lease cleanup waits for that
cleanup before checking whether it can claim the directory.
Switching projects is also only a view change. Closing or removing a workspace
is what stops that folder's processes — but **removal never waits for them**:
`workspaces:remove` writes the settings first and lets `stopCwd` drain behind
it, because a busy agent can spend its whole seven-second abort timeout and the
row used to sit on screen for all of it. `stopCwd` claims the folder
synchronously, so nothing new starts there while the old runtimes shut down.
The removal also answers with the settings it wrote, so the renderer does not
re-read them under the settings lock a second time.

The sidebar running mark reads `threads[file].isStreaming`. `stop()` aborts the
conversation on screen, not whichever one happens to be running in the
background.

**Delete is final; Archive is the reversible action.** `removeSessionFile`
unlinks the verified JSONL inside the session root while its mutation lock is
held — it must not use `shell.trashItem`, because a deleted conversation must
not leave a recoverable copy in the OS Recycle Bin. The confirmation body says
the session file will be permanently deleted; keep that copy explicit.

**Archived conversations are grouped by project in the single list.** The flat
column ("Single list") has no project rows at all, which is what makes it quick
to scan — but an archived conversation is exactly the row whose folder is not
obvious from its surroundings. `groupArchivedByProject` in
`lib/sidebar-view.ts` therefore takes archived rows out of the column and puts
them back below it, one heading per project: the caller's project order holds,
a folder that order does not name still gets a heading from its own folder name,
and archived chats with no folder close the list. The head is a **fold control**:
a button carrying a caret and `aria-expanded` that opens and closes that
folder's archived rows, never touching the runtime. The open/closed set lives in
the sidebar's own component state, so it lasts for the session rather than across
a relaunch, and a search opens every group, because a hit inside a folded group
would be invisible. Its glyph still hangs in the row indent so the project name
lines up with the conversation titles underneath. The
`All conversations (show archived)` filter also gets an `Archived` section head,
because the column above holds current work; in `Archived only` mode every row
is archived, so the group headings speak for themselves. Tree grouping needs
none of this: its project rows already say where a conversation came from.

**Only a conversation list folds, and its caret sits at the right.** The heads
that label conversations —「对话」over the single list, and「对话」over the chats
with no project — carry one caret at the right end of the head; the list hides
under it while the head stays on screen, because the caret is the only way back.
The「项目 / Projects」head does **not** fold: the project rows are the tree itself,
and folding them away hides the list the reader opened the sidebar for. The
label stays plain text, so a click on the name cannot fold anything; the
hover-revealed view menu steps left of the caret instead of under it. Open points
down, folded points right. The state is a view preference (`lib/sidebar-fold.ts`,
localStorage) keyed per list (`chats`, `chats-without-project`), so folding one
list never folds another. A filter in the sidebar's field opens a folded list,
because a match hidden inside it is the one thing a search must not do.

### The name in the sidebar head

The app's name is a **drawing, not text**. `PiWordmark`
(`components/PiWordmark.tsx`) fills "Pi Desktop" one pixel at a time on a
5-column cell, so it reads like a terminal (TUI) font: no pixel font ships with
the app, and the system UI font does not read as a terminal. The grid is 56x8
(7:1 — the `p` descends into the eighth row) and the glyph table is duplicated
in `scripts/make-wordmark.mjs`, which writes `build/wordmark-pixel.svg`, and
inlined once more in `src/renderer/index.html` for the startup screen — that
screen paints before React, so it cannot use the component, and an `<img>`
would arrive a frame late and lose `currentColor`. All three are the same
drawing and must stay byte-identical; `tests/wordmark.test.ts` checks the
component, the asset and the inline copy. The mark inherits `currentColor` so
it follows `--sidebar-text` (and the startup screen's `--text-primary`),
`shape-rendering: crispEdges` keeps the steps square, and only the dot of the
`i` wears the logo's coral.
Do not "fix" it back into a `<span>`: the sidebar head has no font-size rule for
the name any more, and nothing ellipsises it — at the 200px minimum width the
mark leaves ~22px of slack before the search button.

### What a row says about itself

A conversation row carries **one** mark, and the mark is derived, never
stored twice: `sessionIndicator()` in `src/renderer/src/lib/session-indicator.ts`
turns the thread into `needs-input` / `error` / `unread` / `running` / `idle`,
and the row writes it into `data-indicator`. The precedence is the point: a
waiting dialog outranks everything, a failure outranks an unread answer.

`unread` and `error` live in `thread.notice` and mean the same thing — *there
is something in this conversation the reader has not looked at*. A run that
settles while another conversation is on screen leaves the mark behind;
opening the conversation clears it (`selectSession` / `openWorkspace`), and a
new run clears it too. A conversation the reader is watching leaves no mark:
it speaks for itself. Do not add a second flag for "the reader has not looked
at this" — one mark, one place.

A project row wears an **icon** and a **tint**. The emoji and the tint live
in the workspace (`Workspace.icon` / `Workspace.iconColor`), and the picker
hangs off the project icon itself, which is a control of its own — clicking
the icon opens the picker, clicking the rest of the row still only folds the
list. The icon list and its keywords come from MCode's own picker
(`src/renderer/src/lib/project-icon-data.ts`, generated), so the same words
find the same emoji in both apps. The tint is a token, never a literal: the
component writes `data-icon-color` and the stylesheet picks the hue.

### The row's hover card

A row's details live in a **card**, not in the native `title` attribute:
`SidebarTip` (`components/SidebarTip.tsx`) draws a label/value list in a portal,
positioned from the row's own rectangle, so a scrolled or clipped list cannot cut
it off and the card never covers the row it describes. `useHoverTip` owns the
"pointer is resting here" state for one row and returns handlers that go on the
row's own button — never on a wrapper element, because the rows are laid out to
the pixel and a wrapper would move the title. The delay before it appears and
the grace period after the pointer leaves are both there so moving across the
list to click something does not flash a card. A `focus` event opens it only
when it did not follow a pointer press: a click focuses the button too, and a
card that popped up on every click would stay over the list. Do not test
`:focus-visible` for that — it is a heuristic, and it is false for a
programmatic focus. One card exists at a time, so it has one fixed id
(`SIDEBAR_TIP_ID`) and the described row carries `aria-describedby` only while
the card is up.

The card answers "when" and "where": `Created` is the moment the row joined the
list, `Conversations` its count, `Path` the project folder. The conversation
row's `Path` is `SessionMeta.cwd` — the folder the agent runs in — and never
`SessionMeta.file`, the JSONL under Pi's own `~/.pi/agent/sessions` storage; the
latter answers "where is the transcript cached", which is not what the row is
asked. A project has no start date
of its own when it is known only from sessions, so `collectProjects` falls back
to its oldest conversation; `Workspace.createdAt` is written when the folder is
registered and stays absent for a folder registered before the field existed —
never `0`, which would read as 1970. A conversation's start comes from Pi's
session header (the first JSONL line, never rewritten); `updatedAt` cannot stand
in for it because a resumed session moves that forward on every message.

### Project order

The order of project rows is `settings.projectOrder` — the path list the user
arranged, and it includes folders that are only known from sessions. The
`workspaces` array is registration data, not a sort key; selecting a project
adds its workspace without moving its row. `lastOpenedAt` is activity metadata
and never sorts anything. `dedupeWorkspaces` keeps a duplicate in its original
array position, so saving any setting cannot pull the active project to the top
and undo a drag. A drag starts as soon as the pointer moves a few pixels (no
long press), shows a drop line where the row will land and auto-scrolls near the
list edges; the project action menu offers the same move as *Move up* /
*Move down* for people who would rather not drag. Both paths write
`projectOrder` and the workspace array. `output/audit/sidebar-order-check.mjs`
drives a real mouse through both; `output/audit/sidebar-session-order-check.mjs`
covers a folder discovered from a session becoming registered.

### Desk pages

「插件与技能 / Plugins & skills」and「定时任务 / Scheduled tasks」are desk
pages, not dialogs. Their sidebar entries toggle `deskPage`, and `App` renders
only `<div className="desk-page">` inside `main__body`: the composer, GoalBar,
widgets, task rail **and the corner tools-panel toggle** all belong to the
conversation branch and must not sit underneath the page. The toggle is drawn
only while no desk page is open — it floats over the content row's top-right
corner, which on a desk page is that page's own header, so leaving it there put
a conversation control over a page that has nothing to do with the
conversation. The tools panel closes with the conversation branch as well: with
the toggle gone nothing would close a panel left open over the page, and the
panel's pages read the project and the session, not the desk page. There is no
Back control in the
titlebar; selecting a conversation, starting a new chat, or clicking the same
sidebar entry again clears `deskPage` and restores the conversation unchanged.
Destructive confirmations stay inline as well: deleting a scheduled task asks
in its detail pane, so these pages never open a native or modal dialog. The
scheduled page is a DSH-shaped master-detail: list rows only select, and the
47% right pane owns the editable rule, run history, pause/more/close controls
and the inline delete confirmation.

**A running task must be stoppable from that pane.** The run owns a Pi process
under a draft session key, and the pane disables pause, more and delete while it
goes — so without a stop action a hung run (a prompt response that timed out
while the agent kept running) left the task `running` until the app restarted.
`stopRun(id)` stops that one process through the supervisor; Pi publishes
`agent_settled`, the usual settle path records `aborted` and releases the run
lock and slot, and the schedule is untouched (`enabled` and `nextRunAt` survive).
Removing a task stops its run for the same reason: a deleted task must not leave
an agent working where nothing can see it.

A recurring occurrence is skipped only when the saved run matches a live lease.
A lease taken before the run is saved, or left behind by a dead process, leaves
the occurrence due so the scheduler can run it when the lease clears.

**An unreadable `scheduled-tasks.json` is set aside, not pinned.**
`recoverInvalidTaskFile` rechecks the current file under the same lock used by
writers. It renames confirmed corrupt data to `scheduled-tasks.corrupt-<stamp>-<id>.json`
and continues from an empty list. Lock contention leaves recovery for the next
refresh. Pinning the bad version's fingerprint (the old
behaviour) left the page empty for good: every write still started from a list
that could never load, so a new task could not be created either and the only
clue was a console line. Only a *content* error is quarantined — a file with no
id, title or usable schedule is dropped per record with a count in the log.
An I/O error preserves the last successfully loaded list until refresh succeeds.

A scheduled task carries its own project, prompt, schedule, **model and
reasoning effort**. Empty model/effort fields mean "follow the app's saved
default" and must stay absent from `scheduled-tasks.json`. The effective choices
are passed as Pi arguments for that run. Editing is allowed while a task runs
(the change reaches the next run). A finished one-time task keeps its past
date so its title, prompt, model or effort can be edited without
rescheduling; an enabled task still has to point at the future, and editing
never re-enables a paused task.

### The row never moves

The actions of a project row live in a **slot that is always there**
(`--sidebar-action-slot`, 60px). The slot is empty at rest and fills with the
buttons on hover or focus, so the title keeps the same width whether the row
is hovered or not; the conversation count is not shown on the row. Do not
"solve" an overlap by changing the padding of the row on hover — that re-flows
the title. Measure it instead: `output/audit/hover-check.mjs` drives a real
mouse over the row and compares the geometry before and after.

A conversation row is the same rule one step down, taken further: its mark (the
dot or the spinner, sharing one 14px slot) hangs in the row's indent
(`--sidebar-session-indent`, which is the project's own text column) and is
positioned out of the flow. A running row and a silent row therefore start their
titles on exactly the same column — the column the project name uses — and the
mark sits concentric with the project icon above it. Never put the mark in front
of the title as a flex child: that is how one running conversation shifts every
other row's title out of alignment.

## The composer

The bar inside the box holds the same two controls in every state: `+` (the add
menu) on the left and the round send button on the right. Nothing about the
composer is conditional on a run — the model, reasoning and session controls
used to live in this bar, which is why starting or sending used to rearrange it.

The round button stops an active run while the composer is empty or a submission
is awaiting confirmation. Otherwise it sends the current draft (steer or queue),
and `session-bar__stop` remains available under the box. Both stop controls call
`stop()`. A submitted draft stays visible and on disk until acceptance.
Acceptance clears the draft that was submitted if it still matches the editor,
so an edit made while waiting survives.

**A queued prompt can be taken back without stopping the run.** The rows above
the box are Pi's queue, and the first one carries two 20px controls: recall
(`clearQueue(true)`, the prompts go back into the editor) and discard
(`clearQueue(false)`, after the inline confirmation in `ConfirmDialog`). Both
call `clear_queue`, so they never abort the turn. `clearQueue` takes the
conversation key, because the side chat reuses this composer with its own
session — clearing "the queue" from the visible box must not empty whichever
conversation the main view happens to show. The actions live on the first row
rather than in a header so the queued block keeps its own height; do not put
them in the flow of every row, where they would repeat for each prompt.

If a draft snapshot exceeds browser storage quota, drop sent-prompt history
before removing any unsent images. If the images still exceed the quota,
retry with still-attached images from the last saved snapshot before falling
back to text and file references. An oversized new attachment should leave
older saved drafts recoverable.

**A model pick is one round trip, and never waits for a boot.** The switch
talks to a live Pi process, and `runtime:has` / `ensure` / `set_model` used to
be able to stack their timeouts — the picker stayed open (and the module-wide
"already in progress" flag blocked every later attempt) while that happened,
which reads as a frozen app. Three rules keep a pick under a frame:

- `setModel` updates the chip, session row, side override and draft default
  from a successful `set_model` response. A rejected pick shows an error and
  keeps the confirmed model and saved preferences.
- It **never calls `ensureRuntime`**. Opening a conversation prewarms Pi, so the
  first pick after a switch lands mid-boot; waiting for that start made one pick
  cost the whole cold start (measured: 1.3 s, and 9.9 s on a slow boot with the
  registry refresh in front of it). A pick during an in-flight start records a
  pending choice and returns. The existing `ensureRuntime` applies the choice
  once Pi is ready. A first send that joins the startup waits for the same
  model confirmation and keeps its draft if Pi rejects it.
- It **does not await a state snapshot**. `refreshState` follows at its own
  pace; a slow read is not a failed switch. Measured on a ready process: 6 ms.
- A model the running process does not know yet (a provider just saved) still
  gets `/desktop-refresh-models` first — but only for an idle, ready process,
  and again as the fallback when `set_model` answers "unknown model". Never for
  a booting one: its registry is not written yet.

Every wait behind `setModel` / `setThinkingLevel` keeps a deadline
(`lib/with-timeout.ts`): 5 s for `runtime:has`, 5 s for `set_model`, 15 s for the
catalogue refresh, 8 s for a settings write. The picker closes and dismisses
`showModels` before it calls the store, and the chip shows a spinner only while
the command is really in flight.

The model is a per-conversation choice: picking a model in a session sends
`set_model` to that process and never writes the app default — only a draft
chooses the default for the conversation it is about to create. A cold session
reads its own persisted model from the sessions list (`SessionMeta.model`),
so the chip follows the conversation, not whatever another conversation
picked last.

Transient app messages are a single floating `AppToast`, in the **middle of the
window** — never a strip inside the composer, and never pinned to a corner (a
notice anchored to an edge reads as something sliding in from the side).
`showToast` still owns the one message queue; the toast maps `info` to the
success mark, carries a close button, and must not change the composer's
geometry. A message about the app is not part of writing a message.

A message with a value in it (a path, a model name) must be translated
**before** the value is interpolated:
`translate('Exported {file}', language).replace('{file}', …)`. `AppToast`
translates its text through `t()` too, but that can only match an exact key, and
a string with a path in it is no longer one — which is how `Exported {file}`
stayed English in the Chinese interface while `Conversation deleted` did not.
`tests/i18n.test.ts` pins the placeholder templates.

**A toast that names a file carries `openPath`, and the card offers Open.** The
Markdown export, and the HTML export whose viewer failed, put the destination on
the toast; the action calls `shell.openPath` and closes on success. A failure
from that retry replaces the toast with the translated "Could not open the
exported file" line. The path comes from the save dialog, not from the reader's
text, so the action cannot be used to launch an arbitrary string.

### The usage line under the composer

`UsageBar` is one compact line **centred** under the input after a run, and it
carries three readings plus the ring, in that order: turns/steps with TPS, token
usage with cache hit rate, then `ContextRing` at the end of the line. The bar is
a summary, not a report: **the first-token delay is not on it.** Speed and TTFT
describe measured model responses, so they share
a second popover behind the turns/steps and speed reading (`GenerationPanel`). It
uses the compact session statistics layout: turns and steps, model time, tool
execution time, average TTFT and output speed. Unavailable readings say
`Not measured yet`. Pi reports tool `durationMs` when available; the client
measures tool start-to-end as a fallback. Model time sums client-observed
`turn_start` to assistant-message completion intervals while a run is live.
A reopened transcript uses Pi's per-message `durationMs`; the local samples
cover branches outside the visible tail and are never added on top of the
transcript — both describe the same messages, so taking both doubled the
number (a real 24-minute session read 48 minutes). Average TTFT measures
one model request, from just before the provider request to that request's
first nonempty text delta; every new request starts a fresh clock, so tool
execution and retry backoff cannot inflate it. `generation-timing.ts` measures
both boundaries with Pi's own monotonic clock and publishes only the duration
through a reserved status key. Thinking and tool-argument deltas do not count
as first text, and one request needing more than two minutes to reach it is
dropped as a stalled boundary rather than poisoning the average. The store
records each sample once, keyed by `runId`.
These timing samples live in localStorage per conversation and migrate when a
draft gets its session file. A reopened transcript with no client samples is
approximated from each assistant message's `durationMs` for model time and TPS;
TTFT remains unavailable without observed token arrivals. Version 1 model-time
samples used the wall clock and are dropped; version 2 changed model time to
a monotonic clock. TTFT, run, generation and fallback tool samples before
version 4 also used the wall clock,
so they are dropped during migration because the record cannot distinguish a
Pi-reported tool duration from a client fallback. Sleeping the machine or
syncing the time could turn one answer into hours, and a wrong total is worse
than a missing one. Version 5 drops only older TTFT samples because they measured
the entire run up to its first text and could include minutes of thinking and tools.
Version 6 drops v5 TTFT samples because they included local request preparation
and renderer/IPC delivery time. Version 7 drops v5/v6 TTFT samples because they
used per-turn/request boundaries and could count hidden reasoning or tool
arguments as first text. Other monotonic timing samples are preserved.
Version 8 stored appended samples as individually named localStorage keys;
version 9 uses a per-conversation indexed journal so reading one conversation
does not enumerate the storage keys for every conversation. Version 8 samples
are folded into the snapshot the next time a timing sample is recorded.
Version 10 drops every v7-v9 TTFT sample: those started at `agent_start` and
could hold minutes of tool work (one real sample read 4m29s for a "first
token"). The v9 journal is folded into the snapshot first, so model, tool,
run and generation timings survive the migration.
The tokens and the hit rate open `UsagePanel` — total Token,
cache hit rate, uncached input, cache read, cache write and output. Two
questions, two cards; a reading printed in both would be two things to keep in
sync.

The ring is `ContextRing`: the arc plus its percentage, one colour, following
the `showContextUsage` setting. It opens `ContextPanel`, which asks Pi for
`get_session_stats` once on open (`readSessionStats`). Both components read
through `lib/context-reading.ts`, never off `stats` directly:
`get_session_stats` only answers while a process is running, so a conversation
merely reopened from disk has no `stats` at all. That module falls back to the
newest assistant message's usage and the model's `contextWindow` — the saved
model's when there is no live process — and reports `source` so the panel can
say whether the reading is Pi's or an estimate. Pi's own `contextWindow` must
outrank the saved model, or a stale window renders an impossible percentage.

Token totals and the hit rate come from `get_session_stats`, with the visible
transcript as a fallback; the hit rate counts cache reads against every prompt
token — fresh input, cache reads and cache writes. A run start drops the old
snapshot so the transcript can drive the line, and every finished answer or
tool result re-reads Pi's statistics (throttled per conversation by
`refreshLiveStats`) — the readings must move during a long tool-heavy turn,
not jump only at `agent_settled`. Pi reports no generation
timing, so `run` mints `firstTokenAt` on the first nonempty content delta of
each model request and starts each answer's generation window at its first
block of any kind — text, thinking or a tool call — summing the window into
`generationMs` when the block ends (`text_end`, `thinking_end`,
`toolcall_end`, `message_update:done` or `message_end`). A tool gap between
answers is not model time. `session-timing.ts` stores per-conversation model
time, TTFT, generation windows and fallback tool durations.
`session-metrics.ts` averages output speed by pairing completed assistant usage
with the corresponding model duration. A locally recorded duration is used
only when its assistant timestamp identifies one unambiguous sample. Older
records can fall back to the matching turn's generation window. Session token
totals can cover more history than the timed answers, so the speed calculation
uses only output from the timed samples.

## The session bar

The conversation's settings live in the composer and nowhere else. `Composer.tsx`
draws the row above the box (`composer__top-selectors`) with the project
(`ProjectSelector`, a menu of every known project which switches through
`switchProject(..., { allowWhileRunning: true })` — the same deliberate door the
launcher uses) and the branch with its dirty count (`BranchMenu`); the model and
reasoning effort sit inside the box beside the send control (`ModelPicker` in
`TopBar.tsx`); the context ring is the last reading of the `UsageBar` line under
the box (`ContextRing`). While a run is going, the composer's round button stops
it and `session-bar__stop` stays available under the box; delivery mode is a
Settings preference, not a composer control. There is no separate `SessionBar`
component any more — it was absorbed into the composer, so new controls belong
there rather than in a second row.

The title bar does not repeat any of it: it keeps the conversation's name and
the app's actions. A project or branch chip in two places is two things to keep
in sync, and the one in the header had no room to say what it was.

**The title bar wears the conversation's name and nothing else.** Subagents live
in the task rail (the 子智能体 section) and in the Subagents page, not beside the
title: a badge there counted children the rail already listed one line below, and
it crowded the name of the conversation it belonged to. Both places read the same
projection — `lib/subagents.ts` (`subagentTasks`, `summarizeSubagents`,
`subagentPreview`) over the thread's `subagent` tool nodes. Clicking a row uses
`openSubagentTask` in `App.tsx`: it stores only a session key and a task id, then
`SubagentPanel` reads the current thread to render `SubagentConversation` on the
right panel, with the Back control returning to the catalog. `tests/subagents.test.ts`
guards the projection and `tests/ui-regressions.mjs` drives a catalog row into the
child conversation against real child processes. Do not add a second summary of
the same children to the header.

**The title bar must wear the same row the sidebar highlights.** The sidebar
lists disk sessions *plus* live threads (`lib/live-sessions.ts`), because a chat
Pi has not flushed to the session folder yet still has a first prompt. The
title bar used to read only `sessions`, so a running conversation showed the
project name while its row showed the prompt. `activeConversationTitle()`
resolves the active key against both sources, and `App.tsx` uses it for the
title, the rename draft and the rename comparison. A rename made in the main
process (auto-title, a hot or a cold session) never re-reads the index by
itself: `SessionSupervisor.rename` emits `rename`, `bridgeRuntime` forwards
`sessions:changed`, and the store paints the name on the row and calls
`refreshSessions()`. `session_info_changed` refreshes too, for a
`set_session_name` that bypassed `supervisor.rename`. Do not drop either half —
`tests/title-sync.test.ts` and `tests/live-sessions.test.ts` guard the wiring.

The context window is a ring (`ContextRing`), not a gauge icon and not a bar.
The arc length is the whole reading — the percentage of the window in use — and
it is drawn in one colour, the control's own foreground. Do not add a colour
scale: the length says how much, and the numbers stay in the `ContextPanel`
popover behind it, which reads Pi's `get_session_stats`.

## The side chat

A side chat is a **second working conversation** beside the chat on screen. It
runs its own Pi process in the same project with the same tools, and it is
steered on its own — asking it something never touches the run the lead is
doing. Every main conversation keeps one side slot, and that binding is what
the panel follows.

### It is not a weaker agent

`src/main/pi/side-chat.ts` adds two things to a normal Pi process: the
`inspect_main_conversation` / `inspect_main_changes` tools, and an ephemeral
`<main_conversation_digest>` before each user message. It installs **no tool
policy** — `write`, `edit`, `bash`, `powershell`, MCP servers and the rest are
available, exactly as in the main conversation, because a reader who cannot act
on what they found has not been helped. The static system-prompt section (kept
byte-identical so providers keep their KV-cache prefix) says the same thing and
warns that the main conversation may be editing the same files.

The clamp that used to live here (an `--tools` allow-list, an
`--exclude-tools` list, `--no-mcp`, an extension-side `setActiveTools`, a
`tool_call` block and a `user_bash` answer, plus a supervisor guard on
mutating RPC commands) was a design mistake, not a safety feature: it made the
pane a viewer of a conversation it appears to be equal to. Do not reintroduce it;
`tests/side-chat-supervisor.test.ts` now asserts a `bash` request reaches Pi and
that the extension leaves the loadout alone. The only real constraint left is
concurrency: both conversations work in one working tree, so a side chat must
re-read a file before writing it rather than assume it owns the workspace.

### The mirror is a projection, never a second transcript

`src/main/pi/main-mirror.ts` reads the main conversation from Pi's own session
file and rebuilds `<main_conversation_digest>` (`MAX_DIGEST_CHARS`) before every
side user message: finished turns, the goal and todo plan, tool calls, and the
files the run changed. Full turn text, tool output (`TOOL_OUTPUT_LINES_PER_PAGE`
lines per page) and unified diffs come back only through
`inspect_main_conversation` / `inspect_main_changes`, which
`side-chat-bridge.ts` serves over a token-guarded loopback HTTP port. Do not
grow the digest into a copy of the chat; the tools are the deep read.

### The binding

`src/main/side-chats.ts` owns `side-chats.json` in `userData`: for each main
`.jsonl` it remembers the active side file and every side file ever bound to it.
Side sessions live under `_side-chats/` beside the main session; they are
ordinary Pi sessions, and `isSideSessionKey` keeps them out of the sidebar and
the tray. `Clear` stops the old side runtime and starts a fresh side session
without deleting the old file. The live snapshot is published on
`pi-desktop-side-chat` (`parentSessionKey`, `activeSideKey`, `parentRunning`,
`parentTurnCount`, `sessionChangedFiles`).

### The panel

`SideChatPanel` is lazy-mounted as its own tool-panel page (`view: 'side-chat'`).
It is **not a second chat implementation**: the pane renders the main
conversation's own `Thread` and `Composer` under
`ConversationScopeProvider surface="side"`, so the two panes cannot
drift apart — same bubbles, same tool rows, same folding, same scroll memory
(per session key), same composer with only main-session chrome (project and
branch menus, and the edit rewind undo strip) omitted while keeping full task
modes (GoalBar, mode/swarm chips), the full add menu (skills, plugins,
diagrams, image generation), permissions, inline `!` bash, and per-conversation
model/thinking controls. `readOnly` is a real, optional property of the scope (a future viewer), not a side-chat default. `Thread` and
`Composer` are scope-aware through `lib/conversation-scope.tsx`
(`useConversationScope` + `useSessionViewSlice`); with no provider they read the
top-level store exactly as before, which is what keeps the main surface
unchanged. Do not reintroduce a bespoke transcript or composer for this pane:
`SideChatTranscript`, `SideChatComposer` and `SideChatSyncPill` were exactly
that and they were deleted.

What the pane adds on top of those two components:

- **Header** (`SideChatHeader`): the review/preset menu (`explain-live`,
  `summarize-main`, `diagnose-error`, `breakdown-plan`, `review-session`,
  `review-worktree`) and Clear with confirmation. It carries no read-only badge:
  the side chat works with the same tools as the conversation beside it.
- **Empty state** (`SideChatEmptyState`): the preset cards, drawn only while the
  side thread has no items — `Thread` renders nothing for an empty
  conversation.
- **Reference chips**: `sideQuotes` rendered above the composer through
  `SideChatRefChip`, so a quoted turn stays visible and removable now that the
  chips do not live inside a bespoke composer.

### Doors

`Ctrl+Shift+L` (`toggle-side-chat`), `/side [question]` (open, or follow with a
question), the tool panel's own **Side chat** card and tab, the Progress
section's breakdown action, the context menus on the main transcript, and the
tray card. `lib/side-chat-context.ts` owns `OPEN_SIDE_CHAT_EVENT` and the
request shape; `App.tsx` stamps every request with a new `seq` so repeating
the same question still runs.

### Model and reasoning

Runtime launch passes a model and reasoning level as `--model` and `--thinking`
for that process. Explicit preference saves synchronize Pi's global defaults.

A side chat keeps its own model and reasoning level: `sideModelOverrides` /
`sideThinkingOverrides` in the store, and `pendingModelSelections` /
`pendingThinkingSelections` for the next launch. A side pick never writes the
app default (`rememberDefaults: false`), the per-conversation locks
(`agentSettingSelectionsInFlight`, keyed by session) let the main and the side
switch independently, and the deadlines documented under the composer apply to
both.

## The window's own controls

Maximize, minimize and close are drawn by the OS over the top-right corner of the
content, so their colours come from the renderer: `applyAppearance` resolves
`--chrome-bg` (usually a `color-mix(...)`, which the main process cannot evaluate)
through a canvas probe and hands the channels to `app:setTheme`, which sets
`titleBarOverlay`. Two things follow, and each one is the visible bug when it is
missed: a translucent token has to be composited down to an opaque colour, and the
strip is not always the chrome — a full-window layer (`.modal-layer`,
`.lightbox-layer`) paints its scrim over it first. So the colour pushed while a
dialog is open is the scrim composited over the chrome, recomputed when such a
layer mounts or unmounts (`watchChromeOverlays`, after the layer's fade). Do not
hard-code the strip colour in the main process: the user's background is arbitrary.
That overlay is drawn outside the web content, so a screenshot cannot show it —
`PI_DESKTOP_SCREENSHOT` makes the handler log what it was told to use.

**A full-window layer gates the close button and nothing else.** The native
buttons sit above the content, so a scrim cannot swallow their clicks; the
`watchChromeOverlays` count is pushed through `app:setWindowClosable`, and the
main process touches only `setClosable`. Minimize and maximize stay live: moving
the window aside never abandons a dialog, and greying them out made the window
impossible to minimize whenever the settings page — which is a `.modal-layer`
like every other dialog — was open. Close stays gated because a layer that waits
on an answer would otherwise be hidden behind its own scrim, leaving the agent
blocked with nothing on screen to answer. `tests/window-controls.test.ts` pins
the rule at the handler; `output/audit/window-controls-check.cjs` reads
`WS_MINIMIZEBOX` / `WS_MAXIMIZEBOX` from a real window with the settings page
open.

## Updates

The update control is **one round button in the sidebar foot, beside Settings**,
filled with the accent colour, and the whole download lives behind it.
`lib/app-update.ts` owns both readings — the release a check found and the
installer's stage (`downloading` / `ready` / `installing` / `error`) — because
the sidebar is a list that can be folded away, and a download owned by the
component would lose its progress with it. **The glyph is always the download
mark**. The ring drawn inside the fill shows download progress and disappears
as soon as the installer is verified. The same button then offers "restart and
install" in its accessible label and shows the ready phase in the hover card.
A failed download recolours the fill to the danger tone.
The hover card carries the installer size and the phase, because the foot has no
room for a second line.

- **Automatic checking is the reader's choice** (`automaticUpdates`, Settings →
  About). On, the app checks for a release at startup and every 12 hours and
  downloads it in the background; off, only *Help → Check for updates* and the
  About page reach GitHub. The switch exists on every build — it used to be drawn
  only for the development entry point.
- **The bundled CLI is checked either way.** It is the agent this app drives, so
  `app:checkPiCliUpdate` runs on its own clock whatever the switch says; a stale
  agent is a wrong answer, not a missing feature. The reading lives beside the app
  release in `lib/app-update.ts` (`piCliUpdate`, `notePiCliUpdate`), a full check
  fills the same slot, and the About page's built-in-service row reads it — never
  `updateStatus.piCli`, which only a manual check fills. Only a build that can
  replace its CLI asks npm: a packaged app answers from its own files, and the
  upgrade itself still follows the switch (it writes into the CLI's folder, so a
  running agent is never swapped mid-run). The upgrade reports 100% only after
  the installed CLI runs and prints the requested version.
- **A check that answered still counts.** Both schedulers publish the result
  *before* asking whether their effect is still alive: at startup `info` and the
  saved settings arrive in the middle of the first request, which tears the
  effect down and rebuilds it — and an "is this still my effect?" test at that
  moment threw away the one answer the app had, so the About page showed no
  reading until someone pressed *Check now*. The reading belongs to the module;
  `active` only gates the toast and the CLI upgrade.
- **Downloading is not installing.** `app:downloadUpdate` fetches and verifies
  the installer and stops there: no conversation is aborted and no task is
  stopped for it. `app:installUpdate` is the click, and it still refuses while a
  run is active (`prepareForCliUpgrade`).
- **The finished installer is kept.** It lands in `<userData>/updates` with
  `installer.json` naming its release, `app:downloadedUpdate` puts it back at
  startup, and a later download of the same release reuses the file instead of
  fetching it again. Reuse and installation recheck the saved SHA-256 so a
  damaged cache is fetched again even if its size is unchanged. Older records
  fetch the release metadata once to verify the cached file. A record that
  names another release — or the running version — is pruned by the check.
- **A failed check never replaces the last good reading.** Not in the sidebar,
  not in the About page: `noteAppUpdateCheck` keeps `lastCheck`, and the About
  page re-reads it after a failed check instead of painting the failure. The
  same holds for the installer record: only a check that *reached the network*
  may forget a downloaded release (`!result.app.error`), because a failure says
  nothing about the verified bytes already on disk — and the main process prunes
  the file under the same condition.
- **A killed download does not leave its staging folder behind.** Each download
  streams into its own `download-XXXXXX` folder and deletes it in a `finally`;
  a process killed mid-download never gets there, so `clearStaleDownloads` sweeps
  folders older than an hour — on each new download and on each successful check.
  The age guard is what keeps it from deleting a second instance's live download.
- **Only a build that can install shows "restart and install".** A portable or
  development build has no installer of its own, so the same icon keeps offering
  the download page — `data-state` stays `idle` even when a record is found in
  the data folder.

**The installer copies, verifies, then swaps — and must read `app.asar` as a
file.** `src/main/setup/install.ts` copies the payload into a `.Pi Desktop-install-…`
folder with **robocopy** (a separate process, which is what makes the archive
copyable), then `verifyPayload` checks every file's length before the swap. That
check ran on Electron's patched `fs`, where any path ending in `.asar` is opened
as an archive: a staged `resources/app.asar` answered "Invalid package" instead
of a size, so the one file that had copied correctly was reported missing and
**every silent update died on it** — the setup relaunched the old app, the icon
offered the same install again, and the reader saw only a restart loop. The
lessons live in `src/main/setup/payload.ts`:

- `statPayloadFile` reads a payload file with `process.noAsar = true`. Use it for
  anything in a copied tree; a plain `statSync` there is the bug above.
- `removeTree` deletes a copied tree the same way. Electron refuses to unlink a
  file it is trying to parse as an archive, so `rm(…, { recursive: true })` used
  to delete everything *except* the 187 MB `app.asar` and then abort, leaving a
  near-complete copy beside the install after each failed attempt (four of them
  held 779 MB on the machine this was found on).
- An archive's length is known (`listSource`) and is compared exactly like any
  other file, so a truncated copy is caught; a size of 0 means the payload side
  could not be read and a present, non-empty file is then the whole contract.
- `tests/setup-payload.test.ts` pins all three. The bug cannot reproduce in
  plain Node (no asar patch), which is why it shipped: the tests state the
  contract, and the Electron behaviour that broke it was measured separately
  (`statSync` throws `Invalid package`; `noAsar` answers `isFile: true`).
- Setup holds a per-target lock through recovery and installation. If an
  interrupted swap left the target missing, the next attempt restores the
  previous installation from its backup before checking the new payload.
  `tests/setup-install.test.ts` checks the old executable, archive, and marker.


**Reading a release costs no REST API quota when it can avoid one.** The
anonymous GitHub REST API allows 60 requests an hour per network, shared by
every app instance, restart and test run on that network; a normal startup
check used to spend one of them just to read the installer size, so a few
launches could exhaust the quota and every later download then failed with
"Could not read the update release (HTTP 403)". The flow now spreads the work
over endpoints that have no quota: the version comes from the
`/releases/latest` web redirect, the size from a `HEAD` on the public
`releases/download` URL, and the digest from the release's `SHA256SUMS.txt`.
The REST API is still tried first for the installer (GitHub's own asset digest
and size, plus the draft/prerelease check), and a 403/429 means "the quota is
gone", not "the release is broken": `selectReleaseAsset` falls back to the
deterministic asset names, the file size from the `HEAD`, and the published
checksum. A 5xx does not fall back — a broken API answer is an error worth
retrying, not a reason to trust a different source. The fallback can never pick
a draft or prerelease because the version it resolves came from the web
redirect, which only names a published release.

Two harnesses read the real button: `scripts/verify-update-persistence.mjs`
drives two launches (online, then offline with the GitHub check blocked) and
`scripts/verify-update-icon.mjs` runs a copied `release/win-unpacked` twice —
once with only a reading on disk (the ring must be empty) and once with a
verified installer beside it (the ring must be absent). Both read `data-state`,
the ring's `stroke-dashoffset` when present and the About page out of the live window.

## The tray and the taskbar icon

Two things belong to the main process and nowhere else: the system tray and
the icon Windows draws for the app. The renderer owns the switch and nothing
else — the tray is a projection of one setting, `trayPersistent`.

With the tray on, closing the window hides it instead of quitting, and the
tray icon is the way back: a click opens the window, the menu offers *show*
and *quit*.

**The tray menu is a card and nothing else.** The popup is its own frameless
window (`tray.ts`), `transparent: true` with `hasShadow: false`, sized to the
content height the page reports — so the card *is* the window, and any CSS that
paints outside it (`box-shadow`, `backdrop-filter`) shows up as a halo over the
desktop. It had a two-layer drop shadow plus 6px of outer padding to hold it,
which read as frosted glass around a flat menu; `styles/tray-popup.css` now
keeps `.tray` at zero padding with no shadow, and the 1px border and radius are
what shape the card. Do not add a shadow back: the OS draws none either, and
there is no margin for it to fall into.

The rules that keep the window from disappearing for good:

- Hide only while the tray icon is really there. A missing icon, a real quit
  and the screenshot harness all close the window for real; hiding without a
  tray would leave no way back at all.
- The single-instance lock is taken by every launch, harness runs excepted.
  A second launch — a double-click while the first copy is still starting, or
  a shortcut left in the tray — focuses the window that already exists
  instead of opening a second app beside it. The lock is claimed before any
  startup work, so the duplicate process exits at once.
- The lock is not tied to `trayPersistent`; turning the tray off must not
  release it. With the tray on, closing the window still only hides it, and
  a second launch is the way back to that window.

`tests/tray.test.ts` pins the rules on a fake Electron: the refusal and the
remembered claim, the harness bypass, the icon lifecycle, the click target
following the latest settings write, and a quit that cannot rebuild the icon.

The taskbar icon is the window icon. Windows draws the taskbar button from
the window's own icon, so a dev run of `electron.exe` shows the Electron
logo until the window carries the app mark. `app-icon.ts` owns all of it:
the `.ico` next to the asar (`extraResources`), the `BrowserWindow` icon,
and the AppUserModelID, which has to be the same id electron-builder stamps
on the shortcut (`appId` in `electron-builder.yml`) or Windows treats the
dev run and the installed run as two different apps.

Two rules about that id decide whether the taskbar draws the app mark or
the Electron atom. Both were measured on a real taskbar (`output/audit/`
renders `Shell_TrayWnd` with `PrintWindow`, and UI Automation names the
buttons):

- **The id belongs to the window, not to the process.**
  `app.setAppUserModelId` registers the id for the *process*, and the shell
  files that registration under the executable's own icon. A window that
  reuses the registered id inherits that entry, and its own `appIconPath` is
  ignored. So the id goes onto the window through `setAppDetails` and the
  process keeps no explicit id.
- **An id is remembered with the icon it was first seen with.** Windows
  caches an AppUserModelID together with the name and the icon of its first
  registration and never gives them back: a newer icon, a refreshed icon
  cache and a new shortcut all leave it alone. `dev.pi.desktop` was first
  claimed by a dev run that still carried electron.exe's icon, and
  `dev.pi.desktop.v2` was first registered with the previous pixel mark. The
  id in use is `dev.pi.desktop.v3`, and rotating it again would present the
  build as a new app. There is no NSIS target to pin: `electron-builder.yml`
  builds `portable` and `dir`, and the installer the user runs is drawn by the
  app itself (`setup/`), so `nsis.guid` only matters if an NSIS target is
  introduced.

An `.ico` stores a PNG per size and Electron's loader keeps only the
largest frame, so a reader that wants one particular size walks the
directory itself: `src/main/ico.ts`. The tray wants 32px, and the shell
wants a real file path — neither can be served by a resample of the other.

**The notification sender name is the executable's, not the window's.** Windows
groups toasts under an app identity resolved from the AppUserModelID; a process
with no id of its own falls back to `electron.app.Electron`, so a dev run of
`electron.exe` is labelled "Electron" in the notification center while the
packaged `Pi Desktop.exe` — whose version resource says "Pi Desktop" — is
labelled correctly. That difference is the build, not a bug to fix in code:
`app.setName` only changes `app.getName()`, a custom id only renames the
`wpndatabase.db` handler, and `groupTitle` merely adds a second "Pi Desktop"
line under the "Electron" heading. All three were measured on the real center.
The one remaining lever is a Start-menu shortcut carrying the id, and writing
that into the user's Start menu on every dev launch costs more than it buys.
`desktop-notification.ts` keeps this note next to the code.

## Starting the app

`bootstrap()` reopens the *project* that was active, never the conversation.
`lastSessions` is still written by `rememberSession` and still feeds the welcome
screen's "recent in this project" list, but only a click there opens a session —
a start is a new chat. If no saved project can be restored, the start becomes a
projectless chat and `activeWorkspaceId` is persisted as `null`; the welcome
screen never falls back to a dead "open project folder" state.

### Windows user-data ACLs

`secureUserDataDirectory` runs before the settings file is read, so it must stay
cheap. It **reads** the root directory's ACL (`icacls <dir> /L`) and only writes
when the current account is missing, inheritance is still on, or the entries are
not full control. Never put `icacls /reset` or `/grant:r` back on the
unconditional launch path: on a profile holding ~30k Chromium cache files the
inheritable-ACE propagation blocked the main process for 60–90 s, and the window
did not appear until it finished — the app looked like it refused to start.
Existing children are handled once, after the window is up, by the asynchronous
`scheduleUserDataAclSweep`; it only runs when the root ACL actually changed.

### One-shot Pi CLI processes

`runPiCli` (`src/main/pi/cli.ts`) launches the bundled CLI through
`process.execPath` with `ELECTRON_RUN_AS_NODE=1`. On Windows, `spawn` with a cwd
that does not exist fails with `spawn <exe> ENOENT` — a misleading error that
reads like a missing binary. That made every marketplace install fail whenever
the active folder was `<userData>/chats` and that folder had never been
created. `projectlessRoot()` now creates it, and `runPiCli` falls back to
`process.cwd()` when the requested folder has disappeared. A workspace can be
deleted between listing it and running a command, so never assume a path from
`workspaceRoot()` still exists.

Which executable is launched is decided by `resolvePiLaunch` in
`src/main/pi/locate.ts`: an explicit user path first (a `.js` entry runs under
the app's own node, anything else is spawned directly), then the CLI bundled
with the app, then `pi` on PATH, then a clear `none`. The launch cache re-checks
that the chosen file still exists, so uninstalling a custom CLI falls back
instead of failing forever; `tests/locate.test.ts` pins the order and that
re-check.

### Window state

`window-state.ts` remembers the window's content size and place. It saves the
**content** bounds (not the outer frame, which includes the title bar and
rounding), debounces drag events, writes atomically through a temp file, and
drops a position that no longer lands on a display instead of opening the app
off-screen. A record below 880×572 is what a process killed before its first
frame leaves behind, so it is treated as no state at all.
`tests/window-state.test.ts` pins these rules with a fake window.

### Settings writes wait off the main thread

`settings.json` is guarded by an interprocess lock, and `lockSync` cannot retry
(proper-lockfile refuses retries on the sync API), so the store spins on
`Atomics.wait` between attempts. A second instance — a harness run, or a crashed
one whose lock file has not gone stale yet — can hold the lock for seconds, and
blocking the main thread that long freezes the window. The IPC paths that write
settings therefore `await SettingsStore.waitForLock()` first: it polls
`proper-lockfile.check` asynchronously, so the wait costs the UI nothing. The
sync spin is bounded to ~50 ms and only covers the race between that poll and
the write. Do not grow it back into a long spin.

### Long session files

A session larger than the 24 MB read window is not dropped. `sessions.ts` reads
its transcript from the tail — the newest 24 MB — and builds metadata from a 2 MB
head plus a 1 MB tail. `getSessionMeta` must never answer `null` just because a
file is long, or the sidebar hides a conversation the user can still resume.
`readJsonlLines` starting mid-file skips the partial line. A cold rename finds
the last valid leaf within its bounded read and appends `session_info` through
the same handle. If the final record lacks LF, the append supplies it and keeps
the existing bytes intact.

Full-text search does not skip a long session: above the 8 MB direct-scan window
it uses a per-session index in `<userData>/session-search-index/`, holding only
the user/assistant text with a lower-case copy for matching. The first query
builds it from the newest 64 MB; later queries scan the snapshot, and an append
is picked up from the last complete JSONL record. A changed source header
rebuilds the index because Pi can rewrite legacy files in place. An unterminated tail is
retried on the next query, so a write racing the index build is not lost.
Entries whose source records move before the newest 64 MB window are evicted
when that append is indexed, so a live session's index stays bounded.
Each sidecar is at most 64 MiB; a larger one is discarded and rebuilt, and a
snapshot larger than that is used for the current search but not persisted.
Each query budgets 128 MB across source reads, sidecar reads and indexed-text
scans; when the remaining budget cannot cover the index work, it falls back to
the bounded direct scan, and a cached scan stops at the remaining work limit.
A missing, truncated or far-behind snapshot is rebuilt; the in-memory cache holds
at most eight snapshots and an estimated 64 MiB total, and removing a session
removes its index. An open handle can outlast deletion or replacement, so
search rechecks the named file's identity before returning its hits. On-disk
sidecars are capped at 512 files and 512 MiB; startup
and writes evict the oldest indexes when either limit is exceeded.
`configureSessionSearchIndex` is the only door to the folder — the main process
points it at `userData`, tests pass `null` to keep the old direct scan.

### Settings and shortcuts

The settings dialog has no Plugins page: **插件与技能 / Plugins & skills** is a desk
page that reads Pi's own package catalog (`pi.dev/packages`) — see
[docs/marketplace.md](docs/marketplace.md) — and the project-trust
switch lives in General → Project safety. `Ctrl+,` opens the dialog. Its
**Keyboard shortcuts** page and the `Ctrl+/` modal both render `ShortcutsList`
from the single `SHORTCUTS` table in `lib/shortcuts.ts`, so a new chord needs
adding in exactly one place and the launcher's Settings action shows its hint.

**Deleting one memory asks first, and quotes the line it is about to lose.**
`MemorySettings` used to unlink an entry on the trash icon's click, with no
undo anywhere — the store keeps one `memories.json`, so a mis-click was final.
A row now enters `pendingDelete` and the confirmation names the entry's own text
(one line, capped at 120 characters) instead of asking a bare "are you sure"
over a list of similar rows; `Clear all` keeps the separate dialog it always
had. The placeholder is filled with a **function** replacer, because a memory's
text is arbitrary and `$&` in it would otherwise be read as a replacement
pattern by `String.replace`.

**The memory list is grouped by project, and each group folds.** The rows are
still a projection of `MemoryState`; the grouping key is the entry's
`projectPath` (normalised) or `global`, and the open/closed state is a view
preference in localStorage (`lib/memory-fold.ts`), never a field in the memory
store. The group head is the toggle button with a caret and `aria-expanded`;
folding hides only that group's rows. A block that mounts with a group already
folded starts closed, and an unreadable storage value is treated as no folds.

**A confirmation is portalled to `body`, so it is centred on the window.**
`ConfirmDialog` renders through `createPortal`, not inside the component that
asks. A `position: fixed` layer resolves against the nearest ancestor that
creates a containing block — a `transform`, a `filter`, `will-change`, a
`contain` — and settings pages, panels and menus are exactly where one appears;
mounted inline, the question「删除这条记忆?」was centred on the settings card
instead of the window it is asking about. Keep the portal: a confirmation
belongs to the window, and the layer it is drawn in must cover it, or the scrim
leaves the card's surroundings live.

## The launcher

`Ctrl+Shift+P` opens a palette over the app. It lists every action the app has,
every project it can open, and the model and reasoning switches. The actions are
built in `useLauncherActions` in `src/renderer/src/components/Launcher.tsx`; the
app's own commands are run through the store (`runAppCommand`), so the launcher
and the `/` command list never drift apart.

`Ctrl+P` and `Ctrl+T` walk through Pi's own list of models and reasoning levels.
The store cycles the list that `get_available_models` and
`get_available_thinking_levels` reported. The model picker groups its display by
provider in first-appearance order, preserving Pi's order within each provider;
that grouping does not reorder the store's list or the keyboard cycle. A
`Recent models` shortcut may sit above the provider groups; it only reorders the
display. Search normalizes separators (`model-search.ts`), arrow keys move the
highlight and Enter picks, and the last 20 picks are remembered in
`model-recency.ts`; the menu shows three recent rows and folds the rest of the
list behind "Other models".

A cold chat has not reported `get_available_thinking_levels` yet, so `ModelPicker`
reads `model-catalog:thinking-levels` instead. That handler is a local read of
`models.json` plus the bundled provider JSON (`src/main/pi/model-catalog.ts`);
never import `@earendil-works/pi-coding-agent` there just to answer a picker
question. That import pulls the whole agent bundle into the main process and the
first picker render waits seconds for it. A live session's `get_state` wins over
the static catalog and the picker must not query the catalog again while it does.

## The tool panel

The right side panel is the workspace panel, aligned with MCode: a 46px strip
of fixed-width page tabs (120–160px, 30px high, 18px icons), a close control
that appears on hover, and a `+` beside the tabs that creates a new tab page.
Pages can be dragged to reorder, right-clicked for close/close-others/
close-to-right/close-all, and a strip too narrow for its pages gets the
all-pages menu and horizontal scroll. `Maximize2` makes the panel the whole
work area while leaving the project sidebar reachable — and it maximizes at the
panel's own level (`--z-drawer`), never above it: the shell's corner toggle and
the panel's own menus must stay clickable, or the maximized state covers the
only ways out of it. Staying clickable takes two rules, and z-index alone was
only the first: the maximized (and overlay) panel floats **over the title bar,
which is a `-webkit-app-region: drag` row**, so `.tool-panel` itself must carry
`no-drag` or the OS swallows every strip click — restore included — as a window
drag. And the shell's corner toggle centres in the same 46px band as the
strip's own buttons (`--toolpanel-head-h`), not the 52px title bar, so the
restore, page-action and panel-toggle icons share one line. `Escape` leaves
the maximized state, and never steals the
key from an open dialog, menu or lightbox. There is no permanent
"Tools" tab: closing the last page closes the panel. Reopening it starts from a
centered "start from here" card list (`ToolPanel`).

Files, File changes, Subagents, Swarm, Terminal, Browser and Images are pages,
not a fixed function tab bar. Selecting a card on the new-tab page turns that tab
into the chosen page; opening a view elsewhere adds or focuses its page tab.
`Files` and `File changes` are split views: the preview or diff is the page and
a 236px project tree (Files) or a 220px changed-file list (File changes) sits on
its right, as MCode's file panel and review panel do. `SubagentPanel` is the Subagents page and owns the right-panel
instance of `SubagentTree`; the left sidebar does not contain subagent status.
The Images page lists at most 1,000 pictures after scanning at most 100,000
directory entries; a newer image-list request in the same window supersedes
the previous walk.
The docked panel defaults to 520px and can be dragged between 360 and 760px;
MCode's 640px default does not fit beside Pi's 280px task rail at the same
window width. The comparison with the reference app is in
[docs/mcode-tool-panel-alignment.md](docs/mcode-tool-panel-alignment.md).

## Image generation

Image generation is part of the composer, not a tool-panel page. `/image` (or
the Add menu's Image action) loads the model, size, quality and count controls
into the chat box; the prompt is an ordinary user message, and the pictures
appear in the conversation as the tool's result.

- The desktop hands the chosen options to the task-mode extension with
  `/desktop-image <json>` immediately before the prompt. The extension adds a
  `desktop-image` section to the system prompt for that run only, telling the
  agent to refine the prompt and call `generate_image` exactly once. A
  per-run section is deliberate: a returned `before_agent_start` message would
  stay in the session and keep asking later turns to draw. The options are
  one-shot and are dropped when the next run's prompt does not match, so a
  failed send or an unrelated message can never inherit them.
- The main process owns the direct HTTP path (`src/main/image-generation.ts`,
  `image:generate`): it resolves the `magpie` provider from Pi's `models.json`
  (`baseUrl` + `apiKey`, falling back to `http://127.0.0.1:3425/v1`), POSTs
  `{ prompt, n, size, quality, response_format: 'b64_json' }` to
  `/v1/images/generations`, and parses `{ data: [{ b64_json, mime_type }] }`.
  Credentials never leave main and never appear in an error message. The
  decoded bytes are written into the **current project** under
  `output/generated/` — the output directory is resolved against the workspace
  root and an absolute path or a `..` segment is rejected — so the picture
  immediately shows up in the Images page and can be referenced with `@`.
  Names are slugified from the prompt plus a timestamp and random suffix.
- The Pi tool is a generated extension (`src/main/pi/image-tool.ts`), wired
  into the launch args in `runtime.ts` / `rpc-args.ts` like every other bundled
  extension. It reads the same `models.json` **at runtime** inside the Pi
  process rather than baking a key into the generated file, writes to
  `<cwd>/output/generated/`, and returns the saved paths plus an inline
  `image` content block for the model. The two callers deliberately do not
  share an HTTP client: one lives in Electron main, the other in a generated
  JS string inside a separate process.
- The transcript keeps the result inline. `ToolCard` reads `details.paths`
  through `fs:readImageDataUrl` and draws the thumbnails under the call, and
  `AssistantMessage` keeps `generate_image` out of the process fold so the
  picture is not hidden behind an activity summary.

## The task rail

The rail beside the conversation takes its task data from the session on screen.
Its sections appear in this order: 环境信息 / 后台任务 / 子智能体 / 进度 / 交付物
(Environment info, Background tasks, Subagents, Progress, Deliverables).

Every part of it is a projection, not state:

- the environment section reads `git` from the store: the branch is the
  subtitle under the title, the line counts sit on the right of the Changes
  row, and the other two rows open the commit dialog and the change graph;
- background tasks show Pi's running shell commands by command name after two
  seconds (`listBackgroundCommands` in `lib/task-panel.ts`). A row leaves when
  the command finishes;
- subagents show the thread's recent dispatched children through their outcomes
  (`listSubagentTasks`). A row opens the child's live transcript in the
  Subagents page;
- progress is the newest todo list the agent sent with `desktop_todo`
  (`lib/plan.ts`), or the checklist of the newest assistant message that
  carries one (ignoring a list shorter than two entries) when the agent never
  used the tool. The rail is the only place it is shown — there is no strip
  above the composer;
- deliverables are the files the run wrote (`lib/changes.ts`), listed flat by
  `lib/task-panel.ts`.

**The deliverables are a list of files, not a directory tree.** No folder rows,
no indent, no path on the row: one 20px tile plus one name, so every name starts
on the same column and every row is the same height, in the order the run touched
them. The full path is the tooltip and the click target. The only row that shows
a folder is one whose name another produced file shares — that is the single case
where the name is not enough. `listDeliverables` owns the rule, not the
component.

A tree was tried and is gone: it made every folder a row, hung a file one indent
per level, and turned an absolute path (a chat written outside the project) into a
chain of `C:` → `Users` → `Facron` rows.

The seventh case of `tests/ui-regressions.mjs` measures it: no folder rows, one
column and one row height for every file, the folder shown only on the pair that
shares a name, and the path still on the row's `title`.
`output/audit/rail-check.mjs` prints those numbers for a shape you can look at and
captures the rail.

The rail keeps no state of its own. A section title is plain text with the caret
on the right, and the body folds
on a grid row (180ms) instead of snapping shut. The comparison with the
reference app is in [The task rail, aligned with MCode](docs/mcode-task-rail-alignment.md).

## Files in the composer

`@` in the composer opens the list of files of the project; the list narrows as
the name is typed and a picked file leaves its path in the message. A non-image
file added through the add menu, drag/drop or paste is an **attachment chip**
(`lib/composer-files.ts`): the textarea shows its file icon and basename, and
the `@"<absolute path>"` token is added only when the message is sent. Drafts
written by older builds that already contain a standalone `@"C:/..."` line are
lifted into the same chips on load. A typed `@relative/path` mention stays text,
because it is part of the message rather than an attachment.

The Files page's full-text search is backed by `fs:searchText`: the same walk
and skip policy as `fs:search`, literal case-insensitive matching, binary and
files over 512 KB skipped, at most 3 hits per file and 200 in total. It opens
from the empty preview pane, not from a tab beside the tree. Preview offsets
(`matchStart`/`matchLength`) are relative to the one-line preview, not the file
line; the viewer scrolls to `line`.

The sidebar's conversation search remembers the last eight queries that produced a
hit (`pi-desktop.session-search.history`) and shows them while the field is empty
and focused; picking one just fills the field, which runs the normal debounced
search. Queries with no hits are not remembered.

### The project file tree

The Files page's tree carries **two indexes**, arranged the way the reference
editor arranges them: the filter field sits at the top, then an `All changes`
heading, then two foldable rows — `Changed files` (with a dot while the working
tree is dirty) and `All files`. Pressing a row selects and opens it; pressing
the open one folds it away. The expanded body sits under both rows, so the two
indexes always stay adjacent at the top. `Changed files` lists only the files
git reports, grouped into a folder tree built from the status alone
(`changedFileTree` in `lib/file-status.ts` — no directory walk, so it stays
instant however large the project is). `All files` is the real project tree
from `fs:list`, unchanged in shape from before: folders, sizes, the same
navigation. A clean repository opens on `All files`; once the reader picks an
index, a later git refresh does not move it.

Both indexes use the same row vocabulary: a **file-type icon** instead of an
extension spelled out — code brackets for source, braces for data, a picture
for images, a terminal prompt for scripts, a lined page for prose — tinted per
family from `lib/files.ts`'s tone, plus 27px rows and the change mark on the
right. Only the changed index tints names — modified blue, added green, deleted
struck through — because `All files` is for browsing, not reviewing. Folders in
either index wear a small dot for the strongest change below them; files wear
the framed glyph.

The tree's show/hide control is a **folder button in the panel header**, not a
control inside the tree: it sits in the panel strip's right corner next to
maximize, stays there whether the tree is open or folded, and is tinted while
the tree is showing. `App` owns `fileTreeOpen` and passes it down; `ToolPanel`'s
`actions` slot is where page-specific header controls go.

The marks come from `lib/file-status.ts`, a projection of the same `git` the
task rail reads. `changeKind` folds git's two-letter porcelain codes onto one
mark per file (`modified`, `added`, `deleted`, `renamed`, `conflicted`);
`fileChangeIndex` keys them by the absolute path `fs:list` returns and walks
each file's ancestors so a folded folder still shows its strongest change. A
workspace that is a subdirectory of a larger repository only marks its own
files. `tests/file-status.test.ts` covers the codes, the aggregation, the
virtual tree and the subdirectory case; `tests/ui-regressions.mjs` checks the
two indexes, the badge and the single name column per depth.

The old `Files | Text` segmented control is **gone**. Full-text search is a
wide-pane mode now: the empty preview offers *Search inside the project files*,
and the results open over the preview (`TextSearch`), not in the 236px tree
aside. The tree's own field only filters file names.

`FileViewer` has its own in-file find (Ctrl+F only while the viewer is focused,
so the conversation search keeps its key everywhere else), a line-jump box, a
wrap toggle persisted in localStorage, and copy-path/copy-contents actions. The
find highlights use the CSS Custom Highlight API rather than rewriting the Shiki
output, so async highlighting keeps working.

## Bash

`abort_bash` only aborts a command that the client started with the RPC `bash`
command. The bash **tool** the agent calls runs on its own path, so `abort_bash`
does not touch it — the only way to stop it is `abort`, which ends the whole run.
Do not build a "stop this command" button on top of `abort_bash` and expect it
to work for the agent's own commands.

The terminal is a **real shell on a PTY**, not the client's `bash` user any
more. `src/main/terminal.ts` owns the process through `node-pty`; `TerminalPanel`
draws it with xterm.js and forwards keystrokes/resizes over
`terminal:create`/`write`/`resize`/`kill`. Its output never touches Pi's message
stream or the model's context. The native binaries live in
`node_modules/node-pty` and must stay in `asarUnpack` (and `npmRebuild` is off,
because the prebuilds target Electron 44 and rebuilding needs the VS Spectre
libraries).

New terminal tabs use the `terminalShell` setting: PowerShell (default), CMD,
Git Bash or WSL. Each tab keeps its shell for its lifetime, including an
explicit restart. Adding a shell means adding it in `resolveShellSpec`
(`src/main/shell.ts`) and in the Settings select.

A card in the transcript (the bash tool card, or a bash execution card) can hand
its command to the terminal by dispatching `pi:terminal-run` with `{ command }`.
`App` captures the workspace in a `{ command, cwd, seq }` request. Terminal
tabs keep the directory they started in. A hand-off to a different project
opens a new tab in the requested directory and leaves the old PTY running.
Hand-offs are sent in order. An exited terminal keeps its output and a new
tab handles the next request. A rejected PTY write surfaces an error.

On Windows, closing a terminal ends its process tree before releasing the PTY.
Closing the console alone can leave a background descendant running. Shutdown
waits for the same in-flight cleanup, and a failed close keeps the PTY handle
for a later disposal pass.
Reloading the main renderer ends its old PTYs and drains native cleanup before
the new document can open a shell. Same-document navigation keeps its PTYs.

Pi strips ANSI escape sequences from the bash tool output before it reaches the
client, but the PTY streams raw escape sequences — that is exactly what xterm
needs, so `lib/ansi.ts` is no longer on this path.

## Git

The branch chip, the review panel and the commit dialog read git from the folder
Pi runs in (`src/main/git.ts`, through `workspaceRoot` in `src/main/ipc.ts`).
A folder that is not a repository is a normal answer, not an error: every
handler returns `{ isRepo: false }` rather than failing.

Committing has two modes. When the index already has staged files, the commit
dialog commits only those and says so; ticking "Include unstaged changes" (the
default when nothing is staged) stages the work tree with `git add -A` first.
Do not silently commit unstaged work — the user chose what to stage.

The Review tab reads the same status through `git:fileDiff`: old side from
`git show HEAD:path` (or `HEAD:oldPath` for a rename — `parsePorcelain` keeps the
old path), new side from disk, then the renderer rebuilds a line diff with
`buildDiff`. Reverting restores a tracked file with `git checkout HEAD --` after
a confirmation; an untracked file is deliberately not deleted. Staging is per
file (`stageFile`/`unstageFile`) or all at once, and the staged flag of each file
comes from `git status --porcelain` in `GitStatus.files`. `git:patch` returns a
unified HEAD→worktree patch (all files or one) with untracked files synthesized as
`new file` patches; it is meant to be pasted into `git apply`.

**The working tree is read while a run is going, not only when it settles.** The
agent edits files in the middle of a run, so waiting for `agent_settled` left the
Review list showing the previous batch for the rest of it. `tool_execution_end`
for `edit`/`write`/`bash` now calls `scheduleGitRefresh`, which collapses a burst
of edits into one trailing `refreshGit`. `ReviewView` then has to notice, and
that is a cache question, not a polling one: a cached diff is tagged with the
file's status signature (`path\0oldPath\0index\0worktree\0added\0removed`) *and*
the whole `git` reading it was made under, and an entry whose tag moved is
dropped and re-read. The signature catches an edit that moved the line counts;
the reading catches one that rewrote a line it had already changed, leaving the
counts identical. Only the selected file is re-read, so a run touching twenty
files costs at most one `fileDiff` per git push, and a read that resolves after
a newer one started never paints over it. Do not add a poller, and do not clear
the cache from the component's own refresh path — the store's push invalidates,
the effect re-reads.

`git:commitDetail` reads a commit (metadata, `--numstat -z -M` file list and the
`git show` patch); `git:commitFileDiff` reads the two sides at `hash^` and `hash`,
and `parentHash` (the first parent) lets the dialog walk back through history.
Rename detection for that pair must be done on the whole commit — a pathspec makes
git report the rename as an addition, so `readCommitFileDiff` looks the old path up
in the commit's full `--name-status`. The history row in the commit dialog opens the
read-only detail dialog; DiffView's per-block hunk copy is renderer-only and only
appears when a `patchPath` is passed (the Review tab does; the Changes tab does not).
The same blocks accept `revertPath` and reverse the hunk through `git:applyPatch`
(reverse mode); `applyPatch` writes the patch body verbatim (trailing spaces and an
empty last context line matter) and applies to the worktree only — the index is not
touched, so a staged hunk stays staged while the file on disk changes.

`git:branches` reads local branches (`for-each-ref`, tab-separated — it does not
understand `%x1f`) and `git worktree list --porcelain`. `switchBranch`/`createBranch`
validate the name and use `git switch`; `addWorktree` always creates a new branch by
default because a branch already checked out here cannot be checked out twice, and an
empty path means a sibling folder. The branch chip in the session bar is
`BranchMenu`; a worktree row switches the app to that folder (the store registers
it as a workspace).

The branch menu keeps a **visible worktree checkbox** of its own, beside
"Create and checkout branch". Checking it only arms the next session. The
worktree is created when an empty conversation sends its first prompt — a new
branch named from the current one (`main` → `main-wt`, then `main-wt-2`), an
empty path so the folder is a sibling, then a switch into that checkout.
Git checks the project captured when that send began. If navigation supersedes
the checkout switch, the original submission stays in its composer. A
successful switch passes its own conversation key to the sender.
A conversation that already has a prompt does not gain a worktree on a later
send. There is no branch or path form. Do **not** fold this row into the
branch-creation form: it was hidden there twice (v0.3.0 and the "refine the
branch menu" commit). A "Worktrees" section lists the other checkouts, and
each non-current row can be removed after a confirmation.
`tests/branch-menu-worktree.test.ts` guards the checkbox.

## MCP

`src/main/mcp.ts` reads `~/.pi/agent/mcp.json` and `<workspace>/.pi/mcp.json` and
merges them by server name the way Pi does: a project entry replaces the user entry
with the same name, and an entry without `command`/`url`/`type` overrides only
`enabled`/`exposure`/`toolExposure` while keeping the user server's command and env.
When project trust is off the project file is not loaded at all, and the dialog says
so. `env` and `headers` values are credentials: only the key names leave main, never
the values. The dialog is read-only and never connects to a server — connection state
is the runtime's business, and there is no RPC command for it.

## Remote access

The opt-in phone companion is a separate web app in `src/remote/`, built to
`out/remote/` and served by `src/main/remote-access.ts` only while remote access
is enabled. It works on the same private Wi-Fi network over HTTP; the Settings
page must say that traffic is not encrypted and should only be used on a trusted
network.

- Pairing uses one short-lived, one-use code in the QR fragment. A phone receives
  one bearer token; only its SHA-256 digest is stored in `remote-access.json`.
  Revoking a phone removes the digest and closes its event streams.
- The phone API accepts registered workspace ids and Pi session ids. Resolve
  those ids to paths in the main process; never accept a phone-supplied `cwd` or
  session-file path.
- The phone API is a closed list: listing registered projects and their
  conversations, reading a conversation, sending a prompt (into an existing
  conversation or a new draft), stopping the conversation's run, and answering
  a blocking extension dialog. Do not expose the preload bridge, arbitrary
  Pi RPC, terminal, filesystem, Git, provider or settings operations.
  Prompts still use the session's configured Pi permissions, and answering a
  dialog from a paired phone is the same deliberate act as answering it on
  the desktop — tool-approval dialogs included.
- A blocking dialog (`select`/`confirm`/`input`/`editor`) is forwarded to the
  phone as a sanitized `remote_dialog_request`: only `id`, `method`, `title`,
  `message`, `options`, `placeholder` and `prefill`, each length-capped; the
  `approval` payload, session keys and path fields never leave the main
  process. The pending dialog rides on `/api/session` so a reconnecting phone
  re-renders it, and the answer goes back through `respondUi`. The supervisor
  emits `ui-responded` so every forwarded copy closes when any side answers —
  desktop included. A settled run clears its dialog on both paths.
- A new conversation from the phone runs under a `draft:<uuid>` key (the
  scheduled-task pattern) and follows the supervisor's `rekey` event to find
  the JSONL Pi wrote, so the response can hand the phone the new session id
  instead of leaving it to guess which row in the list is fresh.
- Live updates come from `SessionSupervisor` events. The mobile renderer reuses
  `lib/stream-events.ts` and `lib/thread.ts`; do not add a second protocol reducer.
- Keep host checks, same-origin checks, one-use pairing, device revocation and
  path redaction in the main process. A depth cap must omit nested content,
  never pass raw values through. Never put a bearer token in a URL.
- `npm run dev` watches the separate mobile bundle alongside Electron;
  `npm run build` includes it in the packaged output.

## IM channels

`src/main/channels/` bridges Feishu and WeChat to conversations. One channel
is bound to one registered project and one conversation (`ImChannelBinding`);
messages are dispatched as prompts, and run-state pushes come back through the
same channel. Settings page: `ImChannelSettings` (page id `im-channels`).

- **Config lives in `im-channels.json`** under the user data folder, written
  atomically at mode 0600 behind the same proper-lockfile the remote access
  state uses. `status()` never returns a credential — it reports
  `appSecretSet` / `receiveTokenSet` masks, except `wechat.callbackUrl`, which
  deliberately carries the receive token because that URL is what the user
  must paste into the bridge's `RECVD_MSG_API`. An empty secret on save means
  "keep the stored one", which is why the settings form never reads one back.
- **Feishu** is a 自建应用 in long-connection mode (`@larksuiteoapi/node-sdk`
  `WSClient`): no public URL, no decryption — the SDK owns the socket and the
  reconnect. Feishu re-pushes an event whose handler exceeds three seconds, so
  the handler routes and returns immediately; dedupe on `message_id`; strip
  `@_user_N` mention placeholders before dispatch; only `text` messages
  arrive, and an `allowedChatIds` allowlist gates which chats are routed.
  Replies go through `im.message.create` to the last inbound `chat_id`
  (falling back to the first allowed chat). `test()` reports the connection
  state only — it never sends into a chat.
- **WeChat never hooks the client.** The channel speaks the wechatbot-webhook
  contract against a bridge the user runs themselves (`npx wechatbot-webhook`):
  received messages arrive as multipart POSTs on a local listener (LAN-only
  `isPrivateClient`, receive-token digest compare, per-IP rate limit, 1 MB
  cap, text fields only — file parts are skipped, never buffered), replies go
  to the bridge's `webhook/msg/v2` API, and `test()` is its `/healthz`.
  Sending targets the configured `sendTo` or the last non-self sender. The
  account risk belongs to the bridge project, which is why Pi Desktop keeps
  the contract and none of the hooks.
- **Routing is one place**: `routeInbound` in `im-channel-service.ts`. Commands
  `/help`, `/status`, `/stop` and `/new`; anything else is a prompt through
  `supervisor.ensure` + `request('prompt', …, streamingBehavior: 'steer')`
  with the same argument shape as the remote-access send. `/new` uses the
  draft + `rekey` pattern to re-bind the channel and persist the new binding.
  Inbound length is capped; every reply is capped to `MAX_IM_MESSAGE_CHARS`.
- **Pushes are event projections**, not a second transcript: `agent_end` +
  `agent_settled` reuse `describeRunCompletion` (the same extraction the
  desktop notification uses) to push the final answer — never for an aborted
  or crashed run — and a blocking `extension_ui_request` pushes a
  needs-confirmation notice. IM channels do not answer dialogs in v1.
- **Keep the transport injectable**: `im-channel-service.ts` must not import
  `adapters.ts`; tests pass a fake adapter through the constructor's
  `createAdapter` option, the same seam the app uses with the real one.

## Memory

`src/main/memory/` owns persistent memory: a background extractor, a
file-backed store under `<userData>/memories/`, and the appended system-prompt
block. `MemoryService` only listens to `agent_settled`, waits for an idle
delay, skips aborted, draft, running and external-context sessions, and
serializes model calls. Turning automatic learning off cancels the active
startup batch, even if learning is turned back on before that batch returns.
The Pi extension persists external-context checks on
the active branch; an oversized session without a complete check is skipped
until Pi opens and classifies it, unless that filter is disabled.
`memories.json` is canonical; `memory_summary.md` and
`rollout_summaries/` are projections. Both are capped: the summary at 10,000
bytes, and the notes at 200 files / 8 MiB, oldest first
(`selectRolloutNotesToPrune` in `store.ts`). A note is one file per learned
session, so without a cap a year of conversations would leave thousands of files
behind; a single note larger than the whole byte budget is dropped on its own
rather than taking the smaller notes behind it down too. Never inject the raw
entries file — the prompt gets a project-scoped, 10,000-byte summary plus the
decision-boundary header in `MemoryService.promptFor`. Extraction runs in a
throwaway `pi --print --no-session --no-tools --no-extensions --no-skills --no-mcp
--no-context-files` process; memory text is data, never instructions, and
secrets are redacted before storage and again at merge time. The settings page
is `MemorySettings.tsx`; tests are `tests/memory.test.ts`. See
[docs/memory-system.md](docs/memory-system.md).

## Task modes

Task modes are a bundled Pi extension (`src/main/pi/task-modes.ts`), not renderer
state. There are four working modes — Default, Goal, Swarm and Plugin — plus
Plan Mode, which is an approval gate over the others rather than a fifth
loadout. The extension persists mode and goal in custom session entries, changes
the active tool loadout and publishes the mode on `pi-desktop-mode` and the goal
on `pi-desktop-goal` (JSON `{text,status,summary}`). `GoalBar` only projects that
status and sends `/desktop-goal pause|resume|clear|edit` back through the store.

**A finished goal leaves the composer.** The bar is a header for work in
progress, so once the extension reports `complete` it stops rendering
(`goalBarVisible`) and the objective becomes the conversation's closing row:
`conversation/GoalCompleteRow` draws the check, the objective and the completion
summary at the end of the transcript, where the turn that finished it ends. Its
`clear` action is the only way to retire the row, and `blocked` deliberately
keeps its bar — a blocker is a question (resume it, clear it), not an outcome.
`desktop_goal_finish` returns `terminate: true` for the same reason: the model has
just stated the outcome, and a request after it produced a second message about
work already declared done. Only an *outcome* terminates; the auto-continue path
still asks the model to keep working.

Swarm Mode is a team of persistent workers: the main chat leads, `swarm_spawn`
starts a worker, `swarm_task` queues work on one, `swarm_message` talks to it,
`swarm_collect` and `swarm_status` read the team, and `swarm_disband` ends it
(`src/main/pi/swarm.ts`, page `SwarmPanel`, projection `lib/swarm.ts`). The tools
exist only in this mode; `/swarm` enters it and `/swarm off` leaves it.

### The Swarm page

`SwarmPanel` is the reader's window into that team, and it answers three
questions separately because during a run they disagree constantly:

- **Overview** — one row of readings (workers, active and queued tasks, tokens,
  elapsed), one lane per worker with a block per dispatched task, and a feed
  that puts live workers first and hand-overs after them. A lane exists for a
  worker before it was handed anything, so the page always shows the whole
  team; a worker with no task yet shows what it is doing instead.
- **Workers** — the roster, filtered by status, each row expandable to its live
  output or its report. Arrow keys move between rows; Stop is drawn only for a
  worker that is really running.
- **Dispatches** — the `swarm_task` / `swarm_message` calls as a log, newest
  first, filtered by status; a row opens the existing `SubagentConversation`
  and Back returns to the log.

**A roster read from the thread rather than the live status entry is history**:
a `running` worker there did finish, so it reads "Previously active", and a
queued count is not a live queue (`displayStatusOf`). All of those readings live
in `lib/swarm.ts` (`swarmAssignments`, `assignmentsByWorker`, `swarmFeed`,
`countAssignments`, the filters) so they are tested without a DOM
(`tests/swarm-view.test.ts`). `tests/ui-regressions.mjs` drives the page with
an injected roster and asserts the three views, the lanes, a status filter and a
dispatch row opening its child conversation.

Plan Mode explores with `read`, `grep`, `find`, and `ls`. The `desktop_ask_user`
tool is available in every desktop task mode. It uses Pi's `select` dialog and
returns the chosen option to the requesting conversation. `exit_plan_mode` asks
for approval through Pi's dialog protocol. Approving restores the
previous tool loadout. Its `tool_call` is exempt from the generic permission
gate because that dialog is already the approval. Working modes include the
`subagent` tool. Plan Mode blocks it. Saved Subagent Mode conversations reopen
in Default Mode. The saved original tool list excludes the managed `subagent`
tool. `desktop_todo` is available in working modes: it records the agent's checklist
in the session and its `tool_call` is exempt from the permission gate because it
is bookkeeping for the progress rail. Plugin Mode keeps the normal working
loadout and adds an instruction to author a Pi extension — global
`~/.pi/agent/extensions/` or project `.pi/extensions/`, a load check with a
throwaway `pi -e`, and a report of the path. `src/main/pi/subagent.ts` generates the
per-process extension that spawns a separate `pi --mode rpc` process per task,
loads the child's permission extension, and routes its approval requests through
the parent conversation's live permission dialog. It reads Pi's JSONL with
`StringDecoder` (never `readline`) and returns the child's final text and usage.

The delegation contract is part of the generated source, not a renderer concern:

- `promptSnippet` plus `promptGuidelines` teach the model when to delegate and
  that a briefing must be self-contained; the child's system prompt repeats it.
- A call may carry `label`, `cwd`, `model`, `thinking`, `tools`, `timeoutMs`,
  `retries` and `outputSchema`, at batch level or per task. A valid per-task
  model or thinking level wins over the batch; the batch then falls back to
  Settings and the dispatching session. Nonempty per-task tools and any
  explicitly supplied schema override the batch; an empty tools list uses the
  batch value. Timeouts and retries are clamped to their supported ranges; an
  invalid working directory or schema fails before a child starts.
- `timeoutMs` defaults to 30 minutes and also covers time spent waiting for a
  worker slot; a timeout kills the process tree and reports `timed_out`.
- `retries` is 0-2 and only retries an attempt that produced no assistant turn
  and no tool event. That is the whole safety argument: nothing was changed, so
  nothing is repeated. A timeout, a user stop and a schema mismatch are never
  retried.
- `outputSchema` (a bounded JSON Schema subset: type, required, properties,
  items, enum, const and the common length/number bounds) is appended to the
  child's prompt as a contract. The answer is parsed and checked on the parent
  side; a mismatch fails the task with `stopReason: 'schema'` and keeps the raw
  output visible instead of reporting success. Unsupported schema keywords fail
  before the child starts, so ignored constraints cannot be reported as valid.
- A running or queued task is stopped by the app, not by another tool, because
  the parent turn is blocked inside the tool call: the extension registers
  `/desktop-subagent-cancel <toolCallId:index>`; the subagent tree and the Subagents page row's stop
  button sends it through Pi's prompt channel. The id format is the one the UI
  already derives in `lib/subagents.ts`.
- Named agent presets are Markdown + flat `name: value` frontmatter in
  `~/.pi/agent/agents/*.md` (always read) and `<workspace>/.pi/agents/*.md`
  (only while project trust is on — the same gate as `.pi/mcp.json`). A project
  preset with the same name replaces the user's and claims its slot before
  global presets when the 32-preset cap applies. `src/main/pi/agents.ts` owns
  discovery, `realpath` escape checks, file/size/prompt bounds and skipping
  malformed files; `subagentExtension()` re-validates every preset before it
  becomes part of a child's argv. The roster is interpolated into the tool
  description so the model routes by `description`, and `agent: "<name>"` adds
  the preset's body to the child's system prompt plus its model / thinking /
  tools / timeout defaults. Precedence is: the call's explicit value > the named
  agent > the batch default (Settings, then the dispatching session). An unknown
  `agent` fails that task before a child starts, with the available names in the
  error; a sibling in the same batch keeps running.
- Subagent token/cost is a separate reading, never folded into the parent's
  `totalTokens` or cache hit rate (`lib/subagent-usage.ts` → `SessionMetrics`):
  a child is its own Pi process and never appears in the parent's transcript or
  `get_session_stats`. `UsagePanel` shows the row only when a conversation
  actually delegated.

Computer Use is a General setting (`computerUse`), not a task mode.
`src/main/pi/computer-use.ts` registers the `computer` tool (screenshot, list
windows, click, move, type, key, scroll). The task-mode extension adds it to
the normal, Goal and Subagent loadouts only while the setting is on, so the
switch is the approval — the generic permission dialog does not ask again on
every action. A live process hears the change as `/desktop-computer on|off`.
Coordinates are pixels in the latest screenshot, not screen points or window
bounds. Plan Mode blocks the tool, and it is not given to subagents.

`SubagentTree` is a page of the right side panel (`SubagentPanel`), not part of
the left sidebar. It projects all loaded conversations through `lib/subagents.ts`.
Child progress lives in the subagent tool's `details.results`; `lib/thread.ts`
preserves those details from live updates and replayed tool results. Keep
queued/running/terminal states and timing in those events, not a second store.
Tree expansion uses the per-conversation `lib/view-state.ts` map. Clicking a
task row opens its child transcript (`SubagentConversation`), built from the
`messages` the subagent process recorded in the same details; the Back control
returns to the catalog.

## The agent defaults page

Settings has a page (`AgentSettings`, page id `agent`) that gathers what a new
conversation starts with: the default model, permission, reasoning effort, Plan Mode,
the subagent model and effort, pasting, folding and titling. It is a door, not an
owner — every row writes a field in `AppSettings` that the rest of the app already reads.

How a default reaches a process is the part to get right:

- The generated extensions are written **per process**, so a default is baked at
  generation (`runtime.ts` → `taskModesExtension(computerUse, defaultMode)` and
  `subagentExtension(defaults)`). That is why a settings change affects the next
  process, and why the copy must say "new conversations" — never "now".
- The one exception is `permissionMode`: `getPermissionMode` is consulted on every
  `tool_call`, so it is live. That row is allowed to promise immediate effect.
- Do **not** broadcast `/desktop-mode` on a settings change. It would flip the mode of
  conversations the user is already working in, which is not what the switch means.
- Plan Mode seeds only a launch with nothing to resume — gate on `!sessionFile`, the
  same value that decides `--session`. A resumed conversation restores the mode from its
  own `pi-desktop-mode` entry, and that entry then wins over the setting.
- A subagent's model or effort must survive into an argv: only `provider/id` (the id may
  hold slashes — gateway providers are `openrouter/vendor/model`, and the catalog splits a
  saved spec on its **first** slash) and Pi's lowercase level names are accepted; anything
  else degrades to `''` = follow the conversation. Empty settings must leave the child's
  argv byte-identical to before, which `tests/subagent.test.ts` asserts.
- The renderer seeds a draft's `agentMode` so the chip is honest before Pi boots. Pi's
  `setStatus('pi-desktop-mode')` stays the only writer afterwards; no second flag, and no
  process is started just to apply a mode.
- A model switch on a cold conversation is a settings change, not a process launch:
  `setModel` persists `settings.model`/`settings.provider`, a draft's next process reads
  the saved default, and a resumed session gets `set_model` from `ensureRuntime` before
  its first prompt. Never call `ensureRuntime` just to change a model — that made the
  first picker click after startup wait for a full Pi cold boot.

`autoFoldProcess` and `toolCallSummary` are projections, not state. The first is the
*default of the fold that `ProcessTrail` already computes* (`manualOpen ?? (!busy && !autoFold)`) —
it ships on, because a settled trail is folded today. The second only gathers a *live*
stretch of calls into the summary line, opening to the same `ToolCard` rows. Neither adds
a store field, neither touches `lib/thread.ts`, and neither may change the rule that a tool
call is one node keyed by `toolCallId` at its first-appearance position.

`pasteMentions` writes the pasted picture **into the working folder** (`fs:savePastedImage`,
`projectlessRoot()` when there is no project) before referencing it, because an `@` mention
resolves against Pi's cwd and `fs:search` walks the project: a temp path would reference a
file the agent cannot read. It captures the draft and working folder before reading the image
so switching projects during the paste preserves both. It inserts through the same splice as
a hand-picked mention and degrades to attach-only when the folder is removed or the write fails.

`autoTitle` is a second listener on the runtime stream, deliberately not part of
`MemoryService`: a title is wanted for every new conversation while memory skips sessions
that used MCP or subagents. It runs the throwaway `pi --print` CLI, names through
`supervisor.rename` (hot → `set_session_name`, cold → one `session_info` line) and never
writes the JSONL itself, because a second writer of a session file is the bug AGENTS.md
warns about. The model's reply is data: one line, length-capped, short trailing punctuation
is removed, and refusal/prose answers are rejected. A new draft can still use its first
exchange after a quick follow-up; an image-only request uses the first answer to pick the
title language. If the throwaway model call fails, a secret-redacted prompt title is used.
Read races get one short retry, and every failure path logs at most one line.

## Settings

The dialog's page ids and English labels live in `lib/settings-pages.ts`; the
dialog adds only the icons. The search field above the page list reads
`lib/settings-search.ts`, a hand-written index of the settings readers look for,
with the words they might type in either language. Do not mount the lazy pages
to read their labels: opening all twelve would start provider, update and
memory requests the reader never asked for. A result names the page and, when a
setting is what matched, that setting's label. An empty query is the ordinary
navigation, and a miss says so. Every page keeps at least two rows, and
`tests/settings-search.test.ts` asserts every row points at a real page and has
a Chinese reading.

Escape in a modal clears a non-empty `type="search"` field before it closes the
dialog: `useDialogFocus` listens in the capture phase, so the hook has to step
aside for that field or the key never reaches it. The next Escape closes.

Choosing a result does not stop at opening the page. The page is lazy, so
`SettingsDialog` polls for the row whose trimmed text is exactly the matched
label (the deepest such element, or an ancestor would flash the whole group),
scrolls it to the middle of `.settings-content` **without animation** — the
page just changed, and an animated scroll makes the reader wait to see where
the label landed — and flashes it with `.settings-hit` for 1.8 s. There is no
shared anchor on the pages to point at, which is why the label text is the
contract. `Ctrl+F` focuses the settings search while the dialog owns the
keyboard; the conversation search it normally opens is already disabled behind
a modal.

Search is reachable by keyboard alone: ArrowDown in the field enters the page
list at its first row and ArrowUp enters at the last; inside the list the
arrows walk rows and either end hands focus back to the field. Enter in the
field opens the top result (the same action a row click runs). A row is a
button, so Enter and Space on it are the browser's own activation — do not add
another key handler for the row itself.

At the minimum window height (880×572) the page list is taller than the dialog
and scrolls. Its children keep their own height (`flex: 0 0 auto`): without it
flex-shrink squeezed the 28px search field to 21px, and the icon crowded its
placeholder. The field is also sticky at the top of that scroll — it is the way
back to any page, so it must not scroll away with the list. Both are measured
by resizing the modal in `tests/ui-regressions.mjs`, and
`output/audit/check-min-window.mjs` captures the whole window at 880×572.

## Jumping to a search hit

A conversation-search hit becomes a `pendingJump` in the store. The sidebar only
sets it; `Thread` owns the DOM, so it maps `messageIndex` (the n-th user/assistant
message of the file) to a turn, falls back to the first turn containing the query
when a branch makes the index miss, scrolls and flashes that turn, opens the
in-thread search on the same words, and clears the request. Do not scroll from the
sidebar — a conversation that is not mounted has nothing to scroll.

## Style

- TypeScript everywhere, `strict` on. No `any` in the IPC boundary.
- CSS is plain CSS with custom properties in `src/renderer/src/styles/tokens.css`.
  Use the existing tokens; do not hard-code colours.
- The type scale is MCode's standard preset, copied 1:1; use the role tokens
  (`--text-assist` / `--text-small` / `--text-body` / `--text-chat` /
  `--text-large` / `--text-button` / `--text-code-block` …) with their matching
  `--leading-*`. The old numeric names are aliases only; do not add new
  `--text-2xs` / `--text-xs` uses, and never write a raw `font-size` in a
  component stylesheet. The reference record is
  [docs/mcode-typography-alignment.md](docs/mcode-typography-alignment.md).
- The UI face is MCode's system stack; Chinese must fall through to the generic
  `sans-serif` family (Noto Sans SC on this image). Do not put an explicit
  Microsoft YaHei family before it — that changes every CJK glyph. Code uses
  the bundled JetBrains Mono (OFL) in `src/renderer/src/assets/fonts/`.
- **The font chosen in Appearance owns the whole line, Chinese included.**
  `--font-cjk` is a local face whose `unicode-range` covers every CJK block, so
  it claims all Chinese glyphs ahead of anything after it. That makes its
  position a decision: never in front of the chosen font (or the picker changes
  Latin only), and required in `--font-mono` after JetBrains Mono (Windows links
  generic `monospace` to NSimSun). The UI stack does not carry the face at all —
  `sans-serif` already links Chinese to a sans face. Build chosen stacks with
  `uiFontStack()` in `src/renderer/src/lib/ui-font.ts`, never as an inline CSS
  string, and keep `output/audit/ui-font-sweep.mjs` passing.
- The four text sizes live in `src/shared/font-scale.ts` (12/14/15/16 against
  the 14px body). Stored legacy multipliers are normalized there; use that
  module instead of re-deriving the ratios in a component.
- A control that cannot fit its own label in one line — the narrow docked panel
  is where this happens — drops the label and keeps the icon: `.icon-btn` with
  the same words in `title` and `aria-label`, so the tooltip explains what the
  icon does. Do not solve the wrap by shrinking the font or abbreviating the
  wording.
- `HoverTip` replaces the OS `title` bubble for the whole window. It stays down
  while a control's **own** popup is open (`aria-expanded` plus `aria-haspopup`,
  or anywhere inside `.popover-wrap[data-open='true']`), because the open menu
  already names its trigger. `aria-expanded` alone is not that fact: the
  tools-panel and sidebar toggles expand a surface elsewhere on screen, and the
  bubble is the only place an icon-only control is named — hiding it exactly
  while the control reads "Hide …" removed the tip. `expandedPopupHidesTip` in
  `lib/hover-tip.ts` is the rule; `tests/hover-tip.test.ts` guards it. A click
  still dismisses the bubble until the pointer leaves, **except** on a control
  that flips its own name under the pointer (the panel and task-rail toggles do):
  the new name arrives after the usual delay without moving the mouse, because
  otherwise the one control whose meaning just changed is the one you cannot read.
- Prefer small, focused components. Keep protocol knowledge out of the React tree.
- Comments explain *why*, not *what*.

## The interface language

The UI is authored in English and translated at paint time by exact lookup
(`translate` / `useT` in `src/renderer/src/lib/i18n.ts`). **A key that is
missing does not fail; it leaves English on a Chinese screen**, which is why
`tests/i18n-coverage.test.ts` is a gate and not a nicety. It scans the
renderer's literal `t('…')` calls, `showToast('<sentence>')` literals (those
are translated where the toast paints, not at the call site), and the messages
the main process throws from the files whose text reaches a toast, a banner or
a form (`MAIN_DOORS` in the test). Add a key when a scan finds one missing —
the failure names the string and its file.

- A message built around a value (`Image generation failed (HTTP 502): …`,
  `The chat folder must be an absolute path: …`) cannot be a key. Give it a
  shape in `translate` next to the other readings, and translate the detail
  recursively rather than pasting it English into a Chinese sentence.
- An error surface paints `t(error)`, never the bare `error`: unknown text
  (git, Pi, a provider) passes through unchanged, while the app's own messages
  are translated. The form pages, the marketplace, the MCP dialog, the terminal
  overlay and the welcome screen already do.
- Model-facing tool protocol text (`pi/subagent.ts`, `pi/computer-use.ts`,
  `channels/wechat.ts` replies) is not a sentence for a reader and stays out of
  `MAIN_DOORS`; a message the renderer can meet belongs in it.

## Screenshot harness

The main process can capture itself for visual checks. It only activates when the
environment variable is set. The `output/audit/*` harnesses named in this file
are local measurement scripts kept outside the repository (`output/` is
gitignored), so a fresh clone cannot run them; when a claim depends on geometry,
re-measure it with the screenshot harness below instead of trusting the number.

```bash
PI_DESKTOP_SCREENSHOT=out/shot.png \
PI_DESKTOP_WORKSPACE="C:/path/to/project" \
PI_DESKTOP_SCREENSHOT_DELAY=6000 \
PI_DESKTOP_PROMPT="do the thing" \
npm run build && npx electron .
```

`PI_DESKTOP_THEME=light|dark|system` overrides the theme for the run. It only changes
what is rendered; the stored setting stays as the user left it.

`PI_DESKTOP_USER_DATA` points the run at a throwaway data folder, so a harness
run neither reads nor writes the user's own settings, sessions and workspaces.
It works on its own, without the screenshot flag.

Other flags, all off by default: `PI_DESKTOP_PREFILL` fills the composer,
`PI_DESKTOP_OPEN_CHANGES` and `PI_DESKTOP_OPEN_FILES` open an inspector tab,
`PI_DESKTOP_FILE_SEARCH` and `PI_DESKTOP_OPEN_FILE` drive the file panel,
`PI_DESKTOP_SEARCH` opens the in-conversation search, `PI_DESKTOP_SESSION`
resumes a session file, `PI_DESKTOP_SETTINGS` opens the settings dialog,
`PI_DESKTOP_EXPORT` exports the session, `PI_DESKTOP_OPEN_TERMINAL` opens the
terminal drawer, `PI_DESKTOP_COMMIT` opens the review panel and its commit
dialog, and `PI_DESKTOP_CLOSE_AFTER_MS` closes the window on purpose to
reproduce the destroyed-window case.

`PI_DESKTOP_EVAL` runs a JS snippet in the renderer just before the capture
and `PI_DESKTOP_EVAL_DELAY` (default 400ms) is the settle time afterwards.
That is how transient UI — a clicked button, a flashed turn — gets captured.
The snippet can also reach the store through `window.__piDesktopStore`, which
the renderer exposes when the harness is in use. It is the way to reach a
state that is hard to produce on purpose, such as a retry in progress.
