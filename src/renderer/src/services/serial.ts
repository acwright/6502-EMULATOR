import type { PortInfo, SerialConfig, SerialStatus } from '@shared/types'
import type { ISerialService } from './types'

// ── Helpers ──────────────────────────────────────────────────────────────────

function isElectron(): boolean {
  return typeof window !== 'undefined' && 'api' in window && !!window.api
}

// ── Web Serial Service ────────────────────────────────────────────────────────

class WebSerialService implements ISerialService {
  private dataCallbacks = new Set<(d: Uint8Array) => void>()
  private statusCallbacks = new Set<(s: SerialStatus) => void>()
  private port: SerialPort | null = null
  private readLoopActive = false

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
        parity: config.parity as 'none' | 'even' | 'odd'
      })
      this.port = selected
      this.emit('status', 'connected')
      this.startReadLoop()
    } catch (err) {
      this.emit('status', 'error')
      throw err
    }
  }

  async disconnect(): Promise<void> {
    this.readLoopActive = false
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

  constructor() {
    // Register IPC listeners once for the lifetime of this singleton.
    window.api!.serial.onData((data) => {
      this.dataCallbacks.forEach(cb => cb(data))
    })
    window.api!.serial.onStatus((status) => {
      this.statusCallbacks.forEach(cb => cb(status))
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
      await window.api!.serial.connect(portPath, config)
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
