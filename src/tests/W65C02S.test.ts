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
    // Timed in ticks, deliberately. cpu.cycles is budgeted at decode time, so
    // it runs ahead of the clock mid-instruction and cannot be sampled between
    // two of them; the ticks are what the machine's own counter measures, and
    // what an I/O card actually sees.

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

    it('the shifts read-modify-write absolute indexed with X in 6, and 7 across a page', () => {
      // 4 for the mode + 2 for note 3, and note 1 still applies. The NMOS part
      // is a flat 7 here; for ASL, ROL, LSR and ROR the W65C02S column is not.
      place(0x8000, 0x1e, 0x00, 0x20, 0x1e, 0xff, 0x20) // ASL $2000,X  ASL $20FF,X
      place(0x8006, 0x3e, 0x00, 0x20, 0x5e, 0x00, 0x20) // ROL $2000,X  LSR $2000,X
      place(0x800c, 0x7e, 0x00, 0x20) // ROR $2000,X
      start(0x8000)
      cpu.x = 0x01

      expect(timeNext()).toBe(6)
      expect(timeNext()).toBe(7)
      expect(timeNext()).toBe(6)
      expect(timeNext()).toBe(6)
      expect(timeNext()).toBe(6)
    })

    it('INC and DEC absolute indexed with X stay at the NMOS 7, crossing or not', () => {
      // The exception to the line above, and the reason Table 4-1 cannot be
      // read on its own here: it prices addressing modes, and by that reading
      // these would be 6 like the shifts. The CMOS optimisation only reached
      // the shifters. The data sheet's opcode matrix, and every published table
      // after it, keeps INC $nnnn,X and DEC $nnnn,X at a flat 7 — no note 1.
      place(0x8000, 0xfe, 0x00, 0x20, 0xfe, 0xff, 0x20) // INC $2000,X  INC $20FF,X
      place(0x8006, 0xde, 0x00, 0x20, 0xde, 0xff, 0x20) // DEC $2000,X  DEC $20FF,X
      start(0x8000)
      cpu.x = 0x01

      expect(timeNext()).toBe(7)
      expect(timeNext()).toBe(7)
      expect(timeNext()).toBe(7)
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

  describe('decimal mode, which the CMOS part fixed', () => {
    /** Put bytes anywhere, without touching the reset vector. */
    function place(addr: number, ...bytes: number[]): void {
      bytes.forEach((byte, i) => {
        memory[(addr + i) & 0xffff] = byte
      })
    }

    function start(addr: number): void {
      memory[0xfffc] = addr & 0xff
      memory[0xfffd] = (addr >> 8) & 0xff
      cpu.reset()
      while (cpu.cyclesRem > 0) cpu.tick()
    }

    function timeNext(): number {
      cpu.tick()
      const total = cpu.cyclesRem + 1
      while (cpu.cyclesRem > 0) cpu.tick()
      return total
    }

    it('sets N and Z from the decimal result of ADC, not the binary sum', () => {
      // $50 + $50 = $00 with carry in BCD. The binary sum is $A0, so an NMOS
      // 6502 leaves N set here and Z clear — both wrong for the answer it puts
      // in the accumulator, which is why the NMOS data sheet calls them
      // invalid in decimal mode. The W65C02S reports the decimal result.
      place(0x8000, 0xf8, 0x18, 0xa9, 0x50, 0x69, 0x50) // SED CLC LDA #$50 ADC #$50
      start(0x8000)
      cpu.step()
      cpu.step()
      cpu.step()
      cpu.step()

      expect(cpu.a).toBe(0x00)
      expect(cpu.st & CPU.C).toBe(CPU.C)
      expect(cpu.st & CPU.Z).toBe(CPU.Z)
      expect(cpu.st & CPU.N).toBe(0)
    })

    it('sets N and Z from the decimal result of SBC, not the binary difference', () => {
      // $00 - $50 = $50 with a borrow. The binary difference is $B0, so an
      // NMOS part reports N set; the answer has bit 7 clear.
      place(0x8000, 0xf8, 0x38, 0xa9, 0x00, 0xe9, 0x50) // SED SEC LDA #$00 SBC #$50
      start(0x8000)
      cpu.step()
      cpu.step()
      cpu.step()
      cpu.step()

      expect(cpu.a).toBe(0x50)
      expect(cpu.st & CPU.N).toBe(0)
      expect(cpu.st & CPU.C).toBe(0)
    })

    it('charges ADC and SBC an extra cycle in decimal mode', () => {
      // Immediate is 2 cycles, and decimal mode adds 1 on the W65C02S where
      // the NMOS part runs it in the same time as binary.
      place(0x8000, 0x69, 0x01, 0xe9, 0x01) // ADC #$01, SBC #$01
      start(0x8000)

      expect(timeNext()).toBe(2)
      expect(timeNext()).toBe(2)

      place(0x8000, 0xf8, 0x69, 0x01, 0xe9, 0x01) // SED, ADC #$01, SBC #$01
      start(0x8000)

      expect(timeNext()).toBe(2) // SED
      expect(timeNext()).toBe(3)
      expect(timeNext()).toBe(3)
    })

    it('counts the decimal cycle in cpu.cycles as well as cyclesRem', () => {
      // step() returns the difference of cpu.cycles, and Machine.step() ticks
      // the I/O cards that many times. A penalty that only reached cyclesRem
      // would leave the two clocks disagreeing.
      place(0x8000, 0xf8, 0x69, 0x01) // SED, ADC #$01
      start(0x8000)
      cpu.step() // SED

      expect(cpu.step()).toBe(3)
    })

    it('counts a taken branch in cpu.cycles too', () => {
      // Same defect, older: the branch handlers added their cycle to cyclesRem
      // only, so a taken branch reported 2 through step() while taking 3.
      place(0x8000, 0x80, 0x00) // BRA +0
      start(0x8000)

      expect(cpu.step()).toBe(3)
    })
  })

  describe('BIT, which the CMOS part gave two more addressing modes', () => {
    function place(addr: number, ...bytes: number[]): void {
      bytes.forEach((byte, i) => {
        memory[(addr + i) & 0xffff] = byte
      })
    }

    function start(addr: number): void {
      memory[0xfffc] = addr & 0xff
      memory[0xfffd] = (addr >> 8) & 0xff
      cpu.reset()
      while (cpu.cyclesRem > 0) cpu.tick()
    }

    it('has BIT $nn,X at $34 and BIT $nnnn,X at $3C', () => {
      expect(OPCODES[0x34]).toMatchObject({ name: 'BIT', mode: 'ZPX', bytes: 2 })
      expect(OPCODES[0x3c]).toMatchObject({ name: 'BIT', mode: 'ABX', bytes: 3 })
    })

    it('BIT $nn,X tests, and takes N and V from the operand', () => {
      memory[0x0011] = 0xc0
      place(0x8000, 0xa9, 0x0f, 0xa2, 0x01, 0x34, 0x10) // LDA #$0F LDX #$01 BIT $10,X
      start(0x8000)
      cpu.step()
      cpu.step()
      cpu.step()

      expect(cpu.pc).toBe(0x8006) // two bytes wide, not one
      expect(cpu.a).toBe(0x0f)    // BIT does not touch the accumulator
      expect(cpu.st & CPU.Z).toBe(CPU.Z) // $0F & $C0 == 0
      expect(cpu.st & CPU.N).toBe(CPU.N)
      expect(cpu.st & CPU.V).toBe(CPU.V)
    })

    it('BIT $nnnn,X tests, and is three bytes wide', () => {
      memory[0x2001] = 0x40
      place(0x8000, 0xa9, 0x40, 0xa2, 0x01, 0x3c, 0x00, 0x20) // LDA #$40 LDX #$01 BIT $2000,X
      start(0x8000)
      cpu.step()
      cpu.step()
      cpu.step()

      expect(cpu.pc).toBe(0x8007)
      expect(cpu.st & CPU.Z).toBe(0) // $40 & $40 != 0
      expect(cpu.st & CPU.N).toBe(0)
      expect(cpu.st & CPU.V).toBe(CPU.V)
    })

    it('BIT $nn,X is 4 and BIT $nnnn,X is 4, 5 across a page (note 1)', () => {
      place(0x8000, 0x34, 0x10, 0x3c, 0x00, 0x20, 0x3c, 0xff, 0x20)
      start(0x8000)
      cpu.x = 0x01

      const timeNext = (): number => {
        cpu.tick()
        const total = cpu.cyclesRem + 1
        while (cpu.cyclesRem > 0) cpu.tick()
        return total
      }

      expect(timeNext()).toBe(4)
      expect(timeNext()).toBe(4)
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

  describe('the whole opcode matrix', () => {
    // Every one of the 256 opcodes, as the W65C02S matrix publishes it:
    // mnemonic, addressing mode, and the base cycle count the table carries
    // before any of Table 4-1's three notes are applied. The notes are timed
    // instruction by instruction above; this is the check that nothing is
    // simply *absent*.
    //
    // Written out rather than derived, deliberately. It is a second,
    // independent statement of the same 256 facts, so a mistake has to be made
    // twice in the same direction to survive — which is what the two missing
    // BIT forms did not do. They sat in the unused-opcode space as one-byte
    // NOPs, agreeing with the disassembler's table because both were wrong,
    // and no test compared either against the part.
    const MATRIX: ReadonlyArray<readonly [string, string, number]> = [
    // $00
    ['BRK', 'IMM', 7], ['ORA', 'IZX', 6], ['???', 'IMM', 2], ['???', 'IMP', 1],
    ['TSB', 'ZP0', 5], ['ORA', 'ZP0', 3], ['ASL', 'ZP0', 5], ['RMB0', 'ZP0', 5],
    ['PHP', 'IMP', 3], ['ORA', 'IMM', 2], ['ASL', 'IMP', 2], ['???', 'IMP', 1],
    ['TSB', 'ABS', 6], ['ORA', 'ABS', 4], ['ASL', 'ABS', 6], ['BBR0', 'ZPR', 5],
    // $10
    ['BPL', 'REL', 2], ['ORA', 'IZY', 5], ['ORA', 'IZP', 5], ['???', 'IMP', 1],
    ['TRB', 'ZP0', 5], ['ORA', 'ZPX', 4], ['ASL', 'ZPX', 6], ['RMB1', 'ZP0', 5],
    ['CLC', 'IMP', 2], ['ORA', 'ABY', 4], ['INC', 'IMP', 2], ['???', 'IMP', 1],
    ['TRB', 'ABS', 6], ['ORA', 'ABX', 4], ['ASL', 'ABX', 6], ['BBR1', 'ZPR', 5],
    // $20
    ['JSR', 'ABS', 6], ['AND', 'IZX', 6], ['???', 'IMM', 2], ['???', 'IMP', 1],
    ['BIT', 'ZP0', 3], ['AND', 'ZP0', 3], ['ROL', 'ZP0', 5], ['RMB2', 'ZP0', 5],
    ['PLP', 'IMP', 4], ['AND', 'IMM', 2], ['ROL', 'IMP', 2], ['???', 'IMP', 1],
    ['BIT', 'ABS', 4], ['AND', 'ABS', 4], ['ROL', 'ABS', 6], ['BBR2', 'ZPR', 5],
    // $30
    ['BMI', 'REL', 2], ['AND', 'IZY', 5], ['AND', 'IZP', 5], ['???', 'IMP', 1],
    ['BIT', 'ZPX', 4], ['AND', 'ZPX', 4], ['ROL', 'ZPX', 6], ['RMB3', 'ZP0', 5],
    ['SEC', 'IMP', 2], ['AND', 'ABY', 4], ['DEC', 'IMP', 2], ['???', 'IMP', 1],
    ['BIT', 'ABX', 4], ['AND', 'ABX', 4], ['ROL', 'ABX', 6], ['BBR3', 'ZPR', 5],
    // $40
    ['RTI', 'IMP', 6], ['EOR', 'IZX', 6], ['???', 'IMM', 2], ['???', 'IMP', 1],
    ['???', 'ZP0', 3], ['EOR', 'ZP0', 3], ['LSR', 'ZP0', 5], ['RMB4', 'ZP0', 5],
    ['PHA', 'IMP', 3], ['EOR', 'IMM', 2], ['LSR', 'IMP', 2], ['???', 'IMP', 1],
    ['JMP', 'ABS', 3], ['EOR', 'ABS', 4], ['LSR', 'ABS', 6], ['BBR4', 'ZPR', 5],
    // $50
    ['BVC', 'REL', 2], ['EOR', 'IZY', 5], ['EOR', 'IZP', 5], ['???', 'IMP', 1],
    ['???', 'ZPX', 4], ['EOR', 'ZPX', 4], ['LSR', 'ZPX', 6], ['RMB5', 'ZP0', 5],
    ['CLI', 'IMP', 2], ['EOR', 'ABY', 4], ['PHY', 'IMP', 3], ['???', 'IMP', 1],
    ['???', 'ABS', 8], ['EOR', 'ABX', 4], ['LSR', 'ABX', 6], ['BBR5', 'ZPR', 5],
    // $60
    ['RTS', 'IMP', 6], ['ADC', 'IZX', 6], ['???', 'IMM', 2], ['???', 'IMP', 1],
    ['STZ', 'ZP0', 3], ['ADC', 'ZP0', 3], ['ROR', 'ZP0', 5], ['RMB6', 'ZP0', 5],
    ['PLA', 'IMP', 4], ['ADC', 'IMM', 2], ['ROR', 'IMP', 2], ['???', 'IMP', 1],
    ['JMP', 'IND', 6], ['ADC', 'ABS', 4], ['ROR', 'ABS', 6], ['BBR6', 'ZPR', 5],
    // $70
    ['BVS', 'REL', 2], ['ADC', 'IZY', 5], ['ADC', 'IZP', 5], ['???', 'IMP', 1],
    ['STZ', 'ZPX', 4], ['ADC', 'ZPX', 4], ['ROR', 'ZPX', 6], ['RMB7', 'ZP0', 5],
    ['SEI', 'IMP', 2], ['ADC', 'ABY', 4], ['PLY', 'IMP', 4], ['???', 'IMP', 1],
    ['JMP', 'IAX', 6], ['ADC', 'ABX', 4], ['ROR', 'ABX', 6], ['BBR7', 'ZPR', 5],
    // $80
    ['BRA', 'REL', 2], ['STA', 'IZX', 6], ['???', 'IMM', 2], ['???', 'IMP', 1],
    ['STY', 'ZP0', 3], ['STA', 'ZP0', 3], ['STX', 'ZP0', 3], ['SMB0', 'ZP0', 5],
    ['DEY', 'IMP', 2], ['BIT', 'IMM', 2], ['TXA', 'IMP', 2], ['???', 'IMP', 1],
    ['STY', 'ABS', 4], ['STA', 'ABS', 4], ['STX', 'ABS', 4], ['BBS0', 'ZPR', 5],
    // $90
    ['BCC', 'REL', 2], ['STA', 'IZY', 6], ['STA', 'IZP', 5], ['???', 'IMP', 1],
    ['STY', 'ZPX', 4], ['STA', 'ZPX', 4], ['STX', 'ZPY', 4], ['SMB1', 'ZP0', 5],
    ['TYA', 'IMP', 2], ['STA', 'ABY', 5], ['TXS', 'IMP', 2], ['???', 'IMP', 1],
    ['STZ', 'ABS', 4], ['STA', 'ABX', 5], ['STZ', 'ABX', 5], ['BBS1', 'ZPR', 5],
    // $A0
    ['LDY', 'IMM', 2], ['LDA', 'IZX', 6], ['LDX', 'IMM', 2], ['???', 'IMP', 1],
    ['LDY', 'ZP0', 3], ['LDA', 'ZP0', 3], ['LDX', 'ZP0', 3], ['SMB2', 'ZP0', 5],
    ['TAY', 'IMP', 2], ['LDA', 'IMM', 2], ['TAX', 'IMP', 2], ['???', 'IMP', 1],
    ['LDY', 'ABS', 4], ['LDA', 'ABS', 4], ['LDX', 'ABS', 4], ['BBS2', 'ZPR', 5],
    // $B0
    ['BCS', 'REL', 2], ['LDA', 'IZY', 5], ['LDA', 'IZP', 5], ['???', 'IMP', 1],
    ['LDY', 'ZPX', 4], ['LDA', 'ZPX', 4], ['LDX', 'ZPY', 4], ['SMB3', 'ZP0', 5],
    ['CLV', 'IMP', 2], ['LDA', 'ABY', 4], ['TSX', 'IMP', 2], ['???', 'IMP', 1],
    ['LDY', 'ABX', 4], ['LDA', 'ABX', 4], ['LDX', 'ABY', 4], ['BBS3', 'ZPR', 5],
    // $C0
    ['CPY', 'IMM', 2], ['CMP', 'IZX', 6], ['???', 'IMM', 2], ['???', 'IMP', 1],
    ['CPY', 'ZP0', 3], ['CMP', 'ZP0', 3], ['DEC', 'ZP0', 5], ['SMB4', 'ZP0', 5],
    ['INY', 'IMP', 2], ['CMP', 'IMM', 2], ['DEX', 'IMP', 2], ['WAI', 'IMP', 3],
    ['CPY', 'ABS', 4], ['CMP', 'ABS', 4], ['DEC', 'ABS', 6], ['BBS4', 'ZPR', 5],
    // $D0
    ['BNE', 'REL', 2], ['CMP', 'IZY', 5], ['CMP', 'IZP', 5], ['???', 'IMP', 1],
    ['???', 'ZPX', 4], ['CMP', 'ZPX', 4], ['DEC', 'ZPX', 6], ['SMB5', 'ZP0', 5],
    ['CLD', 'IMP', 2], ['CMP', 'ABY', 4], ['PHX', 'IMP', 3], ['STP', 'IMP', 3],
    ['???', 'ABS', 4], ['CMP', 'ABX', 4], ['DEC', 'ABX', 7], ['BBS5', 'ZPR', 5],
    // $E0
    ['CPX', 'IMM', 2], ['SBC', 'IZX', 6], ['???', 'IMM', 2], ['???', 'IMP', 1],
    ['CPX', 'ZP0', 3], ['SBC', 'ZP0', 3], ['INC', 'ZP0', 5], ['SMB6', 'ZP0', 5],
    ['INX', 'IMP', 2], ['SBC', 'IMM', 2], ['NOP', 'IMP', 2], ['???', 'IMP', 1],
    ['CPX', 'ABS', 4], ['SBC', 'ABS', 4], ['INC', 'ABS', 6], ['BBS6', 'ZPR', 5],
    // $F0
    ['BEQ', 'REL', 2], ['SBC', 'IZY', 5], ['SBC', 'IZP', 5], ['???', 'IMP', 1],
    ['???', 'ZPX', 4], ['SBC', 'ZPX', 4], ['INC', 'ZPX', 6], ['SMB7', 'ZP0', 5],
    ['SED', 'IMP', 2], ['SBC', 'ABY', 4], ['PLX', 'IMP', 4], ['???', 'IMP', 1],
    ['???', 'ABS', 4], ['SBC', 'ABX', 4], ['INC', 'ABX', 7], ['BBS7', 'ZPR', 5],
    ]

    const cpu = new CPU(
      () => 0,
      () => {}
    )

    /** 'bound ABX' -> 'ABX'. Same trick OpcodeTable.test.ts uses. */
    const modeOf = (opcode: number): string =>
      cpu.instructionTable[opcode]!.addrMode.name.replace(/^bound /, '')

    const hex = (opcode: number): string => `$${opcode.toString(16).padStart(2, '0').toUpperCase()}`

    it('covers all 256 opcodes', () => {
      expect(MATRIX).toHaveLength(256)
      expect(cpu.instructionTable).toHaveLength(256)
    })

    it('implements the published mnemonic for every opcode', () => {
      const drifted = MATRIX.flatMap(([name], opcode) =>
        name === cpu.instructionTable[opcode]!.name
          ? []
          : [`${hex(opcode)}: ${cpu.instructionTable[opcode]!.name}, matrix says ${name}`]
      )
      expect(drifted).toEqual([])
    })

    it('implements the published addressing mode for every opcode', () => {
      // The one that matters most: the mode fixes the instruction's width, and
      // a wrong width desynchronises every instruction after it.
      const drifted = MATRIX.flatMap(([, mode], opcode) =>
        mode === modeOf(opcode)
          ? []
          : [`${hex(opcode)}: ${modeOf(opcode)}, matrix says ${mode}`]
      )
      expect(drifted).toEqual([])
    })

    it('carries the published base cycle count for every opcode', () => {
      const drifted = MATRIX.flatMap(([, , cycles], opcode) =>
        cycles === cpu.instructionTable[opcode]!.cycles
          ? []
          : [`${hex(opcode)}: ${cpu.instructionTable[opcode]!.cycles}, matrix says ${cycles}`]
      )
      expect(drifted).toEqual([])
    })
  })
})
