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
- The model's raw thinking text is never rendered. `ThinkingBlock` shows only
  that a thought happened, its duration and a "Reasoning hidden" label.
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

The stream's leaf components live in `components/conversation/`:
`AssistantMessage` owns process segmentation, `StreamingText` owns the reply
document, `ToolResultPanel`/`CommandOutput`/`LogOutput` own expandable output,
`FileChangeRow`/`RunSummary`/`ErrorNotice` own their rows. Long output is
paged by lines (200 per page) — never render a whole build log at once.

`RunSummary` is the completed turn's top row (label, duration, chevron), not a
divider at the end. Its chevron folds the tool/thinking process; the answer
stays visible. `AssistantMessage` receives `processOpen` so hiding the process
never hides the reply. Retry, compaction and other stream notices are process
too, not answer: `hasProcess` counts them and they render only while
`processVisible`, so a settled turn folds them away instead of leaving a stack
of "retry succeeded" lines outside the fold. A turn with nothing but notices is
still foldable, so the reader can always expand to read them.

`Thread` remembers the scroll position per conversation (session file or draft
key) in a process-level map so switching to an empty chat cannot forget it;
`rekeyThread` migrates a draft's entry when Pi writes the session file. It only
follows while the reader is at the bottom. Do not call `scrollToBottom` on
every update; expanding a tool body must not move the reader's viewport.
Per-conversation tool/file/process/history expansion lives in
`lib/view-state.ts`, not in component-local state.

Tests: `npm test` runs the reducer unit tests (`tests/thread.test.ts`,
against the real RPC event shapes), `npm run test:e2e` spawns the bundled
CLI and drives the real reducer with a real run — including a stop mid-run.

## The session tree

Pi stores a session as a tree of entries, and two commands move around it:

- `fork` starts a new session from a user message. It forks **before** that
  message: the new branch keeps the earlier history and the message itself comes
  back as text, so the client puts it back in the composer.
- `clone` copies the active branch into a new session at the current position.

Both need the session to be on disk already, so they fail on a session that has
never received a message. `get_fork_messages` reports the prompts of the active
branch, in order, with the entry id to fork from; the thread pairs them with the
messages on screen in `src/renderer/src/lib/thread.ts`.

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

Opening a conversation does not start Pi. A conversation that stays on screen
for a moment prewarms its own process in the background (`schedulePrewarm`),
and focusing the composer starts a cold runtime; the prompt itself is still sent
only when the user submits it. A prewarmed process carries the speculative mark,
so moving the view on stops it again. Drafts are never prewarmed: Pi writes a
session file as soon as it starts, so a chat that was never written would leave
an empty conversation on disk. `SessionSupervisor` holds one process per hot
conversation, and the same JSONL never has two writers. A second prompt in the
same working directory waits; it does not abort the one already running.
The working-directory gate is shared across app processes. Parent and nested
folders overlap; sibling folders remain independent.
Switching projects is also only a view change. Closing or removing a workspace
is what stops that folder's processes.

The sidebar running mark reads `threads[file].isStreaming`. `stop()` aborts the
conversation on screen, not whichever one happens to be running in the
background.

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
widgets and task rail all belong to the conversation
branch and must not sit underneath the page. There is no Back control in the
titlebar; selecting a conversation, starting a new chat, or clicking the same
sidebar entry again clears `deskPage` and restores the conversation unchanged.
Destructive confirmations stay inline as well: deleting a scheduled task asks
in its own row, so these pages never open a native or modal dialog.

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

One round button, two meanings: it sends when the run is settled, and it stops
when the agent is working. It stops only while there is no draft — with text in
the box the button is the way to send (steer or queue), so the stop moves into
the row under the box as `session-bar__stop`. Both call the same `stop()`; there
is no second abort path.

### The usage line under the composer

