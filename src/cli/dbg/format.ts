/** Human-readable rendering for `dbg` and `attach` output. Skipped by --json. */

const hex = (value: number, digits: number): string =>
  (value >>> 0).toString(16).toUpperCase().padStart(digits, '0')

export const hexByte = (value: number): string => `$${hex(value, 2)}`
export const hexWord = (value: number): string => `$${hex(value, 4)}`

interface Registers {
  A: number
  X: number
  Y: number
  PC: number
  SP: number
  P: number
  flags: Record<string, boolean>
}

/**
 * The classic monitor status-byte rendering: one letter per flag, uppercase
 * where set, lowercase where clear, in the wire order NV-BDIZC.
 */
export function formatFlags(flags: Record<string, boolean>): string {
  return ['N', 'V', 'B', 'D', 'I', 'Z', 'C']
    .map((flag) => (flags[flag] ? flag : flag.toLowerCase()))
    .join('')
}

export function formatRegisters(regs: Registers): string {
  return (
    `A=${hexByte(regs.A)}  X=${hexByte(regs.X)}  Y=${hexByte(regs.Y)}  ` +
    `SP=${hexByte(regs.SP)}  PC=${hexWord(regs.PC)}  P=${hexByte(regs.P)} [${formatFlags(regs.flags)}]`
  )
}

interface Breakpoint {
  id: number
  kind: string
  address: number
  end: number
  condition?: string
  ignoreCount: number
  temporary: boolean
  enabled: boolean
  hits: number
}

export function formatBreakpoint(bp: Breakpoint): string {
  const range = bp.end !== bp.address ? `${hexWord(bp.address)}-${hexWord(bp.end)}` : hexWord(bp.address)
  const bits = [
    `#${bp.id}`,
    bp.enabled ? bp.kind : `${bp.kind} (disabled)`,
    range,
    `hits=${bp.hits}`,
    ...(bp.condition ? [`if ${bp.condition}`] : []),
    ...(bp.temporary ? ['temporary'] : []),
    ...(bp.ignoreCount > 0 ? [`ignore=${bp.ignoreCount}`] : [])
  ]
  return bits.join('  ')
}

export function formatBreakpoints(list: Breakpoint[]): string {
  return list.length === 0 ? '(no breakpoints)' : list.map(formatBreakpoint).join('\n')
}

interface StopReason {
  kind: string
  id?: number
  address?: number
  access?: string
  cycles?: number
  detail?: string
  conditionError?: string
}

/**
 * A breakpoint whose condition threw fires anyway, by design — but saying so is
 * the difference between "my condition is being ignored" and "I mistyped a
 * symbol name".
 */
function conditionNote(stop: StopReason): string {
  return stop.conditionError ? ` (condition could not be evaluated: ${stop.conditionError})` : ''
}

export function formatStop(stop: StopReason): string {
  switch (stop.kind) {
    case 'breakpoint':
      return `breakpoint #${stop.id} at ${hexWord(stop.address!)}${conditionNote(stop)}`
    case 'watchpoint':
      return `watchpoint #${stop.id} (${stop.access}) at ${hexWord(stop.address!)}${conditionNote(stop)}`
    case 'cycle-budget':
      return `ran ${stop.cycles} cycles`
    case 'trap':
      return `trap: ${stop.detail}`
    case 'step':
      return 'stepped'
    case 'paused':
      return 'paused'
    default:
      return stop.kind
  }
}

interface Instruction {
  address: number
  bytes: number[]
  text: string
}

export function formatDisasm(instructions: Instruction[], markPC?: number): string {
  return instructions
    .map((instruction) => {
      const marker = instruction.address === markPC ? '>' : ' '
      return `${marker}${instruction.text}`
    })
    .join('\n')
}

/** 16 bytes per line, address, hex, then the printable ASCII alongside it. */
export function hexDump(base: number, bytes: Uint8Array, addressDigits = 4): string {
  const lines: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = bytes.subarray(offset, offset + 16)
    const hexPart = [...row].map((byte) => hex(byte, 2)).join(' ').padEnd(16 * 3 - 1)
    const ascii = [...row]
      .map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'))
      .join('')
    lines.push(`${hex(base + offset, addressDigits)}  ${hexPart}  ${ascii}`)
  }
  return lines.join('\n')
}

interface Symbol_ {
  name: string
  address: number
  source?: string
}

export function formatSymbols(list: Symbol_[]): string {
  return list.length === 0
    ? '(no symbols)'
    : list.map((s) => `${hexWord(s.address)}  ${s.name}${s.source ? `  (${s.source})` : ''}`).join('\n')
}

interface VideoPort {
  pointer: number
  readMode: boolean
  readAhead: number
  awaitingCommand: boolean
  payload: number
}

