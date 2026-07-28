import {
  loadProgramImage,
  applyProgramPointers,
  loadBinary,
  isBasicReady,
  PROGRAM_LOAD_ADDRESS,
  MAX_PROGRAM_SIZE,
} from '../core/ProgramImage'
import type { MemoryBus } from '../core/ProgramImage'

const BAS_TXTTAB = 0x035d
const BAS_VARTAB = 0x035f
const BAS_ARYTAB = 0x0361
const BAS_STREND = 0x0363
const BAS_MEMSIZ = 0x0367
const BAS_WARM = 0x036f

/** Flat 64K memory standing in for Machine's bus. */
class FakeBus implements MemoryBus {
  readonly mem = new Uint8Array(0x10000)
  read(address: number): number {
    return this.mem[address]!
  }
  write(address: number, data: number): void {
    this.mem[address] = data & 0xff
  }
  word(address: number): number {
    return this.mem[address]! | (this.mem[address + 1]! << 8)
  }
  setWord(address: number, value: number): void {
    this.mem[address] = value & 0xff
    this.mem[address + 1] = (value >> 8) & 0xff
  }
}

/** A bus in the state BASIC leaves after startup with no program loaded. */
function bootedBus(): FakeBus {
  const bus = new FakeBus()
  bus.setWord(BAS_TXTTAB, 0x0800)
  bus.setWord(BAS_MEMSIZ, 0x8000)
  bus.setWord(BAS_VARTAB, 0x0802)
  bus.setWord(BAS_ARYTAB, 0x0802)
  bus.setWord(BAS_STREND, 0x0802)
  bus.write(BAS_WARM, 0xa5) // BasColdInit writes this last
  return bus
}

/**
 * The state part-way through BasColdInit: TXTTAB and MEMSIZ are set, but the
 * end-of-program pointers have not been written yet and the warm magic is
 * still absent.
 */
function bootingBus(): FakeBus {
  const bus = bootedBus()
  bus.write(BAS_WARM, 0x00)
  return bus
}

/**
 * A two-line BASIC program: 10 and 20, each with a one-byte token payload.
 * 14 bytes total, ending in the $0000 next-pointer.
 */
const basicProgram = Uint8Array.from([
  0x06, 0x08, 0x0a, 0x00, 0x99, 0x00, // line 10 -> $0806
  0x0c, 0x08, 0x14, 0x00, 0x80, 0x00, // line 20 -> $080C
  0x00, 0x00, // end marker
])

/** The 6502-PRG stub (10 SYS 2060) followed by four bytes of machine code. */
const prgImage = Uint8Array.from([
  0x0a, 0x08, 0x0a, 0x00, 0xa5, 0x32, 0x30, 0x36, 0x30, 0x00, // line 10
  0x00, 0x00, // end marker at $080A
  0x20, 0x18, 0xa0, 0x60, // machine code at $080C
])

describe('isBasicReady', () => {
  it('is false on cleared RAM', () => {
    expect(isBasicReady(new FakeBus())).toBe(false)
  })

  it('is true once BASIC has initialised its workspace', () => {
    expect(isBasicReady(bootedBus())).toBe(true)
  })

  it('is false when only TXTTAB looks initialised', () => {
    const bus = new FakeBus()
    bus.setWord(BAS_TXTTAB, 0x0800)
    expect(isBasicReady(bus)).toBe(false)
  })

  it('is false part-way through cold init, before the pointers are written', () => {
    // Applying a fixup here would be silently overwritten moments later.
    expect(isBasicReady(bootingBus())).toBe(false)
  })

  it('is false for a stray warm magic in otherwise empty memory', () => {
    const bus = new FakeBus()
    bus.write(BAS_WARM, 0xa5)
    expect(isBasicReady(bus)).toBe(false)
  })
})

describe('applyProgramPointers', () => {
  it('sets all three pointers once BASIC is up', () => {
    const bus = bootedBus()
    expect(applyProgramPointers(bus, basicProgram.length)).toBe(true)
    const end = PROGRAM_LOAD_ADDRESS + basicProgram.length
    expect(bus.word(BAS_VARTAB)).toBe(end)
    expect(bus.word(BAS_ARYTAB)).toBe(end)
    expect(bus.word(BAS_STREND)).toBe(end)
  })

  it('declines and changes nothing while BASIC is still booting', () => {
    const bus = bootingBus()
    expect(applyProgramPointers(bus, basicProgram.length)).toBe(false)
    expect(bus.word(BAS_VARTAB)).toBe(0x0802)
    expect(bus.word(BAS_ARYTAB)).toBe(0x0802)
    expect(bus.word(BAS_STREND)).toBe(0x0802)
  })

  it('lets a deferred caller finish a load that was too early', () => {
    // What the store and a CLI do: write before boot, retry until it takes.
    const bus = bootingBus()
    expect(loadProgramImage(bus, prgImage)).toBe('basic-not-ready')
    expect(applyProgramPointers(bus, prgImage.length)).toBe(false)

    bus.write(BAS_WARM, 0xa5) // BASIC finishes booting
    expect(applyProgramPointers(bus, prgImage.length)).toBe(true)
    expect(bus.word(BAS_VARTAB)).toBe(0x0810)
    expect(bus.word(BAS_ARYTAB)).toBe(0x0810)
  })
})

