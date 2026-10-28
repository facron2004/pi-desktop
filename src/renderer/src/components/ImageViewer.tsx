import { useEffect, useMemo, useState } from 'react'
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

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i

interface ProjectImage {
  path: string
  name: string
  size?: number
}

export function ImageViewer() {
  const t = useT()
  const workspace = useAppStore((state) => state.workspace)
  const [images, setImages] = useState<ProjectImage[] | undefined>(undefined)
  const [active, setActive] = useState<string | null>(null)
  const [source, setSource] = useState<string | null>(null)
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [error, setError] = useState(false)
  const [limit, setLimit] = useState(60)

  // `fs:search` already walks the project the way the file list does, so the
  // pictures are found without a second walker; the query is the extension.
  useEffect(() => {
    let cancelled = false
    setImages(undefined)
    setActive(null)
    setSource(null)
    setNatural(null)
    setError(false)
    if (!workspace?.path) {
      setImages([])
      return
    }
    const queries = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif']
    void Promise.all(queries.map((query) => window.pi.fs.search(query, 200).catch(() => [])))
      .then((lists) => {
        if (cancelled) return
        const seen = new Map<string, ProjectImage>()
        for (const entry of lists.flat()) {
          if (entry.kind !== 'file') continue
          if (!IMAGE_EXTENSIONS.test(entry.path)) continue
          // `fs:search` matches the path, so a folder named "images" brings
          // every file in it; the extension filter above is the real test.
          if (seen.has(entry.path)) continue
          seen.set(entry.path, {
            path: entry.path,
            name: basename(entry.path),
            size: entry.size
          })
        }
        const list = [...seen.values()].sort((a, b) => a.path.localeCompare(b.path))
        setImages(list)
        setActive((current) => current ?? list[0]?.path ?? null)
      })
      .catch(() => {
        if (!cancelled) setImages([])
      })
    return () => {
      cancelled = true
    }
  }, [workspace?.path])

  const visible = useMemo(() => (images ?? []).slice(0, limit), [images, limit])

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
        setSource(data)
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
        {source ? (
          <img
            src={source}
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
            <span>{t('This project has no pictures')}</span>
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
          <button
            className="ghost-btn"
            onClick={() => void window.pi.fs.reveal(activeInfo.path)}
            title={t('Show in the file manager')}
          >
            <ExternalLink size={11} />
            {t('Reveal')}
          </button>
        </div>
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
              <Thumb path={image.path} />
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
 * The strip can hold a hundred paths; reading them all at once would put every
 * byte of the project's artwork in memory. The `IntersectionObserver` would be
 * overkill for a strip that scrolls together, so each thumb loads when it
 * first renders and keeps its data URL afterwards.
 */
function Thumb({ path }: { path: string }) {
  const [data, setData] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.pi.fs
      .readImageDataUrl(path)
      .then((value) => {
        if (!cancelled) setData(value)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [path])
  return data ? <img src={data} alt="" loading="lazy" /> : <span className="image-viewer__thumb-blank" />
}
