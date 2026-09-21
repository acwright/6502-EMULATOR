import { readFileSync } from 'fs'
import { join } from 'path'
import { BankedCart, SECTOR_SIZE, cartFromImage } from '../core/Cart'
import {
  SAVE_HEADER_SIZE,
  SAVE_RECORD_SIZE,
  SaveFormatError,
  SaveMismatchError,
  applySave,
  applySaveToCart,
  crc32hex,
  decodeSave,
  diffSectors,
  encodeSave,
  overlayFor,
  saveFor
} from '../core/CartSave'

// The shared oracle again; see fixtures/cart/README.md. `sample.sav` is the
// container 6502-VCS's host tool wrote, and the only proof that this reader and
// that writer agree.
const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'cart', name)))

const image = (): Uint8Array => fixture('banked-128K.crt')

const setBank = (cart: BankedCart, reg: number): void => cart.write(0xE000, reg)

/**
 * Program one byte through the JEDEC sequence, in the bank that is selected.
 *
 * The unlock writes keep the register's chip bit, because the two chips of a
 * `-1M` cart each have their own state machine: a sequence issued at a bank on
 * U1 unlocks U1, whatever the write that follows it is aimed at.
 */
const programByte = (cart: BankedCart, address: number, value: number): void => {
  const bank = cart.bank
  const chip = bank & 0x40
  setBank(cart, chip | 2); cart.write(0xD555, 0xAA)
  setBank(cart, chip | 1); cart.write(0xCAAA, 0x55)
  setBank(cart, chip | 2); cart.write(0xD555, 0xA0)
  setBank(cart, bank); cart.write(address, value)
}

