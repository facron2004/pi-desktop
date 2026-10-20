# Pi Desktop

A native desktop GUI for the [Pi coding agent](https://github.com/earendil-works/pi) —
the same agent that powers the `pi` CLI, wrapped in a window that feels like Codex or
Claude Desktop.

![Pi Desktop](docs/shots/02-conversation.png)

*Real run: Pi reads a file, edits it, and the diff renders inline.*

## What it does

- **Chat with Pi in a real project folder.** Pick a workspace, and Pi runs there with
  your own permissions — reading files, running commands, editing code.
- **Streaming conversation.** Assistant text, reasoning ("thinking") blocks, tool calls
  and tool output all stream in live, with a caret marking the end of the reply. The
  reasoning opens itself while the model is still thinking and folds away when the
  answer arrives.
- **Tool cards with diffs.** Every tool call is a collapsible card. File edits render
  as a line diff, so you can see exactly what changed. Long stretches of untouched
  lines collapse into a single row you can open, a run of the same call folds into one
  card, and a command or a path can be handed back to the composer. The file a card
  read or wrote is shown as highlighted code with line numbers, and the output of a
  command or the result of a tool can be copied out with one click.
- **Code blocks that answer back.** A snippet gets a header with its language, a copy
  button and an "Ask" button that drops the snippet into the composer, ready for a
  question about it.
- **Images that open.** A picture in a message — yours or the model's — is a button:
  click it and the image fills the window, with its size, a Save button and Escape to
  close.
- **Git branch and review.** The top bar says which branch the open project is on,
  how far it is ahead or behind its upstream, and how many files are uncommitted.
  The Changes panel can review the whole working tree — every file git reports, with
  the lines it adds and removes — and commit it with a message, without leaving the
  app. Files can be staged and unstaged one by one or all at once from the Review tab;
  the commit dialog says how many are staged, commits only those unless "Include
  unstaged changes" is ticked, lists the recent commits (a subject can be reused as
  the message, and a hash copied), offers `feat`/`fix`/`docs`/… templates, and keeps
  a failed or cancelled message for the next attempt. A file's full patch — or the
  whole working tree's, or one hunk of a diff — can be copied for another tool, and a
  single hunk can be reverted on its own after a confirmation. A renamed file shows
  both of its paths (`old → new`) with the diff taken against the old content. Any
  commit in the history can be opened to read its file list and per-file diff without
  leaving the app. The branch chip opens the branch menu: switch a local branch,
  create a new one, or add a worktree on a new branch and open it as a project. A
  folder that is not a repository simply shows no branch.
