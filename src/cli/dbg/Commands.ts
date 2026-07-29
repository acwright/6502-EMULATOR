import { resolve as resolvePath } from 'node:path'
import { parseArgs } from 'node:util'
import { UsageError, parseCount, parseDuration } from '../args'
import { resolveTarget, httpCall, RpcClientError } from './Connection'
import { ExitCode } from './ExitCode'
import { unescape, parseByteList } from './text'
import {
  formatBreakpoint,
  formatBreakpoints,
  formatDisasm,
  formatRegisters,
  formatStop,
  formatSymbols,
  hexDump
} from './format'

/**
 * Every command in one file, in the shape `6502 dbg <this file's name>`.
 *
 * Grouped by protocol family and ordered to match §6.2 of PLAN.md, so the
 * method a command calls is always the next thing below its heading. `screen`
 * is not here: nothing implements it server-side yet (Phase 7 needs the video
 * card wired up first), so there is nothing honest for it to do.
 */

/** Options every command accepts, whatever else it needs. */
const COMMON_OPTIONS = {
  port: { type: 'string' },
  host: { type: 'string' },
  token: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' }
} as const

type CommonValues = { port?: string; host?: string; token?: string; json?: boolean; help?: boolean }

/**
 * `parseArgs`, with a bad argument turned into a UsageError instead of Node's
 * own message-and-exit-1.
 *
 * A thin wrapper around the call rather than a generic reimplementation of it,
 * so TypeScript infers each command's own value types — string flag, boolean
 * flag, `multiple` array — straight from the literal options object it wrote,
 * instead of collapsing every command to the same loose union.
 */
function parse<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    throw new UsageError((e as Error).message)
  }
}

