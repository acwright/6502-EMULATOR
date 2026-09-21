import type { PortInfo, SerialConfig, SerialSignals, SerialStatus, CFSectorWrite } from '@shared/types'

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
  /** Drive the port's RTS line: true is asserted. */
  setRequestToSend(asserted: boolean): void
  /**
   * Subscribe to the port's CTS, DCD and DSR: once they are first read after
   * connecting, and each time they change. Returns an unsubscribe function.
   */
  onSignals(cb: (signals: SerialSignals) => void): () => void
}

export interface IPersistenceService {
  loadCF(): Promise<Uint8Array | null>
  saveCF(data: Uint8Array): Promise<void>
  /**
   * Persist only the sectors that changed. Platforms that can't write in place
   * fall back to a full saveCF() via `readFullImage`, which is only invoked when
   * that fallback is actually taken.
   */
  saveCFSectors(sectors: CFSectorWrite, readFullImage: () => Uint8Array): Promise<void>
  loadNVRAM(): Promise<Uint8Array | null>
  saveNVRAM(data: Uint8Array): Promise<void>
}

/**
 * Where one cartridge's flash overlay is kept (6502-VCS `PLAN.md` §4).
 *
 * A path when the cartridge came from one — `<stem>.sav` beside the `.crt`, so
 * that `6502-flash merge` can find it. A CRC-32 when it did not, which is every
 * cart chosen through a file picker, in the web build and in the app alike.
 */
export type CartSaveTarget =
  | { kind: 'file'; path: string }
  | { kind: 'db'; crc: string }

export interface ICartSaveService {
  /** The overlay already stored for this image, or null. */
  load(target: CartSaveTarget): Promise<Uint8Array | null>
  /**
   * Write the overlay. Rejects rather than swallowing: the running cart holds
   * the only copy of those sectors, so a caller that cleared its state on a
   * save that never happened would lose them.
   */
  save(target: CartSaveTarget, data: Uint8Array): Promise<void>
}