- **Integrated terminal.** `Ctrl+`` opens a terminal under the conversation. Commands
  run in the project through Pi's own `bash` command, the output streams in as it
  arrives, and each block says its exit code and how long it took. The drawer can be
  dragged taller and keeps its height, `Ctrl+C` stops the running command, `↑`/`↓`
  recall history, and the output can be filtered, copied or cleared. A bash card in
  the transcript can hand its command to the terminal and run it again, which keeps
  the output out of the conversation. Terminal commands are kept out of the model's
  context.
- **Search the conversations.** The sidebar filter looks at titles and projects; type
  two characters and it also searches the text of every conversation on disk. Each hit
  says who said it and shows the sentence with the match marked; clicking one opens
  that conversation (and its project, if need be), scrolls the matching turn into view
  and flashes it, with the words marked and the in-thread search parked on them.
  Searches that found something are remembered, so the field offers them again while
  it is empty.
- **Search inside the files.** The Files tab has a **Text** mode: type a word and the
  project is searched line by line (binary and huge files are skipped), with the hits
  grouped by file, their line numbers, and the match marked. Clicking a hit opens the
  file at that line. The file viewer itself has in-file find (`Ctrl+F` inside it, with
  matches walked by Enter), a line-jump box, a word-wrap toggle and one-click copy of
  the path or the contents.
- **The session tree.** `Ctrl+Shift+T` (or `/tree`) shows how the conversation branches:
  every prompt, answer, command and summary in order, the path that is open marked and
  its tip labelled, splits marked where a branch begins. A filter narrows the tree to
  the rows that match (their ancestors stay visible), folds are remembered per
  conversation, and two arrows walk the branch tips. Any prompt in it can start a new
  branch — the fork opens a new conversation and puts the prompt back in the composer,
  ready to be rewritten.
- **Project inspector.** A docked panel with three tabs. **Changes** lists every file
  the agent edited or created in this session, with the line counts of each change;
  **Review** reads the git working tree instead, so edits made outside the app show up
  too — every file expands to its real diff, and a tracked file can be reverted to HEAD
  after a confirmation; **Files** is a project tree you can search by name and read in
  place, with syntax highlighting and line numbers. Diffs can be shown unified or side
  by side, the folded
  runs of unchanged lines can be opened all at once, and the panel can be dragged to any
  width. A line number in a diff opens the file at that line, so a change can be
  followed into the code around it. The list of changed files can be filtered, copied to
  the clipboard, or handed to the agent in one go — the file list lands in the composer,
  ready to be asked about. The sidebar and the panel keep the width they were given.
- **Extension dialogs.** When a Pi extension asks you a question — pick one, confirm,
  type a value, edit a block of text — the desktop app shows the dialog and answers Pi
  for you. Extensions can also push status lines, widgets and notifications.
- **Session history.** Pi persists every conversation to disk; the sidebar lists them
  per project, filters them, renames them and exports them as HTML. The empty state
  offers the last conversations of the project, so a run can be picked up again
  without walking through the sidebar. A conversation can be pinned, and pinned ones
  float to the top of the sidebar no matter which project they belong to. The app
  also reopens the conversation that was open last, so a restart does not lose the
  thread of the work.
- **Several projects at once.** The sidebar lists every project that was opened. Clicking
  one runs Pi there, `Ctrl+1` … `Ctrl+9` jump to the n-th project, and the title bar
  says which project the open conversation belongs to.
- **Branch from any prompt.** Every message you sent is a branch point. "Branch" opens a
  new conversation that keeps the earlier history and hands the prompt back to the
  composer, so you can try a different approach without losing the run-up. The copy
  button in the title bar duplicates the whole conversation instead.
- **Search the conversation.** `Ctrl+F` finds every mention of a word in the thread and
  walks through the hits. `Alt+↑` and `Alt+↓` walk the turns themselves, and a running
  turn counts its own seconds.
- **Command palette.** Type `/` in the composer to reach Pi's own commands — skills,
  prompt templates and extension commands — and the ones the desktop app adds:
  `/export`, `/duplicate`, `/branch`, `/compact`, `/copy`, `/changes`, `/files`, `/new`.
- **Files by name.** Type `@` in the composer and the files of the project are listed;
  the list narrows down as the name is typed, and picking one puts its path into the
  message. The path is the one Pi uses, so it means the same thing to the agent.
- **Everything within reach.** `Ctrl+Shift+P` opens a palette over the app: every action
  it has, every project it can open, the model and reasoning switches, the theme and
  the text size. It is one search away from anything, without touching the mouse.
- **Model and effort control.** Switch model and reasoning level mid-conversation.
  The model menu says what each choice costs per million tokens, how large its context
  window is, and whether it reasons and takes images; the reasoning menu explains what
  each effort level means. `Ctrl+P` and `Ctrl+T` walk through Pi's own list of models
  and reasoning levels, the way they do in Pi's terminal. The context meter in the top
  bar opens a session panel with the token breakdown, the cost so far and the message
  counts, and it can compact the context — with or without instructions for the
  summary. The same panel says how steering and follow-up messages are delivered.
- **Steering.** While Pi is working you can steer it ("stop and do this instead") or
  queue a follow-up for when it finishes.
- **The plan on screen.** When the agent writes a checklist, the app lifts it into a
  strip above the composer: how many steps are done, which one is current, and the
  whole list one click away. It is read from the conversation, so it needs no tool of
  its own — and a new plan opens again on its own. The plan can be copied as a
  markdown checklist, dropped into the composer whole, or picked apart step by step.
- **Retries you can see.** When a request fails with a transient error, Pi retries it on its
  own. The app says so — with the attempt, the reason and a button that stops the retry
  instead of waiting it out.
- **Keyboard-first.** `Ctrl+N` new chat, `Ctrl+B` sidebar, `Ctrl+K` focus the composer,
  `Ctrl+F` search the conversation, `Ctrl+1`…`Ctrl+9` switch project, `Ctrl+Shift+P`
  the palette, `` Ctrl+` `` the terminal, `Ctrl+Shift+T` the session tree,
  `Ctrl+P`/`Ctrl+T` the next model and reasoning level, `Alt+↑`/`Alt+↓` walk the turns,
  `↑` recalls earlier prompts, `Esc` stops a run. `Ctrl+/` lists every shortcut. The
  conversations in the sidebar are reachable with the keyboard, and everything that can
  be focused shows where the focus is. The app also follows the system's "reduce motion"
  setting.

## How it talks to Pi

Pi exposes an [RPC mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md):
the CLI is started as a long-lived child process and driven with JSON Lines over
stdin/stdout.

```
┌──────────────────┐   JSONL over stdio   ┌───────────────────────────┐
│  Pi Desktop      │ ───────────────────► │  pi --mode rpc            │
│  (Electron)      │ ◄─────────────────── │  (child process)          │
└──────────────────┘   responses+events   └───────────────────────────┘
```

The desktop app is a protocol client, not a re-implementation of the agent. That
means every Pi feature — providers, models, thinking levels, compaction, steering,
sessions, skills, prompt templates — works the same way it does in the terminal.

