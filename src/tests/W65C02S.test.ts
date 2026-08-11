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

    it('executes WAI from $CB, and halts on it', () => {
      load(0xcb, 0xea)
      const before = cpu.cycles
      cpu.step()

      expect(cpu.pc).toBe(0x8001)
      expect(cpu.cycles).toBe(before + 3)
      expect(cpu.waiting).toBe(true)

      // The NOP after it does not run until something asserts an interrupt.
      cpu.step()
      expect(cpu.pc).toBe(0x8001)
    })

    it('executes STP from $DB, and halts on it', () => {
      load(0xdb, 0xea)
      cpu.step()

      expect(cpu.pc).toBe(0x8001)
      expect(cpu.stopped).toBe(true)

      cpu.step()
      expect(cpu.pc).toBe(0x8001)
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

  describe('Table 4-1 instruction timing', () => {
    // The data sheet does not price instructions — Table 5-1 has no cycle
    // column at all. It prices ADDRESSING MODES, in Table 4-1, and three notes
    // do the rest:
    //
    //   note 1  page boundary, add 1 if crossed when forming the address
    //           (and add 1 for STA abs,X regardless of crossing)
    //   note 2  branch taken, add 1
    //   note 3  read-modify-write, add 2
    //
    // Every expectation below is that table's W65C02S column, which is the one
    // that differs from the NMOS part in two places — absolute indirect, and
    // the read-modify-write forms of absolute indexed with X. Both of those are
    // where NMOS timing has been found hiding here before, so they are tested
    // in both directions.
    //
    // Timed in ticks, deliberately: cpu.cycles is totalled at decode time and
    // never sees what an opcode handler adds to cyclesRem, so it cannot measure
    // notes 1 and 2 and would agree with a broken implementation.

    /** Put bytes anywhere, without touching the reset vector. */
    function place(addr: number, ...bytes: number[]): void {
      bytes.forEach((byte, i) => {
        memory[(addr + i) & 0xffff] = byte
      })
    }

    /** Reset to `addr` and run out the reset sequence. */
    function start(addr: number): void {
      memory[0xfffc] = addr & 0xff
      memory[0xfffd] = (addr >> 8) & 0xff
      cpu.reset()
      while (cpu.cyclesRem > 0) cpu.tick()
    }

    /** Cycles for the next instruction. The tick that decodes it is cycle 1. */
    function timeNext(): number {
      cpu.tick()
      const total = cpu.cyclesRem + 1
      while (cpu.cyclesRem > 0) cpu.tick()
      return total
    }

    it('immediate, implied and accumulator are 2', () => {
      place(0x8000, 0xa9, 0x01, 0xe8, 0x0a) // LDA #$01, INX, ASL A
      start(0x8000)

      expect(timeNext()).toBe(2)
      expect(timeNext()).toBe(2)
      expect(timeNext()).toBe(2)
    })

    it('zero page is 3, and 5 read-modify-write (note 3)', () => {
      place(0x8000, 0xa5, 0x10, 0x06, 0x10) // LDA $10, ASL $10
      start(0x8000)

      expect(timeNext()).toBe(3)
      expect(timeNext()).toBe(5)
    })

    it('zero page indexed is 4, and 6 read-modify-write (note 3)', () => {
      place(0x8000, 0xb5, 0x10, 0x16, 0x10, 0xb6, 0x10) // LDA $10,X ASL $10,X LDX $10,Y
      start(0x8000)

      expect(timeNext()).toBe(4)
      expect(timeNext()).toBe(6)
      expect(timeNext()).toBe(4)
    })

    it('zero page indirect is 5 and zero page indexed indirect is 6', () => {
      place(0x8000, 0xb2, 0x10, 0xa1, 0x10) // LDA ($10), LDA ($10,X)
      start(0x8000)

      expect(timeNext()).toBe(5)
      expect(timeNext()).toBe(6)
    })

    it('zero page indirect indexed with Y is 5, and 6 across a page (note 1)', () => {
      place(0x0010, 0x00, 0x20) // -> $2000
      place(0x0012, 0xff, 0x20) // -> $20FF
      place(0x8000, 0xb1, 0x10, 0xb1, 0x12) // LDA ($10),Y  LDA ($12),Y
      start(0x8000)
      cpu.y = 0x01

      expect(timeNext()).toBe(5)
      expect(timeNext()).toBe(6)
    })

    it('absolute is 4, and 6 read-modify-write (note 3)', () => {
      place(0x8000, 0xad, 0x00, 0x20, 0x0e, 0x00, 0x20) // LDA $2000, ASL $2000
      start(0x8000)

      expect(timeNext()).toBe(4)
      expect(timeNext()).toBe(6)
    })

    it('absolute indexed is 4, and 5 across a page (note 1)', () => {
      place(0x8000, 0xbd, 0x00, 0x20, 0xbd, 0xff, 0x20) // LDA $2000,X  LDA $20FF,X
      place(0x8006, 0xb9, 0x00, 0x20, 0xb9, 0xff, 0x20) // LDA $2000,Y  LDA $20FF,Y
      start(0x8000)
      cpu.x = 0x01
      cpu.y = 0x01

      expect(timeNext()).toBe(4)
      expect(timeNext()).toBe(5)
      expect(timeNext()).toBe(4)
      expect(timeNext()).toBe(5)
    })

    it('read-modify-write absolute indexed with X is 6, and 7 across a page', () => {
      // 4 for the mode + 2 for note 3, and note 1 still applies. The NMOS part
      // is a flat 7 here; the W65C02S column is not.
      place(0x8000, 0x1e, 0x00, 0x20, 0x1e, 0xff, 0x20) // ASL $2000,X  ASL $20FF,X
      start(0x8000)
      cpu.x = 0x01

      expect(timeNext()).toBe(6)
      expect(timeNext()).toBe(7)
    })

    it('stores in indexed modes pay the cycle whether or not a page is crossed', () => {
      // Note 1 spells this out for STA abs,X. STA abs,Y and STA (zp),Y are the
      // same shape: the address is formed before the write either way.
      place(0x0010, 0x00, 0x20)
      place(0x8000, 0x9d, 0x00, 0x20, 0x9d, 0xff, 0x20) // STA $2000,X  STA $20FF,X
      place(0x8006, 0x99, 0x00, 0x20, 0x91, 0x10) // STA $2000,Y  STA ($10),Y
      start(0x8000)
      cpu.x = 0x01
      cpu.y = 0x01

      expect(timeNext()).toBe(5)
      expect(timeNext()).toBe(5)
      expect(timeNext()).toBe(5)
      expect(timeNext()).toBe(6)
    })

    it('program counter relative is 2, 3 taken (note 2), 4 taken across a page', () => {
      place(0x8000, 0xa9, 0x01, 0xf0, 0x00, 0xd0, 0x00) // LDA #$01, BEQ +0, BNE +0
      start(0x8000)

      expect(timeNext()).toBe(2) // LDA
      expect(timeNext()).toBe(2) // BEQ, not taken
      expect(timeNext()).toBe(3) // BNE, taken

      place(0x80fc, 0xd0, 0x02) // BNE from $80FE to $8100
      start(0x80fc)
      cpu.a = 0x01
      cpu.st &= ~CPU.Z

      expect(timeNext()).toBe(4)
      expect(cpu.pc).toBe(0x8100)
    })

    it('BRA is a taken branch: 3, and 4 across a page', () => {
      place(0x8000, 0x80, 0x00) // BRA +0
      start(0x8000)

      expect(timeNext()).toBe(3)

      place(0x80fc, 0x80, 0x02) // BRA from $80FE to $8100
      start(0x80fc)

      expect(timeNext()).toBe(4)
      expect(cpu.pc).toBe(0x8100)
    })

    it('absolute indirect is 6 on the W65C02S, where the NMOS part is 5', () => {
      place(0x2000, 0x34, 0x12)
      place(0x8000, 0x6c, 0x00, 0x20) // JMP ($2000)
      start(0x8000)

      expect(timeNext()).toBe(6)
      expect(cpu.pc).toBe(0x1234)
    })

    it('absolute indexed indirect is 6', () => {
      place(0x2002, 0x34, 0x12)
      place(0x8000, 0x7c, 0x00, 0x20) // JMP ($2000,X)
      start(0x8000)
      cpu.x = 0x02

      expect(timeNext()).toBe(6)
      expect(cpu.pc).toBe(0x1234)
    })

    it('JMP absolute is 3 — the one absolute-mode instruction with no data cycle', () => {
      // Table 4-1 prices absolute at 4 and does not carve this out; 3 is the
      // conventional count for a JMP that only loads the program counter, and
      // it is pinned here so it cannot drift.
      place(0x8000, 0x4c, 0x34, 0x12) // JMP $1234
      start(0x8000)

      expect(timeNext()).toBe(3)
    })

    it('the stack instructions land inside Table 4-1\'s 3-7', () => {
      place(0x8000, 0x48, 0x68, 0x08, 0x28) // PHA PLA PHP PLP
      start(0x8000)

      expect(timeNext()).toBe(3) // PHA
      expect(timeNext()).toBe(4) // PLA
      expect(timeNext()).toBe(3) // PHP
      expect(timeNext()).toBe(4) // PLP

      place(0x8000, 0x20, 0x00, 0x90) // JSR $9000
      place(0x9000, 0x60) // RTS
      start(0x8000)

      expect(timeNext()).toBe(6) // JSR
      expect(timeNext()).toBe(6) // RTS

      place(0x8000, 0x00, 0xea) // BRK, and its signature byte
      place(0xfffe, 0x00, 0x90)
      place(0x9000, 0x40) // RTI
      start(0x8000)

      expect(timeNext()).toBe(7) // BRK
      expect(timeNext()).toBe(6) // RTI
    })

    it('the Rockwell bit branches are 5 when the branch is not taken', () => {
      // Zero page + relative is NOT one of Table 4-1's sixteen modes — it came
      // from Rockwell and the W65C02S data sheet prices it nowhere. Published
      // tables agree on 5, which is what this pins. Whether a taken bit-branch
      // adds a cycle the way note 2 does for the ordinary branches is not
      // settled by any source here, so it is deliberately not asserted: this
      // implementation adds one, and that is recorded rather than blessed.
      memory[0x0010] = 0x01 // bit 0 set, so BBR0 does not branch
      place(0x8000, 0x0f, 0x10, 0x00) // BBR0 $10,+0
      start(0x8000)

      expect(timeNext()).toBe(5)
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
