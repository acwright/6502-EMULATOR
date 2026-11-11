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
    // 6502-BIOS tag v1.7 (387d29d5396b821568e7b9a41fa7e7fccf6d1b76) — the 1.x line: 1.6's serial
    // flow control, a SID probe open bus cannot fool, and a CF probe that skips an empty slot
    sha256: '49be5865bde74220f37ad10bd773619b17f052b37c89f79c1a3564b7da51d799',
    banner: /6502 BIOS v1\.\d+/
  },
  {
    file: 'BIOS2.bin',
    // 6502-BIOS tag v2.1.0 (6f9e137607eb4fc6471e7d1bfc877cbc2804e96b) — v2.0.2, plus the same two
    // probes as 1.7 and the keyboard encoders' settle cut from 80 loops to 50
    sha256: '991ba3c258caec56824ef46ed9dbae5224d824f292cc6a41de9c9e4bf79e8543',
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
