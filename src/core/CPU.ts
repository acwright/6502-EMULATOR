// 65c02 CPU
// Adapted from: https://github.com/OneLoneCoder/olcNES

export interface CPUInstruction {
  name: string
  cycles: number
  opcode: () => number
  addrMode: () => number
}

export class CPU {

  static C: number = 0b00000001
  static Z: number = 0b00000010
  static I: number = 0b00000100
  static D: number = 0b00001000
  static B: number = 0b00010000
  static U: number = 0b00100000
  static V: number = 0b01000000
  static N: number = 0b10000000

  private fetched: number   = 0x00    // Working input value to the ALU
  private temp: number      = 0x0000  // A convenience var used everywhere
  private addrAbs: number   = 0x0000  // All used memory addresses end up here
  private addrRel: number   = 0x0000  // Represents abs address following a branch
  private opcode: number    = 0x00    // The instruction byte

  cyclesRem: number = 0               // Counts how many cycles the current instruction has remaining
  cycles: number            = 0       // Counts the total number of cycles executed

  private irqLine: boolean = false

  a: number   = 0x00
  x: number   = 0x00
  y: number   = 0x00
  pc: number  = 0x0000
  sp: number  = 0xFD
  st: number  = 0x00 | CPU.U

  read: (address: number) => number
  write: (address: number, data: number) => void

  constructor(
    read: (address: number) => number,
    write: (address: number, data: number) => void
  ) {
    this.read = read
    this.write = write
  }

  //
  // Interface
  //

  reset(): void {
    // Read the PC location from the Reset vector
    const resetVector = 0xFFFC
    const lo: number = this.read(resetVector + 0)
    const hi: number = this.read(resetVector + 1)
    this.pc = (hi << 8) | lo

    // Clear the registers
    this.a = 0x00
    this.x = 0x00
    this.y = 0x00
    this.sp = 0xFD
    this.st = 0x00 | CPU.U

    // Clear our helper variables
    this.addrRel = 0x0000
    this.addrAbs = 0x0000
    this.fetched = 0x00

    // Reset takes 7 clock cycles
    this.cyclesRem = 7
    this.cycles += 7
  }

  irq(): void {
    // Are interrupts enabled?
    if (this.getFlag(CPU.I) == 0) {
      // Push the program counter onto the stack
      this.write(0x0100 + this.sp, (this.pc >> 8) & 0x00FF)
      this.decSP()
      this.write(0x0100 + this.sp, this.pc & 0x00FF)
      this.decSP()

      // Push the status register onto the stack (B=0, I unchanged)
      this.setFlag(CPU.B, false)
      this.write(0x0100 + this.sp, this.st)
      this.decSP()

      // Now set I to prevent nested interrupts
      this.setFlag(CPU.I, true)

      // Read new PC location from IRQ vector
      const irqVector = 0xFFFE
      const lo: number = this.read(irqVector + 0)
      const hi: number = this.read(irqVector + 1)
      this.pc = (hi << 8) | lo

      // IRQ takes 7 clock cycles
      this.cyclesRem = 7
      this.cycles += 7
    }
  }

  irqTrigger(): void {
    this.irqLine = true
  }

  irqClear(): void {
    this.irqLine = false
  }

  nmi(): void {
      // Push the program counter onto the stack
      this.write(0x0100 + this.sp, (this.pc >> 8) & 0x00FF)
      this.decSP()
      this.write(0x0100 + this.sp, this.pc & 0x00FF)
      this.decSP()

      // Push the status register onto the stack (B=0, I unchanged)
      this.setFlag(CPU.B, false)
      this.write(0x0100 + this.sp, this.st)
      this.decSP()

      // Now set I to prevent nested interrupts
      this.setFlag(CPU.I, true)

      // Read new PC location from NMI vector
      const nmiVector = 0xFFFA
      const lo: number = this.read(nmiVector + 0)
      const hi: number = this.read(nmiVector + 1)
      this.pc = (hi << 8) | lo

      // NMI takes 7 clock cycles
      this.cyclesRem = 7
      this.cycles += 7
  }

  tick(): void {
    if (this.cyclesRem == 0) {
      // Perform one clock cycle
      this.opcode = this.read(this.pc)

      this.setFlag(CPU.U, true)
      this.incPC()

      const instruction = this.instructionTable[this.opcode]

      this.cyclesRem  = instruction.cycles
      this.cycles     += instruction.cycles

      const addCycleAddrMode  = instruction.addrMode()
      const addCycleOpcode    = instruction.opcode()
      
      // addrMode() and opcode() return 1 or 0 if additional clock cycles are required
      this.cyclesRem += addCycleAddrMode & addCycleOpcode
      this.cycles    += addCycleAddrMode & addCycleOpcode

      // Level-triggered IRQ: check after instruction decode
      if (this.irqLine) {
        this.irq()
      }
    }

    this.cyclesRem--
  }

  step(): number {
    // Finish current instruction
    if (this.cyclesRem > 0) {
      do {
        this.tick()
      } while (this.cyclesRem > 0)
    }

    const startCycles = this.cycles

    // Execute one instruction
    do {
      this.tick()
    } while (this.cyclesRem > 0)

    return this.cycles - startCycles
  }


  //
  // Helpers
  //

  private fetch() {
    // For IMP addressing mode (opcode 0x0A, 0x2A, 0x4A, 0x6A), fetched is already set to this.a
    // Don't fetch from memory for those instructions
    const accumulatorOpcodes = [0x0A, 0x1A, 0x2A, 0x3A, 0x4A, 0x6A]
    if (!accumulatorOpcodes.includes(this.opcode)) {
      this.fetched = this.read(this.addrAbs)
    }
  }

  private getFlag(flag: number): number {
    return (this.st & flag) > 0 ? 1 : 0
  }

  private setFlag(flag: number, value: boolean): void {
    if (value) {
      this.st |= flag
    } else {
      this.st &= ~flag
    }
  }

  private incPC() {
    if (this.pc == 0xFFFF) {
      this.pc = 0x0000
    } else {
      this.pc++
    }
  }

  private decPC() {
    if (this.pc > 0x0000) {
      this.pc--
    } else {
      this.pc = 0xFFFF
    }
  }

