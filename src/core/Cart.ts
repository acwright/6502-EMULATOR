/**
 * Cartridges: the flat 32K ROM cart, and the banked flash cart.
 *
 * The contract implemented here is **6502-VCS `PLAN.md` §§1–3**, which is the
 * normative copy: three emulators and one programmer have to agree bit for bit,
 * so the rules live in that plan rather than in any one implementation. The
 * section markers below (`§2`, `§3`) cite it.
 *
 * The shared oracle is that plan's fixture set, copied into
 * `src/tests/fixtures/` — `banked-128K.crt` above all, whose every bank is
 * filled with its own number so that reading the wrong bank is a wrong byte
 * rather than a hang.
 *
 * **The 32K ROM cart is not replaced.** A 32,768-byte image still becomes a
 * `Cart`, with the same silent drop on a wrong length, and the goldens captured
 * from one do not move.
 */

/** The SST39SF0x0 erase unit, and the granularity of a `.sav` overlay. */
export const SECTOR_SIZE = 0x1000

/** The switchable window, `$C000–$DFFF`. */
export const BANK_SIZE = 0x2000

/**
 * Every length a cartridge image may legally be (§1).
 *
 * The mapper is decided by size and never by the name: 32,768 is the flat
 * mapper, the other four are banked. They cannot collide — no 32K flash part is
 * in the BOM and no 128K-and-up EEPROM cart exists.
 */
export const CART_SIZES: readonly number[] = [0x8000, 0x20000, 0x40000, 0x80000, 0x100000]

/**
 * The target suffix §1's table gives each size, and the words to say it in.
 *
 * The suffix is a label for whoever is reading `ls`; it never decides anything
 * (rule 2). It is here so that `cartNameWarning` and every host that describes
 * a loaded cart spell the five sizes the same way the rollout does.
 */
export const CART_TARGETS: ReadonlyMap<number, string> = new Map([
  [0x8000, '32K'],
  [0x20000, '128K'],
  [0x40000, '256K'],
  [0x80000, '512K'],
  [0x100000, '1M']
])

/** How a cart of this size is named in prose: `256K flash`, or `32K ROM`. */
export function describeCartSize(size: number): string {
  const target = CART_TARGETS.get(size)
  if (!target) return `${size.toLocaleString()} bytes`
  return size === 0x8000 ? '32K ROM' : `${target} flash`
}

/**
 * Rule 3: **the name must agree with the size, and a disagreement is a warning,
 * not an error.**
 *
 * `Foo-512K.crt` that is 262,144 bytes long loads as a 256K cart and says so.
 * The name is for the human reading `ls`; the bytes are for the machine — so
 * this returns a sentence to print, never a reason to refuse the file.
 *
 * Returns `null` when they agree, when the name carries no target suffix and
 * the image is the flat 32K one, or when the size is not a legal one at all
 * (which is the host's own error to report, and a worse one).
 */
export function cartNameWarning(name: string, size: number): string | null {
  if (!CART_TARGETS.has(size)) return null
  const stem = name.replace(/\.[^.]*$/, '')
  // `-VDP` comes before the target (§1), so the target is always last.
  const match = /-(128K|256K|512K|1M)$/i.exec(stem)
  const claimed = match ? match[1]!.toUpperCase() : '32K'
  const actual = CART_TARGETS.get(size)!
  if (claimed === actual) return null
  return (
    `"${name}" is named ${claimed} but is ${size.toLocaleString()} bytes, ` +
    `so it loads as a ${actual} cart. The name is a label; the bytes decide.`
  )
}

/**
 * The busy windows of §3, in cycles at 1 MHz.
 *
 * The plan states them in microseconds at 1 MHz and `Machine` hands the cart its
 * raw cycle count, so a 2 MHz machine sees a window half as long in wall-clock
 * terms. That is the plan's simplification, not an oversight: the window exists
 * to make a self-programming routine that would hang real hardware hang here
 * too, and it does that at either clock.
 */
