/**
 * Memories are written verbatim into a future system prompt, so a credential
 * that appeared in one conversation must not survive extraction. This is a
 * last line of defence: the extraction prompt already forbids secrets, but a
 * model can still quote a token it saw in a command.
 */

const PATTERNS: Array<[RegExp, string]> = [
  // Multi-line or inline PEM private keys (must run before line-level rules so
  // headers, footers and short trailing lines do not survive).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[redacted-key]'],
  // Common provider key shapes.
  [/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[redacted-key]'],
  // Stripe secret and restricted keys use underscores instead of hyphens.
  [/\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,})\b/g, '[redacted-key]'],
  [/\b(hf_[A-Za-z0-9]{20,})\b/g, '[redacted-key]'],
  // npm granular and classic tokens.
  [/\b(npm_[A-Za-z0-9]{36})\b/g, '[redacted-key]'],
  // Google API keys and OAuth access tokens can appear without an assignment label.
  [/\b(AIza[0-9A-Za-z_-]{20,})\b/g, '[redacted-key]'],
  [/\b(ya29\.[0-9A-Za-z_-]{20,})\b/g, '[redacted-key]'],
  // GitLab token families and PyPI API tokens have recognizable prefixes.
  [/\b(gl(?:pat|oas|dt|rt|rtr|cbt|ptt|ft|imt|agent|wt|soat|ffct)-[A-Za-z0-9_-]{10,})\b/g, '[redacted-key]'],
  [/\b(pypi-[A-Za-z0-9_-]{85,})\b/g, '[redacted-key]'],
  // GitHub PAT, OAuth and GitHub App tokens. Installation tokens can contain
  // separators in the newer stateless format.
  [/\b(gh[opusr]_[A-Za-z0-9._~-]{20,})\b/g, '[redacted-key]'],
  [/\b(github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted-key]'],
  // AWS permanent (AKIA) and temporary STS (ASIA) access key IDs.
  [/\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g, '[redacted-key]'],
  [/\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '[redacted-key]'],
  // Authorization and cookie headers may carry credentials without a known token prefix.
  [/(?<![A-Za-z0-9_-])((?:proxy[-_]?)?authorization["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]+)/gi, '$1[redacted]'],
  [/(?<![A-Za-z0-9_-])((?:set[-_]?)?cookie["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,]+)/gi, '$1[redacted]'],
  // Bearer tokens can also appear outside a header.
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted]'],
  // Compact JWT/JWE tokens can appear without a Bearer prefix or assignment.
  [
    /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*)?(?![A-Za-z0-9_-])/g,
    '[redacted-token]'
  ],
  // URL user info often carries database passwords or service credentials.
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/[^/\s:@]+:)[^@\s/]+@/gi, '$1[redacted]@'],
  // AWS secret access keys are 40 characters. Keep 40-character hexadecimal
  // Git object IDs intact by requiring at least one non-hex base64 character.
  [/(?<![A-Za-z0-9_+/=])(?=[A-Za-z0-9/+=]{0,39}[G-Zg-z/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9_+/=])/g, '[redacted-key]'],
  // Credential-like environment/config keys, including vendor-prefixed names
  // such as AWS_SECRET_ACCESS_KEY and STRIPE_SECRET_KEY. Keep the key name so
  // the sentence stays readable. Bound prefix depth and start at key boundaries
  // so ordinary long transcript text does not trigger repeated scans.
  [
    /(?<![A-Za-z0-9_-])((?:["']?(?:[A-Za-z0-9]+[_-]){0,4}(?:api[_-]?(?:key|secret)|access[_-]?(?:key(?:[_-]?id)?|token)|refresh[_-]?token|session[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret(?:[_-](?:access[_-]?key|key|token))?|password|passwd|credential(?:s)?|token)["']?\s*[:=]\s*))(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
    '$1[redacted]'
  ],
  // Long opaque blobs that are very unlikely to be prose. Run the 64+ Base64
  // rule before 48+ hex so Base64 strings with hex runs and `=` padding are
  // replaced whole, and use explicit Base64 boundaries rather than `\b` because
  // `+`, `/` and `=` are non-word characters.
  [/(?<![A-Za-z0-9_+/=])[A-Za-z0-9+/]{64,}={0,2}(?![A-Za-z0-9_+/=])/g, '[redacted]'],
  [/\b[A-Fa-f0-9]{48,}\b/g, '[redacted]']
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
