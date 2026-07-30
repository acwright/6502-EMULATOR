import type { DeviceState } from './DeviceState'

export interface IO {

  /**
   * What kind of card this is — 'video', 'sound', 'empty' and so on.
   *
   * A stable name rather than the class name, because a bundler is free to
   * mangle the latter and a snapshot taken by the desktop app has to be readable
   * by the headless host. It appears as `kind` in this card's serialized state,
   * and it is what lets a snapshot be checked against a machine's slot layout
   * without serializing every card to find out what they are.
   */
  readonly kind: string

  read(address: number): number
  write(address: number, data: number): void
  tick(frequency: number): number  // Returns interrupt status: bit 7 = IRQ, bit 6 = NMI
  reset(coldStart: boolean): void

  /**
   * This card's complete state, JSON-ready — everything that affects what it
   * will do next.
   *
   * Part of the interface rather than an optional extra so a card added later
   * cannot quietly omit snapshot support: a machine that silently restores seven
   * of its eight slots is worse than one that will not compile.
   */
  serialize(): DeviceState

  /**
   * Adopt a state produced by serialize(). Throws a StateError on anything it
   * cannot apply, leaving the caller to abandon the restore rather than run a
   * machine assembled from half a snapshot.
   */
  deserialize(state: DeviceState): void

}

export type { DeviceState }