`UsageBar` is one compact line **centred** under the input after a run, and it
carries three readings plus the ring, in that order: turns/steps with TPS, token
usage with cache hit rate, then `ContextRing` at the end of the line. The bar is
a summary, not a report: **the first-token delay is not on it.** Speed and TTFT
describe one answer rather than the conversation's running totals, so they share
a second popover behind the turns/steps and speed reading (`GenerationPanel`). It
uses the compact session statistics layout: turns and steps, model time, tool
execution time, average TTFT and output speed. Unavailable readings say
`Not measured yet`. Pi reports tool `durationMs` when available; the client
measures tool start-to-end as a fallback. Model time sums client-observed
`turn_start` to assistant-message completion intervals. Average TTFT is one
prompt/run's `agent_start` to first text token, averaged across recorded runs.
These timing samples live in localStorage per conversation and migrate when a
draft gets its session file. A reopened transcript with no client samples is
approximated from Pi's message timestamps and each assistant message's
`durationMs` (prompt-to-first-assistant for TTFT, summed answer windows for
model time and TPS). Version 1 model-time samples used the wall clock and are
dropped; version 2 changed model time to a monotonic clock. TTFT, run,
generation and fallback tool samples before version 4 also used the wall clock,
so they are dropped during migration because the record cannot distinguish a
Pi-reported tool duration from a client fallback. Sleeping the machine or
syncing the time could turn one answer into hours, and a wrong total is worse
than a missing one. The tokens and the hit rate open `UsagePanel` — total Token,
cache hit rate, uncached input, cache read, cache write and output. Two
questions, two cards; a reading printed in both would be two things to keep in
sync.

The ring is `ContextRing`: the arc plus its percentage, one colour, following
the `showContextUsage` setting. It opens `ContextPanel`, which asks Pi for
`get_session_stats` on open (`readSessionStats`) and offers a refresh. Both
components read through `lib/context-reading.ts`, never off `stats` directly:
`get_session_stats` only answers while a process is running, so a conversation
merely reopened from disk has no `stats` at all. That module falls back to the
newest assistant message's usage and the model's `contextWindow` — the saved
model's when there is no live process — and reports `source` so the panel can
say whether the reading is Pi's or an estimate. Pi's own `contextWindow` must
outrank the saved model, or a stale window renders an impossible percentage.

Token totals and the hit rate come from `get_session_stats`, with the visible
transcript as a fallback; the hit rate counts cache reads against every prompt
token — fresh input, cache reads and cache writes. Pi reports no generation
timing, so `run` mints `firstTokenAt` on the first text delta (TTFT is the
first readable word) and starts each answer's generation window at its first
block of any kind — text, thinking or a tool call — summing the window into
`generationMs` when the block ends (`text_end`, `thinking_end`,
`toolcall_end`, `message_update:done` or `message_end`). A tool gap between
answers is not model time. `session-timing.ts` stores per-conversation model
time, TTFT, generation windows and fallback tool durations, while
`session-metrics.ts` derives the displayed totals and newest-turn TPS.

## The session bar

`SessionBar` is the row under the composer, and it is the only place where the
conversation's settings live: the project (a menu of every known project, which
switches through `switchProject(..., { allowWhileRunning: true })` — the same
deliberate door the launcher uses), the branch and its dirty count
(`BranchMenu`), the reasoning effort, the model and the context ring
(`ContextRing`). While a run is going it also carries the stop link; delivery
mode is a Settings preference, not a composer control.

The title bar does not repeat any of it: it keeps the conversation's name and
the app's actions. A project or branch chip in two places is two things to keep
in sync, and the one in the header had no room to say what it was.

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

## The tray and the taskbar icon

Two things belong to the main process and nowhere else: the system tray and
the icon Windows draws for the app. The renderer owns the switch and nothing
else — the tray is a projection of one setting, `trayPersistent`.

With the tray on, closing the window hides it instead of quitting, and the
tray icon is the way back: a click opens the window, the menu offers *show*
and *quit*. The rules that keep the window from disappearing for good:

- Hide only while the tray icon is really there. A missing icon, a real quit
  and the screenshot harness all close the window for real; hiding without a
  tray would leave no way back at all.
