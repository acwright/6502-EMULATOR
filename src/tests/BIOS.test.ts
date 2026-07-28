/**
 * End-to-end tests against the bundled BIOS ROM.
 *
 * Boots the real BIOS.bin headlessly with no video card, so the Kernal routes
 * the console to serial and the ACIA transmit callback gives us the screen as
 * text. BASIC is then driven over the same serial link, exactly as a terminal
 * would drive the real machine.
 *
 * These cover the seam between the emulator's program loader and BASIC's own
 * memory management: injecting an image into RAM skips BASIC's LOAD, so the
 * end-of-program pointers have to be set by hand, and getting that wrong lets
 * the first variable assignment overwrite the program.
 *
 * Program images are captured out of a live machine rather than hand-assembled,
 * so the token bytes are always whatever this BASIC actually uses.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { Machine } from '../core/Machine'
import { Empty } from '../core/IO/Empty'
import { loadProgramImage, applyProgramPointers, isBasicReady } from '../core/ProgramImage'

const BIOS = readFileSync(join(__dirname, '../renderer/public/roms/BIOS.bin'))

const BAS_TXTTAB = 0x035d
const BAS_VARTAB = 0x035f
const BAS_ARYTAB = 0x0361
const BAS_STREND = 0x0363

/** Kernal hardware-detect bitmask; non-zero once the boot probe has finished. */
const HW_PRESENT = 0x030d

const KEY_ENTER = 0x0d

/** Emulated cycles between polls of the condition a wait is blocked on. */
const POLL_CYCLES = 50_000

/** Upper bound on any single wait; generous, and never reached in practice. */
const MAX_WAIT_CYCLES = 20_000_000

/**
 * The 6502-PRG template's startup stub (`10 SYS 2060`) followed by machine code
 * at $080C that immediately returns to BASIC. The end-of-program marker sits at
 * $080A, so a line-chain walk stops well short of the real end of the image.
 */
const PRG_IMAGE = Uint8Array.from([
  0x0a, 0x08, 0x0a, 0x00, 0xa5, 0x32, 0x30, 0x36, 0x30, 0x00, // 10 SYS 2060
  0x00, 0x00, // end-of-program marker at $080A
  0x60, 0x60, 0x60, 0x60, // machine code at $080C
])

class Harness {
  readonly machine = new Machine()
  out = ''

  constructor() {
    this.machine.io8 = new Empty() // no video -> console routes to serial
    this.machine.transmit = (b: number) => {
      this.out += String.fromCharCode(b)
    }
    this.machine.loadROM(new Uint8Array(BIOS))
    this.machine.reset(true)
  }

  private cycles(n: number): void {
    for (let i = 0; i < n; i++) this.machine.step()
  }

  /**
   * Step until `done()` holds. Returns false if the budget ran out first.
   *
   * `onPoll` runs before the check, so a caller standing in for the deferred
   * fixup still gets a turn on the iteration where the condition first holds —
   * the same ordering the store's timer sees.
   */
  private waitFor(done: () => boolean, onPoll?: () => void): boolean {
    for (let spent = 0; spent < MAX_WAIT_CYCLES; spent += POLL_CYCLES) {
      onPoll?.()
      if (done()) return true
      this.cycles(POLL_CYCLES)
    }
    return done()
  }

  /**
   * Boot through the hardware probe and the splash into BASIC.
   *
   * The splash waits on a keypress and there is no serial-side signal for when
   * it starts listening — the splash itself goes to video, which this harness
   * does not have — so wait on the Kernal publishing its hardware-probe result
   * instead. Typing before that wedges the receiver: a byte arriving ahead of
   * ACIA setup is lost, and re-sending one every poll never boots at all.
   */
  boot(): this {
    if (!this.waitFor(() => this.machine.read(HW_PRESENT) !== 0)) {
      throw new Error('BIOS hardware probe did not complete')
    }
    this.machine.onReceive(KEY_ENTER) // ENTER at the splash selects BASIC
    if (!this.waitFor(() => isBasicReady(this.machine), this.onPoll)) {
      throw new Error('BIOS did not reach the BASIC prompt')
    }
    this.waitForPrompt()
    return this
  }

  /**
   * Called on every poll while booting, so a test can stand in for the deferred
   * pointer fixup the store and a CLI run against a live machine.
   */
  onPoll?: () => void

  private send(text: string): void {
    for (const ch of text) {
      this.machine.onReceive(ch.charCodeAt(0))
      this.cycles(6000) // let the IRQ handler drain the ACIA between keystrokes
    }
  }

