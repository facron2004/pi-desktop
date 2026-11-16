import test from 'node:test'
import assert from 'node:assert/strict'
import {
  composerFileToken,
  extractFilePathMentions,
  fileNameFromPath,
  makeComposerFile,
  mergeComposerFiles
} from '../src/renderer/src/lib/composer-files'

test('an absolute path line becomes a file attachment, not visible text', () => {
  const result = extractFilePathMentions(
    '@"C:/Users/Facron/Downloads/AgentBench_Studio_%E5%BC%80%E5%8F%91%E9%9C%80%E6%B1%82.md"\n请阅读并总结'
  )
  assert.equal(result.text, '请阅读并总结')
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].name, 'AgentBench_Studio_开发需求.md')
  assert.equal(result.files[0].path, 'C:/Users/Facron/Downloads/AgentBench_Studio_%E5%BC%80%E5%8F%91%E9%9C%80%E6%B1%82.md')
})

test('a relative @ mention stays in the message', () => {
  const result = extractFilePathMentions('请检查 @src/main/ipc.ts 这段')
  assert.equal(result.files.length, 0)
  assert.equal(result.text, '请检查 @src/main/ipc.ts 这段')
})

test('the file token uses the absolute path Pi already understands', () => {
  const file = makeComposerFile('C:\\Users\\Facron\\Downloads\\需求.md')
  assert.equal(composerFileToken(file), '@"C:/Users/Facron/Downloads/需求.md"')
  assert.equal(file.name, '需求.md')
  assert.equal(fileNameFromPath('C:\\a\\b\\'), 'b')
})

test('adding the same path twice keeps one chip', () => {
  const first = makeComposerFile('C:/Users/Facron/a.md')
  const second = makeComposerFile('c:\\users\\facron\\A.MD')
  const merged = mergeComposerFiles([first], [second])
  assert.equal(merged.length, 1)
  assert.equal(merged[0], first)
})