describe('the .sav container', () => {

  // 6502-VCS PLAN.md §4 states this header byte for byte, because four
  // implementations have to agree on it without talking to each other.
  test('lays its header out as the plan does', () => {
    const img = image()
    const sav = encodeSave(img, [[3, new Uint8Array(SECTOR_SIZE).fill(0xA5)]])
    const dv = new DataView(sav.buffer, sav.byteOffset, sav.byteLength)

    expect([...sav.subarray(0, 4)]).toEqual([0x41, 0x43, 0x53, 0x56]) // 'ACSV'
    expect(sav[4]).toBe(1) // version
    expect(sav[5]).toBe(0) // reserved
    expect(dv.getUint16(6, true)).toBe(1)
    expect(dv.getUint32(8, true)).toBe(0x20000)
    expect(dv.getUint32(12, true)).toBe(parseInt('e0e4f83c', 16))
    expect(dv.getUint32(SAVE_HEADER_SIZE, true)).toBe(3)
    expect(sav.length).toBe(SAVE_HEADER_SIZE + SAVE_RECORD_SIZE)
  })

  test('reads the fixture 6502-VCS wrote', () => {
    const save = decodeSave(fixture('sample.sav'))
    expect(save.version).toBe(1)
    expect(save.imageSize).toBe(0x20000)
    expect(crc32hex(image())).toBe(save.imageCrc.toString(16).padStart(8, '0'))
    // Sectors 0, 28 and 29 — deliberately non-contiguous, so a reader that
    // assumed a run would fail here rather than in six months.
    expect([...save.sectors.keys()]).toEqual([0, 28, 29])
  })

  test('writes records ascending whatever order they arrive in', () => {
    const img = image()
    const sector = (fill: number): Uint8Array => new Uint8Array(SECTOR_SIZE).fill(fill)
    const sav = encodeSave(img, [[29, sector(2)], [0, sector(1)], [28, sector(3)]])
    expect([...decodeSave(sav).sectors.keys()]).toEqual([0, 28, 29])
  })

  test('round-trips every sector byte for byte', () => {
    const img = image()
    const sectors = new Map([
      [0, Uint8Array.from({ length: SECTOR_SIZE }, (_, i) => i & 0xFF)],
      [31, Uint8Array.from({ length: SECTOR_SIZE }, (_, i) => ~i & 0xFF)]
    ])
    const back = decodeSave(encodeSave(img, sectors))
    expect(back.sectors.get(0)).toEqual(sectors.get(0))
    expect(back.sectors.get(31)).toEqual(sectors.get(31))
  })

  test('refuses a sector that is not 4 KB, or lies outside the image', () => {
    const img = image()
    expect(() => encodeSave(img, [[0, new Uint8Array(512)]])).toThrow(RangeError)
    expect(() => encodeSave(img, [[32, new Uint8Array(SECTOR_SIZE)]])).toThrow(RangeError)
  })

  describe('rejects a file that is not one', () => {
    const good = (): Uint8Array => encodeSave(image(), [[0, new Uint8Array(SECTOR_SIZE)]])

    test('too short for a header', () => {
      expect(() => decodeSave(new Uint8Array(8))).toThrow(SaveFormatError)
    })
    test('bad magic', () => {
      const sav = good(); sav[0] = 0x42
      expect(() => decodeSave(sav)).toThrow(/bad magic/)
    })
    test('a version this build does not know', () => {
      const sav = good(); sav[4] = 2
      expect(() => decodeSave(sav)).toThrow(/version 2/)
    })
    test('a count the length does not support', () => {
      const sav = good()
      new DataView(sav.buffer).setUint16(6, 2, true)
      expect(() => decodeSave(sav)).toThrow(/expected .* for 2 sectors/)
    })
    test('records out of order', () => {
      const sav = encodeSave(image(), [
        [0, new Uint8Array(SECTOR_SIZE)],
        [1, new Uint8Array(SECTOR_SIZE)]
      ])
      const dv = new DataView(sav.buffer)
      dv.setUint32(SAVE_HEADER_SIZE, 5, true)
      dv.setUint32(SAVE_HEADER_SIZE + SAVE_RECORD_SIZE, 5, true)
      expect(() => decodeSave(sav)).toThrow(/ascending/)
    })
  })

  // The whole reason the header carries a size and a CRC.
  describe('refuses a save that belongs to another cart', () => {
    test('a different size', () => {
      const sav = encodeSave(image(), [[0, new Uint8Array(SECTOR_SIZE).fill(1)]])
      expect(() => applySave(fixture('legacy-512K.crt'), sav)).toThrow(SaveMismatchError)
      expect(() => applySave(fixture('legacy-512K.crt'), sav)).toThrow(/131,072-byte cartridge/)
    })

    test('a different build of the same size', () => {
      const sav = encodeSave(image(), [[0, new Uint8Array(SECTOR_SIZE).fill(1)]])
      const rebuilt = image()
      rebuilt[0x100] ^= 0xFF // one byte, as a rebuild would move
      expect(() => applySave(rebuilt, sav)).toThrow(/a different build of this cart/)
    })

    test('and says which two checksums disagree', () => {
      const sav = encodeSave(image(), [[0, new Uint8Array(SECTOR_SIZE).fill(1)]])
      const rebuilt = image()
      rebuilt[0x100] ^= 0xFF
      expect(() => applySave(rebuilt, sav)).toThrow(
        new RegExp(`save e0e4f83c, image ${crc32hex(rebuilt)}`)
      )
    })
  })

  test('applies over a copy, never over the image it was given', () => {
    const img = image()
    const sav = encodeSave(img, [[0, new Uint8Array(SECTOR_SIZE).fill(0x5A)]])
    const out = applySave(img, sav)
    expect(out[0]).toBe(0x5A)
    expect(img[0]).toBe(image()[0]) // the `.crt`'s bytes are untouched
  })

  test('diffSectors finds exactly the sectors that moved', () => {
    const a = image()
    const b = image()
    b[0] ^= 0xFF
    b[29 * SECTOR_SIZE + 5] ^= 0xFF
    expect([...diffSectors(a, b).keys()]).toEqual([0, 29])
    expect(diffSectors(a, a).size).toBe(0)
    expect(() => diffSectors(a, fixture('legacy.crt'))).toThrow(RangeError)
  })

})