  private incSP() {
    if (this.sp == 0xFF) {
      this.sp = 0x00
    } else {
      this.sp++
    }
  }

  private decSP() {
    if (this.sp > 0x00) {
      this.sp--
    } else {
      this.sp = 0xFF
    }
  }

  //
  // Addressing Modes
  //

  private IMP(): number {
    this.fetched = this.a
    return 0 
  }

  private IMM(): number {
    this.addrAbs = this.pc;
    this.incPC()
    return 0
  }

  private ZP0(): number {
    this.addrAbs = this.read(this.pc)
    this.incPC()
    this.addrAbs &= 0x00FF
    return 0
  }

  private ZPX(): number {
    this.addrAbs = this.read(this.pc) + this.x
    this.incPC()
    this.addrAbs &= 0x00FF
    return 0
  }

  private ZPY(): number {
    this.addrAbs = this.read(this.pc) + this.y
    this.incPC()
    this.addrAbs &= 0x00FF
    return 0
  }

  private REL(): number {
    this.addrRel = this.read(this.pc)
    this.incPC()
    if ((this.addrRel & 0x80) != 0) {
      this.addrRel |= 0xFFFFFF00
    }
    return 0
  }

  private ABS(): number {
    const lo: number = this.read(this.pc)
    this.incPC()
    const hi: number = this.read(this.pc)
    this.incPC()

    this.addrAbs = (hi << 8) | lo

    return 0
  }

  private ABX(): number {
    const lo: number = this.read(this.pc)
    this.incPC()
    const hi: number = this.read(this.pc)
    this.incPC()

    this.addrAbs = (hi << 8) | lo
    this.addrAbs += this.x

    if ((this.addrAbs & 0xFF00) != (hi << 8)) {
      return 1
    } else {
      return 0
    }
  }

  private ABY(): number {
    const lo: number = this.read(this.pc)
    this.incPC()
    const hi: number = this.read(this.pc)
    this.incPC()

    this.addrAbs = (hi << 8) | lo
    this.addrAbs += this.y

    if ((this.addrAbs & 0xFF00) != (hi << 8)) {
      return 1
    } else {
      return 0
    }
  }

  private IND(): number {
    const ptrLo: number = this.read(this.pc)
    this.incPC()
    const ptrHi: number = this.read(this.pc)
    this.incPC()

    const ptr = (ptrHi << 8) | ptrLo

    // 65C02 fixed the page boundary bug from the original 6502
    this.addrAbs = (this.read(ptr + 1) << 8) | this.read(ptr)

    return 0
  }

  private IZX(): number {
    const t = this.read(this.pc)
    this.incPC()

    const lo = this.read((t + this.x) & 0x00FF)
    const hi = this.read((t + this.x + 1) & 0x00FF)

    this.addrAbs = (hi << 8) | lo

    return 0
  }

  private IZY(): number {
    const t = this.read(this.pc)
    this.incPC()

    const lo = this.read((t ) & 0x00FF)
    const hi = this.read((t + 1) & 0x00FF)

    this.addrAbs = (hi << 8) | lo
    this.addrAbs += this.y

    if ((this.addrAbs & 0xFF00) != (hi << 8)) {
      return 1
    } else {
      return 0
    }
  }

  // IZP - Zero Page Indirect - (zp)
  // 65C02-only addressing mode used by ORA/AND/EOR/ADC/STA/LDA/CMP/SBC (zp)
  private IZP(): number {
    const t = this.read(this.pc)
    this.incPC()

    const lo = this.read(t & 0x00FF)
    const hi = this.read((t + 1) & 0x00FF)

    this.addrAbs = (hi << 8) | lo

    return 0
  }

  // IAX - Indexed Absolute Indirect - (a,x)
  // Used by JMP (addr,X) on 65C02
  private IAX(): number {
    const lo = this.read(this.pc)
    this.incPC()
    const hi = this.read(this.pc)
    this.incPC()

    const ptr = ((hi << 8) | lo) + this.x

    const addrLo = this.read(ptr)
    const addrHi = this.read(ptr + 1)

    this.addrAbs = (addrHi << 8) | addrLo

    return 0
  }

  // ZPR - Zero Page + Relative
  // Used by BBR/BBS instructions on WDC 65C02
  private ZPR(): number {
    // First byte is zero page address
    this.addrAbs = this.read(this.pc) & 0x00FF
    this.incPC()

    // Second byte is relative offset for branch
    const relAddr = this.read(this.pc)
    this.incPC()

    if (relAddr & 0x80) {
      this.addrRel = relAddr | 0xFF00
    } else {
      this.addrRel = relAddr
    }

    return 0
  }

  //
  // Opcodes
  //

  private ADC(): number {
    this.fetch()

    if (this.getFlag(CPU.D)) {
      // BCD decimal mode (65C02)
      const c = this.getFlag(CPU.C)
      const bin = this.a + this.fetched + c

      let lo = (this.a & 0x0F) + (this.fetched & 0x0F) + c
      if (lo > 0x09) lo += 0x06
      let hi = (this.a >> 4) + (this.fetched >> 4) + (lo > 0x0F ? 1 : 0)
      if (hi > 0x09) hi += 0x06

      const result = (hi << 4) | (lo & 0x0F)

      this.setFlag(CPU.Z, (bin & 0xFF) === 0)
      this.setFlag(CPU.V, ((this.a ^ bin) & (this.fetched ^ bin) & 0x80) !== 0)
      this.setFlag(CPU.N, (bin & 0x80) !== 0)
      this.setFlag(CPU.C, hi > 0x0F)

      this.a = result & 0xFF
    } else {
      this.temp = this.a + this.fetched + this.getFlag(CPU.C)
      this.setFlag(CPU.C, (this.temp & 0xFF00) != 0)
      this.setFlag(CPU.Z, (this.temp & 0x00FF) == 0)
      this.setFlag(CPU.V, ((this.temp ^ this.a) & (this.temp ^ this.fetched) & 0x0080) != 0)
      this.setFlag(CPU.N, (this.temp & 0x0080) != 0)

      this.a = this.temp & 0x00FF
    }

    return 1
  }
  
  private AND(): number {
    this.fetch()
    this.a &= this.fetched
    this.setFlag(CPU.Z, this.a == 0x00)
    this.setFlag(CPU.N, (this.a & 0x80) != 0)
    return 1
  }

