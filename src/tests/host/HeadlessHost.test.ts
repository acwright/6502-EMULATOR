/**
 * End-to-end tests for the headless host.
 *
 * These boot the real bundled BIOS with no video card, so the Kernal's own
 * console auto-detection routes everything to the ACIA and stdio becomes the
 * machine's terminal. Nothing here is stubbed — if the BIOS stops booting or
 * the serial path breaks, these fail.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { HeadlessHost } from '../../host/headless/HeadlessHost'
import type { HeadlessOptions } from '../../host/headless/HeadlessHost'
import { SerialConsole } from '../../host/headless/SerialConsole'
import { Machine } from '../../core/Machine'
import { Empty } from '../../core/IO/Empty'
import { RTC } from '../../core/IO/RTC'
import { Video } from '../../core/IO/Video'

const BIOS = new Uint8Array(readFileSync(join(__dirname, '../../../assets/roms/BIOS.bin')))

/**
 * Enough emulated time to boot and run a short command, with room to spare.
 * Booting to the BASIC prompt and running a line takes about 450k cycles when
 * ENTER skips the splash countdown.
 */
const BOOT_BUDGET = 3_000_000

// These boot a real ROM, and under parallel workers they contend for CPU with
// every other suite. The work is bounded in emulated cycles, not wall time, so
// a generous ceiling avoids a flaky timeout without hiding a real hang.
jest.setTimeout(60_000)

/** ENTER at the splash boots straight to BASIC instead of waiting out the countdown. */
const ENTER = '\r'
const ESC = '\x1b'

function host(options: Partial<HeadlessOptions> = {}) {
  let output = ''
  const h = new HeadlessHost({
    rom: BIOS,
    // A small card keeps the test allocation modest; the default is 256 MB.
    cf: new Uint8Array(64 * 1024),
    maxCycles: BOOT_BUDGET,
    onOutput: (data) => {
      output += Buffer.from(data).toString('binary')
    },
    ...options
  })
  return { host: h, read: () => output }
}

