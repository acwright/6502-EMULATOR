import { readFileSync } from 'fs'
import { join } from 'path'
import { Machine } from '../../core/Machine'
import type { SlotConfig } from '../../core/Machine'
import { Cart } from '../../core/Cart'
import { Empty } from '../../core/IO/Empty'
import { RAMBank } from '../../core/IO/RAMBank'
import { RTC } from '../../core/IO/RTC'
import { Sound } from '../../core/IO/Sound'
import { Storage } from '../../core/IO/Storage'
import { Video } from '../../core/IO/Video'
import { TMS9918A } from '../../core/IO/TMS9918A'
import { Session } from '../../debug/Session'
import {
  captureSnapshot,
  restoreSnapshot,
  SnapshotRefused,
  StateError,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION
} from '../../debug/Snapshot'
import type { Snapshot } from '../../debug/Snapshot'

const BIOS = readFileSync(join(__dirname, '../../renderer/public/roms/BIOS.bin'))

/** A small CF card, so a test can compare whole images without minutes of work. */
const CF_SIZE = 64 * 1024

/**
 * The standard slot layout with a small CF card and a serial console.
 *
 * Serial rather than video because that is what a headless run boots as, and it
 * exercises the case where a snapshot has an Empty card in io8 — the one slot
 * whose contents change the machine's behaviour rather than just its state.
 */
function machine(overrides: SlotConfig = {}): Machine {
  const m = new Machine({ io4: new Storage(CF_SIZE), io8: new Empty(), ...overrides })
  m.loadROM(BIOS)
  m.reset(true)
  return m
}

/** JSON round-trip, so a test is asserting on what a client would receive. */
const wire = (snapshot: Snapshot): Snapshot => JSON.parse(JSON.stringify(snapshot)) as Snapshot

/** Write `bytes` to a CF sector through the IDE registers, as the BIOS would. */
function writeSector(storage: Storage, sector: number, fill: number): void {
  storage.write(0x02, 1)
  storage.write(0x03, sector & 0xff)
  storage.write(0x04, (sector >> 8) & 0xff)
  storage.write(0x05, (sector >> 16) & 0xff)
  storage.write(0x06, 0xe0 | ((sector >> 24) & 0x0f))
  storage.write(0x07, 0x30)
  for (let i = 0; i < Storage.SECTOR_SIZE; i++) storage.write(0x00, fill)
}

const cfImage = (storage: Storage): Uint8Array => storage.getData()

