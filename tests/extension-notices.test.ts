import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMcpOrSkillChatter } from '../src/renderer/src/lib/extension-notices'

test('MCP startup notices stay out of the composer toast slot', () => {
  assert.equal(
    isMcpOrSkillChatter(
      'MCP: Project servers blocked: fuyao-a-share (blocked by project trust — trust the project to review and approve this server)'
    ),
    true
  )
  assert.equal(isMcpOrSkillChatter('MCP: 3/4 servers connected (12 tools)'), true)
  assert.equal(isMcpOrSkillChatter('🔌 MCP: server disabled'), true)
  assert.equal(isMcpOrSkillChatter('MCP tools are only reachable from the codemode tool'), true)
})

test('skill discovery and loading notices are treated as chatter', () => {
  assert.equal(isMcpOrSkillChatter('Loaded 12 skills'), true)
  assert.equal(isMcpOrSkillChatter('Skills: 4 available'), true)
  assert.equal(isMcpOrSkillChatter('3 skill bundles skipped'), true)
  assert.equal(isMcpOrSkillChatter('skill "review" failed to load'), true)
  assert.equal(isMcpOrSkillChatter('已加载 12 个技能'), true)
})

test('ordinary extension notifications still reach the reader', () => {
  assert.equal(isMcpOrSkillChatter('The provider rejected the request'), false)
  assert.equal(isMcpOrSkillChatter('Update downloaded. Restart Pi Desktop to apply.'), false)
  assert.equal(isMcpOrSkillChatter('The conversation was copied'), false)
  assert.equal(isMcpOrSkillChatter('   '), true)
})
