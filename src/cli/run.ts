import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { HeadlessHost, readROM } from '../host/headless/HeadlessHost'
import type { ConsoleMode, RunResult, BinaryLoad } from '../host/headless/HeadlessHost'
import { HeadlessTarget } from '../host/headless/HeadlessTarget'
import { DebugServer } from '../debug/server/DebugServer'
import { createMethods } from '../debug/server/Methods'
import { cliVersion } from './version'
import { parseSymbols, formatForPath } from '../debug/symbols/parse'
import {
  UsageError,
  parseBinarySpec,
  parseCount,
  parseDuration,
  parseFrequency
} from './args'

export const RUN_HELP = `Usage: 6502 run [options] [program]

Boot a machine, optionally loaded with your build output.

  program                   Program image (.prg/.bas) loaded at $0800

Machine
  --rom <file>              Use this ROM instead of the bundled BIOS
  --cart <file>             Load a cartridge
  --program <file>          Same as the positional argument
  --bin <addr>=<file>       Load raw bytes at an address (repeatable)
  --cf <file>               Attach a CF card image
  --console <serial|video>  Console device (default: serial)
  --freq <1|2>              CPU clock in MHz (default: 1)
  --baud <rate>             Serial line rate (default: 19200)

Execution
  --headless                Run without a window (currently required)
  --realtime                Pace against the wall clock instead of running flat out
  --pause                   Start paused, for attaching a debugger before boot
  --max-cycles <n>          Stop after n CPU cycles
  --timeout <duration>      Stop after 30s, 500ms, 5m ...
  --exit-on <regex>         Stop when console output matches
  --input-after <regex>     Hold stdin until console output matches

Debugging
  --debug                   Serve the debug protocol (JSON-RPC over WS and HTTP)
  --debug-port <n>          Port to listen on (default: an unused one)
  --debug-host <addr>       Interface to bind (default: 127.0.0.1)
  --debug-token <token>     Use this token instead of generating one
  --symbols <file>          Load a VICE label or ca65 .dbg file

Output
  --json                    Print a machine-readable result to stderr on exit
  --quiet                   Suppress the startup banner

Exit codes
  0  ran to completion       2  timed out
  1  usage or load error     130 interrupted

Notes
  The BIOS splash takes ENTER for BASIC or ESC for the Monitor and acts on it
  at once, so a leading CR skips the countdown entirely. Anything sent before
  that choice is made gets swallowed by the boot menu — lead with the CR, or
  hold input back with --input-after until a prompt appears.

  --bin writes straight into RAM before the machine boots. At $0800 that is
  BASIC's program area, and its cold start will read whatever is there as a
  tokenized program; use --program for images that belong at $0800.

Examples
  6502 run --headless build/game.prg
  6502 run --headless --bin 0xC000=sprites.bin --max-cycles 5e6

  # Straight into BASIC, run a line, stop at the next prompt.
  printf '\\rPRINT 2+2\\r' | 6502 run --headless --exit-on 'OK[^]*OK' --timeout 10s

  # Straight into the machine-code Monitor.
  printf '\\x1b' | 6502 run --headless --timeout 10s

  # Serve a debugger, paused at reset, with symbols loaded.
  6502 run --headless --debug --pause --symbols build/game.lbl build/game.prg
`

const OPTIONS = {
  rom: { type: 'string' },
  cart: { type: 'string' },
  program: { type: 'string' },
  bin: { type: 'string', multiple: true },
  cf: { type: 'string' },
  console: { type: 'string' },
  freq: { type: 'string' },
  baud: { type: 'string' },
  headless: { type: 'boolean' },
  realtime: { type: 'boolean' },
  pause: { type: 'boolean' },
  'max-cycles': { type: 'string' },
  timeout: { type: 'string' },
  'exit-on': { type: 'string' },
  'input-after': { type: 'string' },
  debug: { type: 'boolean' },
  'debug-port': { type: 'string' },
  'debug-host': { type: 'string' },
  'debug-token': { type: 'string' },
  symbols: { type: 'string' },
  json: { type: 'boolean' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' }
} as const

/** Locate the BIOS that ships with the app. */
function bundledROMPath(): string {
  const here = __dirname
  // resourcesPath exists only under Electron, which is how the installed shim
  // will run this; from a checkout we walk up to the repo's assets/.
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [
    resources ? join(resources, 'assets', 'roms', 'BIOS.bin') : '',
    join(here, '..', '..', 'assets', 'roms', 'BIOS.bin'),
    join(here, '..', '..', '..', 'assets', 'roms', 'BIOS.bin')
  ]
  const found = candidates.find((path) => path && existsSync(path))
  if (!found) {
    throw new UsageError('could not find the bundled BIOS; pass one with --rom')
  }
  return found
}

function readFile(path: string, label: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path))
  } catch {
    throw new UsageError(`${label}: cannot read "${path}"`)
  }
}

