export const HIGHLIGHT_CACHE_LIMIT = 48
export const MAX_CACHED_HIGHLIGHT_CODE_UNITS = 32 * 1024

export function highlightCacheKey(code: string, language: string, isDark: boolean): string | undefined {
  if (code.length > MAX_CACHED_HIGHLIGHT_CODE_UNITS) return undefined
  return `${isDark ? 'dark' : 'light'}\u0000${language}\u0000${code}`
}

export class HighlightCache {
  private readonly entries = new Map<string, Promise<string>>()

  get(key: string): Promise<string> | undefined {
    const value = this.entries.get(key)
    if (!value) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(key: string, codeUnits: number, value: Promise<string>): void {
    if (codeUnits > MAX_CACHED_HIGHLIGHT_CODE_UNITS) return
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > HIGHLIGHT_CACHE_LIMIT) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  deleteIfValue(key: string, value: Promise<string>): void {
    if (this.entries.get(key) === value) this.entries.delete(key)
  }
}
