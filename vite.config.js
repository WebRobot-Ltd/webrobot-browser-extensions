import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Build the side-panel SPA (Vue) into ui-dist/. The per-browser build scripts
// (package.json) then assemble dist/chrome|firefox by combining this UI with
// the content/background scripts + the right manifest.
export default defineConfig({
  root: 'src/sidepanel',
  base: './', // relative asset paths — required inside an extension package
  plugins: [vue()],
  build: {
    outDir: '../../ui-dist',
    emptyOutDir: true,
  },
})
