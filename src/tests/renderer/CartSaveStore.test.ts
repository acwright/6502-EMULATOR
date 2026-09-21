import { createPinia, setActivePinia } from 'pinia'
import { BankedCart, SECTOR_SIZE } from '../../core/Cart'
import { decodeSave, encodeSave } from '../../core/CartSave'
import type { CartSaveTarget } from '../../renderer/src/services/types'
import {
  FIRST_SECTOR,
  FIRST_VALUE,
  selfProgrammingCart
} from '../support/selfProgrammingCart'

/**
 * The renderer's end of 6502-VCS `PLAN.md` §4: a cartridge goes in with
 * whatever it had programmed last time, and what it programs this time comes
 * back out on eject, on the next cartridge, and on quit.
 *
 * The service is stubbed because where the bytes go is the *other* half of the
 * story — a file beside the `.crt` in the app, a key in IndexedDB on the web —
 * and neither of those exists under Jest. What is tested here is the part both
 * share: what the store hands over, and when.
 */

const mockSaved: { target: CartSaveTarget; data: Uint8Array }[] = []
let mockStored: Uint8Array | null = null
let mockFail = false

jest.mock('@/services/cartSaves', () => ({
  createCartSaveService: () => ({
    load: async () => mockStored,
    save: async (target: CartSaveTarget, data: Uint8Array) => {
      if (mockFail) throw new Error('the disk is full')
      mockSaved.push({ target, data })
    }
  })
}))

// The bundled BIOS is fetched with `import.meta.env`, which does not survive
// the CommonJS transform this suite is compiled with. Nothing here boots a
// BIOS: a cartridge brings its own vectors.
jest.mock('@/composables/useDefaultBIOS', () => ({
  loadDefaultBIOS: async () => null,
  DEFAULT_ROM_LABEL: 'BIOS'
}))

import { useEmulatorStore } from '@/stores/emulator'

/** Run the cart until it halts on its STP, which is a few thousand cycles. */
function runToHalt(store: ReturnType<typeof useEmulatorStore>): void {
  store.machine!.runCycles(20_000)
}

function makeStore(): ReturnType<typeof useEmulatorStore> {
  setActivePinia(createPinia())
  const store = useEmulatorStore()
  // A small CF card: this is about cartridges, and the real 256 MB is half a
  // second of allocation per test.
  store.init({ cfSize: 512 * 1024 })
  return store
}

beforeEach(() => {
  mockSaved.length = 0
  mockStored = null
  mockFail = false
})

describe('inserting a flash cart', () => {

  it('keys its overlay by the image, and asks for what is already there', async () => {
    const store = makeStore()
    await store.insertCart(selfProgrammingCart(), 'Game-128K.crt')

    expect(store.cartName).toBe('Game-128K.crt')
    // e0e4f83c is the oracle fixture's; this cart is a different image, so all
    // that matters is that the key is the checksum of what went in.
    expect(store.cartSaveTarget).toEqual({ kind: 'db', crc: expect.stringMatching(/^[0-9a-f]{8}$/) })
  })

  it('gives a 32K ROM cart no overlay at all — it has no flash', async () => {
    const store = makeStore()
    await store.insertCart(new Uint8Array(0x8000), 'Rom.crt')
    expect(store.cartSaveTarget).toBeNull()
  })

  it('refuses a size that is not one of the five, and loads nothing', async () => {
    const store = makeStore()
    await store.insertCart(selfProgrammingCart(), 'Game-128K.crt')
    await store.insertCart(new Uint8Array(4096), 'Odd.crt')

    expect(store.loadWarning).toMatch(/must be 32,768, 131,072, 262,144, 524,288, 1,048,576/)
    expect(store.loadWarning).toMatch(/Nothing loaded/)
    expect(store.cartName).toBe('Game-128K.crt') // the one that was in stayed in
  })

  it('takes all five sizes', async () => {
    for (const size of [0x8000, 0x20000, 0x40000, 0x80000, 0x100000]) {
      const store = makeStore()
      await store.insertCart(new Uint8Array(size), `Cart-${size}.crt`)
      expect(store.loadWarning).toBeNull()
      expect(store.cartName).toBe(`Cart-${size}.crt`)
    }
  })

  it('lays a stored overlay over the image as the cart goes in', async () => {
    const image = selfProgrammingCart()
    const sector = new Uint8Array(SECTOR_SIZE).fill(0x00)
    mockStored = encodeSave(image, [[FIRST_SECTOR, sector]])

    const store = makeStore()
    await store.insertCart(image, 'Game-128K.crt')

    expect(store.loadWarning).toBeNull()
    const cart = store.machine!.cart as BankedCart
    cart.write(0xE000, 14) // bank 14 is FIRST_SECTOR
    expect(cart.read(0xC000)).toBe(0x00)
  })

  /**
   * Rebuilding a cartridge is the ordinary way a save goes stale. The message
   * goes where a bad image size's message goes, the cart starts anyway, and the
   * save itself is not touched.
   */
  it('reports a save from another build and starts without it', async () => {
    const other = selfProgrammingCart()
    other[0x100] ^= 0xFF
    mockStored = encodeSave(other, [[FIRST_SECTOR, new Uint8Array(SECTOR_SIZE).fill(0x00)]])

    const store = makeStore()
    await store.insertCart(selfProgrammingCart(), 'Game-128K.crt')

    expect(store.loadWarning).toMatch(/a different build of this cart/)
    expect(store.loadWarning).toMatch(/the save file was not changed/)
    expect(store.cartName).toBe('Game-128K.crt')
    expect(mockSaved).toEqual([]) // and nothing was written over it
  })

  it('reports a save file that is not one, and still starts', async () => {
    mockStored = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    const store = makeStore()
    await store.insertCart(selfProgrammingCart(), 'Game-128K.crt')
    expect(store.loadWarning).toMatch(/could not be read/)
    expect(store.cartName).toBe('Game-128K.crt')
  })

})