  /** Wait for BASIC to finish and print its OK prompt. */
  private waitForPrompt(): boolean {
    return this.waitFor(() => /OK[\r\n]*$/.test(this.out))
  }

  /**
   * Type a direct-mode command, wait for the prompt, and return only its output.
   * Not for numbered program lines — storing one prints no prompt.
   */
  run(command: string): string {
    this.out = ''
    this.send(command + '\r')
    if (!this.waitForPrompt()) {
      throw new Error(`no prompt after ${JSON.stringify(command)}; saw ${JSON.stringify(this.out)}`)
    }
    return this.out
  }

  /**
   * Enter a numbered program line. BASIC returns straight to its input loop
   * without printing a prompt, so wait for the program to grow instead.
   */
  enterLine(line: string): void {
    const before = this.word(BAS_VARTAB)
    this.out = ''
    this.send(line + '\r')
    if (!this.waitFor(() => this.word(BAS_VARTAB) !== before)) {
      throw new Error(`line not stored: ${JSON.stringify(line)}; saw ${JSON.stringify(this.out)}`)
    }
  }

  read(address: number): number {
    return this.machine.read(address)
  }

  word(address: number): number {
    return this.machine.read(address) | (this.machine.read(address + 1) << 8)
  }

  /** The bytes BASIC's SAVE would write: $0800 up to VARTAB. */
  capture(): Uint8Array {
    const end = this.word(BAS_VARTAB)
    const bytes = new Uint8Array(end - 0x0800)
    for (let i = 0; i < bytes.length; i++) bytes[i] = this.machine.read(0x0800 + i)
    return bytes
  }

  /** The four machine-code bytes a .prg carries at $080C. */
  prgCode(): number[] {
    return [0, 1, 2, 3].map((i) => this.read(0x080c + i))
  }
}

/**
 * A three-line program typed into a live BASIC and captured as an image — the
 * same bytes SAVE would produce, and therefore the same bytes bastok emits.
 */
function captureBasicImage(): Uint8Array {
  const h = new Harness().boot()
  h.enterLine('10 PRINT "HI"')
  h.enterLine('20 A=5')
  h.enterLine('30 PRINT A')
  return h.capture()
}

let basicImage: Uint8Array

beforeAll(() => {
  basicImage = captureBasicImage()
})

describe('BIOS boot', () => {
  let h: Harness

  beforeAll(() => {
    h = new Harness().boot()
  })

  it('reaches the BASIC prompt over serial', () => {
    expect(h.out).toMatch(/6502 BASIC/i)
    expect(h.out).toMatch(/OK/)
  })

  it('reports all of RAM free above the empty-program pointer', () => {
    // MEMSIZ - VARTAB = $8000 - $0802.
    expect(h.out).toMatch(/30718 BYTES FREE/i)
  })

  it('initialises the BASIC workspace that isBasicReady() looks for', () => {
    expect(h.word(BAS_TXTTAB)).toBe(0x0800)
    expect(h.word(BAS_VARTAB)).toBe(0x0802)
    expect(isBasicReady(h.machine)).toBe(true)
  })
})

describe('capturing a program image from a live BASIC', () => {
  it('ends at the $0000 end-of-program marker', () => {
    expect(basicImage.length).toBeGreaterThan(10)
    expect(Array.from(basicImage.slice(-2))).toEqual([0, 0])
  })
})

describe('injecting a BASIC program image', () => {
  let h: Harness

  beforeAll(() => {
    h = new Harness().boot()
  })

  it('moves all three pointers past the image', () => {
    expect(loadProgramImage(h.machine, basicImage)).toBe('ok')
    const end = 0x0800 + basicImage.length
    expect(h.word(BAS_VARTAB)).toBe(end)
    expect(h.word(BAS_ARYTAB)).toBe(end)
    expect(h.word(BAS_STREND)).toBe(end)
  })

  it('lists the injected program', () => {
    const listing = h.run('LIST')
    expect(listing).toMatch(/10\s+PRINT/i)
    expect(listing).toMatch(/20\s+A/i)
    expect(listing).toMatch(/30\s+PRINT/i)
  })

  it('survives a direct-mode assignment', () => {
    // Without the ARYTAB/STREND fixup the new scalar lands on line 10 and the
    // listing collapses to a single nonsense line ("78 FOR").
    h.run('B=7')
    const listing = h.run('LIST')
    expect(listing).toMatch(/10\s+PRINT/i)
    expect(listing).toMatch(/30\s+PRINT/i)
    expect(listing).not.toMatch(/78\s+FOR/i)
  })

  it('runs, and still lists afterwards', () => {
    const output = h.run('RUN')
    expect(output).toMatch(/HI/)
    expect(output).not.toMatch(/ERROR/i)

    const listing = h.run('LIST')
    expect(listing).toMatch(/10\s+PRINT/i)
    expect(listing).toMatch(/30\s+PRINT/i)
  })
})

