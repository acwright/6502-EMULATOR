import type { PortInfo, SerialConfig, SerialStatus } from '@shared/types'

export interface ISerialService {
  /** Whether this service can connect to serial ports on the current platform. */
  isAvailable(): boolean
  /** Electron: list detected ports. Web: always returns []. */
  listPorts(): Promise<PortInfo[]>
  /**
   * Open a connection.
   * - Web path: ignores `portPath`, triggers browser's port-picker dialog.
   * - Electron path: `portPath` is required (supplied by the port-picker UI in Phase 6).
   */
  connect(config: SerialConfig, portPath?: string): Promise<void>
  disconnect(): Promise<void>
  /** Send raw bytes to the connected port. */
  send(data: Uint8Array): void
  /** Subscribe to incoming data bytes. Returns an unsubscribe function. */
  onData(cb: (data: Uint8Array) => void): () => void
  /** Subscribe to connection status changes. Returns an unsubscribe function. */
  onStatus(cb: (status: SerialStatus) => void): () => void
}

export interface IPersistenceService {
  loadCF(): Promise<Uint8Array | null>
  saveCF(data: Uint8Array): Promise<void>
  loadNVRAM(): Promise<Uint8Array | null>
  saveNVRAM(data: Uint8Array): Promise<void>
}
