import { CPU } from '../../core/CPU'
import { RAM } from '../../core/RAM'
import { ROM } from '../../core/ROM'
import { Storage } from '../../core/IO/Storage'
import { RTC } from '../../core/IO/RTC'
import { DISPLAY_WIDTH, DISPLAY_HEIGHT } from '../../core/IO/Video'
import { JoystickAttachment } from '../../core/IO/Attachments/JoystickAttachment'
import type { Machine } from '../../core/Machine'
import {
  loadBinary,
  loadProgramImage,
  applyProgramPointers,
  MAX_PROGRAM_SIZE
} from '../../core/ProgramImage'
import { disassemble, disassembleRange, formatInstruction } from '../Disassembler'
import type { Instruction } from '../Disassembler'
import { compileExpression, ExpressionError } from '../Expression'
import type { StepKind, StopReason } from '../Session'
import type { Breakpoint } from '../Breakpoints'
import { parseSymbols, formatForPath } from '../symbols/parse'
import type { SymbolFormat } from '../symbols/parse'
import { resolveKeyCode, ASCII_TO_KEY, HID_NAMES } from '../KeyCodes'
import { encodePNG } from '../PNG'
import { crc32 } from '../Checksums'
import type { DebugTarget } from './DebugTarget'
import {
  ErrorCode,
  PROTOCOL_VERSION,
  RpcMethodError,
  invalidParams,
  notSupported
} from './Protocol'
import {
  asObject,
  base64,
  oneOf,
  optionalAddress,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireAddress,
  requireNumber,
  requireString,
  toBytes,
  toRegExp
} from './Params'
import type { Params } from './Params'

export type MethodHandler = (params: unknown) => unknown | Promise<unknown>
export type MethodTable = Record<string, MethodHandler>

/** How long `wait.for` waits when the caller does not say. */
const DEFAULT_WAIT_MS = 10_000

/** Ceiling on a single `mem.read`, so one call cannot hand back a 256 MB reply. */
const MAX_READ_LENGTH = 1 << 20

//
// Memory spaces
//

const SPACES = ['cpu', 'ram', 'rom', 'vram', 'nvram', 'cf'] as const
export type MemorySpace = (typeof SPACES)[number]

interface SpaceAccess {
  size: number
  read(offset: number): number
  write(offset: number, value: number): void
}

/**
 * Resolve a named memory space to something byte-addressable.
 *
 * `cpu` is the 64K the processor sees, through the address decode, so it
 * reflects cartridge banking and reads I/O registers as the program would.
 * The rest reach a device's storage directly, which is the only way to see
 * VRAM or the CF image at all — the CPU can only get at those through register
 * protocols whose side effects would disturb what is being inspected.
 */
function spaceAccess(machine: Machine, space: MemorySpace): SpaceAccess {
  switch (space) {
    case 'cpu':
      return {
        size: 0x10000,
        read: (offset) => machine.peek(offset),
        write: (offset, value) => machine.poke(offset, value)
      }

    case 'ram':
      return {
        size: RAM.SIZE,
        read: (offset) => machine.ram.data[offset] ?? 0,
        write: (offset, value) => {
          machine.ram.data[offset] = value
        }
      }

    case 'rom':
      return {
        size: ROM.SIZE,
        read: (offset) => machine.rom.data[offset] ?? 0,
        // Patching the ROM image is a legitimate debugging move — it is what
        // "try this fix without rebuilding" looks like. Writing through the CPU
        // space cannot do it, because the hardware ignores writes there.
        write: (offset, value) => {
          machine.rom.data[offset] = value
        }
      }

    case 'vram': {
      const video = machine.video()
      if (!video) {
        throw notSupported('vram: no video card is present (this machine booted serial)')
      }
      return {
        size: video.vramSize,
        read: (offset) => video.readVRAM(offset),
        write: (offset, value) => video.writeVRAM(offset, value)
      }
    }

    case 'nvram': {
      const rtc = machine.slots().find((io): io is RTC => io instanceof RTC)
      if (!rtc) throw notSupported('nvram: no real-time clock is present')
      return {
        size: rtc.nvramSize,
        read: (offset) => rtc.readNVRAM(offset),
        write: (offset, value) => rtc.writeNVRAM(offset, value)
      }
    }

    case 'cf': {
      const storage = machine.slots().find((io): io is Storage => io instanceof Storage)
      if (!storage) throw notSupported('cf: no storage card is present')
      return {
        size: storage.imageSize,
        read: (offset) => storage.readImage(offset),
        write: (offset, value) => storage.writeImage(offset, value)
      }
    }
  }
}

/**
 * The offset a space request starts at.
 *
 * For `cpu` the parameter is an address in the processor's map. For every other
 * space it is an offset from the start of that device's storage, which is why
 * `ram` and `cpu` agree below $8000 and `rom` is offset from $8000 rather than
 * addressed at it.
 */
