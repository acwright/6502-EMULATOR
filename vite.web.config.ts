import { resolve } from 'path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

/**
 * Standalone web build — targets src/renderer exactly like the electron-vite
 * renderer config but outputs a static site for GitHub Pages deployment.
 *
 * Build:   npm run build:web          → dist/web/
 * Preview: npm run preview:web        → localhost:4173/<base>/
 * Deploy:  .github/workflows/deploy.yml via GitHub Actions
 */
export default defineConfig({
  // GitHub Pages serves the repo at /6502-EMULATOR/.
  base: '/6502-EMULATOR/',

  // Treat src/renderer as the project root so Vite finds index.html there.
  root: resolve('src/renderer'),

  // Static files (audio-worklet-processor.js etc.) are in src/renderer/public/.
  publicDir: resolve('src/renderer/public'),

  build: {
    outDir: resolve('dist/web'),
    emptyOutDir: true,
    rollupOptions: {
      // Two entry points: the full app, and the iframe-sized embed. They share
      // everything below the component layer, so Rollup splits the common chunk
      // between them rather than shipping the emulator core twice.
      input: {
        index: resolve('src/renderer/index.html'),
        embed: resolve('src/renderer/embed.html')
      }
    }
  },

  resolve: {
    alias: {
      '@': resolve('src/renderer/src'),
      '@renderer': resolve('src/renderer/src'),
      '@core': resolve('src/core'),
      '@debug': resolve('src/debug'),
      '@shared': resolve('src/shared')
    }
  },

  plugins: [
    vue(),
    tailwindcss(),
    // Polyfill `buffer` — required by the emulator core on the browser.
    nodePolyfills({
      include: ['buffer']
    })
  ]
})
