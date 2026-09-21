/**
 * The `.sav` sidecar: flash writes that must never reach a chip by accident.
 *
 * **6502-VCS `PLAN.md` §4** is the normative copy and specifies this container
 * byte for byte, because the Flash Helper's host tool, this emulator, the
 * PicoCalc port and the DB Emulator all read and write it. The reference
 * implementation is `Firmware/FH Programmer/host/src/sav.js`; `sample.sav` in
 * `src/tests/fixtures/cart/` is the shared oracle.
 *
 * The requirement, stated plainly: a save written while testing must not be
 * able to end up on a real chip. The mechanism is that it lives beside the
 * image rather than in it — **no host in this repository opens a `.crt` for
 * writing, ever** — and the enforcement is that `6502-flash program` has no
 * flag to include one.
 *
 * Records are 4 KB because that is the SST39SF0x0's erase unit, so the
 * container's granularity is the chip's granularity.
 *
 * ```
 * offset  size  field
 *   0      4    magic      'A' 'C' 'S' 'V'  (41 43 53 56)
 *   4      1    version    1
 *   5      1    reserved   0
 *   6      2    count      number of sector records
 *   8      4    image_size the SIZE of the .crt this belongs to
 *  12      4    image_crc  CRC-32 (IEEE, the zlib polynomial) of the whole .crt
 *  16    ...    records    count × [ 4-byte sector index ][ 4096 bytes ]
 * ```
 *
 * Little-endian throughout. Records ascend by sector index, and the index
 * counts 4 KB units from the start of the **image**, so on a `-1M` cart U2's
 * first sector is index 128.
 */

import { BankedCart, SECTOR_SIZE } from './Cart'
import type { Cartridge } from './Cart'
// A leaf: the same CRC-32 `screen.hash` and the PNG writer already use, written
// out rather than taken from `node:zlib` so that it works in the renderer too.
import { crc32 } from '../debug/Checksums'

export const SAVE_MAGIC = 0x5653_4341 // 'ACSV' read back little-endian
export const SAVE_VERSION = 1
export const SAVE_HEADER_SIZE = 16
export const SAVE_RECORD_SIZE = 4 + SECTOR_SIZE

/** A parsed `.sav`, before it has been checked against any particular image. */
export interface CartSave {
  version: number
  imageSize: number
  imageCrc: number
  /** Sector index → its 4 KB, in ascending index order. */
  sectors: Map<number, Uint8Array>
}

/**
 * The `.sav` is not this cart's.
 *
 * Distinct from a malformed file, because the two want different words: a
 * mismatch is the ordinary consequence of rebuilding a cartridge, and the host
 * reports it, starts the cart without the overlay, and **leaves the file
 * alone**. Nothing here ever deletes a save.
 */
export class SaveMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SaveMismatchError'
  }
}

/** The `.sav` is not a `.sav`. */
export class SaveFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SaveFormatError'
  }
}

/**
 * `Cart-512K.crt` → `Cart-512K.sav`, beside it: §4's `<stem>.sav`.
 *
 * A pure string rule rather than a path operation, because the same rule has to
 * hold in the CLI, in Electron's main process and in a browser that has no
 * `path` module. The extension is replaced rather than appended, so the pair
 * reads as a pair in `ls`; a name with no extension of its own — a dot in a
 * directory does not count — simply gains one.
 */
export function defaultCartSavePath(cartPath: string): string {
  return `${cartPath.replace(/\.[^./\\]*$/, '')}.sav`
}

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** CRC-32 as it is printed everywhere in the rollout: eight lowercase hex digits. */
export const crc32hex = (bytes: Uint8Array): string =>
  crc32(bytes).toString(16).padStart(8, '0')

/** Serialise an overlay. `sectors` need not be ordered; records always are. */
export function encodeSave(
  image: Uint8Array,
  sectors: Iterable<[number, Uint8Array]>
): Uint8Array {
  return encodeSaveFor(image.length, crc32(image), sectors)
}

