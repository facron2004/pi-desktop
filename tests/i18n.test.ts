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
