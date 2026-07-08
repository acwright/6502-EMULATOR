import { SerialPort } from 'serialport'
import type { BrowserWindow } from 'electron'
import { IPC } from '../shared/types'
import type { PortInfo, SerialConfig, SerialStatus } from '../shared/types'

/**
 * Manages the native serial port connection in the main process.
 * Data received from the port is pushed to the renderer via IPC.SERIAL_DATA.
 * Status changes are pushed via IPC.SERIAL_STATUS.
 */
export class SerialService {
  private port: SerialPort | null = null
  private win: BrowserWindow | null = null

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
        autoOpen: false
      })

      sp.open((err) => {
        if (err) {
          this.pushStatus('error')
          reject(err)
          return
        }

        this.port = sp
        this.pushStatus('connected')

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
          this.port = null
          this.pushStatus('disconnected')
        })

        resolve()
      })
    })
  }

  async disconnect(): Promise<void> {
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

  private pushStatus(status: SerialStatus): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(IPC.SERIAL_STATUS, status)
    }
  }
}
