import type { Machine } from './Machine'
import type { SerialPin } from './IO/SerialCard'

/**
 * Whatever is on the far end of the serial card's cable.
 *
 * The card and its jumpers decide which of the chip's pins follow the cable
 * (see `IO/SerialCard.ts`); a peer decides what is on the cable. It owns two
 * things: the RTS the machine gives it, and the CTS, DCD and DSR it asserts.
 *
 * There are two kinds.
 *
 * - **A console or a pipe** (`SerialConsole` headless; the machine's own queue
 *   in `ACIA.tick` everywhere). It honours RTS or ignores it, which is the
 *   machine's `flowControl`, and its lines are asserted unless something says
 *   otherwise — a terminal with its port open asserts them.
 * - **A real host serial port**, in the app. The machine's RTS drives the
 *   port's real RTS line, and the port's real CTS, DCD and DSR are read back
 *   into the chip. The host's own `rtscts` stays off, so that it does not
 *   fight the machine for the line.
 *
 * A peer's lines only reach the chip where the card wires a pin to the cable.
 * With every jumper at ground, as by default, none of them do, and a peer that
 * drops CTS changes nothing.
 */
export interface SerialPeer {
  /**
   * The machine's RTS, each time it changes and once when the peer is linked:
   * true is asserted (the pin low, "you may send").
   */
  receiveRequestToSend(asserted: boolean): void

  /** The lines this peer drives: true is asserted. */
  readonly lines: Readonly<SerialLines>
}

/** CTS, DCD and DSR as the far end drives them: true is asserted. */
export type SerialLines = Record<SerialPin, boolean>

/** A peer with its port open and nothing to say: every line asserted. */
export const LINES_ASSERTED: Readonly<SerialLines> = Object.freeze({ cts: true, dcd: true, dsr: true })

/**
 * Carries a peer's side of the handshake to a machine and back.
 *
 * Both directions move only on change: RTS changes when the firmware writes
 * the command register, which is rare, and the lines change when the far end
 * moves them. `sync` is cheap enough to call on every chunk of execution.
 *
 * The machine is passed on each call rather than held, because a host can
 * replace its machine (a power cycle to another video card) under a link that
 * outlives it. A new machine starts from nothing known, so both directions are
 * sent afresh.
 */
export class SerialLink {
  private machine?: Machine
  private rts?: boolean
  private lines?: SerialLines

  constructor(readonly peer: SerialPeer) {}

  sync(machine: Machine): void {
    if (machine !== this.machine) {
      this.machine = machine
      this.rts = undefined
      this.lines = undefined
    }

    const rts = machine.requestToSend
    if (rts !== this.rts) {
      this.rts = rts
      this.peer.receiveRequestToSend(rts)
    }

    const lines = this.peer.lines
    if (!this.lines || !sameLines(lines, this.lines)) {
      this.lines = { ...lines }
      machine.setSerialLines(this.lines)
    }
  }
}

export function sameLines(a: Readonly<SerialLines>, b: Readonly<SerialLines>): boolean {
  return a.cts === b.cts && a.dcd === b.dcd && a.dsr === b.dsr
}
