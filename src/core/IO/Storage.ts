import { IO } from '../IO'
import {
  StateError,
  expectKind,
  fromBase64,
  readBoolean,
  readBytes,
  readNumber,
  readString,
  toBase64
} from '../DeviceState'
import type { DeviceState } from '../DeviceState'

/**
 * What changed in the image since the last clearDirty().
 *
 * 'sectors' packs every dirty sector into one contiguous buffer rather than an
 * array of per-sector views. That is deliberate: structured-cloning a subarray
 * clones its *entire* backing ArrayBuffer, so handing out views of a 256 MB
 * image would send 256 MB per sector across the Electron IPC boundary.
 */
export type StorageDelta =
  | { kind: 'none' }
  /** The whole image was replaced. Use getData(). */
  | { kind: 'full' }
  | {
      kind: 'sectors'
      sectorSize: number
      /** Byte offset of each sector within the image, ascending. */
      offsets: number[]
      /** The sectors' bytes concatenated in `offsets` order. */
      data: Uint8Array
    }

/**
 * Storage - Emulates a Compact Flash card in 8-bit IDE mode
 *
 * Emulates a CF card with ATA-style register interface.
 * Default size is 32MB. Size is configurable via constructor or loadData.
 * Uses LBA (Logical Block Addressing) for sector access.
 * 
 * Register Map (address & 0x07):
 * $00: Data Register (read/write)
 * $01: Error Register (read) / Feature Register (write)
 * $02: Sector Count Register (read/write)
 * $03: LBA0 Register (read/write) - bits 0-7 of LBA
 * $04: LBA1 Register (read/write) - bits 8-15 of LBA
 * $05: LBA2 Register (read/write) - bits 16-23 of LBA
 * $06: LBA3 Register (read/write) - bits 24-27 of LBA + mode bits
 * $07: Status Register (read) / Command Register (write)
 * 
 * Supported Commands:
 * 0x20, 0x21: Read Sector(s)
 * 0x30, 0x31: Write Sector(s)
 * 0xC0: Erase Sector
 * 0xEC: Identify Drive
 * 0xEF: Set Features (accepted but not implemented)
 */
export class Storage implements IO {

  readonly kind = 'storage'

  // Constants
  static readonly DEFAULT_STORAGE_SIZE = 32 * 1024 * 1024  // 32MB
  static readonly SECTOR_SIZE = 512

  // Instance size properties
  private storageSize: number
  private totalSectors: number

  // Status Register Flags
  private static readonly STATUS_ERR = 0x01  // Error
  private static readonly STATUS_DRQ = 0x08  // Data Request
  private static readonly STATUS_RDY = 0x40  // Ready

  // Error Register Flags
  private static readonly ERR_AMNF = 0x01    // Address Mark Not Found
  private static readonly ERR_ABRT = 0x04    // Aborted Command
  private static readonly ERR_IDNF = 0x10    // ID Not Found

  // Storage and Identity data (in-memory simulation)
  private storage: Uint8Array
  private identity: Uint8Array

  // Data buffer (512 bytes)
  private buffer: Uint8Array = new Uint8Array(Storage.SECTOR_SIZE)
  private bufferIndex: number = 0
  private commandDataSize: number = Storage.SECTOR_SIZE
  private sectorOffset: number = 0

  // Registers
  private error: number = 0x00
  private feature: number = 0x00
  private sectorCount: number = 0x00
  private lba0: number = 0x00
  private lba1: number = 0x00
  private lba2: number = 0x00
  private lba3: number = 0xE0
  private status: number = 0x00
  private command: number = 0x00

  // State flags
  private isIdentifying: boolean = false
  private isTransferring: boolean = false

  // ── Dirty tracking ─────────────────────────────────────────────────────────
  //
  // Persistence used to copy and ship the entire image every 30 s, which stalled
  // the renderer long enough to starve the audio queue. Tracking which sectors
  // actually changed lets a save move kilobytes, or be skipped outright — which
  // is the common case, since most sessions never write to the card.
  //
  // The bias here is deliberately toward over-saving: a redundant write costs
  // time, a missed one costs data.

  /** Sector indices written since the last clearDirty(). */
  private dirtySectors: Set<number> = new Set()

  /** Set when the whole image was replaced, making per-sector tracking moot. */
  private allDirty: boolean = false

  // ── Snapshot baseline ──────────────────────────────────────────────────────
  //
  // Persistence's dirty set is cleared every time a save succeeds, so it cannot
  // answer the question a snapshot asks: which sectors differ from the image
  // this card was loaded with, and what did they hold before? Two structures
  // answer it, and they are what make a 256 MB card snapshottable at all.

