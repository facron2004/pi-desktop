import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  addProjectFolder,
  promoteProjectFolder,
  removeProjectFolder
} from '../src/renderer/src/lib/project-folders'

const root = path.resolve(process.cwd())
const dialog = readFileSync(
  path.join(root, 'src/renderer/src/components/EditProjectDialog.tsx'),
  'utf8'
)

test('a folder added after the primary one is appended, not made primary', () => {
  const primary = addProjectFolder([], 'E:\\Work\\Amazon')
  assert.deepEqual(primary, ['E:\\Work\\Amazon'])

  const withSecond = addProjectFolder(primary!, 'E:\\Work\\Amazon\\docs')
  assert.deepEqual(withSecond, ['E:\\Work\\Amazon', 'E:\\Work\\Amazon\\docs'])
  assert.equal(withSecond?.[0], 'E:\\Work\\Amazon', 'the main folder must stay first')
})

test('a folder already in the project is refused, whatever its spelling', () => {
  const folders = ['E:\\Work\\Amazon']
  assert.equal(addProjectFolder(folders, 'e:/work/amazon/'), null)
  assert.equal(addProjectFolder(folders, 'E:\\Work\\Amazon'), null)
  assert.deepEqual(folders, ['E:\\Work\\Amazon'], 'a refused folder must not mutate the list')
})

test('removing the primary folder promotes the next row', () => {
  assert.deepEqual(
    removeProjectFolder(['E:\\Work\\Amazon', 'E:\\Work\\Shared'], 'e:/work/amazon'),
    ['E:\\Work\\Shared']
  )
  assert.deepEqual(
    removeProjectFolder(['E:\\Work\\Amazon', 'E:\\Work\\Shared'], 'E:\\Work\\Other'),
    ['E:\\Work\\Amazon', 'E:\\Work\\Shared'],
    'removing a folder that is not there changes nothing'
  )
})

test('promoting a folder moves it to the front and keeps the rest in order', () => {
  assert.deepEqual(
    promoteProjectFolder(['E:\\Work\\Amazon', 'E:\\Work\\Shared', 'E:\\Work\\Docs'], 'e:/work/docs'),
    ['E:\\Work\\Docs', 'E:\\Work\\Amazon', 'E:\\Work\\Shared']
  )
  assert.deepEqual(
    promoteProjectFolder(['E:\\Work\\Amazon'], 'E:\\Work\\Other'),
    ['E:\\Work\\Amazon'],
    'an unknown folder cannot become primary'
  )
})

test('the add-folder row lives in the list and is rendered in every state', () => {
  const list = dialog.slice(dialog.indexOf('className="project-edit__folder-list"'))
  assert.ok(list.length > 0, 'the folder list moved; update this test')
  assert.match(list, /folders\.map/, 'the folder rows are not drawn in the list')
  assert.match(
    list,
    /className="project-edit__add-row"/,
    'the add-folder row is missing from the list'
  )
  // The first folder used to replace the whole empty state with a list that
  // had no add control, so the action disappeared exactly when a second
  // folder was needed.
  assert.doesNotMatch(dialog, /project-edit__empty/, 'the old empty state is back')
  assert.doesNotMatch(dialog, /folders\.length === 0 \?/, 'the add control is conditional again')
})
