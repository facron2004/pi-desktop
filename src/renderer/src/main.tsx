import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import '@xterm/xterm/css/xterm.css'
import './styles/tokens.css'
import './styles/base/controls.css'
import './styles/global.css'
import './styles/terminal.css'
import './styles/plan.css'
import './styles/ui-polish.css'

const container = document.getElementById('root')
if (!container) throw new Error('Root container is missing')

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
