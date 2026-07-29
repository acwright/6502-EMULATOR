import { CPU } from '../core/CPU'
import { OPCODES } from '../debug/OpcodeTable'

/**
 * Conformance with the WDC W65C02S, which is the part the real hardware uses.
 *
 * The distinction from the Rockwell R65C02 matters in two places. WDC adds WAI
 * ($CB) and STP ($DB) on top of the Rockwell bit instructions. And where the
 * Rockwell part leaves the unused opcode space loosely defined, WDC specifies a
 * width and a cycle count for every one — several are two or three bytes, not
 * one-byte NOPs.
 *
 * Width is the part worth testing. An unused opcode that consumes the wrong
 * number of operand bytes leaves the PC in the wrong place, so every
 * instruction after it decodes differently from real silicon — which is exactly
 * the situation you are in when debugging a program that has run off into data.
 */
describe('W65C02S conformance', () => {
  let memory: number[]
  let cpu: CPU

  beforeEach(() => {
    memory = new Array(0x10000).fill(0)
    cpu = new CPU(
      (address) => memory[address & 0xffff] || 0,
      (address, data) => {
        memory[address & 0xffff] = data & 0xff
      }
    )
  })

  /** Place `bytes` at $8000 and point the reset vector there. */
  function load(...bytes: number[]): void {
    bytes.forEach((byte, i) => {
      memory[0x8000 + i] = byte
    })
    memory[0xfffc] = 0x00
    memory[0xfffd] = 0x80
    cpu.reset()
  }

  describe('WDC-only instructions', () => {
    it('places WAI at $CB, not $EB', () => {
      expect(OPCODES[0xcb]).toMatchObject({ name: 'WAI', bytes: 1 })
      expect(OPCODES[0xeb]!.name).toBe('???')
    })

    it('places STP at $DB', () => {
      expect(OPCODES[0xdb]).toMatchObject({ name: 'STP', bytes: 1 })
    })

    it('executes WAI from $CB', () => {
      load(0xcb)
      const before = cpu.cycles
      cpu.step()

      expect(cpu.pc).toBe(0x8001)
      expect(cpu.cycles).toBeGreaterThan(before)
    })

    it('treats $EB as a one-byte NOP', () => {
      load(0xeb, 0xea)
      cpu.step()
      expect(cpu.pc).toBe(0x8001)
    })
  })

  describe('unused opcode widths', () => {
    // Opcode -> total instruction length, from the W65C02S opcode matrix.
    const WIDTHS: ReadonlyArray<readonly [number, number]> = [
      [0x02, 2],
      [0x22, 2],
      [0x42, 2],
      [0x62, 2],
      [0x82, 2],
      [0xc2, 2],
      [0xe2, 2],
      [0x44, 2],
      [0x54, 2],
      [0xd4, 2],
      [0xf4, 2],
      [0x5c, 3],
      [0xdc, 3],
      [0xfc, 3],
      [0x03, 1],
      [0x0b, 1],
      [0xfb, 1]
    ]

    it.each(WIDTHS)('$%s advances the PC by its full width', (opcode, width) => {
      expect(OPCODES[opcode]!.bytes).toBe(width)

      // Operand bytes are $FF so a mis-sized instruction would decode one of
      // them next and land somewhere obviously wrong.
      load(opcode, 0xff, 0xff)
      cpu.step()

      expect(cpu.pc).toBe(0x8000 + width)
    })

    it('does not disturb the registers', () => {
      load(0x5c, 0xff, 0xff)
      cpu.a = 0x42
      cpu.x = 0x43
      cpu.y = 0x44
      const sp = cpu.sp

      cpu.step()

      expect(cpu.a).toBe(0x42)
      expect(cpu.x).toBe(0x43)
      expect(cpu.y).toBe(0x44)
      expect(cpu.sp).toBe(sp)
    })

    it('keeps executing correctly after a multi-byte NOP', () => {
      // $5C is three bytes. If it were treated as one, the CPU would run the
      // $A9 operand as an instruction and never reach the real LDA.
      load(0x5c, 0xa9, 0x99, 0xa9, 0x42)
      cpu.step() // the NOP
      cpu.step() // LDA #$42

      expect(cpu.a).toBe(0x42)
      expect(cpu.pc).toBe(0x8005)
    })
  })

  describe('Rockwell bit instructions, which WDC also implements', () => {
    it('has all eight RMB, SMB, BBR and BBS pairs', () => {
      for (let bit = 0; bit < 8; bit++) {
        expect(OPCODES[0x07 + bit * 0x10]!.name).toBe(`RMB${bit}`)
        expect(OPCODES[0x87 + bit * 0x10]!.name).toBe(`SMB${bit}`)
        expect(OPCODES[0x0f + bit * 0x10]!.name).toBe(`BBR${bit}`)
        expect(OPCODES[0x8f + bit * 0x10]!.name).toBe(`BBS${bit}`)
      }
    })
  })
})
