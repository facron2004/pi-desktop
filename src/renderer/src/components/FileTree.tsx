import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Braces,
  ChevronRight,
  FileCode,
  FileImage,
  FileTerminal,
  FileText,
  Folder,
  FolderOpen,
  Hash,
  List,
  Loader2,
  Search,
  X
} from 'lucide-react'
import { MAX_SEARCH_QUERY_LENGTH } from '@shared/types'
import type { FileListResult, FileSearchResult } from '@shared/types'
import { fileTone } from '../lib/files'
import {
  changeFor,
  changedFileTree,
  fileChangeIndex,
  type ChangedNode,
  type FileChangeKind
} from '../lib/file-status'
import { formatBytes } from '../lib/format'
import { relativePath } from '../lib/path'
import { useT } from '../lib/i18n'
import { useAppStore } from '../store/useAppStore'

interface FileTreeProps {
  root: string
  onOpen: (file: string) => void
}

type TreeMode = 'changed' | 'all'

/**
 * The file's type as a real glyph, not its extension spelled out.
 *
 * The shape says what kind of thing it is at a glance — code brackets, braces,
 * a picture, a terminal prompt — and the tint separates the families that
 * share a glyph. This is how a file browser is read.
 */
function FileTypeIcon({ name }: { name: string }) {
  const tone = fileTone(name)
  const Icon =
    tone === 'json' ? Braces
      : tone === 'image' ? FileImage
        : tone === 'markdown' || tone === 'plain' ? FileText
          : tone === 'shell' ? FileTerminal
            : tone === 'style' ? Hash
              : FileCode
  return (
    <span className="tree__file-icon" data-tone={tone} aria-hidden="true">
      <Icon size={14} strokeWidth={1.7} />
    </span>
  )
}

const CHANGE_LABEL: Record<FileChangeKind, string> = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  conflicted: 'Conflict'
}

/**
 * The right-hand mark of a changed row: an outlined tile with one glyph,
 * matching the reference app's `.` / `+` squares.
 */
