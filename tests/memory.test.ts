import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  AgentMessage,
  AppSettings,
  MemoryEntry,
  MemoryKind,
  MemoryScope,
  SessionMeta
} from '../src/shared/types'
import {
  MAX_ENTRIES,
  MAX_ENTRY_CHARS,
  MAX_PROJECT_ENTRIES,
  MemoryStore,
  memoryPathKey,
  renderMemorySummary,
  type MemoryCandidate
} from '../src/main/memory/store'
import { containsSecret, redactSecrets } from '../src/main/memory/redact'
import { buildTranscript, parseMemoryResponse, shouldLearnFromSession } from '../src/main/memory/prompt'
import { extractFromSession } from '../src/main/memory/extract'
import { MemoryService } from '../src/main/memory/service'

const isWindows = process.platform === 'win32'
const alphaCwd = isWindows ? 'C:\\Work\\Alpha' : '/work/alpha'
const alphaCwdAlt = isWindows ? 'c:/work/alpha/' : '/work/alpha/'
const betaCwd = isWindows ? 'C:\\Work\\Beta' : '/work/beta'

function tempDir(t: TestContext, label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `pi-memory-${label}-`))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeEntry(input: {
  scope: MemoryScope
  kind: MemoryKind
  text: string
  projectPath?: string
  projectName?: string
  updatedAt?: number
}): MemoryEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2)}`,
    scope: input.scope,
    kind: input.kind,
    text: input.text,
    projectPath: input.projectPath,
    projectName: input.projectName,
    createdAt: input.updatedAt ?? 1_000,
    updatedAt: input.updatedAt ?? 1_000
  }
}

/** Distinct last tokens keep the near-duplicate check from folding the batch. */
function distinctCandidates(count: number, label: string, extra: Partial<MemoryCandidate> = {}): MemoryCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    scope: 'global' as MemoryScope,
    kind: 'knowledge' as MemoryKind,
    text: `Shared ${label} note token${index}unique for the memory store.`,
    ...extra
  }))
}

function longMessages(): AgentMessage[] {
  return [
    {
      role: 'user',
      content:
        'Please review the deployment scripts and explain how they work in detail, including every environment they touch.',
      timestamp: 1
    },
    {
      role: 'assistant',
      content:
        'The deployment scripts live in scripts/deploy and target the staging environment before production.',
      timestamp: 2
    },
    {
      role: 'user',
      content:
        'Thanks. Please also document the build commands and the test commands for the team in detail.',
      timestamp: 3
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'The build command is npm run build and the test command is npm test; both run from the repository root.'
        },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'package.json' } }
      ],
      timestamp: 4
    }
  ]
}

function writeSessionFile(file: string, cwd: string, id: string): void {
  const now = new Date().toISOString()
  const lines = [
    JSON.stringify({ type: 'session', id, timestamp: now, cwd }),
    JSON.stringify({
      type: 'message',
      id: `${id}-m1`,
      parentId: null,
      timestamp: now,
      message: { role: 'user', content: 'Hello from the test session.' }
    })
  ]
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
}

function metaFor(file: string, cwd: string, updatedAt: number, messageCount: number): SessionMeta {
  return {
    id: path.basename(file, '.jsonl'),
    file,
    cwd,
    preview: 'A conversation preview',
    updatedAt,
    messageCount
  }
}

/* ------------------------------------------------------------------ *
 * MemoryStore.merge
 * ------------------------------------------------------------------ */

test('merge adds entries, dedupes exact and near-duplicate text, and refreshes the timestamp', async (t) => {
  const store = new MemoryStore(tempDir(t, 'merge'))

  const first = store.merge([
    { scope: 'global', kind: 'preference', text: 'Always run the unit tests before committing changes.' },
    {
      scope: 'project',
      kind: 'knowledge',
      text: 'The build pipeline uses esbuild and lives in scripts/build.ts.',
      projectPath: alphaCwd
    }
  ])
  assert.equal(first.added, 2)
  assert.equal(first.total, 2)

  const before = store.readEntries()
  const preference = before.find((entry) => entry.kind === 'preference')
  assert.ok(preference)

  await delay(15)
  const second = store.merge([
    // Near duplicate: same sentence with one filler word dropped.
    { scope: 'global', kind: 'preference', text: 'Always run unit tests before committing changes' },
    // Exact duplicate.
    { scope: 'global', kind: 'preference', text: 'Always run the unit tests before committing changes.' }
  ])
  assert.equal(second.added, 0)
  assert.equal(second.total, 2)

  const after = store.readEntries()
  assert.equal(after.length, 2)
  const refreshed = after.find((entry) => entry.id === preference.id)
  assert.ok(refreshed)
  assert.ok(refreshed.updatedAt > preference.updatedAt)
  assert.equal(refreshed.createdAt, preference.createdAt)
})

/* ------------------------------------------------------------------ *
 * Summary rendering & project scoping
 * ------------------------------------------------------------------ */

test('renderMemorySummary includes global memories plus only the matching project', () => {
  const entries: MemoryEntry[] = [
    makeEntry({ scope: 'global', kind: 'preference', text: 'Prefer concise answers.' }),
    makeEntry({
      scope: 'project',
      kind: 'knowledge',
      text: 'Alpha project uses pnpm.',
      projectPath: alphaCwd,
      projectName: 'Alpha'
    }),
    makeEntry({
      scope: 'project',
      kind: 'knowledge',
      text: 'Beta project uses npm.',
      projectPath: betaCwd,
      projectName: 'Beta'
    })
  ]

  const scoped = renderMemorySummary(entries, { cwd: alphaCwdAlt })
  assert.match(scoped, /Prefer concise answers\./)
  assert.match(scoped, /Alpha project uses pnpm\./)
  assert.doesNotMatch(scoped, /Beta project uses npm\./)
  assert.equal(memoryPathKey(alphaCwdAlt), memoryPathKey(alphaCwd))

  const full = renderMemorySummary(entries)
  assert.match(full, /Alpha project uses pnpm\./)
  assert.match(full, /Beta project uses npm\./)
})

test('renderMemorySummary respects maxChars', () => {
  const entries = Array.from({ length: 8 }, (_, index) =>
    makeEntry({
      scope: 'global',
      kind: 'preference',
      text: `Memory entry ${index} carries enough detail to consume a meaningful part of the summary budget.`,
      updatedAt: index
    })
  )
  const summary = renderMemorySummary(entries, { maxChars: 220 })
  assert.ok(summary.length <= 220, `summary was ${summary.length} characters`)
  const bullets = summary.split('\n').filter((line) => line.startsWith('- '))
  assert.ok(bullets.length < entries.length)
})

test('renderMemorySummary caps CJK content by UTF-8 bytes', () => {
  const entries = Array.from({ length: 30 }, (_, index) =>
    makeEntry({
      scope: 'global',
      kind: 'preference',
      text: `记住第${index}条很长的中文记忆：这个项目的构建命令、发布目录和验证流程都必须保持一致。`,
      updatedAt: index
    })
  )
  const summary = renderMemorySummary(entries, { maxChars: 100_000, maxBytes: 1_000 })
  assert.ok(Buffer.byteLength(summary, 'utf8') <= 1_000, `summary was ${Buffer.byteLength(summary, 'utf8')} bytes`)
  assert.ok(summary.split('\n').filter((line) => line.startsWith('- ')).length < entries.length)
})

test('memoryPathKey strips the Windows extended path prefix', () => {
  if (!isWindows) return
  assert.equal(memoryPathKey('\\\\?\\C:\\Work\\Alpha'), memoryPathKey(alphaCwd))
})

/* ------------------------------------------------------------------ *
 * Entry cap & sanitisation
 * ------------------------------------------------------------------ */

test('merge sanitizes text: collapses whitespace, truncates and rejects tiny or unassigned candidates', (t) => {
  const store = new MemoryStore(tempDir(t, 'sanitize'))

  const result = store.merge([
    { scope: 'global', kind: 'knowledge', text: '  many   spaces\n and\tlines  ' },
    { scope: 'global', kind: 'knowledge', text: 'detail '.repeat(120) },
    { scope: 'global', kind: 'knowledge', text: 'short' },
    { scope: 'project', kind: 'knowledge', text: 'A project fact without a project path' },
    {
      scope: 'global',
      kind: 'knowledge',
      text: 'The API token is sk-abcdefghijklmnopqrstuvwxyz012345 and must stay secret'
    }
  ])

  assert.equal(result.added, 3)
  const entries = store.readEntries()
  assert.equal(entries.length, 3)
  assert.ok(entries.find((entry) => entry.text === 'many spaces and lines'))

  const truncated = entries.find((entry) => entry.text.startsWith('detail detail'))
  assert.ok(truncated)
  assert.equal(truncated.text.length, MAX_ENTRY_CHARS)

  const redacted = entries.find((entry) => entry.text.includes('[redacted-key]'))
  assert.ok(redacted)
  assert.doesNotMatch(redacted.text, /sk-abcdefghijklmnopqrstuvwxyz012345/)
})

test('merge enforces the MAX_ENTRIES cap', (t) => {
  const store = new MemoryStore(tempDir(t, 'cap-total'))
  const result = store.merge(distinctCandidates(MAX_ENTRIES + 12, 'global'))

  assert.equal(result.total, MAX_ENTRIES)
  assert.equal(store.readEntries().length, MAX_ENTRIES)
})

test('merge enforces the per-project cap without limiting other projects', (t) => {
  const store = new MemoryStore(tempDir(t, 'cap-project'))
  const alpha = distinctCandidates(MAX_PROJECT_ENTRIES + 8, 'project', {
    scope: 'project',
    projectPath: alphaCwd
  })
  const beta = distinctCandidates(12, 'beta', { scope: 'project', projectPath: betaCwd })
  store.merge([...alpha, ...beta])

  const entries = store.readEntries()
  const countFor = (cwd: string): number =>
    entries.filter((entry) => memoryPathKey(entry.projectPath) === memoryPathKey(cwd)).length
  assert.equal(countFor(alphaCwd), MAX_PROJECT_ENTRIES)
  assert.equal(countFor(betaCwd), 12)
  assert.equal(entries.length, MAX_PROJECT_ENTRIES + 12)
})

/* ------------------------------------------------------------------ *
 * Secret redaction
 * ------------------------------------------------------------------ */

test('redactSecrets removes provider keys, bearer tokens and assignments without touching prose', () => {
  const raw = [
    'OpenAI key sk-abcdefghijklmnopqrstuvwxyz0123456789',
    'GitHub token ghp_abcdefghijklmnopqrstuvwx',
    'AWS key AKIAIOSFODNN7EXAMPLE',
    'Slack token xoxb-123456789012-abcdefghij',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    'set password = "hunter2"',
    'api_key: supersecretvalue',
    'The build uses environment variables and the test suite stays green.'
  ].join('\n')

  const clean = redactSecrets(raw)
  assert.doesNotMatch(clean, /sk-abcdefghijklmnopqrstuvwxyz/)
  assert.doesNotMatch(clean, /ghp_abcdefghijklmnopqrstuvwx/)
  assert.doesNotMatch(clean, /AKIAIOSFODNN7EXAMPLE/)
  assert.doesNotMatch(clean, /xoxb-123456789012/)
  assert.doesNotMatch(clean, /Bearer\s+abcdefghijklmnopqrstuvwxyz/)
  assert.match(clean, /password = \[redacted\]/)
  assert.match(clean, /api_key: \[redacted\]/)
  assert.match(clean, /The build uses environment variables and the test suite stays green\./)

  assert.equal(containsSecret(raw), true)
  assert.equal(containsSecret('The build uses environment variables and the test suite stays green.'), false)
})

/* ------------------------------------------------------------------ *
 * Transcript building
 * ------------------------------------------------------------------ */

test('buildTranscript keeps user/assistant text and tool names but drops thinking and tool output', () => {
  const messages: AgentMessage[] = [
    { role: 'user', content: 'Please fix the failing build and explain the root cause.', timestamp: 1 },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'SECRET THOUGHT should not appear' },
        { type: 'text', text: 'The build failed because the lockfile was stale.' },
        { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'package.json' } },
        { type: 'toolCall', id: 'tool-2', name: 'bash', arguments: { command: 'npm ci' } },
        { type: 'text', text: 'I refreshed it.' }
      ],
      timestamp: 2
    },
    { role: 'toolResult', content: 'TOOL OUTPUT should not appear', timestamp: 3 },
    { role: 'user', content: 'Great, also add a regression test.', timestamp: 4 }
  ]

  const view = buildTranscript(messages)
  assert.equal(view.userTurns, 2)
  assert.match(view.text, /User: Please fix the failing build and explain the root cause\./)
  assert.match(
    view.text,
    /Assistant: The build failed because the lockfile was stale\. I refreshed it\. \[tools used: read, bash\]/
  )
  assert.doesNotMatch(view.text, /SECRET THOUGHT/)
  assert.doesNotMatch(view.text, /TOOL OUTPUT/)
  assert.doesNotMatch(view.text, /package\.json/)
  assert.equal(view.chars, view.text.length)
})

test('buildTranscript truncates a long transcript while keeping the opening request and the outcome', () => {
  const messages: AgentMessage[] = [
    { role: 'user', content: `Original request: ${'context '.repeat(400)}`, timestamp: 1 }
  ]
  const prose = 'alpha beta gamma delta epsilon zeta eta theta iota kappa '.repeat(70)
  for (let index = 0; index < 8; index += 1) {
    messages.push({
      role: 'assistant',
      content: `${prose} part${index} endmarker${index}`,
      timestamp: index + 2
    })
  }
  messages.push({ role: 'user', content: 'Final outcome: everything now works. end', timestamp: 100 })

  const view = buildTranscript(messages)
  assert.ok(view.chars <= 26_100, `transcript was ${view.chars} characters`)
  assert.match(view.text, /Original request:/)
  assert.match(view.text, /Final outcome: everything now works\. end/)
  assert.match(view.text, /…/)
})

test('shouldLearnFromSession accepts one long turn and rejects empty or trivial sessions', () => {
  const empty = buildTranscript([{ role: 'assistant', content: 'A'.repeat(400), timestamp: 1 }])
  assert.equal(empty.userTurns, 0)
  assert.deepEqual(shouldLearnFromSession(empty), { ok: false, reason: 'Conversation is too short' })

  const trivial = buildTranscript([{ role: 'user', content: 'Please fix the build.', timestamp: 1 }])
  assert.equal(trivial.userTurns, 1)
  assert.deepEqual(shouldLearnFromSession(trivial), {
    ok: false,
    reason: 'Conversation is too small to learn from'
  })

  const oneLongTurn = buildTranscript([
    { role: 'user', content: `Please refactor the build pipeline. ${'context '.repeat(60)}`, timestamp: 1 }
  ])
  assert.equal(oneLongTurn.userTurns, 1)
  assert.ok(oneLongTurn.chars >= 300)
  assert.deepEqual(shouldLearnFromSession(oneLongTurn), { ok: true })
})

/* ------------------------------------------------------------------ *
 * Model response parsing
 * ------------------------------------------------------------------ */

test('parseMemoryResponse accepts plain JSON, fenced JSON and JSON surrounded by prose', () => {
  const plain = parseMemoryResponse(
    '{"memories":[{"scope":"global","kind":"preference","text":"Prefer short answers."},{"scope":"project","kind":"knowledge","text":"Build with pnpm."}]}'
  )
  assert.deepEqual(plain, [
    { scope: 'global', kind: 'preference', text: 'Prefer short answers.' },
    { scope: 'project', kind: 'knowledge', text: 'Build with pnpm.' }
  ])

  const fenced = parseMemoryResponse(
    '```json\n{"memories":[{"scope":"global","kind":"failure","text":"Do not run npm install in this repo."}]}\n```'
  )
  assert.deepEqual(fenced, [
    { scope: 'global', kind: 'failure', text: 'Do not run npm install in this repo.' }
  ])

  const prose = parseMemoryResponse(
    'Here is the result:\n{"memories":[{"scope":"global","kind":"environment","text":"Node 22 is required."}]}\nDone.'
  )
  assert.deepEqual(prose, [{ scope: 'global', kind: 'environment', text: 'Node 22 is required.' }])
})

test('parseMemoryResponse falls back for unknown kinds/scopes and rejects invalid input', () => {
  assert.deepEqual(parseMemoryResponse('not json at all'), [])
  assert.deepEqual(parseMemoryResponse('{"memories":"nope"}'), [])

  const unknown = parseMemoryResponse(
    '{"memories":[{"scope":"weird","kind":"unexpected","text":"Unknown values become project knowledge."}]}'
  )
  assert.deepEqual(unknown, [
    { scope: 'project', kind: 'knowledge', text: 'Unknown values become project knowledge.' }
  ])

  const mixed = parseMemoryResponse(
    '{"memories":[{"text":"No scope or kind"},{"scope":"global","kind":"knowledge","text":"   "}]}'
  )
  assert.deepEqual(mixed, [{ scope: 'project', kind: 'knowledge', text: 'No scope or kind' }])
})

/* ------------------------------------------------------------------ *
 * Processed ledger, remove and clear
 * ------------------------------------------------------------------ */

test('ledger records only the same mtime and size revision, and keeps a skip reason', (t) => {
  const dir = tempDir(t, 'ledger')
  const store = new MemoryStore(dir)
  const file = path.join(dir, 'session.jsonl')
  writeFileSync(file, '{"type":"session","id":"s1"}\n', 'utf8')
  const original = statSync(file)

  assert.equal(store.wasProcessed(file), false)
  store.markProcessed(file, 'too-short')
  assert.equal(store.wasProcessed(file), true)
  assert.equal(store.wasProcessed(file, { mtimeMs: original.mtimeMs, size: original.size }), true)
  assert.equal(store.wasProcessed(file, { mtimeMs: original.mtimeMs + 1, size: original.size }), false)
  assert.equal(store.wasProcessed(file, { mtimeMs: original.mtimeMs, size: original.size + 1 }), false)
  assert.equal(store.sessionRecord(file)?.skipped, 'too-short')

  writeFileSync(file, '{"type":"session","id":"s1","changed":true}\n', 'utf8')
  assert.equal(store.wasProcessed(file), false)
  store.markProcessed(file)
  assert.equal(store.wasProcessed(file), true)
  assert.equal(store.sessionRecord(file)?.skipped, undefined)
})

test('remove deletes one entry and clear empties entries, ledger and rollout summaries', (t) => {
  const dir = tempDir(t, 'clear')
  const store = new MemoryStore(dir)
  store.merge([
    { scope: 'global', kind: 'preference', text: 'Prefer small focused commits.' },
    { scope: 'project', kind: 'knowledge', text: 'The release script is scripts/release.ts.', projectPath: alphaCwd }
  ])

  const [first] = store.readEntries()
  assert.ok(first)
  store.remove(first.id)
  assert.equal(store.readEntries().length, 1)

  const sessionFile = path.join(dir, 'session.jsonl')
  writeSessionFile(sessionFile, alphaCwd, 'clear-session')
  store.markProcessed(sessionFile, 'short')
  store.writeRolloutSummary(sessionFile, { cwd: alphaCwd, candidates: [] })
  assert.equal(readdirSync(store.rolloutDir).length, 1)

  store.clear()
  assert.deepEqual(store.readEntries(), [])
  assert.equal(readFileSync(store.summaryFile, 'utf8'), '')
  assert.deepEqual(store.readLedger().sessions, {})
  assert.deepEqual(readdirSync(store.rolloutDir), [])
})

/* ------------------------------------------------------------------ *
 * extractFromSession
 * ------------------------------------------------------------------ */

test('extractFromSession merges parsed memories with cwd and source metadata', async (t) => {
  const dir = tempDir(t, 'extract-happy')
  const store = new MemoryStore(path.join(dir, 'memories'))
  const sessionFile = path.join(dir, 'session-happy.jsonl')
  writeSessionFile(sessionFile, alphaCwd, 'happy')
  const messages = longMessages()
  let calls = 0

  const outcome = await extractFromSession(store, sessionFile, {
    deps: {
      readMessages: async () => messages,
      getMeta: async () => metaFor(sessionFile, alphaCwd, messages.length),
      run: async (args) => {
        calls += 1
        assert.match(args.prompt, /Working folder: /)
        assert.match(args.prompt, /Please review the deployment scripts/)
        return {
          code: 0,
          stdout: JSON.stringify({
            memories: [
              {
                scope: 'project',
                kind: 'knowledge',
                text: 'Deployment scripts live in scripts/deploy and target staging.'
              },
              {
                scope: 'global',
                kind: 'preference',
                text: 'Prefer direct explanations that include the exact command.'
              }
            ]
          }),
          stderr: ''
        }
      },
      userDataDir: path.join(dir, 'scratch')
    }
  })

  assert.equal(calls, 1)
  assert.equal(outcome.error, undefined)
  assert.equal(outcome.added, 2)

  const entries = store.readEntries()
  const projectEntry = entries.find((entry) => entry.scope === 'project')
  assert.ok(projectEntry)
  assert.equal(projectEntry.projectPath, path.resolve(alphaCwd))
  assert.equal(projectEntry.projectName, path.basename(alphaCwd))
  assert.equal(projectEntry.source, sessionFile)

  const globalEntry = entries.find((entry) => entry.scope === 'global')
  assert.ok(globalEntry)
  assert.equal(globalEntry.projectPath, undefined)
  assert.equal(globalEntry.source, sessionFile)
  assert.equal(readdirSync(store.rolloutDir).length, 1)
})

test('extractFromSession skips a trivial session without calling the model', async (t) => {
  const dir = tempDir(t, 'extract-short')
  const store = new MemoryStore(path.join(dir, 'memories'))
  const sessionFile = path.join(dir, 'session-short.jsonl')
  writeSessionFile(sessionFile, alphaCwd, 'short')
  let runCalls = 0

  const outcome = await extractFromSession(store, sessionFile, {
    deps: {
      readMessages: async () => [{ role: 'user', content: 'Please fix the build.', timestamp: 1 }],
      getMeta: async () => metaFor(sessionFile, alphaCwd, 1),
      run: async () => {
        runCalls += 1
        return { code: 0, stdout: '{"memories":[]}', stderr: '' }
      }
    }
  })

  assert.equal(runCalls, 0)
  assert.equal(outcome.added, 0)
  assert.equal(outcome.skipped, 'Conversation is too small to learn from')
})

test('extractFromSession returns the runner error when the model run fails', async (t) => {
  const dir = tempDir(t, 'extract-error')
  const store = new MemoryStore(path.join(dir, 'memories'))
  const sessionFile = path.join(dir, 'session-error.jsonl')
  writeSessionFile(sessionFile, alphaCwd, 'error')

  const outcome = await extractFromSession(store, sessionFile, {
    cwd: alphaCwd,
    deps: {
      readMessages: async () => longMessages(),
      getMeta: async () => metaFor(sessionFile, alphaCwd, 4),
      run: async () => ({ code: 1, stdout: '', stderr: 'model exploded' })
    }
  })

  assert.equal(outcome.added, 0)
  assert.equal(outcome.error, 'model exploded')
  assert.equal(store.readEntries().length, 0)
})

/* ------------------------------------------------------------------ *
 * MemoryService
 * ------------------------------------------------------------------ */

test('MemoryService.generate scans recent sessions and serializes extraction', async (t) => {
  const dir = tempDir(t, 'service-scan')
  const store = new MemoryStore(path.join(dir, 'memories'))
  const files = [0, 1, 2, 3, 4].map((index) => path.join(dir, `session-${index}.jsonl`))
  files.forEach((file, index) => writeSessionFile(file, alphaCwd, `scan-${index}`))

  const sessions: SessionMeta[] = [
    metaFor(files[0]!, alphaCwd, 100, 3),
    metaFor(files[1]!, alphaCwd, 200, 2),
    metaFor(files[2]!, alphaCwd, 300, 5),
    metaFor(files[3]!, alphaCwd, 400, 4),
    metaFor(files[4]!, alphaCwd, 500, 1),
    metaFor('draft:abc', alphaCwd, 600, 3)
  ]

  let active = 0
  let maxActive = 0
  const calls: string[] = []
  const extract: typeof extractFromSession = async (_store, file) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    calls.push(file)
    await delay(15)
    active -= 1
    return { added: 1 }
  }

  const service = new MemoryService(store, () => ({ memoriesEnabled: true } as AppSettings), {
    extract,
    list: async () => sessions,
    settleDelayMs: 5
  })

  const [first, second] = await Promise.all([service.generate({ limit: 3 }), service.generate({ limit: 3 })])
  assert.equal(first.ok, true)
  assert.equal(first.added, 3)
  assert.equal(second.ok, true)
  assert.equal(second.added, 3)

  assert.equal(maxActive, 1, 'extractions from concurrent generate calls must not overlap')
  assert.equal(calls.length, 6)
  for (const file of [files[1]!, files[2]!, files[3]!]) {
    assert.equal(calls.filter((called) => called === file).length, 2)
  }
  assert.equal(calls.includes(files[0]!), false)
  assert.equal(calls.includes(files[4]!), false)

  const state = await service.state()
  assert.equal(state.pending, 0)
  assert.equal(state.generating, false)
})

test('MemoryService.generate({ sessionFile }) bypasses the processed ledger guard', async (t) => {
  const dir = tempDir(t, 'service-session')
  const store = new MemoryStore(path.join(dir, 'memories'))
  const sessionFile = path.join(dir, 'session.jsonl')
  writeSessionFile(sessionFile, alphaCwd, 'single')
  store.markProcessed(sessionFile, 'short')
  assert.equal(store.wasProcessed(sessionFile), true)

  let calls = 0
  let seenCwd: string | undefined
  const extract: typeof extractFromSession = async (_store, _file, options) => {
    calls += 1
    seenCwd = options?.cwd
    return { added: 1 }
  }

  const service = new MemoryService(store, () => ({ memoriesEnabled: true } as AppSettings), {
    extract,
    settleDelayMs: 5
  })

  const first = await service.generate({ sessionFile })
  const second = await service.generate({ sessionFile })
  assert.equal(first.ok, true)
  assert.equal(first.added, 1)
  assert.equal(second.added, 1)
  assert.equal(calls, 2)
  assert.equal(seenCwd, alphaCwd)
})

test('MemoryService.clear resets entries, ledger, rollout summaries and status', async (t) => {
  const dir = tempDir(t, 'service-clear')
  const store = new MemoryStore(path.join(dir, 'memories'))
  store.merge([
    { scope: 'global', kind: 'preference', text: 'Prefer small focused commits.' },
    { scope: 'project', kind: 'knowledge', text: 'The release script is scripts/release.ts.', projectPath: alphaCwd }
  ])
  const sessionFile = path.join(dir, 'session.jsonl')
  writeSessionFile(sessionFile, alphaCwd, 'service-clear')
  store.markProcessed(sessionFile, 'short')
  store.writeRolloutSummary(sessionFile, { cwd: alphaCwd, candidates: [] })

  const service = new MemoryService(store, () => ({ memoriesEnabled: true } as AppSettings), {
    settleDelayMs: 5
  })
  const state = service.clear()

  assert.deepEqual(state.entries, [])
  assert.equal(state.summary, '')
  assert.equal(state.pending, 0)
  assert.equal(state.generating, false)
  assert.deepEqual(store.readLedger().sessions, {})
  assert.deepEqual(readdirSync(store.rolloutDir), [])
})