const PROGRAM_CYCLES = 20 // 20 µs
const SECTOR_ERASE_CYCLES = 25_000 // 25 ms
const CHIP_ERASE_CYCLES = 100_000 // 100 ms

/** Where the unlock state machine has got to. */
const enum Seq {
  Idle,
  Unlock1, // 5555←AA seen
  Unlock2, // 2AAA←55 seen
  Program, // …←A0 seen; the next write is the byte
  Erase1, // …←80 seen
  Erase2, // 5555←AA seen again
  Erase3 // 2AAA←55 seen again; the next write picks chip or sector
}

/**
 * One SST39SF0x0, addressed in flash space.
 *
 * It knows nothing about banks — `BankedCart` does the translation, which is
 * what puts the JEDEC unlock addresses where §3 says they are without any
 * special-casing: CPU `$D555` in bank 2 translates to flash `$5555`.
 */
export class Flash {

  /** `0x20000`, `0x40000` or `0x80000`. */
  readonly size: number

  /** `$B5` / `$B6` / `$B7`, derived from the size so `id` agrees with the Helper. */
  readonly deviceId: number

  readonly data: Uint8Array

  private seq: Seq = Seq.Idle
  private idMode = false

  /** Absolute cycle count at which the current program or erase completes. */
  private busyUntil = 0
  /** DQ7 while busy: the complement of the programmed value for a program, 0 for an erase. */
  private busyDQ7 = 0
  /** DQ6 toggles on every read while busy. */
  private toggle = 0

  private readonly dirty = new Set<number>()

  constructor(size: number) {
    if (size !== 0x20000 && size !== 0x40000 && size !== 0x80000) {
      throw new RangeError(`Flash: ${size} is not an SST39SF0x0 size`)
    }
    this.size = size
    this.deviceId = size === 0x20000 ? 0xB5 : size === 0x40000 ? 0xB6 : 0xB7
    this.data = new Uint8Array(size).fill(0xFF) // the erased state
  }

  /** Replace the contents and forget every sector the cart had touched. */
  load(bytes: Uint8Array): void {
    this.data.set(bytes.subarray(0, this.size))
    this.dirty.clear()
    this.reset()
  }

  /** True while a program or erase is still running at `cycle`. */
  busy(cycle: number): boolean {
    return cycle < this.busyUntil
  }

  /**
   * A byte, an ID byte, or — while busy — status.
   *
   * The busy case is the one that earns its keep. `DESIGN.md` requires a routine
   * programming the chip to run from RAM with interrupts off, because a busy
   * chip answers *every* read, including the vector fetches in the fixed region.
   * An emulator that completed instantly would happily run a routine that hangs
   * on real hardware.
   */
  read(address: number, cycle: number = Infinity): number {
    if (this.busy(cycle)) {
      // DQ7 = complement of the value's DQ7 (program) or 0 (erase);
      // DQ6 toggles on every read; DQ5 = 0. Both standard polling loops — a
      // DQ7 data-poll and a DQ6 toggle-loop — then terminate once the window
      // closes and reads go back to data.
      this.toggle ^= 1
      return (this.busyDQ7 << 7) | (this.toggle << 6)
    }
    if (this.idMode) {
      // Software ID: xx00h is the manufacturer, xx01h the device
      // (SST39SF0x0 data sheet, *Software Product Identification*).
      return address & 1 ? this.deviceId : 0xBF
    }
    return this.data[address & (this.size - 1)]!
  }

