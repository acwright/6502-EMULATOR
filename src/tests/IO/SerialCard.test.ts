import { ACIA } from '../../core/IO/ACIA'
import { Empty } from '../../core/IO/Empty'
import { Machine, DEFAULT_SERIAL_CARD } from '../../core/Machine'
import { SERIAL_CARDS, jumpersOf, normalizeSerialCard, pinSources } from '../../core/IO/SerialCard'
import type { SerialCardConfig } from '../../core/IO/SerialCard'

// DTR on, receive IRQ on, TIC 10 (RTS low, transmitter on): what the BIOS writes.
const READY = 0x09

const TDRE = 0x10
const DCD_HIGH = 0x20
const DSR_HIGH = 0x40
const IRQ = 0x80

describe('Serial cards and their jumpers', () => {
  describe('the wiring table', () => {
    it('gives each card only its own jumpers', () => {
      expect(jumpersOf('standard')).toEqual(['cts'])
      expect(jumpersOf('pro')).toEqual(['dcd'])
      expect(jumpersOf('ace')).toEqual(['cts', 'dcd'])
    })

    it('labels each jumper as the silkscreen does', () => {
      expect(SERIAL_CARDS.standard.jumperLabels).toEqual({ cts: 'CTS EN' })
      expect(SERIAL_CARDS.pro.jumperLabels).toEqual({ dcd: 'DCD Select' })
      expect(SERIAL_CARDS.ace.jumperLabels).toEqual({ cts: 'CTS EN', dcd: 'DCD EN' })
    })

    it('never puts a jumper on DSR', () => {
      for (const spec of Object.values(SERIAL_CARDS)) {
        expect(spec.wiring.dsr).not.toBe('jumper')
      }
    })

    it('drops a jumper the card lacks, and puts a missing one at ground', () => {
      expect(normalizeSerialCard({ card: 'standard', jumpers: { dcd: 'cable' } }))
        .toEqual({ card: 'standard', jumpers: { cts: 'ground' } })
      expect(normalizeSerialCard({ card: 'pro', jumpers: { cts: 'cable', dcd: 'cable' } }))
        .toEqual({ card: 'pro', jumpers: { dcd: 'cable' } })
      expect(normalizeSerialCard({ card: 'ace', jumpers: {} }))
        .toEqual({ card: 'ace', jumpers: { cts: 'ground', dcd: 'ground' } })
    })

    it.each<[SerialCardConfig, ReturnType<typeof pinSources>]>([
      [{ card: 'standard', jumpers: { cts: 'ground' } }, { cts: 'ground', dcd: 'ground', dsr: 'ground' }],
      [{ card: 'standard', jumpers: { cts: 'cable' } }, { cts: 'cable', dcd: 'ground', dsr: 'ground' }],
      [{ card: 'pro', jumpers: { dcd: 'ground' } }, { cts: 'cable', dcd: 'ground', dsr: 'cable' }],
      [{ card: 'pro', jumpers: { dcd: 'cable' } }, { cts: 'cable', dcd: 'cable', dsr: 'cable' }],
      [{ card: 'ace', jumpers: { cts: 'ground', dcd: 'ground' } }, { cts: 'ground', dcd: 'ground', dsr: 'cable' }],
      [{ card: 'ace', jumpers: { cts: 'cable', dcd: 'cable' } }, { cts: 'cable', dcd: 'cable', dsr: 'cable' }]
    ])('wires %j as %j', (config, sources) => {
      expect(pinSources(config)).toEqual(sources)
    })
  })

  describe('the ACIA on a card', () => {
    let acia: ACIA
    let sent: number[]

    const fit = (config: SerialCardConfig): void => {
      acia.serialCard = config
    }

    const deassertAll = (): void => {
      acia.setCableLine('cts', false)
      acia.setCableLine('dcd', false)
      acia.setCableLine('dsr', false)
    }

    beforeEach(() => {
      acia = new ACIA()
      sent = []
      acia.transmit = (byte) => sent.push(byte)
      acia.write(0x02, READY)
    })

    it('is a Serial Card with CTS EN at ground until fitted otherwise', () => {
      expect(acia.serialCard).toEqual({ card: 'standard', jumpers: { cts: 'ground' } })
      for (const pin of ['cts', 'dcd', 'dsr'] as const) {
        expect(acia.pinSourceOf(pin)).toBe('ground')
      }
    })

    it('keeps only the jumpers the card has', () => {
      fit({ card: 'pro', jumpers: { cts: 'cable', dcd: 'cable' } })
      expect(acia.serialCard).toEqual({ card: 'pro', jumpers: { dcd: 'cable' } })
    })

    describe('CTS', () => {
      it.each<SerialCardConfig>([
        { card: 'standard', jumpers: { cts: 'ground' } },
        { card: 'ace', jumpers: { cts: 'ground', dcd: 'ground' } }
      ])('at ground never stops the transmitter (%j)', (config) => {
        fit(config)
        acia.setCableLine('cts', false)

        acia.write(0x00, 0x41)
        acia.tick(1000000)

        expect(sent).toEqual([0x41])
        expect(acia.read(0x01) & TDRE).toBe(TDRE)
      })

      it.each<SerialCardConfig>([
        { card: 'standard', jumpers: { cts: 'cable' } },
        { card: 'pro', jumpers: { dcd: 'ground' } },
        { card: 'ace', jumpers: { cts: 'cable', dcd: 'ground' } }
      ])('on the cable, deasserted, stops the transmitter (%j)', (config) => {
        fit(config)
        acia.setCableLine('cts', false)

        expect(acia.transmitterEnabled).toBe(false)
        acia.write(0x00, 0x41)
        for (let i = 0; i < 10; i++) acia.tick(1000000)

        expect(sent).toEqual([])
        expect(acia.read(0x01) & TDRE).toBe(0)
      })

      it('holds one byte, overwritten by the next write, and sends the last on release', () => {
        // The bench: four writes during the gate, TDRE clear after each, and
        // exactly one byte — the last — out when CTS came back.
        fit({ card: 'pro', jumpers: { dcd: 'ground' } })
        acia.setCableLine('cts', false)

        for (const byte of [0x31, 0x32, 0x33, 0x34]) {
          acia.write(0x00, byte)
          acia.tick(1000000)
          expect(acia.read(0x01) & TDRE).toBe(0)
        }
        expect(sent).toEqual([])

        acia.setCableLine('cts', true)
        acia.tick(1000000)
        acia.tick(1000000)

        expect(sent).toEqual([0x34])
        expect(acia.read(0x01) & TDRE).toBe(TDRE)
      })

      it('has no status bit', () => {
        fit({ card: 'pro', jumpers: { dcd: 'ground' } })
        const before = acia.read(0x01)
        acia.setCableLine('cts', false)
        expect(acia.read(0x01)).toBe(before)
      })

      it('does not stop the receiver', () => {
        fit({ card: 'pro', jumpers: { dcd: 'ground' } })
        acia.setCableLine('cts', false)

        acia.onData(0x5A)
        acia.tick(1000000)

        expect(acia.read(0x00)).toBe(0x5A)
      })
    })

    describe('DCD', () => {
      it.each<SerialCardConfig>([
        { card: 'standard', jumpers: { cts: 'ground' } },
        { card: 'pro', jumpers: { dcd: 'ground' } },
        { card: 'ace', jumpers: { cts: 'ground', dcd: 'ground' } }
      ])('at ground never stops the receiver (%j)', (config) => {
        fit(config)
        acia.setCableLine('dcd', false)

        acia.onData(0x5A)
        acia.tick(1000000)

        expect(acia.read(0x01) & 0x08).toBe(0x08)
        expect(acia.read(0x00)).toBe(0x5A)
      })

      it.each<SerialCardConfig>([
        { card: 'pro', jumpers: { dcd: 'cable' } },
        { card: 'ace', jumpers: { cts: 'ground', dcd: 'cable' } }
      ])('on the cable, deasserted, stops the receiver and loses the byte (%j)', (config) => {
        // The bench: a Z sent with DCD high was never answered, not even once
        // DCD came back; a later Y was answered at once.
        fit(config)
        acia.setCableLine('dcd', false)
        expect(acia.receiverEnabled).toBe(false)

        acia.onData(0x5A)
        acia.tick(1000000)
        expect(acia.read(0x01) & 0x08).toBe(0)
        expect(acia.tick(1000000)).toBe(0)

        acia.setCableLine('dcd', true)
        acia.tick(1000000)
        expect(acia.read(0x01) & 0x08).toBe(0)

        acia.onData(0x59)
        acia.tick(1000000)
        expect(acia.read(0x00)).toBe(0x59)
      })

      it('does not stop the transmitter', () => {
        fit({ card: 'pro', jumpers: { dcd: 'cable' } })
        acia.setCableLine('dcd', false)

        acia.write(0x00, 0x41)
        acia.tick(1000000)

        expect(sent).toEqual([0x41])
      })
    })

    describe('DSR', () => {
      it('is a status bit and gates nothing', () => {
        // The bench: with only DSR high, a Z was answered in 20 ms.
        fit({ card: 'pro', jumpers: { dcd: 'ground' } })
        acia.setCableLine('dsr', false)

        expect(acia.read(0x01) & DSR_HIGH).toBe(DSR_HIGH)
        expect(acia.receiverEnabled).toBe(true)
        expect(acia.transmitterEnabled).toBe(true)

        acia.onData(0x5A)
        acia.tick(1000000)
        expect(acia.read(0x00)).toBe(0x5A)
      })

      it('reads 0 on the Serial Card, where it is tied to ground', () => {
        acia.setCableLine('dsr', false)
        expect(acia.read(0x01) & DSR_HIGH).toBe(0)
      })
    })

    describe('the status register tracks the pins, active low', () => {
      it('reads $10, $70, $50 as the bench did', () => {
        // A Serial Card Pro at rest; then the far end's DTR, arriving as DSR
        // and DCD, deasserted; then DCD Select moved to ground. Each change
        // interrupts, so the first read after it also has bit 7 — on the bench
        // the BIOS's IRQ handler took that read, and the probe saw the second.
        fit({ card: 'pro', jumpers: { dcd: 'cable' } })
        expect(acia.read(0x01)).toBe(TDRE)

        acia.setCableLines({ dsr: false, dcd: false })
        expect(acia.read(0x01)).toBe(IRQ | TDRE | DSR_HIGH | DCD_HIGH)
        expect(acia.read(0x01)).toBe(TDRE | DSR_HIGH | DCD_HIGH)

        fit({ card: 'pro', jumpers: { dcd: 'ground' } })
        expect(acia.read(0x01)).toBe(IRQ | TDRE | DSR_HIGH)
        expect(acia.read(0x01)).toBe(TDRE | DSR_HIGH)
      })

      it('reads DCD and DSR as 0 on every card with its jumpers at ground and the far end asserting', () => {
        for (const card of ['standard', 'pro', 'ace'] as const) {
          fit({ card, jumpers: {} })
          expect(acia.read(0x01) & (DCD_HIGH | DSR_HIGH)).toBe(0)
        }
      })
    })

    describe('a change on DCD or DSR interrupts, and latches the status bits', () => {
      beforeEach(() => {
        fit({ card: 'pro', jumpers: { dcd: 'cable' } })
        acia.read(0x01)
      })

      it.each(['dcd', 'dsr'] as const)('%s going high or low drives IRQB', (pin) => {
        acia.setCableLine(pin, false)
        expect(acia.tick(1000000)).toBe(0x80)
        acia.read(0x01)
        expect(acia.tick(1000000)).toBe(0)

        acia.setCableLine(pin, true)
        expect(acia.tick(1000000)).toBe(0x80)
        expect(acia.read(0x01) & (IRQ | DCD_HIGH | DSR_HIGH)).toBe(IRQ)
      })

      it('interrupts with IRD set: only the receiver is masked by it', () => {
        acia.write(0x02, READY | 0x02)
        acia.setCableLine('dsr', false)
        expect(acia.tick(1000000)).toBe(0x80)
      })

      it('sets bit 7 but does not drive IRQB with DTR off', () => {
        acia.write(0x02, 0x00)
        acia.setCableLine('dsr', false)
        expect(acia.tick(1000000)).toBe(0)
        expect(acia.read(0x01)).toBe(IRQ | TDRE | DSR_HIGH)
      })

      it('holds the bits still until the status register is read', () => {
        acia.setCableLine('dcd', false)
        acia.setCableLine('dsr', false)
        acia.setCableLine('dcd', true)

        // The first change latched; the rest wait for the read.
        expect(acia.read(0x01)).toBe(IRQ | TDRE | DCD_HIGH)
        // The read samples again: DSR has moved and DCD has come back, so
        // another interrupt, with the new levels.
        expect(acia.tick(1000000)).toBe(0x80)
        expect(acia.read(0x01)).toBe(IRQ | TDRE | DSR_HIGH)
        expect(acia.read(0x01)).toBe(TDRE | DSR_HIGH)
        expect(acia.tick(1000000)).toBe(0)
      })

      it('reports a pulse gone before the read with two interrupts', () => {
        acia.setCableLine('dcd', false)
        acia.setCableLine('dcd', true)

        expect(acia.read(0x01)).toBe(IRQ | TDRE | DCD_HIGH)
        expect(acia.read(0x01)).toBe(IRQ | TDRE)
        expect(acia.read(0x01)).toBe(TDRE)
      })

      it('sees lines driven together as one change', () => {
        acia.setCableLines({ dcd: false, dsr: false })
        expect(acia.read(0x01)).toBe(IRQ | TDRE | DCD_HIGH | DSR_HIGH)
        expect(acia.read(0x01)).toBe(TDRE | DCD_HIGH | DSR_HIGH)
      })

      it('interrupts when a jumper moves the pin to a different level', () => {
        acia.setCableLines({ dcd: false })
        acia.read(0x01)
        acia.read(0x01)

        fit({ card: 'pro', jumpers: { dcd: 'ground' } })
        expect(acia.read(0x01)).toBe(IRQ | TDRE)
      })

      it('never interrupts for a pin at ground, or for CTS', () => {
        fit({ card: 'standard', jumpers: { cts: 'cable' } })
        acia.read(0x01)

        acia.setCableLines({ cts: false, dcd: false, dsr: false })
        acia.setCableLines({ cts: true, dcd: true, dsr: true })
        expect(acia.tick(1000000)).toBe(0)
        expect(acia.read(0x01)).toBe(TDRE)
      })

      it('takes the levels afresh at a hardware reset, with nothing owed', () => {
        acia.setCableLine('dsr', false)
        acia.reset(true)

        expect(acia.read(0x01)).toBe(TDRE | DSR_HIGH)
        expect(acia.read(0x01)).toBe(TDRE | DSR_HIGH)
      })

      it('leaves the latch alone at a programmed reset', () => {
        acia.setCableLine('dsr', false)
        acia.write(0x01, 0x00)

        expect(acia.read(0x01)).toBe(IRQ | TDRE | DSR_HIGH)
      })

      it('carries the latch through a snapshot', () => {
        acia.setCableLine('dcd', false)
        const state = acia.serialize()

        const restored = new ACIA()
        restored.serialCard = { card: 'pro', jumpers: { dcd: 'cable' } }
        restored.setCableLine('dcd', false)
        restored.read(0x01)
        restored.read(0x01)
        restored.deserialize(state)

        expect(restored.read(0x01)).toBe(IRQ | TDRE | DCD_HIGH)
        expect(restored.read(0x01)).toBe(TDRE | DCD_HIGH)
      })

      it('restores a snapshot from before the latch with both bits at 0', () => {
        const state = acia.serialize()
        delete state.dcdHigh
        delete state.dsrHigh
        delete state.modemChangePending

        const restored = new ACIA()
        restored.deserialize(state)
        expect(restored.read(0x01)).toBe(TDRE)
      })
    })

    describe('echo mode', () => {
      const ECHO = 0x11 // DTR on, receive IRQ on, TIC 00, echo

      it('echoes with CTS at ground whatever the far end does', () => {
        acia.setCableLine('cts', false)
        acia.write(0x02, ECHO)

        acia.onData(0x5A)
        acia.tick(1000000)

        expect(sent).toEqual([0x5A])
      })

      it('loses the echo while CTS on the cable is high, and receives the byte anyway', () => {
        // "Effect of CTS on Echo Mode": TxD goes to MARK; the receiver carries on.
        fit({ card: 'pro', jumpers: { dcd: 'ground' } })
        acia.write(0x02, ECHO)
        acia.setCableLine('cts', false)

        acia.onData(0x5A)
        acia.tick(1000000)
        expect(sent).toEqual([])
        expect(acia.read(0x00)).toBe(0x5A)

        acia.setCableLine('cts', true)
        acia.tick(1000000)
        expect(sent).toEqual([])

        acia.onData(0x59)
        acia.tick(1000000)
        expect(sent).toEqual([0x59])
      })
    })

    it('behaves exactly as before on a Serial Card whatever the far end does', () => {
      deassertAll()

      acia.write(0x00, 0x41)
      acia.tick(1000000)
      acia.onData(0x5A)
      acia.tick(1000000)

      expect(sent).toEqual([0x41])
      expect(acia.read(0x01)).toBe(TDRE | 0x08 | 0x80)
      expect(acia.read(0x00)).toBe(0x5A)
    })

    it('is not chip state: a reset and a snapshot leave the card and the lines alone', () => {
      fit({ card: 'ace', jumpers: { cts: 'cable', dcd: 'cable' } })
      acia.setCableLine('cts', false)

      acia.reset(true)
      expect(acia.serialCard).toEqual({ card: 'ace', jumpers: { cts: 'cable', dcd: 'cable' } })
      expect(acia.cableLine('cts')).toBe(false)

      const keys = Object.keys(acia.serialize())
      expect(keys).not.toContain('serialCard')
      expect(keys).not.toContain('cableLines')

      const restored = new ACIA()
      restored.deserialize(acia.serialize())
      expect(restored.serialCard).toEqual({ card: 'standard', jumpers: { cts: 'ground' } })
      expect(restored.cableLine('cts')).toBe(true)
    })
  })

  describe('the machine', () => {
    it('is built with the ACE, CTS EN and DCD EN at ground', () => {
      const machine = new Machine()
      const acia = machine.io5 as ACIA

      expect(DEFAULT_SERIAL_CARD).toEqual({ card: 'ace', jumpers: { cts: 'ground', dcd: 'ground' } })
      expect(machine.serialCard).toEqual(DEFAULT_SERIAL_CARD)
      expect(acia.serialCard).toEqual(DEFAULT_SERIAL_CARD)
    })

    it('fits its card to the ACIA, keeping only that card\'s jumpers', () => {
      const machine = new Machine()
      machine.serialCard = { card: 'pro', jumpers: { cts: 'cable', dcd: 'cable' } }

      expect(machine.serialCard).toEqual({ card: 'pro', jumpers: { dcd: 'cable' } })
      expect((machine.io5 as ACIA).serialCard).toEqual({ card: 'pro', jumpers: { dcd: 'cable' } })
    })

    it('passes the far end\'s lines to the ACIA, where the jumpers let them through', () => {
      const machine = new Machine()
      const acia = machine.io5 as ACIA
      acia.write(0x02, READY)

      machine.setSerialLine('cts', false)
      expect(acia.transmitterEnabled).toBe(true)

      machine.serialCard = { card: 'ace', jumpers: { cts: 'cable', dcd: 'ground' } }
      expect(acia.transmitterEnabled).toBe(false)

      machine.setSerialLine('cts', true)
      expect(acia.transmitterEnabled).toBe(true)
    })

    it('drives several lines as one change', () => {
      const machine = new Machine()
      machine.serialCard = { card: 'pro', jumpers: { dcd: 'cable' } }
      const acia = machine.io5 as ACIA
      acia.read(0x01)

      machine.setSerialLines({ dcd: false, dsr: false })
      expect(acia.read(0x01)).toBe(IRQ | TDRE | DCD_HIGH | DSR_HIGH)
    })

    it('does nothing without a serial card', () => {
      const machine = new Machine({ io5: new Empty() })
      expect(() => machine.setSerialLine('dcd', false)).not.toThrow()
    })
  })
})
