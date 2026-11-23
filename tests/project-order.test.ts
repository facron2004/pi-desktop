import test from 'node:test'
import assert from 'node:assert/strict'
import { withNewProjectFirst } from '../src/shared/project-order'

/** The key rule settings uses: case, slashes and a trailing separator folded. */
const keyOf = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

test('a new folder takes the first row and the rest keep their order', () => {
  assert.deepEqual(withNewProjectFirst(['C:/a', 'C:/b'], 'C:/c', keyOf), ['C:/c', 'C:/a', 'C:/b'])
})

test('the first folder of an empty list is simply first', () => {
  assert.deepEqual(withNewProjectFirst([], 'C:/only', keyOf), ['C:/only'])
})

test('the same folder is never listed twice, however it is spelled', () => {
  assert.deepEqual(withNewProjectFirst(['c:\\a\\', 'C:/b'], 'C:/A', keyOf), ['C:/A', 'C:/b'])
  assert.deepEqual(withNewProjectFirst(['C:/a', 'C:/b'], 'C:/A/', keyOf), ['C:/A/', 'C:/b'])
})

test('a case-insensitive duplicate deeper in the list is removed too', () => {
  assert.deepEqual(
    withNewProjectFirst(['C:/a', 'C:/b', 'c:\\B'], 'C:/b', keyOf),
    ['C:/b', 'C:/a']
  )
})