  /** Every sector written since the image was loaded. Never cleared by a save. */
  private writtenSectors: Set<number> = new Set()

  /**
   * Each written sector's contents *before* the first write to it.
   *
   * A restore has to undo writes the snapshot never saw — a test case that wrote
   * sector 900 after the snapshot was taken must not leave sector 900 modified
   * for the next test, or restoring is not isolation. That needs the original
   * bytes, which only a copy-on-write journal can supply.
   *
   * Bounded by how much the program actually writes, not by the size of the
   * card: a BASIC session that never touches disk journals nothing, and one
   * that writes a 4 KB file journals 4 KB.
   */
  private baselineSectors: Map<number, Uint8Array> = new Map()

  constructor(size: number = Storage.DEFAULT_STORAGE_SIZE) {
    // Initialize storage and identity buffers
    this.storageSize = size
    this.totalSectors = Math.floor(size / Storage.SECTOR_SIZE)
    this.storage = new Uint8Array(this.storageSize)
    this.identity = new Uint8Array(Storage.SECTOR_SIZE)
    this.generateIdentity()
    this.reset(true)
  }

  read(address: number): number {
    switch (address & 0x0007) {
      case 0x00: // Data Register
        return this.readBuffer()
      case 0x01: // Error Register
        return this.error
      case 0x02: // Sector Count Register
        return this.sectorCount
      case 0x03: // LBA0 Register
        return this.lba0
      case 0x04: // LBA1 Register
        return this.lba1
      case 0x05: // LBA2 Register
        return this.lba2
      case 0x06: // LBA3 Register
        return this.lba3
      case 0x07: // Status Register
        return this.status
      default:
        return 0x00
    }
  }

  write(address: number, data: number): void {
    switch (address & 0x0007) {
      case 0x00: // Data Register
        this.writeBuffer(data)
        break
      case 0x01: // Feature Register
        this.feature = data
        break
      case 0x02: // Sector Count Register
        this.sectorCount = data
        break
      case 0x03: // LBA0 Register
        this.lba0 = data
        break
      case 0x04: // LBA1 Register
        this.lba1 = data
        break
      case 0x05: // LBA2 Register
        this.lba2 = data
        break
      case 0x06: // LBA3 Register
        this.lba3 = (data & 0x0F) | 0xE0
        break
      case 0x07: // Command Register
        this.command = data
        this.executeCommand()
        break
    }
  }

  tick(frequency: number): number {
    return 0
  }

  reset(coldStart: boolean): void {
    this.bufferIndex = 0x0000
    this.commandDataSize = Storage.SECTOR_SIZE
    this.sectorOffset = 0

    this.error = 0x00
    this.feature = 0x00
    this.sectorCount = 0x00
    this.lba0 = 0x00
    this.lba1 = 0x00
    this.lba2 = 0x00
    this.lba3 = 0xE0
    this.status = 0x00 | Storage.STATUS_RDY
    this.command = 0x00

    this.isIdentifying = false
    this.isTransferring = false

    this.buffer.fill(0x00)
  }

  //
  // Private methods
  //

  private executeCommand(): void {
    // New command so clear errors and flags
    this.status &= ~Storage.STATUS_ERR
    this.status &= ~Storage.STATUS_DRQ
    this.error = 0x00
    this.commandDataSize = Storage.SECTOR_SIZE * this.sectorCount
    this.bufferIndex = 0
    this.sectorOffset = 0

    // Check if already executing a command
    if (this.isTransferring || this.isIdentifying) {
      this.status |= Storage.STATUS_ERR
      this.error |= Storage.ERR_ABRT
      return
    }

    switch (this.command) {
      case 0xC0: { // Erase sector
        if (!this.sectorValid()) {
          this.status |= Storage.STATUS_ERR
          this.error |= Storage.ERR_ABRT | Storage.ERR_IDNF
        } else {
          const eraseSector = this.sectorIndex()
          const eraseOffset = eraseSector * Storage.SECTOR_SIZE
          this.touchSector(eraseSector)
          this.storage.fill(0x00, eraseOffset, eraseOffset + Storage.SECTOR_SIZE)
        }
        break
      }

      case 0xEC: { // Identify drive
        this.buffer.set(this.identity.subarray(0, Storage.SECTOR_SIZE))
        this.commandDataSize = Storage.SECTOR_SIZE
        this.status |= Storage.STATUS_DRQ
        this.isIdentifying = true
        break
      }

      case 0x20: // Read sector
      case 0x21:
        if (!this.sectorValid()) {
          this.status |= Storage.STATUS_ERR
          this.error |= Storage.ERR_ABRT | Storage.ERR_IDNF
        } else {
          // Load first sector into buffer
          const offset = this.sectorIndex() * Storage.SECTOR_SIZE
          this.buffer.set(this.storage.subarray(offset, offset + Storage.SECTOR_SIZE))
          this.status |= Storage.STATUS_DRQ
          this.isTransferring = true
        }
        break

      case 0xEF: // Set features
        // We don't support setting features but accept them without error
        break

      case 0x30: // Write sector
      case 0x31:
        if (!this.sectorValid()) {
          this.status |= Storage.STATUS_ERR
          this.error |= Storage.ERR_ABRT | Storage.ERR_IDNF
        } else {
          this.status |= Storage.STATUS_DRQ
          this.isTransferring = true
        }
        break

      default:
        // Unsupported command
        this.status |= Storage.STATUS_ERR
        this.error |= Storage.ERR_ABRT
        break
    }
  }

