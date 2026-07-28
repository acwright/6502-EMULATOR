/**
 * The default BIOS ships twice, and the two copies are loaded by different
 * builds:
 *
 *   assets/roms/BIOS.bin               Electron, via extraResources and
 *                                      storage.loadDefaultROM (src/main/storage.ts)
 *   src/renderer/public/roms/BIOS.bin  web, fetched from BASE_URL + roms/BIOS.bin
 *                                      (src/renderer/src/composables/useDefaultBIOS.ts)
 *
 * Updating one and not the other ships a desktop app running a different ROM
 * from the web build — and from the end-to-end tests in BIOS.test.ts, which read
 * the renderer copy and would go on passing.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '../..')
const ELECTRON_ROM = join(ROOT, 'assets/roms/BIOS.bin')
const WEB_ROM = join(ROOT, 'src/renderer/public/roms/BIOS.bin')

describe('bundled BIOS ROM', () => {
  it('is byte-identical in the Electron and web asset paths', () => {
    const electron = readFileSync(ELECTRON_ROM)
    const web = readFileSync(WEB_ROM)
    expect(electron.equals(web)).toBe(true)
  })

  it('is a full 32K image', () => {
    expect(readFileSync(WEB_ROM).length).toBe(32768)
  })

  it('carries a version string the splash can show', () => {
    // Guards against bundling a truncated or unrelated binary.
    expect(readFileSync(WEB_ROM).toString('latin1')).toMatch(/6502 BIOS v\d+\.\d+/)
  })
})