export async function runCommand(argv: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
  } catch (e) {
    throw new UsageError((e as Error).message)
  }
  const { values, positionals } = parsed

  if (values.help) {
    process.stdout.write(RUN_HELP)
    return 0
  }

  // `run` will launch the desktop app once that lands; until then be explicit
  // rather than quietly doing something else.
  if (!values.headless) {
    throw new UsageError(
      'launching the desktop app is not implemented yet — pass --headless to run without a window'
    )
  }

  if (positionals.length > 1) {
    throw new UsageError(`expected at most one program, got ${positionals.length}`)
  }

  const consoleMode = (values.console ?? 'serial') as string
  if (consoleMode !== 'serial' && consoleMode !== 'video') {
    throw new UsageError(`--console: expected "serial" or "video", got "${consoleMode}"`)
  }

  const programPath = values.program ?? positionals[0]
  const binaries: BinaryLoad[] = (values.bin ?? []).map((spec) => {
    const { address, path } = parseBinarySpec(spec)
    return { address, bytes: readFile(path, '--bin') }
  })

  const compile = (flag: '--exit-on' | '--input-after', pattern?: string): RegExp | undefined => {
    if (pattern === undefined) return undefined
    try {
      return new RegExp(pattern)
    } catch (e) {
      throw new UsageError(`${flag}: ${(e as Error).message}`)
    }
  }
  const exitOn = compile('--exit-on', values['exit-on'])
  const inputAfter = compile('--input-after', values['input-after'])

  const host = new HeadlessHost({
    rom: values.rom ? readROM(values.rom) : readROM(bundledROMPath()),
    cart: values.cart ? readFile(values.cart, '--cart') : undefined,
    program: programPath ? readFile(programPath, 'program') : undefined,
    binaries,
    cf: values.cf ? readFile(values.cf, '--cf') : undefined,
    console: consoleMode as ConsoleMode,
    frequency: values.freq ? parseFrequency(values.freq) : undefined,
    baudRate: values.baud ? parseCount(values.baud, '--baud') : undefined,
    maxCycles: values['max-cycles']
      ? parseCount(values['max-cycles'], '--max-cycles')
      : undefined,
    timeoutMs: values.timeout ? parseDuration(values.timeout, '--timeout') : undefined,
    exitOn,
    inputAfter,
    onOutput: (data) => process.stdout.write(data)
  })

  const BASIC_PROGRAM_START = 0x0800
  if (!values.quiet) {
    for (const binary of binaries) {
      if (binary.address >= BASIC_PROGRAM_START && binary.address < 0x8000 && !programPath) {
        process.stderr.write(
          `6502: warning: --bin at $${binary.address.toString(16).toUpperCase().padStart(4, '0')} ` +
            `is inside BASIC's program area; its cold start will read those bytes as a program\n`
        )
      }
    }
  }

  if (!values.quiet) {
    // Say which console is in use. A video-console boot behaves differently —
    // the BIOS makes CLS, LOCATE and COLOR no-ops when video is absent — and
    // nobody should have to discover that by debugging a phantom bug.
    process.stderr.write(
      `6502: headless, ${consoleMode} console, ` +
        `${(host.session.machine.frequency / 1e6).toFixed(0)} MHz` +
        `${values.realtime ? '' : ', turbo'}\n`
    )
  }

  if (values.symbols) {
    const path = values.symbols
    const table = parseSymbols(
      readFileSync(path, 'utf8'),
      formatForPath(path),
      path
    )
    host.symbols.merge(table)
    host.session.symbolResolver = (name) => host.symbols.resolve(name)
    if (!values.quiet) {
      process.stderr.write(`6502: loaded ${table.size} symbols from ${path}\n`)
    }
  }

  const server = values.debug ? await startDebugServer(host, values) : undefined
  if (server && !values.quiet) {
    process.stderr.write(`6502: debug server on ${server.url}\n`)
  }

  const detach = attachStdin(host)
  const onSignal = (): void => host.stop('stopped')
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  let result: RunResult
  try {
    // --pause is how a debugger attaches before the BIOS has run an
    // instruction. The run promise stays pending until a client calls exec.run,
    // and only then can an exit condition fire.
    result = await host.run(values.realtime ? 'realtime' : 'turbo', values.pause)
  } finally {
    detach()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await server?.close()
  }

  if (values.json) {
    process.stderr.write(`${JSON.stringify(result)}\n`)
  }

  if (result.reason === 'timeout') return 2
  if (result.reason === 'stopped') return 130
  return 0
}