  private ASL(): number {
    this.fetch()
    this.temp = this.fetched << 1
    this.setFlag(CPU.C, (this.temp & 0xFF00) > 0)
    this.setFlag(CPU.Z, (this.temp & 0x00FF) == 0x00)
    this.setFlag(CPU.N, (this.temp & 0x80) != 0)
    // Opcode 0x0A is ASL A (accumulator mode)
    if (this.opcode === 0x0A) {
      this.a = this.temp & 0x00FF
    } else {
      this.write(this.addrAbs, this.temp & 0x00FF)
    }
    return 0
  }

  private BCC(): number {
    if (this.getFlag(CPU.C) == 0) {
      this.cyclesRem++
      this.addrAbs = this.pc + this.addrRel

      if ((this.addrAbs & 0xFF00) != (this.pc & 0xFF00)) {
        this.cyclesRem++
      }

      this.pc = this.addrAbs
    }
    return 0
  }

  private BCS(): number {
    if (this.getFlag(CPU.C) == 1) {
      this.cyclesRem++
      this.addrAbs = this.pc + this.addrRel

      if ((this.addrAbs & 0xFF00) != (this.pc & 0xFF00)) {
        this.cyclesRem++
      }

      this.pc = this.addrAbs
    }
    return 0
  }

  private BEQ(): number {
    if (this.getFlag(CPU.Z) == 1) {
      this.cyclesRem++
      this.addrAbs = this.pc + this.addrRel
      if ((this.addrAbs & 0xFF00) != (this.pc & 0xFF00)) {
        this.cyclesRem++
      }

      this.pc = this.addrAbs
    }
    return 0
  }

  private BIT(): number {
    this.fetch()
    this.temp = this.a & this.fetched
    this.setFlag(CPU.Z, (this.temp & 0x00FF) == 0x00)
    this.setFlag(CPU.N, (this.fetched & (1 << 7)) != 0)
    this.setFlag(CPU.V, (this.fetched & (1 << 6)) != 0)
    return 0
  }

  private BIT_IMM(): number {
    this.fetch()
    this.temp = this.a & this.fetched
    this.setFlag(CPU.Z, (this.temp & 0x00FF) == 0x00)
    // N and V are NOT modified for BIT immediate (65C02)
    return 0
  }

  private BMI(): number {
    if (this.getFlag(CPU.N) == 1) {
      this.cyclesRem++
      this.addrAbs = this.pc + this.addrRel

      if ((this.addrAbs & 0xFF00) != (this.pc & 0xFF00)) {
        this.cyclesRem++
      }

      this.pc = this.addrAbs
    }
    return 0
  }

  private BNE(): number {
    if (this.getFlag(CPU.Z) == 0) {
      this.cyclesRem++
      this.addrAbs = this.pc + this.addrRel

      if ((this.addrAbs & 0xFF00) != (this.pc & 0xFF00)) {
        this.cyclesRem++
      }

      this.pc = this.addrAbs
    }
    return 0
  }

  private BPL(): number {
    if (this.getFlag(CPU.N) == 0) {
      this.cyclesRem++
      this.addrAbs = this.pc + this.addrRel

      if ((this.addrAbs & 0xFF00) != (this.pc & 0xFF00)) {
        this.cyclesRem++
      }

      this.pc = this.addrAbs
    }
    return 0
  }

  private BRK(): number {
    this.incPC()

    this.setFlag(CPU.I, true)
    this.write(0x0100 + this.sp, (this.pc >> 8) & 0x00FF)
    this.decSP()
    this.write(0x0100 + this.sp, this.pc & 0x00FF)
    this.decSP()

    this.setFlag(CPU.B, true)
    this.write(0x0100 + this.sp, this.st)
    this.decSP()
    this.setFlag(CPU.B, false)

    this.pc = this.read(0xFFFE) | this.read(0xFFFF) << 8

    return 0
  }
  
  private BVC(): number {
    if (this.getFlag(CPU.V) == 0) {
      this.cyclesRem++
      this.addrAbs = this.pc + this.addrRel

      if ((this.addrAbs & 0xFF00) != (this.pc & 0xFF00)) {
        this.cyclesRem++
      }

      this.pc = this.addrAbs
    }
    return 0
  }

  private BVS(): number {
    if (this.getFlag(CPU.V) == 1) {
      this.cyclesRem++
      this.addrAbs = this.pc + this.addrRel

      if ((this.addrAbs & 0xFF00) != (this.pc & 0xFF00)) {
        this.cyclesRem++
      }

      this.pc = this.addrAbs
    }
    return 0
  }

  private CLC(): number {
    this.setFlag(CPU.C, false)
    return 0
  }

  private CLD(): number {
    this.setFlag(CPU.D, false)
    return 0
  }

  private CLI(): number {
    this.setFlag(CPU.I, false)
    return 0
  }

  private CLV(): number {
    this.setFlag(CPU.V, false)
    return 0
  }

  private CMP(): number {
    this.fetch()
    this.temp = this.a - this.fetched
    this.setFlag(CPU.C, this.a >= this.fetched)
    this.setFlag(CPU.Z, (this.temp & 0x00FF) == 0x0000)
    this.setFlag(CPU.N, (this.temp & 0x0080) != 0)
    return 1
  }

  private CPX(): number {
    this.fetch()
    this.temp = this.x - this.fetched
    this.setFlag(CPU.C, this.x >= this.fetched)
    this.setFlag(CPU.Z, (this.temp & 0x00FF) == 0x0000)
    this.setFlag(CPU.N, (this.temp & 0x0080) != 0)
    return 0
  }

  private CPY(): number {
    this.fetch()
    this.temp = this.y - this.fetched
    this.setFlag(CPU.C, this.y >= this.fetched)
    this.setFlag(CPU.Z, (this.temp & 0x00FF) == 0x0000)
    this.setFlag(CPU.N, (this.temp & 0x0080) != 0)
    return 0
  }

