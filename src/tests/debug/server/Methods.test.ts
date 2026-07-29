import { Session } from '../../../debug/Session'
import { Empty } from '../../../core/IO/Empty'
import { RTC } from '../../../core/IO/RTC'
import { Storage } from '../../../core/IO/Storage'
import { Video } from '../../../core/IO/Video'
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
function target(options: { console?: 'serial' | 'video'; serial?: boolean } = {}): {
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
    io8: consoleMode === 'video' ? new Video() : new Empty()
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

describe('mem', () => {
  const decode = (result: unknown): number[] => [
    ...Buffer.from((result as { data: string }).data, 'base64')
  ]

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
    const video = session.machine.video()!
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