  /**
   * Advance the unlock state machine (§3).
   *
   * Unlock addresses are compared as `address & 0x7FFF`, because the part
   * decodes only A14–A0 for commands.
   */
  write(address: number, data: number, cycle: number = Infinity): void {
    const a = address & 0x7FFF
    const value = data & 0xFF

    // `F0` at any address returns the chip to read mode. It is only a command
    // when a program is not pending: the byte a program writes may itself be
    // $F0.
    if (this.seq !== Seq.Program && value === 0xF0) {
      this.idMode = false
      this.seq = Seq.Idle
      return
    }

    switch (this.seq) {
      case Seq.Idle:
        this.seq = a === 0x5555 && value === 0xAA ? Seq.Unlock1 : Seq.Idle
        return
      case Seq.Unlock1:
        this.seq = a === 0x2AAA && value === 0x55 ? Seq.Unlock2 : Seq.Idle
        return
      case Seq.Unlock2:
        if (a !== 0x5555) { this.seq = Seq.Idle; return }
        switch (value) {
          case 0xA0: this.seq = Seq.Program; return
          case 0x80: this.seq = Seq.Erase1; return
          case 0x90: this.idMode = true; this.seq = Seq.Idle; return
          default: this.seq = Seq.Idle; return
        }
      case Seq.Program:
        this.seq = Seq.Idle
        this.program(address, value, cycle)
        return
      case Seq.Erase1:
        this.seq = a === 0x5555 && value === 0xAA ? Seq.Erase2 : Seq.Idle
        return
      case Seq.Erase2:
        this.seq = a === 0x2AAA && value === 0x55 ? Seq.Erase3 : Seq.Idle
        return
      case Seq.Erase3:
        this.seq = Seq.Idle
        if (a === 0x5555 && value === 0x10) this.eraseChip(cycle)
        else if (value === 0x30) this.eraseSector(address, cycle)
        return
    }
  }

  /**
   * Byte program: **clears bits only**, `new = old & data`.
   *
   * A program that expects a `0` bit to come back as `1` without an erase is a
   * bug on hardware, and reproducing it here is how that bug shows up before the
   * chip is real.
   */
  private program(address: number, value: number, cycle: number): void {
    const a = address & (this.size - 1)
    this.data[a] = this.data[a]! & value
    this.dirty.add(Math.floor(a / SECTOR_SIZE))
    // DQ7 is the complement of the *written* value, not of what actually
    // landed. So a data-poll for a bit the chip could not set — a 0 asked to
    // become a 1 without an erase — never matches, which is what the routine
    // would do on hardware.
    this.startBusy(cycle, PROGRAM_CYCLES, (~value >> 7) & 1)
  }

  /** Sector erase: 4 KB to `$FF`, aligned on a 4 KB boundary. */
  private eraseSector(address: number, cycle: number): void {
    const sector = Math.floor((address & (this.size - 1)) / SECTOR_SIZE)
    this.data.fill(0xFF, sector * SECTOR_SIZE, (sector + 1) * SECTOR_SIZE)
    this.dirty.add(sector)
    this.startBusy(cycle, SECTOR_ERASE_CYCLES, 0)
  }

  /** Chip erase: the whole part to `$FF`. */
  private eraseChip(cycle: number): void {
    this.data.fill(0xFF)
    for (let s = 0; s < this.size / SECTOR_SIZE; s++) this.dirty.add(s)
    this.startBusy(cycle, CHIP_ERASE_CYCLES, 0)
  }

  private startBusy(cycle: number, cycles: number, dq7: number): void {
    // A host with no cycle count passes Infinity and gets instant completion.
    this.busyUntil = Number.isFinite(cycle) ? cycle + cycles : 0
    this.busyDQ7 = dq7
    this.toggle = 0
  }

  /**
   * Lay one 4 KB sector down from a `.sav` overlay, and count it dirty.
   *
   * Dirty is the point. The overlay *is* the difference between the `.crt` on
   * disk and what the cart is running, so a sector restored from one still
   * differs from the file — and if it were not marked, a session that read a
   * save back without writing to it again would write an empty `.sav` on eject
   * and throw the save away.
   */
  loadSector(sector: number, bytes: Uint8Array): void {
    this.data.set(bytes.subarray(0, SECTOR_SIZE), sector * SECTOR_SIZE)
    this.dirty.add(sector)
  }

