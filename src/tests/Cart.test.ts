import { readFileSync } from 'fs'
import { join } from 'path'
import {
  BANK_SIZE,
  BankedCart,
  CART_SIZES,
  Cart,
  Flash,
  SECTOR_SIZE,
  cartFromImage
} from '../core/Cart'

// The shared oracle. These four files come from 6502-VCS
// `Firmware/FH Programmer/host/test/fixtures/`; see fixtures/cart/README.md.
const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'cart', name)))

/** CRC-32, IEEE, as the rollout quotes it. */
const crc32hex = (bytes: Uint8Array): string => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let c = 0xFFFFFFFF
  for (const b of bytes) c = table[(c ^ b) & 0xFF]! ^ (c >>> 8)
  return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0')
}

/**
 * A deterministic image whose every byte says where it came from, so a
 * translation error is a wrong byte rather than a coincidence.
 */
const synthetic = (size: number): Uint8Array => {
  const image = new Uint8Array(size)
  for (let i = 0; i < size; i++) image[i] = (i ^ (i >>> 8) ^ (i >>> 16)) & 0xFF
  return image
}

/** Set the bank register the way a program does: a write anywhere in $E000+. */
const setBank = (cart: BankedCart, reg: number): void => cart.write(0xE000, reg)

/** The JEDEC unlock pair, at the CPU addresses DESIGN.md's table gives. */
const unlock = (cart: BankedCart, cycle = Infinity): void => {
  setBank(cart, 2)
  cart.write(0xD555, 0xAA, cycle) // flash $5555
  setBank(cart, 1)
  cart.write(0xCAAA, 0x55, cycle) // flash $2AAA
  setBank(cart, 2)
}

describe('fixtures', () => {
  // If one of these moves, every other repository checking against these files
  // has to be told. They are quoted in 6502-VCS PLAN.md and in the ROLLOUT.
  test('carry the published checksums', () => {
    expect(crc32hex(fixture('legacy.crt'))).toBe('98a4e0fd')
    expect(crc32hex(fixture('legacy-512K.crt'))).toBe('bdaa7346')
    expect(crc32hex(fixture('banked-128K.crt'))).toBe('e0e4f83c')
    expect(crc32hex(fixture('sample.sav'))).toBe('45c4068e')
  })
})

describe('cartFromImage', () => {
  test('32,768 bytes is the flat ROM cart', () => {
    const cart = cartFromImage(fixture('legacy.crt'))
    expect(cart).toBeInstanceOf(Cart)
  })

  test.each([
    [0x20000, 16, 1],
    [0x40000, 32, 1],
    [0x80000, 64, 1],
    [0x100000, 64, 2]
  ])('%d bytes is a banked cart of %d banks over %d chip(s)', (size, banks, chips) => {
    const cart = cartFromImage(synthetic(size)) as BankedCart
    expect(cart).toBeInstanceOf(BankedCart)
    expect(cart.banks).toBe(banks)
    expect(cart.chips).toHaveLength(chips)
    expect(cart.bankMask).toBe(banks - 1)
    expect(cart.size).toBe(size)
  })

  test.each([0, 1, 16384, 0x7FFF, 0x8001, 0x10000, 0x60000, 0x100001, 0x200000])(
    '%d bytes is not a cartridge image',
    (size) => {
      expect(cartFromImage(new Uint8Array(size))).toBeNull()
    }
  )

  test('every published size is accepted, and nothing else', () => {
    expect([...CART_SIZES]).toEqual([0x8000, 0x20000, 0x40000, 0x80000, 0x100000])
    for (const size of CART_SIZES) expect(cartFromImage(new Uint8Array(size))).not.toBeNull()
  })

  test('takes a number[] as well as a Uint8Array', () => {
    expect(cartFromImage([...fixture('legacy.crt')])).toBeInstanceOf(Cart)
  })
})

