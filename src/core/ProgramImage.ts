/**
 * Program images and raw binaries.
 *
 * A program image — what a `.prg` or `.bas` file holds — is simply the raw bytes
 * that belong at $0800 upward: a tokenized BASIC line chain,
 *
 *   per line:  [next-lo][next-hi][num-lo][num-hi][tokens...][$00]
 *   end:       a next-pointer of $0000
 *
 * `.prg` and `.bas` are not different formats. A `.prg` is a program image whose
 * BASIC part is a one-line stub (`10 SYS 2060`) and which carries machine code
 * after the end marker. Nothing here inspects the file extension — behaviour is
 * chosen by the caller's verb, as on the real machine, where LOAD means "program
 * image to $0800" and BLOAD means "raw bytes to an explicit address".
 *
 * Writing an image straight into RAM skips BASIC's own LOAD, which fixes up the
 * end-of-program pointers afterwards. Without that fixup BASIC still believes its
 * program ends at $0802, and the first variable — a 7-byte record — is written
 * over the start of the program. So the pointers have to be set here.
 *
 * The extent of an image is its byte length, not where its line chain ends. For a
 * pure BASIC program the two are identical, because SAVE writes VARTAB - TXTTAB
 * bytes; for a `.prg` only the byte length covers the trailing machine code.
 */

/** The subset of Machine this module needs. */
export interface MemoryBus {
  read(address: number): number
  write(address: number, data: number): void
}

/** Programs load at $0800, immediately above the Kernal/BASIC workspace. */
export const PROGRAM_LOAD_ADDRESS = 0x0800

/** $8000 and up is I/O, so RAM ends here. */
const RAM_TOP = 0x8000

/** Largest program image that fits in $0800-$7FFF. */
export const MAX_PROGRAM_SIZE = RAM_TOP - PROGRAM_LOAD_ADDRESS

/** BASIC workspace pointers — see BIOS.inc in the 6502-BIOS repo. */
const BAS_TXTTAB = 0x035d // start of program text
const BAS_VARTAB = 0x035f // end of program / start of variables
const BAS_ARYTAB = 0x0361 // start of arrays
const BAS_STREND = 0x0363 // end of arrays
const BAS_MEMSIZ = 0x0367 // end of usable memory
const BAS_WARM = 0x036f // warm-start magic, written last by BasColdInit

/** Value BasColdInit leaves in BAS_WARM once it has finished. */
const BASIC_WARM_MAGIC = 0xa5

export type ProgramLoadStatus = 'ok' | 'basic-not-ready' | 'empty' | 'too-large'
export type BinaryLoadStatus = 'ok' | 'empty' | 'out-of-range'

function readWord(bus: MemoryBus, address: number): number {
  return bus.read(address) | (bus.read(address + 1) << 8)
}

function writeWord(bus: MemoryBus, address: number, value: number): void {
  bus.write(address, value & 0xff)
  bus.write(address + 1, (value >> 8) & 0xff)
}

/**
 * True once BASIC has *finished* initialising its workspace. BasColdInit writes
 * the end-of-program pointers unconditionally, so a fixup applied before it
 * completes is overwritten.
 *
 * The warm-start magic is the load-bearing check here: BasColdInit sets TXTTAB
 * and MEMSIZ early but VARTAB/ARYTAB/STREND later, leaving a window where the
 * workspace looks ready but the pointers have not been written yet. BAS_WARM is
 * the last thing it writes, so it is the only signal that closes that window.
 * TXTTAB and MEMSIZ are still checked to avoid mistaking a stray $A5 in
 * uninitialised memory for a booted BASIC.
 */
export function isBasicReady(bus: MemoryBus): boolean {
  return (
    bus.read(BAS_WARM) === BASIC_WARM_MAGIC &&
    readWord(bus, BAS_TXTTAB) === PROGRAM_LOAD_ADDRESS &&
    readWord(bus, BAS_MEMSIZ) === RAM_TOP
  )
}

/**
 * Point BASIC's end-of-program pointers past an image of `byteLength` bytes at
 * $0800, and report whether it could be done.
 *
 * Split out from loadProgramImage so a caller that wrote an image before BASIC
 * was up — an emulator's load button used while the machine is reset, or a CLI
 * that preloads a program and then boots — can retry as the machine runs and
 * apply the fixup the moment BASIC finishes initialising. Cheap enough to call
 * on every frame; it reads three bytes until BASIC is up.
 */
export function applyProgramPointers(bus: MemoryBus, byteLength: number): boolean {
  if (!isBasicReady(bus)) return false

  // TXTTAB is already $0800 — isBasicReady asserts it.
  const end = PROGRAM_LOAD_ADDRESS + byteLength
  writeWord(bus, BAS_VARTAB, end)
  writeWord(bus, BAS_ARYTAB, end)
  writeWord(bus, BAS_STREND, end)
  return true
}

/**
 * Write a program image to $0800 and move BASIC's end-of-program pointers past
 * it, the way BASIC's own LOAD does.
 *
 * ARYTAB and STREND are set alongside VARTAB. RUN re-derives them from VARTAB via
 * CLR, but a direct-mode assignment typed before RUN allocates at ARYTAB and would
 * otherwise land inside the program.
 *
 * Returns `basic-not-ready` if the bytes were written but the pointers could not
 * be. Do not treat that as done: BASIC's startup will walk the line chain, which
 * recovers a pure BASIC program but leaves a `.prg`'s machine code below VARTAB
 * and exposed. Keep the byte length and retry via applyProgramPointers().
 */
export function loadProgramImage(bus: MemoryBus, bytes: Uint8Array): ProgramLoadStatus {
  if (bytes.length === 0) return 'empty'
  if (bytes.length > MAX_PROGRAM_SIZE) return 'too-large'

  for (let i = 0; i < bytes.length; i++) {
    bus.write(PROGRAM_LOAD_ADDRESS + i, bytes[i]!)
  }

  return applyProgramPointers(bus, bytes.length) ? 'ok' : 'basic-not-ready'
}

/**
 * BLOAD: raw bytes to an explicit address, leaving BASIC's state alone.
 *
 * Deliberately permissive about the destination — BLOAD on the real machine will
 * write anywhere in RAM, including zero page and the Kernal workspace — but it
 * will not run off the top of RAM into the I/O space.
 */
export function loadBinary(
  bus: MemoryBus,
  address: number,
  bytes: Uint8Array
): BinaryLoadStatus {
  if (bytes.length === 0) return 'empty'
  if (address < 0 || address + bytes.length > RAM_TOP) return 'out-of-range'

  for (let i = 0; i < bytes.length; i++) {
    bus.write(address + i, bytes[i]!)
  }
  return 'ok'
}
