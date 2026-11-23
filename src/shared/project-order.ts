/**
 * Where a newly added project folder goes in the sidebar.
 *
 * It takes the **first** place. A folder the reader has just added is the
 * newest row on the list, and the thing they are looking for; appending it to
 * the end put it below every existing project, which reads as if the add had
 * been ignored. Existing rows keep their relative order, so a manual
 * arrangement is never disturbed — only the new path moves.
 *
 * `keyOf` is the caller's path-key function: settings canonicalises case,
 * slashes and trailing separators, and this must not invent a second rule.
 */
export function withNewProjectFirst(
  order: readonly string[],
  path: string,
  keyOf: (value: string) => string
): string[] {
  const key = keyOf(path)
  const rest = order.filter((item) => keyOf(item) !== key)
  return [path, ...rest]
}
