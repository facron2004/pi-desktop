import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw } from 'lucide-react'
import { useT } from '../lib/i18n'

/**
 * A browser in the inspector.
 *
 * The project's pages are often the thing being built, and a reader that has to
 * leave the app to look at `localhost:3000` loses the conversation. This is a
 * `<webview>`: a page of its own, sandboxed, with no preload and no bridge to
 * the app, so a page that is looked at can never reach the app's runtime.
 *
 * The history buttons follow the view's own events rather than a local guess —
 * a page can navigate itself.
 */

interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>
  reload(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
}

const HOME = 'https://www.google.com/'

export function BrowserView() {
  const t = useT()
  const viewRef = useRef<WebviewElement | null>(null)
  const [address, setAddress] = useState('')
  const [loaded, setLoaded] = useState('')
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const syncNavigation = useCallback((view: WebviewElement) => {
    try {
      setCanBack(view.canGoBack())
      setCanForward(view.canGoForward())
    } catch {
      /* the view can be gone while an event is still queued */
    }
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    const onDomReady = () => {
      try {
        // The webview's own methods exist once its guest page is attached.
        setCanForward(false)
      } catch {
        /* ignore */
      }
    }
    const onStart = () => {
      setLoading(true)
      setFailed(false)
    }
    const onStop = () => {
      setLoading(false)
      const url = view.getURL?.() ?? ''
      setLoaded(url)
      setAddress((current) => (current ? current : url))
      syncNavigation(view)
    }
    const onNavigated = (event: Event) => {
      const url = (event as unknown as { url?: string }).url ?? view.getURL?.() ?? ''
      setLoaded(url)
      setAddress(url)
      syncNavigation(view)
    }
    const onFail = () => {
      setLoading(false)
      setFailed(true)
    }

    view.addEventListener('dom-ready', onDomReady)
    view.addEventListener('did-start-loading', onStart)
    view.addEventListener('did-stop-loading', onStop)
    view.addEventListener('did-navigate', onNavigated)
    view.addEventListener('did-navigate-in-page', onNavigated)
    view.addEventListener('did-fail-load', onFail as EventListener)
    return () => {
      view.removeEventListener('dom-ready', onDomReady)
      view.removeEventListener('did-start-loading', onStart)
      view.removeEventListener('did-stop-loading', onStop)
      view.removeEventListener('did-navigate', onNavigated)
      view.removeEventListener('did-navigate-in-page', onNavigated)
      view.removeEventListener('did-fail-load', onFail as EventListener)
    }
  }, [syncNavigation])

  /**
   * What the reader meant by the text in the box: an address, a local page, or
   * words to search for. A bare `localhost:3000` is the common case while
   * building, so it becomes `http://localhost:3000`.
   */
  const resolve = (raw: string): string => {
    const value = raw.trim()
    if (!value) return ''
    if (/^https?:\/\//i.test(value)) return value
    if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i.test(value)) return `http://${value}`
    if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(value)) return `https://${value}`
    return `https://www.google.com/search?q=${encodeURIComponent(value)}`
  }

  const navigate = (event: React.FormEvent) => {
    event.preventDefault()
    const url = resolve(address)
    if (!url) return
    setFailed(false)
    void viewRef.current?.loadURL(url).catch(() => setFailed(true))
  }

  return (
    <div className="browser-pane">
      <form className="browser-bar" onSubmit={navigate}>
        <button
          type="button"
          className="icon-btn"
          aria-label={t('Back')}
          title={t('Back')}
          disabled={!canBack}
          onClick={() => viewRef.current?.goBack()}
        >
          <ArrowLeft size={13} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={t('Forward')}
          title={t('Forward')}
          disabled={!canForward}
          onClick={() => viewRef.current?.goForward()}
        >
          <ArrowRight size={13} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={t('Reload')}
          title={t('Reload')}
          onClick={() => viewRef.current?.reload()}
        >
          <RotateCw size={13} className={loading ? 'spin' : undefined} />
        </button>
        <div className="browser-bar__address">
          <Globe size={12} />
          <input
            value={address}
            placeholder={t('Search or enter an address')}
            aria-label={t('Search or enter an address')}
            spellCheck={false}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label={t('Open in the system browser')}
          title={t('Open in the system browser')}
          disabled={!/^https?:\/\//i.test(loaded)}
          onClick={() => void window.pi.shell.openExternal(loaded)}
        >
          <ExternalLink size={13} />
        </button>
      </form>

      <div className="browser-pane__view">
        <webview ref={viewRef as never} src={HOME} />
      </div>

      {failed ? (
        <div className="browser-pane__note" role="status">
          {t('That page did not load')}
        </div>
      ) : null}
    </div>
  )
}