/** Print a result, either as one line of JSON or the caller's formatted text. */
function show(json: boolean | undefined, result: unknown, formatted: () => string): void {
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${formatted()}\n`)
}

/** stop.kind === 'breakpoint' | 'watchpoint' is HIT; everything else that succeeded is OK. */
function exitForStop(stop: { kind: string } | undefined): number {
  if (stop?.kind === 'breakpoint' || stop?.kind === 'watchpoint') return ExitCode.HIT
  return ExitCode.OK
}

const call = (values: CommonValues, method: string, params?: unknown): Promise<unknown> =>
  httpCall(resolveTarget(values), method, params)

/** Connection flags that take a following value, for extractSubcommand below. */
const FLAG_WITH_VALUE = new Set(['--port', '--host', '--token'])

/**
 * Pull the sub-subcommand — `write` out of `mem write $0300 ...` — out of an
 * argv that may have connection flags ahead of it.
 *
 * `attach` resolves `--port`/`--host`/`--token` once and hands them to every
 * typed line, and where exactly it puts them relative to the line's own
 * tokens is an implementation detail of attach.ts that a two-level command
 * here should not have to stay in sync with. Scanning past known flags (and
 * their values) rather than assuming the sub-subcommand is always argv[0]
 * means it doesn't matter.
 */
function extractSubcommand(argv: string[]): { sub: string | undefined; rest: string[] } {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (FLAG_WITH_VALUE.has(token)) {
      i++
      continue
    }
    if (token.startsWith('-')) continue
    return { sub: token, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] }
  }
  return { sub: undefined, rest: argv }
}

//
// session
//

async function info(argv: string[]): Promise<number> {
  const { values } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  const result = (await call(values, 'session.info')) as {
    host: string
    version: string
    console: string
    frequency: number
    mode: string
    cycles: number
  }
  show(values.json, result, () =>
    `${result.host} ${result.version} — ${result.console} console, ` +
    `${(result.frequency / 1e6).toFixed(0)} MHz, ${result.mode}, ${result.cycles} cycles`
  )
  return ExitCode.OK
}

async function reset(argv: string[]): Promise<number> {
  const OPTIONS = { ...COMMON_OPTIONS, warm: { type: 'boolean' } } as const
  const { values } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  const result = await call(values, 'session.reset', { cold: !values.warm })
  show(values.json, result, () => 'reset')
  return ExitCode.OK
}

async function config(argv: string[]): Promise<number> {
  const OPTIONS = {
    ...COMMON_OPTIONS,
    frequency: { type: 'string' },
    baud: { type: 'string' }
  } as const
  const { values } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))

  const params: Record<string, number> = {}
  if (values.frequency) {
    const mhz = Number(values.frequency)
    params.frequency = mhz === 1 || mhz === 2 ? mhz * 1_000_000 : Number(values.frequency)
  }
  if (values.baud) params.baudRate = parseCount(values.baud, '--baud')

  const result = await call(values, 'session.config', params)
  show(values.json, result, () => JSON.stringify(result))
  return ExitCode.OK
}

async function shutdown(argv: string[]): Promise<number> {
  const { values } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  await call(values, 'session.shutdown')
  show(values.json, { ok: true }, () => 'shutting down')
  return ExitCode.OK
}

//
// reg
//

async function regs(argv: string[]): Promise<number> {
  const OPTIONS = { ...COMMON_OPTIONS, set: { type: 'string', multiple: true } } as const
  const { values } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))

  const sets = values.set ?? []
  let result: unknown

  if (sets.length > 0) {
    const params: Record<string, string> = {}
    for (const assignment of sets) {
      const split = assignment.indexOf('=')
      if (split === -1) throw new UsageError(`--set: expected NAME=VALUE, got "${assignment}"`)
      const name = assignment.slice(0, split).toUpperCase()
      const raw = assignment.slice(split + 1)
      params[name] = /^\$|^0x/i.test(raw) ? String(parseInt(raw.replace(/^\$|^0x/i, ''), 16)) : raw
    }
    // reg.set wants numbers; the params above stayed strings only so a $-hex
    // value could be told apart from a decimal one before conversion.
    const numeric: Record<string, number> = {}
    for (const [name, value] of Object.entries(params)) numeric[name] = Number(value)
    result = await call(values, 'reg.set', numeric)
  } else {
    result = await call(values, 'reg.get')
  }

  show(values.json, result, () => formatRegisters(result as Parameters<typeof formatRegisters>[0]))
  return ExitCode.OK
}

//
// mem
//

async function mem(argv: string[]): Promise<number> {
  const { sub, rest } = extractSubcommand(argv)

  if (sub === 'write') return memWrite(rest)
  if (sub === 'fill') return memFill(rest)
  if (sub === 'search') return memSearch(rest)
  return memRead(argv)
}

const SPACE_OPTION = { space: { type: 'string' } } as const

async function memRead(argv: string[]): Promise<number> {
  const OPTIONS = { ...COMMON_OPTIONS, ...SPACE_OPTION } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('mem: expected an address')

  const address = positionals[0]!
  const length = positionals[1] ? parseCount(positionals[1], 'length') : 16

  const result = (await call(values, 'mem.read', {
    ...(values.space ? { space: values.space } : {}),
    address,
    length
  })) as { address: number; data: string }

  const bytes = Buffer.from(result.data, 'base64')
  show(values.json, result, () => hexDump(result.address, bytes))
  return ExitCode.OK
}

async function memWrite(argv: string[]): Promise<number> {
  const OPTIONS = { ...COMMON_OPTIONS, ...SPACE_OPTION } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  if (positionals.length < 2) throw new UsageError('mem write: expected an address and bytes')

  const data = parseByteList(positionals.slice(1).join(' '), 'mem write')
  const result = await call(values, 'mem.write', {
    ...(values.space ? { space: values.space } : {}),
    address: positionals[0],
    data
  })
  show(values.json, result, () => `wrote ${data.length} byte(s)`)
  return ExitCode.OK
}

async function memFill(argv: string[]): Promise<number> {
  const OPTIONS = { ...COMMON_OPTIONS, ...SPACE_OPTION } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  if (positionals.length < 3) {
    throw new UsageError('mem fill: expected an address, a length and a value')
  }

  const result = await call(values, 'mem.fill', {
    ...(values.space ? { space: values.space } : {}),
    address: positionals[0],
    length: parseCount(positionals[1]!, 'length'),
    value: parseCount(positionals[2]!, 'value')
  })
  show(values.json, result, () => `filled ${positionals[1]} byte(s)`)
  return ExitCode.OK
}

async function memSearch(argv: string[]): Promise<number> {
  const OPTIONS = {
    ...COMMON_OPTIONS,
    ...SPACE_OPTION,
    text: { type: 'boolean' },
    start: { type: 'string' },
    end: { type: 'string' },
    limit: { type: 'string' }
  } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('mem search: expected a pattern')

  const pattern = values.text ? positionals.join(' ') : parseByteList(positionals.join(' '), 'pattern')

  const result = (await call(values, 'mem.search', {
    ...(values.space ? { space: values.space } : {}),
    pattern,
    ...(values.start !== undefined ? { start: parseCount(values.start, '--start') } : {}),
    ...(values.end !== undefined ? { end: parseCount(values.end, '--end') } : {}),
    ...(values.limit !== undefined ? { limit: parseCount(values.limit, '--limit') } : {})
  })) as { matches: number[]; truncated: boolean }

  show(values.json, result, () =>
    result.matches.length === 0
      ? '(no matches)'
      : result.matches.map((address) => `$${address.toString(16).toUpperCase()}`).join('\n') +
        (result.truncated ? '\n... (truncated)' : '')
  )
  return ExitCode.OK
}

//
// disasm
//

async function disasm(argv: string[]): Promise<number> {
  const { sub, rest } = extractSubcommand(argv)
  if (sub === 'range') return disasmRange(rest)
  return disasmAt(argv)
}

async function disasmAt(argv: string[]): Promise<number> {
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  const result = (await call(values, 'disasm.at', {
    ...(positionals[0] !== undefined ? { address: positionals[0] } : {}),
    count: positionals[1] ? parseCount(positionals[1], 'count') : 8
  })) as { instructions: { address: number }[] }

  show(values.json, result, () => formatDisasm(result.instructions as never))
  return ExitCode.OK
}

async function disasmRange(argv: string[]): Promise<number> {
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  if (positionals.length < 2) throw new UsageError('disasm range: expected a start and an end')

  const result = await call(values, 'disasm.range', { start: positionals[0], end: positionals[1] })
  show(values.json, result, () =>
    formatDisasm((result as { instructions: unknown[] }).instructions as never)
  )
  return ExitCode.OK
}

//
// bp
//

async function breakCmd(argv: string[]): Promise<number> {
  const { sub, rest } = extractSubcommand(argv)
  if (sub === 'list') return breakList(rest)
  if (sub === 'clear') return breakClear(rest)
  if (sub === 'enable') return breakSetEnabled(rest, true)
  if (sub === 'disable') return breakSetEnabled(rest, false)
  return breakSet(argv)
}

async function breakSet(argv: string[]): Promise<number> {
  const OPTIONS = {
    ...COMMON_OPTIONS,
    watch: { type: 'string' },
    end: { type: 'string' },
    condition: { type: 'string' },
    ignore: { type: 'string' },
    temporary: { type: 'boolean' },
    disabled: { type: 'boolean' }
  } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('break: expected an address')

  const result = await call(values, 'bp.set', {
    address: positionals[0],
    kind: values.watch ?? 'exec',
    ...(values.end !== undefined ? { end: values.end } : {}),
    ...(values.condition !== undefined ? { condition: values.condition } : {}),
    ...(values.ignore !== undefined ? { ignoreCount: parseCount(values.ignore, '--ignore') } : {}),
    ...(values.temporary ? { temporary: true } : {}),
    ...(values.disabled ? { enabled: false } : {})
  })
  show(values.json, result, () => formatBreakpoint(result as never))
  return ExitCode.OK
}

async function breakList(argv: string[]): Promise<number> {
  const { values } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  const result = (await call(values, 'bp.list')) as { breakpoints: unknown[] }
  show(values.json, result, () => formatBreakpoints(result.breakpoints as never))
  return ExitCode.OK
}

async function breakClear(argv: string[]): Promise<number> {
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  const result = await call(
    values,
    'bp.clear',
    positionals[0] !== undefined ? { id: parseCount(positionals[0], 'id') } : {}
  )
  show(values.json, result, () => JSON.stringify(result))
  return ExitCode.OK
}

async function breakSetEnabled(argv: string[], enabled: boolean): Promise<number> {
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('break: expected a breakpoint id')

  const result = await call(values, enabled ? 'bp.enable' : 'bp.disable', {
    id: parseCount(positionals[0]!, 'id')
  })
  show(values.json, result, () => formatBreakpoint(result as never))
  return ExitCode.OK
}

//
// exec
//

async function run(argv: string[]): Promise<number> {
  const OPTIONS = { ...COMMON_OPTIONS, realtime: { type: 'boolean' } } as const
  const { values } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  const result = await call(values, 'exec.run', { mode: values.realtime ? 'realtime' : 'turbo' })
  show(values.json, result, () => 'running')
  return ExitCode.OK
}

async function pause(argv: string[]): Promise<number> {
  const { values } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  const result = (await call(values, 'exec.pause')) as { stop: { kind: string } }
  show(values.json, result, () => formatStop(result.stop as never))
  return ExitCode.OK
}

async function step(argv: string[]): Promise<number> {
  const OPTIONS = {
    ...COMMON_OPTIONS,
    over: { type: 'boolean' },
    out: { type: 'boolean' },
    cycle: { type: 'boolean' },
    count: { type: 'string' }
  } as const
  const { values } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))

  const kind = values.over ? 'over' : values.out ? 'out' : values.cycle ? 'cycle' : 'instruction'
  const result = (await call(values, 'exec.step', {
    kind,
    ...(values.count !== undefined ? { count: parseCount(values.count, '--count') } : {})
  })) as { stop: { kind: string }; registers: unknown }

  show(values.json, result, () => `${formatStop(result.stop as never)}\n${formatRegisters(result.registers as never)}`)
  return exitForStop(result.stop)
}

async function runTo(argv: string[]): Promise<number> {
  const OPTIONS = { ...COMMON_OPTIONS, timeout: { type: 'string' }, realtime: { type: 'boolean' } } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('runto: expected an address')

  const result = (await call(values, 'exec.runTo', {
    address: positionals[0],
    mode: values.realtime ? 'realtime' : 'turbo',
    ...(values.timeout ? { timeoutMs: parseDuration(values.timeout, '--timeout') } : {})
  })) as { stop: { kind: string }; registers: unknown }

  show(values.json, result, () => `${formatStop(result.stop as never)}\n${formatRegisters(result.registers as never)}`)
  return exitForStop(result.stop)
}

async function runCycles(argv: string[]): Promise<number> {
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('runcycles: expected a cycle count')

  const result = (await call(values, 'exec.runCycles', {
    cycles: parseCount(positionals[0]!, 'cycles')
  })) as { stop: { kind: string } }
  show(values.json, result, () => formatStop(result.stop as never))
  return exitForStop(result.stop)
}

//
// serial
//

async function send(argv: string[]): Promise<number> {
  const OPTIONS = {
    ...COMMON_OPTIONS,
    wait: { type: 'string' },
    timeout: { type: 'string' },
    encoding: { type: 'string' }
  } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('send: expected text to send')

  const data = values.encoding === 'base64' ? positionals[0]! : unescape(positionals.join(' '))
  const written = (await call(values, 'serial.write', {
    data,
    ...(values.encoding ? { encoding: values.encoding } : {})
  })) as { queued: number; cursor?: number }

  if (!values.wait) {
    show(values.json, written, () => `sent ${written.queued} byte(s)`)
    return ExitCode.OK
  }

  const waited = (await call(values, 'wait.for', {
    serial: values.wait,
    ...(written.cursor !== undefined ? { since: written.cursor } : {}),
    ...(values.timeout ? { timeoutMs: parseDuration(values.timeout, '--timeout') } : {})
  })) as { matched: boolean; reason: string; output?: string }

  show(values.json, waited, () => waited.output ?? waited.reason)
  return waited.matched ? ExitCode.OK : ExitCode.TIMEOUT
}

async function wait(argv: string[]): Promise<number> {
  const OPTIONS = {
    ...COMMON_OPTIONS,
    serial: { type: 'string' },
    stopped: { type: 'boolean' },
    cycles: { type: 'string' },
    expression: { type: 'string' },
    since: { type: 'string' },
    timeout: { type: 'string' },
    run: { type: 'string' }
  } as const
  const { values } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))

  const result = (await call(values, 'wait.for', {
    ...(values.serial !== undefined ? { serial: values.serial } : {}),
    ...(values.stopped ? { stopped: true } : {}),
    ...(values.cycles !== undefined ? { cycles: parseCount(values.cycles, '--cycles') } : {}),
    ...(values.expression !== undefined ? { expression: values.expression } : {}),
    ...(values.since !== undefined ? { since: parseCount(values.since, '--since') } : {}),
    ...(values.run !== undefined ? { run: values.run } : {}),
    ...(values.timeout ? { timeoutMs: parseDuration(values.timeout, '--timeout') } : {})
  })) as { matched: boolean; reason: string; output?: string; stop?: { kind: string } }

  show(values.json, result, () => result.output ?? (result.stop ? formatStop(result.stop as never) : result.reason))
  return result.matched ? ExitCode.OK : ExitCode.TIMEOUT
}

//
// sym
//

async function sym(argv: string[]): Promise<number> {
  const { sub, rest } = extractSubcommand(argv)
  if (sub === 'resolve') return symResolve(rest)
  if (sub === 'lookup') return symLookup(rest)
  if (sub === 'list') return symList(rest)
  if (sub === 'load') return symLoad(rest)
  throw new UsageError(`sym: expected load, resolve, lookup or list, got "${sub ?? ''}"`)
}

async function symLoad(argv: string[]): Promise<number> {
  const OPTIONS = {
    ...COMMON_OPTIONS,
    format: { type: 'string' },
    'no-merge': { type: 'boolean' }
  } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('sym load: expected a file path')

  const result = await call(values, 'sym.load', {
    path: resolvePath(process.cwd(), positionals[0]!),
    ...(values.format ? { format: values.format } : {}),
    ...(values['no-merge'] ? { merge: false } : {})
  })
  show(values.json, result, () => JSON.stringify(result))
  return ExitCode.OK
}

async function symResolve(argv: string[]): Promise<number> {
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('sym resolve: expected a name')

  const result = await call(values, 'sym.resolve', { name: positionals[0] })
  show(values.json, result, () => JSON.stringify(result))
  return ExitCode.OK
}

async function symLookup(argv: string[]): Promise<number> {
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('sym lookup: expected an address')

  const result = await call(values, 'sym.lookup', { address: positionals[0] })
  show(values.json, result, () => JSON.stringify(result))
  return ExitCode.OK
}

async function symList(argv: string[]): Promise<number> {
  const OPTIONS = { ...COMMON_OPTIONS, limit: { type: 'string' } } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))

  const result = (await call(values, 'sym.list', {
    ...(positionals[0] !== undefined ? { prefix: positionals[0] } : {}),
    ...(values.limit !== undefined ? { limit: parseCount(values.limit, '--limit') } : {})
  })) as { symbols: unknown[] }
  show(values.json, result, () => formatSymbols(result.symbols as never))
  return ExitCode.OK
}

//
// media
//

async function load(argv: string[]): Promise<number> {
  const { sub, rest } = extractSubcommand(argv)

  if (sub === 'rom' || sub === 'cart' || sub === 'program') {
    const { values, positionals } = parse(() => parseArgs({ args: rest, options: COMMON_OPTIONS, allowPositionals: true }))
    if (positionals.length < 1) throw new UsageError(`load ${sub}: expected a file path`)

    const method = sub === 'rom' ? 'media.loadROM' : sub === 'cart' ? 'media.loadCart' : 'media.loadProgram'
    const result = await call(values, method, { path: resolvePath(process.cwd(), positionals[0]!) })
    show(values.json, result, () => JSON.stringify(result))
    return ExitCode.OK
  }

  if (sub === 'bin') {
    const { values, positionals } = parse(() => parseArgs({ args: rest, options: COMMON_OPTIONS, allowPositionals: true }))
    if (positionals.length < 2) throw new UsageError('load bin: expected an address and a file path')

    const result = await call(values, 'media.loadBinary', {
      address: positionals[0],
      path: resolvePath(process.cwd(), positionals[1]!)
    })
    show(values.json, result, () => JSON.stringify(result))
    return ExitCode.OK
  }

  throw new UsageError(`load: expected rom, cart, program or bin, got "${sub ?? ''}"`)
}

async function unload(argv: string[]): Promise<number> {
  const { sub, rest } = extractSubcommand(argv)
  if (sub !== 'cart') throw new UsageError(`unload: expected "cart", got "${sub ?? ''}"`)

  const { values } = parse(() => parseArgs({ args: rest, options: COMMON_OPTIONS, allowPositionals: true }))
  const result = await call(values, 'media.unloadCart')
  show(values.json, result, () => JSON.stringify(result))
  return ExitCode.OK
}

//
// screen
//

async function screen(argv: string[]): Promise<number> {
  const { sub, rest } = extractSubcommand(argv)
  if (sub === 'hash') return screenHash(rest)
  if (sub === 'png') return screenPng(rest)
  return screenText(rest) // default, and explicit "text"
}

async function screenText(argv: string[]): Promise<number> {
  const { values } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  const result = (await call(values, 'screen.text')) as { lines: string[] }
  show(values.json, result, () => result.lines.join('\n'))
  return ExitCode.OK
}

async function screenHash(argv: string[]): Promise<number> {
  const { values } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  const result = (await call(values, 'screen.hash')) as { hash: string }
  show(values.json, result, () => result.hash)
  return ExitCode.OK
}

async function screenPng(argv: string[]): Promise<number> {
  const { values, positionals } = parse(() =>
    parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true })
  )
  const result = (await call(values, 'screen.png')) as { width: number; height: number; data: string }
  const outPath = resolvePath(process.cwd(), positionals[0] ?? 'screen.png')

  if (values.json) {
    show(values.json, result, () => '')
    return ExitCode.OK
  }

  const { writeFileSync } = await import('node:fs')
  writeFileSync(outPath, Buffer.from(result.data, 'base64'))
  process.stdout.write(`wrote ${result.width}x${result.height} to ${outPath}\n`)
  return ExitCode.OK
}

//
// input
//

async function input(argv: string[]): Promise<number> {
  const { sub, rest } = extractSubcommand(argv)
  if (sub === 'key') return inputKey(rest)
  if (sub === 'joystick') return inputJoystick(rest)
  if (sub === 'type') return inputType(rest)
  throw new UsageError(`input: expected key, joystick or type, got "${sub ?? ''}"`)
}

async function inputKey(argv: string[]): Promise<number> {
  const OPTIONS = { ...COMMON_OPTIONS, down: { type: 'boolean' }, up: { type: 'boolean' } } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('input key: expected a key name or HID code')

  const raw = positionals[0]!
  const hex = raw.startsWith('$') ? raw.slice(1) : /^0x/i.test(raw) ? raw.slice(2) : null
  const code: string | number = hex !== null ? parseInt(hex, 16) : /^\d+$/.test(raw) ? Number(raw) : raw

  // Neither flag: a full tap — press, then release — which is what a
  // one-shot process typing a single key means by default.
  if (!values.down && !values.up) {
    await call(values, 'input.key', { code, down: true })
    const result = await call(values, 'input.key', { code, down: false })
    show(values.json, result, () => `tapped ${positionals[0]}`)
    return ExitCode.OK
  }

  const result = await call(values, 'input.key', { code, down: !!values.down })
  show(values.json, result, () => JSON.stringify(result))
  return ExitCode.OK
}

async function inputJoystick(argv: string[]): Promise<number> {
  const OPTIONS = { ...COMMON_OPTIONS, side: { type: 'string' }, mask: { type: 'string' } } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))

  const buttons = values.mask !== undefined ? parseCount(values.mask, '--mask') : positionals
  const result = await call(values, 'input.joystick', {
    side: values.side ?? 'a',
    buttons
  })
  show(values.json, result, () => JSON.stringify(result))
  return ExitCode.OK
}

async function inputType(argv: string[]): Promise<number> {
  const OPTIONS = { ...COMMON_OPTIONS, cps: { type: 'string' } } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('input type: expected text to type')

  const result = await call(values, 'input.type', {
    text: unescape(positionals.join(' ')),
    ...(values.cps !== undefined ? { cps: parseCount(values.cps, '--cps') } : {})
  })
  show(values.json, result, () => JSON.stringify(result))
  return ExitCode.OK
}

//
// dispatch
//

const COMMANDS: Record<string, (argv: string[]) => Promise<number>> = {
  info,
  regs,
  reset,
  config,
  shutdown,
  reg: regs,
  mem,
  disasm,
  break: breakCmd,
  run,
  pause,
  step,
  runto: runTo,
  runcycles: runCycles,
  send,
  wait,
  sym,
  load,
  unload,
  screen,
  input
}

export async function dispatch(name: string | undefined, argv: string[]): Promise<number> {
  const handler = name ? COMMANDS[name] : undefined
  if (!handler) {
    process.stderr.write(
      `6502 dbg: unknown command "${name ?? ''}"\n\n` +
        `Commands: ${Object.keys(COMMANDS).filter((k) => k !== 'reg').sort().join(', ')}\n`
    )
    return ExitCode.ERROR
  }

  try {
    return await handler(argv)
  } catch (e) {
    if (e instanceof RpcClientError) {
      process.stderr.write(`6502 dbg: ${e.message}\n`)
      return e.exitCode
    }
    if (e instanceof UsageError) {
      process.stderr.write(`6502 dbg: ${e.message}\n`)
      return ExitCode.ERROR
    }
    throw e
  }
}

export const COMMAND_NAMES = Object.keys(COMMANDS).filter((name) => name !== 'reg').sort()
