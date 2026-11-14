import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles/base/controls.css'
import './styles/global.css'
import './styles/ui-polish.css'
import './styles/plan.css'
import './styles/base/focus.css'

const container = document.getElementById('root')
if (!container) throw new Error('Root container is missing')

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
