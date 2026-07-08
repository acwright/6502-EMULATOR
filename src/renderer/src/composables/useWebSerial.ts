import { computed, onUnmounted } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'

declare global {
  interface Serial {
    requestPort(): Promise<SerialPort>
  }
  interface SerialPort {
    open(options: {
      baudRate: number
      dataBits?: number
      stopBits?: number
      parity?: string
    }): Promise<void>
    close(): Promise<void>
    readable: ReadableStream<Uint8Array> | null
    writable: WritableStream<Uint8Array> | null
  }
  interface Navigator {
    serial: Serial
  }
}

const BAUD_RATE = 19200

export function useWebSerial() {
  const store = useEmulatorStore()

  // Only available in browsers that support Web Serial (not Electron renderer).
  // Phase 3 adds an Electron serial path via window.api.serial.
  const serialAvailable = computed(() => 'serial' in navigator)

  let port: SerialPort | null = null
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let readLoopActive = false

  async function connect() {
    if (!serialAvailable.value || port) return

    const selected = await navigator.serial.requestPort()
    await selected.open({ baudRate: BAUD_RATE, dataBits: 8, stopBits: 1, parity: 'none' })
    port = selected

    store.setTransmitCallback((data: number) => {
      if (!port?.writable) return
      const writer = port.writable.getWriter()
      writer.write(new Uint8Array([data])).finally(() => writer.releaseLock())
    })

    store.serialConnected = true
    startReadLoop()
  }

  async function disconnect() {
    readLoopActive = false

    if (reader) {
      try { await reader.cancel() } catch { /* ignore */ }
      reader = null
    }

    if (port) {
      try { await port.close() } catch { /* ignore */ }
      port = null
    }

    store.setTransmitCallback(() => {})
    store.serialConnected = false
  }

  async function startReadLoop() {
    if (!port?.readable) return
    readLoopActive = true

    while (readLoopActive && port?.readable) {
      const r = port.readable.getReader()
      reader = r
      try {
        while (true) {
          const { value, done } = await r.read()
          if (done || !readLoopActive) break
          if (value) {
            for (let i = 0; i < value.length; i++) {
              store.machine?.onReceive(value[i]!)
            }
          }
        }
      } catch {
        // Port disconnected or read error — loop exits cleanly
      } finally {
        try { r.releaseLock() } catch { /* ignore */ }
        reader = null
      }
    }
  }

  onUnmounted(() => {
    disconnect()
  })

  return { serialAvailable, connect, disconnect }
}
