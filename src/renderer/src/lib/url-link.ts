/**
 * Pure link detection. Kept free of store imports so the rules can be tested
 * without a renderer window; `open-link.ts` is the half that performs the open.
 */

/**
 * Top-level domains that make a bare `host/path` string a URL rather than a
 * file reference. The list only has to cover what a model writes in an answer;
 * an unknown suffix is safer treated as a path, because a wrong file link still
 * opens something useful while a wrong URL link does not.
 */
const URL_TLDS = new Set([
  'com', 'org', 'net', 'edu', 'gov', 'mil', 'int',
  'io', 'dev', 'app', 'ai', 'co', 'me', 'so', 'sh', 'gg', 'tv', 'cc',
  'cn', 'uk', 'de', 'fr', 'jp', 'kr', 'ru', 'br', 'in', 'it', 'nl', 'se',
  'no', 'fi', 'dk', 'pl', 'es', 'ca', 'au', 'ch', 'at', 'be', 'cz', 'pt',
  'info', 'biz', 'xyz', 'site', 'online', 'tech', 'store', 'blog', 'page',
  'link', 'live', 'news', 'cloud', 'space', 'website', 'wiki', 'tools'
])

/**
 * Is this string a link the reader would expect to open in a browser?
 *
 * Covers the explicit schemes, the protocol-relative form, and a bare
 * `example.com`, `docs.example.com/x?y` that a model writes without `https://`.
 * A filename such as `foo.test.ts` is rejected: its suffix is not a domain.
 */
export function looksLikeUrl(value: string): boolean {
  const text = value.trim()
  if (!text) return false
  if (/^(?:https?|ftp):\/\//i.test(text)) return true
  if (/^mailto:/i.test(text)) return false
  if (text.startsWith('//')) return true
  if (/\s/.test(text)) return false
  const match = /^([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)(?:[/:?#]|$)/i.exec(text)
  if (!match) return false
  const host = match[1]
  const tld = host.slice(host.lastIndexOf('.') + 1).toLowerCase()
  return URL_TLDS.has(tld)
}

/** Turn any accepted link form into an absolute http(s) URL, or null. */
export function normalizeExternalUrl(value: string): string | null {
  const text = value.trim()
  if (!text) return null
  if (/^https?:\/\//i.test(text)) return text
  if (text.startsWith('//')) return `https:${text}`
  if (!looksLikeUrl(text)) return null
  return `https://${text.replace(/^\/+/, '')}`
}
