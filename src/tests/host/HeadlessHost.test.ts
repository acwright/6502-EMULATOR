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
import { createHash } from 'crypto'
import { HeadlessHost } from '../../host/headless/HeadlessHost'
import type { HeadlessOptions } from '../../host/headless/HeadlessHost'
import { SerialConsole } from '../../host/headless/SerialConsole'
import { Machine } from '../../core/Machine'
import { Empty } from '../../core/IO/Empty'
import { RTC } from '../../core/IO/RTC'
import { Video } from '../../core/IO/Video'
import { TMS9918A } from '../../core/IO/TMS9918A'
import { decodePNG } from '../goldens/fixtures'

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

    describe('a program pasted at 19,200 baud', () => {
      // Crunching one of these lines takes 60,000-80,000 cycles, well over a
      // hundred characters of line time, so a paste fills the BIOS's 256-byte
      // input buffer within a few lines. Its IRQ handler raises RTS at $F0
      // bytes; with flow control on, input survives only if the console stops
      // sending when it does and the firmware lowers RTS again.
      const lines = [
        '10 REM PASTED AT 19200 BAUD, ONE WRITE',
        '20 DIM D(13) : DIM E(13)',
        ...Array.from({ length: 18 }, (_, i) => {
          const n = 30 + i * 10
          return [
            `${n} FOR K = 2 TO 15 : V = PEEK(${i} + K) : GOSUB 1500 : NEXT K`,
            `${n} IF T = ${i} THEN PRINT "SLOT";S;": ";D(${i % 14});" FREE"`,
            `${n} C = C * 2 : IF C > 255 THEN C = C - 255 : V = V + ${i}`,
            `${n} FOR X = 0 TO 31 : POKE X + ${i * 32},X : NEXT X : GOSUB 1500`
          ][i % 4]!
        }),
        '1500 C = (C OR V) - (C AND V)',
        '1510 RETURN'
      ]
      const paste = lines.map((line) => `${line}\r`).join('')
      const FIXED = { year: 2026, month: 1, date: 2, hours: 3, minutes: 4, seconds: 5 }

      /**
       * Boot `rom` over the serial console and drive it the way HeadlessHost's
       * scheduler does — a byte's worth of cycles, then a pump — by hand, so
       * the test can act between stages.
       */
      function start(rom: Uint8Array, flowControl: boolean) {
        const h = new HeadlessHost({
          rom,
          cf: new Uint8Array(64 * 1024),
          baudRate: 19200,
          rtc: FIXED,
          flowControl
        })
        const machine = h.session.machine
        const out = { text: '' }
        machine.transmit = (byte) => {
          out.text += String.fromCharCode(byte)
        }
        const chunk = Math.floor((machine.frequency * 10) / h.baudRate)
        const runUntil = (done: () => boolean, budget: number): void => {
          for (let spent = 0; spent < budget && !done(); spent += chunk) {
            machine.runCycles(chunk)
            h.serial.pump()
          }
        }
        return { h, machine, out, runUntil }
      }

      function boot(rom: Uint8Array, flowControl: boolean) {
        const started = start(rom, flowControl)
        started.h.write(ENTER)
        started.runUntil(() => /OK\r\n$/.test(started.out.text), BOOT_BUDGET)
        expect(started.out.text).toMatch(/OK\r\n$/)
        return started
      }

      it('with flow control on, delivers every line when BASIC lets go of RTS as the buffer drains', () => {
        // BIOS 1.6's line input reads the buffer with ReadBuffer, which never
        // lowers RTS again; its Chrin does. One byte turns BasReadKey's
        // `jmp ReadBuffer` into `jmp Chrin`, which reads the same byte and
        // releases RTS below $B0 (and echoes it a second time, harmlessly).
        const rom = Uint8Array.from(BIOS)
        const readKey = Buffer.from(rom).indexOf(Buffer.from([0x20, 0x0c, 0xa0, 0xf0, 0xfb, 0x4c, 0x09, 0xa0]))
        expect(readKey).toBeGreaterThan(0)
        rom[readKey + 6] = 0x03 // jmp $A003, Chrin

        const { h, out, runUntil } = boot(rom, true)
        h.write(paste)
        runUntil(() => h.serial.pendingBytes === 0, 20_000_000)
        runUntil(() => false, 1_000_000) // the last line's crunch

        const listStart = out.text.length
        h.write('LIST\r')
        runUntil(() => /OK\r\n$/.test(out.text.slice(listStart)), 5_000_000)

        const listed = out.text
          .slice(listStart)
          .split('\r\n')
          .filter((line) => /^\d+ /.test(line))
        expect(listed).toEqual(lines)
      })

      it('with flow control on, holds the rest of the paste, losing nothing, when BASIC never lets go of RTS', () => {
        // The bundled 1.6 as it ships: RTS goes up at $F0 and BASIC's line
        // input never brings it down, so the console stops accepting input —
        // as a terminal doing RTS/CTS flow control would find on the real
        // machine. This is why flow control is off by default. What must hold
        // is that nothing is lost: every byte BASIC saw is the paste in order,
        // and every byte it did not is still queued.
        const { h, machine, out, runUntil } = boot(BIOS, true)
        const echoStart = out.text.length
        h.write(paste)
        runUntil(() => false, 10_000_000)

        const echoed = out.text.slice(echoStart)
        const expected = lines.map((line) => `${line}\r\n`).join('')
        expect(echoed.length).toBeGreaterThan(lines[0]!.length)
        expect(expected.startsWith(echoed)).toBe(true)

        expect(machine.serialReady).toBe(false)
        expect(h.serial.pendingBytes).toBeGreaterThan(0)
      })

      it('with flow control off, does exactly what 3.0.0 did', () => {
        // Everything is delivered and RTS is ignored, so BASIC overruns its
        // buffer and drops lines. The transcript below was captured from
        // v3.0.0 with this exact procedure: fixed budgets rather than waits,
        // so the two runs cannot differ by where a wait happened to end.
        const { h, machine, out, runUntil } = start(BIOS, false)
        const budget = (cycles: number): void => runUntil(() => false, cycles)
        h.write(ENTER)
        budget(3_000_000)
        h.write(paste)
        budget(20_000_000)
        const listStart = out.text.length
        h.write('LIST\r')
        budget(5_000_000)

        const listed = out.text
          .slice(listStart)
          .split('\r\n')
          .filter((line) => /^\d+ /.test(line))
          .map((line) => line.split(' ')[0])
        expect(listed).toEqual(['10', '20', '30', '40', '100', '110', '170', '180', '190', '200', '1500', '1510'])
        expect(h.serial.pendingBytes).toBe(0)
        expect(machine.serialReady).toBe(true)
        expect(machine.cycles).toBe(28_000_960)
        expect(out.text.length).toBe(1342)
        expect(createHash('sha256').update(out.text, 'binary').digest('hex')).toBe(
          '23457e95452239fe14534264a3ae6944d37ec18d5841a659d2d69ba9813fbc04'
        )
      })
    })

    it('leaves the video slot empty in serial mode, and populated otherwise', () => {
      expect(host().host.session.machine.io8).toBeInstanceOf(Empty)
      expect(host({ vdp: 'picovdp' }).host.session.machine.io8).toBeInstanceOf(Empty)
      expect(host({ console: 'video' }).host.session.machine.io8).toBeInstanceOf(TMS9918A)
    })

    it('puts the card --vdp names in the video slot, the TMS9918A by default', () => {
      expect(host({ console: 'video' }).host.vdp).toBe('tms9918a')
      expect(host({ console: 'video', vdp: 'tms9918a' }).host.session.machine.io8).toBeInstanceOf(TMS9918A)
      const pico = host({ console: 'video', vdp: 'picovdp' }).host
      expect(pico.vdp).toBe('picovdp')
      expect(pico.session.machine.io8).toBeInstanceOf(Video)
    })
  })

  describe('screenshots', () => {
    it.each(['tms9918a', 'picovdp'] as const)('captures the video console as a PNG of the last complete frame (%s)', async (vdp) => {
      const { host: h } = host({ console: 'video', vdp })
      await h.run('turbo')

      const video = h.session.machine.video()!
      // Booted far enough to have drawn something: the splash is on screen.
      expect(video.textGrid().join('\n')).toMatch(/6502/)

      // And the frame has it, not only VRAM: two colors at least, or a blank
      // buffer would round-trip through the PNG just as faithfully.
      expect(new Set(video.frameIndices()).size).toBeGreaterThan(1)

      const png = h.screenshot()!
      expect(decodePNG(png, 320, 240)).toEqual(Uint8Array.from(video.buffer))
    })

    it('has nothing to capture on a serial console', () => {
      expect(host().host.screenshot()).toBeUndefined()
    })
  })

  describe('holding input back', () => {
    it('opens on the screen text when the console is video', async () => {
      const BIOS2 = new Uint8Array(readFileSync(join(__dirname, '../../../assets/roms/BIOS2.bin')))
      const { host: h } = host({ rom: BIOS2, console: 'video', vdp: 'picovdp', inputAfter: /OK/ })
      h.write('PRINT 6*7\r')

      await h.run('turbo')

      const screen = h.session.machine.video()!.textGrid().join('\n')
      // Held until BASIC's OK was on screen, then typed at the prompt and run.
      expect(screen).toMatch(/PRINT 6\*7\s*\n\s*42/)
      expect(h.serial.pendingBytes).toBe(0)
    })

    it('stays shut while the pattern is on neither the console nor the screen', async () => {
      const BIOS2 = new Uint8Array(readFileSync(join(__dirname, '../../../assets/roms/BIOS2.bin')))
      const { host: h } = host({ rom: BIOS2, console: 'video', vdp: 'picovdp', inputAfter: /NEVER PRINTED/ })
      h.write('PRINT 6*7\r')

      await h.run('turbo')

      expect(h.serial.pendingBytes).toBe(10)
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

    it('ends the run when the program halts the processor', async () => {
      // A ROM that STPs straight away rather than the BIOS: the point is which
      // exit condition fires, and a one-instruction program leaves no doubt.
      const rom = new Uint8Array(0x8000).fill(0xea)
      rom[0xa000 - 0x8000] = 0xdb // STP
      rom[0xfffc - 0x8000] = 0x00
      rom[0xfffd - 0x8000] = 0xa0

      const { host: h } = host({ rom, maxCycles: 1e9, timeoutMs: 10_000 })
      const result = await h.run('turbo')

      // Not 'timeout', which would exit 2 and fail a CI job for a program that
      // did exactly what it was written to do.
      expect(result.reason).toBe('halted')
      expect(result.cycles).toBeLessThan(100_000)
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

    it('loads NVRAM into the clock card, as the app does from its own file', () => {
      const nvram = new Uint8Array(256)
      nvram[0] = 0x42
      nvram[255] = 0x99
      const { host: h } = host({ nvram })

      const rtc = h.session.machine.io3 as RTC
      expect(rtc.readNVRAM(0)).toBe(0x42)
      expect(rtc.readNVRAM(255)).toBe(0x99)
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
    // `dbg send` then `dbg runcycles` on a paused machine (DOCS ACCURACY O6).
    it('delivers queued serial input during exec.runCycles', async () => {
      const BIOS2 = new Uint8Array(readFileSync(join(__dirname, '../../../assets/roms/BIOS2.bin')))
      const { host: h, read } = host({ rom: BIOS2, maxCycles: 1e12 })
      const pending = h.run('turbo', true)

      h.session.runCycles(2_000_000)
      expect(read()).toMatch(/OK\r?\n$/)

      h.write('PRINT 12\r')
      h.session.runCycles(1_000_000)

      expect(h.serial.pendingBytes).toBe(0)
      expect(read()).toMatch(/PRINT 12\r\n 12\r\n/)
      h.stop()
      await pending
    })

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
  // Programmed as the BIOS leaves it ($09: receiver on, RTS low), so input is
  // sent from the start with flow control on, the default.
  const machine = () => {
    const m = new Machine({ io8: new Empty() })
    m.write(0x9002, 0x09)
    return m
  }

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

  describe.each([
    { flowControl: true, holds: true },
    { flowControl: false, holds: false }
  ])('with flow control $flowControl', ({ flowControl, holds }) => {
    it(holds
      ? 'sends nothing while the machine has RTS raised, and resumes at the line rate when it drops'
      : 'ignores RTS and keeps sending at the line rate, as 3.0.0 did', () => {
      const m = machine()
      m.flowControl = flowControl
      const received: number[] = []
      m.onReceive = (byte) => received.push(byte)
      const perByte = Math.ceil((1_000_000 * 10) / 19200)

      const console_ = new SerialConsole(m, 19200)
      console_.write('ABCD')

      m.write(0x9002, 0x01) // DTR on, RTSB high: the BIOS's "buffer nearly full"
      m.runCycles(perByte)
      console_.pump()
      expect(received).toEqual(holds ? [] : [0x41])
      for (let i = 0; i < 100; i++) {
        m.runCycles(perByte)
        console_.pump()
      }

      if (!holds) {
        expect(received).toEqual([0x41, 0x42, 0x43, 0x44])
        expect(console_.pendingBytes).toBe(0)
        return
      }
      expect(received).toEqual([])
      expect(console_.pendingBytes).toBe(4)

      // The hold banked no time: the first byte still takes a byte's line time.
      m.write(0x9002, 0x09) // RTSB low
      m.runCycles(perByte - 1)
      console_.pump()
      expect(received).toEqual([])

      m.runCycles(1)
      console_.pump()
      expect(received).toEqual([0x41])

      m.runCycles(perByte * 3)
      console_.pump()
      expect(received).toEqual([0x41, 0x42, 0x43, 0x44])
    })
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
