import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionIndicator, isDotIndicator } from '../src/renderer/src/lib/session-indicator'
import {
  DEFAULT_PROJECT_ICON_COLOR,
  projectIconColor,
  projectIconEmoji,
  searchProjectIcons
} from '../src/renderer/src/lib/project-icons'
import { collectProjects } from '../src/renderer/src/lib/projects'

test('a waiting dialog outranks every other mark', () => {
  assert.equal(
    sessionIndicator({ isStreaming: true, notice: 'error', needsInput: true }),
    'needs-input'
  )
  assert.equal(sessionIndicator({ isStreaming: true, needsInput: true }), 'needs-input')
})

test('a failure outranks an unread mark', () => {
  assert.equal(sessionIndicator({ notice: 'error' }), 'error')
  assert.equal(sessionIndicator({ notice: 'unread' }), 'unread')
})

test('a running conversation with nothing to notice is running', () => {
  assert.equal(sessionIndicator({ isStreaming: true }), 'running')
  assert.equal(sessionIndicator({}), 'idle')
})

test('only a failure or an unread answer draws a dot', () => {
  assert.equal(isDotIndicator('error'), true)
  assert.equal(isDotIndicator('unread'), true)
  assert.equal(isDotIndicator('running'), false)
  assert.equal(isDotIndicator('needs-input'), false)
  assert.equal(isDotIndicator('idle'), false)
})

test('an unknown tint falls back to the neutral one', () => {
  assert.equal(projectIconColor(undefined), DEFAULT_PROJECT_ICON_COLOR)
  assert.equal(projectIconColor('chartreuse'), DEFAULT_PROJECT_ICON_COLOR)
  assert.equal(projectIconColor('blue'), 'blue')
})

test('only a single character can be worn as a project icon', () => {
  assert.equal(projectIconEmoji(undefined), undefined)
  assert.equal(projectIconEmoji('  '), undefined)
  assert.equal(projectIconEmoji('🚀'), '🚀')
  assert.equal(projectIconEmoji('🚀🎯'), undefined)
})

test('the emoji search finds an entry by its keywords, in either language', () => {
  const byEnglish = searchProjectIcons('code')
  assert.ok(byEnglish.length > 0, 'the laptop should be found by "code"')
  const byChinese = searchProjectIcons('编程')
  assert.ok(byChinese.length > 0, 'the laptop should be found by "编程"')
  assert.deepEqual(
    byEnglish.map((entry) => entry.emoji),
    byChinese.map((entry) => entry.emoji),
    'both languages should lead to the same emoji'
  )
})

test('a search with no hit returns nothing', () => {
  assert.deepEqual(searchProjectIcons('zzz-no-such-emoji'), [])
})

test('a project keeps the icon and the tint it was given', () => {
  const projects = collectProjects(
    [
      {
        id: 'ws-1',
        path: 'E:\\Program\\Pi Desktop',
        name: 'Pi Desktop',
        lastOpenedAt: 1000,
        icon: '🚀',
        iconColor: 'blue' as const
      }
    ],
    []
  )
  assert.equal(projects.length, 1)
  assert.equal(projects[0].icon, '🚀')
  assert.equal(projects[0].iconColor, 'blue')
})

test('a folder that is only known from disk wears no icon', () => {
  const projects = collectProjects(
    [],
    [
      {
        id: 'sess-1',
        file: 'sess-1.jsonl',
        cwd: 'E:\\Program\\Other',
        preview: 'hello',
        updatedAt: 2000,
        messageCount: 1
      }
    ]
  )
  assert.equal(projects.length, 1)
  assert.equal(projects[0].icon, undefined)
  assert.equal(projects[0].iconColor, undefined)
})
