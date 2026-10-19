import { File as FileIcon } from 'lucide-react'
import type { FileEntry } from '@shared/types'
import { relativePath } from '../lib/path'

/**
 * The files that match an `@` in the composer.
 *
 * The list is shown above the composer, the way the command list is, so the
 * two never fight over the same place.
 */
export function FileMention({
  files,
  root,
  activeIndex,
  onActiveChange,
  onSelect
}: {
  files: FileEntry[]
  root?: string
  activeIndex: number
  onActiveChange: (index: number) => void
  onSelect: (file: FileEntry) => void
}) {
  return (
    <div className="mention" role="listbox" aria-label="Files">
      <div className="mention__head">
        <FileIcon size={12} />
        <span>
          {files.length} {files.length === 1 ? 'file' : 'files'}
        </span>
      </div>

      {files.length === 0 ? (
        <div className="mention__empty">No file matches that name.</div>
      ) : (
        <div className="mention__list">
          {files.map((file, index) => {
            const relative = relativePath(root ?? '', file.path)
            const folder = relative
              .slice(0, Math.max(0, relative.length - file.name.length))
              .replace(/\\/g, '/')
              .replace(/\/$/, '')
            return (
              <button
                key={file.path}
                className="mention__item"
                role="option"
                aria-selected={index === activeIndex}
                data-active={index === activeIndex}
                onMouseEnter={() => onActiveChange(index)}
                // The textarea keeps the focus, so the list does not vanish
                // before the click lands.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(file)}
              >
                <span className="mention__name">{file.name}</span>
                <span className="mention__folder">{folder}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
