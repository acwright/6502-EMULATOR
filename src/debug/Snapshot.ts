import { BankedCart, CART_SIZES, SECTOR_SIZE } from '../core/Cart'
import type { Cartridge } from '../core/Cart'
import { SaveFormatError, decodeSave, encodeSaveFor } from '../core/CartSave'
import { ROM } from '../core/ROM'
import { StateError, fromBase64, toBase64 } from '../core/DeviceState'
import type { DeviceState } from '../core/DeviceState'
import type { Machine, SlotName } from '../core/Machine'
import type { VdpModel } from '../core/IO/VideoCard'
import { crc32 } from './Checksums'

export { StateError }

/**
 * A snapshot turned away before anything in the machine was written: a bad
 * envelope, the other video card, a different ROM, a different slot layout, a
 * malformed cartridge. The machine is exactly as it was.
 *
 * A `StateError` that is not one of these came from a card part-way through
 * the restore, and the machine is then part one program and part another.
 */
export class SnapshotRefused extends StateError {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotRefused'
  }
}

/**
 * Whole-machine save and restore.
 *
 * The point, stated plainly: today every test run pays the BIOS countdown and
 * BASIC's cold start — around 450,000 cycles before the machine will accept a
 * line of input. With snapshots an agent boots once, saves at the `READY.`
 * prompt, and restores per test case. It also gives a person a reproducible bug
 * report: here is the machine one instruction before it breaks.
 *
 * A snapshot is plain JSON so it travels over the debug protocol unchanged and a
 * person can read one in an editor. The size, for the standard slot layout at
 * the BASIC prompt, is around 140 KB — RAM and all 64 KB of VRAM in full, and
 * almost nothing else, because the cards that could be large (banked RAM, the
 * CF image) store only what has actually been touched. Headless, with the video
 * slot empty, it is around 52 KB.
 */

/**
 * Bumped whenever a stored field changes meaning.
 *
 * Loading is never a best effort: a version this build does not know restores
 * *most* of a machine, and a machine assembled from most of a snapshot fails in
 * ways nobody can reason about. Refusing costs a re-record.
 *
 * The versions this build reads, and the video card each one holds:
 *
 * - **1**, every snapshot emulator 2.x saved: the TMS9918A.
 * - **2**, 3.0 before the TMS9918A came back: the 6502-PICOVDP.
 * - **3**, this build: whichever card the top-level `vdp` names.
 *
 * A card's state is only ever applied to the same card. Eight registers and
 * 16 KB of VRAM cannot honestly be read as 128 registers and 64 KB, or the other
 * way about, so a snapshot taken with the other card is refused, naming the card
 * to relaunch with.
 */
export const SNAPSHOT_VERSION = 3

/** Every version `restoreSnapshot` accepts. */
const READABLE_VERSIONS: readonly number[] = [1, 2, 3]

/** The card a version 1 or 2 snapshot holds, which it does not name. */
const IMPLIED_VDP: Record<number, VdpModel> = { 1: 'tms9918a', 2: 'picovdp' }

/** Identifies the file, so a wrong path fails as "not a snapshot", not as JSON. */
export const SNAPSHOT_FORMAT = '6502-emulator-snapshot'

/** ROM enough to tell one apart, without carrying 32 KB of it. */
export interface ROMIdentity {
  length: number
  /** CRC-32, lower case hex. Not a security claim — just an identity. */
  crc32: string
}

export interface Snapshot {
  format: typeof SNAPSHOT_FORMAT
  version: number
  /** Informational: when the snapshot was taken, in host wall-clock time. */
  createdAt: string

  /**
   * The video card in io8, by the name `--vdp` takes, or null when io8 is empty
   * (a serial console). Version 3 on; a version 1 snapshot holds a TMS9918A
   * and a version 2 one a PICOVDP, and `restoreSnapshot` reads them that way.
   */
  vdp: VdpModel | null

  /**
   * PHI2 in Hz. Always 1000000 since 3.5, when the emulator became 1 MHz only, as the ACE is.
   * Still written, so a snapshot keeps its shape for an older reader, and not
   * applied on restore: one saved at 2 MHz by 3.4 restores and runs at 1 MHz.
   */
  frequency: number