- The single-instance lock is taken only in tray mode. A second launch then
  focuses the window that already sits in the tray instead of opening a
  second one the user cannot find. With the tray off, no lock is taken and
  the app opens a second window as it always did.
- The flag is read from the settings file *before* the app is ready, because
  the lock has to be claimed before `start` builds the store.
  `readPersistedFlag` in `settings.ts` is that early reader. It must stay
  the only one: two readers of one file are two notions of a byte order mark.

The taskbar icon is the window icon. Windows draws the taskbar button from
the window's own icon, so a dev run of `electron.exe` shows the Electron
logo until the window carries the pixel mark. `app-icon.ts` owns all of it:
the `.ico` next to the asar (`extraResources`), the `BrowserWindow` icon,
and the AppUserModelID, which has to be the same id electron-builder stamps
on the shortcut (`appId` in `electron-builder.yml`) or Windows treats the
dev run and the installed run as two different apps.

Two rules about that id decide whether the taskbar draws the pixel mark or
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
  claimed by a dev run that still carried electron.exe's icon, so that id is
  stuck on the Electron atom for good. The id in use is `dev.pi.desktop.v2`.

An `.ico` stores a PNG per size and Electron's loader keeps only the
largest frame, so a reader that wants one particular size walks the
directory itself: `src/main/ico.ts`. The tray wants 32px, and the shell
wants a real file path — neither can be served by a resample of the other.

## Starting the app

`bootstrap()` reopens the *project* that was active, never the conversation.
`lastSessions` is still written by `rememberSession` and still feeds the welcome
screen's "recent in this project" list, but only a click there opens a session —
a start is a new chat. If no saved project can be restored, the start becomes a
projectless chat and `activeWorkspaceId` is persisted as `null`; the welcome
screen never falls back to a dead "open project folder" state.

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

### Long session files

A session larger than the 24 MB read window is not dropped. `sessions.ts` reads
its transcript from the tail — the newest 24 MB — and builds metadata from a 2 MB
head plus a 1 MB tail. `getSessionMeta` must never answer `null` just because a
file is long, or the sidebar hides a conversation the user can still resume.
`readJsonlLines` starting mid-file skips the partial line, and a cold rename
appends its `session_info` to the tail leaf.

Full-text search does not skip a long session: above the 8 MB direct-scan window
it uses a per-session index in `<userData>/session-search-index/`, holding only
the user/assistant text with a lower-case copy for matching. The first query
builds it from the newest 64 MB; later queries scan the snapshot, and an append
is picked up from the last complete JSONL record. An unterminated tail is
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
removes its index. On-disk sidecars are capped at 512 files and 512 MiB; startup
and writes evict the oldest indexes when either limit is exceeded.
`configureSessionSearchIndex` is the only door to the folder — the main process
points it at `userData`, tests pass `null` to keep the old direct scan.

### Settings and shortcuts

The settings dialog has no Plugins page: plugins, skills and MCP servers are
managed on the Marketplace desk page (`ResourceManager`), and the project-trust
switch lives in General → Project safety. `Ctrl+,` opens the dialog. Its
**Keyboard shortcuts** page and the `Ctrl+/` modal both render `ShortcutsList`
from the single `SHORTCUTS` table in `lib/shortcuts.ts`, so a new chord needs
adding in exactly one place and the launcher's Settings action shows its hint.

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
only ways out of it. `Escape` leaves the maximized state, and never steals the
key from an open dialog, menu or lightbox. There is no permanent
"Tools" tab: closing the last page closes the panel. Reopening it starts from a
centered "start from here" card list (`ToolPanel`).

