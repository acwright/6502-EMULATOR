import { OPCODES } from './OpcodeTable'
import type { AddrMode } from './OpcodeTable'

/** Somewhere to read bytes from — a Machine, a snapshot, a plain buffer. */
export interface ByteSource {
  read(address: number): number
}

/** Resolves an address to a label, when symbols have been loaded. */
export type SymbolResolver = (address: number) => string | undefined

export interface Instruction {
  address: number
  /** The instruction's bytes, opcode first. */
  bytes: number[]
  name: string
  mode: AddrMode
  /** Rendered operand — `#$12`, `$1234,X`, `$0080` for a branch target. */
  operand: string
  /**
   * Where this instruction refers to, when that is a fixed address: the target
   * of a branch or jump, or the address an absolute or zero-page operand names.
   * Undefined for implied and immediate.
   */
  target?: number
  /** Label for `target`, when one is known. */
  label?: string
  documented: boolean
}

const hex = (value: number, digits: number): string =>
  value.toString(16).toUpperCase().padStart(digits, '0')

export const formatByte = (value: number): string => `$${hex(value & 0xff, 2)}`
export const formatWord = (value: number): string => `$${hex(value & 0xffff, 4)}`

/**
 * Decode one instruction.
 *
 * Always returns something. An unimplemented opcode disassembles as its
 * mnemonic `???` with the width the W65C02S gives it, so stepping through data
 * stays in sync with what the CPU will actually do rather than desynchronising
 * at the first odd byte.
 */
export function disassembleOne(
  source: ByteSource,
  address: number,
  resolve?: SymbolResolver
): Instruction {
  const at = address & 0xffff
  const opcode = source.read(at) & 0xff
  const info = OPCODES[opcode]!

  const bytes = [opcode]
  for (let i = 1; i < info.bytes; i++) bytes.push(source.read((at + i) & 0xffff) & 0xff)

  const lo = bytes[1] ?? 0
  const hi = bytes[2] ?? 0
  const word = (hi << 8) | lo

  let operand = ''
  let target: number | undefined

  switch (info.mode) {
    case 'IMP':
      break
    case 'IMM':
      operand = `#${formatByte(lo)}`
      break
    case 'ZP0':
      operand = formatByte(lo)
      target = lo
      break
    case 'ZPX':
      operand = `${formatByte(lo)},X`
      target = lo
      break
    case 'ZPY':
      operand = `${formatByte(lo)},Y`
      target = lo
      break
    case 'IZX':
      operand = `(${formatByte(lo)},X)`
      target = lo
      break
    case 'IZY':
      operand = `(${formatByte(lo)}),Y`
      target = lo
      break
    case 'IZP':
      operand = `(${formatByte(lo)})`
      target = lo
      break
    case 'ABS':
      operand = formatWord(word)
      target = word
      break
    case 'ABX':
      operand = `${formatWord(word)},X`
      target = word
      break
    case 'ABY':
      operand = `${formatWord(word)},Y`
      target = word
      break
    case 'IND':
      operand = `(${formatWord(word)})`
      target = word
      break
    case 'IAX':
      operand = `(${formatWord(word)},X)`
      target = word
      break
    case 'REL': {
      // The displacement is signed and measured from the *following*
      // instruction, so a backward branch is a negative offset from there.
      const offset = lo < 0x80 ? lo : lo - 0x100
      target = (at + info.bytes + offset) & 0xffff
      operand = formatWord(target)
      break
    }
    case 'ZPR': {
      // BBR/BBS: a zero-page address to test, then a branch displacement.
      const offset = hi < 0x80 ? hi : hi - 0x100
      target = (at + info.bytes + offset) & 0xffff
      operand = `${formatByte(lo)},${formatWord(target)}`
      break
    }
  }

  const label = target === undefined ? undefined : resolve?.(target)

  return {
    address: at,
    bytes,
    name: info.name,
    mode: info.mode,
    operand,
    ...(target === undefined ? {} : { target }),
    ...(label === undefined ? {} : { label }),
    documented: info.documented
  }
}

/** Decode `count` consecutive instructions starting at `address`. */
export function disassemble(
  source: ByteSource,
  address: number,
  count: number,
  resolve?: SymbolResolver
): Instruction[] {
  const out: Instruction[] = []
  let at = address & 0xffff

  for (let i = 0; i < count; i++) {
    const instruction = disassembleOne(source, at, resolve)
    out.push(instruction)
    at = (at + instruction.bytes.length) & 0xffff
  }
  return out
}

/** Decode instructions until `end` is reached or passed. */
export function disassembleRange(
  source: ByteSource,
  start: number,
  end: number,
  resolve?: SymbolResolver
): Instruction[] {
  const out: Instruction[] = []
  let at = start & 0xffff

  while (at <= (end & 0xffff)) {
    const instruction = disassembleOne(source, at, resolve)
    out.push(instruction)
    at += instruction.bytes.length
  }
  return out
}

export interface FormatOptions {
  /** Include the instruction's raw bytes between the address and the mnemonic. */
  bytes?: boolean
  /** Prefix the line with `>` — used to mark the PC. */
  marker?: boolean
}

/**
 * Render one instruction the way a monitor listing does:
 *
 *   C012  A9 42     LDA #$42
 *   C014  20 00 A0  JSR PrintChar
 */
export function formatInstruction(
  instruction: Instruction,
  options: FormatOptions = {}
): string {
  const { bytes = true, marker = false } = options

  const address = hex(instruction.address, 4)
  const raw = bytes
    ? instruction.bytes
        .map((byte) => hex(byte, 2))
        .join(' ')
        .padEnd(10)
    : ''

  // A resolved label replaces the numeric operand entirely; for the bit-branch
  // pair only its branch target is a label, so patch that half in place.
  let operand = instruction.operand
  if (instruction.label) {
    operand =
      instruction.mode === 'ZPR'
        ? operand.replace(/,\$[0-9A-F]{4}$/, `,${instruction.label}`)
        : operand.replace(/\$[0-9A-F]{2,4}/, instruction.label)
  }

  const text = operand ? `${instruction.name} ${operand}` : instruction.name
  return `${marker ? '>' : ' '} ${address}  ${raw}${text}`.trimEnd()
}
