import { IO } from '../IO'
import { VTAC } from 'vtac-terminal'

/**
 * Terminal - Emulates the VTAC fantasy terminal
 *
 * Register Map:
 * $00: Data / Status Register
 *   Write: sends byte to VTAC for processing
 *   Read:  always returns 0 (bit 7 is a busy flag on the real device; busy is never set here)
 */
export class Terminal implements IO {

  raiseIRQ = () => {}
  raiseNMI = () => {}

  readonly vtac: VTAC = new VTAC()

  read(address: number): number {
    // Status register: bit 7 is busy flag on real device, never busy in emulation
    return 0
  }

  write(address: number, data: number): void {
    const register = address & 0x00
    if (register === 0x00) {
      this.vtac.parse(data)
    }
  }

  tick(frequency: number): void {}
  reset(coldStart: boolean): void {}

}