Files, File changes, Subagents, Terminal, Browser and Images are pages, not a
fixed function tab bar. Selecting a card on the new-tab page turns that tab
into the chosen page; opening a view elsewhere adds or focuses its page tab.
`Files` and `File changes` are split views: the preview or diff is the page and
a 220px project tree (Files) or changed-file list (File changes) sits on its
right, as MCode's file panel and review panel do. `SubagentPanel` is the Subagents page and owns the right-panel
instance of `SubagentTree`; the left sidebar does not contain subagent status.
The Images page lists at most 1,000 pictures after scanning at most 100,000
directory entries; a newer image-list request in the same window supersedes
the previous walk.
The docked panel defaults to 520px and can be dragged between 360 and 760px;
MCode's 640px default does not fit beside Pi's 280px task rail at the same
window width. The comparison with the reference app is in
[docs/mcode-tool-panel-alignment.md](docs/mcode-tool-panel-alignment.md).

## The task rail

The rail beside the conversation answers four questions about the session on
screen, in this order: the environment of the folder, the tasks running in the
background, how far the plan has come, and the files the run produced. Its
sections are 环境信息 / 后台任务 / 进度 / 交付物 (Environment info, Background
tasks, Progress, Deliverables) — the same four the reference app carries.

Every part of it is a projection, not state:

- the environment section reads `git` from the store: the branch is the
  subtitle under the title, the line counts sit on the right of the Changes
  row, and the other two rows open the commit dialog and the change graph;
- background tasks are the subagent calls of the thread (`lib/subagents.ts`),
  and the dot on the right of a row says how the task is going. Clicking a row
  opens that task's `SubagentConversation` on the Subagents page. The shell
  keeps only its session key and task id; the detail reads the current thread,
  so status and output keep updating while it is open;
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
the name is typed and a picked file leaves its path in the message. The search
walks the project in the main process (`fs:search`), and it matches the path,
not only the name — the separators are normalised, so `src/renderer` finds the
folder on Windows as well.

The Files tab has a Text mode backed by `fs:searchText`: the same walk and skip
policy as `fs:search`, literal case-insensitive matching, binary and files over
512 KB skipped, at most 3 hits per file and 200 in total. Preview offsets
(`matchStart`/`matchLength`) are relative to the one-line preview, not the file
line; the viewer scrolls to `line`.

The sidebar's conversation search remembers the last eight queries that produced a
hit (`pi-desktop.session-search.history`) and shows them while the field is empty
and focused; picking one just fills the field, which runs the normal debounced
search. Queries with no hits are not remembered.

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

The shell follows the `terminalShell` setting: PowerShell (default), CMD,
Git Bash or WSL. Adding a shell means adding it in `resolveShellSpec`
(`src/main/shell.ts`) and in the Settings select.

A card in the transcript (the bash tool card, or a bash execution card) can hand
its command to the terminal by dispatching `pi:terminal-run` with `{ command }`.
`App` owns the terminal, so it turns the event into a `{ command, seq }` request
that `TerminalPanel` types into the live shell.

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

The branch menu keeps a **visible worktree button** of its own, beside
"Create and checkout branch". It opens an inline form that adds a worktree on a
new branch and switches the app to it; a "Worktrees" section lists the other
checkouts, and each non-current row can be removed after a confirmation. Do
**not** fold this action into the branch-creation form as a checkbox: it was
removed twice that way (v0.3.0 and the "refine the branch menu" commit), and a
hidden toggle leaves no obvious way to ask for an isolated checkout.
`tests/branch-menu-worktree.test.ts` guards the button.

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
- Keep the API limited to listing registered projects and their conversations,
  reading a conversation, and sending a prompt. Do not expose the preload bridge,
  arbitrary Pi RPC, terminal, filesystem, Git, provider or settings operations.
  Prompts still use the session's configured Pi permissions.
- Live updates come from `SessionSupervisor` events. The mobile renderer reuses
  `lib/stream-events.ts` and `lib/thread.ts`; do not add a second protocol reducer.
- Keep host checks, same-origin checks, one-use pairing, device revocation and
  path redaction in the main process. A depth cap must omit nested content,
  never pass raw values through. Never put a bearer token in a URL.
- `npm run dev` watches the separate mobile bundle alongside Electron;
  `npm run build` includes it in the packaged output.

## Memory

