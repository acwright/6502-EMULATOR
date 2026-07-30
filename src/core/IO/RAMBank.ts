import { IO } from '../IO'
import { StateError, expectKind, fromBase64, readNumber, toBase64 } from '../DeviceState'
import type { DeviceState } from '../DeviceState'

/**
 * RAMBank - Emulates banked RAM with 256KB total capacity
 * 
 * Provides 256KB of banked RAM divided into 256 banks of 1KB each.
 * A bank control register at address 0x3FF selects which bank is currently visible.
 * 
 * Address Map:
 * $000-$3FE: Bank data (1K window into selected bank)
 * $3FF: Bank control register (read/write)
 */
export class RAMBank implements IO {

  readonly kind = 'rambank'

  static TOTAL_SIZE: number = 256 * 1024 // 256k bytes
  static BANK_SIZE: number = 1024 // 1k per bank
  static NUM_BANKS: number = RAMBank.TOTAL_SIZE / RAMBank.BANK_SIZE // 256 banks
  static BANK_CONTROL_REGISTER: number = 0x3FF // Last byte in 1k window

  data: number[] = [...Array(RAMBank.TOTAL_SIZE)].fill(0x00)
  currentBank: number = 0

  /**
   * Read from RAM - all addresses read from the data array
   */
  read(address: number): number {
    return this.data[this.currentBank * RAMBank.BANK_SIZE + address]
  }

  /**
   * Write to RAM or bank control register
   * Writing to $3FF sets the bank AND writes through to the new bank's data
   */
  write(address: number, data: number): void {
    if (address === RAMBank.BANK_CONTROL_REGISTER) {
      this.currentBank = data & 0xFF
    }
    
    this.data[this.currentBank * RAMBank.BANK_SIZE + address] = data & 0xFF
  }
  
  /**
   * Tick - no timing behavior for RAM
   */
  tick(frequency: number): number { return 0 }
  
  /**
   * Reset the RAM card
   */
  reset(coldStart: boolean): void {
    if (coldStart) {
      this.currentBank = 0
      this.data.fill(0x00)
    }
  }

  /**
   * Only the banks that hold something.
   *
   * Two of these cards ship in the standard layout, 256 KB each, and a snapshot
   * that carried both in full would be 683 KB of base64 for state most programs
   * never touch. Skipping all-zero banks makes the common snapshot carry none of
   * it while a program that really does page through 256 banks still restores
   * exactly.
   */
  serialize(): DeviceState {
    const banks: Record<string, string> = {}

    for (let bank = 0; bank < RAMBank.NUM_BANKS; bank++) {
      const from = bank * RAMBank.BANK_SIZE
      const bytes = this.data.slice(from, from + RAMBank.BANK_SIZE)
      if (bytes.some((byte) => byte !== 0x00)) banks[String(bank)] = toBase64(bytes)
    }

    return { kind: this.kind, currentBank: this.currentBank, banks }
  }

  deserialize(state: DeviceState): void {
    expectKind(state, this.kind)
    const banks = state.banks
    if (typeof banks !== 'object' || banks === null || Array.isArray(banks)) {
      throw new StateError('rambank.banks: expected an object of bank index to base64')
    }

    // A bank absent from the snapshot was all zeros when it was taken, so the
    // card has to be cleared first rather than only overwritten where the
    // snapshot has data.
    this.data.fill(0x00)

    for (const [index, encoded] of Object.entries(banks as Record<string, unknown>)) {
      const bank = Number(index)
      if (!Number.isInteger(bank) || bank < 0 || bank >= RAMBank.NUM_BANKS) {
        throw new StateError(`rambank.banks: "${index}" is not a bank index`)
      }
      if (typeof encoded !== 'string') {
        throw new StateError(`rambank.banks[${index}]: expected base64`)
      }
      const bytes = fromBase64(encoded, `rambank.banks[${index}]`)
      if (bytes.length !== RAMBank.BANK_SIZE) {
        throw new StateError(
          `rambank.banks[${index}]: expected ${RAMBank.BANK_SIZE} bytes, got ${bytes.length}`
        )
      }
      const from = bank * RAMBank.BANK_SIZE
      for (let i = 0; i < RAMBank.BANK_SIZE; i++) this.data[from + i] = bytes[i]!
    }

    this.currentBank = readNumber(state, 'currentBank')
  }

}