import test from 'node:test'
import assert from 'node:assert/strict'
import { repliesPrompt, stripEchoedPrompt } from '../src/renderer/src/lib/image-echo'

const PROMPT =
  '一张高度写实的半身人像摄影：一位四十六岁左右的欧洲白人男子，深棕色短发略带白色鬓角，皮肤有日晒痕迹'

test('a paraphrase of the prompt is recognised', () => {
  assert.equal(repliesPrompt(`${PROMPT}，看向镜头。`, PROMPT), true)
  assert.equal(repliesPrompt('已生成，这次是户外阳光下的版本。', PROMPT), false)
})

test('the quoted prompt paragraph is dropped from the reply', () => {
  const reply = `已生成，这次是户外阳光下的版本。\n\n${PROMPT}\n\n说明：本张无水印。`
  const kept = stripEchoedPrompt(reply, [PROMPT])
  assert.equal(kept.includes(PROMPT), false)
  assert.equal(kept.includes('已生成'), true)
  assert.equal(kept.includes('说明'), true)
})

test('a reply that is only the prompt becomes empty', () => {
  assert.equal(stripEchoedPrompt(PROMPT, [PROMPT]), '')
})

test('unrelated text is left untouched', () => {
  const reply = '已生成，这次是户外阳光下的版本。\n\n说明：本张无水印。'
  assert.equal(stripEchoedPrompt(reply, [PROMPT]), reply)
  assert.equal(stripEchoedPrompt(reply, []), reply)
  assert.equal(stripEchoedPrompt('', [PROMPT]), '')
})

test('a blockquote of the prompt, including its continuation, is dropped', () => {
  const reply = [
    '已生成，这次改成摄影棚极简风格。',
    `> ${PROMPT}，看向镜头。`,
    '> 构图是胸部以上，背景是浅灰摄影棚。',
    '图片保存于 `E:/project/output/generated/shot.png`',
    '说明：本张无水印。'
  ].join('\n\n')
  const kept = stripEchoedPrompt(reply, [`${PROMPT}，看向镜头。构图是胸部以上，背景是浅灰摄影棚。`])
  assert.equal(kept.includes('一张高度写实'), false)
  assert.equal(kept.includes('构图是胸部以上'), false)
  assert.equal(kept.includes('已生成'), true)
  assert.equal(kept.includes('图片保存于'), true)
  assert.equal(kept.includes('说明'), true)
})
test('a mention of the subject is not mistaken for the prompt', () => {
  const reply = '这是一位欧洲男子站在阳光下的版本，比上一版更自然。'
  assert.equal(stripEchoedPrompt(reply, [PROMPT]), reply)
})
