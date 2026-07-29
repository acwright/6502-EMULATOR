import { app, dialog } from 'electron'
import { readFile, writeFile, mkdir, open } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { BrowserWindow } from 'electron'
import type { CFSectorWrite } from '../shared/types'

/**
 * CF card: 256 disks × 1 MB = 256 MB total (mirrors the real machine).
 * NVRAM: 256 bytes (DS1511Y+ battery-backed registers).
 */
const CF_SIZE = 256 * 1024 * 1024
const NVRAM_SIZE = 256

const DEFAULT_CF_FILE = 'storage.img'
const DEFAULT_NVRAM_FILE = 'nvram.bin'

export class StorageService {
  private readonly userDataDir: string
  private cfPath: string
  private nvramPath: string

  // In-memory caches so we don't re-read large files on every IPC call.
  private cfCache: Uint8Array | null = null
  private nvramCache: Uint8Array | null = null

  /**
   * Resolves once the CF file exists at full size on disk. First launch creates
   * it in the background, and a positional write into a file that is still being
   * laid down would land at the wrong place or extend it with a hole.
   */
  private cfFileReady: Promise<void> = Promise.resolve()

  constructor() {
    this.userDataDir = app.getPath('userData')
    this.cfPath = join(this.userDataDir, DEFAULT_CF_FILE)
    this.nvramPath = join(this.userDataDir, DEFAULT_NVRAM_FILE)
  }

  async init(): Promise<void> {
    await mkdir(this.userDataDir, { recursive: true })
  }

  // ── CF card ────────────────────────────────────────────────────────────────

  async loadCF(): Promise<Uint8Array> {
    if (this.cfCache) return this.cfCache
    try {
      if (existsSync(this.cfPath)) {
        const buf = await readFile(this.cfPath)
        this.cfCache = new Uint8Array(buf)
      } else {
        // First launch: create an empty 256 MB image.
        // Return it immediately and save to disk in the background.
        this.cfCache = new Uint8Array(CF_SIZE)
        this.cfFileReady = writeFile(this.cfPath, Buffer.from(this.cfCache)).catch((e) =>
          console.error('[storage] initial CF create:', e)
        )
      }
    } catch (e) {
      console.error('[storage] loadCF:', e)
      this.cfCache = new Uint8Array(CF_SIZE)
    }
    return this.cfCache
  }

  async saveCF(data: Uint8Array): Promise<void> {
    // Update cache so a subsequent loadCF() returns the latest state.
    this.cfCache = data
    try {
      // Zero-copy: wrap the Uint8Array's backing buffer.
      const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      await writeFile(this.cfPath, buf)
    } catch (e) {
      console.error('[storage] saveCF:', e)
    }
  }

  /**
   * Write only the sectors that changed, in place. A typical session dirties a
   * handful of 512-byte sectors, so this moves kilobytes where saveCF() moved
   * 256 MB.
   *
   * Throws on failure rather than swallowing: the renderer keeps its dirty set
   * until the save is confirmed, so a rejected promise means "retry next tick"
   * instead of silently losing the writes.
   */
  async saveCFSectors({ sectorSize, offsets, data }: CFSectorWrite): Promise<void> {
    if (offsets.length === 0) return
    await this.cfFileReady

    // Keep the cache in step so loadCF() doesn't hand back stale sectors.
    if (this.cfCache) {
      offsets.forEach((offset, i) => {
        this.cfCache!.set(data.subarray(i * sectorSize, (i + 1) * sectorSize), offset)
      })
    }

    // Coalesce contiguous sectors into single writes. Sequential writes are the
    // normal shape — saving a file touches a run of sectors — so this turns
    // thousands of syscalls into a handful without changing what lands on disk.
    const handle = await open(this.cfPath, 'r+')
    try {
      let runStart = 0
      for (let i = 1; i <= offsets.length; i++) {
        const contiguous =
          i < offsets.length && offsets[i]! === offsets[i - 1]! + sectorSize
        if (contiguous) continue

        await handle.write(
          data,
          runStart * sectorSize,
          (i - runStart) * sectorSize,
          offsets[runStart]!
        )
        runStart = i
      }
    } finally {
      await handle.close()
    }
  }

