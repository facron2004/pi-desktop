/**
 * Memories are written verbatim into a future system prompt, so a credential
 * that appeared in one conversation must not survive extraction. This is a
 * last line of defence: the extraction prompt already forbids secrets, but a
 * model can still quote a token it saw in a command.
 */

const PATTERNS: Array<[RegExp, string]> = [
  // Common provider key shapes.
  [/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[redacted-key]'],
  [/\b(ghp_[A-Za-z0-9]{20,})\b/g, '[redacted-key]'],
  [/\b(github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted-key]'],
  [/\b(AKIA[0-9A-Z]{16})\b/g, '[redacted-key]'],
  [/\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '[redacted-key]'],
  // Authorization headers and bearer tokens.
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted]'],
  // key = "value" / key: value. Keep the key name so the sentence stays readable.
  [
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    '$1[redacted]'
  ],
  // Long opaque blobs that are very unlikely to be prose.
  [/\b[A-Fa-f0-9]{48,}\b/g, '[redacted]'],
  [/\b[A-Za-z0-9+/]{64,}={0,2}\b/g, '[redacted]']
]

export function redactSecrets(input: string): string {
  let text = input
  for (const [pattern, replacement] of PATTERNS) {
    text = text.replace(pattern, replacement)
  }
  return text
}

/** True when the text still looks like it contains a credential. */
export function containsSecret(input: string): boolean {
  return redactSecrets(input) !== input
}
