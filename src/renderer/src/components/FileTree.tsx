import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, File, Folder, FolderOpen, Loader2 } from 'lucide-react'
import type { FileEntry } from '@shared/types'

interface FileTreeProps {
  root: string
  onOpen: (file: string) => void
}

export function FileTree({ root, onOpen }: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [children, setChildren] = useState<Map<string, FileEntry[]>>(new Map())
  const [loading, setLoading] = useState<Set<string>>(new Set())

  const load = useCallback(async (dir: string) => {
    if (children.has(dir)) return
    setLoading((current) => new Set(current).add(dir))
    try {
      const entries = await window.pi.fs.list(dir)
      setChildren((current) => new Map(current).set(dir, entries))
    } finally {
      setLoading((current) => {
        const next = new Set(current)
        next.delete(dir)
        return next
      })
    }
  }, [children])

  useEffect(() => {
    if (!root) return
    void load(root)
    setExpanded((current) => new Set(current).add(root))
  }, [root, load])

  const toggle = (dir: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(dir)) next.delete(dir)
      else {
        next.add(dir)
        void load(dir)
      }
      return next
    })
  }

  if (!root) {
    return <div className="drawer__empty">Open a project folder to browse its files.</div>
  }

  return (
    <div className="tree" role="tree">
      <TreeLevel
        dir={root}
        depth={0}
        children={children}
        expanded={expanded}
        loading={loading}
        onToggle={toggle}
        onOpen={onOpen}
      />
    </div>
  )
}

interface TreeLevelProps {
  dir: string
  depth: number
  children: Map<string, FileEntry[]>
  expanded: Set<string>
  loading: Set<string>
  onToggle: (dir: string) => void
  onOpen: (file: string) => void
}

function TreeLevel({
  dir,
  depth,
  children,
  expanded,
  loading,
  onToggle,
  onOpen
}: TreeLevelProps) {
  const entries = children.get(dir)
  if (!entries) {
    return loading.has(dir) ? (
      <div className="tree__loading" style={{ paddingLeft: depth * 12 + 18 }}>
        <Loader2 size={12} className="spin" />
      </div>
    ) : null
  }
  if (entries.length === 0) {
    return <div className="tree__empty" style={{ paddingLeft: depth * 12 + 18 }}>empty</div>
  }

  return (
    <ul className="tree__list" role="group">
      {entries.map((entry) => {
        const isOpen = expanded.has(entry.path)
        return (
          <li key={entry.path} role="treeitem" aria-expanded={entry.kind === 'directory' ? isOpen : undefined}>
            <button
              className="tree__item"
              style={{ paddingLeft: depth * 12 + 8 }}
              onClick={() => (entry.kind === 'directory' ? onToggle(entry.path) : onOpen(entry.path))}
              title={entry.path}
            >
              {entry.kind === 'directory' ? (
                <>
                  <ChevronRight size={12} className="caret" data-open={isOpen} />
                  {isOpen ? <FolderOpen size={13} /> : <Folder size={13} />}
                </>
              ) : (
                <>
                  <span style={{ width: 12, display: 'inline-block' }} />
                  <File size={13} />
                </>
              )}
              <span className="tree__name">{entry.name}</span>
            </button>
            {entry.kind === 'directory' && isOpen ? (
              <TreeLevel
                dir={entry.path}
                depth={depth + 1}
                children={children}
                expanded={expanded}
                loading={loading}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
