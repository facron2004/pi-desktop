import assert from 'node:assert/strict'
import { test } from 'node:test'
import { highlightCode, resolveHighlightLanguage } from '../src/renderer/src/lib/highlight'

test('resolveHighlightLanguage resolves PowerShell aliases, paths, and qualifiers safely', () => {
  const psInputs = [
    'ps1',
    'PS1',
    'powershell',
    'pwsh',
    'posh',
    'psm1',
    'psd1',
    'ps1xml',
    'powershell.exe',
    'pwsh.exe',
    '.ps1',
    'deploy.ps1',
    'scripts/deploy.ps1',
    'C:\\Scripts\\Deploy.PS1',
    'ps1:deploy.ps1',
    'file:scripts/deploy.ps1',
    'powershell{1,3}'
  ]
  for (const input of psInputs) {
    assert.equal(resolveHighlightLanguage(input), 'powershell', `expected powershell for ${input}`)
  }

  assert.equal(resolveHighlightLanguage('bat'), 'bat')
  assert.equal(resolveHighlightLanguage('cmd'), 'bat')
  assert.equal(resolveHighlightLanguage('cmd.exe'), 'bat')
  assert.equal(resolveHighlightLanguage('scripts\\build.bat'), 'bat')
  assert.equal(resolveHighlightLanguage('fish'), 'fish')
  assert.equal(resolveHighlightLanguage('nu'), 'nushell')
  assert.equal(resolveHighlightLanguage('Dockerfile.prod'), 'dockerfile')
  assert.equal(resolveHighlightLanguage('.env.local'), 'dotenv')
  assert.equal(resolveHighlightLanguage('Makefile'), 'makefile')

  // Prototype names and unknown Windows paths stay plain text.
  assert.equal(resolveHighlightLanguage('C:\\unknown\\notes.unknown'), null)
  assert.equal(resolveHighlightLanguage('constructor'), null)
  assert.equal(resolveHighlightLanguage('__proto__'), null)
  assert.equal(resolveHighlightLanguage('toString'), null)
  assert.equal(resolveHighlightLanguage('text'), null)
})

test('highlightCode tokenizes PowerShell and Batch snippets cleanly', async () => {
  const psScript = '\uFEFFparam([string]$Target = "prod")\r\nGet-ChildItem -Path $Target | Out-Null\r\n'
  const [fromTag, fromFile, fromPwsh, fromBat] = await Promise.all([
    highlightCode(psScript, 'ps1', true),
    highlightCode(psScript, 'deploy.ps1', true),
    highlightCode(psScript, 'pwsh', false),
    highlightCode('@echo off\r\nsetlocal\r\necho Hello %1\r\n', 'cmd', true)
  ])

  for (const html of [fromTag, fromFile, fromPwsh, fromBat]) {
    assert.match(html, /class="shiki/)
    assert.match(html, /style="color:#/)
  }
})
