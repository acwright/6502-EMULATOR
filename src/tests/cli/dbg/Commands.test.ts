import { createServer } from 'node:http'
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '../../../debug/Session'
import { Empty } from '../../../core/IO/Empty'
import { DebugServer } from '../../../debug/server/DebugServer'
import { createMethods } from '../../../debug/server/Methods'
import type { DebugTarget } from '../../../debug/server/DebugTarget'
import { SymbolTable } from '../../../debug/symbols/Symbols'
import { dispatch } from '../../../cli/dbg/Commands'
import { ExitCode } from '../../../cli/dbg/ExitCode'

/**
 * Integration tests: a real DebugServer on a real loopback port, driven
 * through the same `dispatch()` the CLI's own process calls.
 *
 * `--port` is passed on every call rather than going through the lock file, so
 * these tests are about Commands.ts's own parsing, RPC calls and exit codes —
 * not a second copy of LockFile's tests.
 */

function bareSession(): Session {
  return new Session({
    io1: new Empty(),
    io2: new Empty(),
    io3: new Empty(),
    io4: new Empty(),
    io5: new Empty(),
    io6: new Empty(),
    io7: new Empty(),
    io8: new Empty()
  })
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

let server: DebugServer
let session: Session
let port: number
let token: string

beforeEach(async () => {
  session = bareSession()
  const target: DebugTarget = {
    session,
    symbols: new SymbolTable(),
    hostName: 'test',
    version: '9.9.9',
    consoleMode: () => 'serial',
    // sym.load and media.load* resolve a path against the host's own
    // filesystem — see Commands.ts's symLoad, which sends an absolute path
    // rather than reading the file itself.
    readTextFile: (path) => readFileSync(path, 'utf8')
  }
  server = new DebugServer({
    hostName: target.hostName,
    version: target.version,
    hostKind: 'headless',
    methods: createMethods(target),
    onEvent: () => () => {},
    lockFile: false
  })
  const listening = await server.listen()
  port = listening.port
  token = listening.token
})

afterEach(async () => {
  await server.close()
})

/**
 * Connection flags go *after* the command's own arguments, not before.
 *
 * Several commands (mem, disasm, break, sym, load, unload) take a
 * sub-subcommand as their first token — `mem write ...` — and read it
 * positionally rather than through parseArgs, so anything placed ahead of it
 * would be mistaken for that token. This mirrors exactly how `attach.ts`
 * appends the connection it resolved once at startup to each typed line.
 */
const connectionArgs = (): string[] => ['--port', String(port), '--token', token]

/** Run a command, capturing what it wrote to stdout and its exit code. */
async function run(name: string, args: string[] = []): Promise<{ exitCode: number; out: string }> {
  const chunks: string[] = []
  const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  })
  try {
    const exitCode = await dispatch(name, [...args, ...connectionArgs()])
    return { exitCode, out: chunks.join('') }
  } finally {
    spy.mockRestore()
  }
}

async function runErr(name: string, args: string[] = []): Promise<{ exitCode: number; err: string }> {
  const chunks: string[] = []
  const spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  })
  try {
    const exitCode = await dispatch(name, [...args, ...connectionArgs()])
    return { exitCode, err: chunks.join('') }
  } finally {
    spy.mockRestore()
  }
}

describe('session commands', () => {
  it('info reports the host and formats the summary', async () => {
    const { exitCode, out } = await run('info')
    expect(exitCode).toBe(ExitCode.OK)
    expect(out).toContain('test')
    expect(out).toContain('serial console')
  })

  it('info --json prints the raw result', async () => {
    const { out } = await run('info', ['--json'])
    expect(JSON.parse(out)).toMatchObject({ host: 'test', protocol: 1 })
  })

  it('reset zeroes the registers', async () => {
    session.machine.cpu.a = 0x42
    await run('reset')
    expect(session.machine.cpu.a).toBe(0)
  })
})

describe('reg commands', () => {
  it('regs with no arguments reads', async () => {
    session.machine.cpu.a = 0x42
    const { out } = await run('regs')
    expect(out).toContain('A=$42')
  })

  it('regs --set writes registers, accepting hex or decimal', async () => {
    await run('regs', ['--set', 'A=0x42', '--set', 'X=16'])
    expect(session.machine.cpu.a).toBe(0x42)
    expect(session.machine.cpu.x).toBe(16)
  })

  it('reg is an alias for regs', async () => {
    session.machine.cpu.x = 0x10
    const { out } = await run('reg')
    expect(out).toContain('X=$10')
  })
})