  private DEC(): number {
    this.fetch()
    this.temp = this.fetched - 0x01
    // Opcode 0x3A is DEC A (accumulator mode, 65C02)
    if (this.opcode === 0x3A) {
      this.a = this.temp & 0x00FF
    } else {
      this.write(this.addrAbs, this.temp & 0x00FF)
    }
    this.setFlag(CPU.Z, (this.temp & 0x00FF) == 0x0000)
    this.setFlag(CPU.N, (this.temp & 0x0080) != 0)
    return 0
  }

  private DEX(): number {
    this.x = (this.x - 1) & 0xFF
    this.setFlag(CPU.Z, this.x == 0x00)
    this.setFlag(CPU.N, (this.x & 0x80) != 0)
    return 0
  }

  private DEY(): number {
    this.y = (this.y - 1) & 0xFF
    this.setFlag(CPU.Z, this.y == 0x00)
    this.setFlag(CPU.N, (this.y & 0x80) != 0)
    return 0
  }

  private EOR(): number {
    this.fetch()
    this.a ^= this.fetched
    this.setFlag(CPU.Z, this.a == 0x00)
    this.setFlag(CPU.N, (this.a & 0x80) != 0)
    return 1
  }

  private INC(): number {
    this.fetch()
    this.temp = this.fetched + 1
    // Opcode 0x1A is INC A (accumulator mode, 65C02)
    if (this.opcode === 0x1A) {
      this.a = this.temp & 0x00FF
    } else {
      this.write(this.addrAbs, this.temp & 0x00FF)
    }
    this.setFlag(CPU.Z, (this.temp & 0x00FF) == 0x0000)
    this.setFlag(CPU.N, (this.temp & 0x0080) != 0)
    return 0
  }

  private INX(): number {
    this.x = (this.x + 1) & 0xFF
    this.setFlag(CPU.Z, this.x == 0x00)
    this.setFlag(CPU.N, (this.x & 0x80) != 0)
    return 0
  }

  private INY(): number {
    this.y = (this.y + 1) & 0xFF
    this.setFlag(CPU.Z, this.y == 0x00)
    this.setFlag(CPU.N, (this.y & 0x80) != 0)
    return 0
  }

  private JMP(): number {
    this.pc = this.addrAbs
    return 0
  }

  private JSR(): number {
    this.decPC()

    this.write(0x0100 + this.sp, (this.pc >> 8) & 0x00FF)
    this.decSP()
    this.write(0x0100 + this.sp, this.pc & 0x00FF)
    this.decSP()

    this.pc = this.addrAbs

    return 0
  }

  private LDA(): number {
    this.fetch()
    this.a = this.fetched
    this.setFlag(CPU.Z, this.a == 0x00)
    this.setFlag(CPU.N, (this.a & 0x80) != 0)
    return 1
  }

  private LDX(): number {
    this.fetch()
    this.x = this.fetched
    this.setFlag(CPU.Z, this.x == 0x00)
    this.setFlag(CPU.N, (this.x & 0x80) != 0)
    return 1
  }

  private LDY(): number {
    this.fetch()
    this.y = this.fetched
    this.setFlag(CPU.Z, this.y == 0x00)
    this.setFlag(CPU.N, (this.y & 0x80) != 0)
    return 1
  }

  private LSR(): number {
    this.fetch()
    this.setFlag(CPU.C, (this.fetched & 0x0001) != 0)
    this.temp = this.fetched >> 1
    this.setFlag(CPU.Z, (this.temp & 0x00FF) == 0x0000)
    this.setFlag(CPU.N, (this.temp & 0x0080) != 0)
    // Opcode 0x4A is LSR A (accumulator mode)
    if (this.opcode === 0x4A) {
      this.a = this.temp & 0x00FF
    } else {
      this.write(this.addrAbs, this.temp & 0x00FF)
    }
    return 0
  }

  private NOP(): number {
    switch (this.opcode) {
      case 0x1C:
      case 0x3C:
      case 0x5C:
      case 0x7C:
      case 0xDC:
      case 0xFC:
        return 1
      }
    return 0
  }

  private ORA(): number {
    this.fetch()
    this.a |= this.fetched
    this.setFlag(CPU.Z, this.a == 0x00)
    this.setFlag(CPU.N, (this.a & 0x80) != 0)
    return 1
  }

  private PHA(): number {
    this.write(0x0100 + this.sp, this.a)
    this.decSP()
    return 0
  }

  private PHP(): number {
    this.write(0x0100 + this.sp, this.st | CPU.B | CPU.U)
    this.setFlag(CPU.B, false)
    this.setFlag(CPU.U, false)
    this.decSP()
    return 0
  }

  private PLA(): number {
    this.incSP()
    this.a = this.read(0x0100 + this.sp)
    this.setFlag(CPU.Z, this.a == 0x00)
    this.setFlag(CPU.N, (this.a & 0x80) != 0)
    return 0
  }

  private PLP(): number {
    this.incSP()
    this.st = this.read(0x0100 + this.sp)
    this.setFlag(CPU.U, true)
    return 0
  }

  private ROL(): number {
    this.fetch()
    this.temp = (this.fetched << 1) | this.getFlag(CPU.C)
    this.setFlag(CPU.C, (this.temp & 0xFF00) != 0)
    this.setFlag(CPU.Z, (this.temp & 0x00FF) == 0x00)
    this.setFlag(CPU.N, (this.temp & 0x0080) != 0)
    // Opcode 0x2A is ROL A (accumulator mode)
    if (this.opcode === 0x2A) {
      this.a = this.temp & 0x00FF
    } else {
      this.write(this.addrAbs, this.temp & 0x00FF)
    }
    return 0
  }

  private ROR(): number {
    this.fetch()
    this.temp = (this.getFlag(CPU.C) << 7) | (this.fetched >> 1)
    this.setFlag(CPU.C, (this.fetched & 0x01) != 0)
    this.setFlag(CPU.Z, (this.temp & 0x00FF) == 0x00)
    this.setFlag(CPU.N, (this.temp & 0x0080) != 0)
    // Opcode 0x6A is ROR A (accumulator mode)
    if (this.opcode === 0x6A) {
      this.a = this.temp & 0x00FF
    } else {
      this.write(this.addrAbs, this.temp & 0x00FF)
    }
    return 0
  }

  private RTI(): number {
    this.incSP()
    this.st = this.read(0x0100 + this.sp)
    this.st &= ~CPU.B
    this.st &= ~CPU.U
    this.incSP()
    this.pc = this.read(0x0100 + this.sp)
    this.incSP()
    this.pc |= this.read(0x0100 + this.sp) << 8
    return 0
  }

