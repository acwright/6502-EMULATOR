import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    publicDir: resolve('src/renderer/public'),
    resolve: {
      alias: {
        // @/ mirrors the WEBULATOR convention (src/renderer/src)
        '@': resolve('src/renderer/src'),
        '@renderer': resolve('src/renderer/src'),
        '@core': resolve('src/core'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [
      vue(),
      tailwindcss(),
      nodePolyfills({
        include: ['buffer']
      })
    ]
  }
})
