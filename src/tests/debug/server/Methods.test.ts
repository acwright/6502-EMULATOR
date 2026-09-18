import { Session } from '../../../debug/Session'
import { Empty } from '../../../core/IO/Empty'
import { RTC } from '../../../core/IO/RTC'
import { Storage } from '../../../core/IO/Storage'
import { Video } from '../../../core/IO/Video'
import { TMS9918A } from '../../../core/IO/TMS9918A'
import { createVideoCard } from '../../../core/IO/createVideoCard'
import type { VdpModel } from '../../../core/IO/VideoCard'
import { SymbolTable } from '../../../debug/symbols/Symbols'
import { createMethods } from '../../../debug/server/Methods'
import type { MethodTable } from '../../../debug/server/Methods'
import { ErrorCode, RpcMethodError } from '../../../debug/server/Protocol'
import type { DebugTarget, SerialRead } from '../../../debug/server/DebugTarget'

/**
 * A target with no sockets and no filesystem.
 *
 * The method table is the whole protocol surface, so testing it directly —
 * rather than through HTTP — is where the behaviour actually gets covered.
 */
function target(options: { console?: 'serial' | 'video'; serial?: boolean; vdp?: VdpModel } = {}): {
  target: DebugTarget
  methods: MethodTable
  session: Session
  emit: (text: string) => void
  written: string[]
} {
  const consoleMode = options.console ?? 'serial'
  const session = new Session({
    io1: new Empty(),
    io2: new Empty(),
    io3: new RTC(),
    io4: new Storage(64 * 1024),
    io5: new Empty(),
    io6: new Empty(),
    io7: new Empty(),
    // The PICOVDP unless a test asks otherwise: most of these are about it.
    io8: consoleMode === 'video' ? createVideoCard(options.vdp ?? 'picovdp') : new Empty()
  })

  let stream = ''
  const listeners = new Set<(text: string) => void>()
  const written: string[] = []

  const base: DebugTarget = {
    session,
    symbols: new SymbolTable(),
    hostName: 'test',
    version: '9.9.9',
    consoleMode: () => consoleMode
  }

  const withSerial: DebugTarget = {
    ...base,
    writeSerial: (data) => written.push(Buffer.from(data).toString('binary')),
    readSerial: ({ since, max, clear }): SerialRead => {
      let text = since === undefined ? stream : stream.slice(Math.min(since, stream.length))
      if (max !== undefined) text = text.slice(-max)
      if (clear) stream = ''
      return { data: text, cursor: stream.length, truncated: false }
    },
    onSerial: (callback) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    baudRate: () => 19200,
    setBaudRate: () => {}
  }

  const chosen = options.serial === false ? base : withSerial

  return {
    target: chosen,
    methods: createMethods(chosen),
    session,
    emit: (text) => {
      stream += text
      for (const listener of listeners) listener(text)
    },
    written
  }
}

/** Assemble bytes into ROM at `at` and point the reset vector there. */
function program(session: Session, at: number, ...bytes: number[]): void {
  const rom = new Array(0x8000).fill(0xea)
  bytes.forEach((byte, i) => {
    rom[at - 0x8000 + i] = byte
  })
  rom[0xfffc - 0x8000] = at & 0xff
  rom[0xfffd - 0x8000] = (at >> 8) & 0xff
  session.machine.loadROM(rom)
  session.machine.reset(true)
}

/** The error a call rejects with, so a test can assert on its code. */
async function errorOf(call: () => unknown): Promise<RpcMethodError> {
  try {
    await call()
  } catch (e) {
    return e as RpcMethodError
  }
  throw new Error('expected the call to fail')
}

describe('session', () => {
  it('reports what the machine is', () => {
    const { methods } = target()
    expect(methods['session.info']!({})).toMatchObject({
      protocol: 1,
      host: 'test',
      version: '9.9.9',
      console: 'serial',
      frequency: 1_000_000,
      mode: 'paused',
      running: false
    })
  })

  it('names the video card, or null when the slot is empty', () => {
    expect(methods('serial')['session.info']!({})).toMatchObject({ vdp: null })
    expect(methods('picovdp')['session.info']!({})).toMatchObject({ vdp: 'picovdp' })
    expect(methods('tms9918a')['session.info']!({})).toMatchObject({ vdp: 'tms9918a' })

    function methods(card: 'serial' | VdpModel): MethodTable {
      return card === 'serial' ? target().methods : target({ console: 'video', vdp: card }).methods
    }
  })

  it('reports flow control, on by default, in session.info, session.config and serial.config', () => {
    const { methods, session } = target()
    expect(methods['session.info']!({})).toMatchObject({ flowControl: true })
    expect(methods['session.config']!({})).toMatchObject({ flowControl: true })
    expect(methods['serial.config']!({})).toMatchObject({ flowControl: true })

    session.machine.flowControl = false
    expect(methods['session.info']!({})).toMatchObject({ flowControl: false })
    expect(methods['serial.config']!({})).toMatchObject({ flowControl: false })
  })

  it('sets flow control where the host allows it, and refuses where it does not', async () => {
    const { target: t, session } = target()
    let set: boolean | undefined
    const methods = createMethods({ ...t, setFlowControl: (on) => {
      set = on
      session.machine.flowControl = on
    } })
    expect(methods['session.config']!({ flowControl: true })).toMatchObject({ flowControl: true })
    expect(set).toBe(true)

    const invalid = await errorOf(() => methods['session.config']!({ flowControl: 'on' }))
    expect(invalid.code).toBe(ErrorCode.INVALID_PARAMS)

    const refused = await errorOf(() => target().methods['session.config']!({ flowControl: true }))
    expect(refused.code).toBe(ErrorCode.NOT_SUPPORTED)
  })

  it('changes the clock, and refuses one the hardware has no jumper for', async () => {
    const { methods, session } = target()

    methods['session.config']!({ frequency: 2_000_000 })
    expect(session.machine.frequency).toBe(2_000_000)

    const error = await errorOf(() => methods['session.config']!({ frequency: 3_000_000 }))
    expect(error.code).toBe(ErrorCode.INVALID_PARAMS)
  })

  it('resets', () => {
    const { methods, session } = target()
    session.machine.cpu.a = 0x42
    methods['session.reset']!({ cold: true })
    expect(session.machine.cpu.a).toBe(0)
  })
})