  private readBuffer(): number {
    if (this.isIdentifying) {
      const data = this.buffer[this.bufferIndex]

      if (this.bufferIndex < this.commandDataSize - 1) {
        this.bufferIndex++
      } else {
        this.bufferIndex = 0
        this.isIdentifying = false
        this.status &= ~Storage.STATUS_DRQ
      }

      return data
    } else if (this.isTransferring) {
      const data = this.buffer[this.bufferIndex]

      if (this.bufferIndex < Storage.SECTOR_SIZE - 1) {
        this.bufferIndex++
      } else {
        this.bufferIndex = 0
        this.sectorOffset++

        if (this.sectorOffset < this.sectorCount) {
          // Load the next sector
          const offset = (this.sectorIndex() + this.sectorOffset) * Storage.SECTOR_SIZE
          this.buffer.set(this.storage.subarray(offset, offset + Storage.SECTOR_SIZE))
        } else {
          this.isTransferring = false
          this.status &= ~Storage.STATUS_DRQ
        }
      }

      return data
    } else {
      return 0x00
    }
  }

  private writeBuffer(value: number): void {
    this.buffer[this.bufferIndex] = value

    if (this.bufferIndex < Storage.SECTOR_SIZE - 1) {
      this.bufferIndex++
    } else {
      this.bufferIndex = 0

      // Write the current sector to storage
      const sector = this.sectorIndex() + this.sectorOffset
      this.touchSector(sector)
      this.storage.set(this.buffer.subarray(0, Storage.SECTOR_SIZE), sector * Storage.SECTOR_SIZE)

      this.sectorOffset++

      // Check if all sectors have been written
      if (this.sectorOffset >= this.sectorCount) {
        this.isTransferring = false
        this.status &= ~Storage.STATUS_DRQ
      }
    }
  }

  /**
   * Note that a sector is about to change.
   *
   * Called before the mutation, not after, because the baseline journal needs
   * the bytes that are still there. Every mutation path goes through it —
   * sector write, sector erase and a debugger's writeImage are the only three —
   * and a new one that forgot to would lose data at the next save and lose
   * isolation at the next snapshot restore.
   */
  private touchSector(sector: number): void {
    if (!this.writtenSectors.has(sector)) {
      const from = sector * Storage.SECTOR_SIZE
      this.baselineSectors.set(sector, this.storage.slice(from, from + Storage.SECTOR_SIZE))
      this.writtenSectors.add(sector)
    }
    if (!this.allDirty) this.dirtySectors.add(sector)
  }

  private sectorIndex(): number {
    return ((this.lba3 & 0x0F) << 24) | (this.lba2 << 16) | (this.lba1 << 8) | this.lba0
  }

  private sectorValid(): boolean {
    return this.sectorIndex() < this.totalSectors
  }