  /**
   * The machine's cycle counter when the snapshot was taken. Informational.
   *
   * Not restored. `Machine.cycles` is a monotonic measure of elapsed emulated
   * time that cycle budgets, `wait.for {cycles}` and the step limits are all
   * expressed against; rewinding it would make every one of them report
   * negative progress across a restore. Nothing the machine emulates reads it —
   * the cards keep their own accumulators, and those *are* restored — so
   * determinism does not depend on it.
   */
  cycles: number

  /**
   * The ROM the snapshot was taken against, by identity rather than by content.
   *
   * A snapshot is worthless without the matching BIOS — the PC in it points into
   * that ROM — but the ROM is 32 KB that the host always loads at startup
   * anyway, so storing a checksum and refusing a mismatch is both smaller and
   * more useful than storing a copy that could disagree with the machine.
   */
  rom: ROMIdentity

  /**
   * The cartridge, when one is inserted — by content or by identity, depending
   * on which kind it is.
   *
   * A **flat 32K cart** is a base64 string of the whole image, which is what it
   * has always been. Content rather than identity, unlike the ROM, because a
   * cartridge can be swapped while the machine runs (`media.loadCart`) — so the
   * bytes that were in the address space at snapshot time are not necessarily
   * anything the host can find again. This encoding does not move: every
   * snapshot ever written carries it, and the goldens are captured against it.
   *
   * A **banked flash cart** is `BankedCart`'s identity plus what it has written
   * to itself (`PLAN.md` §6). The reasoning above still holds at 32 KB and
   * stops holding at a megabyte: a 1.4 MB snapshot, against a documented
   * typical of around 140 KB, would make the feature unusable for the thing it
   * is for. So the same image has to be loaded to restore one, checked by
   * `size` and `crc32` and overridable with `force` exactly as a mismatched ROM
   * is.
   */
  cart?: string | BankedCartState

  cpu: DeviceState
  ram: DeviceState
  /** The eight slot cards in address order, io1 first. */
  slots: DeviceState[]
}

/** A banked flash cart, carried by identity and difference (`PLAN.md` §6). */
export interface BankedCartState {
  /** The image's length: which of the four flash sizes it is. */
  size: number
  /** CRC-32 of the `.crt` the cart was loaded from, as eight hex digits. */
  crc32: string
  /**
   * The latched bank register.
   *
   * **The field it would be easy to forget.** A snapshot that restores memory
   * but not the register resumes a cart looking at the wrong 8 KB, which
   * presents as a nondeterministic golden rather than as an error.
   */
  bank: number
  /**
   * What the cart has programmed into itself since it was loaded, as a base64
   * `.sav` container (6502-VCS `PLAN.md` §4) — absent when it has programmed
   * nothing, which is every cart that does not write to its own flash.
   *
   * The container rather than a bare run of sectors because it already says
   * which sectors these are and which image they belong to, and because it is
   * then the same bytes the sidecar holds: sectors pulled out of a snapshot can
   * go straight to `6502-flash merge`. Its header must agree with `size` and
   * `crc32` above, and a snapshot where they disagree is malformed.
   */
  sectors?: string
}

const SLOT_NAMES: SlotName[] = ['io1', 'io2', 'io3', 'io4', 'io5', 'io6', 'io7', 'io8']

const romIdentity = (rom: ROM): ROMIdentity => ({
  length: rom.data.length,
  crc32: crc32(Uint8Array.from(rom.data)).toString(16).padStart(8, '0')
})

/**
 * Capture the machine as it stands.
 *
 * Safe to call at any point, including mid-instruction: the CPU's working
 * registers and every card's cycle accumulator are part of what is stored, so a
 * snapshot taken between two ticks resumes as the same instruction rather than
 * re-decoding from a PC that has already moved.
 */
/**
 * The cartridge, as a snapshot carries it.
 *
 * A flat `Cart` keeps today's encoding exactly — the whole 32 KB, base64 — so
 * no committed snapshot is invalidated and no golden moves. A banked cart is
 * its identity, its bank register, and a `.sav` of whatever it has programmed
 * into itself.
 */
