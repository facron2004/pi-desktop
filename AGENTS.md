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

## Layout

| Path | Role |
|---|---|
| `src/main/` | Electron main process: window, IPC, settings, session index |
| `src/main/pi/` | Pi integration: CLI discovery, RPC client, runtime, one-shot CLI |
| `src/preload/` | `contextBridge` surface — the only renderer↔main channel |
| `src/renderer/` | React UI |
| `src/shared/types.ts` | Protocol and domain types shared by every layer |
| `scripts/rpc-smoke.mjs` | Spawns the bundled CLI and exercises the RPC commands |

## Commands

```bash
npm run dev         # run with hot reload
npm run build       # production build into out/
npm run typecheck   # must pass before committing
npm run dist        # installers into release/
node scripts/rpc-smoke.mjs "C:/some/project"   # protocol smoke test
```

## Adding a Pi capability

1. Check the upstream docs first: `packages/coding-agent/docs/rpc-commands.md` for
   commands, `json.md` for events.
2. Add the command/event to the shared types.
3. Wire it through `src/main/ipc.ts` → `src/preload/index.ts` → the store.
4. If it changes the conversation, extend the reducer in
   `src/renderer/src/lib/thread.ts` — not the components.
5. Verify with `npm run typecheck` and a real run against the bundled CLI.

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

`PI_DESKTOP_THEME=light|dark|system` overrides the theme for the run.
