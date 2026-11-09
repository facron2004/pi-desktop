# Memory

Pi Desktop remembers durable facts from finished conversations so a new session
starts with the user's working preferences and each project's hard-won
knowledge, without asking the user to maintain a long instruction file.

This follows the same idea as Codex memories: learn in the background, keep the
injected part small, and let the user review and delete what was learned.

## What was borrowed from Codex

Codex keeps memory in a local store under its home directory and separates two
layers: a compact `memory_summary.md` that is injected into new sessions, and
per-session `rollout_summaries/` that keep the detail on demand. Its newer v2
store moved from a large task-group `MEMORY.md` to a shorter, project-scoped
summary with pointers to those rollout summaries, and became deliberately
conservative about user preferences: only explicit preferences are recorded,
never inferred ones. Generation runs in the background after a chat has been
idle, skips short or still-active sessions, redacts secrets, and can be turned
off for chats that used external context (MCP, web search, computer use).

Pi Desktop adopts those principles without copying Codex's file format:

- **Two layers.** `memories.json` is the canonical list; `memory_summary.md`
  and `rollout_summaries/` are projections for review and for the prompt.
- **Project scope.** A memory is either global (applies in every project) or
  project (tied to one working folder). Injection only carries global memories
  plus the current project's memories.
- **Background extraction.** A settled conversation is learned from by a
  throwaway `pi --print` process; the live conversation is never touched.
- **Review and delete.** Settings → Memory lists every entry. Deleting an entry
  removes it from the next prompt as well as from the file.
- **Small prompt.** The injected summary is capped at 10,000 UTF-8 bytes (the
  same budget Codex uses). The detailed rollout summaries stay on disk and are
  not sent to the model.

## Storage

Everything lives under `<userData>/memories/`:

```
memories/
├── memories.json          canonical entries (id, scope, kind, text, source)
├── memory_summary.md      human-readable projection of all projects
├── state.json             which session revision was already considered
└── rollout_summaries/
    └── <session-id>.md    what one extraction found, plus the raw model output
```

`settings.json` keeps the switches:

| Field | Default | Meaning |
|---|---|---|
| `memoriesEnabled` | `true` | Inject stored memories into new Pi processes. |
| `memoryGeneration` | `true` | Learn from conversations after they settle. |
| `memorySkipExternalContext` | `true` | Do not learn from chats that used MCP, computer use, subagents or web tools. |
| `memoryModel` | empty | Model for extraction; empty uses the current model. |

A memory entry has one of four kinds — `preference`, `environment`,
`knowledge`, `failure` — and one of two scopes — `global`, `project`.

## Lifecycle

1. Pi emits `agent_settled`. `MemoryService` checks the settings, skips aborted
   runs, drafts and chats outside the external-context policy, then arms a
   per-session idle timer (20 seconds by default).
2. When the timer fires, the session file is stat'ed. If `state.json` already
   records the same `(mtime, size, filesystem identity)`, the conversation is
   not read again. Identity distinguishes a replacement file with unchanged
   size and timestamp.
3. All extractions are serialized. Each one reads the active branch, builds a
   compact transcript (user/assistant text plus tool names, no tool output),
   and runs a throwaway Pi process with `--print --no-session --no-tools
   --no-extensions --no-skills --no-mcp --no-context-files`.
4. The model returns JSON entries. Entries are redacted again in the main
   process, near-duplicates are merged, and caps are enforced (300 total, 80
   per project, 10,000 UTF-8 bytes for the injected summary). The per-session
   rollout summary is written.
5. The next `runtime:ensure` for that folder composes the user's custom
   instructions plus the project-scoped summary into one appended system
   prompt file.

A conversation that is still running is never learned from. A failed
extraction records the revision with an error and stays retryable from the
Settings page up to three attempts; a successful or deliberately skipped pass
records the revision so it is not repeated. On startup the service also offers the newest few
unprocessed conversations to the same queue, so a fresh profile can build
initial memory without a manual step.

## Privacy and trust boundaries

- Extracted entries are data, not instructions. The injected block says so
  explicitly: the current request wins and stale notes should be verified.
- Secrets are removed twice: the extraction prompt forbids them, and
  `redact.ts` strips common key shapes and `key = value` credentials before an
  entry is stored.
- Chats that used external context are skipped by default, so an MCP account,
  a browser page or a delegated subagent task cannot leak into a future prompt.
- The Pi extension persists a versioned classification after checking the
  active branch. An oversized session without a current check is skipped.
  Legacy local tool calls whose source was never recorded remain unverified
  even after reopening, because the current tool registration cannot prove
  which implementation ran then; they stay skipped unless filtering is off.
- Memory files stay in the app's user-data folder. Conversation text is sent to
  the selected model provider during extraction; existing stored memories are
  not included in that extraction request. During normal conversations, the
  relevant memory summary is included in the model prompt.
- Clearing memories also clears the learning ledger, so earlier conversations
  can be learned again on purpose.