/**
 * The same, for a caller that knows the image's size and checksum but no longer
 * holds the image — a snapshot, which carries a banked cart by identity.
 */
export function encodeSaveFor(
  imageSize: number,
  imageCrc: number,
  sectors: Iterable<[number, Uint8Array]>
): Uint8Array {
  const list = [...sectors].sort((a, b) => a[0] - b[0])
  for (const [index, bytes] of list) {
    if (bytes.length !== SECTOR_SIZE) {
      throw new RangeError(`sector ${index} is ${bytes.length} bytes, expected ${SECTOR_SIZE}`)
    }
    if (index < 0 || (index + 1) * SECTOR_SIZE > imageSize) {
      throw new RangeError(`sector ${index} lies outside a ${imageSize}-byte image`)
    }
  }

  const out = new Uint8Array(SAVE_HEADER_SIZE + list.length * SAVE_RECORD_SIZE)
  const dv = view(out)
  dv.setUint32(0, SAVE_MAGIC, true)
  out[4] = SAVE_VERSION
  out[5] = 0
  dv.setUint16(6, list.length, true)
  dv.setUint32(8, imageSize, true)
  dv.setUint32(12, imageCrc >>> 0, true)

  let p = SAVE_HEADER_SIZE
  for (const [index, bytes] of list) {
    dv.setUint32(p, index, true)
    out.set(bytes, p + 4)
    p += SAVE_RECORD_SIZE
  }
  return out
}

/** Parse a `.sav`. Throws on anything malformed; checks it against no image. */
export function decodeSave(bytes: Uint8Array): CartSave {
  if (bytes.length < SAVE_HEADER_SIZE) {
    throw new SaveFormatError('save file is too short to hold a header')
  }
  const dv = view(bytes)
  if (dv.getUint32(0, true) !== SAVE_MAGIC) {
    throw new SaveFormatError('not a .sav file (bad magic)')
  }
  const version = bytes[4]!
  if (version !== SAVE_VERSION) {
    throw new SaveFormatError(`save file version ${version}, expected ${SAVE_VERSION}`)
  }
  const count = dv.getUint16(6, true)
  const expected = SAVE_HEADER_SIZE + count * SAVE_RECORD_SIZE
  if (bytes.length !== expected) {
    throw new SaveFormatError(
      `save file is ${bytes.length} bytes, expected ${expected} for ${count} sectors`
    )
  }

  const sectors = new Map<number, Uint8Array>()
  let last = -1
  for (let i = 0; i < count; i++) {
    const p = SAVE_HEADER_SIZE + i * SAVE_RECORD_SIZE
    const index = dv.getUint32(p, true)
    if (index <= last) throw new SaveFormatError('save file sectors are not in ascending order')
    last = index
    sectors.set(index, bytes.slice(p + 4, p + 4 + SECTOR_SIZE))
  }

  return { version, imageSize: dv.getUint32(8, true), imageCrc: dv.getUint32(12, true), sectors }
}

/**
 * Check a `.sav` belongs to `image`, and throw `SaveMismatchError` if it does not.
 *
 * The size and CRC in the header are what make the sidecar safe: rebuild the
 * cartridge and the CRC moves, so a stale save is refused rather than laid over
 * new code that happens to sit at the same addresses.
 */
export function checkSave(image: Uint8Array, save: CartSave): void {
  if (save.imageSize !== image.length) {
    throw new SaveMismatchError(
      `save data belongs to a ${save.imageSize.toLocaleString()}-byte cartridge, ` +
        `not this ${image.length.toLocaleString()}-byte one`
    )
  }
  if (save.imageCrc !== crc32(image)) {
    throw new SaveMismatchError(
      'save data belongs to a different build of this cart ' +
        `(save ${save.imageCrc.toString(16).padStart(8, '0')}, image ${crc32hex(image)})`
    )
  }
  for (const index of save.sectors.keys()) {
    if ((index + 1) * SECTOR_SIZE > image.length) {
      throw new SaveMismatchError(`save sector ${index} lies outside the image`)
    }
  }
}