  private generateIdentity(): void {
    // Generate emulated CF card identity based on current storage size

    // Fill with zeros first
    this.identity.fill(0x00)

    // Compute CHS geometry from sector count
    const totalSectors = this.totalSectors
    const heads = 16
    const sectorsPerTrack = 32
    const cylinders = Math.floor(totalSectors / (heads * sectorsPerTrack))

    // Word 0: General configuration
    this.identity[0] = 0x84
    this.identity[1] = 0x8A  // Removable Disk

    // Word 1: Number of cylinders
    this.identity[2] = cylinders & 0xFF
    this.identity[3] = (cylinders >> 8) & 0xFF

    // Word 2: Reserved
    this.identity[4] = 0x00
    this.identity[5] = 0x00

    // Word 3: Number of heads
    this.identity[6] = heads & 0xFF
    this.identity[7] = (heads >> 8) & 0xFF

    // Word 4: Unformatted bytes per track
    this.identity[8] = 0x00
    this.identity[9] = 0x40

    // Word 5: Unformatted bytes per sector
    this.identity[10] = 0x00
    this.identity[11] = 0x02

    // Word 6: Sectors per track
    this.identity[12] = sectorsPerTrack & 0xFF
    this.identity[13] = (sectorsPerTrack >> 8) & 0xFF

    // Words 7-9: Reserved
    this.identity[14] = 0x04
    this.identity[15] = 0x00
    this.identity[16] = 0x00
    this.identity[17] = 0x00
    this.identity[18] = 0x00
    this.identity[19] = 0x00

    // Words 10-19: Serial number (20 ASCII characters)
    const serial = 'ACWD6502EMUCF1010101'
    for (let i = 0; i < serial.length; i++) {
      this.identity[20 + i] = serial.charCodeAt(i)
    }

    // Word 20: Buffer type
    this.identity[40] = 0x01
    this.identity[41] = 0x00

    // Word 21: Buffer size in 512 byte increments
    this.identity[42] = 0x04
    this.identity[43] = 0x00

    // Word 22: ECC bytes
    this.identity[44] = 0x04
    this.identity[45] = 0x00

    // Words 23-26: Firmware revision (8 ASCII characters)
    const firmware = '1.0     '
    for (let i = 0; i < firmware.length; i++) {
      this.identity[46 + i] = firmware.charCodeAt(i)
    }

    // Words 27-46: Model number (40 ASCII characters)
    const model = 'ACWD6502EMUCF                       '
    for (let i = 0; i < model.length; i++) {
      this.identity[54 + i] = model.charCodeAt(i)
    }

    // Word 47: Multiple sector setting
    this.identity[94] = 0x01
    this.identity[95] = 0x00

    // Word 48: Double word not supported
    this.identity[96] = 0x00
    this.identity[97] = 0x00

    // Word 49: Capabilities (LBA supported)
    this.identity[98] = 0x00
    this.identity[99] = 0x02

    // Word 50: Reserved
    this.identity[100] = 0x00
    this.identity[101] = 0x00

    // Word 51: PIO data transfer cycle timing
    this.identity[102] = 0x00
    this.identity[103] = 0x02

    // Word 52: DMA transfer cycle timing
    this.identity[104] = 0x00
    this.identity[105] = 0x00

    // Word 53: Field validity
    this.identity[106] = 0x01
    this.identity[107] = 0x00

    // Word 54: Current number of cylinders
    this.identity[108] = cylinders & 0xFF
    this.identity[109] = (cylinders >> 8) & 0xFF

    // Word 55: Current number of heads
    this.identity[110] = heads & 0xFF
    this.identity[111] = (heads >> 8) & 0xFF

    // Word 56: Current sectors per track
    this.identity[112] = sectorsPerTrack & 0xFF
    this.identity[113] = (sectorsPerTrack >> 8) & 0xFF

    // Words 57-58: Current capacity in sectors
    this.identity[114] = totalSectors & 0xFF
    this.identity[115] = (totalSectors >> 8) & 0xFF
    this.identity[116] = (totalSectors >> 16) & 0xFF
    this.identity[117] = (totalSectors >> 24) & 0xFF

    // Word 59: Multiple sector setting
    this.identity[118] = 0x01
    this.identity[119] = 0x01

    // Words 60-61: Total number of sectors in LBA mode
    this.identity[120] = totalSectors & 0xFF
    this.identity[121] = (totalSectors >> 8) & 0xFF
    this.identity[122] = (totalSectors >> 16) & 0xFF
    this.identity[123] = (totalSectors >> 24) & 0xFF

    // Remaining words are zero
  }