Pi can also ask the client for interaction through its
[extension UI protocol](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md).
`select`, `confirm`, `input` and `editor` pause the agent until the user answers, so
the app renders them as dialogs and replies with an `extension_ui_response` carrying
Pi's own request id. `notify`, `setStatus`, `setWidget`, `setTitle` and
`set_editor_text` are fire-and-forget and become a status strip, a widget above the
composer, a window title or a prefilled prompt.

The protocol implementation lives in [`src/main/pi/rpc-client.ts`](src/main/pi/rpc-client.ts).
It follows the framing rules from Pi's docs exactly:

- one JSON object per record, terminated by `\n`
- records are split on **LF only** — `U+2028`/`U+2029` are valid inside JSON strings,
  so Node's `readline` is deliberately not used
- an optional `\r` before the `\n` is stripped
- stdout carries protocol records only; stderr carries diagnostics
- stdin writes honour backpressure

Commands are correlated by `id`, and session events are folded into a normalised
thread model in [`src/renderer/src/lib/thread.ts`](src/renderer/src/lib/thread.ts).

Pi keeps a session as a tree: a conversation can branch, and a branch keeps the
history that came before it. The app drives that through `get_fork_messages` and
`fork`, so a prompt can become the start of a new conversation without the earlier
turns being lost.

## Requirements

- Windows, macOS or Linux
- Node.js 22.19+ (for development)
- A Pi provider login. Run `pi` once and use `/login`, or set an API key.

Pi itself is bundled as a dependency, so no separate install is required. If you
already have a Pi checkout, point **Settings → Pi CLI path** at it.

## Development

```bash
npm install
npm run dev        # run with hot reload
npm run build      # type-safe production build into out/
npm run typecheck  # tsc for main, preload and renderer
npm run icon       # regenerate build/icon.png
npm run dist       # package installers into release/
```

A protocol smoke test that spawns the bundled CLI and exercises the RPC commands:

```bash
node scripts/rpc-smoke.mjs "C:/path/to/project"
```

And one that checks the extension UI round trip — a temporary extension asks for every
kind of dialog, and the answers have to reach it:

```bash
node scripts/rpc-ui-smoke.mjs
```

Screenshots live in [`docs/shots/`](docs/shots): the welcome screen, a real
conversation with an inline diff, the light theme, the app mid-run, the terminal
drawer, the commit dialog, the search across conversations, the git review tab,
the plan strip, a jump from a search hit, the commit history, the model menu, the
image lightbox, git staging, a command handed to the terminal, the session tree,
a fork started from it, the project text search, the pre-commit checks, a renamed
file with a copied patch, the file viewer's find bar, the session-tree filter, an
opened commit, a copied hunk, the plan's actions, the branch menu with its worktrees,
a reverted hunk and the recent searches. The roadmap for the remaining Codex-style
work is in [`docs/codex-parity.md`](docs/codex-parity.md).

## Architecture

```
src/
├── main/                 Electron main process
│   ├── pi/
│   │   ├── locate.ts     finds the Pi CLI (bundled → custom → PATH)
│   │   ├── rpc-client.ts JSONL framing, command correlation, event fan-out
│   │   ├── runtime.ts    owns the Pi child process for the active workspace
│   │   └── cli.ts        one-shot CLI calls (version, auth check)
│   ├── ipc.ts            typed IPC surface
│   ├── sessions.ts       reads Pi's session files from ~/.pi/agent/sessions
│   ├── git.ts            branch, working tree and commits of the open project
│   ├── settings.ts       persisted app settings
│   └── screenshot.ts     dev-only window capture
├── preload/index.ts      contextBridge API (contextIsolation, no nodeIntegration)
├── shared/types.ts       protocol and domain types shared by all three layers
└── renderer/src/         React UI
    ├── components/       thread, tool cards, diffs, composer, launcher, terminal, panels
    ├── lib/thread.ts     Pi session event → UI thread reducer
    ├── lib/changes.ts    tool calls → changed-files review
    ├── lib/session-search.ts  debounced full-text search of the conversations
    ├── lib/session-tree.ts  get_tree → rows, active path, branch labels
    ├── lib/diff-fold.ts  line diff → folded, expandable diff rows
    ├── lib/projects.ts   registered projects + the conversations of each
    ├── lib/search.ts     in-conversation search
    ├── lib/highlight.ts  syntax highlighting, grammars loaded on demand
    └── store/            zustand store
```

### Security

- The renderer has no Node.js access: `contextIsolation: true`, `nodeIntegration: false`.
- The only bridge surface is the typed `window.pi` API in [`src/shared/types.ts`](src/shared/types.ts).
- Pi runs as a separate process with your own permissions, exactly like the CLI.

## Credits

Built on [Pi](https://github.com/earendil-works/pi) by Mario Zechner and contributors
(MIT). This GUI is an independent client of Pi's RPC protocol.

## License

MIT
