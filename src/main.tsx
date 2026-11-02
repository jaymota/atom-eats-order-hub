import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { isUpdateError, reloadForUpdate } from './lib/update'

window.addEventListener('vite:preloadError', (e) => { e.preventDefault(); reloadForUpdate() })
window.addEventListener('unhandledrejection', (e) => {
  if (isUpdateError(e.reason)) reloadForUpdate()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
