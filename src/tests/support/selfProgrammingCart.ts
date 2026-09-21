/**
 * A 128K flash cart that programs its own flash, built here rather than
 * committed as a binary.
 *
 * The `.sav` sidecar cannot be tested end to end without one: every other
 * fixture in the rollout is inert, and the question E2 has to answer is what
 * happens when a *running* cartridge writes to the chip it is executing out of.
 *
 * Two things about it are not incidental.
 *
 * **It copies the programming routine into RAM and runs it there.** `DESIGN.md`
 * requires that, and the emulator's busy window is what makes the requirement
 * real: while the chip is programming, every read of it returns status, so a
 * routine polling from the fixed region would be fetching its own instructions
 * out of a status register. Modelling the window means a cart that got this
 * wrong would hang here exactly as it would on the board.
 *
 * **It behaves differently on its second run**, which is how a test can see a
 * save come back from disk without reading a serial port. The first run finds
 * bank 14 as the `.crt` left it and programs a byte there. A run that finds
 * that byte already programmed knows the overlay was applied, and programs a
 * second one in bank 13 — so an overlay that came back is a two-sector `.sav`,
 * and one that did not is a one-sector `.sav` again.
 */

import { BANK_SIZE, SECTOR_SIZE } from '../../core/Cart'

/** Where the fixed bank puts the routine it copies down. */
export const RAM_ROUTINE = 0x0200

/** Bank 14 `$C000`, the byte the first run programs, and the sector it lands in. */
export const FIRST_VALUE = 0x0A
export const FIRST_BANK = 14
export const FIRST_SECTOR = (FIRST_BANK * BANK_SIZE) / SECTOR_SIZE // 28

/** Bank 13 `$C000`, the byte a run that found a save programs. */
export const SECOND_VALUE = 0x0C
export const SECOND_BANK = 13
export const SECOND_SECTOR = (SECOND_BANK * BANK_SIZE) / SECTOR_SIZE // 26

/**
 * The smallest assembler that will do: bytes, labels, and relative branches.
 *
 * Hand-computed branch offsets in a fixture are a bug waiting for whoever edits
 * it next, and pulling ca65 into a unit test is not a trade worth making.
 */
class Asm {
  readonly bytes: number[] = []
  private readonly labels = new Map<string, number>()
  private readonly fixups: { at: number; label: string; absolute: boolean }[] = []

  constructor(readonly origin: number) {}

  byte(...values: number[]): this {
    this.bytes.push(...values)
    return this
  }

  /** A 16-bit operand, little-endian. */
  word(opcode: number, address: number): this {
    return this.byte(opcode, address & 0xFF, address >> 8)
  }

  label(name: string): this {
    this.labels.set(name, this.bytes.length)
    return this
  }

  /** A relative branch to a label that may not exist yet. */
  branch(opcode: number, name: string): this {
    this.byte(opcode, 0x00)
    this.fixups.push({ at: this.bytes.length - 1, label: name, absolute: false })
    return this
  }

  /** An absolute reference to a label, as `JSR`/`JMP` take one. */
  jump(opcode: number, name: string): this {
    this.byte(opcode, 0x00, 0x00)
    this.fixups.push({ at: this.bytes.length - 2, label: name, absolute: true })
    return this
  }

  assemble(): Uint8Array {
    for (const { at, label, absolute } of this.fixups) {
      const target = this.labels.get(label)
      if (target === undefined) throw new Error(`no label "${label}"`)
      if (absolute) {
        const address = this.origin + target
        this.bytes[at] = address & 0xFF
        this.bytes[at + 1] = address >> 8
      } else {
        const offset = target - (at + 1)
        if (offset < -128 || offset > 127) throw new Error(`"${label}" is out of branch range`)
        this.bytes[at] = offset & 0xFF
      }
    }
    return Uint8Array.from(this.bytes)
  }
}

/**
 * The routine that runs from RAM.
 *
 * `$00` holds the byte to program and `$01` the bank to program it in, so that
 * `PROG` is one routine called twice rather than two copies of the JEDEC
 * sequence. The unlock writes go to banks 2 and 1, which is where CPU `$D555`
 * and `$CAAA` translate to flash `$5555` and `$2AAA` (6502-VCS `PLAN.md` §3).
 */