function cartState(cart: Cartridge): string | BankedCartState {
  if (!(cart instanceof BankedCart)) return toBase64(cart.data)
  // The overlay is measured against the image the cart was loaded from, which
  // the cart no longer holds — but every sector it has *not* written is still
  // that image, so the dirty set is exactly the difference.
  const sectors = cart.dirtySectors()
  return {
    size: cart.size,
    crc32: cart.imageCrc,
    bank: cart.bank,
    ...(sectors.length > 0
      ? {
          sectors: toBase64(
            encodeSaveFor(
              cart.size,
              parseInt(cart.imageCrc, 16),
              sectors.map((index) => [index, cart.sector(index)])
            )
          )
        }
      : {})
  }
}

export function captureSnapshot(machine: Machine): Snapshot {
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    createdAt: new Date().toISOString(),
    vdp: machine.video()?.model ?? null,
    frequency: machine.frequency,
    cycles: machine.cycles,
    rom: romIdentity(machine.rom),
    ...(machine.cart ? { cart: cartState(machine.cart) } : {}),
    cpu: machine.cpu.serialize(),
    ram: machine.ram.serialize(),
    slots: machine.slots().map((card) => card.serialize())
  }
}

export interface RestoreOptions {
  /**
   * Apply the snapshot even though its ROM is not the one in the machine.
   *
   * Occasionally right — patching a BIOS and replaying a saved state against it
   * is a real thing to want — and wrong by default, because the far more common
   * cause of a mismatch is restoring against the wrong build entirely, which
   * produces a machine that crashes somewhere unrelated.
   */
  force?: boolean
}

export interface RestoreResult {
  /** The version the snapshot was written as. */
  version: number
  /** Set when the ROM did not match and `force` allowed it through anyway. */
  romMismatch?: { expected: ROMIdentity; actual: ROMIdentity }
  /** Set when the flash cart did not match and `force` allowed it through. */
  cartMismatch?: { expected: ROMIdentity; actual: ROMIdentity }
}

/**
 * Apply a snapshot to a machine.
 *
 * Validates before it writes anything it can — format, version, slot layout and
 * ROM identity — because a restore that fails halfway leaves a machine that is
 * part one program and part another. The per-card checks cannot all be hoisted
 * (a card only knows its own fields), so a card that throws does abandon the
 * restore mid-way; the caller's recourse is to reset, which is why `state.load`
 * says so in its error rather than pretending the machine is still usable.
 *
 * Every refusal from the checks that run before the first write is a
 * `SnapshotRefused`, so a caller can tell "nothing happened" from "reset now".
 */
export function restoreSnapshot(
  machine: Machine,
  snapshot: unknown,
  options: RestoreOptions = {}
): RestoreResult {
  let checked: { state: Snapshot; result: RestoreResult; cart: CheckedCart }
  try {
    checked = checkBeforeWriting(machine, snapshot, options)
  } catch (e) {
    throw e instanceof StateError && !(e instanceof SnapshotRefused) ? new SnapshotRefused(e.message) : e
  }
  const { state, result, cart } = checked
  const cards = machine.slots()

  if (cart.kind === 'none') machine.unloadCart()
  else if (cart.kind === 'image') machine.loadCart(cart.bytes)
  else {
    // A banked cart is not reloaded: the image is already in the machine and
    // was checked against the snapshot's identity above. What is applied is
    // what the cart had written to itself, and the bank register.
    for (const [index, bytes] of cart.sectors) cart.cart.loadSector(index, bytes)
    cart.cart.bank = cart.bank
  }

  machine.cpu.deserialize(state.cpu)
  machine.ram.deserialize(state.ram)
  state.slots.forEach((slotState, index) => cards[index]!.deserialize(slotState))

  return result
}

