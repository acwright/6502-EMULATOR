import { ref } from 'vue'
import type { Ref } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'
import { createSerialService } from '@/services/serial'
import { SerialPortPeer } from '@/services/serialPortPeer'
import { DEFAULT_SERIAL_CONFIG } from '@shared/types'
import type { SerialConfig, SerialStatus } from '@shared/types'

/**
 * The machine's link to a real serial port on the host.
 *
 * Wired once for the life of the app rather than per component. Two sets of
 * callbacks on the one underlying service would hand every received byte to
 * `machine.onReceive` twice, and a connection is not the Settings panel's to
 * own — opening and closing that panel should not connect or disconnect
 * hardware. App.vue holds it; the panel and `6502 run --serial` both drive
 * this same one.
 *
 * The port is the far end of the machine's serial card (`SerialPortPeer`):
 * while it is connected, the machine's RTS drives the port's, and the port's
 * CTS, DCD and DSR reach the pins the card's jumpers connect to the cable.
 */
type Serial = {
  available: boolean
  status: Ref<SerialStatus>
  connect: (config?: SerialConfig, portPath?: string) => Promise<void>
  disconnect: () => Promise<void>
}

let shared: Serial | undefined

function createSerial(): Serial {
  const store = useEmulatorStore()
  const service = createSerialService()

  const status = ref<SerialStatus>('disconnected')
  const available = service.isAvailable()
  const peer = new SerialPortPeer(service, () => store.machine)

  // Wire service callbacks: data → machine.onReceive, status → store + transmit
  service.onData((bytes) => {
    for (let i = 0; i < bytes.length; i++) {
      store.machine?.onReceive(bytes[i]!)
    }
  })

  service.onStatus((s) => {
    status.value = s
    store.serialConnected = s === 'connected'
    if (s === 'connected') {
      peer.start()

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
      peer.stop()
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

  return { available, status, connect, disconnect }
}

export function useSerial(): Serial {
  shared ??= createSerial()
  return shared
}