  /** The 4 KB sectors written since the image was loaded, ascending. */
  dirtySectors(): number[] {
    return [...this.dirty].sort((a, b) => a - b)
  }

  /** `RESB`: back to read mode, mid-sequence or not. Contents are untouched. */
  reset(): void {
    this.seq = Seq.Idle
    this.idMode = false
    this.busyUntil = 0
    this.toggle = 0
  }

}

/**
 * The banked flash cart: one SST39SF040 pair at most, §2.
 *
 * Addressed in **CPU** space, `$C000–$FFFF`. Doing the translation in one place
 * is what keeps `Flash` ignorant of banks.
 */
export class BankedCart {

  /** The switchable window. */
  static WINDOW: number = 0xC000
  /** The fixed region — always the primary chip's last 8 KB. */
  static FIXED: number = 0xE000
  static END: number = 0xFFFF

  readonly chips: Flash[]

  /** The whole image's length: `CHIPS * CHIP_SIZE`. */
  readonly size: number
  readonly chipSize: number
  readonly banks: number
  readonly bankMask: number

  /**
   * The latched bank register — write-only, 8 bits, at any address in
   * `$E000–$FFFF`. Cleared to 0 by reset, because its `/MR` is on `RESB`.
   */
  bank: number = 0

  constructor(size: number) {
    if (!CART_SIZES.includes(size) || size === 0x8000) {
      throw new RangeError(`BankedCart: ${size} is not a flash cart size`)
    }
    const chips = size > 0x80000 ? 2 : 1
    this.size = size
    this.chipSize = size / chips
    this.banks = this.chipSize / BANK_SIZE
    this.bankMask = this.banks - 1
    this.chips = [...Array(chips)].map(() => new Flash(this.chipSize))
  }

  /**
   * Build a cart from an image. **U1 is the first half of a `-1M` file, U2 the
   * second** (§1 rule 4), so the file is linear and so is the bank numbering.
   */
  static from(bytes: Uint8Array): BankedCart {
    const cart = new BankedCart(bytes.length)
    cart.chips.forEach((chip, i) => {
      chip.load(bytes.subarray(i * cart.chipSize, (i + 1) * cart.chipSize))
    })
    return cart
  }

  /** `chip = (reg >> 6) & 1`. Bit 7 is latched and goes nowhere. */
  private get chip(): number {
    return (this.bank >> 6) & 1
  }

  /**
   * A read through the mapper.
   *
   * `$E000–$FFFF` is the fixed region and ignores the register entirely;
   * `$C000–$DFFF` is the window. Selecting the absent U2 reads open bus, which
   * every emulator in the rollout models as `$FF` — a deliberate simplification,
   * recorded in 6502-DOCS `ACCURACY.md`.
   */
  read(address: number, cycle: number = Infinity): number {
    if (address >= BankedCart.FIXED) {
      return this.chips[0]!.read(this.chipSize - BANK_SIZE + (address - BankedCart.FIXED), cycle)
    }
    const chip = this.chips[this.chip]
    if (!chip) return 0xFF
    // The NC high address pins on a 010A or 020A are exactly this mask, so a
    // register value above the part's bank count aliases down.
    const bank = this.bank & this.bankMask
    return chip.read(bank * BANK_SIZE + (address - BankedCart.WINDOW), cycle)
  }

  /**
   * A write through the mapper.
   *
   * `$E000–$FFFF` latches the register and **reaches no flash** — `WEB` is not
   * asserted there, so it is not also a flash write. `$C000–$DFFF` is a flash
   * write at the translated address, which only does anything as part of a
   * JEDEC sequence (§3).
   */
  write(address: number, data: number, cycle: number = Infinity): void {
    if (address >= BankedCart.FIXED) {
      this.bank = data & 0xFF
      return
    }
    const chip = this.chips[this.chip]
    if (!chip) return // U2 is not fitted: the write goes nowhere
    const bank = this.bank & this.bankMask
    chip.write(bank * BANK_SIZE + (address - BankedCart.WINDOW), data, cycle)
  }

