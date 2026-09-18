/**
 * The far end of the serial cable: the peer, and the link that carries the
 * machine's RTS out to it and its CTS, DCD and DSR back in.
 *
 * The headless half boots the real bundled BIOS over a serial console, as
 * HeadlessHost.test.ts does, and is the proof S2 of the RTS/CTS plan asks for:
 * with `CTS EN` on the cable, a console that drops CTS holds the machine
 * silent — no banner, nothing — and with it at ground the same console
 * changes nothing. On the bench a KIM held that way for fourteen seconds
 * printed nothing, then the whole banner the moment CTS came back.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { Machine, DEFAULT_SERIAL_CARD as MACHINE_DEFAULT } from '../core/Machine'
import { ACIA } from '../core/IO/ACIA'
import { Empty } from '../core/IO/Empty'
import { LINES_ASSERTED, SerialLink } from '../core/SerialPeer'
import type { SerialLines, SerialPeer } from '../core/SerialPeer'
import { HeadlessHost } from '../host/headless/HeadlessHost'
import type { HeadlessOptions } from '../host/headless/HeadlessHost'
import { HeadlessTarget } from '../host/headless/HeadlessTarget'
import { createMethods } from '../debug/server/Methods'
import { DEFAULT_SERIAL_CARD } from '../shared/serialCard'

const BIOS = new Uint8Array(readFileSync(join(__dirname, '../../assets/roms/BIOS.bin')))

jest.setTimeout(60_000)

/** A peer that records the RTS it is given. */
class RecordingPeer implements SerialPeer {
  rts: boolean[] = []
  lines: SerialLines = { ...LINES_ASSERTED }
  receiveRequestToSend(asserted: boolean): void {
    this.rts.push(asserted)
  }
}

function acia(machine: Machine): ACIA {
  return machine.io5 as ACIA
}

describe('SerialLink', () => {
  it('gives the peer the machine\'s RTS once, then only when it changes', () => {
    const machine = new Machine()
    const peer = new RecordingPeer()
    const link = new SerialLink(peer)

    link.sync(machine) // reset: TIC 00, RTS high
    link.sync(machine)
    machine.write(0x9002, 0x09) // DTR on, TIC 10: RTS low
    link.sync(machine)
    link.sync(machine)
    machine.write(0x9002, 0x01) // TIC 00: RTS high again
    link.sync(machine)

    expect(peer.rts).toEqual([false, true, false])
  })

  it('carries the peer\'s lines to the chip, only when they change', () => {
    const machine = new Machine()
    machine.serialCard = { card: 'ace', jumpers: { cts: 'cable', dcd: 'cable' } }
    const peer = new RecordingPeer()
    const link = new SerialLink(peer)
    const setLines = jest.spyOn(machine, 'setSerialLines')

    link.sync(machine)
    link.sync(machine)
    peer.lines = { cts: false, dcd: true, dsr: false }
    link.sync(machine)
    link.sync(machine)

    expect(setLines.mock.calls.map(([lines]) => lines)).toEqual([
      { cts: true, dcd: true, dsr: true },
      { cts: false, dcd: true, dsr: false }
    ])
    expect(acia(machine).pinAsserted('cts')).toBe(false)
    expect(acia(machine).pinAsserted('dsr')).toBe(false)
  })

  it('starts afresh on a new machine, which knows nothing of the old one\'s lines', () => {
    const peer = new RecordingPeer()
    peer.lines = { cts: false, dcd: true, dsr: true }
    const link = new SerialLink(peer)
    const first = new Machine()
    first.serialCard = { card: 'pro', jumpers: {} }
    link.sync(first)

    const second = new Machine()
    second.serialCard = { card: 'pro', jumpers: {} }
    link.sync(second)

    expect(peer.rts).toEqual([false, false])
    expect(acia(second).cableLine('cts')).toBe(false)
  })

  it('reads RTS as not asserted on a machine with no serial card, which drives nothing', () => {
    expect(new Machine({ io5: new Empty() }).requestToSend).toBe(false)
  })
})

describe('the app and the machine agree on the default card', () => {
  it('is the ACE with both jumpers at ground in both places', () => {
    expect(DEFAULT_SERIAL_CARD).toEqual(MACHINE_DEFAULT)
  })
})

describe('a headless console as the far end of the cable', () => {
  function boot(options: Partial<HeadlessOptions> = {}) {
    let output = ''
    const host = new HeadlessHost({
      rom: BIOS,
      cf: new Uint8Array(64 * 1024),
      maxCycles: 2_000_000,
      onOutput: (data) => {
        output += Buffer.from(data).toString('binary')
      },
      ...options
    })
    return { host, read: () => output }
  }

  it('fits the ACE with both jumpers at ground unless told otherwise', () => {
    expect(boot().host.serialCard).toEqual({ card: 'ace', jumpers: { cts: 'ground', dcd: 'ground' } })
  })

  it('stalls the machine from reset when CTS EN is on the cable and the console drops CTS', async () => {
    const { host, read } = boot({
      serialCard: { card: 'ace', jumpers: { cts: 'cable' } },
      serialLines: { cts: false }
    })
    await host.run('turbo')
    expect(read()).toBe('')
    // Stalled, not dead: the byte is held and TDRE stays clear.
    const status = host.session.machine.read(0x9001)
    expect(status & 0x10).toBe(0)
  })

  it('changes nothing when CTS EN is at ground, whatever the console does with CTS', async () => {
    const { host, read } = boot({ serialLines: { cts: false } })
    await host.run('turbo')
    expect(read()).toContain('6502 BIOS')
  })

  it('prints the whole banner once CTS comes back, having lost nothing', () => {
    const { host, read } = boot({
      serialCard: { card: 'standard', jumpers: { cts: 'cable' } },
      serialLines: { cts: false }
    })
    host.session.runCycles(2_000_000)
    expect(read()).toBe('')

    host.setSerialLines({ cts: true })
    host.session.runCycles(2_000_000)

    // The same as a machine that was never held: `-- 6502 BIOS v1.6 --` and
    // the menu line, whole, as the bench saw it.
    const reference = boot()
    reference.host.session.runCycles(2_000_000)
    expect(reference.read()).toMatch(/6502 BIOS[^]*ENTER=BASIC  ESC=MONITOR\r\n$/)
    expect(read()).toBe(reference.read())
  })

  it('shows and moves the lines over the debug protocol', () => {
    const { host } = boot({ serialCard: { card: 'pro', jumpers: { dcd: 'cable' } } })
    const methods = createMethods(new HeadlessTarget(host, 'test'))

    expect(methods['session.info']!({})).toMatchObject({
      serialCard: { card: 'pro', jumpers: { dcd: 'cable' } }
    })
    expect(methods['serial.lines']!({ dcd: false, dsr: false })).toEqual({
      rts: false,
      lines: { cts: true, dcd: false, dsr: false },
      pins: {
        cts: { wiring: 'cable', asserted: true },
        dcd: { wiring: 'cable', asserted: false },
        dsr: { wiring: 'cable', asserted: false }
      }
    })
    // The status register follows the pins: DCD and DSR high read as bits 5 and 6.
    expect(host.session.machine.read(0x9001) & 0x60).toBe(0x60)
  })
})