describe('exec', () => {
  it('steps one instruction at a time', () => {
    const { methods, session } = target()
    program(session, 0xc000, 0xa9, 0x42) // LDA #$42

    const result = methods['exec.step']!({}) as { registers: { PC: number; A: number } }
    expect(result.registers.PC).toBe(0xc002)
    expect(result.registers.A).toBe(0x42)
  })

  it('steps a requested number of times', () => {
    const { methods, session } = target()
    program(session, 0xc000)
    methods['exec.step']!({ count: 4 })
    expect(session.machine.cpu.pc).toBe(0xc004)
  })

  it('runs an exact cycle budget', () => {
    const { methods, session } = target()
    program(session, 0xc000)

    const result = methods['exec.runCycles']!({ cycles: 1000 }) as { stop: unknown }
    expect(result.stop).toEqual({ kind: 'cycle-budget', cycles: 1000 })
    expect(session.cycles).toBe(1000)
  })

  it('rejects a step count that is not a positive whole number', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['exec.step']!({ count: 0 }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
    expect((await errorOf(() => methods['exec.step']!({ count: 1.5 }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })

  it('runs to an address', async () => {
    const { methods, session } = target()
    program(session, 0xc000)

    const result = (await methods['exec.runTo']!({ address: 0xc010 })) as {
      stop: { kind: string; address: number }
    }
    expect(result.stop).toMatchObject({ kind: 'breakpoint', address: 0xc010 })
    expect(session.machine.cpu.pc).toBe(0xc010)
  })

  // Otherwise run-to-cursor inside a loop would return immediately, every time,
  // having executed nothing.
  it('runs a full lap when already sitting on the target', async () => {
    const { methods, session } = target()
    // $C000 NOP; $C001 JMP $C000
    program(session, 0xc000, 0xea, 0x4c, 0x00, 0xc0)
    expect(session.machine.cpu.pc).toBe(0xc000)

    const before = session.cycles
    await methods['exec.runTo']!({ address: 0xc000 })
    expect(session.machine.cpu.pc).toBe(0xc000)
    expect(session.cycles).toBeGreaterThan(before)
  })

  it('gives up on an address never reached, leaving no breakpoint behind', async () => {
    const { methods, session } = target()
    program(session, 0xc000, 0x4c, 0x00, 0xc0) // JMP $C000, forever

    const result = (await methods['exec.runTo']!({
      address: 0xd000,
      timeoutMs: 100
    })) as { stop: { kind: string } }

    expect(result.stop.kind).toBe('paused')
    expect(session.breakpoints.list()).toHaveLength(0)
  })
})

describe('bp', () => {
  it('sets, lists, disables and clears', () => {
    const { methods } = target()

    const set = methods['bp.set']!({ address: '0xC000' }) as { id: number; address: number }
    expect(set.address).toBe(0xc000)

    expect(methods['bp.list']!({})).toMatchObject({ breakpoints: [{ id: set.id }] })

    expect(methods['bp.disable']!({ id: set.id })).toMatchObject({ enabled: false })
    expect(methods['bp.enable']!({ id: set.id })).toMatchObject({ enabled: true })

    expect(methods['bp.clear']!({})).toEqual({ cleared: 1 })
    expect(methods['bp.list']!({})).toEqual({ breakpoints: [] })
  })

  it('accepts a symbol as the address', () => {
    const { methods, target: t } = target()
    t.symbols.add({ name: 'main', address: 0xc123 })
    expect(methods['bp.set']!({ address: 'main' })).toMatchObject({ address: 0xc123 })
  })

  // A condition that will not compile has to be reported as the caller's
  // mistake, not swallowed into a breakpoint that then never fires.
  it('reports a malformed condition as a parameter error', async () => {
    const { methods } = target()
    const error = await errorOf(() => methods['bp.set']!({ address: 0xc000, condition: 'A ==' }))
    expect(error.code).toBe(ErrorCode.INVALID_PARAMS)
    expect(error.message).toMatch(/condition/)
  })

  it('refuses to enable a breakpoint that does not exist', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['bp.enable']!({ id: 99 }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })
})

describe('reg', () => {
  it('reads registers with the flags broken out', () => {
    const { methods, session } = target()
    session.machine.cpu.a = 0x80
    session.machine.cpu.st = 0b10000001

    expect(methods['reg.get']!({})).toMatchObject({
      A: 0x80,
      flags: { N: true, C: true, Z: false }
    })
  })

  it('writes registers', () => {
    const { methods, session } = target()
    methods['reg.set']!({ A: 0x12, X: 0x34, PC: '0xC000' })

    expect(session.machine.cpu.a).toBe(0x12)
    expect(session.machine.cpu.x).toBe(0x34)
    expect(session.machine.cpu.pc).toBe(0xc000)
  })

  // Setting the PC mid-instruction would otherwise let the CPU finish the old
  // one against the new address and execute a spliced-together opcode.
  it('abandons the instruction in flight when the PC moves', () => {
    const { methods, session } = target()
    program(session, 0xc000, 0xad, 0x00, 0x04) // LDA $0400, a 4-cycle instruction
    session.machine.tick()
    expect(session.machine.cpu.cyclesRem).toBeGreaterThan(0)

    methods['reg.set']!({ PC: 0xc100 })
    expect(session.machine.cpu.cyclesRem).toBe(0)
  })

  it('rejects a byte that is not one', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['reg.set']!({ A: 256 }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })
})

/** The bytes of a `mem.read` result. */
const decode = (result: unknown): number[] => [
  ...Buffer.from((result as { data: string }).data, 'base64')
]

describe('mem', () => {
  it('writes and reads back', () => {
    const { methods } = target()
    methods['mem.write']!({ address: 0x0300, data: [0xde, 0xad, 0xbe, 0xef] })
    expect(decode(methods['mem.read']!({ address: 0x0300, length: 4 }))).toEqual([
      0xde, 0xad, 0xbe, 0xef
    ])
  })

  it('accepts base64 as well as an array', () => {
    const { methods } = target()
    methods['mem.write']!({ address: 0x0300, data: Buffer.from([1, 2, 3]).toString('base64') })
    expect(decode(methods['mem.read']!({ address: 0x0300, length: 3 }))).toEqual([1, 2, 3])
  })

  it('fills', () => {
    const { methods } = target()
    methods['mem.fill']!({ address: 0x0400, length: 16, value: 0xaa })
    expect(decode(methods['mem.read']!({ address: 0x040f, length: 1 }))).toEqual([0xaa])
  })

  it('searches', () => {
    const { methods } = target()
    methods['mem.write']!({ address: 0x1234, data: [0xca, 0xfe] })
    expect(methods['mem.search']!({ space: 'ram', pattern: [0xca, 0xfe] })).toMatchObject({
      matches: [0x1234]
    })
  })

  it('wraps the CPU space at 64K, as the address bus does', () => {
    const { methods } = target()
    methods['mem.write']!({ address: 0xffff, data: [0x11, 0x22] })
    // The second byte lands at $0000, not past the end of memory.
    expect(decode(methods['mem.read']!({ address: 0x0000, length: 1 }))).toEqual([0x22])
  })

  // Reading VRAM through the CPU would disturb the address latch, so it has its
  // own space — and asking for it on a serial machine has no sensible answer.
  it('reaches VRAM only when a video card is present', async () => {
    const withVideo = target({ console: 'video' })
    withVideo.methods['mem.write']!({ space: 'vram', address: 0x100, data: [0x5a] })
    expect(decode(withVideo.methods['mem.read']!({ space: 'vram', address: 0x100, length: 1 })))
      .toEqual([0x5a])

    const serial = target()
    const error = await errorOf(() =>
      serial.methods['mem.read']!({ space: 'vram', address: 0, length: 1 })
    )
    expect(error.code).toBe(ErrorCode.NOT_SUPPORTED)
  })

  it('reaches the CF image and the clock chip RAM', () => {
    const { methods } = target()
    methods['mem.write']!({ space: 'cf', address: 1024, data: [0x77] })
    expect(decode(methods['mem.read']!({ space: 'cf', address: 1024, length: 1 }))).toEqual([0x77])

    methods['mem.write']!({ space: 'nvram', address: 8, data: [0x33] })
    expect(decode(methods['mem.read']!({ space: 'nvram', address: 8, length: 1 }))).toEqual([0x33])
  })

  // `6502 dbg mem 0x400 --space cf` sends the address as the string it was typed.
  it('takes a device-space offset written as $hex, 0xhex or decimal text', async () => {
    const { methods } = target()
    methods['mem.write']!({ space: 'cf', address: '0x8000', data: [0x42] })
    expect(decode(methods['mem.read']!({ space: 'cf', address: '$8000', length: 1 }))).toEqual([0x42])
    expect(decode(methods['mem.read']!({ space: 'cf', address: '32768', length: 1 }))).toEqual([0x42])

    const withVideo = target({ console: 'video' })
    withVideo.methods['mem.write']!({ space: 'vram', address: '$100', data: [0x5a] })
    expect(decode(withVideo.methods['mem.read']!({ space: 'vram', address: '256', length: 1 })))
      .toEqual([0x5a])

    for (const address of ['-1', '$', '0xZZ', 'main', 1.5]) {
      expect((await errorOf(() => methods['mem.read']!({ space: 'cf', address }))).code).toBe(
        ErrorCode.INVALID_PARAMS
      )
    }
  })

  // Writes through the CPU space are ignored above $8000, exactly as on the
  // hardware, so patching a ROM image needs its own space.
  it('patches the ROM image, which a CPU-space write cannot', () => {
    const { methods } = target()

    methods['mem.write']!({ address: 0xa000, data: [0x99] })
    expect(decode(methods['mem.read']!({ address: 0xa000, length: 1 }))).not.toEqual([0x99])

    methods['mem.write']!({ space: 'rom', address: 0xa000 - 0x8000, data: [0x99] })
    expect(decode(methods['mem.read']!({ address: 0xa000, length: 1 }))).toEqual([0x99])
  })

  it('refuses to run off the end of a device space', async () => {
    const { methods } = target()
    const error = await errorOf(() =>
      methods['mem.read']!({ space: 'nvram', address: 250, length: 16 })
    )
    expect(error.code).toBe(ErrorCode.INVALID_PARAMS)
  })

  it('rejects an unknown space and a bad length', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['mem.read']!({ space: 'tape', address: 0 }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
    expect((await errorOf(() => methods['mem.read']!({ address: 0, length: 0 }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })

  // The debugger must not trip the watchpoints the program set — they exist to
  // catch what the program does, not what the person inspecting it does.
  it('does not fire a watchpoint', () => {
    const { methods, session } = target()
    session.addBreakpoint({ kind: 'access', address: 0x0400 })

    const stops: unknown[] = []
    session.onStop((reason) => stops.push(reason))

    methods['mem.read']!({ address: 0x0400, length: 1 })
    methods['mem.write']!({ address: 0x0400, data: [1] })
    expect(stops).toHaveLength(0)
  })
})

describe('disasm', () => {
  it('decodes from the PC by default', () => {
    const { methods, session } = target()
    program(session, 0xc000, 0xa9, 0x42, 0xea)

    const result = methods['disasm.at']!({ count: 2 }) as {
      instructions: { address: number; name: string; text: string }[]
    }
    expect(result.instructions[0]).toMatchObject({ address: 0xc000, name: 'LDA' })
    expect(result.instructions[0]!.text).toContain('LDA #$42')
    expect(result.instructions[1]).toMatchObject({ address: 0xc002, name: 'NOP' })
  })

  it('names a target it has a symbol for', () => {
    const { methods, session, target: t } = target()
    t.symbols.add({ name: 'Chrout', address: 0xa000 })
    program(session, 0xc000, 0x20, 0x00, 0xa0) // JSR $A000

    const result = methods['disasm.at']!({ count: 1 }) as {
      instructions: { label?: string; text: string }[]
    }
    expect(result.instructions[0]!.label).toBe('Chrout')
    expect(result.instructions[0]!.text).toContain('JSR Chrout')
  })

  it('decodes a range', () => {
    const { methods, session } = target()
    program(session, 0xc000)
    const result = methods['disasm.range']!({ start: 0xc000, end: 0xc003 }) as {
      instructions: unknown[]
    }
    expect(result.instructions).toHaveLength(4)
  })

  it('refuses a range that runs backwards', async () => {
    const { methods } = target()
    expect(
      (await errorOf(() => methods['disasm.range']!({ start: 0xc010, end: 0xc000 }))).code
    ).toBe(ErrorCode.INVALID_PARAMS)
  })
})

describe('sym', () => {
  it('loads VICE labels from text and resolves both ways', async () => {
    const { methods, session } = target()

    expect(
      await methods['sym.load']!({ text: 'al C:C000 .main\nal C:A000 .Chrout\n' })
    ).toMatchObject({
      format: 'vice',
      loaded: 2
    })

    expect(methods['sym.resolve']!({ name: 'main' })).toEqual({ name: 'main', address: 0xc000 })
    expect(methods['sym.lookup']!({ address: 0xc007 })).toMatchObject({ name: 'main', offset: 7 })

    // Loaded symbols become available to breakpoint conditions too.
    expect(session.symbolResolver?.('Chrout')).toBe(0xa000)
  })

  it('lists with a prefix', async () => {
    const { methods } = target()
    await methods['sym.load']!({ text: 'al C:C000 .main\nal C:C010 .mainLoop\nal C:A000 .other\n' })

    expect(methods['sym.list']!({ prefix: 'main' })).toMatchObject({ total: 2 })
  })

  it('reports an unknown name rather than guessing an address', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['sym.resolve']!({ name: 'nope' }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })

  // A host with no filesystem — the renderer, in Phase 7 — has to say so rather
  // than fail in some other way.
  it('says so when it cannot read files', async () => {
    const { methods } = target()
    const error = await errorOf(() => methods['sym.load']!({ path: '/tmp/nope.lbl' }))
    expect(error.code).toBe(ErrorCode.NOT_SUPPORTED)
  })
})

describe('serial', () => {
  it('queues text, translating newlines to what a terminal sends', () => {
    const { methods, written } = target()
    methods['serial.write']!({ data: 'PRINT 2+2\n' })
    // BASIC ends a line on CR; an LF would type the line and leave it there.
    expect(written[0]).toBe('PRINT 2+2\r')
  })

  it('collapses CRLF so a Windows-authored script does not submit twice', () => {
    const { methods, written } = target()
    methods['serial.write']!({ data: 'LIST\r\n' })
    expect(written[0]).toBe('LIST\r')
  })

  it('sends base64 through untouched', () => {
    const { methods, written } = target()
    methods['serial.write']!({
      data: Buffer.from([0x1b, 0x0a]).toString('base64'),
      encoding: 'base64'
    })
    expect(written[0]).toBe('\x1b\n')
  })

  it('reads back what the machine printed', () => {
    const { methods, emit } = target()
    emit('READY.\r\n')
    expect(methods['serial.read']!({})).toMatchObject({ data: 'READY.\r\n' })
  })

  it('says so when the machine has no serial console', async () => {
    const { methods } = target({ serial: false })
    expect((await errorOf(() => methods['serial.write']!({ data: 'x' }))).code).toBe(
      ErrorCode.NOT_SUPPORTED
    )
  })
})

describe('wait.for', () => {
  it('matches output that arrives after the call', async () => {
    const { methods, emit } = target()
    const pending = methods['wait.for']!({ serial: 'OK', timeoutMs: 2000 })

    emit('OK\r\n')
    expect(await pending).toMatchObject({ matched: true, reason: 'serial' })
  })

  /**
   * The case that makes one-shot CLI calls usable at all.
   *
   * Between a `serial.write` process and a `wait.for` process the machine can
   * run hundreds of thousands of cycles in turbo, so the reply is normally
   * already printed before the wait exists. Defaulting to the cursor recorded
   * at the last write is what stops that being a lost race.
   */
  it('finds a reply that was already printed before the wait started', async () => {
    const { methods, emit } = target()

    methods['serial.write']!({ data: 'PRINT 2+2\n' })
    emit('PRINT 2+2\r\n 4\r\n\r\nOK\r\n')

    const result = (await methods['wait.for']!({ serial: 'OK', timeoutMs: 500 })) as {
      matched: boolean
      output: string
    }
    expect(result.matched).toBe(true)
    expect(result.output).toContain(' 4')
  })

  /**
   * Bug 21, and the shape the DOCS site hit: `(OK|PRESS)` matches inside the
   * `YOU PRESSED` of a line the machine is still printing.
   *
   * What the caller could not do was tell where the match ended — output
   * arrives in whatever chunks the host flushed, so the transcript held a
   * different amount of the line every run. `matchEnd` says where, while
   * `output` still holds everything received: cutting it here instead would
   * take the rest of the chunk away from a caller that reads `output` across
   * successive waits, which is the same loss this call was fixed to stop.
   */
  it('says where the match ends, and still returns the whole chunk', async () => {
    const { methods, emit } = target()
    const pending = methods['wait.for']!({ serial: '(OK|PRESS)', timeoutMs: 2000 })

    // One flush, as the host happened to deliver it. The match is 12 bytes in
    // and there are 16 more bytes in the same chunk.
    emit(' 1 YOU PRESSED A (CODE 65)\r\n')

    const result = (await pending) as {
      matched: boolean
      output: string
      cursor: number
      matchEnd: number
    }
    expect(result.matched).toBe(true)
    expect(result.output).toBe(' 1 YOU PRESSED A (CODE 65)\r\n')
    expect(result.matchEnd).toBe(12)
    expect(result.output.slice(0, result.matchEnd)).toBe(' 1 YOU PRESS')
    expect(result.cursor).toBe(result.output.length)
  })

  /**
   * The regression that shipped in 3.2.1 and broke two 6502-DOCS samples.
   *
   * A harness waits for one thing, then waits for the next, and builds its
   * transcript out of what each call returned. When 3.2.1 cut `output` at the
   * match, whatever followed the match in that same chunk was returned to
   * nobody unless the caller knew to pass `cursor` back as `since` — so the
   * second expectation could never be satisfied. Both halves of the machine's
   * answer arrive in one flush here, which is exactly how a real one behaves.
   */
  it('lets a caller reading output across two waits see text that followed the first match', async () => {
    const { methods, emit } = target()
    const first = methods['wait.for']!({ serial: 'BANK 3', timeoutMs: 2000 })

    emit('BANK 3 SNOWDROPS AND MUD\r\nBANK 9 APPLES AND WOODSMOKE\r\n')

    const a = (await first) as { output: string }
    const b = (await methods['wait.for']!({ serial: 'BANK 9', timeoutMs: 500 })) as {
      output: string
    }

    // Concatenating what the calls returned — the naive thing every harness
    // does — must contain both lines.
    expect(a.output + b.output).toContain('BANK 3 SNOWDROPS AND MUD')
    expect(a.output + b.output).toContain('BANK 9 APPLES AND WOODSMOKE')
  })

  /**
   * The other half of the fix: what is not in the transcript is still reachable.
   * Before this, `wait.for` returned no cursor at all, so a one-shot client had
   * no position to read on from and the bytes between the cut and the next
   * `serial.write` were lost to everybody.
   */
  it('reports a cursor the rest of the output can be read from, losing nothing', async () => {
    const { methods, emit } = target()
    const pending = methods['wait.for']!({ serial: '(OK|PRESS)', timeoutMs: 2000 })

    emit(' 1 YOU PRESSED A (CODE 65)\r\n')
    emit('\r\nOK\r\n')

    const result = (await pending) as { output: string; cursor: number }
    const rest = methods['serial.read']!({ since: result.cursor }) as { data: string }

    expect(rest.data).toBe('\r\nOK\r\n')
    // Transcript plus remainder is the whole stream, byte for byte: nothing
    // dropped between them and nothing counted twice.
    expect(result.output + rest.data).toBe(' 1 YOU PRESSED A (CODE 65)\r\n\r\nOK\r\n')
  })

  it('positions a backlog transcript in the stream', async () => {
    const { methods, emit } = target()
    emit('BOOT\r\n')

    methods['serial.write']!({ data: 'PRINT 2+2\n' })
    emit('PRINT 2+2\r\n 4\r\n\r\nOK\r\n')

    const result = (await methods['wait.for']!({ serial: 'OK', timeoutMs: 500 })) as {
      output: string
      cursor: number
    }
    expect(result.output).toBe('PRINT 2+2\r\n 4\r\n\r\nOK\r\n')
    // Six bytes of `BOOT\r\n` came before the write, and are not in the
    // transcript — but the cursor counts them, because it is a stream position.
    expect(result.cursor).toBe('BOOT\r\n'.length + result.output.length)
  })

  it('reports a cursor for the whole transcript when nothing matched', async () => {
    const { methods, emit } = target()
    const pending = methods['wait.for']!({ serial: 'never', timeoutMs: 100 })
    emit('READY.\r\n')

    const result = (await pending) as { matched: boolean; output: string; cursor: number }
    expect(result.matched).toBe(false)
    expect(result.output).toBe('READY.\r\n')
    expect(result.cursor).toBe(8)
  })

  it('does not match output from before the point asked for', async () => {
    const { methods, emit } = target()
    emit('OK\r\n')

    // since = the end of the stream, i.e. strictly new output only.
    const result = (await methods['wait.for']!({
      serial: 'OK',
      since: 4,
      timeoutMs: 200
    })) as { matched: boolean }
    expect(result.matched).toBe(false)
  })

  it('reports a timeout rather than failing', async () => {
    const { methods } = target()
    expect(await methods['wait.for']!({ serial: 'never', timeoutMs: 100 })).toMatchObject({
      matched: false,
      reason: 'timeout'
    })
  })

  it('waits for a cycle budget, measured in emulated time', async () => {
    const { methods, session } = target()
    program(session, 0xc000)

    const result = (await methods['wait.for']!({
      cycles: 50_000,
      run: 'turbo',
      timeoutMs: 5000
    })) as { reason: string; elapsedCycles: number }

    expect(result.reason).toBe('cycles')
    expect(result.elapsedCycles).toBeGreaterThanOrEqual(50_000)
    session.pause()
  })

  it('waits for an expression over the machine state', async () => {
    const { methods, session } = target()
    // LDX #0; INX; JMP $C002 — X climbs until it wraps.
    program(session, 0xc000, 0xa2, 0x00, 0xe8, 0x4c, 0x02, 0xc0)

    const result = (await methods['wait.for']!({
      expression: 'X > 100',
      run: 'turbo',
      timeoutMs: 5000
    })) as { reason: string }

    expect(result.reason).toBe('expression')
    session.pause()
  })

  it('waits for the machine to stop', async () => {
    const { methods, session } = target()
    program(session, 0xc000)
    session.addBreakpoint({ address: 0xc010 })

    const result = (await methods['wait.for']!({
      stopped: true,
      run: 'turbo',
      timeoutMs: 5000
    })) as { reason: string; stop: { kind: string; address: number } }

    expect(result.reason).toBe('stopped')
    expect(result.stop).toMatchObject({ kind: 'breakpoint', address: 0xc010 })
  })

  /**
   * The `stopped` counterpart to the serial-cursor case above, and it bit a
   * worked example before it bit a user: a breakpoint armed by one `6502 dbg`
   * process fires while the *next* one is still starting up, so a wait that only
   * listened for a future stop timed out with the machine sitting there stopped.
   */
  it('reports a stop that already happened, with the reason it happened for', async () => {
    const { methods, session } = target()
    program(session, 0xc000)
    session.addBreakpoint({ address: 0xc010 })

    // Run to the breakpoint first, so the stop is in the past by the time the
    // wait is set up — exactly what a separate process would find.
    await methods['wait.for']!({ stopped: true, run: 'turbo', timeoutMs: 5000 })
    expect(session.isRunning).toBe(false)

    const result = (await methods['wait.for']!({ stopped: true, timeoutMs: 200 })) as {
      matched: boolean
      reason: string
      stop: { kind: string; address: number }
    }

    expect(result.matched).toBe(true)
    expect(result.stop).toMatchObject({ kind: 'breakpoint', address: 0xc010 })
  })

  it('reports a machine that was simply never started as paused', async () => {
    const { methods } = target()
    const result = (await methods['wait.for']!({ stopped: true, timeoutMs: 200 })) as {
      matched: boolean
      stop: { kind: string }
    }
    expect(result).toMatchObject({ matched: true, stop: { kind: 'paused' } })
  })

  /**
   * `--stopped --run turbo` means "continue, and tell me when it stops again",
   * so the already-stopped shortcut must not short-circuit it — otherwise
   * resuming from a breakpoint would return instantly without running.
   */
  it('runs first when asked to, rather than answering with the stop it is leaving', async () => {
    const { methods, session } = target()
    program(session, 0xc000)
    session.addBreakpoint({ address: 0xc010 })

    await methods['wait.for']!({ stopped: true, run: 'turbo', timeoutMs: 5000 })
    const stoppedAt = session.cycles

    // Ahead of where it stopped: the program is NOPs climbing through the
    // address space, so a breakpoint behind the PC would never be reached.
    session.breakpoints.clear()
    session.addBreakpoint({ address: 0xc020 })

    const result = (await methods['wait.for']!({
      stopped: true,
      run: 'turbo',
      timeoutMs: 5000
    })) as { stop: { address: number } }

    expect(result.stop.address).toBe(0xc020)
    expect(session.cycles).toBeGreaterThan(stoppedAt)
  })

  /**
   * The other half of that rule, and the bug it was written for
   * (6502-EMULATOR#1): "continue" only means continue to a caller that has been
   * told what it is continuing from. A one-shot client arms a watchpoint, makes
   * the machine trigger it, and then asks to run on and be told about the next
   * stop — but the stop it wanted has already fired, unwitnessed, and for a
   * one-off write there is no next one. Resuming past it timed out with the
   * answer sitting in front of it.
   */
  it('answers with a stop no client has been told about instead of resuming past it', async () => {
    const { methods, session } = target()
    // LDA #$01; STA $0300, then NOPs.
    program(session, 0xc000, 0xa9, 0x01, 0x8d, 0x00, 0x03)
    session.addBreakpoint({ kind: 'write', address: 0x0300 })

    // The write happens with nobody listening: between two `6502 dbg`
    // processes, which is the normal case, not an edge one.
    session.run('turbo')
    expect(session.isRunning).toBe(false)

    const result = (await methods['wait.for']!({
      stopped: true,
      run: 'turbo',
      timeoutMs: 500
    })) as { matched: boolean; reason: string; stop: { kind: string; address: number } }

    expect(result).toMatchObject({ matched: true, reason: 'stopped' })
    expect(result.stop).toMatchObject({ kind: 'watchpoint', address: 0x0300, access: 'write' })
    // And it did not run on past it.
    expect(session.isRunning).toBe(false)
  })

  it('having answered once, continues the next time it is asked', async () => {
    const { methods, session } = target()
    program(session, 0xc000, 0xa9, 0x01, 0x8d, 0x00, 0x03)
    session.addBreakpoint({ kind: 'write', address: 0x0300 })
    session.run('turbo')

    await methods['wait.for']!({ stopped: true, run: 'turbo', timeoutMs: 500 })
    const stoppedAt = session.cycles

    // Ahead of where it stopped, so only a machine that actually resumed
    // reaches it.
    session.breakpoints.clear()
    session.addBreakpoint({ address: 0xc020 })

    const result = (await methods['wait.for']!({
      stopped: true,
      run: 'turbo',
      timeoutMs: 5000
    })) as { stop: { address: number } }

    expect(result.stop.address).toBe(0xc020)
    expect(session.cycles).toBeGreaterThan(stoppedAt)
  })

  it('counts a stop returned by exec.* as reported, and continues from it', async () => {
    const { methods, session } = target()
    program(session, 0xc000)

    // runTo hands the stop back in its own result, so the caller has seen it.
    await methods['exec.runTo']!({ address: 0xc010, timeoutMs: 5000 })
    const stoppedAt = session.cycles

    session.addBreakpoint({ address: 0xc020 })
    const result = (await methods['wait.for']!({
      stopped: true,
      run: 'turbo',
      timeoutMs: 5000
    })) as { stop: { address: number } }

    expect(result.stop.address).toBe(0xc020)
    expect(session.cycles).toBeGreaterThan(stoppedAt)
  })

  it('insists on being given something to wait for', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['wait.for']!({ timeoutMs: 100 }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })

  it('rejects a pattern that will not compile', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['wait.for']!({ serial: '[' }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })
})

describe('media', () => {
  it('refuses a ROM that is not exactly 32K', async () => {
    const { methods } = target()
    const error = await errorOf(() =>
      methods['media.loadROM']!({ data: Buffer.alloc(1024).toString('base64') })
    )
    expect(error.code).toBe(ErrorCode.LOAD_FAILED)
  })

  it('loads a ROM and re-reads the reset vector', async () => {
    const { methods, session } = target()
    const rom = Buffer.alloc(0x8000, 0xea)
    rom[0xfffc - 0x8000] = 0x34
    rom[0xfffd - 0x8000] = 0xc2

    await methods['media.loadROM']!({ data: rom.toString('base64') })
    expect(session.machine.cpu.pc).toBe(0xc234)
  })

  it('loads raw bytes at an address', async () => {
    const { methods, session } = target()
    await methods['media.loadBinary']!({ address: 0x2000, data: [1, 2, 3] })
    expect(session.machine.peek(0x2000)).toBe(1)
    expect(session.machine.peek(0x2002)).toBe(3)
  })

  it('refuses raw bytes that will not fit in RAM', async () => {
    const { methods } = target()
    const error = await errorOf(() =>
      methods['media.loadBinary']!({ address: 0xc000, data: [1, 2, 3] })
    )
    expect(error.code).toBe(ErrorCode.LOAD_FAILED)
  })

  it('needs either a path or inline data', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['media.loadBinary']!({ address: 0x2000 }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })
})

describe('input', () => {
  it('presses and releases a key by name or raw HID code', () => {
    const { methods, session } = target()
    const down = jest.spyOn(session.machine, 'onKeyDown')
    const up = jest.spyOn(session.machine, 'onKeyUp')

    expect(methods['input.key']!({ code: 'KeyA' })).toEqual({ code: 0x04, down: true })
    expect(down).toHaveBeenCalledWith(0x04)

    expect(methods['input.key']!({ code: 0x04, down: false })).toEqual({ code: 0x04, down: false })
    expect(up).toHaveBeenCalledWith(0x04)
  })

  it('rejects a key name that does not exist', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['input.key']!({ code: 'NotAKey' }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })

  it('drives a joystick by bitmask or by named buttons', () => {
    const { methods, session } = target()
    const onA = jest.spyOn(session.machine, 'onJoystickA')
    const onB = jest.spyOn(session.machine, 'onJoystickB')

    methods['input.joystick']!({ buttons: 0x01 })
    expect(onA).toHaveBeenCalledWith(0x01)

    methods['input.joystick']!({ side: 'b', buttons: ['up', 'a'] })
    expect(onB).toHaveBeenCalledWith(0x01 | 0x10)
  })

  it('rejects an unknown button name', async () => {
    const { methods } = target()
    expect(
      (await errorOf(() => methods['input.joystick']!({ buttons: ['not-a-button'] }))).code
    ).toBe(ErrorCode.INVALID_PARAMS)
  })

  it('types text as a paced sequence of keystrokes', async () => {
    const { methods, session } = target()
    program(session, 0xc000) // NOPs forever — nothing needs to read the keys
    session.run('turbo')

    const down = jest.spyOn(session.machine, 'onKeyDown')
    const result = (await methods['input.type']!({ text: 'Hi!', cps: 1000 })) as {
      typed: number
    }

    session.pause()

    expect(result.typed).toBe(3)
    // 'H' needs Shift; 'i' and '!' both need a keystroke as well, '!' shifted.
    expect(down).toHaveBeenCalledWith(0xe1) // Shift, for 'H' and '!'
    expect(down).toHaveBeenCalledWith(0x0b) // KeyH
    expect(down).toHaveBeenCalledWith(0x0c) // KeyI
    expect(down).toHaveBeenCalledWith(0x1e) // Digit1, shifted for '!'
  })

  it('refuses to type into a paused machine rather than hanging forever', async () => {
    const { methods, session } = target()
    program(session, 0xc000)
    expect((await errorOf(() => methods['input.type']!({ text: 'x' }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
    void session
  })

  it('rejects a character with no US-keyboard equivalent', async () => {
    const { methods, session } = target()
    program(session, 0xc000)
    session.run('turbo')
    const error = await errorOf(() => methods['input.type']!({ text: '€' }))
    session.pause()
    expect(error.code).toBe(ErrorCode.INVALID_PARAMS)
  })
})

describe('screen', () => {
  it('reads the name table as text', () => {
    const { methods, session } = target({ console: 'video' })
    const video = (session.machine.video() as Video)
    video.write(1, 0x0e) // register value: name table at $3800 — stage 0
    video.write(1, 0x82) // register 2 — stage 1
    for (const [i, ch] of [...'HELLO'].entries()) video.writeVRAM(0x3800 + i, ch.charCodeAt(0))

    const result = methods['screen.text']!({}) as { lines: string[] }
    expect(result.lines[0]!.startsWith('HELLO')).toBe(true)
  })

  it('hashes the frame buffer', () => {
    const { methods } = target({ console: 'video' })
    const a = methods['screen.hash']!({}) as { hash: string }
    const b = methods['screen.hash']!({}) as { hash: string }
    expect(a.hash).toBe(b.hash)
    expect(a.hash).toMatch(/^[0-9a-f]{8}$/)
  })

  it('encodes the frame as a PNG', () => {
    const { methods } = target({ console: 'video' })
    const result = methods['screen.png']!({}) as { width: number; height: number; data: string }
    expect(result.width).toBe(320)
    expect(result.height).toBe(240)
    expect(Buffer.from(result.data, 'base64').subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  })

  it('reports no video card rather than guessing at a screen', async () => {
    const { methods } = target() // serial console — io8 is Empty
    expect((await errorOf(() => methods['screen.text']!({}))).code).toBe(ErrorCode.NOT_SUPPORTED)
    expect((await errorOf(() => methods['screen.hash']!({}))).code).toBe(ErrorCode.NOT_SUPPORTED)
    expect((await errorOf(() => methods['screen.png']!({}))).code).toBe(ErrorCode.NOT_SUPPORTED)
  })

  it('reads a name table laid out on any of the four grids, not only the legacy two', () => {
    const { methods, session } = target({ console: 'video' })
    const video = (session.machine.video() as Video)
    video.setRegister(0x0d, 0x04) // VMODE: Full, 40 x 30
    video.setRegister(0x10, 0x04) // L0NAME: $1000
    video.writeVRAM(0x1000 + 40 * 30 - 1, 'Z'.charCodeAt(0))

    const { lines } = methods['screen.text']!({}) as { lines: string[] }
    expect(lines).toHaveLength(30)
    expect(lines[29]).toHaveLength(40)
    expect(lines[29]!.endsWith('Z')).toBe(true)
  })
})

describe('video', () => {
  it('reports the mode in §9 terms, the status registers and both ports', () => {
    const { methods, session } = target({ console: 'video' })
    const video = (session.machine.video() as Video)
    video.setRegister(0x0d, 0x03) // VMODE: Graphics
    video.write(3, 0x00)
    video.write(3, 0x60) // port B: write pointer $2000

    const info = methods['video.info']!({}) as {
      mode: { vmode: number; legacy: string | null; geometry: string; cols: number; rows: number }
      status: number[]
      ports: { a: { pointer: number }; b: { pointer: number; readMode: boolean } }
      vramSize: number
      paletteBase: number
    }

    expect(info.mode).toMatchObject({ vmode: 3, legacy: null, geometry: 'graphics', cols: 32, rows: 30 })
    expect(info.status).toHaveLength(16)
    expect(info.status[4]).toBe(0xac) // §16's identification byte
    expect(info.ports.a.pointer).toBe(0)
    expect(info.ports.b).toMatchObject({ pointer: 0x2000, readMode: false })
    expect(info.vramSize).toBe(0x10000)
    expect(info.paletteBase).toBe(0xfc00) // PALBASE resets to $3F (§15)
  })

  it('does not acknowledge an interrupt by looking at it', () => {
    const { methods, session } = target({ console: 'video' })
    const video = (session.machine.video() as Video)
    video.setRegister(1, 0x60) // display on, vblank interrupt enabled
    for (let i = 0; i < 17_000; i++) video.tick(1_000_000)

    const first = methods['video.info']!({}) as { status: number[] }
    const second = methods['video.info']!({}) as { status: number[] }
    expect(first.status[0]! & 0x80).toBe(0x80)
    expect(second.status[0]! & 0x80).toBe(0x80)
    expect(second.status[1]! & 0x01).toBe(0x01)
  })

  it('reads all 128 registers, aliases included (§5)', () => {
    const { methods, session } = target({ console: 'video' })
    const video = (session.machine.video() as Video)
    video.setRegister(0x02, 0x0e) // name table, by its TMS9918 number
    video.setRegister(0x7f, 0x5a)

    const { registers } = methods['video.registers']!({}) as { registers: number[] }
    expect(registers).toHaveLength(128)
    expect(registers[0x10]).toBe(0x0e) // L0NAME: the same byte
    expect(registers[0x7f]).toBe(0x5a)
  })

  it('writes a register through the card, with the side effects a program would get', () => {
    const { methods, session } = target({ console: 'video' })
    const video = (session.machine.video() as Video)

    // MODE1's IE bit and IRQEN b0 are one bit with two homes (§14); a debugger
    // that set one and not the other would leave the card contradicting itself.
    const result = methods['video.setRegister']!({ register: 1, value: 0x20 })
    expect(result).toEqual({ register: 1, value: 0x20 })
    expect(video.getRegister(0x0a) & 0x01).toBe(0x01) // IRQEN

    methods['video.setRegister']!({ register: 0x0d, value: 0x01 })
    expect(video.getMode().geometry).toBe('text')
  })

  it('refuses a register or value out of range', async () => {
    const { methods } = target({ console: 'video' })
    for (const params of [
      { register: 128, value: 0 },
      { register: -1, value: 0 },
      { register: 0, value: 256 },
      { register: 1.5, value: 0 }
    ]) {
      expect((await errorOf(() => methods['video.setRegister']!(params))).code).toBe(
        ErrorCode.INVALID_PARAMS
      )
    }
  })

  it('reads the palette the card draws with, and where it is stored', () => {
    const { methods, session } = target({ console: 'video' })
    const video = (session.machine.video() as Video)
    video.writeVRAM(0xfc00 + 2 * 0x21, 0x0f) // entry $21: red nibble
    video.writeVRAM(0xfc00 + 2 * 0x21 + 1, 0x80) // green and blue

    const palette = methods['video.palette']!({}) as { base: number; entries: number[] }
    expect(palette.base).toBe(0xfc00)
    expect(palette.entries).toHaveLength(256)
    expect(palette.entries[0x0f]).toBe(0xfff) // row 0's white (§11)
    expect(palette.entries[0x21]).toBe(0xf80)
  })

  it('follows PALBASE when a program moves the palette', () => {
    const { methods, session } = target({ console: 'video' })
    const video = (session.machine.video() as Video)
    video.writeVRAM(0x0400 + 2 * 1, 0x0a)
    video.writeVRAM(0x0400 + 2 * 1 + 1, 0xbc)
    methods['video.setRegister']!({ register: 0x0c, value: 0x01 }) // PALBASE: $0400

    const palette = methods['video.palette']!({}) as { base: number; entries: number[] }
    expect(palette.base).toBe(0x0400)
    expect(palette.entries[1]).toBe(0xabc)
  })

  it('reports no video card for every video method', async () => {
    const { methods } = target()
    for (const method of ['video.info', 'video.registers', 'video.palette']) {
      expect((await errorOf(() => methods[method]!({}))).code).toBe(ErrorCode.NOT_SUPPORTED)
    }
    expect(
      (await errorOf(() => methods['video.setRegister']!({ register: 0, value: 0 }))).code
    ).toBe(ErrorCode.NOT_SUPPORTED)
  })

  it('reaches all 64 KB of VRAM through mem.*, and refuses the byte past it', async () => {
    const { methods } = target({ console: 'video' })
    methods['mem.write']!({ space: 'vram', address: 0xffff, data: [0xa5] })
    expect(decode(methods['mem.read']!({ space: 'vram', address: 0xffff, length: 1 }))).toEqual([0xa5])

    const error = await errorOf(() => methods['mem.read']!({ space: 'vram', address: 0x10000 }))
    expect(error.code).toBe(ErrorCode.INVALID_PARAMS)
  })
})

describe('video, on a TMS9918A', () => {
  it('reports its mode, display bit, one status byte and 16 KB, and nothing it does not have', () => {
    const { methods, session } = target({ console: 'video', vdp: 'tms9918a' })
    const video = session.machine.video() as TMS9918A
    video.setRegister(1, 0x50) // display on, Text mode

    expect(methods['video.info']!({})).toEqual({
      vdp: 'tms9918a',
      mode: 'TEXT',
      displayEnabled: true,
      status: [0],
      vramSize: 0x4000
    })
  })

  it('reads and bounds eight registers', async () => {
    const { methods, session } = target({ console: 'video', vdp: 'tms9918a' })
    methods['video.setRegister']!({ register: 7, value: 0xf4 })
    expect(session.machine.video()!.getRegister(7)).toBe(0xf4)

    const { registers } = methods['video.registers']!({}) as { registers: number[] }
    expect(registers).toHaveLength(8)
    expect(registers[7]).toBe(0xf4)

    const error = await errorOf(() => methods['video.setRegister']!({ register: 8, value: 0 }))
    expect(error.code).toBe(ErrorCode.INVALID_PARAMS)
    expect(error.message).toMatch(/expected 0-7/)
  })

  it('has no palette to show', async () => {
    const { methods } = target({ console: 'video', vdp: 'tms9918a' })
    const error = await errorOf(() => methods['video.palette']!({}))
    expect(error.code).toBe(ErrorCode.NOT_SUPPORTED)
    expect(error.message).toBe('video.palette: the TMS9918A has a fixed palette')
  })

  it('reaches its 16 KB of VRAM through mem.*, and reads the screen', async () => {
    const { methods, session } = target({ console: 'video', vdp: 'tms9918a' })
    methods['mem.write']!({ space: 'vram', address: 0x3fff, data: [0xa5] })
    expect(decode(methods['mem.read']!({ space: 'vram', address: 0x3fff, length: 1 }))).toEqual([0xa5])
    const error = await errorOf(() => methods['mem.read']!({ space: 'vram', address: 0x4000 }))
    expect(error.code).toBe(ErrorCode.INVALID_PARAMS)

    const video = session.machine.video()!
    video.setRegister(2, 0x0e) // name table at $3800
    for (const [i, ch] of [...'HELLO'].entries()) video.writeVRAM(0x3800 + i, ch.charCodeAt(0))
    const { lines } = methods['screen.text']!({}) as { lines: string[] }
    expect(lines[0]!.startsWith('HELLO')).toBe(true)
    expect((methods['screen.png']!({}) as { width: number }).width).toBe(320)
  })
})

describe('state, with a video card', () => {
  /**
   * A snapshot round-trip through the debug session rather than through
   * Snapshot.ts directly — `state.save` and `state.load` over the
   * method table, and the card checked through the same `video.*` and
   * `screen.*` methods a client would use to see whether it worked.
   *
   * Everything set up here is something a version 1 snapshot could not have
   * held: a register above $07, the top of 64 KB, a moved palette, a second
   * port pair and a VMODE geometry.
   */
  it('puts back everything the card is, not only what a TMS9918 had', async () => {
    const { methods, session } = target({ console: 'video' })
    const video = (session.machine.video() as Video)

    video.setRegister(0x0d, 0x04) // VMODE: Full
    video.setRegister(0x10, 0x04) // L0NAME: $1000
    video.setRegister(0x19, 0xa5) // L1PAL
    video.writeVRAM(0x1000, 'S'.charCodeAt(0))
    video.writeVRAM(0xffff, 0x77)
    video.writeVRAM(0xfc00 + 2 * 5, 0x01) // palette entry 5: $123
    video.writeVRAM(0xfc00 + 2 * 5 + 1, 0x23)
    video.write(3, 0x00)
    video.write(3, 0x70) // port B: write pointer $3000
    video.write(1, 0x42) // port A: halfway through a command pair

    const before = {
      info: methods['video.info']!({}),
      registers: methods['video.registers']!({}),
      palette: methods['video.palette']!({}),
      text: methods['screen.text']!({})
    }
    const saved = methods['state.save']!({}) as { state: unknown }

    // Change every one of those things, so a restore that missed one shows it.
    video.setRegister(0x0d, 0x00)
    video.setRegister(0x10, 0x00)
    video.setRegister(0x19, 0x00)
    video.writeVRAM(0x1000, 0)
    video.writeVRAM(0xffff, 0)
    video.writeVRAM(0xfc00 + 2 * 5 + 1, 0x00)
    video.write(3, 0x00)
    video.write(3, 0x40)
    video.write(1, 0x00) // completes port A's pair: a read pointer, stage 0
    expect(methods['video.info']!({})).not.toEqual(before.info)

    await methods['state.load']!({ state: JSON.parse(JSON.stringify(saved.state)) })

    expect(methods['video.info']!({})).toEqual(before.info)
    expect(methods['video.registers']!({})).toEqual(before.registers)
    // The drawn palette, not only the stored bytes: the cache has to have been
    // rebuilt from restored VRAM (§11).
    expect(methods['video.palette']!({})).toEqual(before.palette)
    expect(methods['screen.text']!({})).toEqual(before.text)
    expect(decode(methods['mem.read']!({ space: 'vram', address: 0xffff, length: 1 }))).toEqual([0x77])
  })
})

describe('state', () => {
  it('saves the whole machine as JSON, with its size', () => {
    const { methods, session } = target()
    program(session, 0xc000, 0xa9, 0x42) // LDA #$42
    session.step('instruction')

    const saved = methods['state.save']!({}) as {
      state: { format: string; version: number }
      version: number
      bytes: number
    }

    expect(saved.state.format).toBe('6502-emulator-snapshot')
    expect(saved.version).toBe(saved.state.version)
    expect(saved.bytes).toBe(JSON.stringify(saved.state).length)
  })

  it('round-trips a machine through save and load', async () => {
    const { methods, session } = target()
    program(session, 0xc000, 0xa9, 0x42)
    session.step('instruction')

    const saved = methods['state.save']!({}) as { state: unknown }
    const at = session.machine.cpu.pc
    const a = session.machine.cpu.a

    session.step('instruction', 10)
    expect(session.machine.cpu.pc).not.toBe(at)

    const loaded = (await methods['state.load']!({ state: saved.state })) as {
      registers: { PC: number; A: number }
    }

    expect(loaded.registers.PC).toBe(at)
    expect(loaded.registers.A).toBe(a)
  })

  /**
   * The reason snapshots are worth having: this is the shape of an agent's inner
   * loop — restore, drive, assert — with no BIOS countdown in it.
   */
  it('restores repeatedly from one saved state', async () => {
    const { methods, session } = target()
    // INC $0300; JMP $C000 — a loop, so stepping on always changes something.
    program(session, 0xc000, 0xee, 0x00, 0x03, 0x4c, 0x00, 0xc0)
    session.step('instruction')

    const saved = methods['state.save']!({}) as { state: unknown }
    expect(session.machine.peek(0x0300)).toBe(1)

    for (let i = 0; i < 3; i++) {
      session.step('instruction', 4)
      expect(session.machine.peek(0x0300)).toBeGreaterThan(1)

      await methods['state.load']!({ state: saved.state })
      expect(session.machine.peek(0x0300)).toBe(1)
    }
  })

  it('reads a snapshot from a file when the host has one', async () => {
    const { methods, session, target: t } = target()
    program(session, 0xc000, 0xa9, 0x42)
    session.step('instruction')

    const saved = methods['state.save']!({}) as { state: unknown }
    ;(t as { readTextFile?: (path: string) => string }).readTextFile = () =>
      JSON.stringify(saved.state)

    session.step('instruction', 5)
    const loaded = (await methods['state.load']!({ path: 'ready.state' })) as {
      registers: { A: number }
    }
    expect(loaded.registers.A).toBe(0x42)
  })

  it('reports a file that is not JSON as a load failure', async () => {
    const { methods, target: t } = target()
    ;(t as { readTextFile?: (path: string) => string }).readTextFile = () => 'not json'

    const error = await errorOf(() => methods['state.load']!({ path: 'broken.state' }))
    expect(error.code).toBe(ErrorCode.LOAD_FAILED)
    expect(error.message).toMatch(/not valid JSON/)
  })

  it('needs either a state or a path', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['state.load']!({}))).code).toBe(ErrorCode.INVALID_PARAMS)
  })

  it('refuses a snapshot it cannot apply, and says the machine is untouched', async () => {
    const { methods } = target()
    const error = await errorOf(() =>
      methods['state.load']!({ state: { format: 'something-else' } })
    )

    expect(error.code).toBe(ErrorCode.LOAD_FAILED)
    expect(error.message).toMatch(/The machine is unchanged\.$/)
    expect(error.message).not.toMatch(/partial state/)
  })

  it('says how to recover when a restore fails part-way through', async () => {
    const { methods } = target()
    const saved = methods['state.save']!({}) as { state: { cpu: Record<string, unknown> } }
    // Everything checked before the first write passes; the CPU's own fields do not.
    const state = JSON.parse(JSON.stringify(saved.state))
    state.cpu = { kind: 'cpu' }

    const error = await errorOf(() => methods['state.load']!({ state }))
    expect(error.code).toBe(ErrorCode.LOAD_FAILED)
    expect(error.message).toMatch(/partial state; session\.reset to recover/)
  })
})

describe('parameters', () => {
  it('accepts an address as a number, $hex, 0xhex or a symbol', () => {
    const { methods, target: t } = target()
    t.symbols.add({ name: 'start', address: 0x0800 })

    for (const address of [0x0800, '$0800', '0x0800', '2048', 'start']) {
      expect(methods['bp.set']!({ address })).toMatchObject({ address: 0x0800 })
    }
    methods['bp.clear']!({})
  })

  it('rejects an address outside the address space', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['bp.set']!({ address: 0x10000 }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })

  it('rejects malformed base64 rather than silently writing fewer bytes', async () => {
    const { methods } = target()
    const error = await errorOf(() =>
      methods['mem.write']!({ address: 0x0300, data: 'not valid base64!!' })
    )
    expect(error.code).toBe(ErrorCode.INVALID_PARAMS)
  })

  it('rejects params that are not an object', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['exec.step']!([1, 2, 3]))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })
})
