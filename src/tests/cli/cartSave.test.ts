import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageError, resolveCartSave } from '../../cli/args'
import { runCommand } from '../../cli/run'
import { SECTOR_SIZE, cartFromImage } from '../../core/Cart'
import type { BankedCart } from '../../core/Cart'
import { decodeSave, defaultCartSavePath, encodeSave } from '../../core/CartSave'
import {
  FIRST_SECTOR,
  FIRST_VALUE,
  SECOND_SECTOR,
  SECOND_VALUE,
  selfProgrammingCart
} from '../support/selfProgrammingCart'

/**
 * 6502-VCS `PLAN.md` §4 through the CLI: a cartridge programs its own flash,
 * the writes land in a `.sav` beside the image, and **the `.crt` is never
 * touched**.
 *
 * The cart is `src/tests/support/selfProgrammingCart.ts`, which runs its
 * programming routine from RAM and behaves differently on a run that found a
 * save — see that file for why both of those matter.
 */

jest.setTimeout(60_000)

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), '6502-cart-save-'))
})

/** Run the command with its terminal output swallowed, and return stderr. */
async function run(argv: string[]): Promise<{ code: number; stderr: string }> {
  let stderr = ''
  const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const err = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
  try {
    return { code: await runCommand(argv), stderr }
  } finally {
    out.mockRestore()
    err.mockRestore()
  }
}

/** A fresh copy of the self-programming cart, under its own name. */
function plant(name: string): string {
  const path = join(dir, `${name}-128K.crt`)
  writeFileSync(path, selfProgrammingCart())
  return path
}

const args = (cart: string, ...rest: string[]): string[] => [
  '--headless',
  '--quiet',
  '--rtc',
  '2026-01-01T00:00:00',
  '--max-cycles',
  '200000',
  '--cart',
  cart,
  ...rest
]

describe('defaultCartSavePath', () => {
  it('puts the .sav beside the .crt, under the same stem', () => {
    expect(defaultCartSavePath('/games/Cart-512K.crt')).toBe('/games/Cart-512K.sav')
    expect(defaultCartSavePath('Cart.crt')).toBe('Cart.sav')
  })

  it('does not mistake a dot in a directory for an extension', () => {
    expect(defaultCartSavePath('/build.d/game')).toBe('/build.d/game.sav')
  })
})

describe('resolveCartSave', () => {
  const flash = 0x20000

  it('defaults to the sidecar for a flash cart', () => {
    expect(resolveCartSave({}, '/g/Cart-128K.crt', flash)).toBe('/g/Cart-128K.sav')
  })

  it('leaves a 32K ROM cart alone — it has no flash to write', () => {
    expect(resolveCartSave({}, '/g/Cart.crt', 0x8000)).toBeUndefined()
  })

  it('takes a path of its own', () => {
    expect(resolveCartSave({ 'cart-save': '/tmp/x.sav' }, '/g/Cart-128K.crt', flash))
      .toBe('/tmp/x.sav')
  })

  it('discards the writes when asked to', () => {
    expect(resolveCartSave({ 'no-cart-save': true }, '/g/Cart-128K.crt', flash)).toBeUndefined()
  })

  it('refuses the two flags together', () => {
    expect(() => resolveCartSave({ 'cart-save': 'x', 'no-cart-save': true }, '/g/c.crt', flash))
      .toThrow(/say opposite things/)
  })

  it('refuses either flag without a cartridge', () => {
    expect(() => resolveCartSave({ 'cart-save': 'x' }, undefined, undefined))
      .toThrow(/there is no --cart to save/)
    expect(() => resolveCartSave({ 'no-cart-save': true }, undefined, undefined))
      .toThrow(UsageError)
  })

  it('refuses either flag on a cart with no flash in it', () => {
    expect(() => resolveCartSave({ 'cart-save': 'x' }, '/g/Cart.crt', 0x8000))
      .toThrow(/a 32K ROM cart has no flash to write/)
  })
})