interface VideoInfo {
  mode: {
    vmode: number
    legacy: string | null
    geometry: string
    cols: number
    rows: number
    cellWidth: number
    width: number
    lines: number
    originX: number
    originY: number
  }
  displayEnabled: boolean
  displayLine: number
  status: number[]
  ports: { a: VideoPort; b: VideoPort }
  paletteBase: number
}

/** §9's names, as the spec capitalises them. */
const GEOMETRY_NAMES: Record<string, string> = {
  text: 'Text',
  compact: 'Compact',
  graphics: 'Graphics',
  full: 'Full'
}

const LEGACY_NAMES: Record<string, string> = {
  text: 'Text',
  'graphics-i': 'Graphics I',
  'graphics-ii': 'Graphics II',
  multicolor: 'Multicolor'
}

/**
 * `STAT6`'s bits, b0 up (VDP-SPEC §6). b6 is reserved for a blitter and never
 * set, so it has no name here; b7 is the built-in font of draft 0.5 (§7).
 */
const CAPABILITY_NAMES: readonly (string | null)[] = [
  'two layers',
  '8bpp layer',
  'sprite flip',
  'hardware scroll',
  'scanline IRQ',
  '64 KB VRAM',
  null,
  'built-in font'
]

/** `STAT5` as the BCD version it is, and `STAT6` as the capabilities it names. */
function formatCard(status: number[]): string {
  const version = status[5] ?? 0
  const capabilities = status[6] ?? 0
  const names = CAPABILITY_NAMES.filter((name, bit) => name !== null && capabilities & (1 << bit))
  return `firmware  ${hex(version >> 4, 1)}.${hex(version & 0x0f, 1)}; ${names.length ? names.join(', ') : 'no capabilities'}`
}

/** Up to 16 bytes as bare hex pairs, for the register and status grids. */
const hexRow = (bytes: number[]): string => bytes.map((byte) => hex(byte, 2)).join(' ')

function formatVideoPort(name: string, port: VideoPort): string {
  const direction = port.readMode ? 'read ' : 'write'
  const pending = port.awaitingCommand ? `, awaiting a command byte (payload ${hexByte(port.payload)})` : ''
  return `port ${name}    ${direction} ${hexWord(port.pointer)}, prefetch ${hexByte(port.readAhead)}${pending}`
}

/**
 * The card at a glance: which picture, where the raster is, what the status
 * registers hold and where each port pair is pointed.
 *
 * A legacy program's mode is shown beside the geometry it lands on, because
 * the two differ exactly when something is being drawn wrong — Graphics II asks
 * for a picture this card does not have and gets Compact's Graphics I.
 */
export function formatVideoInfo(info: VideoInfo): string {
  const { mode } = info
  const selected =
    mode.legacy === null
      ? `VMODE $${hex(mode.vmode, 1)}`
      : `VMODE $${hex(mode.vmode, 1)}, legacy ${LEGACY_NAMES[mode.legacy] ?? mode.legacy}`
  return [
    `${GEOMETRY_NAMES[mode.geometry] ?? mode.geometry}: ${mode.cols} x ${mode.rows} cells of ` +
      `${mode.cellWidth} x 8, ${mode.width} x ${mode.lines} at x ${mode.originX}, y ${mode.originY} (${selected})`,
    `display ${info.displayEnabled ? 'on' : 'off'}, raster on display line ${info.displayLine}`,
    `STAT0-7   ${hexRow(info.status.slice(0, 8))}`,
    `STAT8-15  ${hexRow(info.status.slice(8, 16))}`,
    formatCard(info.status),
    formatVideoPort('A', info.ports.a),
    formatVideoPort('B', info.ports.b),
    `palette   ${hexWord(info.paletteBase)}`
  ].join('\n')
}

/** The register file, sixteen to a row, each row labelled by its first register. */
export function formatVideoRegisters(registers: number[]): string {
  const lines: string[] = []
  for (let first = 0; first < registers.length; first += 16) {
    lines.push(`${hexByte(first)}  ${hexRow(registers.slice(first, first + 16))}`)
  }
  return lines.join('\n')
}

/**
 * The palette as §11 lays it out: sixteen rows of sixteen, so that a row here is
 * the row a 4bpp sub-palette selector picks. Entries in the spec's `$RGB`.
 */
export function formatPalette(base: number, entries: number[]): string {
  const lines = [`stored at ${hexWord(base)} in VRAM`]
  for (let row = 0; row * 16 < entries.length; row++) {
    const values = entries.slice(row * 16, row * 16 + 16).map((entry) => hex(entry, 3))
    lines.push(`row ${hex(row, 1)}  ${values.join(' ')}`)
  }
  return lines.join('\n')
}