describe('injecting a .prg image with a machine-code payload', () => {
  let h: Harness

  beforeAll(() => {
    h = new Harness().boot()
  })

  it('puts the pointers past the machine code, not at the chain end', () => {
    expect(loadProgramImage(h.machine, PRG_IMAGE)).toBe('ok')
    // A line-chain walk would stop at the $080A marker and leave VARTAB at
    // $080C — on top of the machine code.
    expect(h.word(BAS_VARTAB)).toBe(0x0810)
    expect(h.word(BAS_ARYTAB)).toBe(0x0810)
    expect(h.word(BAS_STREND)).toBe(0x0810)
  })

  it('lists as the SYS stub', () => {
    expect(h.run('LIST')).toMatch(/10\s+SYS\s*2060/i)
  })

  it('leaves the machine code intact across a variable assignment', () => {
    h.run('C=9')
    expect(h.prgCode()).toEqual([0x60, 0x60, 0x60, 0x60])
  })

  it('runs the stub without corrupting the payload', () => {
    expect(h.run('RUN')).not.toMatch(/ERROR/i)
    expect(h.prgCode()).toEqual([0x60, 0x60, 0x60, 0x60])
  })
})

describe('injecting before BASIC has booted', () => {
  let h: Harness
  let status: string

  beforeAll(() => {
    h = new Harness() // reset, but not yet stepped
    status = loadProgramImage(h.machine, basicImage)
    h.boot()
  })

  it('reports that the pointers could not be set', () => {
    expect(status).toBe('basic-not-ready')
  })

  it('is still recovered by the BIOS cold-start chain walk', () => {
    // BASIC's startup detects a program already sitting at $0800 and walks the
    // chain itself, which is correct for a pure BASIC image.
    expect(h.word(BAS_VARTAB)).toBe(0x0800 + basicImage.length)
    expect(h.run('LIST')).toMatch(/10\s+PRINT/i)
  })
})

/**
 * The CLI's flow: write the image before the machine has booted, then let it
 * boot with the deferred fixup retrying until BASIC is up. Without the fixup the
 * BIOS chain walk stops at the end marker and leaves the payload exposed.
 */
describe('preloading a .prg before boot, with the deferred fixup', () => {
  let h: Harness
  let status: string
  let applied = false

  beforeAll(() => {
    h = new Harness()
    status = loadProgramImage(h.machine, PRG_IMAGE)
    h.onPoll = () => {
      if (!applied) applied = applyProgramPointers(h.machine, PRG_IMAGE.length)
    }
    h.boot()
  })

  it('cannot set the pointers up front', () => {
    expect(status).toBe('basic-not-ready')
  })

  it('applies them once BASIC has booted', () => {
    expect(applied).toBe(true)
    expect(h.word(BAS_VARTAB)).toBe(0x0810)
    expect(h.word(BAS_ARYTAB)).toBe(0x0810)
    expect(h.word(BAS_STREND)).toBe(0x0810)
  })

  it('lists as the SYS stub', () => {
    expect(h.run('LIST')).toMatch(/10\s+SYS\s*2060/i)
  })

  it('keeps the machine code across a variable assignment', () => {
    h.run('C=9')
    expect(h.prgCode()).toEqual([0x60, 0x60, 0x60, 0x60])
  })
})

/** The same preload without the fixup, showing what it is protecting against. */
describe('preloading a .prg before boot, without the fixup', () => {
  let h: Harness

  beforeAll(() => {
    h = new Harness()
    loadProgramImage(h.machine, PRG_IMAGE)
    h.boot()
  })

  it('leaves VARTAB at the chain end, short of the payload', () => {
    expect(h.word(BAS_VARTAB)).toBe(0x080c)
  })

  it('lets the first variable overwrite the machine code', () => {
    expect(h.prgCode()).toEqual([0x60, 0x60, 0x60, 0x60])
    h.run('C=9')
    expect(h.prgCode()).not.toEqual([0x60, 0x60, 0x60, 0x60])
  })
})
