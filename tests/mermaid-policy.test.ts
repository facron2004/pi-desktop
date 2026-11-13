import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { mermaidPolicyExtension } from '../src/main/pi/mermaid'
import { buildRpcArgs } from '../src/main/pi/rpc-args'

test('the mermaid policy extension is generated as loadable JavaScript', () => {
  const source = mermaidPolicyExtension()
  assert.match(source, /export default function registerMermaidPolicy/)
  assert.match(source, /PI MERMAID POLICY/)
  // The generated module must parse before Pi ever loads it.
  const directory = mkdtempSync(path.join(tmpdir(), 'pi-mermaid-policy-'))
  const file = path.join(directory, 'mermaid-policy.mjs')
  try {
    writeFileSync(file, source, 'utf8')
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the policy targets diagram prompts, including Chinese terms', () => {
  const source = mermaidPolicyExtension()
  const pattern = /const DIAGRAM_HINT = (\/.+\/i);/.exec(source)
  assert.ok(pattern, 'DIAGRAM_HINT regex is missing')
  const regex = new RegExp(pattern[1].slice(1, -2), 'i')
  for (const prompt of ['draw a swimlane for refunds', '帮我画一个退款流程图', 'make a gantt chart', '时序图怎么画']) {
    assert.equal(regex.test(prompt), true, prompt)
  }
  for (const prompt of ['fix this TypeScript error', 'review the pull request']) {
    assert.equal(regex.test(prompt), false, prompt)
  }
})

test('a runtime launch carries the mermaid policy extension', () => {
  const args = buildRpcArgs({ cwd: 'C:/project' }, false, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'mermaid.mjs')
  assert.deepEqual(args.slice(0, 4), ['--mode', 'rpc', '--extension', 'mermaid.mjs'])
})
