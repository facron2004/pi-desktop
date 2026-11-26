import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REMOTE_ACCESS_WARNING, translate } from '../src/renderer/src/lib/i18n'

test('remote access warning is translated with the full security notice', () => {
  assert.equal(
    translate(REMOTE_ACCESS_WARNING, 'zh-CN'),
    '请仅在可信 Wi-Fi 网络中使用。本地网络传输未加密；手机消息沿用 Pi Desktop 的智能体权限，需要批准时仍须在桌面端确认。'
  )
})

test('subagent token count omits the Chinese classifier', () => {
  assert.equal(translate('{value} tokens', 'zh-CN'), '{value} Token')
})

test('the thinking disclosure has a short Chinese label', () => {
  assert.equal(translate('Thinking content', 'zh-CN'), '思考内容')
})

test('dynamic toasts translate their template and keep the placeholder', () => {
  const templates: Array<[string, string]> = [
    ['Worktree created at {path}', '工作树已创建：{path}'],
    ['Could not open the new worktree ({message})', '无法打开新的工作树（{message}）'],
    ['Exported {file}', '已导出 {file}'],
    ['Could not open the exported file: {message}', '无法打开导出的文件：{message}'],
    ['Only {model} is available', '只有 {model} 可用'],
    ['Model: {model}', '模型：{model}'],
    ['Reasoning effort: {level}', '推理强度：{level}']
  ]
  for (const [key, expected] of templates) {
    assert.equal(translate(key, 'zh-CN'), expected)
    // The store fills the placeholder after translating, so it has to survive.
    const placeholder = /\{(\w+)\}/.exec(key)?.[1]
    assert.ok(placeholder, `${key} has no placeholder`)
    assert.equal(translate(key, 'zh-CN').replace(`{${placeholder}}`, 'VALUE').includes('VALUE'), true)
  }
})
