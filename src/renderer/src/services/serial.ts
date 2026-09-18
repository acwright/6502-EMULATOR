import type { PortInfo, SerialConfig, SerialSignals, SerialStatus } from '@shared/types'
import type { ISerialService } from './types'

// ── Helpers ──────────────────────────────────────────────────────────────────

function isElectron(): boolean {
  return typeof window !== 'undefined' && 'api' in window && !!window.api
}

/**
 * How often the port's CTS, DCD and DSR are read. Web Serial, like the OS
 * underneath it, never says when a modem line moves. A browser clamps a
 * repeating timer to about 4 ms, so this is what is asked for rather than
 * what happens.
 */
const SIGNAL_POLL_MS = 1

// ── Web Serial Service ────────────────────────────────────────────────────────

class WebSerialService implements ISerialService {
  private dataCallbacks = new Set<(d: Uint8Array) => void>()
  private statusCallbacks = new Set<(s: SerialStatus) => void>()
  private signalCallbacks = new Set<(s: SerialSignals) => void>()
  private port: SerialPort | null = null
  private readLoopActive = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private signals: SerialSignals | null = null

  isAvailable(): boolean {
    return typeof navigator !== 'undefined' && 'serial' in navigator
  }

  async listPorts(): Promise<PortInfo[]> {
    // Web Serial requires a user gesture for requestPort; listing isn't supported.
    return []
  }

  async connect(config: SerialConfig, _portPath?: string): Promise<void> {
    if (!this.isAvailable() || this.port) return
    this.emit('status', 'connecting')
    try {
      const selected = await (navigator as Navigator & { serial: { requestPort(): Promise<SerialPort> } }).serial.requestPort()
      await selected.open({
        baudRate: config.baudRate,
        dataBits: config.dataBits as 7 | 8,
        stopBits: config.stopBits as 1 | 2,
        parity: config.parity as 'none' | 'even' | 'odd',
        // 'none' whatever `config.rtscts` says (deprecated, ignored): the
        // machine drives RTS itself, and the browser doing RTS/CTS as well
        // would fight it for the line. See SerialConfig.rtscts.
        flowControl: 'none'
      })
      this.port = selected
      this.signals = null
      this.emit('status', 'connected')
      this.startReadLoop()
      this.startPolling(selected)
    } catch (err) {
      this.emit('status', 'error')
      throw err
    }
  }

  async disconnect(): Promise<void> {
    this.readLoopActive = false
    this.stopPolling()
    if (this.port) {
      try { await this.port.close() } catch { /* ignore */ }
      this.port = null
    }
    this.emit('status', 'disconnected')
  }

  send(data: Uint8Array): void {
    if (!this.port?.writable) return
    const writer = this.port.writable.getWriter()
    writer.write(data).finally(() => writer.releaseLock())
  }

  onData(cb: (d: Uint8Array) => void): () => void {
    this.dataCallbacks.add(cb)
    return () => this.dataCallbacks.delete(cb)
  }

  onStatus(cb: (s: SerialStatus) => void): () => void {
    this.statusCallbacks.add(cb)
    return () => this.statusCallbacks.delete(cb)
  }

  setRequestToSend(asserted: boolean): void {
    this.port?.setSignals({ requestToSend: asserted }).catch(() => {
      // The port went away; the read loop reports that.
    })
  }