  // ── NVRAM ──────────────────────────────────────────────────────────────────

  async loadNVRAM(): Promise<Uint8Array> {
    if (this.nvramCache) return this.nvramCache
    try {
      if (existsSync(this.nvramPath)) {
        const buf = await readFile(this.nvramPath)
        this.nvramCache = new Uint8Array(buf)
      } else {
        this.nvramCache = new Uint8Array(NVRAM_SIZE)
        await writeFile(this.nvramPath, Buffer.from(this.nvramCache))
      }
    } catch (e) {
      console.error('[storage] loadNVRAM:', e)
      this.nvramCache = new Uint8Array(NVRAM_SIZE)
    }
    return this.nvramCache
  }

  async saveNVRAM(data: Uint8Array): Promise<void> {
    this.nvramCache = data
    try {
      const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      await writeFile(this.nvramPath, buf)
    } catch (e) {
      console.error('[storage] saveNVRAM:', e)
    }
  }

  // ── File pickers ───────────────────────────────────────────────────────────

  async pickCF(win: BrowserWindow): Promise<string | null> {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Select CF Card Image',
      filters: [
        { name: 'Disk Images', extensions: ['img', 'bin'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (canceled || filePaths.length === 0) return null
    const selected = filePaths[0]!
    try {
      const buf = await readFile(selected)
      this.cfCache = new Uint8Array(buf)
      this.cfPath = selected
      return selected
    } catch (e) {
      console.error('[storage] pickCF read:', e)
      return null
    }
  }

  async pickNVRAM(win: BrowserWindow): Promise<string | null> {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Select NVRAM File',
      filters: [
        { name: 'NVRAM Files', extensions: ['bin', 'nvram'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (canceled || filePaths.length === 0) return null
    const selected = filePaths[0]!
    try {
      const buf = await readFile(selected)
      this.nvramCache = new Uint8Array(buf)
      this.nvramPath = selected
      return selected
    } catch (e) {
      console.error('[storage] pickNVRAM read:', e)
      return null
    }
  }

  getCFPath(): string { return this.cfPath }
  getNVRAMPath(): string { return this.nvramPath }

  /**
   * Override the CF file path (e.g. from a persisted setting on startup).
   * Does NOT load the file — call loadCF() afterwards.
   */
  setCFPath(p: string): void {
    this.cfPath = p
    this.cfCache = null // invalidate cache so next loadCF() reads the new file
  }

  setNVRAMPath(p: string): void {
    this.nvramPath = p
    this.nvramCache = null
  }

  /**
   * Revert the CF path back to the app's default image in userData and load it.
   * A custom file previously selected via pickCF() is left untouched on disk.
   */
  async resetCF(): Promise<Uint8Array> {
    this.setCFPath(join(this.userDataDir, DEFAULT_CF_FILE))
    return this.loadCF()
  }

  /** Revert the NVRAM path back to the app's default file and load it. */
  async resetNVRAM(): Promise<Uint8Array> {
    this.setNVRAMPath(join(this.userDataDir, DEFAULT_NVRAM_FILE))
    return this.loadNVRAM()
  }

  /**
   * Load the bundled default BIOS ROM from the app's asset bundle.
   * In dev mode resolves relative to the repo root; in production uses
   * process.resourcesPath where electron-builder's extraResources places assets/.
   */
  loadDefaultROM(): Uint8Array | null {
    const romPath = app.isPackaged
      ? join(process.resourcesPath, 'assets', 'roms', 'BIOS.bin')
      : join(__dirname, '..', '..', 'assets', 'roms', 'BIOS.bin')
    try {
      return new Uint8Array(readFileSync(romPath))
    } catch (e) {
      console.error('[storage] loadDefaultROM:', e)
      return null
    }
  }
}
