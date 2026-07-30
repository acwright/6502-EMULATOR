import { IO } from '../IO'
import { expectKind } from '../DeviceState'
import type { DeviceState } from '../DeviceState'

export class Empty implements IO {

  readonly kind = 'empty'

  read(address: number): number {
    return 0
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