function spaceOffset(params: Params, space: MemorySpace, resolve?: (n: string) => number | undefined): number {
  if (space === 'cpu') return requireAddress(params, 'address', resolve)

  const value = optionalNumber(params, 'address')
  if (value === undefined) throw invalidParams('address is required')
  if (!Number.isInteger(value) || value < 0) {
    throw invalidParams(`address: expected a non-negative offset into ${space}, got ${value}`)
  }
  return value
}

//
// Serialisation
//

function flagsOf(status: number): Record<string, boolean> {
  return {
    N: (status & CPU.N) !== 0,
    V: (status & CPU.V) !== 0,
    B: (status & CPU.B) !== 0,
    D: (status & CPU.D) !== 0,
    I: (status & CPU.I) !== 0,
    Z: (status & CPU.Z) !== 0,
    C: (status & CPU.C) !== 0
  }
}

function registersOf(cpu: CPU): Record<string, unknown> {
  return {
    A: cpu.a,
    X: cpu.x,
    Y: cpu.y,
    PC: cpu.pc,
    SP: cpu.sp,
    P: cpu.st,
    flags: flagsOf(cpu.st)
  }
}

function instructionJSON(instruction: Instruction): Record<string, unknown> {
  return {
    address: instruction.address,
    bytes: [...instruction.bytes],
    name: instruction.name,
    mode: instruction.mode,
    operand: instruction.operand,
    ...(instruction.target === undefined ? {} : { target: instruction.target }),
    ...(instruction.label === undefined ? {} : { label: instruction.label }),
    documented: instruction.documented,
    /** Pre-rendered listing line, so a client need not reimplement formatting. */
    text: formatInstruction(instruction).trim()
  }
}

function breakpointJSON(breakpoint: Breakpoint): Record<string, unknown> {
  return {
    id: breakpoint.id,
    kind: breakpoint.kind,
    address: breakpoint.address,
    end: breakpoint.end,
    ...(breakpoint.condition === undefined ? {} : { condition: breakpoint.condition }),
    ignoreCount: breakpoint.ignoreCount,
    temporary: breakpoint.temporary,
    enabled: breakpoint.enabled,
    hits: breakpoint.hits
  }
}

/**
 * Build the method table for a target.
 *
 * A plain object of named functions rather than a switch, so the same table can
 * be dispatched from the socket server here and from an IPC handler in Phase 7
 * without either one enumerating the methods.
 */