describe('a cart and its overlay', () => {

  test('a cart that never programmed anything has no save', () => {
    const img = image()
    const cart = cartFromImage(img) as BankedCart
    expect(overlayFor(img, cart).size).toBe(0)
    expect(saveFor(img, cart)).toBeNull()
  })

  test('a 32K ROM cart has no save, ever', () => {
    const img = fixture('legacy.crt')
    const cart = cartFromImage(img)!
    expect(saveFor(img, cart)).toBeNull()
  })

  test('records the sector a program touched, and only that one', () => {
    const img = image()
    const cart = cartFromImage(img) as BankedCart
    setBank(cart, 14) // where the 6502-CRT template keeps its saves
    programByte(cart, 0xC000, 0x00)

    const sectors = overlayFor(img, cart)
    expect([...sectors.keys()]).toEqual([28]) // bank 14 starts at 0x1C000
    expect(sectors.get(28)![0]).toBe(0x00)
  })

  // A program clears bits only, so writing $FF back is not an undo; an erase
  // is. Either way what matters is that the overlay reports the difference from
  // the `.crt` rather than the fact that something was written.
  test('a sector erased back to what the .crt holds drops out of the overlay', () => {
    const img = image()
    const cart = cartFromImage(img) as BankedCart
    setBank(cart, 14)
    programByte(cart, 0xC000, 0x00)
    expect(overlayFor(img, cart).size).toBe(1)

    // Put the byte back by hand; the sector is still dirty, but no longer differs.
    cart.sector(28)[0] = img[28 * SECTOR_SIZE]!
    expect(overlayFor(img, cart).size).toBe(0)
    expect(saveFor(img, cart)).toBeNull()
  })

  test('a sector erase is recorded whole', () => {
    const img = image()
    const cart = cartFromImage(img) as BankedCart
    setBank(cart, 2); cart.write(0xD555, 0xAA)
    setBank(cart, 1); cart.write(0xCAAA, 0x55)
    setBank(cart, 2); cart.write(0xD555, 0x80)
    setBank(cart, 2); cart.write(0xD555, 0xAA)
    setBank(cart, 1); cart.write(0xCAAA, 0x55)
    setBank(cart, 14); cart.write(0xC000, 0x30) // sector erase, flash $1C000

    const sectors = overlayFor(img, cart)
    expect([...sectors.keys()]).toEqual([28])
    expect(sectors.get(28)!.every((b) => b === 0xFF)).toBe(true)
  })

  // The round trip the CLI and the desktop both make: program, eject, reload,
  // read it back.
  test('a save written on eject comes back on the next load', () => {
    const img = image()
    const first = cartFromImage(img) as BankedCart
    setBank(first, 14)
    // A program clears bits only, so the value has to be one the byte already
    // there can reach: bank 14 is full of $0E, and $0E & $0A is $0A.
    programByte(first, 0xC123, 0x0A)
    const sav = saveFor(img, first)!

    const second = cartFromImage(image()) as BankedCart
    applySaveToCart(image(), second, sav)
    setBank(second, 14)
    expect(second.read(0xC123)).toBe(0x0A)
  })

  /**
   * The failure this guards is silent: a restored sector that is not marked
   * dirty is dropped from the next `.sav`, so a save survives one quit and
   * vanishes on the second.
   */
  test('a restored save is still in the overlay when nothing writes to it again', () => {
    const img = image()
    const first = cartFromImage(img) as BankedCart
    setBank(first, 14)
    programByte(first, 0xC123, 0x0A)
    const sav = saveFor(img, first)!

    const second = cartFromImage(image()) as BankedCart
    applySaveToCart(image(), second, sav)
    const again = saveFor(image(), second)
    expect(again).not.toBeNull()
    expect(again).toEqual(sav)
  })

  test('the fixture save restores into the fixture cart', () => {
    const img = image()
    const cart = cartFromImage(img) as BankedCart
    applySaveToCart(img, cart, fixture('sample.sav'))
    const save = decodeSave(fixture('sample.sav'))
    // Sector 28 is the start of bank 14.
    setBank(cart, 14)
    expect(cart.read(0xC000)).toBe(save.sectors.get(28)![0])
  })

  test('a save for another build never reaches the cart', () => {
    const rebuilt = image()
    rebuilt[0x100] ^= 0xFF
    const cart = cartFromImage(rebuilt) as BankedCart
    expect(() => applySaveToCart(rebuilt, cart, fixture('sample.sav')))
      .toThrow(SaveMismatchError)
    // Refused whole: nothing was half-applied.
    expect(cart.dirtySectors()).toEqual([])
  })

  test('a save never reaches a 32K ROM cart', () => {
    const img = fixture('legacy.crt')
    const cart = cartFromImage(img)!
    const sav = encodeSave(img, [[0, new Uint8Array(SECTOR_SIZE).fill(1)]])
    expect(() => applySaveToCart(img, cart, sav)).toThrow(SaveMismatchError)
  })

  test('U2 of a -1M cart starts at sector 128', () => {
    const img = new Uint8Array(0x100000).fill(0xFF)
    const cart = cartFromImage(img) as BankedCart
    // Bank 64 is U2's bank 0 (§1 rule 4).
    setBank(cart, 64)
    programByte(cart, 0xC000, 0x7E)
    expect([...overlayFor(img, cart).keys()]).toEqual([128])
  })

})
