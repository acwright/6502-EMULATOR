import type { Machine } from '@core/Machine'
import { LINES_ASSERTED, SerialLink } from '@core/SerialPeer'
import type { SerialLines, SerialPeer } from '@core/SerialPeer'
import type { ISerialService } from './types'

/**
 * How often the machine's RTS is checked for a change to carry to the port,
 * and the port's last-read lines carried to the machine. The cadence the
 * port's lines are read at, too (`SIGNAL_POLL_MS` in `main/serial.ts`).
 */
const LINK_SYNC_MS = 1

/**
 * A real host serial port as the far end of the machine's serial card.
 *
 * While it is started the machine's RTS drives the port's RTS line, and the
 * port's CTS, DCD and DSR reach the chip wherever the card's jumpers connect
 * those pins to the cable. The OS does no RTS/CTS of its own. Stopped, nothing
 * is on the cable to drop a line, and the machine sees them asserted, as it
 * always has.
 *
 * The machine is looked up on each sync rather than held, because the app
 * replaces it on a power cycle to another video card.
 */
export class SerialPortPeer implements SerialPeer {
  lines: SerialLines = { ...LINES_ASSERTED }

  private link: SerialLink | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly service: Pick<ISerialService, 'setRequestToSend' | 'onSignals'>,
    private readonly machine: () => Machine | null | undefined
  ) {
    service.onSignals((signals) => {
      this.lines = { ...signals }
      this.sync()
    })
  }

  receiveRequestToSend(asserted: boolean): void {
    this.service.setRequestToSend(asserted)
  }

  /**
   * The port has connected. Until its lines are first read they are taken as
   * asserted, as a port that has just opened most likely has them, and the
   * machine's RTS goes out at once, whatever it last was.
   */
  start(): void {
    this.stop()
    this.lines = { ...LINES_ASSERTED }
    this.link = new SerialLink(this)
    this.sync()
    this.timer = setInterval(() => this.sync(), LINK_SYNC_MS)
  }

  /** The port has gone: nothing drives the lines, so the machine sees them asserted. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.link) this.machine()?.setSerialLines(LINES_ASSERTED)
    this.link = null
  }

  private sync(): void {
    const machine = this.machine()
    if (this.link && machine) this.link.sync(machine)
  }
}
