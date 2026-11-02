import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sanitizeArgs, sanitizeCommand, sanitizeUrl } from '../src/main/mcp'

// ===========================================================================
// Dimension 1: Adversarial Passwords with Special Characters in URLs
// ===========================================================================

test('sanitizeUrl: masks passwords with #, ?, &, !, :, @, %, and IPv6', () => {
  // Case 1.1: Password with digits and unencoded #
  const url1 = 'http://admin:123#xyz@host:8080/sse'
  const res1 = sanitizeUrl(url1)
  assert.equal(res1, 'http://admin:***@host:8080/sse')
  assert.ok(!res1?.includes('123#xyz'), 'Password 123#xyz leaked')

  // Case 1.2: Protocol-less with digits and unencoded #
  const url2 = 'admin:123#xyz@host:8080/sse'
  const res2 = sanitizeUrl(url2)
  assert.equal(res2, 'admin:***@host:8080/sse')
  assert.ok(!res2?.includes('123#xyz'), 'Password 123#xyz leaked')

  // Case 1.3: Complex special characters in password: p#s?s&w!o:r%d
  const url3 = 'http://user:p#s?s&w!o:r%d@host:8080/sse'
  const res3 = sanitizeUrl(url3)
  assert.equal(res3, 'http://user:***@host:8080/sse')
  assert.ok(!res3?.includes('p#s?s&w!o:r%d'), 'Password with special characters leaked')

  // Case 1.4: IPv6 literal host with password containing #
  const url4 = 'http://user:123#xyz@[::1]:8080/sse'
  const res4 = sanitizeUrl(url4)
  assert.equal(res4, 'http://user:***@[::1]:8080/sse')
  assert.ok(!res4?.includes('123#xyz'), 'Password 123#xyz leaked in IPv6 URL')

  // Case 1.5: Password with # and real fragment at the end
  const url5 = 'http://admin:123#xyz@host:8080/sse#realFragment'
  const res5 = sanitizeUrl(url5)
  assert.equal(res5, 'http://admin:***@host:8080/sse#realFragment')
  assert.ok(!res5?.includes('123#xyz'), 'Password 123#xyz leaked')
  assert.ok(res5?.endsWith('#realFragment'), 'Real fragment must be preserved')

  // Case 1.6: Password with #, query string, and real fragment
  const url6 = 'http://admin:123#xyz@host:8080/sse?query=val&token=secret#myFragment'
  const res6 = sanitizeUrl(url6)
  assert.equal(res6, 'http://admin:***@host:8080/sse?query=val&token=***#myFragment')
  assert.ok(!res6?.includes('123#xyz'), 'Password 123#xyz leaked')
  assert.ok(!res6?.includes('secret'), 'Sensitive token leaked')
  assert.ok(res6?.includes('query=val'), 'Safe query param preserved')
  assert.ok(res6?.endsWith('#myFragment'), 'Fragment preserved')

  // Case 1.7: Password containing multiple colons and @ signs
  const url7 = 'http://user:p@ss:w:o:r:d@host:8080/mcp'
  const res7 = sanitizeUrl(url7)
  assert.equal(res7, 'http://user:***@host:8080/mcp')
  assert.ok(!res7?.includes('p@ss:w:o:r:d'))

  // Case 1.8: Empty password with colon
  const url8 = 'http://admin:@host:8080/sse'
  const res8 = sanitizeUrl(url8)
  assert.equal(res8, 'http://admin:***@host:8080/sse')
})

// ===========================================================================
// Dimension 2: False-Positive Resistance
// ===========================================================================

test('sanitizeUrl: false-positive resistance for @ in paths, queries, and fragments', () => {
  // Case 2.1: @ in path (@alice)
  const fp1 = 'http://example.com/@alice'
  assert.equal(sanitizeUrl(fp1), fp1, '@ in path should not trigger basic auth masking')

  // Case 2.2: @ in query parameter value (?email=foo@bar.com)
  const fp2 = 'http://example.com/?email=foo@bar.com'
  assert.equal(sanitizeUrl(fp2), fp2, 'email query param with @ should not be corrupted')

  // Case 2.3: @ in hash fragment (#heading@section)
  const fp3 = 'http://example.com/#heading@section'
  assert.equal(sanitizeUrl(fp3), fp3, '@ in hash fragment should not be corrupted')

  // Case 2.4: Complex URL with scoped npm package in path, @ in query, and @ in fragment
  const fp4 = 'https://sub.domain.org/path/@org/package?tag=v1.0@beta#readme@usage'
  assert.equal(sanitizeUrl(fp4), fp4, 'complex path/query/fragment with @ should not be corrupted')

  // Case 2.5: URL with port and @ in path
  const fp5 = 'http://example.com:8080/api/users/@me/avatar'
  assert.equal(sanitizeUrl(fp5), fp5, 'port with @ in path should not be corrupted')

  // Case 2.6: Git commit URL with email query and diff fragment
  const fp6 = 'https://github.com/org/repo/commit/123456?author=user@test.com#diff-1'
  assert.equal(sanitizeUrl(fp6), fp6, 'author email in query should not be corrupted')

  // Case 2.7: Relative query string with email
  const fp7 = '?email=foo@bar.com'
  assert.equal(sanitizeUrl(fp7), fp7, 'relative email query string should not be corrupted')
})

