/**
 * An image turn can say the same prompt twice: the model sometimes quotes its
 * refined prompt in the reply, while the image card also keeps the prompt in
 * its fold. Only one of them is worth reading.
 *
 * The quote is a paraphrase, so an exact match misses it. The opening of a
 * refined prompt is stable across the two copies, so compare a normalized
 * prefix instead of the whole string.
 */

const PREFIX = 36

function normalize(value: string): string {
  return value.replace(/\s+/g, '').replace(/[，。；：、,.;:]/g, '')
}

/** True when `reply` already contains (a paraphrase of) the image prompt. */
export function repliesPrompt(reply: string, prompt: string): boolean {
  const needle = normalize(prompt).slice(0, PREFIX)
  if (needle.length < 16) return false
  return normalize(reply).includes(needle)
}

/**
 * Remove the quoted prompt from the reply.
 *
 * The picture card keeps the prompt in its own fold, so a reply that repeats it
 * prints the same long paragraph twice — once in the reading column and once
 * behind the card's caret. The reader asked for one copy, and the card is where
 * it belongs. A later paragraph that is only more of the same quote is dropped
 * too; a sentence that merely mentions the subject is left alone.
 */
export function stripEchoedPrompt(text: string, prompts: readonly string[]): string {
  if (!text || prompts.length === 0) return text
  const needles = prompts.map((prompt) => normalize(prompt)).filter((value) => value.length >= 16)
  if (needles.length === 0) return text
  const paragraphs = text.split(/\n{2,}/)
  const kept = paragraphs.filter((paragraph) => {
    const body = paragraph.trim()
    if (!body) return false
    const normalized = normalize(body.replace(/^>\s?/gm, ''))
    // A one-line aside is not a quote. Anything longer that is only a slice of
    // the prompt — the opening, or a later sentence of the same quote — is.
    if (normalized.length < 12) return true
    return !needles.some(
      (needle) => needle.includes(normalized) || normalized.includes(needle.slice(0, PREFIX))
    )
  })
  if (kept.length === paragraphs.filter((paragraph) => paragraph.trim()).length) return text
  return kept.join('\n\n').trim()
}