  /**
   * `RESB`: the register clears to 0 and both chips return to read mode.
   *
   * Flash contents are not cleared and a save overlay is not discarded. The one
   * place where forgetting produces a cart that boots the first time and not the
   * second.
   */
  reset(): void {
    this.bank = 0
    for (const chip of this.chips) chip.reset()
  }

  /** The whole image as it now stands, U1 then U2. */
  image(): Uint8Array {
    const out = new Uint8Array(this.size)
    this.chips.forEach((chip, i) => out.set(chip.data, i * this.chipSize))
    return out
  }

  /** The 4 KB sectors written since load, indexed from the start of the image. */
  dirtySectors(): number[] {
    const perChip = this.chipSize / SECTOR_SIZE
    return this.chips.flatMap((chip, i) => chip.dirtySectors().map((s) => s + i * perChip))
  }

  /**
   * One 4 KB sector as it now stands, as a view into the chip's own bytes.
   *
   * A view and not a copy so that building a `.sav` costs the sectors that
   * changed rather than a megabyte: `image()` would allocate the whole cart to
   * read three sectors out of it.
   */
  sector(index: number): Uint8Array {
    const perChip = this.chipSize / SECTOR_SIZE
    const chip = this.chips[Math.floor(index / perChip)]
    if (!chip) throw new RangeError(`sector ${index} lies outside a ${this.size}-byte cart`)
    const at = (index % perChip) * SECTOR_SIZE
    return chip.data.subarray(at, at + SECTOR_SIZE)
  }

  /** Lay one sector of a `.sav` overlay over the image, counting it dirty. */
  loadSector(index: number, bytes: Uint8Array): void {
    const perChip = this.chipSize / SECTOR_SIZE
    const chip = this.chips[Math.floor(index / perChip)]
    if (!chip) throw new RangeError(`sector ${index} lies outside a ${this.size}-byte cart`)
    chip.loadSector(index % perChip, bytes)
  }

}

/**
 * The flat 32K ROM cart — a 28C256 or 27C256, unchanged.
 *
 * `read` now takes a **CPU** address and does the `- START` itself, so that
 * `Machine` can hand either kind of cart the address off the bus. `write` and
 * `reset` exist so the two kinds share a shape; on a ROM cart both do nothing,
 * which is what a write to a mask ROM does.
 */
export class Cart {

  static START: number = 0x8000
  static END: number = 0xFFFF
  static CODE: number = 0xC000
  static SIZE: number = Cart.END - Cart.START + 1

  data: number[] = [...Array(Cart.SIZE)].fill(0x00)

  read(address: number, _cycle?: number): number {
    return this.data[address - Cart.START]!
  }

  /** A ROM cart has no `WEB`. */
  write(_address: number, _data: number, _cycle?: number): void {}

  reset(): void {}

  load(data: number[]): void {
    if (data.length != Cart.SIZE) { return }

    this.data = data
  }

}

/** Either kind of cartridge, as `Machine` holds it. */
export type Cartridge = Cart | BankedCart

/**
 * Size alone decides which mapper an image gets (§1 rule 2).
 *
 * Anything else returns `null`, which every caller already handles as "the image
 * was dropped". The name/size cross-check of rule 3 belongs in the hosts: this
 * function never sees a filename.
 */
export function cartFromImage(bytes: Uint8Array | number[]): Cartridge | null {
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)
  if (data.length === Cart.SIZE) {
    const cart = new Cart()
    cart.load(Array.from(data))
    return cart
  }
  if (!CART_SIZES.includes(data.length)) return null
  return BankedCart.from(data)
}
