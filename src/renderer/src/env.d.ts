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

  /**
   * The Web Serial API, as much of it as `services/serial.ts` uses.
   *
   * Declared here rather than beside its one consumer because it is an ambient
   * browser API and TypeScript's own `dom` lib does not carry it yet.
   */
  interface Serial {
    requestPort(): Promise<SerialPort>
  }

  interface SerialPort {
    open(options: {
      baudRate: number
      dataBits?: number
      stopBits?: number
      parity?: string
      flowControl?: 'none' | 'hardware'
    }): Promise<void>
    close(): Promise<void>
    readable: ReadableStream<Uint8Array> | null
    writable: WritableStream<Uint8Array> | null
  }

  interface Navigator {
    serial: Serial
  }
}