function ramRoutine(): Uint8Array {
  const a = new Asm(RAM_ROUTINE)

  a.byte(0x78) // SEI — the busy chip would answer an interrupt's vector fetch
  a.byte(0xA9, FIRST_BANK).word(0x8D, 0xE000) // LDA #14 : STA $E000
  a.word(0xAD, 0xC000) // LDA $C000
  a.byte(0xC9, FIRST_VALUE) // CMP #$0A — did a save come back?
  a.branch(0xF0, 'second') // BEQ second

  a.byte(0xA9, FIRST_VALUE).byte(0x85, 0x00) // LDA #$0A : STA $00
  a.byte(0xA9, FIRST_BANK).byte(0x85, 0x01) // LDA #14  : STA $01
  a.jump(0x20, 'prog') // JSR prog
  a.byte(0xDB) // STP

  a.label('second')
  a.byte(0xA9, SECOND_VALUE).byte(0x85, 0x00) // LDA #$0C : STA $00
  a.byte(0xA9, SECOND_BANK).byte(0x85, 0x01) // LDA #13  : STA $01
  a.jump(0x20, 'prog') // JSR prog
  a.byte(0xDB) // STP

  // prog: program $00 into $C000 of bank $01, then data-poll until it reads back.
  a.label('prog')
  a.byte(0xA9, 0x02).word(0x8D, 0xE000) // LDA #2   : STA $E000
  a.byte(0xA9, 0xAA).word(0x8D, 0xD555) // LDA #$AA : STA $D555  (flash $5555)
  a.byte(0xA9, 0x01).word(0x8D, 0xE000) // LDA #1   : STA $E000
  a.byte(0xA9, 0x55).word(0x8D, 0xCAAA) // LDA #$55 : STA $CAAA  (flash $2AAA)
  a.byte(0xA9, 0x02).word(0x8D, 0xE000) // LDA #2   : STA $E000
  a.byte(0xA9, 0xA0).word(0x8D, 0xD555) // LDA #$A0 : STA $D555  (program)
  a.byte(0xA5, 0x01).word(0x8D, 0xE000) // LDA $01  : STA $E000  (the target bank)
  a.byte(0xA5, 0x00).word(0x8D, 0xC000) // LDA $00  : STA $C000  (the byte)

  // The data poll. While the chip is busy it answers with status — DQ7
  // complemented, DQ6 toggling — so this cannot match until the window closes.
  a.label('poll')
  a.word(0xAD, 0xC000) // LDA $C000
  a.byte(0xC5, 0x00) // CMP $00
  a.branch(0xD0, 'poll') // BNE poll
  a.byte(0x60) // RTS

  return a.assemble()
}

/**
 * What sits in the fixed bank at `$E000`: copy the routine down, jump to it.
 *
 * `PAYLOAD` is the copy's source, far enough past `$E000` to leave room for
 * this without either having to know the other's length.
 */
const PAYLOAD = 0xE100

function bootRoutine(length: number): Uint8Array {
  if (length > 0xFF) throw new Error('the RAM routine no longer fits a single-byte copy loop')
  const a = new Asm(0xE000)
  a.byte(0x78) // SEI
  a.byte(0xA2, 0x00) // LDX #0
  a.label('copy')
  a.word(0xBD, PAYLOAD) // LDA PAYLOAD,X
  a.word(0x9D, RAM_ROUTINE) // STA $0200,X
  a.byte(0xE8) // INX
  a.byte(0xE0, length) // CPX #length
  a.branch(0xD0, 'copy') // BNE copy
  a.word(0x4C, RAM_ROUTINE) // JMP $0200
  return a.assemble()
}

/**
 * A 131,072-byte image: every bank filled with its own number, bank 15 fixed
 * and carrying the code and the vectors.
 *
 * The fill is the `banked-128K.crt` idea — a byte says which bank it came from
 * — so that a mapper error shows up as a wrong number rather than as a hang,
 * and so that `$0E & $0A` is a program the chip can actually perform: a program
 * clears bits only, and $0A is reachable from $0E.
 */
export function selfProgrammingCart(): Uint8Array {
  const image = new Uint8Array(0x20000)
  for (let bank = 0; bank < 16; bank++) {
    image.fill(bank, bank * BANK_SIZE, (bank + 1) * BANK_SIZE)
  }

  const fixed = 15 * BANK_SIZE // 0x1E000, what $E000–$FFFF reads
  const ram = ramRoutine()
  image.set(bootRoutine(ram.length), fixed)
  image.set(ram, fixed + (PAYLOAD - 0xE000))

  // Vectors at $FFFA. NMI and IRQ point at the reset routine too: nothing
  // should reach them, and a run that does is better off looping than running
  // off into the bank fill.
  const vectors = fixed + 0x1FFA
  for (const at of [vectors, vectors + 2, vectors + 4]) {
    image[at] = 0x00
    image[at + 1] = 0xE0
  }
  return image
}
