import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// StrictMode double-invokes effects in dev, which would boot the 3D engine twice.
// The engine guards against that itself (see Viewport), so it stays enabled.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
