import { DEFAULT_SERIAL_CONFIG } from '../../shared/types'
import type { SerialConfig } from '../../shared/types'

/**
 * How the host's own serial port is opened.
 *
 * The app is a terminal whenever it is cabled to a real board, and the board's
 * firmware raises RTS when its input buffer fills. node-serialport leaves
 * `rtscts` off, so a port opened without saying otherwise is exactly the
 * terminal 6502-DOCS tells owners not to use: a long paste into a real machine
 * loses lines. The default here is on, and a settings file written before the
 * option existed says nothing, so it gets the default too.
 */

const opened: Record<string, unknown>[] = []

jest.mock('serialport', () => ({
  SerialPort: class {
    isOpen = false
    constructor(options: Record<string, unknown>) {
      opened.push(options)
    }
    open(callback: (error?: Error) => void): void {
      this.isOpen = true
      callback()
    }
    on(): void {}
    close(callback: (error?: Error) => void): void {
      this.isOpen = false
      callback()
    }
    static list(): Promise<unknown[]> {
      return Promise.resolve([])
    }
  }
}))

import { SerialService } from '../../main/serial'

async function openWith(config: SerialConfig): Promise<Record<string, unknown>> {
  opened.length = 0
  const service = new SerialService()
  await service.connect('/dev/tty.usbserial', config)
  return opened[0]!
}

describe('SerialService', () => {
  it('opens the port with RTS/CTS by default', async () => {
    expect(await openWith({ ...DEFAULT_SERIAL_CONFIG })).toMatchObject({
      path: '/dev/tty.usbserial',
      baudRate: 19200,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      rtscts: true
    })
  })

  it('turns RTS/CTS off when that is what was chosen', async () => {
    expect(await openWith({ ...DEFAULT_SERIAL_CONFIG, rtscts: false })).toMatchObject({
      rtscts: false
    })
  })

  it('does RTS/CTS for a config that predates the option', async () => {
    const legacy = { ...DEFAULT_SERIAL_CONFIG } as Partial<SerialConfig>
    delete legacy.rtscts

    expect(await openWith(legacy as SerialConfig)).toMatchObject({ rtscts: true })
  })
})