describe('HeadlessHost', () => {
  describe('serial console', () => {
    it('boots to BASIC with no video card, using the BIOS console auto-detection', async () => {
      const { host: h, read } = host()
      h.write(ENTER)

      const result = await h.run('turbo')

      expect(read()).toContain('6502 BASIC')
      expect(read()).toContain('OK')
      expect(result.reason).toBe('max-cycles')
    })

    it('boots to the Monitor when ESC is sent at the splash', async () => {
      const { host: h, read } = host()
      h.write(ESC)

      await h.run('turbo')

      expect(read()).toContain('MONITOR')
    })

    it('runs a command typed over the console and returns its result', async () => {
      const { host: h, read } = host({ exitOn: /OK[\s\S]*OK/ })
      h.write(`${ENTER}PRINT 2+2${ENTER}`)

      const result = await h.run('turbo')

      expect(result.reason).toBe('exit-on')
      // BASIC prints numbers with a leading space for the sign column.
      expect(read()).toMatch(/PRINT 2\+2\r\n\s*4/)
    })

    it('leaves the video slot empty in serial mode, and populated otherwise', () => {
      expect(host().host.session.machine.io8).toBeInstanceOf(Empty)
      expect(host({ console: 'video' }).host.session.machine.io8).toBeInstanceOf(Video)
    })
  })

  describe('exit conditions', () => {
    it('stops on a cycle budget', async () => {
      const { host: h } = host({ maxCycles: 100_000 })
      const result = await h.run('turbo')

      expect(result.reason).toBe('max-cycles')
      expect(result.cycles).toBeGreaterThanOrEqual(100_000)
    })

    it('stops when output matches, long before the budget', async () => {
      const { host: h } = host({ exitOn: /BASIC/, maxCycles: BOOT_BUDGET })
      h.write(ENTER)

      const result = await h.run('turbo')

      expect(result.reason).toBe('exit-on')
      expect(result.cycles).toBeLessThan(BOOT_BUDGET)
    })

    it('stops when asked to', async () => {
      const { host: h } = host({ maxCycles: 1e9 })
      setTimeout(() => h.stop(), 5)

      const result = await h.run('turbo')
      expect(result.reason).toBe('stopped')
    })

    it('reports a timeout', async () => {
      const { host: h } = host({ maxCycles: 1e12, timeoutMs: 20 })
      const result = await h.run('turbo')
      expect(result.reason).toBe('timeout')
    })
  })

  describe('media loading', () => {
    it('applies BASIC pointer fixups for a program preloaded before boot', async () => {
      // A minimal but well-formed image: one empty line 10, then the end marker.
      // Loaded while the machine is reset, so BASIC's cold start would clobber
      // the pointers — the host has to reapply them once BASIC is up.
      const program = Uint8Array.of(0x05, 0x08, 0x0a, 0x00, 0x00, 0x00, 0x00)
      const { host: h, read } = host({ program, exitOn: /OK[\s\S]*OK/ })
      h.write(`${ENTER}PRINT FRE(0)${ENTER}`)

      await h.run('turbo')

      const free = Number(/\r\n\s*(\d+)\r\n/.exec(read().split('PRINT FRE(0)')[1] ?? '')?.[1])
      expect(Number.isFinite(free)).toBe(true)

      // Baseline for an empty program, minus the extra bytes this image occupies.
      const { host: bare, read: bareRead } = host({ exitOn: /OK[\s\S]*OK/ })
      bare.write(`${ENTER}PRINT FRE(0)${ENTER}`)
      await bare.run('turbo')
      const bareFree = Number(
        /\r\n\s*(\d+)\r\n/.exec(bareRead().split('PRINT FRE(0)')[1] ?? '')?.[1]
      )

      expect(free).toBe(bareFree - (program.length - 2))
    })

    it('rejects an oversized program rather than corrupting RAM', () => {
      expect(() => host({ program: new Uint8Array(0x8000) })).toThrow(/only \d+ fit/)
    })

    it('rejects an empty program', () => {
      expect(() => host({ program: new Uint8Array(0) })).toThrow(/empty/)
    })

    it('rejects a binary that would run past the top of RAM', () => {
      // RAM ends at $7FFF; $8000 and up is I/O.
      expect(() =>
        host({ binaries: [{ address: 0x7ff0, bytes: new Uint8Array(64) }] })
      ).toThrow(/out-of-range/)
    })

    it('loads a binary and runs it from BASIC', async () => {
      // LDA #'X'; JSR Chrout ($A000); RTS. RAM ends at $7FFF, so this sits at
      // the top of it, above BASIC's program area and clear of the workspace.
      const code = Uint8Array.of(0xa9, 0x58, 0x20, 0x00, 0xa0, 0x60)
      const { host: h, read } = host({
        binaries: [{ address: 0x7f00, bytes: code }],
        exitOn: /OK[\s\S]*OK/
      })
      h.write(`${ENTER}SYS 32512${ENTER}`)

      await h.run('turbo')
      expect(read()).toMatch(/SYS 32512\r\nX/)
    })
  })

  describe('a fixed clock', () => {
    /**
     * `--rtc` closes the last non-deterministic input to the engine (§5.11).
     * Everything else is driven by cycle accumulators, so with this fixed the
     * same ROM, input and cycle budget produce byte-identical results — which is
     * what makes an emulator-based test trustworthy in CI.
     */
    const FIXED = { year: 2026, month: 1, date: 2, hours: 3, minutes: 4, seconds: 5 }

    it('seats an RTC that reads the given time', () => {
      const { host: h } = host({ rtc: FIXED })
      const rtc = h.session.machine.io3 as RTC
      const bcd = (value: number): number => (((value >> 4) & 0x0f) * 10) + (value & 0x0f)

      expect(bcd(rtc.read(0x02))).toBe(FIXED.hours)
      expect(bcd(rtc.read(0x01))).toBe(FIXED.minutes)
    })

    it('reads the same time again after the machine boots and cold-resets', () => {
      const { host: h } = host({ rtc: FIXED })
      const rtc = h.session.machine.io3 as RTC
      const bcd = (value: number): number => (((value >> 4) & 0x0f) * 10) + (value & 0x0f)

      h.session.runCycles(2_000_000)
      h.session.reset(true)

      expect(bcd(rtc.read(0x00))).toBe(FIXED.seconds)
    })

    it('two runs of the same program produce identical machines', async () => {
      const run = async (): Promise<string> => {
        const { host: h, read } = host({ rtc: FIXED, exitOn: /OK[\s\S]*OK/ })
        h.write(`${ENTER}PRINT 6*7${ENTER}`)
        await h.run('turbo')
        return JSON.stringify(h.session.machine.ram.serialize())
      }

      expect(await run()).toBe(await run())
    })

    it('leaves the clock on wall time when not asked', () => {
      const { host: h } = host()
      const rtc = h.session.machine.io3 as RTC
      const bcd = (value: number): number => (((value >> 4) & 0x0f) * 10) + (value & 0x0f)

      expect(bcd(rtc.read(0x02))).toBe(new Date().getHours())
    })
  })

  describe('serving a debugger', () => {
    /**
     * Starting paused has to mean not started at all.
     *
     * Scheduler.start() runs a whole turbo slice synchronously, so pausing
     * after calling run() would already be tens of thousands of cycles into the
     * BIOS — and a debugger attaching at reset has to see the reset vector.
     */
    it('starts paused at the reset vector, having run nothing', async () => {
      const { host: h } = host()
      const pending = h.run('turbo', true)

      expect(h.session.cycles).toBe(0)
      expect(h.session.isRunning).toBe(false)
      // $FFFC/$FFFD, read straight from the ROM image.
      const vector = h.session.machine.peek(0xfffc) | (h.session.machine.peek(0xfffd) << 8)
      expect(h.session.machine.cpu.pc).toBe(vector)

      h.stop('stopped')
      await pending
    })

    it('retains output only while somebody has asked for it', async () => {
      const { host: h } = host({ maxCycles: 600_000 })
      h.write(ENTER)

      // No retain request and no exit-on: nothing is kept.
      await h.run('turbo')
      expect(h.readOutput().data).toBe('')

      const second = host({ maxCycles: 600_000 })
      const release = second.host.retainOutput()
      second.host.write(ENTER)
      await second.host.run('turbo')

      expect(second.host.readOutput().data).toContain('6502 BASIC')
      release()
    })

    /**
     * The cursor is what makes "wait for the reply to what I just sent" work.
     *
     * A one-shot client writes, exits, and a later process waits — by which
     * time the machine has run far enough in turbo to have printed and scrolled
     * past the reply. An absolute stream position survives that; "from now"
     * cannot.
     */
    it('reads output from an absolute position in the stream', async () => {
      const { host: h } = host({ maxCycles: 600_000 })
      const release = h.retainOutput()
      h.write(ENTER)
      await h.run('turbo')

      const all = h.readOutput()
      expect(all.cursor).toBe(all.data.length)

      const tail = h.readOutput({ since: all.cursor - 4 })
      expect(tail.data).toBe(all.data.slice(-4))
      expect(tail.truncated).toBe(false)
      release()
    })

    it('says when the output it was asked for has already been dropped', async () => {
      const { host: h } = host({ maxCycles: 600_000 })
      const release = h.retainOutput()
      h.write(ENTER)
      await h.run('turbo')

      h.readOutput({ clear: true })
      expect(h.readOutput({ since: 0 }).truncated).toBe(true)
      release()
    })

    it('reports console output to every subscriber', async () => {
      const { host: h } = host({ maxCycles: 600_000 })
      let seen = ''
      const off = h.onSerialOutput((data) => {
        seen += Buffer.from(data).toString('binary')
      })

      h.write(ENTER)
      await h.run('turbo')

      expect(seen).toContain('6502 BASIC')
      off()
    })
  })
})

