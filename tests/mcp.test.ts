import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readMcpConfig, sanitizeArgs, sanitizeCommand, sanitizeUrl } from '../src/main/mcp'

test('sanitizeUrl masks Basic Auth credentials in HTTP URLs', () => {
  const input = 'https://admin:superSecret123@mcp.internal.company.com/v1/sse'
  const sanitized = sanitizeUrl(input)
  assert.equal(sanitized, 'https://admin:***@mcp.internal.company.com/v1/sse')
})

test('sanitizeUrl masks sensitive query parameters in URLs', () => {
  const input = 'https://api.mcp.io/sse?token=sec_abc123&apiKey=ak_test_xyz&secret=s_999&key=k_111&safeParam=public_value'
  const sanitized = sanitizeUrl(input)
  assert.ok(sanitized)
  const url = new URL(sanitized)
  assert.equal(url.searchParams.get('token'), '***')
  assert.equal(url.searchParams.get('apiKey'), '***')
  assert.equal(url.searchParams.get('secret'), '***')
  assert.equal(url.searchParams.get('key'), '***')
  assert.equal(url.searchParams.get('safeParam'), 'public_value')
})

test('sanitizeUrl handles both Basic Auth and sensitive query tokens simultaneously', () => {
  const input = 'http://user:mypassword@localhost:8080/mcp?apiKey=sk_live_12345'
  const sanitized = sanitizeUrl(input)
  assert.equal(sanitized, 'http://user:***@localhost:8080/mcp?apiKey=***')
})

test('sanitizeUrl leaves URLs without credentials unmodified', () => {
  const input = 'https://mcp.github.com/events?scope=all'
  const sanitized = sanitizeUrl(input)
  assert.equal(sanitized, input)
})

test('sanitizeUrl returns undefined on undefined or empty input', () => {
  assert.equal(sanitizeUrl(undefined), undefined)
  assert.equal(sanitizeUrl(''), undefined)
})

test('sanitizeUrl masks Basic Auth passwords containing special characters (#, %, :, @, ?, &, !)', () => {
  // Passwords with #
  const hashPass = 'http://admin:123#xyz@host:8080/sse'
  assert.equal(sanitizeUrl(hashPass), 'http://admin:***@host:8080/sse')
  assert.ok(!sanitizeUrl(hashPass)?.includes('123#xyz'))

  // Passwords with % (e.g. percent-encoded #)
  const pctPass = 'http://admin:123%23xyz@host:8080/sse'
  assert.equal(sanitizeUrl(pctPass), 'http://admin:***@host:8080/sse')
  assert.ok(!sanitizeUrl(pctPass)?.includes('123%23xyz'))

  // Passwords with : and @
  const colAtPass = 'http://user:p@ss:word@host'
  assert.equal(sanitizeUrl(colAtPass), 'http://user:***@host/')
  assert.ok(!sanitizeUrl(colAtPass)?.includes('p@ss:word'))

  // Passwords with ?
  const qPass = 'http://user:pass?word@host:8080/sse'
  assert.equal(sanitizeUrl(qPass), 'http://user:***@host:8080/sse')
  assert.ok(!sanitizeUrl(qPass)?.includes('pass?word'))

  // Passwords with & and !
  const ampBangPass = 'http://user:pass!word&more@host:8080/sse'
  assert.equal(sanitizeUrl(ampBangPass), 'http://user:***@host:8080/sse')
  assert.ok(!sanitizeUrl(ampBangPass)?.includes('pass!word&more'))
})

test('sanitizeUrl handles protocol-less Basic Auth', () => {
  const noProtoHash = 'admin:123#xyz@host:8080/sse'
  assert.equal(sanitizeUrl(noProtoHash), 'admin:***@host:8080/sse')
  assert.ok(!sanitizeUrl(noProtoHash)?.includes('123#xyz'))

  const noProtoSimple = 'user:pass@localhost:8080'
  assert.equal(sanitizeUrl(noProtoSimple), 'user:***@localhost:8080')
  assert.ok(!sanitizeUrl(noProtoSimple)?.includes('pass'))

  const noProtoWithQuery = 'user:pass@localhost:8080/mcp?token=sec_abc123'
  assert.equal(sanitizeUrl(noProtoWithQuery), 'user:***@localhost:8080/mcp?token=***')
  assert.ok(!sanitizeUrl(noProtoWithQuery)?.includes('sec_abc123'))
})

test('sanitizeUrl handles IPv6 Basic Auth', () => {
  const ipv6WithHash = 'http://user:123#xyz@[::1]:8080/sse'
  assert.equal(sanitizeUrl(ipv6WithHash), 'http://user:***@[::1]:8080/sse')
  assert.ok(!sanitizeUrl(ipv6WithHash)?.includes('123#xyz'))

  const ipv6NoProto = 'user:pass@[::1]:8080'
  assert.equal(sanitizeUrl(ipv6NoProto), 'user:***@[::1]:8080')

  const ipv6Complex = 'http://user:complex!pass@[2001:db8::1]:9000/stream'
  assert.equal(sanitizeUrl(ipv6Complex), 'http://user:***@[2001:db8::1]:9000/stream')
})