`src/main/memory/` owns persistent memory: a background extractor, a
file-backed store under `<userData>/memories/`, and the appended system-prompt
block. `MemoryService` only listens to `agent_settled`, waits for an idle
delay, skips aborted, draft, running and external-context sessions, and
serializes model calls. The Pi extension persists external-context checks on
the active branch; an oversized session without a complete check is skipped
until Pi opens and classifies it, unless that filter is disabled.
`memories.json` is canonical; `memory_summary.md` and
`rollout_summaries/` are projections. Never inject the raw entries file — the
prompt gets a project-scoped, 10,000-byte summary plus the decision-boundary
header in `MemoryService.promptFor`. Extraction runs in a throwaway
`pi --print --no-session --no-tools --no-extensions --no-skills --no-mcp
--no-context-files` process; memory text is data, never instructions, and
secrets are redacted before storage and again at merge time. The settings page
is `MemorySettings.tsx`; tests are `tests/memory.test.ts`. See
[docs/memory-system.md](docs/memory-system.md).

## Task modes

Task modes are a bundled Pi extension (`src/main/pi/task-modes.ts`), not renderer
state. The extension persists mode and goal in custom session entries, changes
the active tool loadout and publishes the mode on `pi-desktop-mode` and the goal
on `pi-desktop-goal` (JSON `{text,status,summary}`). `GoalBar` only projects that
status and sends `/desktop-goal pause|resume|clear|edit` back through the store.

Plan Mode is read-only: `read`, `grep`, `find`, `ls` plus `exit_plan_mode`. The
plan tool asks for approval through Pi's dialog protocol; approving restores the
previous tool loadout. Its `tool_call` is exempt from the generic permission
gate because that dialog is already the approval. The `subagent` tool is in the
normal, Goal and Subagent loadouts (and blocked in Plan Mode); Subagent Mode adds
the delegation-first instruction. `desktop_todo` is in the normal, Goal,
Subagent and Plugin loadouts (not Plan Mode): it records the agent's checklist
in the session and its `tool_call` is exempt from the permission gate because it
is bookkeeping for the progress rail. Plugin Mode keeps the normal working
loadout and adds an instruction to author a Pi extension — global
`~/.pi/agent/extensions/` or project `.pi/extensions/`, a load check with a
throwaway `pi -e`, and a report of the path. `src/main/pi/subagent.ts` generates the
per-process extension that spawns a separate `pi --mode rpc` process per task,
loads the child's permission extension, and routes its approval requests through
the parent conversation's live permission dialog. It reads Pi's JSONL with
`StringDecoder` (never `readline`) and returns the child's final text and usage.

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
*default of the fold that `ProcessTrail` already computes* (`manualOpen ?? !autoFold`) —
it ships on, because a settled trail is folded today. The second only gathers a *live*
stretch of calls into the summary line, opening to the same `ToolCard` rows. Neither adds
a store field, neither touches `lib/thread.ts`, and neither may change the rule that a tool
call is one node keyed by `toolCallId` at its first-appearance position.

`pasteMentions` writes the pasted picture **into the working folder** (`fs:savePastedImage`,
`projectlessRoot()` when there is no project) before referencing it, because an `@` mention
resolves against Pi's cwd and `fs:search` walks the project: a temp path would reference a
file the agent cannot read. It inserts through the same splice as a hand-picked mention and
degrades to attach-only when the write fails.

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
- The four text sizes live in `src/shared/font-scale.ts` (12/14/15/16 against
  the 14px body). Stored legacy multipliers are normalized there; use that
  module instead of re-deriving the ratios in a component.
- A control that cannot fit its own label in one line — the narrow docked panel
  is where this happens — drops the label and keeps the icon: `.icon-btn` with
  the same words in `title` and `aria-label`, so the tooltip explains what the
  icon does. Do not solve the wrap by shrinking the font or abbreviating the
  wording.
- Prefer small, focused components. Keep protocol knowledge out of the React tree.
- Comments explain *why*, not *what*.

## Screenshot harness

The main process can capture itself for visual checks. It only activates when the
environment variable is set:

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
