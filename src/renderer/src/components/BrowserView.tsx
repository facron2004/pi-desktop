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
 * a page can navigate itself. The mouse's back and forward keys are not clicks
 * the page owns; the main process walks this view's history for them.
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

/** A URL the app shell asked this page to load, with a counter so the same
 *  address requested twice still counts as two requests. */
export interface BrowserRequest {
  url: string
  seq: number
}

export function BrowserView({ request }: { request?: BrowserRequest | null } = {}) {
  const t = useT()
  const viewRef = useRef<WebviewElement | null>(null)
  const [address, setAddress] = useState('')
  const [loaded, setLoaded] = useState('')
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [loading, setLoading] = useState(false)
  // A failure carries what the reader needs to judge it: the page and the reason.
  const [failure, setFailure] = useState<{ url: string; reason: string } | null>(null)

  // A link the reader opened inside the app lands here. The address box shows
  // it at once, and the view is remounted on `seq` so a repeated request for
  // the same page still performs a navigation instead of looking ignored.
  const requestedUrl = request?.url ?? ''
  useEffect(() => {
    if (!requestedUrl) return
    setAddress(requestedUrl)
    setFailure(null)
  }, [requestedUrl, request?.seq])

  const syncNavigation = useCallback((view: WebviewElement) => {
    try {
      setCanBack(view.canGoBack())
      setCanForward(view.canGoForward())
    } catch {
      /* the view can be gone while an event is still queued */
    }
  }, [])

  const requestSeq = request?.seq ?? 0
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
      setFailure(null)
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
    const onFail = (event: Event) => {
      const detail = event as unknown as {
        errorCode?: number
        errorDescription?: string
        isMainFrame?: boolean
        validatedURL?: string
      }
      // A failed subframe (an ad, an embedded player) is not the page failing,
      // and -3 is a navigation another one replaced: neither is news.
      if (detail.isMainFrame === false) return
      if (detail.errorCode === -3) return
      setLoading(false)
      setFailure({
        url: detail.validatedURL || view.getURL?.() || '',
        reason: (detail.errorDescription || '').replace(/^ERR_/, '')
      })
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
  }, [syncNavigation, requestSeq])

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
    setFailure(null)
    void viewRef.current?.loadURL(url).catch(() => {
      // The event carries Chromium's reason; keep it when it already arrived.
      setFailure((current) => current ?? { url, reason: '' })
    })
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
        <webview
          key={`browser-${request?.seq ?? 0}`}
          ref={viewRef as never}
          src={requestedUrl || HOME}
        />
      </div>

      {failure ? (
        <div className="browser-pane__note" role="status">
          <span className="browser-pane__note-title">{t('That page did not load')}</span>
          {failure.reason ? (
            <span className="browser-pane__note-reason">{failure.reason}</span>
          ) : null}
          {failure.url ? (
            <span className="browser-pane__note-url" title={failure.url}>
              {failure.url}
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              setFailure(null)
              viewRef.current?.reload()
            }}
          >
            {t('Try again')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
