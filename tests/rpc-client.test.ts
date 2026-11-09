import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { MAX_RPC_RECORD_BYTES, PiRpcClient } from '../src/main/pi/rpc-client'

const echo = String.raw`
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const command = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (command.type === 'wait') continue;
    const line = JSON.stringify({ type: 'response', id: command.id, success: true, data: command.value }) + '\r\n';
    const bytes = Buffer.from(line);
    setTimeout(() => {
      for (const byte of bytes) process.stdout.write(Buffer.from([byte]));
    }, command.delay || 0);
  }
});`

function clientFor(code = echo): PiRpcClient {
  const client = new PiRpcClient({ command: process.execPath, args: ['-e', code], cwd: process.cwd() })
  client.on('error', () => {})
  client.start()
  return client
}

test('RPC preserves fragmented UTF-8, Unicode line separators and out-of-order responses', async () => {
  const client = clientFor()
  try {
    const text = 'first\u2028second\u2029中文'
    const slow = client.request({ type: 'echo', value: text, delay: 40 })
    const fast = client.request({ type: 'echo', value: 'fast' })
    assert.equal(await fast, 'fast')
    assert.equal(await slow, text)
  } finally {
    await client.stop()
  }
})

test('RPC joins a fragmented record once after buffering its chunks', () => {
  const client = new PiRpcClient({ command: process.execPath, args: [], cwd: process.cwd() })
  const message = 'x'.repeat(256 * 1024)
  const line = Buffer.from(`${JSON.stringify({ type: 'test', message })}\n`)
  const originalConcat = Buffer.concat
  let concatCalls = 0
  let received: unknown
  const consume = (client as any).consume.bind(client) as (chunk: Buffer) => void
  client.on('event', (event) => { received = event })
  Buffer.concat = function (...args: Parameters<typeof Buffer.concat>): Buffer {
    concatCalls += 1
    return originalConcat.apply(Buffer, args)
  }
  try {
    for (let offset = 0; offset < line.length - 1; offset += 1024) {
      consume(line.subarray(offset, Math.min(offset + 1024, line.length - 1)))
    }
    assert.ok((client as any).bufferedChunks.length <= 4)
    consume(line.subarray(line.length - 1))
  } finally {
    Buffer.concat = originalConcat
  }
  assert.equal(concatCalls, 1)
  assert.deepEqual(received, { type: 'test', message })
})

test('RPC drops an oversized record without retaining the rest of its bytes', () => {
  const client = new PiRpcClient({ command: process.execPath, args: [], cwd: process.cwd() })
  const consume = (client as any).consume.bind(client) as (chunk: Buffer) => void
  const errors: string[] = []
  let received: unknown
  client.on('protocol-error', ({ line }: { line: string }) => errors.push(line))
  client.on('event', (event) => { received = event })

  consume(Buffer.alloc(MAX_RPC_RECORD_BYTES + 1))
  assert.equal((client as any).bufferedBytes, 0)
  assert.equal((client as any).discardingOversizedRecord, true)

  consume(Buffer.from(`\n${JSON.stringify({ type: 'after_oversized_record' })}\n`))
  assert.equal(errors.length, 1)
  assert.deepEqual(received, { type: 'after_oversized_record' })
  assert.equal((client as any).discardingOversizedRecord, false)
})

test('a failed spawn cannot report a running transport', async () => {
  const client = new PiRpcClient({ command: path.join(process.cwd(), 'missing-pi-executable'), args: [], cwd: process.cwd() })
  const failed = new Promise<void>((resolve) => { client.once('error', () => resolve()) })
  client.start()
  const request = assert.rejects(client.request({ type: 'get_state' }), /Failed to start|not running|exited/)
  await failed
  assert.equal(client.running, false)
  await request
  await client.stop()
})

test('stopping rejects commands with no deadline and closes the transport', async () => {
  const client = clientFor()
  await client.request({ type: 'echo', value: 'ready' })
  const waiting = assert.rejects(client.request({ type: 'wait' }, 0), /stop|exit/i)
  await client.stop()
  await waiting
  assert.equal(client.running, false)
  await assert.rejects(client.request({ type: 'echo' }), /not running/)
})

test('stop lets Pi finish its EOF cleanup before forcing termination', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-stop-'))
  const marker = path.join(dir, 'disposed')
  const client = clientFor(echo + `
    process.stdin.on('end', () => setTimeout(() => {
      require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'disposed');
    }, 80));`)
  try {
    await client.request({ type: 'echo', value: 'ready' })
    await client.stop()
    assert.equal(existsSync(marker), true, 'the process must finish disposing its session and tools')
  } finally {
    await client.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stopping Pi also terminates its child processes', async () => {
  const grandchild = 'setInterval(() => {}, 1000)'
  const parent = String.raw`
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });
    let buffer = '';
    process.stdin.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const command = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        process.stdout.write(JSON.stringify({ type: 'response', id: command.id, success: true, data: String(child.pid) }) + '\n');
      }
    });
    setInterval(() => {}, 1000);
  `
  const client = clientFor(parent)
  let childPid = 0
  try {
    childPid = Number(await client.request({ type: 'ready' }))
    assert.ok(Number.isInteger(childPid) && childPid > 0)
    await client.stop()
    let childStillRunning = true
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        process.kill(childPid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          childStillRunning = false
          break
        }
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(childStillRunning, false, 'the grandchild must exit before stop resolves')
  } finally {
    await client.stop()
    if (childPid) {
      try { process.kill(childPid, 'SIGKILL') } catch { /* the tree was already terminated */ }
    }
  }
})
