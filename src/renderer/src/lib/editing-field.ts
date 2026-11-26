/**
 * Whether the reader is typing in a field.
 *
 * App-wide chords that change the view — a new chat, another project, the
 * conversation search — must not fire while a field owns the keyboard: the
 * reader would lose what they were writing and the focus that went with it.
 * Chords that open a layer (the palette, settings, the shortcut list, the
 * session tree) stay available, because opening a layer is not a view change.
 *
 * The composer is the one exception: it is a textarea, but there the chords are
 * part of writing a prompt, and it keeps its focus because the prompt is saved
 * as a draft rather than dropped.
 */
export function isEditingField(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false
  if (element.isContentEditable) return true
  if (element instanceof HTMLSelectElement) return true
  if (element instanceof HTMLTextAreaElement) return !isComposerInput(element)
  if (element instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color'].includes(
      element.type
    )
  }
  return element.closest('.xterm') !== null
}

/** The composer's own box, in the main conversation and in the side chat. */
export function isComposerInput(element: Element | null): boolean {
  return element instanceof HTMLElement && element.matches('.composer__input')
}