describe('loadProgramImage', () => {
  it('writes the image at $0800', () => {
    const bus = bootedBus()
    expect(loadProgramImage(bus, basicProgram)).toBe('ok')
    expect(bus.mem.slice(0x0800, 0x0800 + basicProgram.length)).toEqual(basicProgram)
  })

  it('sets VARTAB, ARYTAB and STREND past a BASIC program', () => {
    const bus = bootedBus()
    loadProgramImage(bus, basicProgram)

    const end = PROGRAM_LOAD_ADDRESS + basicProgram.length
    expect(end).toBe(0x080e)
    expect(bus.word(BAS_VARTAB)).toBe(end)
    expect(bus.word(BAS_ARYTAB)).toBe(end)
    expect(bus.word(BAS_STREND)).toBe(end)
  })

  it('leaves TXTTAB alone', () => {
    const bus = bootedBus()
    loadProgramImage(bus, basicProgram)
    expect(bus.word(BAS_TXTTAB)).toBe(0x0800)
  })

  it('protects the machine code carried past a .prg end marker', () => {
    const bus = bootedBus()
    loadProgramImage(bus, prgImage)

    // A chain walk would stop at the $080A end marker and leave VARTAB at
    // $080C, putting the first variable on top of the machine code.
    expect(bus.word(BAS_VARTAB)).toBe(0x0810)
    expect(bus.word(BAS_ARYTAB)).toBe(0x0810)
    expect(bus.word(BAS_STREND)).toBe(0x0810)
  })

  it('writes the bytes but reports basic-not-ready before BASIC has booted', () => {
    const bus = new FakeBus()
    expect(loadProgramImage(bus, basicProgram)).toBe('basic-not-ready')
    expect(bus.mem.slice(0x0800, 0x0800 + basicProgram.length)).toEqual(basicProgram)
    expect(bus.word(BAS_VARTAB)).toBe(0x0000)
  })

  it('rejects an empty file without touching memory', () => {
    const bus = bootedBus()
    expect(loadProgramImage(bus, new Uint8Array(0))).toBe('empty')
    expect(bus.word(BAS_VARTAB)).toBe(0x0802)
  })

  it('rejects an image that would run into the I/O space', () => {
    const bus = bootedBus()
    expect(loadProgramImage(bus, new Uint8Array(MAX_PROGRAM_SIZE + 1))).toBe('too-large')
    expect(bus.mem[0x0800]).toBe(0x00)
    expect(bus.word(BAS_VARTAB)).toBe(0x0802)
  })

  it('accepts an image that exactly fills RAM', () => {
    const bus = bootedBus()
    expect(loadProgramImage(bus, new Uint8Array(MAX_PROGRAM_SIZE))).toBe('ok')
    expect(bus.word(BAS_VARTAB)).toBe(0x8000)
  })

  it('ignores what the line chain says and uses the byte length', () => {
    // Trailing bytes after the end marker are part of the image, whatever they are.
    const bus = bootedBus()
    const padded = new Uint8Array(basicProgram.length + 100)
    padded.set(basicProgram)
    loadProgramImage(bus, padded)
    expect(bus.word(BAS_VARTAB)).toBe(PROGRAM_LOAD_ADDRESS + padded.length)
  })
})

describe('loadBinary', () => {
  it('writes bytes at the requested address', () => {
    const bus = bootedBus()
    expect(loadBinary(bus, 0x2000, Uint8Array.from([1, 2, 3]))).toBe('ok')
    expect(Array.from(bus.mem.slice(0x2000, 0x2003))).toEqual([1, 2, 3])
  })

  it('leaves BASIC pointers untouched', () => {
    const bus = bootedBus()
    loadBinary(bus, 0x2000, Uint8Array.from([1, 2, 3]))
    expect(bus.word(BAS_VARTAB)).toBe(0x0802)
    expect(bus.word(BAS_ARYTAB)).toBe(0x0802)
    expect(bus.word(BAS_STREND)).toBe(0x0802)
    expect(bus.word(BAS_TXTTAB)).toBe(0x0800)
  })

  it('allows zero page and the Kernal workspace, as BLOAD does', () => {
    const bus = bootedBus()
    expect(loadBinary(bus, 0x0000, Uint8Array.from([0xff]))).toBe('ok')
    expect(bus.mem[0x0000]).toBe(0xff)
  })

  it('refuses to run past the top of RAM into I/O', () => {
    const bus = bootedBus()
    expect(loadBinary(bus, 0x7fff, Uint8Array.from([1, 2]))).toBe('out-of-range')
    expect(bus.mem[0x7fff]).toBe(0x00)
  })

  it('accepts a binary ending exactly at the top of RAM', () => {
    const bus = bootedBus()
    expect(loadBinary(bus, 0x7ffe, Uint8Array.from([1, 2]))).toBe('ok')
  })

  it('rejects a negative address', () => {
    const bus = bootedBus()
    expect(loadBinary(bus, -1, Uint8Array.from([1]))).toBe('out-of-range')
  })

  it('rejects an empty file', () => {
    const bus = bootedBus()
    expect(loadBinary(bus, 0x2000, new Uint8Array(0))).toBe('empty')
  })
})
