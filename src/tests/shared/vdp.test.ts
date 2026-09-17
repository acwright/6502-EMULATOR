import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUNDLED_ROM, DEFAULT_VDP, parseVdp, romWantsPicovdp } from '../../shared/vdp'
import { VDP_MODELS } from '../../core/IO/VideoCard'
import { DEFAULT_APP_SETTINGS } from '../../shared/types'

const ROOT = join(__dirname, '..', '..', '..')

describe('the video card selection', () => {
  it('defaults to the TMS9918A, in the app settings too', () => {
    expect(DEFAULT_VDP).toBe('tms9918a')
    expect(DEFAULT_APP_SETTINGS.vdp).toBe(DEFAULT_VDP)
  })

  it('parses both names, trimmed and in any case', () => {
    expect(parseVdp('tms9918a')).toBe('tms9918a')
    expect(parseVdp('picovdp')).toBe('picovdp')
    expect(parseVdp(' PicoVDP ')).toBe('picovdp')
    expect(parseVdp('TMS9918A')).toBe('tms9918a')
  })

  it('names no card for anything else', () => {
    for (const raw of [null, undefined, '', 'tms9918', 'pico', 'video', 'tms9918a picovdp']) {
      expect(parseVdp(raw)).toBeNull()
    }
  })

  it('has a bundled ROM for every card, and each one exists in both places', () => {
    for (const model of VDP_MODELS) {
      const file = BUNDLED_ROM[model]
      const app = readFileSync(join(ROOT, 'assets', 'roms', file))
      const web = readFileSync(join(ROOT, 'src', 'renderer', 'public', 'roms', file))
      expect(app.equals(web)).toBe(true)
    }
  })

  it('does not take the bundled 1.x BIOS for one that needs the PICOVDP', () => {
    const bios = new Uint8Array(readFileSync(join(ROOT, 'assets', 'roms', 'BIOS.bin')))
    expect(romWantsPicovdp(bios)).toBe(false)
  })

  it('takes the bundled 2.x BIOS for one that needs the PICOVDP', () => {
    const bios = new Uint8Array(readFileSync(join(ROOT, 'assets', 'roms', BUNDLED_ROM.picovdp)))
    expect(romWantsPicovdp(bios)).toBe(true)
  })

  it('recognises a 2.x BIOS by its banner', () => {
    const rom = new Uint8Array(0x8000)
    rom.set(Buffer.from('AC6502 BIOS v2.0', 'latin1'), 0x1234)
    expect(romWantsPicovdp(rom)).toBe(true)

    rom.fill(0)
    rom.set(Buffer.from('6502 BIOS v2.0', 'latin1'), 0x1234)
    expect(romWantsPicovdp(rom)).toBe(true)

    rom.fill(0)
    rom.set(Buffer.from('6502 BIOS v1.6', 'latin1'), 0x1234)
    expect(romWantsPicovdp(rom)).toBe(false)
  })
})
