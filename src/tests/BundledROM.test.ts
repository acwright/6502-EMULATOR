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
 *
 * Both are build artifacts of 6502-BIOS and are never edited here —
 * assets/roms/README.md names the tag each was taken from. The digests below are
 * that record made executable, and they matter more than usual for 1.x: `v1.6`
 * has been reissued in place several times, with the same banner every time, so
 * the digest is the only thing that tells one 1.6 from another.
 */
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '../..')

const ROMS = [
  {
    file: 'BIOS.bin',
    // 6502-BIOS tag v1.8 (932021a429bf2c9cdc3a9cbd6a974bef9268e183) — the 1.x line: 1.7, plus a
    // direct GOTO that runs, the DS1501's Crystal Select bit cleared, and the serial mirror
    sha256: '0343d53e8f073cd515e67fbfd344641d1a5a35d5f903bbdd69564e97d4a3aa51',
    banner: /6502 BIOS v1\.\d+/
  },
  {
    file: 'BIOS2.bin',
    // 6502-BIOS tag v2.2.0 (1603ed1b7316a27b5b29ec894a181cf7ff1ac4fd) — v2.1.0, plus the same three changes as 1.8
    sha256: 'ff71d4182e9810932205645383e831dc50f5c2f84edeec5512dc42f351b62181',
    banner: /AC6502 BIOS v2\.\d+/
  }
]

describe.each(ROMS)('bundled ROM $file', ({ file, sha256, banner }) => {
  const electron = () => readFileSync(join(ROOT, 'assets/roms', file))
  const web = () => readFileSync(join(ROOT, 'src/renderer/public/roms', file))

  it('is byte-identical in the Electron and web asset paths', () => {
    expect(electron().equals(web())).toBe(true)
  })

  it('is a full 32K image', () => {
    expect(web().length).toBe(32768)
  })

  it('matches the digest recorded in assets/roms/README.md', () => {
    expect(createHash('sha256').update(web()).digest('hex')).toBe(sha256)
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
