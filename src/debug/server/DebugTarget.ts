import type { Session } from '../Session'
import type { SymbolTable } from '../symbols/Symbols'

/** Retained console output, positioned in the stream it came from. */
export interface SerialRead {
  data: string
  /** Total bytes the console has produced — the stream position after `data`. */
  cursor: number
  /** True when output before the requested `since` had already been dropped. */
  truncated: boolean
}

/**
 * What the method table needs from whichever host it is serving.
 *
 * The point of the indirection is that there will be two hosts. The headless
 * process owns its `Session` directly; the Electron main process reaches one
 * across IPC in the renderer (§4.3). Both implement this, so the two can never
 * drift into serving different protocols.
 *
 * Everything optional is a genuine capability question — a machine booted with
 * a video console has no serial path, and a host without a filesystem cannot
 * load a symbol file by path — and the method table reports a missing one as
 * NOT_SUPPORTED rather than pretending.
 */
export interface DebugTarget {
  readonly session: Session

  /** Symbols loaded so far. Shared with the session's condition resolver. */
  readonly symbols: SymbolTable

  /** Identifies the host in `session.info`. */
  readonly hostName: string
  readonly version: string

  /** Which device the BIOS is using as its console. */
  consoleMode(): 'serial' | 'video'

  //
  // Serial console
  //

  /** Queue bytes for the machine's console, paced at the line rate. */
  writeSerial?(data: Uint8Array): void

  /**
   * Console output the host has buffered, positioned in the output stream.
   *
   * The cursor is what makes "wait for the reply to what I just sent" reliable.
   * Between one RPC call and the next the machine can run millions of cycles in
   * turbo, so a reply routinely arrives before a listener could be attached;
   * reading from an absolute position instead of "from now" removes the race.
   */
  readSerial?(options: { since?: number; max?: number; clear?: boolean }): SerialRead

  /** Subscribe to console output as it is produced. Returns an unsubscribe. */
  onSerial?(callback: (text: string) => void): () => void

  baudRate?(): number
  setBaudRate?(rate: number): void

  //
  // Host filesystem
  //

  readTextFile?(path: string): string
  readBinaryFile?(path: string): Uint8Array

  //
  // Lifecycle
  //

  /** End the session. The server answers first, then the host winds down. */
  shutdown?(): void
}
