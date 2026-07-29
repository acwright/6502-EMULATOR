import { Session } from '../../debug/Session'
import { Scheduler } from '../../debug/Scheduler'
import { Empty } from '../../core/IO/Empty'
import { Video } from '../../core/IO/Video'
import { VIA } from '../../core/IO/VIA'
import { ACIA } from '../../core/IO/ACIA'
import { RAMBank } from '../../core/IO/RAMBank'

/** A controllable clock, so pacing is tested without leaning on wall time. */
function fakeClock(start = 0) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    }
  }
}

/** Fill ROM with NOPs and point the reset vector at $A000 so the CPU just runs. */
function loadNopROM(session: Session): void {
  const rom = new Array(0x8000).fill(0xea)
  rom[0xfffc - 0x8000] = 0x00
  rom[0xfffd - 0x8000] = 0xa0
  session.machine.loadROM(rom)
  session.machine.reset(true)
}

describe('Session', () => {
  let session: Session

  beforeEach(() => {
    session = new Session()
  })

  afterEach(() => {
    session.pause()
  })

  describe('Run state', () => {
    test('starts paused', () => {
      expect(session.mode).toBe('paused')
      expect(session.isRunning).toBe(false)
    })

    test('run() enters realtime by default', () => {
      session.run()
      expect(session.mode).toBe('realtime')
      expect(session.isRunning).toBe(true)
    })

    test('run("turbo") enters turbo', () => {
      session.run('turbo')
      expect(session.mode).toBe('turbo')
      expect(session.isRunning).toBe(true)
    })

    test('pause() stops the machine advancing', () => {
      session.run()
      session.pause()
      expect(session.mode).toBe('paused')
      expect(session.isRunning).toBe(false)
    })

    test('pause() on an already-paused session is harmless', () => {
      expect(session.pause()).toEqual({ kind: 'paused' })
      expect(session.mode).toBe('paused')
    })

    test('turbo discards queued audio, which is not meaningful unpaced', () => {
      const flushAudio = jest.fn()
      session.machine.flushAudio = flushAudio
      session.run('turbo')
      expect(flushAudio).toHaveBeenCalled()
    })
  })

  describe('runCycles', () => {
    test('advances exactly the requested number of cycles', () => {
      const before = session.cycles
      session.runCycles(1000)
      expect(session.cycles - before).toBe(1000)
    })

    test('reports the budget it consumed', () => {
      expect(session.runCycles(64)).toEqual({ kind: 'cycle-budget', cycles: 64 })
    })

    test('is deterministic — same budget, same end state', () => {
      const a = new Session()
      const b = new Session()
      loadNopROM(a)
      loadNopROM(b)

      a.runCycles(50_000)
      b.runCycles(50_000)

      expect(a.machine.cpu.pc).toBe(b.machine.cpu.pc)
      expect(a.machine.cpu.cycles).toBe(b.machine.cpu.cycles)
      expect(a.machine.cpu.a).toBe(b.machine.cpu.a)
      expect(a.machine.cpu.sp).toBe(b.machine.cpu.sp)
    })

    test('pauses a running session first', () => {
      session.run()
      session.runCycles(10)
      expect(session.isRunning).toBe(false)
    })
  })

  describe('Stepping', () => {
    beforeEach(() => loadNopROM(session))

    test('cycle stepping advances one cycle at a time', () => {
      const before = session.cycles
      session.step('cycle', 5)
      expect(session.cycles - before).toBe(5)
    })

    test('instruction stepping lands on an instruction boundary', () => {
      session.step('instruction')
      expect(session.machine.cpu.cyclesRem).toBe(0)
    })

    test('instruction stepping advances the PC by one NOP', () => {
      session.step('instruction') // clear the reset sequence
      const pc = session.machine.cpu.pc
      session.step('instruction')
      expect(session.machine.cpu.pc).toBe((pc + 1) & 0xffff)
    })

    test('stepping N instructions matches N single steps', () => {
      const other = new Session()
      loadNopROM(other)

      session.step('instruction', 5)
      for (let i = 0; i < 5; i++) other.step('instruction')

      expect(session.machine.cpu.pc).toBe(other.machine.cpu.pc)
      expect(session.cycles).toBe(other.cycles)
    })

    // Stepping must not be a different execution path from running, or a
    // debugger would show state the machine never actually reaches.
    test('stepping leaves the same state as running the same cycles', () => {
      const stepped = new Session()
      const ran = new Session()
      loadNopROM(stepped)
      loadNopROM(ran)

      stepped.step('instruction', 200)
      ran.runCycles(stepped.cycles - ran.cycles)

      expect(stepped.machine.cpu.pc).toBe(ran.machine.cpu.pc)
      expect(stepped.machine.cpu.cycles).toBe(ran.machine.cpu.cycles)
    })

    test('pauses a running session first', () => {
      session.run()
      session.step()
      expect(session.isRunning).toBe(false)
    })
  })

  describe('Reset', () => {
    test('preserves a paused session', () => {
      session.reset(true)
      expect(session.mode).toBe('paused')
    })

    test('preserves a running session and its mode', () => {
      session.run('realtime')
      session.reset(true)
      expect(session.mode).toBe('realtime')

      session.run('turbo')
      session.reset(false)
      expect(session.mode).toBe('turbo')
    })
  })

  describe('Stop notifications', () => {
    test('fire with the reason for stopping', () => {
      const reasons: unknown[] = []
      session.onStop((r) => reasons.push(r))

      session.pause()
      session.step()
      session.runCycles(4)

      expect(reasons).toEqual([
        { kind: 'paused' },
        { kind: 'step' },
        { kind: 'cycle-budget', cycles: 4 }
      ])
    })

    test('unsubscribe stops delivery', () => {
      const listener = jest.fn()
      const off = session.onStop(listener)
      off()
      session.pause()
      expect(listener).not.toHaveBeenCalled()
    })
  })

  describe('Slot configuration', () => {
    test('defaults to the standard card layout', () => {
      expect(session.machine.io1).toBeInstanceOf(RAMBank)
      expect(session.machine.io5).toBeInstanceOf(ACIA)
      expect(session.machine.io6).toBeInstanceOf(VIA)
      expect(session.machine.io8).toBeInstanceOf(Video)
    })

    test('an empty video slot is allowed — this is how a serial console boots', () => {
      const headless = new Session({ io8: new Empty() })
      expect(headless.machine.io8).toBeInstanceOf(Empty)
      expect(headless.machine.video()).toBeUndefined()
    })

    test('runs without a video card', () => {
      const headless = new Session({ io8: new Empty() })
      loadNopROM(headless)
      expect(() => headless.runCycles(10_000)).not.toThrow()
    })

    // Callbacks are wired by what a card is, not which slot it sits in — and
    // every slot is ticked, so a card works wherever it is placed.
    test.each(['io1', 'io5', 'io7'] as const)(
      'serial output reaches the host from slot %s',
      (slot) => {
        const transmitted: number[] = []
        const moved = new Session({ io5: new Empty(), [slot]: new ACIA() })
        moved.machine.transmit = (b) => transmitted.push(b)
        ;(moved.machine[slot] as ACIA).write(0x00, 0x41)
        moved.runCycles(200_000)
        expect(transmitted).toContain(0x41)
      }
    )

    test('onReceive is a no-op when no serial card is present', () => {
      const noSerial = new Session({ io5: new Empty() })
      expect(() => noSerial.machine.onReceive(0x41)).not.toThrow()
    })

    test('GPIO attachments exist only when a VIA is present', () => {
      expect(session.machine.keyboardMatrixAttachment).toBeDefined()

      const noVia = new Session({ io6: new Empty() })
      expect(noVia.machine.keyboardMatrixAttachment).toBeUndefined()
    })
  })
})

describe('Scheduler pacing', () => {
  test('realtime runs the cycles the elapsed wall time paid for', () => {
    const clock = fakeClock()
    const session = new Session({}, clock.now)
    loadNopROM(session)

    const before = session.cycles
    session.run('realtime')

    // start() samples the clock; the first loop sees zero elapsed time.
    expect(session.cycles).toBe(before)

    session.pause()
    expect(session.mode).toBe('paused')
  })

  test('caps how much missed time it will make up', () => {
    // A long stall must not turn into an unbounded burst — that is what floods
    // the audio queue after the host has been busy.
    const clock = fakeClock()
    const session = new Session({}, clock.now)
    loadNopROM(session)
    session.machine.frequency = 1_000_000

    const before = session.cycles
    session.run('realtime')
    clock.advance(60_000) // a minute of missed time

    // Drive one loop iteration the way setImmediate would.
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        session.pause()
        const executed = session.cycles - before
        const cap = (Scheduler.MAX_CATCH_UP_MS / 1000) * 1_000_000
        expect(executed).toBeLessThanOrEqual(cap)
        resolve()
      })
    })
  })
})