interface DebugFlags {
  'debug-port'?: string
  'debug-host'?: string
  'debug-token'?: string
  quiet?: boolean
}

/**
 * Start serving the debug protocol for this machine.
 *
 * The port and token land in `~/.6502/session.json`, which is what lets a later
 * `6502 dbg regs` find this process with no arguments at all.
 */
async function startDebugServer(
  host: HeadlessHost,
  values: DebugFlags
): Promise<{ url: string; close: () => Promise<void> }> {
  const bind = values['debug-host'] ?? '127.0.0.1'
  const exposed = bind !== '127.0.0.1' && bind !== '::1' && bind !== 'localhost'

  if (exposed && !values.quiet) {
    process.stderr.write(
      `6502: warning: --debug-host ${bind} exposes the machine beyond this computer; ` +
        'clients must present the token, which is in ~/.6502/session.json\n'
    )
  }

  const target = new HeadlessTarget(host, cliVersion())
  const methods = createMethods(target)

  const server = new DebugServer({
    hostName: target.hostName,
    version: target.version,
    hostKind: 'headless',
    methods,
    onEvent: (callback) => subscribeHeadlessEvents(target, callback),
    host: bind,
    ...(values['debug-port']
      ? { port: parseCount(values['debug-port'], '--debug-port') }
      : {}),
    ...(values['debug-token'] ? { token: values['debug-token'] } : {}),
    onLog: (message) => process.stderr.write(`6502: ${message}\n`)
  })

  const listening = await server.listen()
  return { url: listening.url, close: () => server.close() }
}

/**
 * Forward a target's session and console events to the server's broadcaster.
 *
 * Serial output arrives a byte at a time from the ACIA; coalescing to the end
 * of the turn turns a 40-character line from 40 WebSocket frames into one.
 */
function subscribeHeadlessEvents(
  target: HeadlessTarget,
  callback: (method: string, params: unknown) => void
): () => void {
  const offs = [
    target.session.onStop((reason) => callback('stopped', { stop: reason })),
    target.session.onResume((mode) => callback('resumed', { mode }))
  ]

  let pending = ''
  let flushScheduled = false

  if (target.onSerial) {
    offs.push(
      target.onSerial((text) => {
        pending += text
        if (flushScheduled) return
        flushScheduled = true
        setImmediate(() => {
          flushScheduled = false
          const data = pending
          pending = ''
          if (data) callback('serial.data', { data })
        })
      })
    )
  }

  return () => {
    for (const off of offs) off()
  }
}

/**
 * Feed stdin to the machine's console.
 *
 * A TTY goes into raw mode so keystrokes reach the machine as they are typed
 * rather than a line at a time — the emulator, not the terminal, is doing the
 * line editing. A pipe just streams.
 */
function attachStdin(host: HeadlessHost): () => void {
  const stdin = process.stdin
  if (stdin.isTTY) stdin.setRawMode?.(true)

  const onData = (chunk: Buffer): void => {
    // Ctrl-C never reaches the signal handler in raw mode; honour it here.
    if (stdin.isTTY && chunk.includes(0x03)) {
      host.stop('stopped')
      return
    }
    host.write(toSerialNewlines(chunk))
  }

  stdin.on('data', onData)
  stdin.resume()

  return () => {
    stdin.off('data', onData)
    if (stdin.isTTY) stdin.setRawMode?.(false)
    stdin.pause()
  }
}

/**
 * Translate host line endings to what a serial terminal sends.
 *
 * Pressing Enter on a terminal transmits CR, and the BIOS reads a line until it
 * sees one — an LF is accepted as input but never ends the line, so a piped
 * `echo 'PRINT 2+2'` would be typed at the prompt and simply sit there. CRLF
 * collapses to a single CR so a Windows-authored script does not submit twice.
 */
function toSerialNewlines(chunk: Buffer): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < chunk.length; i++) {
    const byte = chunk[i]!
    if (byte === 0x0d && chunk[i + 1] === 0x0a) continue // CR of a CRLF pair
    out.push(byte === 0x0a ? 0x0d : byte)
  }
  return Uint8Array.from(out)
}