/** Everything `restoreSnapshot` can check without writing to the machine. */
function checkBeforeWriting(
  machine: Machine,
  snapshot: unknown,
  options: RestoreOptions
): { state: Snapshot; result: RestoreResult; cart: CheckedCart } {
  const state = validate(snapshot)
  const result: RestoreResult = { version: state.version }

  // The card before the ROM, and never overridable: `force` is for replaying a
  // state against a patched BIOS, but one card's state cannot be applied to the
  // other at all. Only when both have a card — an empty io8 on either side is a
  // different slot layout, which the kind check below reports.
  const machineVdp = machine.video()?.model ?? null
  if (state.vdp !== null && machineVdp !== null && state.vdp !== machineVdp) {
    throw new StateError(
      `snapshot: taken with the ${state.vdp} video card; this machine has ${machineVdp} — ` +
        `relaunch with --vdp ${state.vdp} (or choose it in Settings)`
    )
  }

  const actual = romIdentity(machine.rom)
  if (state.rom.crc32 !== actual.crc32 || state.rom.length !== actual.length) {
    if (!options.force) {
      throw new StateError(
        `snapshot: taken against a different ROM (${state.rom.crc32}, ` +
          `${state.rom.length} bytes; this machine has ${actual.crc32}, ${actual.length}) — ` +
          'load the matching ROM, or pass force to restore anyway'
      )
    }
    result.romMismatch = { expected: state.rom, actual }
  }

  // Slot kinds first: every card's own deserialize checks its own kind, but
  // finding out at slot 7 means slots 1-6 have already been overwritten.
  const cards = machine.slots()
  state.slots.forEach((slotState, index) => {
    const card = cards[index]!
    if (slotState.kind !== card.kind) {
      throw new StateError(
        `snapshot: ${SLOT_NAMES[index]} holds a ${card.kind} card, ` +
          `the snapshot has ${String(slotState.kind)} — the snapshot was taken from a ` +
          'machine with a different slot configuration'
      )
    }
  })

  return { state, result, cart: checkCart(machine, state, options, result) }
}

/**
 * What the restore will do about the cartridge, decided before it writes
 * anything.
 */
type CheckedCart =
  | { kind: 'none' }
  /** A flat 32K cart, carried whole: load these bytes. */
  | { kind: 'image'; bytes: Uint8Array }
  /** A banked cart already in the machine: apply these sectors and this bank. */
  | { kind: 'banked'; cart: BankedCart; sectors: Map<number, Uint8Array>; bank: number }

function checkCart(
  machine: Machine,
  state: Snapshot,
  options: RestoreOptions,
  result: RestoreResult
): CheckedCart {
  if (state.cart === undefined) return { kind: 'none' }

  if (typeof state.cart === 'string') {
    const bytes = fromBase64(state.cart, 'snapshot.cart')
    if (!CART_SIZES.includes(bytes.length)) {
      throw new StateError(
        `snapshot.cart: expected one of ${CART_SIZES.join(', ')} bytes, got ${bytes.length}`
      )
    }
    return { kind: 'image', bytes }
  }

  const want = state.cart
  const cart = machine.cart
  if (!(cart instanceof BankedCart)) {
    throw new StateError(
      `snapshot.cart: taken with a ${want.size.toLocaleString()}-byte flash cart ` +
        `(${want.crc32}) — insert that cartridge and restore again. A banked cart is ` +
        'carried by identity, not by content, so the snapshot does not hold a copy of it.'
    )
  }
  if (cart.size !== want.size || cart.imageCrc !== want.crc32) {
    // The same escape hatch a mismatched ROM has, and for the same reason:
    // occasionally someone means it, and by default they do not.
    if (!options.force) {
      throw new StateError(
        `snapshot.cart: taken against a different cartridge (${want.crc32}, ` +
          `${want.size.toLocaleString()} bytes; this machine has ${cart.imageCrc}, ` +
          `${cart.size.toLocaleString()}) — insert the matching cart, or pass force ` +
          'to restore anyway'
      )
    }
    result.cartMismatch = {
      expected: { length: want.size, crc32: want.crc32 },
      actual: { length: cart.size, crc32: cart.imageCrc }
    }
  }

  if (!Number.isInteger(want.bank) || want.bank < 0 || want.bank > 0xFF) {
    throw new StateError(`snapshot.cart.bank: expected 0-255, got ${String(want.bank)}`)
  }

  let sectors = new Map<number, Uint8Array>()
  if (want.sectors !== undefined) {
    const bytes = fromBase64(want.sectors, 'snapshot.cart.sectors')
    let save
    try {
      save = decodeSave(bytes)
    } catch (e) {
      throw new StateError(
        `snapshot.cart.sectors: ${e instanceof SaveFormatError ? e.message : String(e)}`
      )
    }
    // The container says which image it belongs to, and the envelope says the
    // same thing; a snapshot where the two disagree is malformed rather than
    // merely mismatched, so `force` does not apply.
    if (save.imageSize !== want.size || save.imageCrc !== parseInt(want.crc32, 16)) {
      throw new StateError(
        'snapshot.cart.sectors: the save container inside the snapshot does not match ' +
          'the cartridge the snapshot names'
      )
    }
    for (const index of save.sectors.keys()) {
      if ((index + 1) * SECTOR_SIZE > cart.size) {
        throw new StateError(`snapshot.cart.sectors: sector ${index} lies outside the cartridge`)
      }
    }
    sectors = save.sectors
  }

  return { kind: 'banked', cart, sectors, bank: want.bank }
}

