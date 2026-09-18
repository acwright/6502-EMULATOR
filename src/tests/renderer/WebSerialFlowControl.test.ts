import { createSerialService } from '../../renderer/src/services/serial'
import { DEFAULT_SERIAL_CONFIG } from '../../shared/types'
import type { SerialConfig, SerialSignals } from '../../shared/types'

/**
 * How the web build opens and handshakes a real port.
 *
 * The same rule as the desktop build's: the port is the far end of the
 * emulated machine's serial card, so the browser does no RTS/CTS of its own
 * (`flowControl: 'none'`) whatever an older setting says. The machine's RTS
 * drives the port's through `setSignals`, and the port's CTS, DCD and DSR are
 * read with `getSignals` and reported when they change.
 */

const opened: Record<string, unknown>[] = []
const setSignals: Record<string, unknown>[] = []
let signals = { clearToSend: true, dataCarrierDetect: true, dataSetReady: true, ringIndicator: false }

const fakePort = {
  open: async (options: Record<string, unknown>) => {
    opened.push(options)
  },
  close: async () => {},
  getSignals: async () => ({ ...signals }),
  setSignals: async (options: Record<string, unknown>) => {
    setSignals.push(options)
  },
  // Open and silent, as a real port with nothing to say is. A null here
  // would end the read loop at once, which reads as the port going away.
  readable: null as ReadableStream<Uint8Array> | null,
  writable: null
}

beforeEach(() => {
  opened.length = 0
  setSignals.length = 0
  fakePort.readable = new ReadableStream<Uint8Array>()
  signals = { clearToSend: true, dataCarrierDetect: true, dataSetReady: true, ringIndicator: false }
  Object.defineProperty(globalThis, 'navigator', {
    value: { serial: { requestPort: async () => fakePort } },
    configurable: true
  })
})

afterEach(() => {
  jest.useRealTimers()
})

async function openWith(config: SerialConfig): Promise<Record<string, unknown>> {
  const service = createSerialService()
  await service.connect(config)
  await service.disconnect()
  return opened[0]!
}

/** Let the pending promise callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('the web build opening a serial port', () => {
  it('asks for no flow control of the browser\'s own', async () => {
    expect(await openWith({ ...DEFAULT_SERIAL_CONFIG })).toMatchObject({
      baudRate: 19200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none'
    })
  })

  it('ignores a saved rtscts, which is deprecated', async () => {
    expect(await openWith({ ...DEFAULT_SERIAL_CONFIG, rtscts: true })).toMatchObject({ flowControl: 'none' })
  })

  it('drives the port\'s RTS from the machine', async () => {
    const service = createSerialService()
    await service.connect(DEFAULT_SERIAL_CONFIG)
    service.setRequestToSend(false)
    service.setRequestToSend(true)
    await service.disconnect()

    expect(setSignals).toEqual([{ requestToSend: false }, { requestToSend: true }])
  })

  it('reports CTS, DCD and DSR once, then only when they change', async () => {
    jest.useFakeTimers()
    const service = createSerialService()
    const seen: SerialSignals[] = []
    const off = service.onSignals((s) => seen.push(s))
    await service.connect(DEFAULT_SERIAL_CONFIG)

    for (let i = 0; i < 3; i++) {
      jest.advanceTimersByTime(1)
      await settle()
    }
    signals = { ...signals, clearToSend: false }
    for (let i = 0; i < 3; i++) {
      jest.advanceTimersByTime(1)
      await settle()
    }
    await service.disconnect()
    off()

    expect(seen).toEqual([
      { cts: true, dcd: true, dsr: true },
      { cts: false, dcd: true, dsr: true }
    ])
  })
})