describe('Snapshot', () => {
  describe('envelope', () => {
    it('stamps the format, version and clock', () => {
      const snapshot = captureSnapshot(machine())

      expect(snapshot.format).toBe(SNAPSHOT_FORMAT)
      expect(snapshot.version).toBe(SNAPSHOT_VERSION)
      expect(snapshot.frequency).toBe(1_000_000)
      expect(snapshot.slots).toHaveLength(8)
      expect(Date.parse(snapshot.createdAt)).not.toBeNaN()
    })

    // 3.4 could save one at 2 MHz. The ACE runs at 1 MHz only now, so it
    // restores, and runs at 1 MHz.
    it('restores a 2 MHz snapshot at 1 MHz', () => {
      const m = machine()
      m.runCycles(5000)
      const saved = { ...captureSnapshot(m), frequency: 2_000_000 }

      const restored = machine()
      expect(() => restoreSnapshot(restored, wire(saved))).not.toThrow()
      expect(restored.frequency).toBe(1_000_000)
      expect(restored.cpu.pc).toBe(m.cpu.pc)
    })

    it('survives a JSON round trip', () => {
      const m = machine()
      m.runCycles(5000)

      const restored = machine()
      expect(() => restoreSnapshot(restored, wire(captureSnapshot(m)))).not.toThrow()
      expect(restored.cpu.pc).toBe(m.cpu.pc)
    })

    it('refuses anything that is not a snapshot', () => {
      const m = machine()
      expect(() => restoreSnapshot(m, { hello: 'world' })).toThrow(StateError)
      expect(() => restoreSnapshot(m, null)).toThrow(/expected an object/)
      expect(() => restoreSnapshot(m, [])).toThrow(/expected an object/)
    })

    it('names the field when the envelope is malformed', () => {
      const m = machine()
      const good = captureSnapshot(m)

      const cases: [unknown, RegExp][] = [
        [{ ...good, frequency: '1MHz' }, /snapshot\.frequency/],
        [{ ...good, rom: undefined }, /snapshot\.rom/],
        [{ ...good, rom: { length: 0x8000 } }, /snapshot\.rom/],
        [{ ...good, cart: 42 }, /snapshot\.cart: expected base64/],
        [{ ...good, slots: good.slots.slice(0, 4) }, /snapshot\.slots: expected 8/],
        [{ ...good, slots: [...good.slots.slice(0, 7), null] }, /snapshot\.slots\[7\]/],
        [{ ...good, slots: [...good.slots.slice(0, 7), {}] }, /snapshot\.slots\[7\]/],
        [{ ...good, cpu: null }, /snapshot\.cpu/],
        [{ ...good, ram: { data: '' } }, /snapshot\.ram/]
      ]

      for (const [snapshot, message] of cases) {
        expect(() => restoreSnapshot(machine(), snapshot)).toThrow(message)
      }
    })

    it('refuses a version it does not read, rather than restoring most of it', () => {
      const m = machine()
      const snapshot = { ...captureSnapshot(m), version: SNAPSHOT_VERSION + 1 }

      expect(() => restoreSnapshot(machine(), snapshot)).toThrow(
        new RegExp(`version ${SNAPSHOT_VERSION + 1}.*reads version ${SNAPSHOT_VERSION}`)
      )
    })

    it('reads versions 1 and 2 as well as its own, and says which it read', () => {
      expect(SNAPSHOT_VERSION).toBe(3)
      for (const version of [1, 2, 3]) {
        const { vdp: _vdp, ...snapshot } = { ...captureSnapshot(machine()), version }
        const stamped = version === 3 ? { ...snapshot, vdp: null } : snapshot
        expect(restoreSnapshot(machine(), stamped).version).toBe(version)
      }
      expect(() => restoreSnapshot(machine(), { ...captureSnapshot(machine()), version: 0 })).toThrow(
        /version 0, this build reads version 3/
      )
    })
  })

  describe('machine identity', () => {
    it('refuses a snapshot taken against a different ROM', () => {
      const m = machine()
      const snapshot = captureSnapshot(m)

      const other = new Machine({ io4: new Storage(CF_SIZE), io8: new Empty() })
      const patched = new Uint8Array(BIOS)
      patched[0x100] = patched[0x100]! ^ 0xff
      other.loadROM(patched)
      other.reset(true)

      expect(() => restoreSnapshot(other, snapshot)).toThrow(/different ROM/)
    })

    it('restores against a different ROM when forced, and says it did', () => {
      const m = machine()
      m.runCycles(1000)
      const snapshot = captureSnapshot(m)

      const other = new Machine({ io4: new Storage(CF_SIZE), io8: new Empty() })
      const patched = new Uint8Array(BIOS)
      patched[0x100] = patched[0x100]! ^ 0xff
      other.loadROM(patched)
      other.reset(true)

      const result = restoreSnapshot(other, snapshot, { force: true })

      expect(result.romMismatch?.expected.crc32).toBe(snapshot.rom.crc32)
      expect(result.romMismatch?.actual.crc32).not.toBe(snapshot.rom.crc32)
      expect(other.cpu.pc).toBe(m.cpu.pc)
    })

    it('refuses a snapshot from a different slot layout', () => {
      const serialBoot = captureSnapshot(machine())
      const videoBoot = new Machine({ io4: new Storage(CF_SIZE), io8: new Video() })
      videoBoot.loadROM(BIOS)
      videoBoot.reset(true)

      expect(() => restoreSnapshot(videoBoot, serialBoot)).toThrow(
        /io8 holds a video card, the snapshot has empty/
      )
    })

    it('checks the layout before writing any of it', () => {
      const m = machine()
      m.runCycles(20_000)
      const snapshot = captureSnapshot(m)
      // Only io8 disagrees, so a restore that wrote as it went would already
      // have replaced RAM and the CPU by the time it noticed.
      snapshot.slots[7] = { kind: 'video' }

      const target = machine()
      const pcBefore = target.cpu.pc
      expect(() => restoreSnapshot(target, snapshot)).toThrow(SnapshotRefused)
      expect(target.cpu.pc).toBe(pcBefore)
    })

    it('says which refusals left the machine untouched', () => {
      // Before the first write: a SnapshotRefused, the machine as it was.
      expect(() => restoreSnapshot(machine(), { hello: 'world' })).toThrow(SnapshotRefused)

      // A card's own fields, found wrong only while applying: a plain StateError.
      const snapshot = wire(captureSnapshot(machine()))
      ;(snapshot as unknown as { cpu: unknown }).cpu = { kind: 'cpu' }
      let thrown: unknown
      try {
        restoreSnapshot(machine(), snapshot)
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(StateError)
      expect(thrown).not.toBeInstanceOf(SnapshotRefused)
    })
  })

  describe('the cartridge', () => {
    it('carries the image, and puts it back', () => {
      const m = machine()
      const cart = new Uint8Array(Cart.SIZE)
      cart[0x4000] = 0xa9
      cart[0x4001] = 0x42
      m.loadCart(cart)

      const snapshot = wire(captureSnapshot(m))
      expect(snapshot.cart).toBeDefined()

      const restored = machine()
      restoreSnapshot(restored, snapshot)

      expect(restored.cart).toBeDefined()
      expect(restored.peek(Cart.CODE)).toBe(0xa9)
      expect(restored.peek(Cart.CODE + 1)).toBe(0x42)
    })

    it('ejects a cartridge the snapshot did not have', () => {
      const snapshot = captureSnapshot(machine())

      const withCart = machine()
      withCart.loadCart(new Uint8Array(Cart.SIZE))
      expect(withCart.cart).toBeDefined()

      restoreSnapshot(withCart, snapshot)
      expect(withCart.cart).toBeUndefined()
    })

    it('refuses a cartridge that is not the size of the address space', () => {
      const m = machine()
      const snapshot = { ...captureSnapshot(m), cart: Buffer.from([1, 2, 3]).toString('base64') }
      expect(() => restoreSnapshot(machine(), snapshot)).toThrow(/snapshot.cart: expected/)
    })

    it('still carries a 32K cart whole, which is what keeps old snapshots valid', () => {
      const m = machine()
      m.loadCart(new Uint8Array(Cart.SIZE).fill(0x5A))
      // A string, not an object: every snapshot ever written has this shape,
      // and the goldens were captured against it.
      expect(typeof captureSnapshot(m).cart).toBe('string')
    })
  })

  /**
   * `PLAN.md` §6. A banked cart is carried by identity and difference, because
   * the honest alternative — the whole image, as a flat cart is carried — is
   * 1.4 MB against a documented typical snapshot of about 140 KB.
   */
  describe('a banked flash cart', () => {
    const image = (fill = 0): Uint8Array => {
      const bytes = new Uint8Array(0x20000)
      for (let bank = 0; bank < 16; bank++) {
        bytes.fill(bank ^ fill, bank * 0x2000, (bank + 1) * 0x2000)
      }
      return bytes
    }

    const withCart = (bytes: Uint8Array): Machine => {
      const m = machine()
      m.loadCart(bytes)
      return m
    }

    /** Program one byte, the way a cartridge's own save routine does. */
    const program = (m: Machine, bank: number, address: number, value: number): void => {
      m.poke(0xE000, 2); m.poke(0xD555, 0xAA)
      m.poke(0xE000, 1); m.poke(0xCAAA, 0x55)
      m.poke(0xE000, 2); m.poke(0xD555, 0xA0)
      m.poke(0xE000, bank); m.poke(address, value)
      // Past the 20 µs program window, or every read of the chip is status.
      // A cart's own routine spends these cycles data-polling; nothing here is
      // executing, so they are simply skipped.
      m.cycles += 100
    }

    it('carries identity, not a copy of the image', () => {
      const snapshot = wire(captureSnapshot(withCart(image())))
      const cart = snapshot.cart as { size: number; crc32: string; bank: number; sectors?: string }
      expect(cart.size).toBe(0x20000)
      expect(cart.crc32).toMatch(/^[0-9a-f]{8}$/)
      // Nothing programmed, so there is nothing to carry.
      expect(cart.sectors).toBeUndefined()
      expect(JSON.stringify(snapshot).length).toBeLessThan(0x20000)
    })

    /**
     * The field it would be easy to forget. A restore that puts memory back but
     * not the register resumes a cart looking at the wrong 8 KB, which presents
     * as a nondeterministic golden rather than as an error.
     */
    it('restores the bank register', () => {
      const m = withCart(image())
      m.poke(0xE000, 9)
      expect(m.peek(0xC000)).toBe(9)

      const restored = withCart(image())
      restoreSnapshot(restored, wire(captureSnapshot(m)))
      expect(restored.peek(0xC000)).toBe(9)
    })

    it('carries what the cart programmed into itself, and puts it back', () => {
      const m = withCart(image())
      program(m, 14, 0xC123, 0x0A) // $0E & $0A is $0A
      expect(m.peek(0xC123)).toBe(0x0A)

      const snapshot = wire(captureSnapshot(m))
      expect((snapshot.cart as { sectors?: string }).sectors).toBeDefined()

      const restored = withCart(image())
      restored.poke(0xE000, 14)
      expect(restored.peek(0xC123)).toBe(0x0E) // a clean cart, before the restore
      restoreSnapshot(restored, snapshot)
      // The register came back as bank 14 with the rest of the cart's state.
      expect(restored.peek(0xC123)).toBe(0x0A)
    })

    it('needs the cartridge in the machine, and says so when it is not', () => {
      const snapshot = wire(captureSnapshot(withCart(image())))
      expect(() => restoreSnapshot(machine(), snapshot)).toThrow(SnapshotRefused)
      expect(() => restoreSnapshot(machine(), snapshot))
        .toThrow(/insert that cartridge and restore again/)
    })

    it('refuses a different build of the cart, and takes force', () => {
      const snapshot = wire(captureSnapshot(withCart(image())))
      const other = withCart(image(0xFF))

      expect(() => restoreSnapshot(other, snapshot)).toThrow(/a different cartridge/)
      const result = restoreSnapshot(other, snapshot, { force: true })
      expect(result.cartMismatch).toBeDefined()
    })

    it('refuses a 32K cart where a flash cart belongs', () => {
      const snapshot = wire(captureSnapshot(withCart(image())))
      const flat = machine()
      flat.loadCart(new Uint8Array(Cart.SIZE))
      expect(() => restoreSnapshot(flat, snapshot)).toThrow(/insert that cartridge/)
    })

    it('refuses an envelope that is neither shape', () => {
      const m = withCart(image())
      const base = wire(captureSnapshot(m))
      expect(() => restoreSnapshot(withCart(image()), { ...base, cart: 42 }))
        .toThrow(/expected base64 or \{ size, crc32, bank \}/)
      expect(() => restoreSnapshot(withCart(image()), { ...base, cart: { size: 0x20000 } }))
        .toThrow(/expected \{ size, crc32, bank \}/)
    })

    it('refuses a bank the register cannot hold', () => {
      const base = wire(captureSnapshot(withCart(image())))
      const cart = { ...(base.cart as object), bank: 256 }
      expect(() => restoreSnapshot(withCart(image()), { ...base, cart }))
        .toThrow(/snapshot.cart.bank: expected 0-255/)
    })

    /**
     * The container inside the envelope says which image it belongs to, and so
     * does the envelope. The two disagreeing is a malformed snapshot rather
     * than a mismatched one, so `force` has nothing to say about it.
     */
    it('refuses a save container that does not match the cart the snapshot names', () => {
      const m = withCart(image())
      program(m, 14, 0xC123, 0x0A)
      const base = wire(captureSnapshot(m))
      const cart = { ...(base.cart as { crc32: string }), crc32: 'deadbeef' }

      expect(() => restoreSnapshot(withCart(image()), { ...base, cart }, { force: true }))
        .toThrow(/the save container inside the snapshot does not match/)
    })

    it('refuses sectors that are not a save container at all', () => {
      const base = wire(captureSnapshot(withCart(image())))
      const cart = { ...(base.cart as object), sectors: Buffer.from('nope').toString('base64') }
      expect(() => restoreSnapshot(withCart(image()), { ...base, cart }))
        .toThrow(/snapshot.cart.sectors:/)
    })
  })

  describe('determinism', () => {
    /**
     * The property the whole feature rests on: restoring and running is the same
     * as never having stopped. If it does not hold, an agent's test results
     * depend on whether a snapshot happened to be taken, which is worse than no
     * snapshots at all.
     */
    it('a restored machine runs to the same state as one that kept going', () => {
      const original = machine()
      original.runCycles(600_000)

      const snapshot = wire(captureSnapshot(original))

      const restored = machine()
      restoreSnapshot(restored, snapshot)

      original.runCycles(250_000)
      restored.runCycles(250_000)

      expect(restored.cpu.serialize()).toEqual(original.cpu.serialize())
      expect(restored.ram.serialize()).toEqual(original.ram.serialize())
      for (let slot = 0; slot < 8; slot++) {
        expect(restored.slots()[slot]!.serialize()).toEqual(original.slots()[slot]!.serialize())
      }
    })

    it('resumes mid-instruction rather than re-decoding from the PC', () => {
      const original = machine()
      original.runCycles(600_000)
      // Land part-way through an instruction, which is where a snapshot that
      // stored only the programmer's model would diverge.
      while (original.cpu.cyclesRem === 0) original.tick()
      expect(original.cpu.cyclesRem).toBeGreaterThan(0)

      const restored = machine()
      restoreSnapshot(restored, wire(captureSnapshot(original)))
      expect(restored.cpu.cyclesRem).toBe(original.cpu.cyclesRem)

      original.runCycles(50_000)
      restored.runCycles(50_000)
      expect(restored.cpu.serialize()).toEqual(original.cpu.serialize())
    })

    /**
     * A machine parked in WAI looks identical to a running one in every field
     * the programmer's model has — same PC, same registers, cyclesRem zero. The
     * halt lives only in the two flags, so leaving them out of the snapshot
     * would restore a sleeping machine as one that carries straight on
     * executing whatever follows the WAI.
     */
    it('a machine halted in WAI restores still halted', () => {
      const original = machine()
      original.poke(0x0200, 0xcb)  // WAI
      original.poke(0x0201, 0xe8)  // INX, if it ever wakes
      original.cpu.pc = 0x0200
      original.cpu.cyclesRem = 0
      original.runCycles(10)
      expect(original.cpu.waiting).toBe(true)

      const restored = machine()
      restoreSnapshot(restored, wire(captureSnapshot(original)))

      expect(restored.cpu.waiting).toBe(true)
      expect(restored.cpu.pc).toBe(0x0201)

      original.runCycles(500)
      restored.runCycles(500)
      expect(restored.cpu.serialize()).toEqual(original.cpu.serialize())
    })

    it('a snapshot without the halt flags restores as a running machine', () => {
      const m = machine()
      m.runCycles(1000)
      const snapshot = wire(captureSnapshot(m))

      // What every snapshot written before WAI and STP halted anything looks
      // like. A missing field is an older format, not corruption.
      delete (snapshot.cpu as Record<string, unknown>).waiting
      delete (snapshot.cpu as Record<string, unknown>).stopped

      const restored = machine()
      restoreSnapshot(restored, snapshot)

      expect(restored.cpu.waiting).toBe(false)
      expect(restored.cpu.stopped).toBe(false)
    })

    it('leaves the cycle counter alone, so elapsed time keeps moving forward', () => {
      const m = machine()
      m.runCycles(1000)
      const snapshot = captureSnapshot(m)
      expect(snapshot.cycles).toBe(m.cycles)

      m.runCycles(1000)
      const before = m.cycles
      restoreSnapshot(m, snapshot)

      expect(m.cycles).toBe(before)
    })
  })

  describe('banked RAM', () => {
    it('stores only the banks that hold something', () => {
      const m = machine({ io1: new RAMBank() })
      const bank = m.io1 as RAMBank

      bank.write(RAMBank.BANK_CONTROL_REGISTER, 7)
      bank.write(0x000, 0xab)

      const state = captureSnapshot(m).slots[0]!
      const banks = state.banks as Record<string, string>

      expect(Object.keys(banks).sort()).toEqual(['7'])
    })

    it('round-trips a bank, and clears one the snapshot did not have', () => {
      const m = machine({ io1: new RAMBank() })
      const bank = m.io1 as RAMBank
      bank.write(RAMBank.BANK_CONTROL_REGISTER, 3)
      bank.write(0x010, 0x5a)

      const snapshot = wire(captureSnapshot(m))

      // Dirty a different bank after the snapshot; restoring must undo it.
      bank.write(RAMBank.BANK_CONTROL_REGISTER, 9)
      bank.write(0x020, 0x99)

      restoreSnapshot(m, snapshot)

      bank.write(RAMBank.BANK_CONTROL_REGISTER, 3)
      expect(bank.read(0x010)).toBe(0x5a)
      bank.write(RAMBank.BANK_CONTROL_REGISTER, 9)
      expect(bank.read(0x020)).toBe(0x00)
    })
  })

  describe('the CF card', () => {
    it('carries the written sectors rather than the whole image', () => {
      const m = machine()
      const storage = m.io4 as Storage
      writeSector(storage, 5, 0xaa)

      const state = captureSnapshot(m).slots[3]!

      expect(state.sectors).toEqual([5])
      expect((state.data as string).length).toBeLessThan(1024)
    })

    it('reverts sectors written after the snapshot, not just those in it', () => {
      const m = machine()
      const storage = m.io4 as Storage

      writeSector(storage, 5, 0xaa)
      const snapshot = wire(captureSnapshot(m))
      const expected = cfImage(storage)

      // The case a snapshot that only re-applied its own sectors would get
      // wrong: sector 9 is not in the snapshot at all, so it has to come back
      // from the baseline journal.
      writeSector(storage, 9, 0xbb)
      writeSector(storage, 5, 0xcc)

      restoreSnapshot(m, snapshot)

      expect(cfImage(storage)).toEqual(expected)
    })

    it('leaves the restored sectors needing a save', () => {
      const m = machine()
      const storage = m.io4 as Storage
      writeSector(storage, 5, 0xaa)
      const snapshot = wire(captureSnapshot(m))

      writeSector(storage, 9, 0xbb)
      storage.clearDirty()
      expect(storage.isDirty()).toBe(false)

      restoreSnapshot(m, snapshot)

      // Sector 9 went back to zeros and sector 5 was rewritten; the copy on
      // disk is now stale, and a restore that did not say so would lose both
      // at the next autosave.
      expect(storage.isDirty()).toBe(true)
    })

    it('refuses a snapshot from a differently sized card', () => {
      const snapshot = captureSnapshot(machine())
      const bigger = machine({ io4: new Storage(CF_SIZE * 2) })

      expect(() => restoreSnapshot(bigger, snapshot)).toThrow(/storage.size/)
    })

    it('keeps a half-finished sector write going', () => {
      const m = machine()
      const storage = m.io4 as Storage

      storage.write(0x02, 1)
      storage.write(0x03, 4)
      storage.write(0x07, 0x30)
      for (let i = 0; i < 100; i++) storage.write(0x00, 0x77)

      const restored = machine()
      restoreSnapshot(restored, wire(captureSnapshot(m)))
      const target = restored.io4 as Storage

      // Finish the write on the restored card; the first 100 bytes were already
      // in its transfer buffer, so the sector must come out complete.
      for (let i = 100; i < Storage.SECTOR_SIZE; i++) target.write(0x00, 0x77)

      for (let i = 0; i < Storage.SECTOR_SIZE; i++) {
        expect(target.readImage(4 * Storage.SECTOR_SIZE + i)).toBe(0x77)
      }
    })
  })

  describe('which video card', () => {
    /** A machine like `machine()` with the given card in io8. */
    const withCard = (card: 'tms9918a' | 'picovdp', rom: Uint8Array = BIOS): Machine => {
      const m = new Machine({ io4: new Storage(CF_SIZE), io8: card === 'tms9918a' ? new TMS9918A() : new Video() })
      m.loadROM(rom)
      m.reset(true)
      return m
    }

    it('names the card in io8, or null when it is empty', () => {
      expect(captureSnapshot(machine()).vdp).toBeNull()
      expect(captureSnapshot(withCard('picovdp')).vdp).toBe('picovdp')
      expect(captureSnapshot(withCard('tms9918a')).vdp).toBe('tms9918a')
    })

    it('round-trips a TMS9918A', () => {
      const m = withCard('tms9918a')
      const video = m.io8 as TMS9918A
      video.setRegister(1, 0x50)
      video.writeVRAM(0x3fff, 0x42)

      const restored = withCard('tms9918a')
      restoreSnapshot(restored, wire(captureSnapshot(m)))
      expect(restored.video()!.readVRAM(0x3fff)).toBe(0x42)
      expect((restored.io8 as TMS9918A).isDisplayEnabled()).toBe(true)
    })

    it('refuses the other card, naming both and the flag, even when forced', () => {
      const pico = wire(captureSnapshot(withCard('picovdp')))
      const tms = wire(captureSnapshot(withCard('tms9918a')))

      expect(() => restoreSnapshot(withCard('tms9918a'), pico)).toThrow(
        'snapshot: taken with the picovdp video card; this machine has tms9918a — ' +
          'relaunch with --vdp picovdp (or choose it in Settings)'
      )
      expect(() => restoreSnapshot(withCard('picovdp'), tms, { force: true })).toThrow(
        'snapshot: taken with the tms9918a video card; this machine has picovdp — ' +
          'relaunch with --vdp tms9918a (or choose it in Settings)'
      )
    })

    it('checks the card before the ROM', () => {
      const patched = new Uint8Array(BIOS)
      patched[0x100] = patched[0x100]! ^ 0xff
      const snapshot = captureSnapshot(withCard('tms9918a', patched))

      expect(() => restoreSnapshot(withCard('picovdp'), snapshot)).toThrow(/taken with the tms9918a video card/)
      expect(() => restoreSnapshot(withCard('tms9918a'), snapshot)).toThrow(/different ROM/)
    })

    it('reads a version 2 snapshot as a PICOVDP', () => {
      const m = withCard('picovdp')
      m.runCycles(20_000)
      const { vdp: _vdp, ...rest } = wire(captureSnapshot(m))
      const version2 = { ...rest, version: 2 }

      const restored = withCard('picovdp')
      expect(restoreSnapshot(restored, version2).version).toBe(2)
      expect(restored.cpu.pc).toBe(m.cpu.pc)
      expect(() => restoreSnapshot(withCard('tms9918a'), version2)).toThrow(
        /taken with the picovdp video card; this machine has tms9918a — relaunch with --vdp picovdp/
      )
    })

    it('refuses a vdp that names no card, or disagrees with io8', () => {
      const good = captureSnapshot(withCard('picovdp'))
      expect(() => restoreSnapshot(withCard('picovdp'), { ...good, vdp: 'vga' })).toThrow(/snapshot\.vdp: expected/)
      expect(() => restoreSnapshot(withCard('picovdp'), { ...good, vdp: undefined })).toThrow(/snapshot\.vdp/)
      expect(() => restoreSnapshot(withCard('picovdp'), { ...good, vdp: null })).toThrow(
        /snapshot\.vdp: null does not match io8, which holds a video card/
      )
      const serial = captureSnapshot(machine())
      expect(() => restoreSnapshot(machine(), { ...serial, vdp: 'tms9918a' })).toThrow(
        /does not match io8, which holds a empty card/
      )
    })

    describe('a version 1 snapshot from emulator 2.7.0', () => {
      /**
       * Saved by v2.7.0's CLI (`run --headless --console video --rtc
       * 2026-01-01T00:00:00`, 7,000,000 cycles, `dbg state save`) at BASIC's
       * OK prompt, on the BIOS 1.6 this repository bundles, with a 64 KB
       * `--cf` image so that it fits `CF_SIZE`.
       */
      const V1 = JSON.parse(
        readFileSync(join(__dirname, '../fixtures/snapshot-v1-tms9918a.json'), 'utf8')
      ) as Record<string, unknown>

      /**
       * The BIOS 1.6 it was saved against. The bundled 1.6 has since been
       * rebuilt three times (6502-BIOS `27bd4e0`, BASIC lowers RTS as it reads;
       * `f858890`, the serial output path drops RTS around each byte; and the
       * `v1.6` tag as it stands, which adds the ring, IRQ and flooded-console
       * fixes the bench turned up), which a snapshot rightly refuses to restore
       * onto without force. The version string says `v1.6` throughout.
       */
      const BIOS_2_7_0 = readFileSync(join(__dirname, '../fixtures/BIOS-1.6-emulator-2.7.0.bin'))

      const tmsMachine = (rom: Uint8Array = BIOS_2_7_0): Machine => {
        const m = new Machine({ io4: new Storage(CF_SIZE), io8: new TMS9918A() })
        m.loadROM(rom)
        m.reset(true)
        return m
      }

      it('is version 1, names no card, and holds a TMS9918A', () => {
        expect(V1.version).toBe(1)
        expect(V1.vdp).toBeUndefined()
        expect((V1.slots as { kind: string }[])[7]!.kind).toBe('video')
      })

      it('is refused on the rebuilt BIOS 1.6 without force, naming the ROM', () => {
        expect(() => restoreSnapshot(tmsMachine(BIOS), V1)).toThrow(/taken against a different ROM \(cf427859/)
      })

      it('restores into a TMS9918A machine on the BIOS 1.6 it was saved on, with no force, at the prompt', () => {
        const m = tmsMachine()
        const result = restoreSnapshot(m, V1)

        expect(result).toEqual({ version: 1 })
        expect(m.cpu.pc).toBe((V1.cpu as { pc: number }).pc)
        const grid = m.video()!.textGrid()
        expect(grid.join('\n')).toMatch(/6502 BASIC V2\.0[^]*30718 BYTES FREE[^]*OK/)
        expect(m.video()!.getRegister(1) & 0x10).toBe(0x10) // Text mode

        // And it runs on from there: a frame later the picture is the prompt,
        // and BASIC answers a line typed at it.
        m.runCycles(40_000)
        expect(new Set(m.video()!.frameIndices()).size).toBeGreaterThan(1)
        for (const character of 'PRINT 2+2\r') {
          m.onReceive(character.charCodeAt(0))
          m.runCycles(20_000)
        }
        m.runCycles(200_000)
        expect(m.video()!.textGrid().join('\n')).toMatch(/PRINT 2\+2\s*\n\s*4\s*\n\s*\nOK/)
      })

      it('is refused on the PICOVDP, naming the card to relaunch with', () => {
        const m = new Machine({ io4: new Storage(CF_SIZE), io8: new Video() })
        m.loadROM(BIOS)
        m.reset(true)
        expect(() => restoreSnapshot(m, V1)).toThrow(
          'snapshot: taken with the tms9918a video card; this machine has picovdp — ' +
            'relaunch with --vdp tms9918a (or choose it in Settings)'
        )
      })
    })
  })

  describe('the video card', () => {
    it('round-trips VRAM and the registers, and recomputes the mode', () => {
      const m = machine({ io8: new Video() })
      const video = m.io8 as Video

      video.setRegister(1, 0x10) // text mode
      video.writeVRAM(0x1234, 0x42)

      const restored = machine({ io8: new Video() })
      restoreSnapshot(restored, wire(captureSnapshot(m)))
      const target = restored.io8 as Video

      expect(target.readVRAM(0x1234)).toBe(0x42)
      // Not only equal to the source: equal to something a fresh card is not,
      // so a restore that forgot to recompute the mode cannot pass by default.
      expect(target.getMode()).toEqual(video.getMode())
      expect(target.getMode().legacy).toBe('text')
    })

    it('does not carry the framebuffers', () => {
      const m = machine({ io8: new Video() })
      const state = captureSnapshot(m).slots[7]!

      expect(state.buffer).toBeUndefined()
      expect(state.backBuffer).toBeUndefined()
      expect(state.indexBuffer).toBeUndefined()
      // Two frames of RGBA and an index frame are 675 KB between them; what is
      // actually carried is 64 KB of VRAM, base64'd, and change. The bound moved
      // with the VDP's VRAM — 16 KB became 64 — and not because anything new is
      // being stored.
      expect(JSON.stringify(state).length).toBeLessThan(96 * 1024)
    })

    it('round-trips both port pairs independently (§4)', () => {
      const m = machine({ io8: new Video() })
      const video = m.io8 as Video

      // Park port A mid-command with a payload latched, and point port B
      // somewhere else entirely — the state a snapshot has to preserve if an
      // interrupt handler using port B is to survive a save and restore.
      video.write(1, 0x34)
      video.write(1, 0x52) // port A: write pointer $1234
      video.write(3, 0x00)
      video.write(3, 0x20) // port B: read pointer $2000, prefetched
      video.write(1, 0x99) // port A: first half of a command pair, unfinished

      const restored = machine({ io8: new Video() })
      restoreSnapshot(restored, wire(captureSnapshot(m)))
      const target = restored.io8 as Video

      // Port A completes the command it was halfway through, onto register 7.
      target.write(1, 0x87)
      expect(target.getRegister(7)).toBe(0x99)

      // Both pointers are where they were: port A still writing at $1234, port
      // B still reading from $2000.
      target.write(0, 0xab)
      expect(target.readVRAM(0x1234)).toBe(0xab)
      target.writeVRAM(0x2000, 0x5a)
      target.read(2) // the byte prefetched before the snapshot
      expect(target.read(2)).toBe(0x00) // $2001, still empty
    })
  })

  describe('the real-time clock', () => {
    it('round-trips both the user-visible and internal time', () => {
      const m = machine()
      const rtc = m.io3 as RTC

      rtc.write(0x0f, 0x80) // TE high — buffer user writes
      rtc.write(0x00, 0x33) // seconds = 33 BCD
      const beforeCommit = captureSnapshot(m)

      const restored = machine()
      restoreSnapshot(restored, wire(beforeCommit))
      const target = restored.io3 as RTC

      // The write is still buffered; committing it on the restored card has to
      // produce the same time, which only works if both copies came along.
      target.write(0x0f, 0x00)
      rtc.write(0x0f, 0x00)
      expect(target.read(0x00)).toBe(rtc.read(0x00))
    })

    it('round-trips the battery-backed RAM', () => {
      const m = machine()
      ;(m.io3 as RTC).writeNVRAM(0x40, 0x5a)

      const restored = machine()
      restoreSnapshot(restored, wire(captureSnapshot(m)))

      expect((restored.io3 as RTC).readNVRAM(0x40)).toBe(0x5a)
    })
  })

  describe('the SID', () => {
    it('round-trips a voice mid-note', () => {
      const m = machine({ io7: new Sound() })
      const sound = m.io7 as Sound

      sound.write(0x18, 0x0f) // volume
      sound.write(0x00, 0x00)
      sound.write(0x01, 0x20) // frequency
      sound.write(0x04, 0x11) // triangle + gate
      m.runCycles(20_000)

      const restored = machine({ io7: new Sound() })
      restoreSnapshot(restored, wire(captureSnapshot(m)))
      const target = restored.io7 as Sound

      expect(target.getVoice(0).serialize()).toEqual(sound.getVoice(0).serialize())
      expect(target.getMasterVolume()).toBe(0x0f)
    })
  })

  describe('through a Session', () => {
    it('stops the machine, restores, and resumes in the mode it found', () => {
      const session = new Session({ io4: new Storage(CF_SIZE), io8: new Empty() })
      session.machine.loadROM(BIOS)
      session.reset(true)
      session.runCycles(200_000)

      const snapshot = wire(captureSnapshot(session.machine))
      session.runCycles(200_000)

      session.run('turbo')
      expect(session.isRunning).toBe(true)

      session.loadState(() => restoreSnapshot(session.machine, snapshot))

      expect(session.isRunning).toBe(true)
      expect(session.mode).toBe('turbo')
      session.pause()
    })

    it('leaves a paused machine paused', () => {
      const session = new Session({ io4: new Storage(CF_SIZE), io8: new Empty() })
      session.machine.loadROM(BIOS)
      session.reset(true)

      const snapshot = wire(captureSnapshot(session.machine))
      session.loadState(() => restoreSnapshot(session.machine, snapshot))

      expect(session.isRunning).toBe(false)
      expect(session.mode).toBe('paused')
    })
  })
})
