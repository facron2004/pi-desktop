/**
 * Decodes a read text buffer with UTF-16LE/BE and UTF-8 BOM awareness.
 *
 * Windows scripts (`.ps1`, `.bat`, `.reg`) written by PowerShell 5.1, ISE, or
 * `Out-File` commonly carry a UTF-16LE BOM (`FF FE`) or UTF-8 BOM (`EF BB BF`).
 * Plain `.toString('utf8')` turns UTF-16 into NUL-interleaved mojibake.
 */
export function decodeBoundedTextBuffer(buffer: Buffer): string {
  if (buffer.length === 0) return ''

  // UTF-16LE BOM (FF FE)
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    const evenEnd = buffer.length - ((buffer.length - 2) % 2)
    return evenEnd <= 2 ? '' : buffer.subarray(2, evenEnd).toString('utf16le')
  }

  // UTF-16BE BOM (FE FF)
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const evenEnd = buffer.length - ((buffer.length - 2) % 2)
    if (evenEnd <= 2) return ''
    // Copy before swap16 so callers sharing the buffer never observe mutation.
    return Buffer.from(buffer.subarray(2, evenEnd)).swap16().toString('utf16le')
  }

  // UTF-8 BOM (EF BB BF) — drop the BOM so line 1 starts cleanly.
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8')
  }

  return buffer.toString('utf8')
}