describe('SerialConsole', () => {
  const machine = () => new Machine({ io8: new Empty() })

  it('paces input at the line rate rather than delivering it at once', () => {
    const m = machine()
    const received: number[] = []
    m.onReceive = (byte) => received.push(byte)

    const console_ = new SerialConsole(m, 19200)
    console_.write('ABCD')

    // 10 bits per byte at 19200 baud is 520.83 cycles at 1 MHz.
    const perByte = Math.ceil((1_000_000 * 10) / 19200)
    m.runCycles(perByte)
    console_.pump()
    expect(received.length).toBe(1)

    m.runCycles(perByte * 3)
    console_.pump()
    expect(received.length).toBe(4)
  })

  it('holds bytes until enough emulated time has passed', () => {
    const m = machine()
    const received: number[] = []
    m.onReceive = (byte) => received.push(byte)

    const console_ = new SerialConsole(m, 19200)
    console_.write('AB')

    m.runCycles(100) // well under one byte time
    console_.pump()
    expect(received).toEqual([])
    expect(console_.pendingBytes).toBe(2)
  })

  it('does not bank credit while idle, so a later write is still paced', () => {
    const m = machine()
    const received: number[] = []
    m.onReceive = (byte) => received.push(byte)

    const console_ = new SerialConsole(m, 19200)

    // A long quiet stretch with nothing queued.
    m.runCycles(1_000_000)
    console_.pump()

    console_.write('ABCD')
    console_.pump()
    expect(received.length).toBe(0)
  })

  it('resync discards banked time, so held-back input is not released in a burst', () => {
    const m = machine()
    const received: number[] = []
    m.onReceive = (byte) => received.push(byte)

    const console_ = new SerialConsole(m, 19200)
    console_.write('ABCD')

    // Time passes while the gate is shut and pump() is not being called.
    m.runCycles(1_000_000)
    console_.resync()
    console_.pump()

    expect(received.length).toBe(0)
  })
})
