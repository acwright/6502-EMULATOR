import { readFileSync } from 'node:fs'
import type { Session } from '../../debug/Session'
import type { SymbolTable } from '../../debug/symbols/Symbols'
import type { DebugTarget, SerialRead } from '../../debug/server/DebugTarget'
import type { HeadlessHost } from './HeadlessHost'

/**
 * Presents a headless machine to the debug protocol.
 *
 * Thin on purpose. Everything with behaviour lives either in the host (which
 * knows how to run a machine) or in the method table (which knows the
 * protocol); this only says which of the host's capabilities exist, which is
 * exactly what changes between hosts.
 */
export class HeadlessTarget implements DebugTarget {
  readonly hostName = 'headless'

  private readonly releaseOutput: () => void

  constructor(
    private readonly host: HeadlessHost,
    readonly version: string
  ) {
    // Something is going to ask for `serial.read` or wait on output, and the
    // host does not retain it otherwise.
    this.releaseOutput = host.retainOutput()
  }

  get session(): Session {
    return this.host.session
  }

  get symbols(): SymbolTable {
    return this.host.symbols
  }

  consoleMode(): 'serial' | 'video' {
    return this.host.consoleMode
  }

  writeSerial(data: Uint8Array): void {
    this.host.write(data)
  }

  readSerial(options: { since?: number; max?: number; clear?: boolean }): SerialRead {
    return this.host.readOutput(options)
  }

  onSerial(callback: (text: string) => void): () => void {
    return this.host.onSerialOutput((data) => {
      let text = ''
      for (const byte of data) text += String.fromCharCode(byte)
      callback(text)
    })
  }

  baudRate(): number {
    return this.host.baudRate
  }

  setBaudRate(rate: number): void {
    this.host.serial.baudRate = rate
  }

  readTextFile(path: string): string {
    return readFileSync(path, 'utf8')
  }

  readBinaryFile(path: string): Uint8Array {
    return new Uint8Array(readFileSync(path))
  }

  shutdown(): void {
    this.releaseOutput()
    this.host.stop('stopped')
  }
}