describe('Cart — the flat 32K ROM cart', () => {
  let cart: Cart

  beforeEach(() => {
    cart = new Cart()
  })

  describe('Static Properties', () => {
    test('should have correct START address', () => {
      expect(Cart.START).toBe(0x8000)
    })

    test('should have correct END address', () => {
      expect(Cart.END).toBe(0xFFFF)
    })

    test('should have correct CODE address', () => {
      expect(Cart.CODE).toBe(0xC000)
    })

    test('should have correct SIZE', () => {
      expect(Cart.SIZE).toBe(0x8000)
      expect(Cart.SIZE).toBe(Cart.END - Cart.START + 1)
    })
  })

  describe('Initialization', () => {
    test('should initialize data array with correct size', () => {
      expect(cart.data).toHaveLength(Cart.SIZE)
    })

    test('should initialize all data to 0x00', () => {
      expect(cart.data.every((b) => b === 0x00)).toBe(true)
    })
  })

  describe('read()', () => {
    // read() takes a CPU address and does the `- START` itself, so that Machine
    // can hand either kind of cart the address off the bus unchanged.
    test('reads by CPU address', () => {
      cart.data[0x4000] = 0x42
      expect(cart.read(0xC000)).toBe(0x42)
    })

    test('reads the first and last bytes of the image', () => {
      cart.data[0] = 0xAA
      cart.data[Cart.SIZE - 1] = 0xBB
      expect(cart.read(Cart.START)).toBe(0xAA)
      expect(cart.read(Cart.END)).toBe(0xBB)
    })

    test('reads 0x00 from an untouched address', () => {
      expect(cart.read(0xD000)).toBe(0x00)
    })
  })

  describe('write() and reset()', () => {
    test('a write does nothing — a ROM cart has no WEB', () => {
      cart.data[0x4000] = 0x42
      cart.write(0xC000, 0xFF)
      expect(cart.read(0xC000)).toBe(0x42)
    })

    test('reset does nothing and does not throw', () => {
      cart.data[0x4000] = 0x42
      cart.reset()
      expect(cart.read(0xC000)).toBe(0x42)
    })
  })

  describe('load()', () => {
    test('should load data array with correct size', () => {
      const testData = new Array(Cart.SIZE).fill(0xFF)
      cart.load(testData)

      expect(cart.data).toBe(testData)
      expect(cart.read(Cart.START)).toBe(0xFF)
      expect(cart.read(Cart.END)).toBe(0xFF)
    })

    test.each([Cart.SIZE - 1, Cart.SIZE + 1, 0])(
      'silently drops an image of %d bytes',
      (length) => {
        const originalData = [...cart.data]
        cart.load(new Array(length).fill(0xFF))
        expect(cart.data).toEqual(originalData)
      }
    )

    test('should replace existing data when loading', () => {
      cart.data[0x4000] = 0xAA
      cart.load(new Array(Cart.SIZE).fill(0x55))
      expect(cart.read(0xC000)).toBe(0x55)
    })
  })

  describe('legacy.crt', () => {
    // The fixture fills the cartridge half with the high byte of each byte's own
    // CPU address, so an off-by-one or a swapped half is a wrong byte.
    test('reads back the high byte of its own address', () => {
      cart.load([...fixture('legacy.crt')])
      for (const address of [0xC010, 0xC123, 0xD555, 0xE010, 0xFFF0]) {
        expect(cart.read(address)).toBe(address >> 8)
      }
    })

    test('carries the vectors', () => {
      cart.load([...fixture('legacy.crt')])
      expect(cart.read(0xFFFC) | (cart.read(0xFFFD) << 8)).toBe(0xE000)
    })
  })
})

