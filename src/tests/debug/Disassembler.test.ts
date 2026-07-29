import {
  disassembleOne,
  disassemble,
  disassembleRange,
  formatInstruction
} from '../../debug/Disassembler'
import type { ByteSource } from '../../debug/Disassembler'
import { CPU } from '../../core/CPU'
import { OPCODES } from '../../debug/OpcodeTable'

/** A flat 64K address space holding the bytes under test. */
function memory(at: number, ...bytes: number[]): ByteSource {
  const ram = new Uint8Array(0x10000)
  bytes.forEach((byte, i) => {
    ram[(at + i) & 0xffff] = byte
  })
  return { read: (address) => ram[address & 0xffff]! }
}

/** Just the mnemonic and operand, which is what the mode tests are about. */
function text(source: ByteSource, at: number): string {
  const instruction = disassembleOne(source, at)
  return instruction.operand ? `${instruction.name} ${instruction.operand}` : instruction.name
}

describe('Disassembler', () => {
  describe('addressing modes', () => {
    it.each([
      ['implied', [0xea], 'NOP'],
      ['accumulator', [0x0a], 'ASL'],
      ['immediate', [0xa9, 0x42], 'LDA #$42'],
      ['zero page', [0xa5, 0x80], 'LDA $80'],
      ['zero page,X', [0xb5, 0x80], 'LDA $80,X'],
      ['zero page,Y', [0xb6, 0x80], 'LDX $80,Y'],
      ['(zp,X)', [0xa1, 0x80], 'LDA ($80,X)'],
      ['(zp),Y', [0xb1, 0x80], 'LDA ($80),Y'],
      ['(zp)', [0xb2, 0x80], 'LDA ($80)'],
      ['absolute', [0xad, 0x34, 0x12], 'LDA $1234'],
      ['absolute,X', [0xbd, 0x34, 0x12], 'LDA $1234,X'],
      ['absolute,Y', [0xb9, 0x34, 0x12], 'LDA $1234,Y'],
      ['indirect', [0x6c, 0x34, 0x12], 'JMP ($1234)'],
      ['(absolute,X)', [0x7c, 0x34, 0x12], 'JMP ($1234,X)']
    ])('renders %s', (_label, bytes, expected) => {
      expect(text(memory(0xc000, ...bytes), 0xc000)).toBe(expected)
    })

    it('resolves a forward branch to its target address', () => {
      // BNE +4 at $C000 is measured from $C002, so it lands on $C006.
      expect(text(memory(0xc000, 0xd0, 0x04), 0xc000)).toBe('BNE $C006')
    })

    it('resolves a backward branch, which uses a signed displacement', () => {
      // $FB is -5, from $C002, so $BFFD.
      expect(text(memory(0xc000, 0xd0, 0xfb), 0xc000)).toBe('BNE $BFFD')
    })

    it('renders the bit-branch pair as a zero page address and a target', () => {
      // BBR0 $12, then branch +3 measured from $C003.
      expect(text(memory(0xc000, 0x0f, 0x12, 0x03), 0xc000)).toBe('BBR0 $12,$C006')
    })
  })

  describe('instruction widths', () => {
    it('advances by the width of each instruction', () => {
      const source = memory(0xc000, 0xa9, 0x42, 0xad, 0x34, 0x12, 0xea)
      const listing = disassemble(source, 0xc000, 3)

      expect(listing.map((i) => i.address)).toEqual([0xc000, 0xc002, 0xc005])
      expect(listing.map((i) => i.name)).toEqual(['LDA', 'LDA', 'NOP'])
    })

    // A wrong width here would desynchronise everything after it, which is the
    // failure mode that makes a disassembler useless on data.
    it('gives unimplemented opcodes their real width, staying in sync', () => {
      // $5C is a three-byte NOP on the W65C02S.
      const source = memory(0xc000, 0x5c, 0xff, 0xff, 0xa9, 0x42)
      const listing = disassemble(source, 0xc000, 2)

      expect(listing[0]).toMatchObject({ name: '???', documented: false })
      expect(listing[0]!.bytes).toHaveLength(3)
      expect(listing[1]).toMatchObject({ address: 0xc003, name: 'LDA' })
    })

    it('agrees with the opcode table for every opcode', () => {
      for (let opcode = 0; opcode < 256; opcode++) {
        const instruction = disassembleOne(memory(0xc000, opcode, 0, 0), 0xc000)
        expect(instruction.bytes).toHaveLength(OPCODES[opcode]!.bytes)
        expect(instruction.name).toBe(OPCODES[opcode]!.name)
      }
    })

    it('wraps at the top of the address space', () => {
      const source = memory(0xffff, 0xa9)
      const instruction = disassembleOne(source, 0xffff)
      expect(instruction.address).toBe(0xffff)
      expect(instruction.bytes).toHaveLength(2)
    })
  })

  describe('symbols', () => {
    const resolve = (address: number) => (address === 0xa000 ? 'Chrout' : undefined)

    it('names a jump target', () => {
      const instruction = disassembleOne(memory(0xc000, 0x20, 0x00, 0xa0), 0xc000, resolve)

      expect(instruction.target).toBe(0xa000)
      expect(instruction.label).toBe('Chrout')
      expect(formatInstruction(instruction, { bytes: false }).trim()).toBe('C000  JSR Chrout')
    })

    it('leaves an unknown target as an address', () => {
      const instruction = disassembleOne(memory(0xc000, 0x20, 0x34, 0x12), 0xc000, resolve)
      expect(instruction.label).toBeUndefined()
      expect(formatInstruction(instruction, { bytes: false }).trim()).toBe('C000  JSR $1234')
    })

    it('substitutes only the branch half of a bit-branch', () => {
      const branchTo = (address: number) => (address === 0xc006 ? 'loop' : undefined)
      const instruction = disassembleOne(memory(0xc000, 0x0f, 0x12, 0x03), 0xc000, branchTo)
      expect(formatInstruction(instruction, { bytes: false }).trim()).toBe('C000  BBR0 $12,loop')
    })

    it('does not offer a target for implied or immediate operands', () => {
      expect(disassembleOne(memory(0xc000, 0xea), 0xc000).target).toBeUndefined()
      expect(disassembleOne(memory(0xc000, 0xa9, 0x42), 0xc000).target).toBeUndefined()
    })
  })

  describe('formatting', () => {
    it('lays out address, bytes and mnemonic', () => {
      const instruction = disassembleOne(memory(0xc000, 0x20, 0x00, 0xa0), 0xc000)
      expect(formatInstruction(instruction)).toBe('  C000  20 00 A0  JSR $A000')
    })

    it('marks a line on request', () => {
      const instruction = disassembleOne(memory(0xc000, 0xea), 0xc000)
      expect(formatInstruction(instruction, { marker: true })).toBe('> C000  EA        NOP')
    })
  })

  describe('range disassembly', () => {
    it('covers the requested span', () => {
      const source = memory(0xc000, 0xa9, 0x42, 0xea, 0xea)
      const listing = disassembleRange(source, 0xc000, 0xc003)
      expect(listing.map((i) => i.address)).toEqual([0xc000, 0xc002, 0xc003])
    })
  })

  // The point of the whole exercise: what the disassembler says an instruction
  // is must be what the CPU actually does with it.
  describe('agreement with the CPU', () => {
    it('predicts where the PC lands for every opcode', () => {
      for (let opcode = 0; opcode < 256; opcode++) {
        const ram = new Uint8Array(0x10000)
        ram[0xc000] = opcode
        ram[0xc001] = 0x00
        ram[0xc002] = 0x00
        ram[0xfffc] = 0x00
        ram[0xfffd] = 0xc0

        const cpu = new CPU(
          (address) => ram[address & 0xffff]!,
          (address, data) => {
            ram[address & 0xffff] = data & 0xff
          }
        )
        cpu.reset()
        cpu.step()

        // Branches, jumps and subroutine calls move the PC somewhere else by
        // design; for everything else it advances by the instruction's width.
        const name = OPCODES[opcode]!.name
        const controlFlow = /^(B|JMP|JSR|RTS|RTI|BRK|STP|WAI)/.test(name)
        if (controlFlow) continue

        const width = disassembleOne({ read: (a) => ram[a & 0xffff]! }, 0xc000).bytes.length
        expect({ opcode, pc: cpu.pc }).toEqual({ opcode, pc: 0xc000 + width })
      }
    })
  })
})
