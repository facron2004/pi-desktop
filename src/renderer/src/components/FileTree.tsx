import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, File, Folder, FolderOpen, Loader2, Search, X } from 'lucide-react'
import type { FileEntry } from '@shared/types'
import { fileTone } from '../lib/files'
import { relativePath } from '../lib/path'

interface FileTreeProps {
  root: string
  onOpen: (file: string) => void
}

export function FileTree({ root, onOpen }: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [children, setChildren] = useState<Map<string, FileEntry[]>>(new Map())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<FileEntry[] | null>(null)
  const [searching, setSearching] = useState(false)

  const load = useCallback(
    async (dir: string) => {
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
    },
    [children]
  )

  useEffect(() => {
    if (!root) return
    void load(root)
    setExpanded((current) => new Set(current).add(root))
  }, [root, load])

  // Development aid: prefill the search box so screenshots can show results.
  useEffect(() => {
    const dev = (window as unknown as { __piDesktopDev?: { fileSearch?: string } }).__piDesktopDev
    if (dev?.fileSearch) setQuery(dev.fileSearch)
  }, [])

  // Search the whole project, not just the folders that happen to be open.
  useEffect(() => {
    const needle = query.trim()
    if (!needle) {
      setMatches(null)
      setSearching(false)
      return
    }
    let cancelled = false
    setSearching(true)
    const timer = window.setTimeout(() => {
      window.pi.fs
        .search(needle)
        .then((found) => {
          if (!cancelled) setMatches(found)
        })
        .catch(() => {
          if (!cancelled) setMatches([])
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query])

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
    <div className="tree">
      <div className="tree__search">
        <Search size={12} />
        <input
          value={query}
          placeholder="Find files"
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <button className="icon-btn" onClick={() => setQuery('')} title="Clear">
            <X size={12} />
          </button>
        ) : null}
      </div>

      {matches ? (
        <div className="tree__results">
          <div className="tree__results-head">
            {searching
              ? 'Searching…'
              : `${matches.length} ${matches.length === 1 ? 'file' : 'files'} match “${query.trim()}”`}
          </div>
          {!searching && matches.length === 0 ? (
            <div className="tree__empty">Nothing found</div>
          ) : null}
          {matches.map((entry) => {
            const relative = relativePath(root, entry.path)
            const folder = relative.slice(0, Math.max(0, relative.length - entry.name.length)).replace(/[\\/]+$/, '')
            return (
              <button
                key={entry.path}
                className="tree__item tree__item--flat"
                onClick={() => onOpen(entry.path)}
                title={entry.path}
              >
                <span className="tree__icon" data-tone={fileTone(entry.name)}>
                  <File size={13} />
                </span>
                <span className="tree__name">{entry.name}</span>
                {folder ? (
                  <span className="tree__dir" title={folder}>
                    {folder}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : (
        <TreeLevel
          dir={root}
          depth={0}
          children={children}
          expanded={expanded}
          loading={loading}
          onToggle={toggle}
          onOpen={onOpen}
        />
      )}
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
          <li
            key={entry.path}
            role="treeitem"
            aria-expanded={entry.kind === 'directory' ? isOpen : undefined}
          >
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
                  <span className="tree__icon" data-tone={fileTone(entry.name)}>
                    <File size={13} />
                  </span>
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