describe('BankedCart — the §2 mapper, against banked-128K.crt', () => {
  let cart: BankedCart

  beforeEach(() => {
    cart = cartFromImage(fixture('banked-128K.crt')) as BankedCart
  })

  // Every byte of a bank is that bank's own number, so reading the wrong bank
  // is a wrong byte rather than a hang.
  test('selecting bank n and reading the window gives n', () => {
    for (let bank = 0; bank < 15; bank++) {
      setBank(cart, bank)
      expect(cart.read(0xD000)).toBe(bank)
    }
  })

  test('the window covers $C000–$DFFF, and the tags at each end line up', () => {
    setBank(cart, 3)
    const tag = (at: number, length: number): string =>
      String.fromCharCode(...[...Array(length)].map((_, i) => cart.read(at + i)))
    expect(tag(0xC000, 16)).toBe('AC6502 BANK $03\n')
    expect(tag(0xDFF0, 16)).toBe('END OF BANK $03\n')
    expect(cart.read(0xC010)).toBe(3)
    expect(cart.read(0xDFEF)).toBe(3)
  })

  test('$E000–$FFFF ignores the register entirely', () => {
    for (const reg of [0x00, 0x07, 0x0F, 0x3F, 0x80, 0xFF]) {
      setBank(cart, reg)
      expect(cart.read(0xF000)).toBe(0x0F)
    }
  })

  test('the fixed region is the primary chip’s last 8 KB, vectors and all', () => {
    setBank(cart, 0x0A)
    expect(cart.read(0xFFFC) | (cart.read(0xFFFD) << 8)).toBe(0xE000)
    const tag = String.fromCharCode(...[...Array(10)].map((_, i) => cart.read(0xFFF0 + i)))
    expect(tag).toBe('FIXED END\n')
  })

  test('high bank bits alias down — a 010A has no A17/A18', () => {
    setBank(cart, 0x10)
    expect(cart.read(0xD000)).toBe(0x00)
    setBank(cart, 0x2E)
    expect(cart.read(0xD000)).toBe(0x0E)
  })

  test('bit 7 is latched and goes nowhere: 128–255 mirror 0–127', () => {
    setBank(cart, 0x85)
    expect(cart.read(0xD000)).toBe(0x05)
    expect(cart.bank).toBe(0x85) // latched all the same
    setBank(cart, 0x8F)
    expect(cart.read(0xD000)).toBe(0x0F)
    // $FF mirrors $7F, which still has B6 set — so it is open bus, not bank 15.
    setBank(cart, 0xFF)
    expect(cart.read(0xD000)).toBe(0xFF)
  })

  test('selecting the unfitted U2 reads open bus, modelled as $FF', () => {
    setBank(cart, 0x40)
    expect(cart.read(0xC000)).toBe(0xFF)
    expect(cart.read(0xD000)).toBe(0xFF)
    expect(cart.read(0xDFFF)).toBe(0xFF)
    // …but the fixed region is always the primary chip, so it still reads.
    expect(cart.read(0xF000)).toBe(0x0F)
  })

  test('a write to $E000–$FFFF latches the register and reaches no flash', () => {
    const before = crc32hex(cart.image())
    cart.write(0xE000, 0x05)
    expect(cart.bank).toBe(0x05)
    cart.write(0xFFFF, 0x06) // any address in the region, not just $E000
    expect(cart.bank).toBe(0x06)
    // WEB is not asserted there, so this is not also the first unlock cycle.
    cart.write(0xF555, 0xAA)
    cart.write(0xEAAA, 0x55)
    cart.write(0xF555, 0xA0)
    cart.write(0xF000, 0x00)
    expect(crc32hex(cart.image())).toBe(before)
  })

  test('reset clears the register', () => {
    setBank(cart, 0x0C)
    expect(cart.read(0xD000)).toBe(0x0C)
    cart.reset()
    expect(cart.bank).toBe(0)
    expect(cart.read(0xD000)).toBe(0x00)
  })
})

describe('BankedCart — the §2 read table at every size', () => {
  // read($C000+n) = chip*CHIP_SIZE + bank*0x2000 + n, and
  // read($E000+n) = CHIP_SIZE - 0x2000 + n on the primary chip.
  test.each([0x20000, 0x40000, 0x80000, 0x100000])('%d bytes translates correctly', (size) => {
    const image = synthetic(size)
    const cart = cartFromImage(image) as BankedCart
    const chips = size > 0x80000 ? 2 : 1
    const chipSize = size / chips

    for (let reg = 0; reg < 256; reg += 7) {
      setBank(cart, reg)
      const chip = (reg >> 6) & 1
      const bank = reg & cart.bankMask
      for (const offset of [0x0000, 0x0001, 0x1234, 0x1FFF]) {
        const expected =
          chip >= chips ? 0xFF : image[chip * chipSize + bank * BANK_SIZE + offset]
        expect(cart.read(0xC000 + offset)).toBe(expected)
      }
      for (const offset of [0x0000, 0x0AAA, 0x1FFF]) {
        expect(cart.read(0xE000 + offset)).toBe(image[chipSize - BANK_SIZE + offset])
      }
    }
  })

  test('a -1M image is U1 then U2, and both halves are reachable', () => {
    const image = synthetic(0x100000)
    const cart = cartFromImage(image) as BankedCart
    expect(cart.chips).toHaveLength(2)
    setBank(cart, 0x00)
    expect(cart.read(0xC000)).toBe(image[0])
    setBank(cart, 0x40)
    expect(cart.read(0xC000)).toBe(image[0x80000])
    // Bank 63 is the fixed bank on U1 only: U2's last bank is reachable.
    setBank(cart, 0x7F)
    expect(cart.read(0xC000)).toBe(image[0x80000 + 63 * BANK_SIZE])
    // …and the fixed region is U1's last 8 KB whatever the register holds.
    expect(cart.read(0xE000)).toBe(image[0x80000 - BANK_SIZE])
  })
})

