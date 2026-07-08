import { ref, onUnmounted } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'
import { createSerialService } from '@/services/serial'
import { DEFAULT_SERIAL_CONFIG } from '@shared/types'
import type { SerialConfig, SerialStatus } from '@shared/types'

export function useSerial() {
  const store = useEmulatorStore()
  const service = createSerialService()

  const status = ref<SerialStatus>('disconnected')
  const available = service.isAvailable()

  // Wire service callbacks: data → machine.onReceive, status → store + transmit
  const stopData = service.onData((bytes) => {
    for (let i = 0; i < bytes.length; i++) {
      store.machine?.onReceive(bytes[i]!)
    }
  })

  const stopStatus = service.onStatus((s) => {
    status.value = s
    store.serialConnected = s === 'connected'
    if (s === 'connected') {
      // Buffer outgoing bytes and flush every 10 ms to reduce IPC call frequency
      // (the ACIA can transmit ~1920 bytes/s at 19200 baud).
      let txBuf: number[] = []
      let flushTimer: ReturnType<typeof setTimeout> | null = null

      store.setTransmitCallback((byte: number) => {
        txBuf.push(byte)
        if (!flushTimer) {
          flushTimer = setTimeout(() => {
            if (txBuf.length > 0) {
              service.send(new Uint8Array(txBuf))
              txBuf = []
            }
            flushTimer = null
          }, 10)
        }
      })
    } else if (s === 'disconnected' || s === 'error') {
      store.setTransmitCallback(() => {})
    }
  })

  async function connect(config: SerialConfig = DEFAULT_SERIAL_CONFIG, portPath?: string) {
    try {
      await service.connect(config, portPath)
    } catch (err) {
      console.warn('[useSerial] connect failed:', err)
    }
  }

  async function disconnect() {
    await service.disconnect()
  }

  onUnmounted(() => {
    stopData()
    stopStatus()
    service.disconnect().catch(() => {})
    store.setTransmitCallback(() => {})
    store.serialConnected = false
  })

  return { available, status, connect, disconnect }
}
