/**
 * Minimal multipart/form-data parser for text fields.
 *
 * The WeChat bridge pushes received messages as multipart posts whose parts
 * are short strings (`type`, `content`, `source`, flag fields) plus, for
 * media, one file part. Text values decode as UTF-8; file parts are skipped
 * without buffering their bytes.
 */

const MAX_FIELDS = 20
const MAX_FIELD_BYTES = 100 * 1024

interface ParsedPart {
  name: string
  filename?: string
  body: Buffer
}

function findAscii(buffer: Buffer, needle: string, from: number): number {
  return buffer.indexOf(needle, from, 'ascii')
}

function parsePartHeaders(buffer: Buffer, start: number, end: number): { name: string; filename?: string } | null {
  const headerText = buffer.subarray(start, end).toString('utf8')
  let name: string | undefined
  let filename: string | undefined
  for (const line of headerText.split(/\r?\n/)) {
    const disposition = /^content-disposition\s*:/i.exec(line)
    if (!disposition) continue
    const nameMatch = /\bname="((?:[^"\\]|\\.)*)"/i.exec(line)
    const fileMatch = /\bfilename="((?:[^"\\]|\\.)*)"/i.exec(line)
    if (nameMatch) name = nameMatch[1].replace(/\\(.)/g, '$1')
    if (fileMatch) filename = fileMatch[1].replace(/\\(.)/g, '$1')
  }
  if (name === undefined) return null
  return { name, filename }
}

function parseParts(contentType: string, body: Buffer): ParsedPart[] {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType)
  if (!boundaryMatch) throw new Error('Multipart body has no boundary.')
  const boundary = `--${boundaryMatch[1] ?? boundaryMatch[2]}`
  const parts: ParsedPart[] = []
  let cursor = findAscii(body, boundary, 0)
  while (cursor >= 0 && parts.length < MAX_FIELDS + 1) {
    const lineEnd = findAscii(body, '\r\n', cursor)
    if (lineEnd < 0) break
    // A closing delimiter carries two extra dashes right after the boundary.
    if (body.subarray(cursor + boundary.length, cursor + boundary.length + 2).toString('ascii') === '--') break
    const headerStart = lineEnd + 2
    const headerEnd = findAscii(body, '\r\n\r\n', headerStart)
    if (headerEnd < 0) break
    const headers = parsePartHeaders(body, headerStart, headerEnd)
    const next = findAscii(body, boundary, headerEnd + 4)
    if (!headers) {
      cursor = next
      continue
    }
    const bodyEnd = next >= 0 ? next - 2 : body.length // strip the trailing \r\n
    parts.push({ name: headers.name, filename: headers.filename, body: body.subarray(headerEnd + 4, bodyEnd) })
    cursor = next
  }
  return parts
}

/**
 * Text fields of one multipart body. File parts are skipped (their names are
 * dropped, never buffered). Bounds: at most 20 fields, 100 KB per field;
 * violations throw and the caller rejects the request.
 */
export function parseMultipartTextFields(contentType: string, body: Buffer): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const part of parseParts(contentType, body)) {
    if (part.filename !== undefined) continue
    if (part.body.length > MAX_FIELD_BYTES) throw new Error('Multipart field exceeds the size limit.')
    fields[part.name] = part.body.toString('utf8')
  }
  return fields
}
