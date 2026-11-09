import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, FolderSearch, ImageOff } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { basename, relativePath } from '../lib/path'
import { formatBytes } from '../lib/format'
import { useT } from '../lib/i18n'

/**
 * The project's pictures, opened in the inspector.
 *
 * The tree of the Files tab only lists folders until a file is opened, and a
 * picture is not worth reading as text — so this tab lists the images of the
 * project directly, draws the one that is picked and keeps the others in a
 * strip under it. It reads through `fs:readImageDataUrl`, which stays inside
 * the project.
 */

interface ProjectImage {
  path: string
  name: string
  size?: number
}

export function ImageViewer() {
  const t = useT()
  const workspace = useAppStore((state) => state.workspace)
  const [images, setImages] = useState<ProjectImage[] | undefined>(undefined)
  const [scanTruncated, setScanTruncated] = useState(false)
  const [active, setActive] = useState<string | null>(null)
  const [source, setSource] = useState<{ path: string; data: string } | null>(null)
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [error, setError] = useState(false)
  const [limit, setLimit] = useState(60)

  // The main process finds every picture in one walk; asking once per
  // extension made the page walk the whole project nine times.
  useEffect(() => {
    let cancelled = false
    setImages(undefined)
    setScanTruncated(false)
    setActive(null)
    setSource(null)
    setNatural(null)
    setError(false)
    if (!workspace?.path) {
      setImages([])
      return
    }
    void window.pi.fs
      .listImages()
      .then((result) => {
        if (cancelled) return
        const list = result.entries
          .filter((entry) => entry.kind === 'file')
          .map((entry) => ({
            path: entry.path,
            name: basename(entry.path) || entry.name,
            size: entry.size
          }))
        setImages(list)
        setScanTruncated(result.truncated)
        setActive((current) => current ?? list[0]?.path ?? null)
      })
      .catch(() => {
        if (!cancelled) {
          setImages([])
          setScanTruncated(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [workspace?.path])

  const visible = useMemo(() => (images ?? []).slice(0, limit), [images, limit])
  const activeSource = source?.path === active ? source.data : null

  useEffect(() => {
    let cancelled = false
    setSource(null)
    setError(false)
    setNatural(null)
    if (!active) return
    void window.pi.fs
      .readImageDataUrl(active)
      .then((data) => {
        if (cancelled) return
        setSource(data ? { path: active, data } : null)
        setError(!data)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [active])

  const activeInfo = (images ?? []).find((image) => image.path === active)

  return (
    <div className="image-viewer">
      <div className="image-viewer__stage">
        {activeSource ? (
          <img
            src={activeSource}
            alt={activeInfo?.name ?? ''}
            onLoad={(event) =>
              setNatural({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight
              })
            }
          />
        ) : error ? (
          <div className="image-viewer__empty">
            <ImageOff size={20} />
            <span>{t('This picture could not be read')}</span>
          </div>
        ) : images === undefined ? (
          <div className="image-viewer__empty">
            <span className="spinner" />
            <span>{t('Reading the pictures…')}</span>
          </div>
        ) : images.length === 0 ? (
          <div className="image-viewer__empty">
            <FolderSearch size={20} />
            <span>{t(scanTruncated ? 'Picture list may be incomplete' : 'This project has no pictures')}</span>
          </div>
        ) : (
          <div className="image-viewer__empty">
            <span>{t('Select a picture')}</span>
          </div>
        )}
      </div>

      {activeInfo ? (
        <div className="image-viewer__meta">
          <span className="image-viewer__name" title={relativePath(workspace?.path ?? '', activeInfo.path)}>
            {relativePath(workspace?.path ?? '', activeInfo.path)}
          </span>
          {natural ? (
            <span className="image-viewer__dim">
              {natural.width} × {natural.height}
            </span>
          ) : null}
          {typeof activeInfo.size === 'number' ? (
            <span className="image-viewer__dim">{formatBytes(activeInfo.size)}</span>
          ) : null}
          <span className="image-viewer__spacer" />
          {/* The meta line is narrow and the label wrapped to three lines; the
              icon carries the action and the tooltip says what it does. */}
          <button
            className="icon-btn"
            onClick={() => void window.pi.fs.reveal(activeInfo.path)}
            aria-label={t('Reveal in the file manager')}
            title={t('Reveal in the file manager')}
          >
            <ExternalLink size={13} />
          </button>
        </div>
      ) : null}

      {scanTruncated && images && images.length > 0 ? (
        <div className="image-viewer__limit-note">{t('Picture list may be incomplete')}</div>
      ) : null}

      {images && images.length > 0 ? (
        <div className="image-viewer__strip" role="listbox" aria-label={t('Pictures in this project')}>
          {visible.map((image) => (
            <button
              key={image.path}
              type="button"
              role="option"
              aria-selected={image.path === active}
              className="image-viewer__thumb"
              data-active={image.path === active}
              title={relativePath(workspace?.path ?? '', image.path)}
              onClick={() => setActive(image.path)}
            >
              <Thumb
                path={image.path}
                active={image.path === active}
                activeData={image.path === active ? activeSource : null}
              />
              <span className="image-viewer__thumb-name">{image.name}</span>
            </button>
          ))}
          {images.length > visible.length ? (
            <button
              type="button"
              className="image-viewer__more"
              onClick={() => setLimit((value) => value + 60)}
            >
              +{images.length - visible.length}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * One picture, loaded on demand.
 *
 * The page renders many paths at once, but only a few thumbnails are in view.
 * Load those on demand, use a smaller IPC byte limit than the main image, and
 * release their data URLs when they leave the strip's viewport.
 */
const MAX_THUMBNAIL_BYTES = 1024 * 1024

function Thumb({
  path,
  active,
  activeData
}: {
  path: string
  active: boolean
  activeData: string | null
}) {
  const target = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const [data, setData] = useState<string | null>(null)

  useEffect(() => {
    const node = target.current
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(Boolean(entry?.isIntersecting)),
      { rootMargin: '0px 96px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (active || activeData || !visible) {
      setData(null)
      return
    }
    let cancelled = false
    void window.pi.fs
      .readImageDataUrl(path, MAX_THUMBNAIL_BYTES)
      .then((value) => {
        if (!cancelled) setData(value)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [path, visible, active, activeData])

  const preview = visible ? (active ? activeData : data) : null
  return (
    <span className="image-viewer__thumb-media" ref={target}>
      {preview ? <img src={preview} alt="" decoding="async" /> : <span className="image-viewer__thumb-blank" />}
    </span>
  )
}
