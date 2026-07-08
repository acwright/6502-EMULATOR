import { IO } from '../IO'

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

}