function ChangeMark({ kind }: { kind: FileChangeKind }) {
  const t = useT()
  return (
    <span className="tree__change" data-kind={kind} title={t(CHANGE_LABEL[kind])} aria-label={t(CHANGE_LABEL[kind])}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <rect x="1.4" y="1.4" width="11.2" height="11.2" rx="3" stroke="currentColor" strokeWidth="1.2" />
        {kind === 'added' ? (
          <path d="M7 4.3v5.4M4.3 7h5.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        ) : null}
        {kind === 'deleted' ? (
          <path d="M4.3 7h5.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        ) : null}
        {kind === 'modified' ? <circle cx="7" cy="7" r="1.6" fill="currentColor" /> : null}
        {kind === 'renamed' ? (
          <path d="M4 7h5.1M7.5 5.4 9.2 7l-1.7 1.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        ) : null}
        {kind === 'conflicted' ? (
          <path d="M7 4.1v3.4M7 9.4v.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        ) : null}
      </svg>
    </span>
  )
}

/**
 * A folder only aggregates its children, so it wears a quiet dot instead of a
 * file's framed glyph — the reference app makes the same distinction.
 */
function FolderMark({ kind }: { kind: FileChangeKind }) {
  const t = useT()
  return (
    <span
      className="tree__folder-dot"
      data-kind={kind}
      title={t(CHANGE_LABEL[kind])}
      aria-label={t(CHANGE_LABEL[kind])}
    />
  )
}

/** Each level of the hierarchy is one step of this many pixels. */
const INDENT = 12

export function FileTree({ root, onOpen }: FileTreeProps) {
  const t = useT()
  const git = useAppStore((state) => state.git)
  const refreshGit = useAppStore((state) => state.refreshGit)
  const [mode, setMode] = useState<TreeMode>('changed')
  const [openIndex, setOpenIndex] = useState<TreeMode | null>(null)
  const [indexChosen, setIndexChosen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [collapsedChanges, setCollapsedChanges] = useState<Set<string>>(() => new Set())
  const [children, setChildren] = useState<Map<string, FileListResult>>(new Map())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<FileSearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const activeRoot = useRef(root)
  const searchVersion = useRef(0)
  activeRoot.current = root
  const changes = useMemo(() => fileChangeIndex(git, root), [git, root])
  const changedCount = changes.files.size
  // A clean project has nothing to list in the changed index, so the first
  // visit falls back to All files; once the reader picks an index, that choice
  // is theirs and a later git refresh must not move it.
  const changedTree = useMemo(
    () => (openIndex === 'changed' ? changedFileTree(changes, root, query) : []),
    [changes, root, query, openIndex]
  )

  const updateQuery = (next: string) => {
    searchVersion.current += 1
    const hasQuery = Boolean(next.trim())
    if (mode === 'all') {
      setMatches(hasQuery ? { entries: [], truncated: false } : null)
      setSearching(hasQuery)
    }
    setSearchError(false)
    setQuery(next)
  }

  const load = useCallback(
    async (dir: string, force = false) => {
      if (!force && children.has(dir)) return
      setLoading((current) => new Set(current).add(dir))
      try {
        const result = await window.pi.fs.list(dir)
        if (activeRoot.current === root) setChildren((current) => new Map(current).set(dir, result))
      } catch {
        // The folder may disappear while it is being read.
      } finally {
        if (activeRoot.current === root) {
          setLoading((current) => {
            const next = new Set(current)
            next.delete(dir)
            return next
          })
        }
      }
    },
    [children, root]
  )

  useEffect(() => {
    setChildren(new Map())
    setExpanded(new Set())
    setCollapsedChanges(new Set())
    setMatches(null)
    setQuery('')
    setSearching(false)
    setSearchError(false)
    setIndexChosen(false)
    setOpenIndex(null)
    searchVersion.current += 1
    if (!root) return
    // The previous workspace may already have loaded this path as a folder.
    // Root changes reset the listing cache below, so do not let that old
    // render's cache suppress the new root read.
    void load(root, true)
    setExpanded((current) => new Set(current).add(root))
  }, [root])

  // Open the index that has something to say the first time git answers. A
  // clean repository shows All files; a dirty one shows the changed list.
  useEffect(() => {
    if (indexChosen || !root) return
    const first: TreeMode = changedCount > 0 ? 'changed' : 'all'
    setMode(first)
    setOpenIndex(first)
  }, [changedCount, indexChosen, root])

  // The tree now wears each file's change, so the reading has to be current
  // when the page opens — not only after a run settles.
  useEffect(() => {
    if (!root) return
    void refreshGit()
  }, [root, refreshGit])

  // Search the whole project, not just the folders that happen to be open.
  // The changed index filters in memory instead; it is already a status list.
  useEffect(() => {
    if (mode !== 'all') {
      setMatches(null)
      setSearching(false)
      setSearchError(false)
      return
    }
    const needle = query.trim()
    const version = ++searchVersion.current
    if (!needle) {
      setMatches(null)
      setSearching(false)
      setSearchError(false)
      return
    }
    let cancelled = false
    let requestStarted = false
    setMatches({ entries: [], truncated: false })
    setSearching(true)
    setSearchError(false)
    const timer = window.setTimeout(() => {
      requestStarted = true
      window.pi.fs
        .search(needle, undefined, 'file-tree')
        .then((found) => {
          if (
            !cancelled &&
            activeRoot.current === root &&
            searchVersion.current === version
          ) {
            setMatches(found)
            setSearchError(false)
          }
        })
        .catch(() => {
          if (
            !cancelled &&
            activeRoot.current === root &&
            searchVersion.current === version
          ) {
            setMatches({ entries: [], truncated: false })
            setSearchError(true)
          }
        })
        .finally(() => {
          if (
            !cancelled &&
            activeRoot.current === root &&
            searchVersion.current === version
          ) setSearching(false)
        })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (requestStarted) void window.pi.fs.search('', 0, 'file-tree').catch(() => undefined)
    }
  }, [query, root, mode])

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

  const toggleChanged = (dir: string) => {
    setCollapsedChanges((current) => {
      const next = new Set(current)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })
  }

  if (!root) {
    return <div className="drawer__empty">{t('Open a project folder to browse its files.')}</div>
  }

  const placeholder = mode === 'all' ? t('Filter files…') : t('Filter changed files…')

  /**
   * Selecting an index both chooses and folds it, the way a section list
   * behaves: pressing the open one closes it, pressing the other swaps them.
   */
  const selectIndex = (next: TreeMode) => {
    setIndexChosen(true)
    setMode(next)
    setQuery('')
    setMatches(null)
    setOpenIndex((current) => (current === next ? null : next))
  }

  return (
    <div className="tree" data-mode={mode}>
      <div className="tree__search">
        <Search size={13} />
        <input
          ref={searchInputRef}
          value={query}
          maxLength={MAX_SEARCH_QUERY_LENGTH}
          aria-label={t('Find files')}
          placeholder={placeholder}
          onChange={(event) => updateQuery(event.target.value)}
        />
        {query ? (
          <button
            className="icon-btn"
            onClick={() => {
              updateQuery('')
              searchInputRef.current?.focus()
            }}
            title={t('Clear')}
            aria-label={t('Clear')}
          >
            <X size={12} />
          </button>
        ) : null}
      </div>

      <div className="tree__index-head">
        <List size={12} aria-hidden="true" />
        {t('All changes')}
      </div>

      <div className="tree__index">
        <button
          type="button"
          className="tree__index-row"
          data-active={mode === 'changed' || undefined}
          data-open={openIndex === 'changed' || undefined}
          aria-expanded={openIndex === 'changed'}
          onClick={() => selectIndex('changed')}
        >
          <ChevronRight size={12} className="tree__index-caret" data-open={openIndex === 'changed'} />
          <span className="tree__index-name">{t('Changed files')}</span>
          {changedCount > 0 ? <span className="tree__index-dot" aria-hidden="true" /> : null}
        </button>

        <button
          type="button"
          className="tree__index-row"
          data-active={mode === 'all' || undefined}
          data-open={openIndex === 'all' || undefined}
          aria-expanded={openIndex === 'all'}
          onClick={() => selectIndex('all')}
        >
          <ChevronRight size={12} className="tree__index-caret" data-open={openIndex === 'all'} />
          <span className="tree__index-name">{t('All files')}</span>
        </button>

        {openIndex === 'all' ? (
          <div className="tree__index-body">
            {matches ? (
              <div className="tree__results">
                {searching ? <div className="tree__results-head">{t('Searching…')}</div> : null}
                {!searching && searchError ? (
                  <div className="tree__empty" data-kind="error">{t('The file search failed.')}</div>
                ) : null}
                {!searching && !searchError ? (
                  <div className="tree__results-head">
                    {`${matches.entries.length} ${matches.entries.length === 1 ? t('file') : t('files')} ${t('match')} “${query.trim()}”`}
                  </div>
                ) : null}
                {!searching && matches.truncated ? (
                  <div className="tree__empty">{t('Search stopped at its limit; results may be incomplete.')}</div>
                ) : null}
                {!searching && !searchError && matches.entries.length === 0 && !matches.truncated ? (
                  <div className="tree__empty">{t('Nothing found')}</div>
                ) : null}
                {matches.entries.map((entry) => {
                  const relative = relativePath(root, entry.path)
                  const folder = relative.slice(0, Math.max(0, relative.length - entry.name.length)).replace(/[\\/]+$/, '')
                  const change = changeFor(changes, entry.path, 'file')
                  return (
                    <button
                      key={entry.path}
                      className="tree__item tree__item--flat"
                      data-status={change}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData('application/x-pi-file', entry.path)
                        event.dataTransfer.effectAllowed = 'copy'
                      }}
                      onClick={() => onOpen(entry.path)}
                      title={entry.path}
                    >
                      <FileTypeIcon name={entry.name} />
                      <span className="tree__name">{entry.name}</span>
                      {folder ? (
                        <span className="tree__dir" title={folder}>
                          {folder}
                        </span>
                      ) : null}
                      {change ? <ChangeMark kind={change} /> : null}
                    </button>
                  )
                })}
              </div>
            ) : (
              <TreeLevel
                dir={root}
                depth={0}
                changes={changes}
                children={children}
                expanded={expanded}
                loading={loading}
                onToggle={toggle}
                onOpen={onOpen}
              />
            )}
          </div>
        ) : null}

        {openIndex === 'changed' ? (
          <div className="tree__index-body">
            {changedTree.length ? (
              <ChangedLevel
                nodes={changedTree}
                depth={0}
                collapsed={collapsedChanges}
                onToggle={toggleChanged}
                onOpen={onOpen}
              />
            ) : (
              <div className="tree__empty tree__empty--center">
                {query.trim() ? t('No changed file matches') : t('No changed files')}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** The changed index: a folder tree built from the status list alone. */
function ChangedLevel({
  nodes,
  depth,
  collapsed,
  onToggle,
  onOpen
}: {
  nodes: ChangedNode[]
  depth: number
  collapsed: Set<string>
  onToggle: (path: string) => void
  onOpen: (file: string) => void
}) {
  return (
    <ul className="tree__list" role="group">
      {nodes.map((node) => {
        if (node.kind === 'folder') {
          const open = !collapsed.has(node.path)
          return (
            <li key={node.path} role="treeitem" aria-expanded={open}>
              <button
                type="button"
                className="tree__item"
                data-kind="directory"
                data-change={node.change}
                style={{ paddingLeft: depth * INDENT + 6 }}
                onClick={() => onToggle(node.path)}
                title={node.path}
              >
                <ChevronRight size={12} className="tree__caret" data-open={open} />
                {open ? <FolderOpen size={14} /> : <Folder size={14} />}
                <span className="tree__name">{node.name}</span>
                <FolderMark kind={node.change} />
              </button>
              {open ? (
                <ChangedLevel
                  nodes={node.children}
                  depth={depth + 1}
                  collapsed={collapsed}
                  onToggle={onToggle}
                  onOpen={onOpen}
                />
              ) : null}
            </li>
          )
        }
        return (
          <li key={node.path} role="treeitem">
            <button
              type="button"
              className="tree__item"
              data-kind="file"
              data-change={node.change}
              style={{ paddingLeft: depth * INDENT + 6 }}
              onClick={() => onOpen(node.path)}
              title={node.path}
            >
              <span className="tree__caret-space" aria-hidden="true" />
              <FileTypeIcon name={node.name} />
              <span className="tree__name">{node.name}</span>
              <ChangeMark kind={node.change} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

interface TreeLevelProps {
  dir: string
  depth: number
  changes: ReturnType<typeof fileChangeIndex>
  children: Map<string, FileListResult>
  expanded: Set<string>
  loading: Set<string>
  onToggle: (dir: string) => void
  onOpen: (file: string) => void
}

/**
 * The all-files index: the real project tree from `fs:list`, unchanged in
 * shape. It still wears the type icon and the status mark, but a name keeps
 * its neutral colour here — this tab is for browsing, not for reviewing.
 */
function TreeLevel({
  dir,
  depth,
  changes,
  children,
  expanded,
  loading,
  onToggle,
  onOpen
}: TreeLevelProps) {
  const t = useT()
  const listing = children.get(dir)
  if (!listing) {
    return loading.has(dir) ? (
      <div className="tree__loading" style={{ paddingLeft: depth * INDENT + 18 }}>
        <Loader2 size={12} className="spin" />
      </div>
    ) : null
  }
  if (listing.entries.length === 0 && !listing.truncated) {
    return <div className="tree__empty" style={{ paddingLeft: depth * INDENT + 18 }}>{t('empty')}</div>
  }

  return (
    <>
      {listing.entries.length > 0 ? (
        <ul className="tree__list" role="group">
          {listing.entries.map((entry) => {
            const isOpen = expanded.has(entry.path)
            const directory = entry.kind === 'directory'
            const change = changeFor(changes, entry.path, directory ? 'directory' : 'file')
            return (
              <li
                key={entry.path}
                role="treeitem"
                aria-expanded={directory ? isOpen : undefined}
              >
                <button
                  className="tree__item"
                  data-kind={directory ? 'directory' : 'file'}
                  data-status={change}
                  data-open={directory ? isOpen || undefined : undefined}
                  style={{ paddingLeft: depth * INDENT + 6 }}
                  draggable={!directory}
                  onDragStart={
                    !directory
                      ? (event) => {
                          event.dataTransfer.setData('application/x-pi-file', entry.path)
                          event.dataTransfer.effectAllowed = 'copy'
                        }
                      : undefined
                  }
                  onClick={() => (directory ? onToggle(entry.path) : onOpen(entry.path))}
                  title={
                    !directory && entry.size !== undefined
                      ? `${entry.path} · ${formatBytes(entry.size)}`
                      : entry.path
                  }
                >
                  {directory ? (
                    <>
                      <ChevronRight size={12} className="tree__caret" data-open={isOpen} />
                      {isOpen ? <FolderOpen size={14} /> : <Folder size={14} />}
                    </>
                  ) : (
                    <>
                      <span className="tree__caret-space" aria-hidden="true" />
                      <FileTypeIcon name={entry.name} />
                    </>
                  )}
                  <span className="tree__name">{entry.name}</span>
                  {change ? (
                    directory ? <FolderMark kind={change} /> : <ChangeMark kind={change} />
                  ) : !directory && entry.size !== undefined ? (
                    <span className="tree__size">{formatBytes(entry.size)}</span>
                  ) : null}
                </button>
                {directory && isOpen ? (
                  <TreeLevel
                    dir={entry.path}
                    depth={depth + 1}
                    changes={changes}
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
      ) : null}
      {listing.truncated ? (
        <div className="tree__empty" style={{ paddingLeft: depth * INDENT + 18 }}>
          {t('Folder listing may be incomplete.')}
        </div>
      ) : null}
    </>
  )
}