export function createMethods(target: DebugTarget): MethodTable {
  const { session } = target
  const machine = session.machine
  const resolveSymbol = (name: string): number | undefined => target.symbols.resolve(name)

  const state = (): Record<string, unknown> => ({
    mode: session.mode,
    running: session.isRunning,
    cycles: session.cycles,
    registers: registersOf(machine.cpu)
  })

  const stopped = (reason: StopReason): Record<string, unknown> => ({
    stop: reason,
    ...state()
  })

  const space = (params: Params): MemorySpace => oneOf(params, 'space', SPACES) ?? 'cpu'

  /**
   * Where the console stream stood when the last `serial.write` went out.
   *
   * The default `since` for `wait.for`, which is what makes the common flow —
   * send a command, wait for its reply — correct without the caller tracking
   * anything. Waiting "from now" cannot work for one-shot callers: in turbo the
   * machine covers hundreds of thousands of cycles between two RPC calls, so
   * the reply is usually already printed by the time the wait is set up.
   */
  let lastWriteCursor: number | undefined

  /**
   * Bytes for a media method, from an inline `data` field or a host file.
   *
   * Always async: the headless host reads synchronously and a sync value
   * awaits to itself, but the Electron renderer has no filesystem access of
   * its own and proxies the read to the main process over IPC.
   */
  const mediaBytes = async (params: Params, method: string): Promise<Uint8Array> => {
    const path = optionalString(params, 'path')
    if (path !== undefined) {
      if (!target.readBinaryFile) {
        throw notSupported(`${method}: this host cannot read files — pass "data" instead`)
      }
      try {
        return await target.readBinaryFile(path)
      } catch (e) {
        throw new RpcMethodError(
          ErrorCode.LOAD_FAILED,
          `${method}: cannot read "${path}": ${(e as Error).message}`
        )
      }
    }
    if (params.data === undefined) throw invalidParams(`${method}: need "path" or "data"`)
    return toBytes(params.data, 'data')
  }

  return {
    //
    // session
    //

    'session.info': () => ({
      protocol: PROTOCOL_VERSION,
      host: target.hostName,
      version: target.version,
      console: target.consoleMode(),
      frequency: machine.frequency,
      ...(target.baudRate ? { baudRate: target.baudRate() } : {}),
      cartridge: machine.cart !== undefined,
      symbols: target.symbols.size,
      ...state()
    }),

    'session.reset': (raw) => {
      const params = asObject(raw, 'session.reset')
      session.reset(optionalBoolean(params, 'cold') ?? true)
      return state()
    },

    'session.config': (raw) => {
      const params = asObject(raw, 'session.config')

      const frequency = optionalNumber(params, 'frequency')
      if (frequency !== undefined) {
        if (frequency !== 1_000_000 && frequency !== 2_000_000) {
          throw invalidParams(`frequency: the hardware supports 1000000 or 2000000, got ${frequency}`)
        }
        machine.frequency = frequency
      }

      const baudRate = optionalNumber(params, 'baudRate')
      if (baudRate !== undefined) {
        if (!target.setBaudRate) throw notSupported('session.config: no serial console')
        if (!Number.isInteger(baudRate) || baudRate <= 0) {
          throw invalidParams(`baudRate: expected a positive integer, got ${baudRate}`)
        }
        target.setBaudRate(baudRate)
      }

      return {
        frequency: machine.frequency,
        ...(target.baudRate ? { baudRate: target.baudRate() } : {}),
        console: target.consoleMode()
      }
    },

    'session.shutdown': () => {
      if (!target.shutdown) throw notSupported('session.shutdown: this host cannot be shut down')
      // Answer before winding down, or the caller sees a dropped socket instead
      // of a result. The host stops once this turn of the loop unwinds.
      setTimeout(() => target.shutdown?.(), 0)
      return { ok: true }
    },

    //
    // exec
    //

    'exec.state': () => state(),

    'exec.run': (raw) => {
      const params = asObject(raw, 'exec.run')
      session.run(oneOf(params, 'mode', ['realtime', 'turbo'] as const) ?? 'turbo')
      return state()
    },

    'exec.pause': () => stopped(session.pause()),

    'exec.step': (raw) => {
      const params = asObject(raw, 'exec.step')
      const kind = (oneOf(params, 'kind', ['instruction', 'cycle', 'over', 'out'] as const) ??
        'instruction') as StepKind
      const count = optionalNumber(params, 'count') ?? 1
      if (!Number.isInteger(count) || count < 1) {
        throw invalidParams(`count: expected a positive integer, got ${count}`)
      }
      return stopped(session.step(kind, count))
    },

    'exec.runCycles': (raw) => {
      const params = asObject(raw, 'exec.runCycles')
      const cycles = requireNumber(params, 'cycles')
      if (!Number.isInteger(cycles) || cycles < 1) {
        throw invalidParams(`cycles: expected a positive integer, got ${cycles}`)
      }
      return stopped(session.runCycles(cycles))
    },

    'exec.runTo': async (raw) => {
      const params = asObject(raw, 'exec.runTo')
      const address = requireAddress(params, 'address', resolveSymbol)
      const timeoutMs = optionalNumber(params, 'timeoutMs') ?? DEFAULT_WAIT_MS
      const mode =
        oneOf(params, 'mode', ['realtime', 'turbo'] as const) ??
        (session.mode === 'realtime' ? 'realtime' : 'turbo')

      // A breakpoint stops *before* the instruction at its address, so starting
      // on top of the target would return having run nothing — which makes
      // run-to-cursor useless inside a loop. Clear the current instruction
      // first, then the wait is for the next time round.
      if (machine.cpu.pc === address) session.step('instruction')

      const breakpoint = session.addBreakpoint({ address, temporary: true })

      const reason = await new Promise<StopReason>((resolve) => {
        let settled = false
        const finish = (value: StopReason): void => {
          if (settled) return
          settled = true
          off()
          clearTimeout(timer)
          resolve(value)
        }

        const off = session.onStop(finish)
        const timer = setTimeout(() => {
          session.removeBreakpoint(breakpoint.id)
          finish(session.pause())
        }, timeoutMs)

        session.run(mode)
      })

      // A temporary breakpoint removes itself when it fires; this covers every
      // other way out, including stopping at a different breakpoint entirely.
      session.removeBreakpoint(breakpoint.id)
      return stopped(reason)
    },

    //
    // bp
    //

    'bp.set': (raw) => {
      const params = asObject(raw, 'bp.set')
      const condition = optionalString(params, 'condition')

      try {
        return breakpointJSON(
          session.addBreakpoint({
            kind: oneOf(params, 'kind', ['exec', 'read', 'write', 'access'] as const) ?? 'exec',
            address: requireAddress(params, 'address', resolveSymbol),
            ...(params.end === undefined || params.end === null
              ? {}
              : { end: requireAddress(params, 'end', resolveSymbol) }),
            ...(condition === undefined ? {} : { condition }),
            ...(optionalNumber(params, 'ignoreCount') === undefined
              ? {}
              : { ignoreCount: optionalNumber(params, 'ignoreCount')! }),
            ...(optionalBoolean(params, 'temporary') === undefined
              ? {}
              : { temporary: optionalBoolean(params, 'temporary')! }),
            ...(optionalBoolean(params, 'enabled') === undefined
              ? {}
              : { enabled: optionalBoolean(params, 'enabled')! })
          })
        )
      } catch (e) {
        // A bad condition is the client's mistake, not an internal fault.
        if (e instanceof ExpressionError) throw invalidParams(e.message)
        throw e
      }
    },

    'bp.clear': (raw) => {
      const params = asObject(raw, 'bp.clear')
      const id = optionalNumber(params, 'id')
      if (id === undefined) {
        const cleared = session.breakpoints.list().length
        session.clearBreakpoints()
        return { cleared }
      }
      return { cleared: session.removeBreakpoint(id) ? 1 : 0 }
    },

    'bp.list': () => ({ breakpoints: session.breakpoints.list().map(breakpointJSON) }),

    'bp.enable': (raw) => setEnabled(asObject(raw, 'bp.enable'), true),
    'bp.disable': (raw) => setEnabled(asObject(raw, 'bp.disable'), false),

    //
    // reg
    //

    'reg.get': () => registersOf(machine.cpu),

    'reg.set': (raw) => {
      const params = asObject(raw, 'reg.set')
      const cpu = machine.cpu

      const byte = (name: string): number | undefined => {
        const value = optionalNumber(params, name)
        if (value === undefined) return undefined
        if (!Number.isInteger(value) || value < 0 || value > 0xff) {
          throw invalidParams(`${name}: expected a byte 0-255, got ${value}`)
        }
        return value
      }

      const a = byte('A')
      const x = byte('X')
      const y = byte('Y')
      const sp = byte('SP')
      const p = byte('P')
      const pc = optionalAddress(params, 'PC', resolveSymbol)

      if (a !== undefined) cpu.a = a
      if (x !== undefined) cpu.x = x
      if (y !== undefined) cpu.y = y
      if (sp !== undefined) cpu.sp = sp
      // The unused bit reads as 1 on a real 65C02; keeping it set means a
      // round-trip through reg.get/reg.set does not silently change P.
      if (p !== undefined) cpu.st = p | CPU.U
      if (pc !== undefined) {
        cpu.pc = pc
        // Abandon whatever instruction was mid-flight, or the next tick would
        // finish it against the new PC and execute a spliced-together opcode.
        cpu.cyclesRem = 0
      }

      return registersOf(cpu)
    },

    //
    // mem
    //

    'mem.read': (raw) => {
      const params = asObject(raw, 'mem.read')
      const which = space(params)
      const access = spaceAccess(machine, which)
      const offset = spaceOffset(params, which, resolveSymbol)
      const length = optionalNumber(params, 'length') ?? 1

      if (!Number.isInteger(length) || length < 1 || length > MAX_READ_LENGTH) {
        throw invalidParams(`length: expected 1-${MAX_READ_LENGTH}, got ${length}`)
      }

      const data = new Uint8Array(length)
      for (let i = 0; i < length; i++) {
        data[i] = access.read(wrap(offset + i, access.size, which)) & 0xff
      }

      return { space: which, address: offset, length, data: base64(data) }
    },

    'mem.write': (raw) => {
      const params = asObject(raw, 'mem.write')
      const which = space(params)
      const access = spaceAccess(machine, which)
      const offset = spaceOffset(params, which, resolveSymbol)
      if (params.data === undefined) throw invalidParams('data is required')
      const data = toBytes(params.data, 'data')

      for (let i = 0; i < data.length; i++) {
        access.write(wrap(offset + i, access.size, which), data[i]!)
      }

      return { space: which, address: offset, written: data.length }
    },

    'mem.fill': (raw) => {
      const params = asObject(raw, 'mem.fill')
      const which = space(params)
      const access = spaceAccess(machine, which)
      const offset = spaceOffset(params, which, resolveSymbol)
      const length = requireNumber(params, 'length')
      const value = requireNumber(params, 'value')

      if (!Number.isInteger(length) || length < 1) {
        throw invalidParams(`length: expected a positive integer, got ${length}`)
      }
      if (!Number.isInteger(value) || value < 0 || value > 0xff) {
        throw invalidParams(`value: expected a byte 0-255, got ${value}`)
      }

      for (let i = 0; i < length; i++) {
        access.write(wrap(offset + i, access.size, which), value)
      }

      return { space: which, address: offset, written: length }
    },

    'mem.search': (raw) => {
      const params = asObject(raw, 'mem.search')
      const which = space(params)
      const access = spaceAccess(machine, which)
      if (params.pattern === undefined) throw invalidParams('pattern is required')

      const pattern =
        typeof params.pattern === 'string' && !/^[A-Za-z0-9+/]*={0,2}$/.test(params.pattern)
          ? Uint8Array.from(Buffer.from(params.pattern, 'binary'))
          : toBytes(params.pattern, 'pattern')

      if (pattern.length === 0) throw invalidParams('pattern: must not be empty')

      const start = optionalNumber(params, 'start') ?? 0
      const end = optionalNumber(params, 'end') ?? access.size - 1
      const limit = optionalNumber(params, 'limit') ?? 64

      const matches: number[] = []
      const last = Math.min(end, access.size - 1) - pattern.length + 1

      for (let at = Math.max(0, start); at <= last && matches.length < limit; at++) {
        let hit = true
        for (let i = 0; i < pattern.length; i++) {
          if (access.read(at + i) !== pattern[i]) {
            hit = false
            break
          }
        }
        if (hit) matches.push(at)
      }

      return { space: which, matches, truncated: matches.length >= limit }
    },

    //
    // disasm
    //

    'disasm.at': (raw) => {
      const params = asObject(raw, 'disasm.at')
      const address = optionalAddress(params, 'address', resolveSymbol) ?? machine.cpu.pc
      const count = optionalNumber(params, 'count') ?? 8
      if (!Number.isInteger(count) || count < 1 || count > 4096) {
        throw invalidParams(`count: expected 1-4096, got ${count}`)
      }
      return {
        instructions: disassemble(
          { read: (at) => machine.peek(at) },
          address,
          count,
          target.symbols.resolver()
        ).map(instructionJSON)
      }
    },

    'disasm.range': (raw) => {
      const params = asObject(raw, 'disasm.range')
      const start = requireAddress(params, 'start', resolveSymbol)
      const end = requireAddress(params, 'end', resolveSymbol)
      if (end < start) throw invalidParams(`end ($${hex(end)}) is before start ($${hex(start)})`)
      return {
        instructions: disassembleRange(
          { read: (at) => machine.peek(at) },
          start,
          end,
          target.symbols.resolver()
        ).map(instructionJSON)
      }
    },

    //
    // sym
    //

    'sym.load': async (raw) => {
      const params = asObject(raw, 'sym.load')
      const path = optionalString(params, 'path')
      let text = optionalString(params, 'text')

      if (text === undefined) {
        if (path === undefined) throw invalidParams('sym.load: need "path" or "text"')
        if (!target.readTextFile) {
          throw notSupported('sym.load: this host cannot read files — pass "text" instead')
        }
        try {
          text = await target.readTextFile(path)
        } catch (e) {
          throw new RpcMethodError(
            ErrorCode.LOAD_FAILED,
            `sym.load: cannot read "${path}": ${(e as Error).message}`
          )
        }
      }

      const format = (oneOf(params, 'format', ['vice', 'ca65'] as const) ??
        (path ? formatForPath(path) : 'vice')) as SymbolFormat

      const loaded = parseSymbols(text, format, path)
      if (optionalBoolean(params, 'merge') === false) target.symbols.clear()
      target.symbols.merge(loaded)

      // Conditions like `PC == main` resolve through the session, so keep it
      // pointed at the table rather than a snapshot of it.
      session.symbolResolver = resolveSymbol

      return { format, loaded: loaded.size, total: target.symbols.size }
    },

    'sym.lookup': (raw) => {
      const params = asObject(raw, 'sym.lookup')
      const address = requireAddress(params, 'address', resolveSymbol)
      const nearest = target.symbols.nearest(address)
      const line = target.symbols.lineFor(address)

      return {
        address,
        ...(nearest ? { name: nearest.symbol.name, offset: nearest.offset } : {}),
        ...(line ? { file: line.file, line: line.line } : {})
      }
    },

    'sym.resolve': (raw) => {
      const params = asObject(raw, 'sym.resolve')
      const name = requireString(params, 'name')
      const address = target.symbols.resolve(name)
      if (address === undefined) {
        throw invalidParams(`sym.resolve: no symbol named "${name}"`)
      }
      return { name, address }
    },

    'sym.list': (raw) => {
      const params = asObject(raw, 'sym.list')
      const prefix = optionalString(params, 'prefix')
      const limit = optionalNumber(params, 'limit') ?? 500

      const all = target.symbols
        .list()
        .filter((symbol) => prefix === undefined || symbol.name.startsWith(prefix))

      return {
        symbols: all.slice(0, limit).map((symbol) => ({
          name: symbol.name,
          address: symbol.address,
          ...(symbol.source ? { source: symbol.source } : {})
        })),
        total: all.length,
        truncated: all.length > limit
      }
    },

    //
    // media
    //

    'media.loadROM': async (raw) => {
      const params = asObject(raw, 'media.loadROM')
      const bytes = await mediaBytes(params, 'media.loadROM')
      if (bytes.length !== ROM.SIZE) {
        throw new RpcMethodError(
          ErrorCode.LOAD_FAILED,
          `media.loadROM: ROM must be exactly ${ROM.SIZE} bytes, got ${bytes.length}`
        )
      }
      machine.loadROM(bytes)
      // The reset vectors just changed under the CPU; re-read them.
      session.reset(true)
      return { bytes: bytes.length, ...state() }
    },

    'media.loadCart': async (raw) => {
      const params = asObject(raw, 'media.loadCart')
      const bytes = await mediaBytes(params, 'media.loadCart')
      machine.loadCart(bytes)
      session.reset(true)
      return { bytes: bytes.length, ...state() }
    },

    'media.unloadCart': () => {
      machine.unloadCart()
      session.reset(true)
      return state()
    },

    'media.loadProgram': async (raw) => {
      const params = asObject(raw, 'media.loadProgram')
      const bytes = await mediaBytes(params, 'media.loadProgram')

      const status = loadProgramImage(machine, bytes)
      if (status === 'empty') {
        throw new RpcMethodError(ErrorCode.LOAD_FAILED, 'media.loadProgram: the image is empty')
      }
      if (status === 'too-large') {
        throw new RpcMethodError(
          ErrorCode.LOAD_FAILED,
          `media.loadProgram: ${bytes.length} bytes; only ${MAX_PROGRAM_SIZE} fit in $0800-$7FFF`
        )
      }

      // Unlike the launcher, a program loaded over RPC arrives at a machine that
      // is usually already at the BASIC prompt, so the fixup lands immediately.
      const fixed = status === 'ok' || applyProgramPointers(machine, bytes.length)
      return { bytes: bytes.length, pointersApplied: fixed }
    },

    'media.loadBinary': async (raw) => {
      const params = asObject(raw, 'media.loadBinary')
      const address = requireAddress(params, 'address', resolveSymbol)
      const bytes = await mediaBytes(params, 'media.loadBinary')

      const status = loadBinary(machine, address, bytes)
      if (status !== 'ok') {
        throw new RpcMethodError(
          ErrorCode.LOAD_FAILED,
          `media.loadBinary at $${hex(address)}: ${status}`
        )
      }
      return { address, bytes: bytes.length }
    },

    //
    // input
    //
    // A HID path alongside the serial console (§5.5) — for programs driven by
    // the keyboard matrix or a joystick rather than typed text, and the only
    // console path at all for a video-console machine (screen.* below reads
    // what such a program draws).
    //

    'input.key': (raw) => {
      const params = asObject(raw, 'input.key')
      const raw_ = params.code
      if (typeof raw_ !== 'number' && typeof raw_ !== 'string') {
        throw invalidParams('code: expected a HID code or a key name')
      }
      const code = resolveKeyCode(raw_)
      if (code === undefined) throw invalidParams(`code: no such key "${String(raw_)}"`)

      const down = optionalBoolean(params, 'down') ?? true
      if (down) machine.onKeyDown(code)
      else machine.onKeyUp(code)
      return { code, down }
    },

    'input.joystick': (raw) => {
      const params = asObject(raw, 'input.joystick')
      const side = oneOf(params, 'side', ['a', 'b'] as const) ?? 'a'

      const named: Record<string, number> = {
        up: JoystickAttachment.BUTTON_UP,
        down: JoystickAttachment.BUTTON_DOWN,
        left: JoystickAttachment.BUTTON_LEFT,
        right: JoystickAttachment.BUTTON_RIGHT,
        a: JoystickAttachment.BUTTON_A,
        b: JoystickAttachment.BUTTON_B,
        select: JoystickAttachment.BUTTON_SELECT,
        start: JoystickAttachment.BUTTON_START
      }

      let buttons: number
      if (Array.isArray(params.buttons)) {
        buttons = params.buttons.reduce((mask: number, name) => {
          if (typeof name !== 'string' || !(name in named)) {
            throw invalidParams(`buttons: unknown button "${String(name)}"`)
          }
          return mask | named[name]!
        }, 0)
      } else {
        buttons = requireNumber(params, 'buttons')
        if (!Number.isInteger(buttons) || buttons < 0 || buttons > 0xff) {
          throw invalidParams(`buttons: expected a byte 0-255, got ${buttons}`)
        }
      }

      if (side === 'a') machine.onJoystickA(buttons)
      else machine.onJoystickB(buttons)
      return { side, buttons }
    },

    /**
     * Type plain text as a sequence of keystrokes, paced in emulated cycles.
     *
     * The keyboard matrix has no flow control the way the ACIA does — a real
     * keyboard simply asserts a row/column intersection and leaves it to the
     * BIOS's own scan loop to notice — so a make/break pair issued with no
     * emulated time between them risks landing between two scans and being
     * missed entirely. Pacing at a plausible typing rate rather than
     * instantaneously is what makes this reliable regardless of exactly how
     * often the BIOS scans.
     */
    'input.type': async (raw) => {
      const params = asObject(raw, 'input.type')
      const text = requireString(params, 'text')
      const MAX_TYPE_LENGTH = 4096
      if (text.length > MAX_TYPE_LENGTH) {
        throw invalidParams(`text: longer than the ${MAX_TYPE_LENGTH} character limit`)
      }

      const cps = optionalNumber(params, 'cps') ?? 20
      if (!Number.isFinite(cps) || cps <= 0) {
        throw invalidParams(`cps: expected a positive number, got ${cps}`)
      }
      const cyclesPerChar = Math.max(1, Math.round(machine.frequency / cps))

      const keys = [...text].map((ch) => {
        const key = ASCII_TO_KEY[ch]
        if (!key) throw invalidParams(`text: no key for ${JSON.stringify(ch)} on a US keyboard`)
        return key
      })

      // Driven by the session's chunk cadence — the same clock SerialConsole
      // paces input on — so this costs nothing when nobody is typing and stays
      // correct at any host speed, turbo included.
      await new Promise<void>((resolve, reject) => {
        if (keys.length === 0) {
          resolve()
          return
        }

        let index = 0
        let budget = 0
        let lastCycles = session.cycles

        const finish = (): void => {
          off()
          resolve()
        }

        const tick = (): void => {
          budget += session.cycles - lastCycles
          lastCycles = session.cycles

          while (budget >= cyclesPerChar && index < keys.length) {
            budget -= cyclesPerChar
            const key = keys[index]!
            if (key.shift) machine.onKeyDown(HID_NAMES.ShiftLeft!)
            machine.onKeyDown(key.code)
            machine.onKeyUp(key.code)
            if (key.shift) machine.onKeyUp(HID_NAMES.ShiftLeft!)
            index++
          }

          if (index >= keys.length) finish()
        }

        const off = session.onChunk(tick)

        // A paused machine would never see another chunk; typing into one is
        // a caller mistake, not a hang.
        if (!session.isRunning) {
          off()
          reject(invalidParams('input.type: the machine is paused — run it first'))
          return
        }

        tick()
      })

      return { typed: keys.length }
    },

    //
    // screen
    //
    // Still needed with §5.5's serial console in place, for the cases where
    // pixels or the video console genuinely matter: sprites, graphics modes,
    // and a video-console machine, which has no other text channel at all.
    //

    'screen.text': () => {
      const video = machine.video()
      if (!video) throw notSupported('screen.text: no video card is present')
      return { lines: video.textGrid() }
    },

    'screen.hash': () => {
      const video = machine.video()
      if (!video) throw notSupported('screen.hash: no video card is present')
      // Not a cryptographic digest — CRC-32 is plenty for "did the screen
      // change", and needs no zlib/crypto import in either host (see PNG.ts).
      return { hash: crc32(video.buffer).toString(16).padStart(8, '0') }
    },

    'screen.png': () => {
      const video = machine.video()
      if (!video) throw notSupported('screen.png: no video card is present')
      const png = encodePNG(DISPLAY_WIDTH, DISPLAY_HEIGHT, video.buffer)
      return { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT, data: base64(png) }
    },

    //
    // serial
    //

    'serial.write': (raw) => {
      const params = asObject(raw, 'serial.write')
      if (!target.writeSerial) {
        throw notSupported('serial.write: this machine has no serial console')
      }

      const encoding = oneOf(params, 'encoding', ['text', 'base64'] as const) ?? 'text'
      const data =
        encoding === 'base64'
          ? toBytes(requireString(params, 'data'), 'data')
          : toSerialNewlines(requireString(params, 'data'))

      // The cursor is taken before the write so a caller can pass it straight to
      // `wait.for {since}` and be certain of catching the reply, however many
      // cycles the machine gets through between the two calls.
      const cursor = target.readSerial?.({ since: Number.MAX_SAFE_INTEGER }).cursor
      lastWriteCursor = cursor

      target.writeSerial(data)
      return { queued: data.length, ...(cursor === undefined ? {} : { cursor }) }
    },

    'serial.read': (raw) => {
      const params = asObject(raw, 'serial.read')
      if (!target.readSerial) {
        throw notSupported('serial.read: this machine has no serial console')
      }
      const max = optionalNumber(params, 'max')
      const since = optionalNumber(params, 'since')
      const clear = optionalBoolean(params, 'clear') ?? false
      const read = target.readSerial({
        ...(max === undefined ? {} : { max }),
        ...(since === undefined ? {} : { since }),
        clear
      })
      return { data: read.data, length: read.data.length, cursor: read.cursor, truncated: read.truncated }
    },

    'serial.config': () => ({
      console: target.consoleMode(),
      ...(target.baudRate ? { baudRate: target.baudRate() } : {}),
      frequency: machine.frequency
    }),

    //
    // wait
    //

    'wait.for': (raw) => waitFor(asObject(raw, 'wait.for'))
  }

  function setEnabled(params: Params, enabled: boolean): Record<string, unknown> {
    const id = requireNumber(params, 'id')
    if (!session.setBreakpointEnabled(id, enabled)) {
      throw invalidParams(`no breakpoint with id ${id}`)
    }
    return breakpointJSON(session.breakpoints.get(id)!)
  }

  /**
   * Block until something happens, or give up.
   *
   * The condition is checked on the session's chunk cadence rather than a
   * wall-clock timer, so `cycles` and `expression` are evaluated in emulated
   * time and land at the same point in a program however fast the host is.
   * Serial and stop conditions are event-driven and need no polling at all.
   */
  async function waitFor(params: Params): Promise<Record<string, unknown>> {
    const timeoutMs = optionalNumber(params, 'timeoutMs') ?? DEFAULT_WAIT_MS
    const serialPattern = optionalString(params, 'serial')
    const wantStop = optionalBoolean(params, 'stopped') ?? false
    const cycles = optionalNumber(params, 'cycles')
    const expression = optionalString(params, 'expression')

    if (!serialPattern && !wantStop && cycles === undefined && !expression) {
      throw invalidParams(
        'wait.for: need at least one of "serial", "stopped", "cycles" or "expression"'
      )
    }
    if (serialPattern && !target.onSerial) {
      throw notSupported('wait.for: this machine has no serial console')
    }

    const pattern = serialPattern ? toRegExp(serialPattern, 'serial') : undefined
    let compiled: ReturnType<typeof compileExpression> | undefined
    if (expression) {
      try {
        compiled = compileExpression(expression)
      } catch (e) {
        throw invalidParams(`expression: ${(e as Error).message}`)
      }
    }

    const startCycles = session.cycles
    const startedAt = Date.now()
    const mode = oneOf(params, 'run', ['realtime', 'turbo'] as const)

    // Look back to the last command sent unless told otherwise, so the reply to
    // it counts however long ago the machine printed it. An explicit `since` of
    // the current cursor is how a caller asks for strictly-new output instead.
    const since = optionalNumber(params, 'since') ?? lastWriteCursor
    const backlog =
      pattern && since !== undefined ? target.readSerial?.({ since }) : undefined
    let output = backlog?.data ?? ''

    return new Promise<Record<string, unknown>>((resolve) => {
      let settled = false
      const offs: (() => void)[] = []

      const finish = (reason: string, stop?: StopReason): void => {
        if (settled) return
        settled = true
        for (const off of offs) off()
        clearTimeout(timer)
        resolve({
          matched: reason !== 'timeout',
          reason,
          cycles: session.cycles,
          elapsedCycles: session.cycles - startCycles,
          elapsedMs: Date.now() - startedAt,
          ...(pattern ? { output } : {}),
          ...(backlog?.truncated ? { truncated: true } : {}),
          ...(stop ? { stop } : {}),
          ...state()
        })
      }

      const check = (): void => {
        if (settled) return
        if (cycles !== undefined && session.cycles - startCycles >= cycles) {
          finish('cycles')
          return
        }
        if (compiled) {
          let value = 0
          try {
            value = compiled({
              registers: {
                A: machine.cpu.a,
                X: machine.cpu.x,
                Y: machine.cpu.y,
                PC: machine.cpu.pc,
                SP: machine.cpu.sp,
                P: machine.cpu.st,
                ST: machine.cpu.st
              },
              read: (at) => machine.peek(at),
              symbol: resolveSymbol
            })
          } catch {
            // An expression that cannot be evaluated here — an unloaded symbol —
            // is not a match, and not a reason to abandon the other conditions.
            value = 0
          }
          if (value) finish('expression')
        }
      }

      const timer = setTimeout(() => finish('timeout'), timeoutMs)

      if (pattern && target.onSerial) {
        offs.push(
          target.onSerial((text) => {
            output += text
            if (pattern.test(output)) finish('serial')
          })
        )
      }
      if (wantStop) {
        offs.push(session.onStop((reason) => finish('stopped', reason)))
      }
      offs.push(session.onChunk(check))

      // Output the caller asked us to look back over may already satisfy the
      // pattern, in which case there is nothing to wait for.
      if (pattern && output && pattern.test(output)) {
        finish('serial')
        return
      }

      if (mode) session.run(mode)

      // An already-satisfied condition should return at once rather than after a
      // chunk's worth of emulated time — or, if the machine is paused, never.
      check()
    })
  }
}

/**
 * Wrap an offset into its space.
 *
 * The CPU space wraps at 64K because that is what the address bus does. The
 * device spaces clamp instead: running off the end of VRAM or the CF image is a
 * mistake, and silently reading from the start would hide it.
 */
function wrap(offset: number, size: number, space: MemorySpace): number {
  if (space === 'cpu') return offset & 0xffff
  if (offset >= size) {
    throw invalidParams(`address: ${offset} is past the end of ${space} (${size} bytes)`)
  }
  return offset
}

const hex = (value: number): string => value.toString(16).toUpperCase().padStart(4, '0')

/**
 * Translate line endings for the serial console.
 *
 * Pressing Enter on a terminal transmits CR, and the BIOS ends a line on CR
 * alone — an LF is accepted as input but never submits, so `serial.write` of
 * "PRINT 2+2\n" would type the line and leave it sitting at the prompt.
 */
function toSerialNewlines(text: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i) & 0xff
    if (code === 0x0d && text.charCodeAt(i + 1) === 0x0a) continue
    out.push(code === 0x0a ? 0x0d : code)
  }
  return Uint8Array.from(out)
}