describe('run --cart, writing flash', () => {

  /**
   * The gate E2 is judged on: program a byte, quit, reload, read it back — and
   * the `.crt` has not moved.
   */
  it('keeps a flash write across two runs, in a .sav and never in the .crt', async () => {
    const cart = plant('Round')
    const sav = defaultCartSavePath(cart)
    const before = readFileSync(cart)
    // A timestamp far enough in the past that any write at all moves it.
    utimesSync(cart, new Date(2020, 0, 1), new Date(2020, 0, 1))
    const mtime = statSync(cart).mtimeMs

    const first = await run(args(cart))
    expect(first.code).toBe(0)
    expect(existsSync(sav)).toBe(true)

    // One sector: the cart found no save and programmed its first byte.
    const one = decodeSave(readFileSync(sav))
    expect([...one.sectors.keys()]).toEqual([FIRST_SECTOR])
    expect(one.sectors.get(FIRST_SECTOR)![0]).toBe(FIRST_VALUE)

    // The cart's second run takes a different branch, which it can only reach
    // by reading back what the first run programmed.
    const second = await run(args(cart))
    expect(second.code).toBe(0)
    const two = decodeSave(readFileSync(sav))
    expect([...two.sectors.keys()]).toEqual([SECOND_SECTOR, FIRST_SECTOR])
    expect(two.sectors.get(SECOND_SECTOR)![0]).toBe(SECOND_VALUE)

    // §4's whole point. Not the bytes, not the timestamp.
    expect(readFileSync(cart).equals(before)).toBe(true)
    expect(statSync(cart).mtimeMs).toBe(mtime)
  })

  it('says where the saves went, and where they came from', async () => {
    const cart = plant('Chatty')
    const loud = (...rest: string[]): string[] =>
      args(cart, ...rest).filter((a) => a !== '--quiet')

    const first = await run(loud())
    expect(first.stderr).toMatch(/wrote 1 flash sector to .*Chatty-128K\.sav/)

    const second = await run(loud())
    expect(second.stderr).toMatch(/flash saves from .*Chatty-128K\.sav/)
    expect(second.stderr).toMatch(/wrote 2 flash sectors to/)
  })

  it('writes nothing at all when the cartridge never programmed anything', async () => {
    const cart = join(dir, 'Inert-128K.crt')
    // Bank fill and a reset vector into a bank that is nothing but $0B — the
    // CPU wanders, and never runs a JEDEC sequence.
    const image = new Uint8Array(0x20000).fill(0x0B)
    image[0x1FFFC] = 0x00
    image[0x1FFFD] = 0xE0
    writeFileSync(cart, image)

    expect((await run(args(cart))).code).toBe(0)
    expect(existsSync(defaultCartSavePath(cart))).toBe(false)
  })

  it('--no-cart-save throws the writes away', async () => {
    const cart = plant('Discard')
    expect((await run(args(cart, '--no-cart-save'))).code).toBe(0)
    expect(existsSync(defaultCartSavePath(cart))).toBe(false)
  })

  it('--cart-save puts them somewhere else entirely', async () => {
    const cart = plant('Elsewhere')
    const sav = join(dir, 'somewhere', '..', 'elsewhere.sav')
    expect((await run(args(cart, '--cart-save', sav))).code).toBe(0)
    expect(existsSync(defaultCartSavePath(cart))).toBe(false)
    expect(decodeSave(readFileSync(sav)).sectors.size).toBe(1)
  })

  /**
   * A rebuilt cartridge is the ordinary way a save goes stale, and the CRC in
   * the header is what catches it. The cart starts anyway, and — this is the
   * part worth a test — the file is left exactly where it was.
   */
  it('refuses a save from another build, starts anyway, and leaves the file alone', async () => {
    const cart = plant('Rebuilt')
    const sav = defaultCartSavePath(cart)

    // A save against a cart that is one byte different from this one.
    const other = selfProgrammingCart()
    other[0x100] ^= 0xFF
    const stale = encodeSave(other, [[FIRST_SECTOR, new Uint8Array(SECTOR_SIZE).fill(0x55)]])
    writeFileSync(sav, stale)

    const { code, stderr } = await run(args(cart).filter((a) => a !== '--quiet'))
    expect(code).toBe(0)
    expect(stderr).toMatch(/a different build of this cart/)
    expect(stderr).toMatch(/starting without it/)

    // It ran as a first run would — the stale sector never reached the cart —
    // and the save it wrote is this build's.
    const written = decodeSave(readFileSync(sav))
    expect(written.imageCrc).not.toBe(stale.slice(12, 16).reduce((a, b, i) => a + (b << (8 * i)), 0))
    expect(written.sectors.get(FIRST_SECTOR)![0]).toBe(FIRST_VALUE)
  })

  it('reports a .sav that is not one, and still runs', async () => {
    const cart = plant('Garbage')
    writeFileSync(defaultCartSavePath(cart), Buffer.from('not a save file at all'))

    const { code, stderr } = await run(args(cart).filter((a) => a !== '--quiet'))
    expect(code).toBe(0)
    expect(stderr).toMatch(/--cart-save: .*(bad magic|too short)/)
  })

  it('a 32K ROM cart still behaves exactly as it did', async () => {
    const cart = join(dir, 'Legacy.crt')
    writeFileSync(cart, readFileSync(join(__dirname, '..', 'fixtures', 'cart', 'legacy.crt')))
    expect((await run(args(cart))).code).toBe(0)
    expect(existsSync(defaultCartSavePath(cart))).toBe(false)
  })

})

describe('the overlay the CLI wrote', () => {
  it('restores into a cart loaded from the .crt', async () => {
    const cart = plant('Restore')
    await run(args(cart))

    const image = new Uint8Array(readFileSync(cart))
    const loaded = cartFromImage(image) as BankedCart
    const save = decodeSave(readFileSync(defaultCartSavePath(cart)))
    for (const [index, bytes] of save.sectors) loaded.loadSector(index, bytes)

    loaded.write(0xE000, 14) // select bank 14
    expect(loaded.read(0xC000)).toBe(FIRST_VALUE)
  })
})
