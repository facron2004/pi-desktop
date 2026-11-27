/**
 * The bytes of a picture the app already holds as a data URL.
 *
 * `fs:saveImage` takes base64 and a media type, not the `data:` wrapper the
 * `<img>` needs, so the two shapes are converted in one place instead of every
 * caller cutting the string itself.
 */
export interface ImagePayload {
  /** Base64 bytes, without the `data:…;base64,` prefix. */
  data: string
  /** The media type the wrapper declared (`image/png`). */
  mimeType: string
}

export function imagePayloadOf(dataUrl: string): ImagePayload | null {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(dataUrl)
  if (!match) return null
  const mimeType = match[1].trim()
  const data = match[2]
  if (!mimeType || !data) return null
  return { data, mimeType }
}
