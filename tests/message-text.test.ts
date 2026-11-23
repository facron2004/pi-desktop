import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripImageAnnotations } from '../src/renderer/src/lib/message-text'

const annotation =
  '[Image: original 2559x1527, displayed at 2000x1193. Multiply coordinates by 1.28 to map to original image.]'

test('the picture annotation Pi adds is dropped from the bubble', () => {
  assert.equal(stripImageAnnotations(`怎么导入sql文件\n${annotation}`), '怎么导入sql文件')
  assert.equal(stripImageAnnotations(`${annotation}\n怎么导入sql文件`), '怎么导入sql文件')
  assert.equal(stripImageAnnotations(`怎么导入sql文件\n\n${annotation}\n`), '怎么导入sql文件')
})

test('a prompt without the annotation is returned unchanged', () => {
  const text = '怎么导入sql文件\n\n第二段'
  assert.equal(stripImageAnnotations(text), text)
})

test('the bracket in ordinary text is not touched', () => {
  const text = '看看 [Image: 这行是我自己写的] 这段'
  assert.equal(stripImageAnnotations(text), text)
})

test('the removed line does not leave a blank gap behind', () => {
  assert.equal(
    stripImageAnnotations(`第一段\n\n${annotation}\n\n第二段`),
    '第一段\n\n第二段'
  )
})
