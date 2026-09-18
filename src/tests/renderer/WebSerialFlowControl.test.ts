import { createSerialService } from '../../renderer/src/services/serial'
import { DEFAULT_SERIAL_CONFIG } from '../../shared/types'
import type { SerialConfig } from '../../shared/types'

/**
 * How the web build opens a real port.
 *
 * The same rule as the desktop build's: the board raises RTS when its input
 * buffer fills, and Web Serial's `flowControl` defaults to `'none'`, so a port
 * opened without saying otherwise loses lines out of a long paste into a real
 * machine. See `SerialConfig.rtscts`.
 */

const opened: Record<string, unknown>[] = []

const fakePort = {
  open: async (options: Record<string, unknown>) => {
    opened.push(options)
  },
  close: async () => {},
  readable: null,
  writable: null
}

beforeEach(() => {
  opened.length = 0
  Object.defineProperty(globalThis, 'navigator', {
    value: { serial: { requestPort: async () => fakePort } },
    configurable: true
  })
})

async function openWith(config: SerialConfig): Promise<Record<string, unknown>> {
  const service = createSerialService()
  await service.connect(config)
  await service.disconnect()
  return opened[0]!
}

describe('the web build opening a serial port', () => {
  it('asks for hardware flow control by default', async () => {
    expect(await openWith({ ...DEFAULT_SERIAL_CONFIG })).toMatchObject({
      baudRate: 19200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'hardware'
    })
  })

  it('asks for none when that is what was chosen', async () => {
    expect(await openWith({ ...DEFAULT_SERIAL_CONFIG, rtscts: false })).toMatchObject({
      flowControl: 'none'
    })
  })

  it('asks for hardware for a config that predates the option', async () => {
    const legacy = { ...DEFAULT_SERIAL_CONFIG } as Partial<SerialConfig>
    delete legacy.rtscts

    expect(await openWith(legacy as SerialConfig)).toMatchObject({ flowControl: 'hardware' })
  })
})