  /**
   * Load storage data from a Uint8Array, ArrayBuffer, or number array
   * Resizes storage to match the loaded data if it is a valid multiple of the sector size
   *
   * Marks the whole image dirty, because the caller could be loading a file the
   * persistence store has never seen (a user-picked CF image on the web build).
   * Callers that know the new contents already match what is persisted — chiefly
   * the startup load — should follow with clearDirty().
   */
  loadData(data: Uint8Array | ArrayBuffer | number[] | null): void {
    if (!data) {
      console.log('No storage data provided. Storage will remain empty.')
      return
    }

    let uint8Data: Uint8Array
    if (data instanceof ArrayBuffer) {
      uint8Data = new Uint8Array(data)
    } else if (data instanceof Uint8Array) {
      uint8Data = data
    } else {
      uint8Data = new Uint8Array(data)
    }

    if (uint8Data.length === 0) {
      this.storage.fill(0x00)
      this.markAllDirty()
      console.log('Storage initialized as new empty image.')
    } else if (uint8Data.length % Storage.SECTOR_SIZE === 0) {
      this.storageSize = uint8Data.length
      this.totalSectors = this.storageSize / Storage.SECTOR_SIZE
      this.storage = new Uint8Array(this.storageSize)
      this.storage.set(uint8Data)
      this.generateIdentity()
      this.markAllDirty()
      console.log(`Storage loaded (${this.storageSize} bytes)`)
    } else {
      console.warn(`Warning: Storage data size (${uint8Data.length} bytes) is not a multiple of sector size (${Storage.SECTOR_SIZE}).`)
      console.warn('Storage will remain empty.')
    }
  }

  /**
   * Get storage data as Uint8Array for saving
   */
  getData(): Uint8Array {
    return new Uint8Array(this.storage)
  }

  //
  // Dirty tracking
  //

  /** True when the image has changed since the last clearDirty(). */
  isDirty(): boolean {
    return this.allDirty || this.dirtySectors.size > 0
  }

  /**
   * Treat the entire image as changed.
   *
   * Also resets the snapshot baseline: the image is now something the card has
   * never written to, so nothing is outstanding to revert and any journal of the
   * previous image's contents would be a record of bytes that no longer exist.
   */
  markAllDirty(): void {
    this.allDirty = true
    this.dirtySectors.clear()
    this.writtenSectors.clear()
    this.baselineSectors.clear()
  }

  /**
   * What has changed since the last clearDirty(), ready to hand to a persistence
   * layer. Does not clear the dirty state — call clearDirty() only once the save
   * has actually succeeded, so a failed save is retried rather than lost.
   */
  getDelta(): StorageDelta {
    if (this.allDirty) return { kind: 'full' }
    if (this.dirtySectors.size === 0) return { kind: 'none' }

    // No dirty-count threshold on purpose. A delta is never bigger than the
    // image, so falling back to a full save can only move more bytes, never
    // fewer. Per-write syscall overhead on a large delta is the writer's
    // problem, and it coalesces contiguous runs to handle it.
    const offsets = [...this.dirtySectors].sort((a, b) => a - b)
    const data = new Uint8Array(offsets.length * Storage.SECTOR_SIZE)

    offsets.forEach((sector, i) => {
      const from = sector * Storage.SECTOR_SIZE
      data.set(this.storage.subarray(from, from + Storage.SECTOR_SIZE), i * Storage.SECTOR_SIZE)
    })

    return {
      kind: 'sectors',
      sectorSize: Storage.SECTOR_SIZE,
      offsets: offsets.map((sector) => sector * Storage.SECTOR_SIZE),
      data
    }
  }

  /** Mark the image as matching its persisted copy. */
  clearDirty(): void {
    this.allDirty = false
    this.dirtySectors.clear()
  }

  //
  // Direct image access
  //
  // For a debugger inspecting the card outside the IDE register protocol —
  // reading a sector normally means driving eight registers through a command
  // sequence, which is not what "show me what is on the disk" should cost.

  get imageSize(): number {
    return this.storageSize
  }

  /** A byte of the image, or 0 past its end. */
  readImage(offset: number): number {
    return offset >= 0 && offset < this.storageSize ? this.storage[offset]! : 0
  }

  /**
   * Write a byte of the image, marking its sector dirty.
   *
   * Going through the dirty set matters: a debug write that skipped it would
   * look correct until the next save, then quietly revert.
   */
  writeImage(offset: number, value: number): void {
    if (offset < 0 || offset >= this.storageSize) return
    this.touchSector(Math.floor(offset / Storage.SECTOR_SIZE))
    this.storage[offset] = value & 0xff
  }

  //
  // Snapshots
  //