/** Check the envelope, and narrow `unknown` to something with named fields. */
function validate(snapshot: unknown): Snapshot {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new StateError('snapshot: expected an object')
  }

  const candidate = snapshot as Record<string, unknown>

  if (candidate.format !== SNAPSHOT_FORMAT) {
    throw new StateError(
      `snapshot: not a 6502 snapshot (format is ${JSON.stringify(candidate.format)})`
    )
  }
  if (typeof candidate.version !== 'number' || !READABLE_VERSIONS.includes(candidate.version)) {
    throw new StateError(
      `snapshot: version ${String(candidate.version)}, this build reads version ${SNAPSHOT_VERSION}`
    )
  }
  const version = candidate.version
  if (typeof candidate.frequency !== 'number' || !Number.isFinite(candidate.frequency)) {
    throw new StateError('snapshot.frequency: expected a number')
  }

  const rom = candidate.rom
  if (
    typeof rom !== 'object' ||
    rom === null ||
    typeof (rom as ROMIdentity).crc32 !== 'string' ||
    typeof (rom as ROMIdentity).length !== 'number'
  ) {
    throw new StateError('snapshot.rom: expected { length, crc32 }')
  }

  // Either encoding: base64 for a flat 32K cart, an identity object for a
  // banked one. `checkCart` reads the object's fields; this only settles which
  // of the two shapes arrived, so that everything after it can trust the union.
  const cart = candidate.cart
  if (cart !== undefined && typeof cart !== 'string') {
    if (typeof cart !== 'object' || cart === null || Array.isArray(cart)) {
      throw new StateError('snapshot.cart: expected base64 or { size, crc32, bank }')
    }
    const banked = cart as BankedCartState
    if (
      typeof banked.size !== 'number' ||
      typeof banked.crc32 !== 'string' ||
      typeof banked.bank !== 'number'
    ) {
      throw new StateError('snapshot.cart: expected { size, crc32, bank }')
    }
    if (banked.sectors !== undefined && typeof banked.sectors !== 'string') {
      throw new StateError('snapshot.cart.sectors: expected base64')
    }
  }

  const slots = candidate.slots
  if (!Array.isArray(slots) || slots.length !== SLOT_NAMES.length) {
    throw new StateError(`snapshot.slots: expected ${SLOT_NAMES.length} entries`)
  }
  slots.forEach((slot, index) => {
    if (typeof slot !== 'object' || slot === null || typeof (slot as DeviceState).kind !== 'string') {
      throw new StateError(`snapshot.slots[${index}]: expected a state object with a "kind"`)
    }
  })

  for (const field of ['cpu', 'ram'] as const) {
    const value = candidate[field]
    if (typeof value !== 'object' || value === null || typeof (value as DeviceState).kind !== 'string') {
      throw new StateError(`snapshot.${field}: expected a state object with a "kind"`)
    }
  }

  // Which card io8 holds. Named from version 3; implied before it, and only
  // where io8 holds a video card at all.
  const io8Kind = (slots[SLOT_NAMES.length - 1] as DeviceState).kind
  let vdp: VdpModel | null
  if (version >= 3) {
    if (candidate.vdp !== null && candidate.vdp !== 'tms9918a' && candidate.vdp !== 'picovdp') {
      throw new StateError(
        `snapshot.vdp: expected "tms9918a", "picovdp" or null, got ${JSON.stringify(candidate.vdp)}`
      )
    }
    vdp = candidate.vdp
    if ((vdp === null) !== (io8Kind !== 'video')) {
      throw new StateError(
        `snapshot.vdp: ${JSON.stringify(vdp)} does not match io8, which holds a ${io8Kind} card`
      )
    }
  } else {
    vdp = io8Kind === 'video' ? IMPLIED_VDP[version]! : null
  }

  return { ...(candidate as unknown as Snapshot), vdp }
}
