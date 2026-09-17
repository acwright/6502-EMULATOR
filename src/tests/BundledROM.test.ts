/**
 * The bundled BIOS ROMs ship twice each, and the two copies are loaded by
 * different builds:
 *
 *   assets/roms/<file>               Electron, via extraResources and
 *                                    storage.loadDefaultROM (src/main/storage.ts)
 *   src/renderer/public/roms/<file>  web, fetched from BASE_URL + roms/<file>
 *                                    (src/renderer/src/composables/useDefaultBIOS.ts)
 *
 * There are two ROMs, one per BIOS line (`BUNDLED_ROM` in src/shared/vdp.ts):
 * `BIOS.bin` is the 1.x BIOS the TMS9918A boots, `BIOS2.bin` the 2.x BIOS the
 * PICOVDP boots.
 *
 * Updating one copy and not the other ships a desktop app running a different ROM
 * from the web build — and from the end-to-end tests in BIOS.test.ts, which read
 * the renderer copy and would go on passing.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '../..')

const ROMS = [
  { file: 'BIOS.bin', banner: /6502 BIOS v1\.\d+/ },
  { file: 'BIOS2.bin', banner: /AC6502 BIOS v2\.\d+/ }
]

describe.each(ROMS)('bundled ROM $file', ({ file, banner }) => {
  const electron = () => readFileSync(join(ROOT, 'assets/roms', file))
  const web = () => readFileSync(join(ROOT, 'src/renderer/public/roms', file))

  it('is byte-identical in the Electron and web asset paths', () => {
    expect(electron().equals(web())).toBe(true)
  })

  it('is a full 32K image', () => {
    expect(web().length).toBe(32768)
  })

  it('carries the version string of its BIOS line', () => {
    // Guards against bundling a truncated or unrelated binary, or the wrong line.
    expect(web().toString('latin1')).toMatch(banner)
  })

  it('has a JMP in every Kernal jump-table slot, $A000–$A0FE', () => {
    // The ROM is mapped at $8000, so $A000 is offset $2000.
    const rom = web()
    for (let slot = 0xa000; slot < 0xa0ff; slot += 3) {
      expect([slot, rom[slot - 0x8000]]).toEqual([slot, 0x4c])
    }
  })
})