  private RTS(): number {
    this.incSP()
    this.pc = this.read(0x0100 + this.sp)
    this.incSP()
    this.pc |= this.read(0x0100 + this.sp) << 8
    this.incPC()

    return 0
  }

  private SBC(): number {
    this.fetch()

    if (this.getFlag(CPU.D)) {
      // BCD decimal mode (65C02)
      const c = this.getFlag(CPU.C)
      const bin = this.a - this.fetched - (1 - c)

      let lo = (this.a & 0x0F) - (this.fetched & 0x0F) - (1 - c)
      if (lo < 0) lo = ((lo - 0x06) & 0x0F) | ((this.a & 0xF0) - (this.fetched & 0xF0) - 0x10)
      else lo = (lo & 0x0F) | ((this.a & 0xF0) - (this.fetched & 0xF0))
      if (lo < 0) lo -= 0x60

      const result = lo & 0xFF

      this.setFlag(CPU.Z, (bin & 0xFF) === 0)
      this.setFlag(CPU.V, ((this.a ^ bin) & (~this.fetched ^ bin) & 0x80) !== 0)
      this.setFlag(CPU.N, (bin & 0x80) !== 0)
      this.setFlag(CPU.C, (bin & 0xFFFF) < 0x100)

      this.a = result
    } else {
      const value = this.fetched ^ 0x00FF

      this.temp = this.a + value + this.getFlag(CPU.C)
      this.setFlag(CPU.C, (this.temp & 0xFF00) != 0)
      this.setFlag(CPU.Z, (this.temp & 0x00FF) == 0)
      this.setFlag(CPU.V, ((this.temp ^ this.a) & (this.temp ^ value) & 0x0080) != 0)
      this.setFlag(CPU.N, (this.temp & 0x0080) != 0)

      this.a = this.temp & 0x00FF
    }

    return 1
  }

  private SEC(): number {
    this.setFlag(CPU.C, true)
    return 0
  }

  private SED(): number {
    this.setFlag(CPU.D, true)
    return 0
  }

  private SEI(): number {
    this.setFlag(CPU.I, true)
    return 0
  }

  private STA(): number {
    this.write(this.addrAbs, this.a)
	  return 0
  }

  private STX(): number {
    this.write(this.addrAbs, this.x)
	  return 0
  }

  private STY(): number {
    this.write(this.addrAbs, this.y)
	  return 0
  }

  private TAX(): number {
    this.x = this.a
    this.setFlag(CPU.Z, this.x == 0x00)
    this.setFlag(CPU.N, (this.x & 0x80) != 0)
    return 0
  }

  private TAY(): number {
    this.y = this.a
    this.setFlag(CPU.Z, this.y == 0x00)
    this.setFlag(CPU.N, (this.y & 0x80) != 0)
    return 0
  }

  private TSX(): number {
    this.x = this.sp
    this.setFlag(CPU.Z, this.x == 0x00)
    this.setFlag(CPU.N, (this.x & 0x80) != 0)
    return 0
  }

  private TXA(): number {
    this.a = this.x
    this.setFlag(CPU.Z, this.a == 0x00)
    this.setFlag(CPU.N, (this.a & 0x80) != 0)
    return 0
  }

  private TXS(): number {
    this.sp = this.x
    return 0
  }

  private TYA(): number {
    this.a = this.y
    this.setFlag(CPU.Z, this.a == 0x00)
    this.setFlag(CPU.N, (this.a & 0x80) != 0)
    return 0
  }

  //
  // 65C02 Instructions
  //

  private BRA(): number {
    // Branch Always
    this.cyclesRem++
    this.pc = (this.pc + this.addrRel) & 0xFFFF

    if ((this.pc & 0xFF00) != ((this.pc - this.addrRel) & 0xFF00)) {
      this.cyclesRem++
    }

    return 0
  }

  private PHX(): number {
    // Push X Register
    this.write(0x0100 + this.sp, this.x)
    this.decSP()
    return 0
  }

  private PHY(): number {
    // Push Y Register
    this.write(0x0100 + this.sp, this.y)
    this.decSP()
    return 0
  }

  private PLX(): number {
    // Pull X Register
    this.incSP()
    this.x = this.read(0x0100 + this.sp)
    this.setFlag(CPU.Z, this.x == 0x00)
    this.setFlag(CPU.N, (this.x & 0x80) != 0)
    return 0
  }

  private PLY(): number {
    // Pull Y Register
    this.incSP()
    this.y = this.read(0x0100 + this.sp)
    this.setFlag(CPU.Z, this.y == 0x00)
    this.setFlag(CPU.N, (this.y & 0x80) != 0)
    return 0
  }

  private STZ(): number {
    // Store Zero
    this.write(this.addrAbs, 0x00)
    return 0
  }

  private TRB(): number {
    // Test and Reset Bits
    this.fetch()
    this.setFlag(CPU.Z, (this.a & this.fetched) == 0x00)
    this.write(this.addrAbs, this.fetched & ~this.a)
    return 0
  }

  private TSB(): number {
    // Test and Set Bits
    this.fetch()
    this.setFlag(CPU.Z, (this.a & this.fetched) == 0x00)
    this.write(this.addrAbs, this.fetched | this.a)
    return 0
  }

  //
  // WDC 65C02 Instructions
  //

  private STP(): number {
    // Stop the processor
    // Implementation: halt execution by preventing PC increment
    // The processor would need to be reset to continue
    this.cyclesRem = 0xFF // Set a large cycle count to effectively halt
    return 0
  }

  private WAI(): number {
    // Wait for Interrupt
    // Implementation: stall until an interrupt occurs
    // For simplicity, we'll just add cycles
    this.cyclesRem = 0xFF // Wait state
    return 0
  }

  private BBR(bit: number): number {
    // Branch on Bit Reset
    this.fetch()
    if ((this.fetched & (1 << bit)) == 0) {
      this.cyclesRem++
      this.pc = (this.pc + this.addrRel) & 0xFFFF

      if ((this.pc & 0xFF00) != ((this.pc - this.addrRel) & 0xFF00)) {
        this.cyclesRem++
      }
    }
    return 0
  }