describe('Flash — the §3 command set', () => {
  let cart: BankedCart

  beforeEach(() => {
    cart = cartFromImage(new Uint8Array(0x20000).fill(0x00)) as BankedCart
  })

  test('the device ID is derived from the chip size', () => {
    expect(new Flash(0x20000).deviceId).toBe(0xB5) // SST39SF010A
    expect(new Flash(0x40000).deviceId).toBe(0xB6) // SST39SF020A
    expect(new Flash(0x80000).deviceId).toBe(0xB7) // SST39SF040
    expect(() => new Flash(0x8000)).toThrow(RangeError)
  })

  test('software ID entry reports SST and the part, and F0 leaves', () => {
    unlock(cart)
    cart.write(0xD555, 0x90)
    setBank(cart, 0)
    expect(cart.read(0xC000)).toBe(0xBF)
    expect(cart.read(0xC001)).toBe(0xB5)
    cart.write(0xC000, 0xF0)
    expect(cart.read(0xC000)).toBe(0x00)
    expect(cart.read(0xC001)).toBe(0x00)
  })

  test('a bare write outside a sequence is swallowed', () => {
    cart.chips[0]!.data.fill(0xFF)
    setBank(cart, 0)
    cart.write(0xC000, 0x00)
    expect(cart.read(0xC000)).toBe(0xFF)
  })

  test('byte program, at the CPU addresses DESIGN.md’s table gives', () => {
    const chip = cart.chips[0]!
    chip.data.fill(0xFF)
    unlock(cart)
    cart.write(0xD555, 0xA0)
    setBank(cart, 4)
    cart.write(0xC123, 0x5A)
    expect(chip.data[4 * BANK_SIZE + 0x123]).toBe(0x5A)
    // …and nowhere else, in particular not at the unmapped flash $0123.
    expect(chip.data[0x123]).toBe(0xFF)
  })

  test('byte program clears bits only: $FF over $00 stays $00', () => {
    const chip = cart.chips[0]!
    chip.data.fill(0xFF)
    const program = (bank: number, address: number, value: number): void => {
      unlock(cart)
      cart.write(0xD555, 0xA0)
      setBank(cart, bank)
      cart.write(address, value)
    }
    program(0, 0xC010, 0x0F)
    expect(chip.data[0x010]).toBe(0x0F)
    // A bit already at 0 cannot be set again without an erase.
    program(0, 0xC010, 0xFF)
    expect(chip.data[0x010]).toBe(0x0F)
    program(0, 0xC010, 0x03)
    expect(chip.data[0x010]).toBe(0x03)
  })

  test('sector erase covers 4 KB, aligned, and writes $FF', () => {
    const chip = cart.chips[0]!
    unlock(cart)
    cart.write(0xD555, 0x80)
    unlock(cart)
    setBank(cart, 0)
    cart.write(0xC800, 0x30) // flash $0800 — inside sector 0
    expect(chip.data.subarray(0, SECTOR_SIZE).every((b) => b === 0xFF)).toBe(true)
    expect(chip.data[SECTOR_SIZE]).toBe(0x00) // sector 1 untouched
  })

  test('sector erase picks the sector the address falls in', () => {
    const chip = cart.chips[0]!
    unlock(cart)
    cart.write(0xD555, 0x80)
    unlock(cart)
    setBank(cart, 6) // flash $C000
    cart.write(0xD001, 0x30) // flash $D001 — sector 13
    expect(chip.data[13 * SECTOR_SIZE]).toBe(0xFF)
    expect(chip.data[12 * SECTOR_SIZE]).toBe(0x00)
    expect(chip.data[14 * SECTOR_SIZE]).toBe(0x00)
  })

  test('chip erase writes $FF everywhere', () => {
    const chip = cart.chips[0]!
    unlock(cart)
    cart.write(0xD555, 0x80)
    unlock(cart)
    cart.write(0xD555, 0x10)
    expect(chip.data.every((b) => b === 0xFF)).toBe(true)
  })

  test('a broken sequence programs nothing', () => {
    const chip = cart.chips[0]!
    chip.data.fill(0xFF)
    setBank(cart, 2)
    cart.write(0xD555, 0xAA)
    setBank(cart, 1)
    cart.write(0xCAAA, 0x54) // wrong byte
    setBank(cart, 2)
    cart.write(0xD555, 0xA0)
    setBank(cart, 0)
    cart.write(0xC000, 0x00)
    expect(chip.data[0]).toBe(0xFF)
  })

  test('a program whose data is $F0 programs rather than resetting read mode', () => {
    const chip = cart.chips[0]!
    chip.data.fill(0xFF)
    unlock(cart)
    cart.write(0xD555, 0xA0)
    setBank(cart, 0)
    cart.write(0xC020, 0xF0)
    expect(chip.data[0x020]).toBe(0xF0)
  })

  test('each chip has its own state machine — U2 is unlocked by B6', () => {
    const megabyte = cartFromImage(new Uint8Array(0x100000).fill(0xFF)) as BankedCart
    const [u1, u2] = megabyte.chips as [Flash, Flash]
    // The same sequence, with B6 set in every bank value it uses.
    megabyte.write(0xE000, 0x40 | 2)
    megabyte.write(0xD555, 0xAA)
    megabyte.write(0xE000, 0x40 | 1)
    megabyte.write(0xCAAA, 0x55)
    megabyte.write(0xE000, 0x40 | 2)
    megabyte.write(0xD555, 0xA0)
    megabyte.write(0xE000, 0x40 | 0)
    megabyte.write(0xC000, 0x7E)
    expect(u2.data[0]).toBe(0x7E)
    expect(u1.data[0]).toBe(0xFF) // U1 never saw any of it
  })

  test('reset returns a chip mid-sequence to read mode', () => {
    const chip = cart.chips[0]!
    chip.data.fill(0xFF)
    unlock(cart)
    cart.write(0xD555, 0xA0) // a program is pending
    cart.reset()
    setBank(cart, 0)
    cart.write(0xC000, 0x00) // …and is now just a bare write
    expect(chip.data[0]).toBe(0xFF)
  })

  test('dirty sectors are reported from the start of the image', () => {
    const megabyte = cartFromImage(new Uint8Array(0x100000).fill(0xFF)) as BankedCart
    const program = (reg: number, address: number, value: number): void => {
      megabyte.write(0xE000, (reg & 0x40) | 2)
      megabyte.write(0xD555, 0xAA)
      megabyte.write(0xE000, (reg & 0x40) | 1)
      megabyte.write(0xCAAA, 0x55)
      megabyte.write(0xE000, (reg & 0x40) | 2)
      megabyte.write(0xD555, 0xA0)
      megabyte.write(0xE000, reg)
      megabyte.write(address, value)
    }
    program(0x00, 0xC000, 0x00) // U1 sector 0
    program(0x40, 0xC000, 0x00) // U2 sector 0 — index 128 across the image
    expect(megabyte.dirtySectors()).toEqual([0, 128])
  })
})