  /**
   * The card's registers, plus the sectors that differ from the loaded image.
   *
   * A 256 MB image is not something to put in a snapshot whole, and it does not
   * have to be: the image the card was loaded with is still on disk, so a
   * snapshot only needs the difference. That is the same delta mechanism Phase 1
   * built for the autosave fix, which is why §5.9 wanted it sequenced first.
   *
   * The transfer buffer is included because a snapshot can land mid-command,
   * halfway through the 512 bytes of a sector write, and resuming has to finish
   * that write with the bytes the program had already sent.
   */
  serialize(): DeviceState {
    const sectors = [...this.writtenSectors].sort((a, b) => a - b)
    const data = new Uint8Array(sectors.length * Storage.SECTOR_SIZE)

    sectors.forEach((sector, i) => {
      const from = sector * Storage.SECTOR_SIZE
      data.set(this.storage.subarray(from, from + Storage.SECTOR_SIZE), i * Storage.SECTOR_SIZE)
    })

    return {
      kind: this.kind,
      size: this.storageSize,
      sectorSize: Storage.SECTOR_SIZE,
      sectors,
      data: toBase64(data),
      buffer: toBase64(this.buffer),
      bufferIndex: this.bufferIndex,
      commandDataSize: this.commandDataSize,
      sectorOffset: this.sectorOffset,
      error: this.error,
      feature: this.feature,
      sectorCount: this.sectorCount,
      lba0: this.lba0,
      lba1: this.lba1,
      lba2: this.lba2,
      lba3: this.lba3,
      status: this.status,
      command: this.command,
      isIdentifying: this.isIdentifying,
      isTransferring: this.isTransferring
    }
  }

  deserialize(state: DeviceState): void {
    expectKind(state, this.kind)

    const size = readNumber(state, 'size')
    if (size !== this.storageSize) {
      throw new StateError(
        `storage.size: the snapshot was taken with a ${size}-byte card, this one is ${this.storageSize}`
      )
    }
    const sectorSize = readNumber(state, 'sectorSize')
    if (sectorSize !== Storage.SECTOR_SIZE) {
      throw new StateError(`storage.sectorSize: expected ${Storage.SECTOR_SIZE}, got ${sectorSize}`)
    }

    const sectors = state.sectors
    if (!Array.isArray(sectors)) throw new StateError('storage.sectors: expected an array')
    const data = fromBase64(readString(state, 'data'), 'storage.data')
    if (data.length !== sectors.length * Storage.SECTOR_SIZE) {
      throw new StateError(
        `storage.data: ${sectors.length} sectors need ${sectors.length * Storage.SECTOR_SIZE} bytes, got ${data.length}`
      )
    }

    // Undo everything written since the image was loaded, then lay the
    // snapshot's sectors on top. Reverting first is what makes a restore
    // isolation rather than a merge: without it, a sector the program wrote
    // *after* the snapshot was taken — and which therefore is not in the
    // snapshot — would keep its later contents.
    for (const [sector, original] of this.baselineSectors) {
      this.storage.set(original, sector * Storage.SECTOR_SIZE)
      this.dirtySectors.add(sector)
    }
    this.writtenSectors.clear()

    sectors.forEach((sector, i) => {
      if (typeof sector !== 'number' || !Number.isInteger(sector) || sector < 0 || sector >= this.totalSectors) {
        throw new StateError(`storage.sectors[${i}]: ${JSON.stringify(sector)} is not a sector of this card`)
      }
      // Through touchSector so the reverted-to-baseline journal is rebuilt for
      // this sector and persistence is told the on-disk copy is now stale.
      this.touchSector(sector)
      this.storage.set(
        data.subarray(i * Storage.SECTOR_SIZE, (i + 1) * Storage.SECTOR_SIZE),
        sector * Storage.SECTOR_SIZE
      )
    })

    this.buffer.set(readBytes(state, 'buffer', Storage.SECTOR_SIZE))
    this.bufferIndex = readNumber(state, 'bufferIndex')
    this.commandDataSize = readNumber(state, 'commandDataSize')
    this.sectorOffset = readNumber(state, 'sectorOffset')
    this.error = readNumber(state, 'error')
    this.feature = readNumber(state, 'feature')
    this.sectorCount = readNumber(state, 'sectorCount')
    this.lba0 = readNumber(state, 'lba0')
    this.lba1 = readNumber(state, 'lba1')
    this.lba2 = readNumber(state, 'lba2')
    this.lba3 = readNumber(state, 'lba3')
    this.status = readNumber(state, 'status')
    this.command = readNumber(state, 'command')
    this.isIdentifying = readBoolean(state, 'isIdentifying')
    this.isTransferring = readBoolean(state, 'isTransferring')
  }

}