test('sanitizeUrl ensures false positive immunity on safe URLs with @ and email query parameters', () => {
  const atPath = 'http://example.com/@alice'
  assert.equal(sanitizeUrl(atPath), 'http://example.com/@alice')

  const userMePath = 'http://example.com/users/@me'
  assert.equal(sanitizeUrl(userMePath), 'http://example.com/users/@me')

  const emailQuery = 'http://example.com/?email=foo@bar.com'
  assert.equal(sanitizeUrl(emailQuery), 'http://example.com/?email=foo@bar.com')

  const relativeEmailQuery = '?email=foo@bar.com'
  assert.equal(sanitizeUrl(relativeEmailQuery), '?email=foo@bar.com')

  const safeQueryWithAt = 'https://example.com/search?q=test@example.com&safe=true'
  assert.equal(sanitizeUrl(safeQueryWithAt), 'https://example.com/search?q=test@example.com&safe=true')
})

test('sanitizeArgs masks sensitive CLI flags, connection strings, and database URLs', () => {
  assert.equal(sanitizeArgs(undefined), undefined)
  assert.deepEqual(sanitizeArgs([]), [])

  // Flag followed by value
  const flagAndVal = ['--token', 'secret_token_123', '--port', '8080']
  assert.deepEqual(sanitizeArgs(flagAndVal), ['--token', '***', '--port', '8080'])

  // Key=value sensitive flags
  const keyValFlags = ['--api-key=sk_live_12345', '--github-token=ghp_secret', '--normal=hello']
  assert.deepEqual(sanitizeArgs(keyValFlags), ['--api-key=***', '--github-token=***', '--normal=hello'])

  // Embedded database URLs with basic auth
  const dbArgs = ['-y', '@mcp/server-postgres', 'postgresql://admin:superSecret@localhost:5432/mydb']
  assert.deepEqual(sanitizeArgs(dbArgs), [
    '-y',
    '@mcp/server-postgres',
    'postgresql://admin:***@localhost:5432/mydb'
  ])

  // Connection strings
  const connStrArgs = ['Server=myServerAddress;Database=myDataBase;Uid=myUsername;Pwd=myPassword;']
  assert.deepEqual(sanitizeArgs(connStrArgs), [
    'Server=myServerAddress;Database=myDataBase;Uid=myUsername;Pwd=***;'
  ])
})

test('sanitizeCommand masks embedded URLs and flags in command lines', () => {
  assert.equal(sanitizeCommand(undefined), undefined)

  const rawCmd1 = 'npx -y @mcp/server-postgres postgresql://admin:secret123@localhost:5432/mydb'
  assert.equal(
    sanitizeCommand(rawCmd1),
    'npx -y @mcp/server-postgres postgresql://admin:***@localhost:5432/mydb'
  )

  const rawCmd2 = 'uvx mcp-server --api-key=secretKey123 --port=8080'
  assert.equal(sanitizeCommand(rawCmd2), 'uvx mcp-server --api-key=*** --port=8080')
})

test('readMcpConfig sanitizes server URLs and STDIO args from project config', () => {
  const temp = realpathSync(os.tmpdir())
  const dir = mkdtempSync(path.join(temp, 'pi-desktop-mcp-test-'))
  try {
    const piDir = path.join(dir, '.pi')
    mkdirSync(piDir, { recursive: true })
    const configPath = path.join(piDir, 'mcp.json')
    const configData = {
      mcpServers: {
        secureServer: {
          url: 'https://operator:superpassword@mcp.example.com/stream?token=topsecret',
          type: 'http'
        },
        plainServer: {
          url: 'https://public.example.com/mcp',
          type: 'http'
        },
        stdioServer: {
          command: 'npx -y @mcp/server-postgres postgresql://admin:pass123@localhost:5432/mydb',
          args: ['--api-key', 'secret_key', '--port', '8080'],
          type: 'stdio'
        }
      }
    }
    writeFileSync(configPath, JSON.stringify(configData), 'utf8')

    const config = readMcpConfig(dir, true)
    assert.equal(config.projectExists, true)

    const secure = config.servers.find((s) => s.name === 'secureServer')
    assert.ok(secure)
    assert.equal(secure.url, 'https://operator:***@mcp.example.com/stream?token=***')

    const plain = config.servers.find((s) => s.name === 'plainServer')
    assert.ok(plain)
    assert.equal(plain.url, 'https://public.example.com/mcp')

    const stdio = config.servers.find((s) => s.name === 'stdioServer')
    assert.ok(stdio)
    assert.equal(
      stdio.command,
      'npx -y @mcp/server-postgres postgresql://admin:***@localhost:5432/mydb'
    )
    assert.deepEqual(stdio.args, ['--api-key', '***', '--port', '8080'])
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})
