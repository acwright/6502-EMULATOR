import { SerialPort } from 'serialport'
import type { BrowserWindow } from 'electron'
import { IPC } from '../shared/types'
import type { PortInfo, SerialConfig, SerialSignals, SerialStatus } from '../shared/types'

/**
 * How often the port's CTS, DCD and DSR are read: about two byte-times at
 * 19,200 baud, which is about what a real cable's far end takes to respond.
 * Neither OS nor node-serialport says when a modem line moves, so they are
 * polled.
 */
export const SIGNAL_POLL_MS = 1

/**
 * Manages the native serial port connection in the main process.
 * Data received from the port is pushed to the renderer via IPC.SERIAL_DATA.
 * Status changes are pushed via IPC.SERIAL_STATUS.
 *
 * The port is the far end of the emulated machine's serial card. The machine
 * does the handshake, not the OS: its RTS arrives by `setRequestToSend` and
 * drives the port's RTS line, and the port's CTS, DCD and DSR are polled and
 * pushed via IPC.SERIAL_SIGNALS whenever they change.
 */
export class SerialService {
  private port: SerialPort | null = null
  private win: BrowserWindow | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private signals: SerialSignals | null = null

  setWindow(win: BrowserWindow): void {
    this.win = win
  }

  async listPorts(): Promise<PortInfo[]> {
    const ports = await SerialPort.list()
    return ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer,
      serialNumber: p.serialNumber,
      pnpId: p.pnpId
    }))
  }

  async connect(path: string, config: SerialConfig): Promise<void> {
    if (this.port?.isOpen) await this.disconnect()

    this.pushStatus('connecting')

    return new Promise<void>((resolve, reject) => {
      const sp = new SerialPort({
        path,
        baudRate: config.baudRate,
        dataBits: config.dataBits as 5 | 6 | 7 | 8,
        parity: config.parity as 'none' | 'odd' | 'even',
        stopBits: config.stopBits as 1 | 1.5 | 2,
        // Off whatever `config.rtscts` says (deprecated, ignored): the machine
        // drives RTS itself, and the OS doing RTS/CTS as well would fight it
        // for the line. See SerialConfig.rtscts.
        rtscts: false,
        autoOpen: false
      })

      sp.open((err) => {
        if (err) {
          this.pushStatus('error')
          reject(err)
          return
        }

        this.port = sp
        this.signals = null
        this.pushStatus('connected')
        this.startPolling(sp)

        sp.on('data', (chunk: Buffer) => {
          if (this.win && !this.win.isDestroyed()) {
            this.win.webContents.send(IPC.SERIAL_DATA, new Uint8Array(chunk))
          }
        })

        sp.on('error', (portErr: Error) => {
          console.error('[serial] port error:', portErr.message)
          this.pushStatus('error')
        })

        sp.on('close', () => {
          this.stopPolling()
          this.port = null
          this.pushStatus('disconnected')
        })

        resolve()
      })
    })
  }

  async disconnect(): Promise<void> {
    this.stopPolling()
    if (!this.port) return
    return new Promise<void>((resolve) => {
      if (!this.port?.isOpen) {
        this.port = null
        this.pushStatus('disconnected')
        resolve()
        return
      }
      this.port.close((err) => {
        if (err) console.error('[serial] close error:', err)
        this.port = null
        this.pushStatus('disconnected')
        resolve()
      })
    })
  }

  /**
   * Send bytes to the port. Called from the IPC handler for SERIAL_SEND which
   * is registered with ipcMain.on (fire-and-forget) for low-latency TX.
   */
  send(data: Uint8Array): void {
    if (!this.port?.isOpen) return
    this.port.write(Buffer.from(data), (err) => {
      if (err) console.error('[serial] write error:', err)
    })
  }

  /**
   * The machine's RTS: true is asserted. node-serialport's `set` writes every
   * modem flag each time, from defaults where not given, so DTR is restated
   * as asserted, which is how the port opened, and BRK as off.
   */
  setRequestToSend(asserted: boolean): void {
    if (!this.port?.isOpen) return
    this.port.set({ rts: asserted, dtr: true, brk: false }, (err) => {
      if (err) console.error('[serial] set RTS:', err.message)
    })
  }

  private startPolling(port: SerialPort): void {
    this.stopPolling()
    this.pollTimer = setInterval(() => this.poll(port), SIGNAL_POLL_MS)
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.polling = false
  }

  /**
   * Read the port's lines and push them if they moved. One read at a time: a
   * read that takes longer than the interval is not stacked up behind.
   */
  private poll(port: SerialPort): void {
    if (this.polling || !port.isOpen) return
    this.polling = true
    port.get((err, status) => {
      this.polling = false
      if (err || !status || port !== this.port) return
      const signals: SerialSignals = { cts: status.cts, dcd: status.dcd, dsr: status.dsr }
      const last = this.signals
      if (last && last.cts === signals.cts && last.dcd === signals.dcd && last.dsr === signals.dsr) return
      this.signals = signals
      if (this.win && !this.win.isDestroyed()) {
        this.win.webContents.send(IPC.SERIAL_SIGNALS, signals)
      }
    })
  }

  private pushStatus(status: SerialStatus): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(IPC.SERIAL_STATUS, status)
    }
  }
}
