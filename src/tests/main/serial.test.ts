import { DEFAULT_SERIAL_CONFIG, IPC } from '../../shared/types'
import type { SerialConfig } from '../../shared/types'

/**
 * How the host's own serial port is opened and handshaken.
 *
 * The port is the far end of the emulated machine's serial card, not a
 * terminal for a real board. So the OS does no RTS/CTS of its own — it would
 * fight the machine for the RTS line — whatever an older settings file says.
 * Instead the machine's RTS drives the port's RTS, and the port's CTS, DCD and
 * DSR are polled and pushed to the renderer whenever they change.
 */

const opened: Record<string, unknown>[] = []
const sets: Record<string, unknown>[] = []
let lines = { cts: true, dsr: true, dcd: true }

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
    set(options: Record<string, unknown>, callback: (error?: Error | null) => void): void {
      sets.push(options)
      callback(null)
    }
    get(callback: (error: Error | null, status?: { cts: boolean; dsr: boolean; dcd: boolean }) => void): void {
      callback(null, { ...lines })
    }
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

/** A window that records what it is sent. */
function fakeWindow(): { sent: [string, unknown][]; win: never } {
  const sent: [string, unknown][] = []
  const win = {
    isDestroyed: () => false,
    webContents: { send: (channel: string, value: unknown) => sent.push([channel, value]) }
  }
  return { sent, win: win as never }
}

async function openWith(config: SerialConfig): Promise<Record<string, unknown>> {
  opened.length = 0
  const service = new SerialService()
  await service.connect('/dev/tty.usbserial', config)
  await service.disconnect()
  return opened[0]!
}

afterEach(() => {
  jest.useRealTimers()
  lines = { cts: true, dsr: true, dcd: true }
  sets.length = 0
})

describe('SerialService', () => {
  it('opens the port with the framing asked for and no RTS/CTS of the OS\'s own', async () => {
    expect(await openWith({ ...DEFAULT_SERIAL_CONFIG })).toMatchObject({
      path: '/dev/tty.usbserial',
      baudRate: 19200,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      rtscts: false
    })
  })

  it('ignores a saved rtscts, which is deprecated', async () => {
    expect(await openWith({ ...DEFAULT_SERIAL_CONFIG, rtscts: true })).toMatchObject({ rtscts: false })
    expect(await openWith({ ...DEFAULT_SERIAL_CONFIG, rtscts: false })).toMatchObject({ rtscts: false })
  })

  it('drives the port\'s RTS from the machine, restating DTR, which set() would otherwise drop', async () => {
    const service = new SerialService()
    await service.connect('/dev/tty.usbserial', DEFAULT_SERIAL_CONFIG)
    service.setRequestToSend(false)
    service.setRequestToSend(true)
    await service.disconnect()
    service.setRequestToSend(false) // closed: nothing to set

    expect(sets).toEqual([
      { rts: false, dtr: true, brk: false },
      { rts: true, dtr: true, brk: false }
    ])
  })

  it('polls CTS, DCD and DSR and pushes them once, then only when they change', async () => {
    jest.useFakeTimers()
    const { sent, win } = fakeWindow()
    const service = new SerialService()
    service.setWindow(win)
    await service.connect('/dev/tty.usbserial', DEFAULT_SERIAL_CONFIG)

    jest.advanceTimersByTime(5)
    lines = { cts: false, dsr: true, dcd: true }
    jest.advanceTimersByTime(5)
    await service.disconnect()
    lines = { cts: true, dsr: false, dcd: false }
    jest.advanceTimersByTime(5)

    expect(sent.filter(([channel]) => channel === IPC.SERIAL_SIGNALS).map(([, value]) => value)).toEqual([
      { cts: true, dcd: true, dsr: true },
      { cts: false, dcd: true, dsr: true }
    ])
  })
})
