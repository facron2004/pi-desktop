import { useEffect, useRef, useState } from 'react'
import { Copy, FolderOpen, Images, Loader2, WandSparkles } from 'lucide-react'
import type { GeneratedImage } from '@shared/types'
import {
  DEFAULT_IMAGE_OUTPUT_DIR,
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_IMAGE_SIZE,
  IMAGE_MODELS,
  IMAGE_QUALITIES,
  IMAGE_SIZES
} from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { formatBytes } from '../lib/format'
import { useT } from '../lib/i18n'
import '../styles/image-generation.css'

/** Recent results are metadata only; the pictures themselves stay on disk. */
const HISTORY_LIMIT = 12

function historyKey(workspacePath: string): string {
  return `pi-desktop.image-history.${workspacePath}`
}

function readHistory(key: string): GeneratedImage[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is GeneratedImage =>
        Boolean(item) && typeof item === 'object' &&
        typeof (item as GeneratedImage).path === 'string' &&
        typeof (item as GeneratedImage).name === 'string')
      .slice(0, HISTORY_LIMIT)
  } catch {
    return []
  }
}

/**
 * A tool-panel page that draws a picture from a prompt through the local
 * Magpie gateway (`image:generate` in the main process).
 *
 * The page keeps no copy of the picture: the main process writes it into the
 * project's output folder, so it shows up in the Images page, can be revealed,
 * and can be referenced with `@` like any other project file. Only the last
 * few results are remembered, per project, in localStorage.
 */
