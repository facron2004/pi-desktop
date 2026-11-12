import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readAgentPresets } from '../src/main/pi/agents'

const base = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-test-'))
const globalDir = path.join(base, 'global-agents')
const workspace = path.join(base, 'workspace')
const projectDir = path.join(workspace, '.pi', 'agents')
mkdirSync(globalDir, { recursive: true })
mkdirSync(projectDir, { recursive: true })

after(() => {
  rmSync(base, { recursive: true, force: true })
})

function writeAgent(dir: string, file: string, body: string): void {
  writeFileSync(path.join(dir, file), body, 'utf8')
}

function presets(trusted: boolean): ReturnType<typeof readAgentPresets> {
  return readAgentPresets(workspace, trusted, globalDir)
}

test('parses flat frontmatter into a preset', () => {
  writeAgent(globalDir, 'scout.md', `---
name: scout
description: Explores a codebase area and reports structure and risks
model: magpie/workbuddy/glm-5.3-flash
thinking: low
tools: read, grep, find
timeoutMs: 300000
some-future-key: ignored
---
You are a scout. Report entry points, invariants and risks.
`)
  const found = presets(true)
  assert.equal(found.length, 1)
  const scout = found[0]!
  assert.equal(scout.name, 'scout')
  assert.equal(scout.description, 'Explores a codebase area and reports structure and risks')
  assert.equal(scout.model, 'magpie/workbuddy/glm-5.3-flash')
  assert.equal(scout.thinking, 'low')
  assert.deepEqual(scout.tools, ['read', 'grep', 'find'])
  assert.equal(scout.timeoutMs, 300000)
  assert.match(scout.prompt, /^You are a scout\./)
})

test('a preset without a description or with a bad name is skipped', () => {
  writeAgent(globalDir, 'no-description.md', `---
name: no-description
---
Body only.`)
  writeAgent(globalDir, 'bad-name.md', `---
name: Not A Slug
description: Bad name
---
Body.`)
  writeAgent(globalDir, 'missing-name.md', `---
description: No name at all
---
Body.`)
  const names = presets(true).map((preset) => preset.name)
  assert.ok(!names.includes('no-description'), 'a preset without a routing description must not load')
  assert.ok(!names.includes('not a slug'), 'a non-slug name must not load')
  assert.ok(!names.includes('missing-name'), 'a preset without a name must not load')
})

test('a file without flat scalar frontmatter is skipped, not misread', () => {
  writeAgent(globalDir, 'nested.md', `---
name: nested
description: Nested values are not supported
tools:
  - read
  - grep
---
Body.`)
  writeAgent(globalDir, 'no-frontmatter.md', `Just a body with no frontmatter at all.`)
  writeAgent(globalDir, 'unclosed.md', `---
name: unclosed
description: Never closed
Body.`)
  const names = presets(true).map((preset) => preset.name)
  assert.ok(!names.includes('nested'))
  assert.ok(!names.includes('no-frontmatter'))
  assert.ok(!names.includes('unclosed'))
})

test('project agents are only read while the project is trusted', () => {
  writeAgent(projectDir, 'reviewer.md', `---
name: reviewer
description: Reviews a diff for correctness
---
You are a reviewer.`)
  const untrusted = presets(false).map((preset) => preset.name)
  assert.ok(!untrusted.includes('reviewer'), 'an untrusted project must contribute no presets')
  const trusted = presets(true).map((preset) => preset.name)
  assert.ok(trusted.includes('reviewer'), 'a trusted project contributes its presets')
})

test('a project preset replaces the user preset with the same name', () => {
  writeAgent(globalDir, 'shared.md', `---
name: shared
description: Global copy
---
Global body.`)
  writeAgent(projectDir, 'shared.md', `---
name: shared
description: Project copy
---
Project body.`)
  const shared = presets(true).find((preset) => preset.name === 'shared')
  assert.equal(shared?.description, 'Project copy')
  assert.match(shared?.prompt ?? '', /Project body/)
})

test('a project agent file escaping the agents directory is rejected', async (t) => {
  const outside = path.join(base, 'outside')
  mkdirSync(outside, { recursive: true })
  writeAgent(outside, 'escaped.md', `---
name: escaped
description: Reached through a link
---
Escaped.`)
  const link = path.join(projectDir, 'escaped.md')
  try {
    symlinkSync(path.join(outside, 'escaped.md'), link, 'file')
  } catch (error) {
    t.skip('file symlinks are unavailable: ' + (error instanceof Error ? error.message : String(error)))
    return
  }
  const names = presets(true).map((preset) => preset.name)
  assert.ok(!names.includes('escaped'), 'a link out of the project agents directory must not load')
})

test('the agents directory itself escaping the workspace is rejected', async (t) => {
  const away = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-away-'))
  mkdirSync(away, { recursive: true })
  writeAgent(away, 'far.md', `---
name: far
description: Outside the workspace
---
Far.`)
  const otherWorkspace = path.join(base, 'other-workspace')
  mkdirSync(otherWorkspace, { recursive: true })
  const link = path.join(otherWorkspace, '.pi', 'agents')
  try {
    symlinkSync(away, link, 'junction')
  } catch (error) {
    t.skip('directory symlinks are unavailable: ' + (error instanceof Error ? error.message : String(error)))
    return
  }
  const found = readAgentPresets(otherWorkspace, true, globalDir)
  assert.ok(!found.some((preset) => preset.name === 'far'), 'a linked agents directory must not load')
})

test('bounds: oversized files are skipped and the combined roster is capped', () => {
  const cappedDir = path.join(base, 'capped-global')
  mkdirSync(cappedDir, { recursive: true })
  for (let index = 0; index < 20; index++) {
    writeAgent(cappedDir, `g${String(index).padStart(2, '0')}.md`, `---
name: g${index}
description: Global ${index}
---
Body.`)
  }
  writeAgent(cappedDir, 'huge.md', `---
name: huge
description: Oversized
---
${'x'.repeat(65 * 1024)}`)
  for (let index = 0; index < 20; index++) {
    writeAgent(projectDir, `p${String(index).padStart(2, '0')}.md`, `---
name: p${index}
description: Project ${index}
---
Body.`)
  }
  const found = readAgentPresets(workspace, true, cappedDir)
  assert.equal(found.length, 32, 'the combined roster is capped at 32 presets')
  assert.ok(!found.some((preset) => preset.name === 'huge'), 'an oversized file must be skipped')
  assert.ok(found.some((preset) => preset.name === 'p19'), 'the project side fills the cap')
  assert.equal(readdirSync(cappedDir).length, 21, 'the fixture wrote every file it meant to')
})

test('a duplicate name inside one directory keeps the first file in name order', () => {
  const dupDir = path.join(base, 'dup-global')
  mkdirSync(dupDir, { recursive: true })
  writeAgent(dupDir, 'a-first.md', `---
name: dup
description: First file
---
First.`)
  writeAgent(dupDir, 'b-second.md', `---
name: dup
description: Second file
---
Second.`)
  const dup = readAgentPresets(workspace, true, dupDir).find((preset) => preset.name === 'dup')
  assert.equal(dup?.description, 'First file', 'the result must not depend on directory enumeration order')
})
