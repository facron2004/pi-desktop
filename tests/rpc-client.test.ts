import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { PiRpcClient } from '../src/main/pi/rpc-client'

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