describe('flushing a flash cart', () => {

  it('writes what the cartridge programmed, and nothing when it programmed nothing', async () => {
    const store = makeStore()
    await store.insertCart(selfProgrammingCart(), 'Game-128K.crt')

    await store.flushCartSave()
    expect(mockSaved).toEqual([]) // it has not run yet

    runToHalt(store)
    await store.flushCartSave()
    expect(mockSaved).toHaveLength(1)
    const save = decodeSave(mockSaved[0]!.data)
    expect([...save.sectors.keys()]).toEqual([FIRST_SECTOR])
    expect(save.sectors.get(FIRST_SECTOR)![0]).toBe(FIRST_VALUE)
  })

  /**
   * This runs on the thirty-second autosave as well as on eject, and a cart
   * writes its saves at a checkpoint rather than continuously — so most ticks
   * have nothing new in them and should cost nothing.
   */
  it('does not write the same overlay twice', async () => {
    const store = makeStore()
    await store.insertCart(selfProgrammingCart(), 'Game-128K.crt')
    runToHalt(store)

    await store.flushCartSave()
    await store.flushCartSave()
    await store.flushCartSave()
    expect(mockSaved).toHaveLength(1)
  })

  it('ejecting writes the overlay, then forgets the cart', async () => {
    const store = makeStore()
    await store.insertCart(selfProgrammingCart(), 'Game-128K.crt')
    runToHalt(store)

    store.unloadCart()
    await Promise.resolve() // the write is started synchronously, awaited here
    expect(mockSaved).toHaveLength(1)
    expect(store.cartName).toBeNull()
    expect(store.cartSaveTarget).toBeNull()
    expect(store.cartImage).toBeNull()
  })

  it('inserting another cartridge saves the one coming out', async () => {
    const store = makeStore()
    await store.insertCart(selfProgrammingCart(), 'First-128K.crt')
    runToHalt(store)

    await store.insertCart(new Uint8Array(0x20000).fill(0xFF), 'Second-128K.crt')
    expect(mockSaved).toHaveLength(1)
    expect(decodeSave(mockSaved[0]!.data).sectors.has(FIRST_SECTOR)).toBe(true)
  })

  it('says so when the overlay could not be written', async () => {
    const store = makeStore()
    await store.insertCart(selfProgrammingCart(), 'Game-128K.crt')
    runToHalt(store)

    mockFail = true
    await store.flushCartSave()
    expect(store.loadWarning).toMatch(/save could not be written: the disk is full/)
  })

  it('has nothing to flush with no cartridge in the slot', async () => {
    const store = makeStore()
    await expect(store.flushCartSave()).resolves.toBeUndefined()
    expect(mockSaved).toEqual([])
  })

})