  private BBR0(): number { return this.BBR(0) }
  private BBR1(): number { return this.BBR(1) }
  private BBR2(): number { return this.BBR(2) }
  private BBR3(): number { return this.BBR(3) }
  private BBR4(): number { return this.BBR(4) }
  private BBR5(): number { return this.BBR(5) }
  private BBR6(): number { return this.BBR(6) }
  private BBR7(): number { return this.BBR(7) }

  private BBS(bit: number): number {
    // Branch on Bit Set
    this.fetch()
    if ((this.fetched & (1 << bit)) != 0) {
      this.cyclesRem++
      this.pc = (this.pc + this.addrRel) & 0xFFFF

      if ((this.pc & 0xFF00) != ((this.pc - this.addrRel) & 0xFF00)) {
        this.cyclesRem++
      }
    }
    return 0
  }

  private BBS0(): number { return this.BBS(0) }
  private BBS1(): number { return this.BBS(1) }
  private BBS2(): number { return this.BBS(2) }
  private BBS3(): number { return this.BBS(3) }
  private BBS4(): number { return this.BBS(4) }
  private BBS5(): number { return this.BBS(5) }
  private BBS6(): number { return this.BBS(6) }
  private BBS7(): number { return this.BBS(7) }

  private RMB(bit: number): number {
    // Reset Memory Bit
    this.fetch()
    this.write(this.addrAbs, this.fetched & ~(1 << bit))
    return 0
  }

  private RMB0(): number { return this.RMB(0) }
  private RMB1(): number { return this.RMB(1) }
  private RMB2(): number { return this.RMB(2) }
  private RMB3(): number { return this.RMB(3) }
  private RMB4(): number { return this.RMB(4) }
  private RMB5(): number { return this.RMB(5) }
  private RMB6(): number { return this.RMB(6) }
  private RMB7(): number { return this.RMB(7) }

  private SMB(bit: number): number {
    // Set Memory Bit
    this.fetch()
    this.write(this.addrAbs, this.fetched | (1 << bit))
    return 0
  }

  private SMB0(): number { return this.SMB(0) }
  private SMB1(): number { return this.SMB(1) }
  private SMB2(): number { return this.SMB(2) }
  private SMB3(): number { return this.SMB(3) }
  private SMB4(): number { return this.SMB(4) }
  private SMB5(): number { return this.SMB(5) }
  private SMB6(): number { return this.SMB(6) }
  private SMB7(): number { return this.SMB(7) }

  private XXX(): number { return 0 }

  //
  // Instruction Table
  //