// ===========================================================================
// Dimension 3: Adversarial Tests on sanitizeArgs and sanitizeCommand
// ===========================================================================

test('sanitizeArgs: masks flags, key=values, database URLs, and connection strings', () => {
  // Case 3.1: The primary test vector from dispatch
  const args1 = [
    '--token',
    'secret123',
    '--api-key=secret456',
    'postgresql://admin:secret789@localhost:5432/mydb'
  ]
  const res1 = sanitizeArgs(args1)
  assert.deepEqual(res1, [
    '--token',
    '***',
    '--api-key=***',
    'postgresql://admin:***@localhost:5432/mydb'
  ])

  // Case 3.2: Consecutive sensitive flags mixed with normal flags
  const args2 = [
    '--port',
    '8080',
    '--token',
    'tok_secret_a',
    '--password',
    'pwd_secret_b',
    '--verbose',
    'true',
    '--access-token=tok_secret_c',
    '--passwd=pwd_secret_d'
  ]
  const res2 = sanitizeArgs(args2)
  assert.deepEqual(res2, [
    '--port',
    '8080',
    '--token',
    '***',
    '--password',
    '***',
    '--verbose',
    'true',
    '--access-token=***',
    '--passwd=***'
  ])

  // Case 3.3: Database URLs with various protocols and special char passwords
  const args3 = [
    'mysql://root:secretPass123@127.0.0.1:3306/db',
    'mongodb://appuser:p#ssword@mongo.internal:27017/prod',
    'redis://default:authpass@redis-host:6379/0'
  ]
  const res3 = sanitizeArgs(args3)
  assert.deepEqual(res3, [
    'mysql://root:***@127.0.0.1:3306/db',
    'mongodb://appuser:***@mongo.internal:27017/prod',
    'redis://default:***@redis-host:6379/0'
  ])

  // Case 3.4: OLEDB/ODBC/SQLServer connection strings
  const args4 = [
    'Server=myServerAddress;Database=myDataBase;Uid=myUsername;Pwd=myPassword;',
    'Data Source=srv;Initial Catalog=db;User ID=u;Password=p;'
  ]
  const res4 = sanitizeArgs(args4)
  assert.deepEqual(res4, [
    'Server=myServerAddress;Database=myDataBase;Uid=myUsername;Pwd=***;',
    'Data Source=srv;Initial Catalog=db;User ID=u;Password=***;'
  ])

  // Case 3.5: Quoted arguments in args array
  const argsQuoted = ['--token', '"secret123"', '--api-key=\'secret456\'', 'Pwd="myPassword";']
  const resQuotedArgs = sanitizeArgs(argsQuoted)
  assert.deepEqual(resQuotedArgs, ['--token', '***', '--api-key=***', 'Pwd=***;'])

  // Case 3.6: Non-array or empty inputs
  assert.equal(sanitizeArgs(undefined), undefined)
  assert.equal(sanitizeArgs(null), undefined)
  assert.deepEqual(sanitizeArgs([]), [])
})

test('sanitizeCommand: masks embedded URLs, flags, and connection strings in command strings', () => {
  // Case 3.7: Command with postgresql URL and token flag
  const cmd1 =
    'npx -y @mcp/server-postgres postgresql://admin:secret789@localhost:5432/mydb --token=secret123'
  const res1 = sanitizeCommand(cmd1)
  assert.equal(
    res1,
    'npx -y @mcp/server-postgres postgresql://admin:***@localhost:5432/mydb --token=***'
  )

  // Case 3.8: Command with CLI flags and connection string
  const cmd2 =
    'uvx mcp-server --api-key=secret456 --port=8080 Pwd=secretPassword;'
  const res2 = sanitizeCommand(cmd2)
  assert.equal(res2, 'uvx mcp-server --api-key=*** --port=8080 Pwd=***;')

  // Case 3.9: Command with quoted embedded database URL
  const cmd3 =
    'npx -y @mcp/server-postgres "postgresql://admin:secret789@localhost:5432/mydb"'
  const res3 = sanitizeCommand(cmd3)
  assert.equal(
    res3,
    'npx -y @mcp/server-postgres "postgresql://admin:***@localhost:5432/mydb"'
  )

  // Case 3.10: Non-string or empty inputs
  assert.equal(sanitizeCommand(undefined), undefined)
  assert.equal(sanitizeCommand(null), undefined)
  assert.equal(sanitizeCommand(''), undefined)
})