describe('Flash — the busy window', () => {
  let cart: BankedCart
  let chip: Flash

  const program = (cycle: number, address: number, value: number): void => {
    unlock(cart, cycle)
    cart.write(0xD555, 0xA0, cycle)
    setBank(cart, 0)
    cart.write(address, value, cycle)
  }

  beforeEach(() => {
    cart = cartFromImage(new Uint8Array(0x20000).fill(0xFF)) as BankedCart
    chip = cart.chips[0]!
  })

  test('no cycle count means instant completion', () => {
    program(Infinity, 0xC000, 0x3C)
    expect(cart.read(0xC000)).toBe(0x3C)
  })

  test('a read during the window returns status, not data', () => {
    program(1000, 0xC000, 0x3C)
    // DQ7 is the complement of the written value's DQ7; DQ5 is clear.
    expect(cart.read(0xC000, 1000) & 0x80).toBe(0x80) // ~$3C bit 7 = 1
    expect(cart.read(0xC000, 1000) & 0x20).toBe(0x00)
    // 20 µs at 1 MHz.
    expect(cart.read(0xC000, 1019) & 0x80).toBe(0x80)
    expect(cart.read(0xC000, 1020)).toBe(0x3C)
  })

  test('the busy chip answers the fixed region too — the trap', () => {
    // This is why DESIGN.md requires a self-programming routine to run from RAM
    // with interrupts off: the vectors come from the chip that is busy.
    program(1000, 0xC000, 0x00)
    expect(cart.read(0xFFFC, 1005)).not.toBe(0xFF)
    expect(cart.read(0xFFFC, 2000)).toBe(0xFF)
  })

  test('U1 stays readable while U2 is busy', () => {
    const megabyte = cartFromImage(new Uint8Array(0x100000).fill(0xFF)) as BankedCart
    megabyte.write(0xE000, 0x42)
    megabyte.write(0xD555, 0xAA, 500)
    megabyte.write(0xE000, 0x41)
    megabyte.write(0xCAAA, 0x55, 500)
    megabyte.write(0xE000, 0x42)
    megabyte.write(0xD555, 0xA0, 500)
    megabyte.write(0xE000, 0x40)
    megabyte.write(0xC000, 0x00, 500)
    expect(megabyte.read(0xE000, 505)).toBe(0xFF) // U1, not busy
    expect(megabyte.read(0xC000, 505)).not.toBe(0x00) // U2, still status
  })

  test('DQ6 toggles on every read while busy, and settles afterwards', () => {
    program(1000, 0xC000, 0x00)
    const a = cart.read(0xC000, 1005) & 0x40
    const b = cart.read(0xC000, 1005) & 0x40
    const c = cart.read(0xC000, 1005) & 0x40
    expect(a).not.toBe(b)
    expect(b).not.toBe(c)
    expect(cart.read(0xC000, 2000) & 0x40).toBe(cart.read(0xC000, 2000) & 0x40)
  })

  test('a DQ7 data-poll terminates', () => {
    program(1000, 0xC000, 0x3C)
    let cycle = 1000
    let reads = 0
    while ((cart.read(0xC000, cycle) & 0x80) !== (0x3C & 0x80)) {
      cycle += 2
      if (++reads > 1000) throw new Error('data-poll did not terminate')
    }
    expect(reads).toBeGreaterThan(0)
    expect(cycle).toBeGreaterThanOrEqual(1020)
  })

  test('a DQ6 toggle-loop terminates', () => {
    program(1000, 0xC000, 0x3C)
    let cycle = 1000
    let reads = 0
    while ((cart.read(0xC000, cycle) & 0x40) !== (cart.read(0xC000, cycle) & 0x40)) {
      cycle += 2
      if (++reads > 1000) throw new Error('toggle-loop did not terminate')
    }
    expect(cycle).toBeGreaterThanOrEqual(1020)
  })

  test('sector erase is 25 ms, with DQ7 clear', () => {
    unlock(cart, 100)
    cart.write(0xD555, 0x80, 100)
    unlock(cart, 100)
    setBank(cart, 0)
    cart.write(0xC000, 0x30, 100)
    expect(cart.read(0xC000, 100) & 0x80).toBe(0x00)
    expect(chip.busy(100 + 24_999)).toBe(true)
    expect(chip.busy(100 + 25_000)).toBe(false)
  })

  test('chip erase is 100 ms', () => {
    unlock(cart, 100)
    cart.write(0xD555, 0x80, 100)
    unlock(cart, 100)
    cart.write(0xD555, 0x10, 100)
    expect(cart.read(0xC000, 100) & 0x80).toBe(0x00)
    expect(chip.busy(100 + 99_999)).toBe(true)
    expect(chip.busy(100 + 100_000)).toBe(false)
  })
})
