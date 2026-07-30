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
import { Session } from '../../debug/Session'
import {
  captureSnapshot,
  restoreSnapshot,
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
      const m = machine()
      m.frequency = 2_000_000

      const snapshot = captureSnapshot(m)

      expect(snapshot.format).toBe(SNAPSHOT_FORMAT)
      expect(snapshot.version).toBe(SNAPSHOT_VERSION)
      expect(snapshot.frequency).toBe(2_000_000)
      expect(snapshot.slots).toHaveLength(8)
      expect(Date.parse(snapshot.createdAt)).not.toBeNaN()
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
      expect(() => restoreSnapshot(target, snapshot)).toThrow(StateError)
      expect(target.cpu.pc).toBe(pcBefore)
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
      expect(target.getMode()).toBe(video.getMode())
    })

    it('does not carry the framebuffers', () => {
      const m = machine({ io8: new Video() })
      const state = captureSnapshot(m).slots[7]!

      expect(state.buffer).toBeUndefined()
      expect(state.backBuffer).toBeUndefined()
      // A frame of RGBA is 300 KB; the whole card's state must be far less.
      expect(JSON.stringify(state).length).toBeLessThan(64 * 1024)
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
