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

## Layout

| Path | Role |
|---|---|
| `src/main/` | Electron main process: window, IPC, settings, session index |
| `src/main/pi/` | Pi integration: CLI discovery, RPC client, runtime, one-shot CLI |
| `src/main/window-state.ts` | remembers the size and place of the window |
| `src/preload/` | `contextBridge` surface — the only renderer↔main channel |
| `src/renderer/` | React UI |
| `src/renderer/src/components/Launcher.tsx` | the palette over the app (`Ctrl+Shift+P`) |
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
second event switch inside a component.

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
  everything still moving into `aborted` at that moment.
- The run state lives in the store (`run`, `transport`), not in the thread:
  `runId` / `turnId` are minted by the client because Pi's protocol has
  neither, and `transport` is deliberately separate from the run phase —
  a lost connection is not a failed run.
- Text deltas are folded into the store immediately but **painted once per
  animation frame** (`scheduleItems` in `useAppStore.ts`). The store is the
  truth; the frame is the paint. `drainPending()` runs before anything that
  changes the conversation (session switch, new chat, settle) so a queued
  delta can never land in the wrong session.

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

Pi starts when a message is sent, not when a row is opened. `SessionSupervisor`
holds one process per hot conversation, and the same JSONL never has two
writers. A second prompt in the same working directory waits; it does not abort
the one already running. Switching projects is also only a view change. Closing
or removing a workspace is what stops that folder's processes.

The sidebar running mark reads `threads[file].isStreaming`. `stop()` aborts the
conversation on screen, not whichever one happens to be running in the
background.

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

## The session bar

`SessionBar` is the row under the composer, and it is the only place where the
conversation's settings live: the project (a menu of every known project, which
switches through `switchProject(..., { allowWhileRunning: true })` — the same
deliberate door the launcher uses), the branch and its dirty count
(`BranchMenu`), the reasoning effort, the model and the context ring
(`ContextRing`). While a run is going it also carries the steer/queue switch and
the stop link.

The title bar does not repeat any of it: it keeps the conversation's name and
the app's actions. A project or branch chip in two places is two things to keep
in sync, and the one in the header had no room to say what it was.

The context window is a ring (`ContextRing`), not a gauge icon and not a bar.
The arc length is the whole reading — the percentage of the window in use — and
it is drawn in one colour, the control's own foreground. Do not add a colour
scale: the length says how much, and the numbers stay in the `ContextPanel`
popover behind it, which reads Pi's `get_session_stats`.

## Starting the app

`bootstrap()` reopens the *project* that was active, never the conversation.
`lastSessions` is still written by `rememberSession` and still feeds the welcome
screen's "recent in this project" list, but only a click there opens a session —
a start is a new chat.

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
that grouping does not reorder the store's list or the keyboard cycle.

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

The terminal drawer is the client's own `bash` user: it sends the command with
an id prefixed `terminal-` and `excludeFromContext: true`. The store drops
`bash_execution_update` events with that prefix, and `itemsFromMessages` skips
`bashExecution` messages that carry `excludeFromContext` — so a command typed
into the terminal never appears in the conversation or in the model's context.

A card in the transcript (the bash tool card, or a bash execution card) can hand
its command to the drawer by dispatching `pi:terminal-run` with `{ command }`.
`App` owns the drawer, so it turns the event into a `{ command, seq }` request
that `TerminalPanel` runs through the same `submit()` path as a typed command —
do not add a second command runner.

Pi strips ANSI escape sequences from the bash output before it reaches the
client, so `parseAnsi` in `lib/ansi.ts` is a safety net for future colour
output, not something the current `bash` path exercises.

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

## MCP

`src/main/mcp.ts` reads `~/.pi/agent/mcp.json` and `<workspace>/.pi/mcp.json` and
merges them by server name the way Pi does: a project entry replaces the user entry
with the same name, and an entry without `command`/`url`/`type` overrides only
`enabled`/`exposure`/`toolExposure` while keeping the user server's command and env.
When project trust is off the project file is not loaded at all, and the dialog says
so. `env` and `headers` values are credentials: only the key names leave main, never
the values. The dialog is read-only and never connects to a server — connection state
is the runtime's business, and there is no RPC command for it.

## The plan strip

`PlanStrip` is a projection, not a feature of the protocol: `extractPlan` reads
markdown checklists out of the newest assistant message and returns `null` for
anything shorter than two entries. Collapse/dismiss are view preferences keyed
by the source message id, so a new plan starts collapsed. A transition to complete
collapses it once; a manual reopen is remembered, including after a restart.
The completion marker is a local view preference, not execution state. Do not add
store state for it — the thread is the source of truth. Its actions only hand the checklist
back: copy as `- [x]` markdown, insert the whole plan or a single step through
`insertIntoComposer`; the strip itself is never changed by them.

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
