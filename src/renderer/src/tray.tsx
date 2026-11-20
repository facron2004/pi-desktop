import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TrayPopup } from './components/TrayPopup'
import './styles/tray-popup.css'

const container = document.getElementById('tray-root')
if (!container) throw new Error('Tray popup root container is missing')

createRoot(container).render(
  <StrictMode>
    <TrayPopup />
  </StrictMode>
)
