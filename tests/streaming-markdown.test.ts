import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitStreamingMarkdown } from '../src/renderer/src/lib/streaming-markdown'

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