/** Apply a `.sav` over a copy of `image`, leaving `image` untouched. */
export function applySave(image: Uint8Array, sav: Uint8Array | CartSave): Uint8Array {
  const save = sav instanceof Uint8Array ? decodeSave(sav) : sav
  checkSave(image, save)
  const out = Uint8Array.from(image)
  for (const [index, bytes] of save.sectors) out.set(bytes, index * SECTOR_SIZE)
  return out
}

/** Which 4 KB sectors of `modified` differ from `original`, ascending. */
export function diffSectors(
  original: Uint8Array,
  modified: Uint8Array
): Map<number, Uint8Array> {
  if (original.length !== modified.length) {
    throw new RangeError('images differ in length; they are not the same cartridge')
  }
  const out = new Map<number, Uint8Array>()
  for (let at = 0; at < original.length; at += SECTOR_SIZE) {
    const a = original.subarray(at, at + SECTOR_SIZE)
    const b = modified.subarray(at, at + SECTOR_SIZE)
    for (let i = 0; i < SECTOR_SIZE; i++) {
      if (a[i] !== b[i]) { out.set(at / SECTOR_SIZE, Uint8Array.from(b)); break }
    }
  }
  return out
}

// ── The cart's side ──────────────────────────────────────────────────────────
//
// Every host holds the bytes it read the `.crt` from, and passes them back in
// here. The alternative — the cart keeping a pristine copy of itself — costs a
// second megabyte at `-1M` to answer a question the host can already answer.

/**
 * The overlay a running cart has accumulated against the image it was loaded
 * from, or an empty map for a flat ROM cart.
 *
 * Only the sectors the chip counts dirty are compared, so this costs the
 * sectors that were touched and not the whole cart — and a sector that was
 * erased and written back to exactly what the `.crt` holds drops out, so an
 * overlay never records a difference that is not one.
 */
export function overlayFor(
  original: Uint8Array,
  cart: Cartridge
): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>()
  if (!(cart instanceof BankedCart) || original.length !== cart.size) return out
  for (const index of cart.dirtySectors()) {
    const now = cart.sector(index)
    const was = original.subarray(index * SECTOR_SIZE, (index + 1) * SECTOR_SIZE)
    for (let i = 0; i < SECTOR_SIZE; i++) {
      if (was[i] !== now[i]) { out.set(index, Uint8Array.from(now)); break }
    }
  }
  return out
}

/**
 * The `.sav` a cart's flash writes deserve, or **null when there is nothing to
 * save**.
 *
 * Null rather than an empty container on purpose: a run that never programmed
 * the flash should leave no file at all, and — more to the point — should not
 * overwrite a save from an earlier run with an empty one.
 */
export function saveFor(original: Uint8Array, cart: Cartridge): Uint8Array | null {
  const sectors = overlayFor(original, cart)
  return sectors.size === 0 ? null : encodeSave(original, sectors)
}

/**
 * Lay a `.sav` over a cart that has just been loaded from `original`.
 *
 * Call this straight after the image goes in and before the machine runs: the
 * checks are against the `.crt`'s own bytes, which is what the cart holds only
 * until something programs it. Throws `SaveMismatchError` when the save belongs
 * to another build, which the host reports while starting the cart anyway.
 */
export function applySaveToCart(
  original: Uint8Array,
  cart: Cartridge,
  sav: Uint8Array | CartSave
): void {
  const save = sav instanceof Uint8Array ? decodeSave(sav) : sav
  checkSave(original, save)
  if (!(cart instanceof BankedCart)) {
    throw new SaveMismatchError('a 32K ROM cart has no flash to restore a save into')
  }
  for (const [index, bytes] of save.sectors) cart.loadSector(index, bytes)
}
