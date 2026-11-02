import { Component, type ReactNode } from 'react'
import { useAppStore } from '../store/useAppStore'
import { translate } from '../lib/i18n'

interface State {
  error: Error | null
}

/**
 * The renderer's last line of defence.
 *
 * One uncaught error in a render or an effect unmounts the whole React tree,
 * which leaves a blank window with nothing to read. The boundary keeps the
 * failure visible instead: what broke, where, and one way back.
 */
export interface ErrorBoundaryProps {
  children: ReactNode
  fallback?: ReactNode | ((error: Error, retry: () => void) => ReactNode)
  scope?: string
  inline?: boolean
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // The dev console surfaces renderer errors to the terminal, so the same
    // message lands next to the app's own logs.
    console.error(`[pi-desktop] error in ${this.props.scope ?? 'interface'}:`, error, info.componentStack)
  }

  retry = () => {
    this.setState({ error: null })
  }

  override render() {
    const error = this.state.error
    if (!error) return this.props.children

    if (this.props.fallback) {
      if (typeof this.props.fallback === 'function') {
        return this.props.fallback(error, this.retry)
      }
      return this.props.fallback
    }

    const language = useAppStore.getState().settings.language ?? 'en'
    const t = (text: string) => translate(text, language)

    if (this.props.inline || this.props.scope) {
      return (
        <div className="component-error-fallback" role="alert">
          <span className="component-error-fallback__message">
            {this.props.scope
              ? `${t('Failed to render')} ${this.props.scope}`
              : t('Failed to render this section')}
          </span>
          <button type="button" className="btn btn--sm" onClick={this.retry}>
            {t('Retry')}
          </button>
        </div>
      )
    }

    return (
      <div className="crash-screen" role="alert">
        <div className="crash-screen__card">
          <h1 className="crash-screen__title">{t('The interface hit an error')}</h1>
          <p className="crash-screen__message">{error.message || String(error)}</p>
          {error.stack ? <pre className="crash-screen__stack">{error.stack}</pre> : null}
          <button
            type="button"
            className="btn"
            onClick={() => window.location.reload()}
          >
            {t('Reload the window')}
          </button>
        </div>
      </div>
    )
  }
}
