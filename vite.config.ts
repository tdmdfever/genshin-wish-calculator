import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command, isPreview }) => ({
  plugins: [react()],
  // GitHub Pages project site: served from /<repo-name>/ in production (and local preview of it), not in dev.
  base: command === 'build' || isPreview ? '/genshin-wish-calculator/' : '/',
}))
