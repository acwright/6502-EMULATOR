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
