# Project: Pi Desktop Session I/O & Metadata Caching Optimization

## Architecture
Pi Desktop's Electron main process handles session discovery, reading, searching, and token usage calculation for Pi sessions stored at `~/.pi/agent/sessions/` (or configured custom directory). The current architecture suffers from 21 synchronous `node:fs` calls (`readdirSync`, `statSync`, `readFileSync`, `appendFileSync`), monolithic 24MB file reads with `split('\n')` creating V8 heap pressure and GC freezes, untargeted $O(N)$ directory scans across all 27+ workspaces, and zero caching.

The optimized architecture introduces:
1. **Targeted Workspace Directory Resolution**: When `cwd` is supplied, uses deterministic `--<path>--` directory encoding to directly target only that workspace's session folder. Includes candidate resolution for Windows drive letter casing (`e:` vs `E:`), realpath/symlinks, and shallow root folder matching.
2. **Asynchronous Non-blocking JSONL Streamer**: Reads session files via Node stream chunks (64KB `highWaterMark`) with strict byte-level LF (`0x0A`) buffer scanning and trailing CR (`0x0D`) stripping, strictly complying with `AGENTS.md` (no `readline`, preserving `U+2028` and `U+2029`), and yielding to the Electron event loop.
3. **Incremental `(mtime, size)` Metadata Cache**: Uses a bounded in-memory cache keyed by canonical session file path. When `(mtimeMs, size)` matches, returns cached `SessionMeta` in <1ms without disk reading or parsing. Invalidates on append/mutation (`appendSessionName`), deletion (`sessions:remove`), or file changes. Includes in-flight Promise coalescing for concurrent requests.
4. **Non-blocking IPC & Supervisor Integration**: Updates `ipcMain.handle` calls for `sessions:list`, `sessions:search`, `sessions:hydrate`, `sessions:usageStats`, and `supervisor.rename`. Because Electron IPC handlers natively support async Promises and the renderer already awaits them, this preserves 100% backward compatibility.
5. **Quality & Test Harness**: Expands unit test coverage via `tests/sessions-targeted.test.ts` and `tests/sessions-cache.test.ts` integrated into `tests/run.mjs`, validating all caching, targeted isolation, and non-blocking performance while preserving 100% pass rate on all 149 existing tests.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Targeted Workspace Directory Resolution | Resolve `cwd` to `--<path>--` directory, eliminating unrelated workspace scanning | M1 | ORIGINAL_REQUEST §R3 |
| F2 | Windows Drive Casing & Path Normalization | Case-resilient path equivalence (`pathsEqual`) and drive flip resolution | M1 | Survey Explorer 2 |
| F3 | Non-blocking Async JSONL Streamer | Chunked 64KB LF scanner obeying AGENTS.md, preserving U+2028/U+2029 | M1 | ORIGINAL_REQUEST §R1 |
| F4 | Async Traversal & IPC Modernization | Convert `listSessions`, `searchSessions`, `getAggregatedUsage` to async Promises | M1 | ORIGINAL_REQUEST §R1, R4 |
| F5 | Incremental `(mtime, size)` Metadata Cache | Lightweight bounded cache with O(1) hit check and invalidation | M1 | ORIGINAL_REQUEST §R2 |
| F6 | Cache Invalidation & Concurrency Coalescing | Precise invalidation on `appendSessionName`/trash and in-flight Promise deduplication | M1 | ORIGINAL_REQUEST §R2, R4 |
| F7 | Unit Test Suite for Targeted Resolution | Automated tests verifying workspace directory targeting and drive casing | M2 | ORIGINAL_REQUEST §Acceptance |
| F8 | Unit Test Suite for Caching & Async Performance | Automated tests for cache hit/miss, invalidation, truncation, and non-blocking load | M2 | ORIGINAL_REQUEST §Acceptance |
| F9 | Full Regression & Quality Gates | `npm run typecheck` (0 errors), `npm test` (all tests pass), `npm run build` | M2 | ORIGINAL_REQUEST §Quality Gates |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Core Session Engine Optimization | Implement targeted workspace resolution, async JSONL streaming parser, incremental (mtime, size) cache, and IPC integration in `src/main/sessions.ts`, `src/main/ipc.ts`, `src/main/pi/supervisor.ts` | none | DONE |
| 2 | Comprehensive Test Suite & Quality Verification | Implement `tests/sessions-targeted.test.ts` and `tests/sessions-cache.test.ts`, register in `tests/run.mjs`, and verify all quality gates (`typecheck`, `test`, `build`) | M1 | DONE |

## Interface Contracts

### 1. `src/main/sessions.ts` Exported Functions
```typescript
export function encodeWorkspaceDir(cwd: string): string
export function pathsEqual(a: string, b: string): boolean
export function findWorkspaceSessionDir(sessionRoot: string, cwd: string): Promise<string | null>

export async function* readJsonlLines(file: string, maxBytes?: number): AsyncGenerator<string, void, void>

export interface SessionCacheEntry {
  mtime: number
  size: number
  meta: SessionMeta
}
export function clearSessionCache(): void
export function invalidateSessionCache(file?: string): void
export function getSessionCacheSize(): number

export async function getSessionMeta(file: string): Promise<SessionMeta | null>
export async function parseSession(file: string): Promise<SessionMeta | null>
export async function readSessionMessages(file: string): Promise<AgentMessage[]>
export async function appendSessionName(file: string, name: string): Promise<boolean>
export async function listSessions(cwd?: string): Promise<SessionMeta[]>
export async function searchSessions(query: string, limit?: number): Promise<SessionSearchHit[]>
export async function getAggregatedUsage(customRoot?: string): Promise<AggregatedUsageStats>
```

### 2. IPC Handlers in `src/main/ipc.ts`
```typescript
ipcMain.handle('sessions:list', async (_event, cwd?: string) => ...)
ipcMain.handle('sessions:hydrate', async (_event, file: string) => ...)
ipcMain.handle('sessions:rename', async (_event, file: string, name: string) => ...)
ipcMain.handle('sessions:search', async (_event, query: string, limit?: number) => ...)
ipcMain.handle('sessions:usageStats', async (_event, customDir?: string) => ...)
```

### 3. Supervisor in `src/main/pi/supervisor.ts`
```typescript
async rename(file: string, name: string): Promise<boolean> {
  // if running -> RPC set_session_name; else -> await appendSessionName(file, name)
}
```

## Code Layout
- `src/main/sessions.ts`: Core session resolution, streaming JSONL reader, metadata parsing, caching, targeted directory resolution, and usage aggregation.
- `src/main/ipc.ts`: Electron IPC handlers connecting renderer to async session APIs.
- `src/main/pi/supervisor.ts`: Session supervisor handling renaming and lifecycle.
- `tests/sessions-targeted.test.ts`: New unit tests for targeted workspace resolution, directory encoding, and drive-casing tolerance.
- `tests/sessions-cache.test.ts`: New unit tests for `(mtime, size)` caching, invalidation, truncation recovery, concurrency coalescing, and non-blocking performance.
- `tests/session-fixture.test.ts`: Updated to await async `readSessionMessages`.
- `tests/session-scope.test.ts`: Updated to await async `readSessionMessages` and `appendSessionName`.
- `tests/run.mjs`: Test runner registering the new test suites.