  instructionTable: CPUInstruction[] = [
    { name: 'BRK', cycles: 7, opcode: this.BRK.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'ORA', cycles: 6, opcode: this.ORA.bind(this), addrMode: this.IZX.bind(this) },
    { name: '???', cycles: 2, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 8, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'TSB', cycles: 5, opcode: this.TSB.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'ORA', cycles: 3, opcode: this.ORA.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'ASL', cycles: 5, opcode: this.ASL.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'RMB0', cycles: 5, opcode: this.RMB0.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'PHP', cycles: 3, opcode: this.PHP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'ORA', cycles: 2, opcode: this.ORA.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'ASL', cycles: 2, opcode: this.ASL.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 2, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'TSB', cycles: 6, opcode: this.TSB.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'ORA', cycles: 4, opcode: this.ORA.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'ASL', cycles: 6, opcode: this.ASL.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'BBR0', cycles: 5, opcode: this.BBR0.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'BPL', cycles: 2, opcode: this.BPL.bind(this), addrMode: this.REL.bind(this) },
    { name: 'ORA', cycles: 5, opcode: this.ORA.bind(this), addrMode: this.IZY.bind(this) },
    { name: 'ORA', cycles: 5, opcode: this.ORA.bind(this), addrMode: this.IZP.bind(this) },
    { name: '???', cycles: 8, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'TRB', cycles: 5, opcode: this.TRB.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'ORA', cycles: 4, opcode: this.ORA.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'ASL', cycles: 6, opcode: this.ASL.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'RMB1', cycles: 5, opcode: this.RMB1.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'CLC', cycles: 2, opcode: this.CLC.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'ORA', cycles: 4, opcode: this.ORA.bind(this), addrMode: this.ABY.bind(this) },
    { name: 'INC', cycles: 2, opcode: this.INC.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 7, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'TRB', cycles: 6, opcode: this.TRB.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'ORA', cycles: 4, opcode: this.ORA.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'ASL', cycles: 7, opcode: this.ASL.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'BBR1', cycles: 5, opcode: this.BBR1.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'JSR', cycles: 6, opcode: this.JSR.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'AND', cycles: 6, opcode: this.AND.bind(this), addrMode: this.IZX.bind(this) },
    { name: '???', cycles: 2, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 8, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'BIT', cycles: 3, opcode: this.BIT.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'AND', cycles: 3, opcode: this.AND.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'ROL', cycles: 5, opcode: this.ROL.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'RMB2', cycles: 5, opcode: this.RMB2.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'PLP', cycles: 4, opcode: this.PLP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'AND', cycles: 2, opcode: this.AND.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'ROL', cycles: 2, opcode: this.ROL.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 2, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'BIT', cycles: 4, opcode: this.BIT.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'AND', cycles: 4, opcode: this.AND.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'ROL', cycles: 6, opcode: this.ROL.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'BBR2', cycles: 5, opcode: this.BBR2.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'BMI', cycles: 2, opcode: this.BMI.bind(this), addrMode: this.REL.bind(this) },
    { name: 'AND', cycles: 5, opcode: this.AND.bind(this), addrMode: this.IZY.bind(this) },
    { name: 'AND', cycles: 5, opcode: this.AND.bind(this), addrMode: this.IZP.bind(this) },
    { name: '???', cycles: 8, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 4, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'AND', cycles: 4, opcode: this.AND.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'ROL', cycles: 6, opcode: this.ROL.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'RMB3', cycles: 5, opcode: this.RMB3.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'SEC', cycles: 2, opcode: this.SEC.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'AND', cycles: 4, opcode: this.AND.bind(this), addrMode: this.ABY.bind(this) },
    { name: 'DEC', cycles: 2, opcode: this.DEC.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 7, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 4, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'AND', cycles: 4, opcode: this.AND.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'ROL', cycles: 7, opcode: this.ROL.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'BBR3', cycles: 5, opcode: this.BBR3.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'RTI', cycles: 6, opcode: this.RTI.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'EOR', cycles: 6, opcode: this.EOR.bind(this), addrMode: this.IZX.bind(this) },
    { name: '???', cycles: 2, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 8, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 3, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'EOR', cycles: 3, opcode: this.EOR.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'LSR', cycles: 5, opcode: this.LSR.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'RMB4', cycles: 5, opcode: this.RMB4.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'PHA', cycles: 3, opcode: this.PHA.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'EOR', cycles: 2, opcode: this.EOR.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'LSR', cycles: 2, opcode: this.LSR.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 2, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'JMP', cycles: 3, opcode: this.JMP.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'EOR', cycles: 4, opcode: this.EOR.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'LSR', cycles: 6, opcode: this.LSR.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'BBR4', cycles: 5, opcode: this.BBR4.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'BVC', cycles: 2, opcode: this.BVC.bind(this), addrMode: this.REL.bind(this) },
    { name: 'EOR', cycles: 5, opcode: this.EOR.bind(this), addrMode: this.IZY.bind(this) },
    { name: 'EOR', cycles: 5, opcode: this.EOR.bind(this), addrMode: this.IZP.bind(this) },
    { name: '???', cycles: 8, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 4, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'EOR', cycles: 4, opcode: this.EOR.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'LSR', cycles: 6, opcode: this.LSR.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'RMB5', cycles: 5, opcode: this.RMB5.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'CLI', cycles: 2, opcode: this.CLI.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'EOR', cycles: 4, opcode: this.EOR.bind(this), addrMode: this.ABY.bind(this) },
    { name: 'PHY', cycles: 3, opcode: this.PHY.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 7, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 4, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'EOR', cycles: 4, opcode: this.EOR.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'LSR', cycles: 7, opcode: this.LSR.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'BBR5', cycles: 5, opcode: this.BBR5.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'RTS', cycles: 6, opcode: this.RTS.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'ADC', cycles: 6, opcode: this.ADC.bind(this), addrMode: this.IZX.bind(this) },
    { name: '???', cycles: 2, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 8, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'STZ', cycles: 3, opcode: this.STZ.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'ADC', cycles: 3, opcode: this.ADC.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'ROR', cycles: 5, opcode: this.ROR.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'RMB6', cycles: 5, opcode: this.RMB6.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'PLA', cycles: 4, opcode: this.PLA.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'ADC', cycles: 2, opcode: this.ADC.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'ROR', cycles: 2, opcode: this.ROR.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 2, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'JMP', cycles: 5, opcode: this.JMP.bind(this), addrMode: this.IND.bind(this) },
    { name: 'ADC', cycles: 4, opcode: this.ADC.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'ROR', cycles: 6, opcode: this.ROR.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'BBR6', cycles: 5, opcode: this.BBR6.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'BVS', cycles: 2, opcode: this.BVS.bind(this), addrMode: this.REL.bind(this) },
    { name: 'ADC', cycles: 5, opcode: this.ADC.bind(this), addrMode: this.IZY.bind(this) },
    { name: 'ADC', cycles: 5, opcode: this.ADC.bind(this), addrMode: this.IZP.bind(this) },
    { name: '???', cycles: 8, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'STZ', cycles: 4, opcode: this.STZ.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'ADC', cycles: 4, opcode: this.ADC.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'ROR', cycles: 6, opcode: this.ROR.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'RMB7', cycles: 5, opcode: this.RMB7.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'SEI', cycles: 2, opcode: this.SEI.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'ADC', cycles: 4, opcode: this.ADC.bind(this), addrMode: this.ABY.bind(this) },
    { name: 'PLY', cycles: 4, opcode: this.PLY.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 7, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'JMP', cycles: 6, opcode: this.JMP.bind(this), addrMode: this.IAX.bind(this) },
    { name: 'ADC', cycles: 4, opcode: this.ADC.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'ROR', cycles: 7, opcode: this.ROR.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'BBR7', cycles: 5, opcode: this.BBR7.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'BRA', cycles: 3, opcode: this.BRA.bind(this), addrMode: this.REL.bind(this) },
    { name: 'STA', cycles: 6, opcode: this.STA.bind(this), addrMode: this.IZX.bind(this) },
    { name: '???', cycles: 2, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 6, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'STY', cycles: 3, opcode: this.STY.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'STA', cycles: 3, opcode: this.STA.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'STX', cycles: 3, opcode: this.STX.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'SMB0', cycles: 5, opcode: this.SMB0.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'DEY', cycles: 2, opcode: this.DEY.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'BIT', cycles: 2, opcode: this.BIT_IMM.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'TXA', cycles: 2, opcode: this.TXA.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 2, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'STY', cycles: 4, opcode: this.STY.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'STA', cycles: 4, opcode: this.STA.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'STX', cycles: 4, opcode: this.STX.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'BBS0', cycles: 5, opcode: this.BBS0.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'BCC', cycles: 2, opcode: this.BCC.bind(this), addrMode: this.REL.bind(this) },
    { name: 'STA', cycles: 6, opcode: this.STA.bind(this), addrMode: this.IZY.bind(this) },
    { name: 'STA', cycles: 5, opcode: this.STA.bind(this), addrMode: this.IZP.bind(this) },
    { name: '???', cycles: 6, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'STY', cycles: 4, opcode: this.STY.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'STA', cycles: 4, opcode: this.STA.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'STX', cycles: 4, opcode: this.STX.bind(this), addrMode: this.ZPY.bind(this) },
    { name: 'SMB1', cycles: 5, opcode: this.SMB1.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'TYA', cycles: 2, opcode: this.TYA.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'STA', cycles: 5, opcode: this.STA.bind(this), addrMode: this.ABY.bind(this) },
    { name: 'TXS', cycles: 2, opcode: this.TXS.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 5, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'STZ', cycles: 4, opcode: this.STZ.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'STA', cycles: 5, opcode: this.STA.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'STZ', cycles: 5, opcode: this.STZ.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'BBS1', cycles: 5, opcode: this.BBS1.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'LDY', cycles: 2, opcode: this.LDY.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'LDA', cycles: 6, opcode: this.LDA.bind(this), addrMode: this.IZX.bind(this) },
    { name: 'LDX', cycles: 2, opcode: this.LDX.bind(this), addrMode: this.IMM.bind(this) },
    { name: '???', cycles: 6, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'LDY', cycles: 3, opcode: this.LDY.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'LDA', cycles: 3, opcode: this.LDA.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'LDX', cycles: 3, opcode: this.LDX.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'SMB2', cycles: 5, opcode: this.SMB2.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'TAY', cycles: 2, opcode: this.TAY.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'LDA', cycles: 2, opcode: this.LDA.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'TAX', cycles: 2, opcode: this.TAX.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 2, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'LDY', cycles: 4, opcode: this.LDY.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'LDA', cycles: 4, opcode: this.LDA.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'LDX', cycles: 4, opcode: this.LDX.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'BBS2', cycles: 5, opcode: this.BBS2.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'BCS', cycles: 2, opcode: this.BCS.bind(this), addrMode: this.REL.bind(this) },
    { name: 'LDA', cycles: 5, opcode: this.LDA.bind(this), addrMode: this.IZY.bind(this) },
    { name: 'LDA', cycles: 5, opcode: this.LDA.bind(this), addrMode: this.IZP.bind(this) },
    { name: '???', cycles: 5, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'LDY', cycles: 4, opcode: this.LDY.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'LDA', cycles: 4, opcode: this.LDA.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'LDX', cycles: 4, opcode: this.LDX.bind(this), addrMode: this.ZPY.bind(this) },
    { name: 'SMB3', cycles: 5, opcode: this.SMB3.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'CLV', cycles: 2, opcode: this.CLV.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'LDA', cycles: 4, opcode: this.LDA.bind(this), addrMode: this.ABY.bind(this) },
    { name: 'TSX', cycles: 2, opcode: this.TSX.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 4, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'LDY', cycles: 4, opcode: this.LDY.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'LDA', cycles: 4, opcode: this.LDA.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'LDX', cycles: 4, opcode: this.LDX.bind(this), addrMode: this.ABY.bind(this) },
    { name: 'BBS3', cycles: 5, opcode: this.BBS3.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'CPY', cycles: 2, opcode: this.CPY.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'CMP', cycles: 6, opcode: this.CMP.bind(this), addrMode: this.IZX.bind(this) },
    { name: '???', cycles: 2, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 8, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'CPY', cycles: 3, opcode: this.CPY.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'CMP', cycles: 3, opcode: this.CMP.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'DEC', cycles: 5, opcode: this.DEC.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'SMB4', cycles: 5, opcode: this.SMB4.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'INY', cycles: 2, opcode: this.INY.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'CMP', cycles: 2, opcode: this.CMP.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'DEX', cycles: 2, opcode: this.DEX.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 2, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'CPY', cycles: 4, opcode: this.CPY.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'CMP', cycles: 4, opcode: this.CMP.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'DEC', cycles: 6, opcode: this.DEC.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'BBS4', cycles: 5, opcode: this.BBS4.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'BNE', cycles: 2, opcode: this.BNE.bind(this), addrMode: this.REL.bind(this) },
    { name: 'CMP', cycles: 5, opcode: this.CMP.bind(this), addrMode: this.IZY.bind(this) },
    { name: 'CMP', cycles: 5, opcode: this.CMP.bind(this), addrMode: this.IZP.bind(this) },
    { name: '???', cycles: 8, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 4, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'CMP', cycles: 4, opcode: this.CMP.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'DEC', cycles: 6, opcode: this.DEC.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'SMB5', cycles: 5, opcode: this.SMB5.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'CLD', cycles: 2, opcode: this.CLD.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'CMP', cycles: 4, opcode: this.CMP.bind(this), addrMode: this.ABY.bind(this) },
    { name: 'PHX', cycles: 3, opcode: this.PHX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'STP', cycles: 3, opcode: this.STP.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 4, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'CMP', cycles: 4, opcode: this.CMP.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'DEC', cycles: 7, opcode: this.DEC.bind(this), addrMode: this.ABX.bind(this) },
    { name: '???', cycles: 7, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },

    { name: 'CPX', cycles: 2, opcode: this.CPX.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'SBC', cycles: 6, opcode: this.SBC.bind(this), addrMode: this.IZX.bind(this) },
    { name: '???', cycles: 2, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 8, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'CPX', cycles: 3, opcode: this.CPX.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'SBC', cycles: 3, opcode: this.SBC.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'INC', cycles: 5, opcode: this.INC.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'SMB6', cycles: 5, opcode: this.SMB6.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'INX', cycles: 2, opcode: this.INX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'SBC', cycles: 2, opcode: this.SBC.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'NOP', cycles: 2, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'WAI', cycles: 3, opcode: this.WAI.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'CPX', cycles: 4, opcode: this.CPX.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'SBC', cycles: 4, opcode: this.SBC.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'INC', cycles: 6, opcode: this.INC.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'BBS5', cycles: 5, opcode: this.BBS5.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'BEQ', cycles: 2, opcode: this.BEQ.bind(this), addrMode: this.REL.bind(this) },
    { name: 'SBC', cycles: 5, opcode: this.SBC.bind(this), addrMode: this.IZY.bind(this) },
    { name: 'SBC', cycles: 5, opcode: this.SBC.bind(this), addrMode: this.IZP.bind(this) },
    { name: '???', cycles: 8, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 4, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'SBC', cycles: 4, opcode: this.SBC.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'INC', cycles: 6, opcode: this.INC.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'SMB7', cycles: 5, opcode: this.SMB7.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'SED', cycles: 2, opcode: this.SED.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'SBC', cycles: 4, opcode: this.SBC.bind(this), addrMode: this.ABY.bind(this) },
    { name: 'PLX', cycles: 4, opcode: this.PLX.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 7, opcode: this.XXX.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 4, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'SBC', cycles: 4, opcode: this.SBC.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'INC', cycles: 7, opcode: this.INC.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'BBS7', cycles: 5, opcode: this.BBS7.bind(this), addrMode: this.ZPR.bind(this) } 
  ]

}