  onSignals(cb: (s: SerialSignals) => void): () => void {
    this.signalCallbacks.add(cb)
    return () => this.signalCallbacks.delete(cb)
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

  /** Read the lines and report them if they moved, one read at a time. */
  private async poll(port: SerialPort): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const read = await port.getSignals()
      if (port !== this.port) return
      const signals: SerialSignals = {
        cts: read.clearToSend,
        dcd: read.dataCarrierDetect,
        dsr: read.dataSetReady
      }
      const last = this.signals
      if (last && last.cts === signals.cts && last.dcd === signals.dcd && last.dsr === signals.dsr) return
      this.signals = signals
      this.signalCallbacks.forEach(cb => cb(signals))
    } catch {
      // The port went away; the read loop reports that.
    } finally {
      this.polling = false
    }
  }

  private emit(type: 'data', data: Uint8Array): void
  private emit(type: 'status', status: SerialStatus): void
  private emit(type: 'data' | 'status', value: Uint8Array | SerialStatus): void {
    if (type === 'data') {
      this.dataCallbacks.forEach(cb => cb(value as Uint8Array))
    } else {
      this.statusCallbacks.forEach(cb => cb(value as SerialStatus))
    }
  }

  private async startReadLoop(): Promise<void> {
    this.readLoopActive = true
    while (this.readLoopActive && this.port?.readable) {
      const reader = this.port.readable.getReader()
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done || !this.readLoopActive) break
          if (value) this.emit('data', value)
        }
      } catch {
        // Port disconnected or read error.
      } finally {
        try { reader.releaseLock() } catch { /* ignore */ }
      }
    }
    if (this.readLoopActive) {
      // Exited cleanly on done — treat as disconnect.
      this.stopPolling()
      this.port = null
      this.emit('status', 'disconnected')
    }
  }
}

// ── Electron Serial Service ───────────────────────────────────────────────────
//
// Thin wrapper over window.api.serial. The IPC handlers on the main-process
// side are wired up in Phase 4. Until then, connect() will throw (no handler
// registered), and the error is caught by useSerial which logs it.

class ElectronSerialService implements ISerialService {
  private dataCallbacks = new Set<(d: Uint8Array) => void>()
  private statusCallbacks = new Set<(s: SerialStatus) => void>()
  private signalCallbacks = new Set<(s: SerialSignals) => void>()

  constructor() {
    // Register IPC listeners once for the lifetime of this singleton.
    window.api!.serial.onData((data) => {
      this.dataCallbacks.forEach(cb => cb(data))
    })
    window.api!.serial.onStatus((status) => {
      this.statusCallbacks.forEach(cb => cb(status))
    })
    window.api!.serial.onSignals((signals) => {
      this.signalCallbacks.forEach(cb => cb(signals))
    })
  }

  isAvailable(): boolean {
    return true // window.api.serial is always present in the Electron preload
  }

  async listPorts(): Promise<PortInfo[]> {
    return window.api!.serial.listPorts()
  }

  async connect(config: SerialConfig, portPath?: string): Promise<void> {
    if (!portPath) {
      // Phase 6 adds the port-picker UI that supplies portPath.
      throw new Error('Electron serial: a port path is required. Use the serial port picker.')
    }
    // Optimistic local status; the main process sends the definitive status event.
    this.statusCallbacks.forEach(cb => cb('connecting'))
    try {
      // Copied, not passed through: callers hand us a `ref`'s value, and a Vue
      // reactive object is a Proxy, which the structured clone behind
      // contextBridge/IPC refuses ("An object could not be cloned"). Every
      // field of SerialConfig is a primitive, so a shallow copy is a plain
      // object again.
      await window.api!.serial.connect(portPath, { ...config })
    } catch (err) {
      this.statusCallbacks.forEach(cb => cb('error'))
      throw err
    }
  }

  async disconnect(): Promise<void> {
    await window.api!.serial.disconnect()
    // Definitive status comes from main via onStatus IPC event.
  }

  send(data: Uint8Array): void {
    window.api!.serial.send(data)
  }

  setRequestToSend(asserted: boolean): void {
    window.api!.serial.setRequestToSend(asserted)
  }

  onSignals(cb: (s: SerialSignals) => void): () => void {
    this.signalCallbacks.add(cb)
    return () => this.signalCallbacks.delete(cb)
  }

  onData(cb: (d: Uint8Array) => void): () => void {
    this.dataCallbacks.add(cb)
    return () => this.dataCallbacks.delete(cb)
  }

  onStatus(cb: (s: SerialStatus) => void): () => void {
    this.statusCallbacks.add(cb)
    return () => this.statusCallbacks.delete(cb)
  }
}

// ── Factory (singletons per platform) ────────────────────────────────────────

let _web: WebSerialService | null = null
let _electron: ElectronSerialService | null = null

export function createSerialService(): ISerialService {
  if (isElectron()) {
    if (!_electron) _electron = new ElectronSerialService()
    return _electron
  }
  if (!_web) _web = new WebSerialService()
  return _web
}
