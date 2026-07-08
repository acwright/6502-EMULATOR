/// <reference types="vite/client" />

import type { AppApi } from '@shared/api'

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

declare global {
  interface Window {
    /** Present in the Electron renderer (set by contextBridge). Undefined in web builds. */
    api?: AppApi
  }
}