describe('mem commands', () => {
  it('writes and reads back a hex byte string', async () => {
    await run('mem', ['write', '0x0300', 'DEADBEEF'])
    const { out } = await run('mem', ['0x0300', '4'])
    expect(out).toContain('DE AD BE EF')
  })

  it('fills a range', async () => {
    await run('mem', ['fill', '0x0400', '4', '0xAA'])
    const { out } = await run('mem', ['0x0400', '4'])
    expect(out).toContain('AA AA AA AA')
  })

  it('searches and reports matches', async () => {
    await run('mem', ['write', '0x1234', 'CAFE'])
    const { out } = await run('mem', ['search', 'CAFE', '--space', 'ram'])
    expect(out).toContain('$1234')
  })

  it('reports a space it does not have as an error, exit 1', async () => {
    const { exitCode, err } = await runErr('mem', ['0', '--space', 'vram'])
    expect(exitCode).toBe(ExitCode.ERROR)
    expect(err).toMatch(/vram/)
  })
})

describe('break commands', () => {
  it('sets, lists and clears', async () => {
    const set = await run('break', ['0xC000'])
    expect(set.out).toContain('$C000')

    const list = await run('break', ['list'])
    expect(list.out).toContain('#1')

    const clear = await run('break', ['clear'])
    expect(clear.exitCode).toBe(ExitCode.OK)

    const empty = await run('break', ['list'])
    expect(empty.out).toContain('no breakpoints')
  })

  it('sets a condition and a watchpoint kind', async () => {
    const { out } = await run('break', ['0x0400', '--watch', 'write', '--condition', 'A == 3'])
    expect(out).toContain('write')
    expect(out).toContain('if A == 3')
  })
})

describe('exec commands', () => {
  it('step advances one instruction and prints the new state', async () => {
    program(session, 0xc000, 0xa9, 0x42) // LDA #$42
    const { exitCode, out } = await run('step')
    expect(exitCode).toBe(ExitCode.OK)
    expect(out).toContain('A=$42')
    expect(session.machine.cpu.pc).toBe(0xc002)
  })

  // The exit code an agent branches on to tell "ran to completion" apart from
  // "something it was watching for actually happened".
  it('runto exits 4 when the address is a breakpoint that fires', async () => {
    program(session, 0xc000)
    const { exitCode, out } = await run('runto', ['0xC010', '--timeout', '2s'])
    expect(exitCode).toBe(ExitCode.HIT)
    expect(out).toContain('breakpoint')
    expect(session.machine.cpu.pc).toBe(0xc010)
  })

  it('runto exits 0 when it gives up without hitting anything', async () => {
    program(session, 0xc000, 0x4c, 0x00, 0xc0) // JMP $C000, forever
    const { exitCode } = await run('runto', ['0xD000', '--timeout', '100ms'])
    expect(exitCode).toBe(ExitCode.OK)
  })

  it('runcycles reports the cycle-budget stop', async () => {
    program(session, 0xc000)
    const { exitCode, out } = await run('runcycles', ['1000'])
    expect(exitCode).toBe(ExitCode.OK)
    expect(out).toContain('1000 cycles')
    expect(session.cycles).toBe(1000)
  })
})

describe('sym commands', () => {
  it('loads from inline text is not available on the CLI — a real file only', async () => {
    // sym load always resolves a path, matching the wire contract used by the
    // running emulator's own filesystem — see symLoad in Commands.ts.
    const { exitCode, err } = await runErr('sym', ['load', '/does/not/exist.lbl'])
    expect(exitCode).toBe(ExitCode.ERROR)
    expect(err).toMatch(/cannot read/)
  })

  it('resolves and looks up once loaded', async () => {
    const path = join(tmpdir(), `sym-${Date.now()}.lbl`)
    writeFileSync(path, 'al C:C000 .main\n')

    try {
      await run('sym', ['load', path])
      const resolved = await run('sym', ['resolve', 'main'])
      expect(resolved.out).toContain('49152')

      const looked = await run('sym', ['lookup', '0xC000'])
      expect(looked.out).toContain('main')
    } finally {
      unlinkSync(path)
    }
  })
})

describe('connection errors', () => {
  it('reports exit code 3 when nothing is listening', async () => {
    // A port just released is reliably unbound for the moment this takes.
    const probe = createServer()
    const freedPort = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port))
    })
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    const chunks: string[] = []
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      chunks.push(String(c))
      return true
    })
    const exitCode = await dispatch('info', ['--port', String(freedPort)])
    spy.mockRestore()

    expect(exitCode).toBe(ExitCode.NOT_RUNNING)
    expect(chunks.join('')).toMatch(/could not reach/)
  })

  it('reports a usage error as exit 1 without contacting the server', async () => {
    const { exitCode, err } = await runErr('break', [])
    expect(exitCode).toBe(ExitCode.ERROR)
    expect(err).toMatch(/expected an address/)
  })

  it('reports an unknown command as exit 1', async () => {
    const chunks: string[] = []
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      chunks.push(String(c))
      return true
    })
    const exitCode = await dispatch('nonsense', [])
    spy.mockRestore()

    expect(exitCode).toBe(ExitCode.ERROR)
    expect(chunks.join('')).toMatch(/unknown command/)
  })
})
