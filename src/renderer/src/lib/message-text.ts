/**
 * Text Pi writes into a message because a picture is attached.
 *
 * When a prompt carries an image, Pi annotates it for the model's context:
 *
 *   [Image: original 2559x1527, displayed at 2000x1193. Multiply coordinates
 *    by 1.28 to map to original image.]
 *
 * That sentence describes the picture to the model — the reader already sees
 * that an attachment exists — so the conversation bubble drops it instead of
 * printing a line of bookkeeping under the prompt.
 */

const IMAGE_ANNOTATION = /^[ \t]*\[Image:[^\]\n]*\][ \t]*$/gm

export function stripImageAnnotations(text: string): string {
  if (!text.includes('[Image:')) return text
  return text
    .replace(IMAGE_ANNOTATION, '')
    // Removing a paragraph must not leave the blank lines it stood between.
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
