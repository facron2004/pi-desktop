import { Code, FileText, Image as ImageIcon, type LucideIcon } from 'lucide-react'
import { fileTone } from '../lib/files'

/**
 * The mark a file carries wherever it is listed.
 *
 * A list of bare names is read by its icon first: a picture for a picture, code
 * for anything with a grammar, a plain sheet for the rest. The changes panel and
 * the conversation card ask here, so the same file looks like itself in both.
 */
export function iconForFile(name: string): LucideIcon {
  const tone = fileTone(name)
  if (tone === 'image') return ImageIcon
  if (tone === 'plain' || tone === 'markdown') return FileText
  return Code
}

export function FileIcon({ name, size = 13 }: { name: string; size?: number }) {
  const Icon = iconForFile(name)
  return (
    <span className="tree__icon file-icon" data-tone={fileTone(name)} aria-hidden="true">
      <Icon size={size} />
    </span>
  )
}
