import { IO, OPEN_BUS } from '../IO'
import { expectKind } from '../DeviceState'
import type { DeviceState } from '../DeviceState'

export class Empty implements IO {

  readonly kind = 'empty'

  /**
   * Nothing in the slot, so nothing drives the bus: the machine answers with the
   * last byte on it. Not `0` — a probe that accepted any value but `$00` and
   * `$FF` found a SID in an empty slot on the real machines, and this emulator
   * hid that by reading `$00`.
   */
  read(address: number): number {
    return OPEN_BUS
  }

  write(address: number, data: number): void {}
  tick(frequency: number): number { return 0 }
  reset(coldStart: boolean): void {}

  /**
   * A vacant slot has no state — but it still says so, so a snapshot taken with
   * an empty video slot (a serial-console boot) cannot be restored into a
   * machine that has a video card there. The two behave differently enough that
   * the BIOS picks a different console for each.
   */
  serialize(): DeviceState {
    return { kind: this.kind }
  }

  deserialize(state: DeviceState): void {
    expectKind(state, this.kind)
  }

}
