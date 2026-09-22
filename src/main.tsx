import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Fonts: IBM Plex, self-hosted (no third-party requests). Only these weights are loaded; using a new
// weight or style means importing its CSS here.
import '@fontsource/ibm-plex-serif/600.css'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/400-italic.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
// The style guide (design tokens), then the base styles built on it. Imported here, not with a CSS
// @import, so editing the tokens live-reloads in dev.
import './styles/tokens.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
