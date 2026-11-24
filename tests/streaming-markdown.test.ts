import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendStreamingMarkdown,
  parseOpenFenceTail,
  splitStreamingMarkdown,
  type StreamingMarkdownSplit
} from '../src/renderer/src/lib/streaming-markdown'

/** A paragraph long enough that several of them cross MIN_SPLIT_CHARS. */
function paragraph(tag: string): string {
  return `${tag} ${'word '.repeat(180).trim()}\n\n`
}

function joined(split: { blocks: string[]; tail: string }): string {
  return split.blocks.join('') + split.tail
}

test('streaming markdown splits finished paragraphs away from the live tail', () => {
  const text = paragraph('First') + paragraph('Second') + paragraph('Third') + 'still growing'
  const split = splitStreamingMarkdown(text)
  assert.ok(split.blocks.length > 0)
  assert.ok(split.tail.endsWith('still growing'))
  assert.equal(joined(split), text)
  assert.ok(split.blocks.join('').includes('First'))
  assert.ok(split.blocks.join('').includes('Second'))
  assert.ok(split.blocks.join('').includes('Third'))
})

test('streaming markdown never splits inside a fenced code block', () => {
  const code = `\`\`\`ts\n${'const value = 1\n\n'.repeat(60)}\`\`\`\n\n`
  const text = paragraph('Intro') + code + paragraph('After')
  const split = splitStreamingMarkdown(text)
  assert.ok(split.blocks.length > 0)
  assert.equal(joined(split), text)
  for (const block of split.blocks) {
    // Every committed block must contain an even number of fences: an open
    // fence belongs to the live tail, never to a finished block.
    const fences = block.match(/^ {0,3}(?:```|~~~)/gm)?.length ?? 0
    assert.equal(fences % 2, 0)
  }
})

test('streaming markdown keeps a loose list together across blank lines', () => {
  const list = `${'- first item\n\n'.repeat(3)}${'- last item\n\n'}`
  const text = paragraph('Before') + list + paragraph('After')
  const split = splitStreamingMarkdown(text)
  assert.equal(joined(split), text)
  // No committed block may end on one list item while the next item is still
  // in the document: that would restart the list at 1 in the rendered output.
  for (const block of split.blocks) {
    assert.ok(!/^- first item\s*$/.test(block.trim()))
  }
  const stable = split.blocks.join('')
  assert.ok(!stable.includes('- first item') || stable.includes('- last item'))
})

test('streaming markdown keeps blockquote paragraphs together', () => {
  const quote = `${'> quoted line\n\n'.repeat(40)}`
  const text = paragraph('Before') + quote + paragraph('After')
  const split = splitStreamingMarkdown(text)
  assert.equal(joined(split), text)
  // The whole quote is one finished block; no boundary may fall between two
  // of its quoted lines.
  assert.ok(split.blocks.join('').includes('> quoted line'))
})

test('streaming markdown leaves reference-definition documents whole', () => {
  const text = `${paragraph('Before')}[docs]: https://example.com/docs\n\n${paragraph('After')}`
  const split = splitStreamingMarkdown(text)
  assert.deepEqual(split.blocks, [])
  assert.equal(split.tail, text)
})

test('streaming markdown is stable as more text arrives', () => {
  const prefix = paragraph('One') + paragraph('Two') + paragraph('Three')
  const earlier = splitStreamingMarkdown(prefix)
  const later = splitStreamingMarkdown(prefix + paragraph('Four'))
  assert.ok(earlier.blocks.length > 0)
  // Chunks that were committed cannot change when later text arrives; a later
  // render must reuse them rather than re-parsing the growing document.
  assert.deepEqual(later.blocks.slice(0, earlier.blocks.length), earlier.blocks)
})

test('streaming markdown short documents are left to the normal path', () => {
  const text = 'A short answer.\n\nSecond paragraph.'
  const split = splitStreamingMarkdown(text)
  assert.deepEqual(split.blocks, [])
  assert.equal(split.tail, text)
})

test('appendStreamingMarkdown matches whole-document splits across fences, lists, and late ref defs', () => {
  const doc = [
    paragraph('Intro'),
    `\`\`\`ts\n${'const n = 42\n'.repeat(120)}\`\`\`\n\n`,
    `${'- item\n\n'.repeat(4)}`,
    paragraph('Outro')
  ].join('')

  let incremental: StreamingMarkdownSplit = { blocks: [], tail: '' }
  for (let offset = 0; offset < doc.length; offset += 73) {
    incremental = appendStreamingMarkdown(incremental, doc.slice(offset, offset + 73))
  }
  assert.equal(joined(incremental), doc)
  assert.ok(incremental.blocks.length > 0)
  for (const block of incremental.blocks) {
    const fences = block.match(/^ {0,3}(?:```|~~~)/gm)?.length ?? 0
    assert.equal(fences % 2, 0)
  }

  // Appending a reference definition collapses committed blocks back to tail.
  const collapsed = appendStreamingMarkdown(incremental, '\n[ref]: https://example.com\n')
  assert.deepEqual(collapsed.blocks, [])
  assert.equal(collapsed.tail, `${doc}\n[ref]: https://example.com\n`)
})

test('an open fence at the start of the tail is readable without a Markdown pass', () => {
  const open = parseOpenFenceTail('```ts\nconst a = 1\n\nconst b = 2\n')
  assert.deepEqual(open, { language: 'ts', code: 'const a = 1\n\nconst b = 2' })
  // No trailing newline yet: the block is mid-line.
  assert.deepEqual(parseOpenFenceTail('```ts\nconst a = 1\nconst b'), {
    language: 'ts',
    code: 'const a = 1\nconst b'
  })
  // Empty content is still a valid open fence (the block exists, it is just empty).
  assert.deepEqual(parseOpenFenceTail('```\n'), { language: undefined, code: '' })
})

test('a closed fence, or a fence after other text, stays with the Markdown path', () => {
  assert.equal(parseOpenFenceTail('```ts\nconst a = 1\n```\n'), null)
  assert.equal(parseOpenFenceTail('```ts\nconst a = 1\n```\n\nnext paragraph'), null)
  assert.equal(parseOpenFenceTail('A paragraph first\n```ts\nconst a = 1\n'), null)
  assert.equal(parseOpenFenceTail('just a paragraph'), null)
  assert.equal(parseOpenFenceTail(''), null)
})

test('an opener line that is still arriving is not a fence yet', () => {
  // The info string could still grow (`ts` → `tsx`), so a code block rendered
  // from it would flicker its language label.
  assert.equal(parseOpenFenceTail('```ts'), null)
  assert.equal(parseOpenFenceTail('``'), null)
})

test('fence markers only close a fence of the same character and at least its length', () => {
  // A shorter backtick run inside a four-backtick fence is content, not a close.
  assert.deepEqual(parseOpenFenceTail('````md\n```ts\nconst a = 1\n'), {
    language: 'md',
    code: '```ts\nconst a = 1'
  })
  // A tilde fence ignores backtick lines entirely.
  assert.deepEqual(parseOpenFenceTail('~~~\n```\ncontent\n'), {
    language: undefined,
    code: '```\ncontent'
  })
  // A closing run must be followed only by whitespace.
  assert.deepEqual(parseOpenFenceTail('```ts\n``` not a close\n'), {
    language: 'ts',
    code: '``` not a close'
  })
})

test('an indented fence strips its own indentation from the content', () => {
  assert.deepEqual(parseOpenFenceTail('   ```ts\n   const a = 1\n  two spaces\n'), {
    language: 'ts',
    code: 'const a = 1\ntwo spaces'
  })
})

test('the info string keeps its first token, as react-markdown does', () => {
  assert.deepEqual(parseOpenFenceTail('```js title="app.js" {1,3}\nlet a\n'), {
    language: 'js',
    code: 'let a'
  })
  // A backtick fence's info string cannot contain a backtick: that line is an
  // inline code span, so the text below is not a fence.
  assert.equal(parseOpenFenceTail('```a`b\ncontent\n'), null)
})

test('streaming markdown does not prematurely split a loose list on a partial next marker', () => {
  const before = `${paragraph('Intro')}1. ${'first list item '.repeat(80).trim()}\n\n`
  // Next item starts arriving one character at a time ("2", then ".", then " second").
  let split = splitStreamingMarkdown(before + '2')
  assert.equal(joined(split), before + '2')
  assert.ok(!split.blocks.join('').includes('first list item'), 'bare digit after blank line must not close the list')

  split = appendStreamingMarkdown(split, '.')
  assert.ok(!split.blocks.join('').includes('first list item'), 'incomplete ordered marker must not close the list')

  split = appendStreamingMarkdown(split, ' second item\n\n' + paragraph('Outro'))
  assert.equal(joined(split), before + '2. second item\n\n' + paragraph('Outro'))
  const stable = split.blocks.join('')
  assert.ok(!stable.includes('first list item') || stable.includes('2. second item'))
})