export function ImageGeneration() {
  const t = useT()
  const workspacePath = useAppStore((state) => state.workspace?.path ?? '')
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const showToast = useAppStore((state) => state.showToast)

  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState(settings.imageModel ?? '')
  const [size, setSize] = useState(settings.imageSize ?? DEFAULT_IMAGE_SIZE)
  const [quality, setQuality] = useState(settings.imageQuality ?? DEFAULT_IMAGE_QUALITY)
  const [count, setCount] = useState(1)
  const [busyWorkspacePaths, setBusyWorkspacePaths] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState('')
  const [results, setResults] = useState<GeneratedImage[]>(() =>
    readHistory(historyKey(workspacePath)))
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const requested = useRef(new Set<string>())
  const currentWorkspacePath = useRef(workspacePath)
  currentWorkspacePath.current = workspacePath
  const busy = busyWorkspacePaths.has(workspacePath)

  // History and thumbnails belong to the project, not to the panel visit.
  useEffect(() => {
    requested.current.clear()
    setResults(readHistory(historyKey(workspacePath)))
    setPreviews({})
    setError('')
  }, [workspacePath])

  // The same verified file read the Images page uses, so a generated picture
  // is never trusted as an arbitrary path from localStorage.
  useEffect(() => {
    let cancelled = false
    for (const image of results) {
      if (requested.current.has(image.path)) continue
      requested.current.add(image.path)
      void window.pi.fs.readImageDataUrl(image.path)
        .then((data) => {
          if (!cancelled && data) {
            setPreviews((current) => ({ ...current, [image.path]: data }))
          }
        })
        .catch(() => { /* a moved file simply keeps its placeholder */ })
    }
    return () => { cancelled = true }
  }, [results])

  const generate = async () => {
    const text = prompt.trim()
    if (!text || busy) return
    if (!window.pi.images?.generate) {
      setError(t('Image generation is not available in this build'))
      return
    }
    const requestWorkspacePath = workspacePath
    setBusyWorkspacePaths((current) => new Set(current).add(requestWorkspacePath))
    setError('')
    try {
      const images = await window.pi.images.generate({
        prompt: text,
        model,
        size,
        quality,
        n: count
      })
      const key = historyKey(requestWorkspacePath)
      const next = [...images, ...readHistory(key)].slice(0, HISTORY_LIMIT)
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch { /* a full quota must not lose the on-screen result */ }
      if (currentWorkspacePath.current === requestWorkspacePath) setResults(next)
      void updateSettings({ imageModel: model, imageSize: size, imageQuality: quality })
    } catch (cause) {
      if (currentWorkspacePath.current === requestWorkspacePath) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      setBusyWorkspacePaths((current) => {
        if (!current.has(requestWorkspacePath)) return current
        const next = new Set(current)
        next.delete(requestWorkspacePath)
        return next
      })
    }
  }

  const reveal = (image: GeneratedImage) => {
    void window.pi.fs.reveal(image.path)
  }

  const copyPath = async (image: GeneratedImage) => {
    try {
      await navigator.clipboard.writeText(image.path)
      showToast(t('Path copied to clipboard'))
    } catch {
      showToast(t('Could not copy to the clipboard'), 'error')
    }
  }

  const openImagesPage = () => {
    window.dispatchEvent(
      new CustomEvent<{ view: 'images' }>('pi:open-tool-page', { detail: { view: 'images' } })
    )
  }

  return (
    <div className="image-gen">
      <div className="image-gen__head">
        <span className="image-gen__title">
          <WandSparkles size={15} aria-hidden="true" />
          {t('Image generation')}
        </span>
        <span className="image-gen__subtitle">{t('Generate images from a prompt')}</span>
      </div>

      <div className="image-gen__form">
        <label className="image-gen__label" htmlFor="image-gen-prompt">
          {t('Prompt')}
        </label>
        <textarea
          id="image-gen-prompt"
          className="image-gen__prompt"
          value={prompt}
          maxLength={4000}
          placeholder={t('Describe the image you want…')}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              void generate()
            }
          }}
        />

        <div className="image-gen__fields">
          <label className="image-gen__field">
            <span>{t('Model')}</span>
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              <option value="">{t('Gateway default')}</option>
              {IMAGE_MODELS.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
          <label className="image-gen__field">
            <span>{t('Size')}</span>
            <select value={size} onChange={(event) => setSize(event.target.value)}>
              {IMAGE_SIZES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="image-gen__field">
            <span>{t('Quality')}</span>
            <select value={quality} onChange={(event) => setQuality(event.target.value)}>
              {IMAGE_QUALITIES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="image-gen__field">
            <span>{t('Count')}</span>
            <select value={count} onChange={(event) => setCount(Number(event.target.value))}>
              {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>

        <div className="image-gen__actions">
          <button
            type="button"
            className="image-gen__generate"
            disabled={busy || !prompt.trim()}
            onClick={() => void generate()}
          >
            {busy
              ? <Loader2 size={14} className="spin" aria-hidden="true" />
              : <WandSparkles size={14} aria-hidden="true" />}
            {busy ? t('Generating…') : t('Generate')}
          </button>
          <span className="image-gen__hint">
            {t('Saved to {dir}').replace('{dir}', settings.imageOutputDir || DEFAULT_IMAGE_OUTPUT_DIR)}
          </span>
        </div>
        {error ? <p className="image-gen__error" role="alert">{error}</p> : null}
      </div>

      <div className="image-gen__results-head">
        <span>{t('Recent images')}</span>
        {results.length ? (
          <button type="button" className="image-gen__link" onClick={openImagesPage}>
            <Images size={13} aria-hidden="true" />
            {t('View in Images page')}
          </button>
        ) : null}
      </div>

      {results.length === 0 ? (
        <p className="image-gen__empty">{t('No images generated yet')}</p>
      ) : (
        <ul className="image-gen__grid">
          {results.map((image) => (
            <li className="image-gen__card" key={image.path}>
              <div className="image-gen__thumb">
                {previews[image.path] ? (
                  <img src={previews[image.path]} alt={image.prompt} />
                ) : (
                  <span className="image-gen__thumb-empty"><Images size={20} aria-hidden="true" /></span>
                )}
              </div>
              <div className="image-gen__card-body">
                <span className="image-gen__name" title={image.name}>{image.name}</span>
                <span className="image-gen__meta">
                  {[image.model || t('Gateway default'), formatBytes(image.size)].join(' · ')}
                </span>
                <span className="image-gen__prompt-text" title={image.prompt}>{image.prompt}</span>
                <div className="image-gen__card-actions">
                  <button type="button" onClick={() => reveal(image)}>
                    <FolderOpen size={13} aria-hidden="true" />
                    {t('Reveal in the file manager')}
                  </button>
                  <button type="button" onClick={() => void copyPath(image)}>
                    <Copy size={13} aria-hidden="true" />
                    {t('Copy path')}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
