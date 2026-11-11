/** Plain-text search over the conversation, used by the in-thread search bar. */

export type SearchSource = 'You' | 'Pi' | 'Tool'

export interface SearchableChunk {
  turnId: string
  messageId?: string
  source: SearchSource
  text: string
}

export interface SearchHit {
  /** Stable identity of the hit, used as a React key. */
  key: string
  turnId: string
  messageId?: string
  source: SearchSource
  /** A short piece of text around the match. */
  snippet: string
  /** Offset of the match inside the chunk, used to split the snippet. */
  index: number
}

interface CachedChunkMatches {
  text: string
  needle: string
  indexes: number[]
  scannedLimit: number
  complete: boolean
}

const matchesByChunk = new WeakMap<SearchableChunk, CachedChunkMatches>()

/** Find every occurrence of the query, in chunk order. */
export function findMatches(
  chunks: SearchableChunk[],
  query: string,
  limit = 50
): SearchHit[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const hits: SearchHit[] = []
  for (const [chunkIndex, chunk] of chunks.entries()) {
    const remaining = Math.max(1, limit - hits.length)
    const cached = matchesByChunk.get(chunk)
    let indexes: number[]
    if (
      cached?.text === chunk.text &&
      cached.needle === needle &&
      (cached.scannedLimit >= remaining || cached.complete)
    ) {
      indexes = cached.indexes
    } else {
      const haystack = chunk.text.toLowerCase()
      indexes = []
      let from = 0
      let index = haystack.indexOf(needle, from)
      while (index !== -1 && indexes.length < remaining) {
        indexes.push(index)
        from = index + needle.length
        index = haystack.indexOf(needle, from)
      }
      matchesByChunk.set(chunk, {
        text: chunk.text,
        needle,
        indexes,
        scannedLimit: remaining,
        complete: index === -1
      })
    }
    for (const index of indexes) {
      hits.push({
        key: `${chunk.turnId}:${chunkIndex}:${index}`,
        turnId: chunk.turnId,
        ...(chunk.messageId ? { messageId: chunk.messageId } : {}),
        source: chunk.source,
        snippet: snippetAround(chunk.text, index, needle.length),
        index
      })
      if (hits.length >= limit) return hits
    }
  }
  return hits
}

/** A window of text around a match, with the whitespace collapsed. */
function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 32)
  const end = Math.min(text.length, index + length + 48)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

/** Split a snippet into the parts before, inside and after the match. */
export function splitSnippet(snippet: string, query: string): [string, string, string] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [snippet, '', '']
  const at = snippet.toLowerCase().indexOf(needle)
  if (at === -1) return [snippet, '', '']
  return [snippet.slice(0, at), snippet.slice(at, at + needle.length), snippet.slice(at + needle.length)]
}
