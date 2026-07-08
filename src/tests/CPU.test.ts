import { CPU } from '../core/CPU'

describe('CPU', () => {
  let memory: number[]
  let cpu: CPU

  beforeEach(() => {
    memory = new Array(0x10000).fill(0)
    
    const read = (address: number): number => {
      return memory[address & 0xFFFF] || 0
    }
    
    const write = (address: number, data: number): void => {
      memory[address & 0xFFFF] = data & 0xFF
    }
    
    cpu = new CPU(read, write)
  })

  describe('Initialization', () => {
    test('should create a new CPU instance', () => {
      expect(cpu).not.toBeNull()
    })

    test('should initialize with default register values', () => {
      expect(cpu.a).toBe(0x00)
      expect(cpu.x).toBe(0x00)
      expect(cpu.y).toBe(0x00)
      expect(cpu.pc).toBe(0x0000)
      expect(cpu.sp).toBe(0xFD)
      expect(cpu.st).toBe(CPU.U)
      expect(cpu.cyclesRem).toBe(0)
      expect(cpu.cycles).toBe(0)
    })
  })

  describe('Reset', () => {
    test('should reset CPU and load PC from reset vector', () => {
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      
      expect(cpu.pc).toBe(0x8000)
      expect(cpu.a).toBe(0x00)
      expect(cpu.x).toBe(0x00)
      expect(cpu.y).toBe(0x00)
      expect(cpu.sp).toBe(0xFD)
      expect(cpu.st).toBe(CPU.U)
      expect(cpu.cyclesRem).toBe(7)
    })

    test('should add 7 cycles on reset', () => {
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      const initialCycles = cpu.cycles
      cpu.reset()
      
      expect(cpu.cycles).toBe(initialCycles + 7)
    })
  })

  describe('Status Flags', () => {
    test('should set carry flag (C)', () => {
      // SEC - Set Carry Flag (0x38)
      memory[0x8000] = 0x38
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()
      
      expect(cpu.st & CPU.C).toBe(CPU.C)
    })

    test('should clear carry flag (C)', () => {
      // CLC - Clear Carry Flag (0x18)
      memory[0x8000] = 0x38  // SEC
      memory[0x8001] = 0x18  // CLC
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // SEC
      cpu.step()  // CLC
      
      expect(cpu.st & CPU.C).toBe(0)
    })

    test('should set interrupt disable flag (I)', () => {
      // SEI - Set Interrupt Disable (0x78)
      memory[0x8000] = 0x78
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()
      
      expect(cpu.st & CPU.I).toBe(CPU.I)
    })

    test('should clear interrupt disable flag (I)', () => {
      // CLI - Clear Interrupt Disable (0x58)
      memory[0x8000] = 0x78  // SEI
      memory[0x8001] = 0x58  // CLI
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // SEI
      cpu.step()  // CLI
      
      expect(cpu.st & CPU.I).toBe(0)
    })

    test('should set decimal mode flag (D)', () => {
      // SED - Set Decimal Mode (0xF8)
      memory[0x8000] = 0xF8
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()
      
      expect(cpu.st & CPU.D).toBe(CPU.D)
    })

    test('should clear decimal mode flag (D)', () => {
      // CLD - Clear Decimal Mode (0xD8)
      memory[0x8000] = 0xF8  // SED
      memory[0x8001] = 0xD8  // CLD
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // SED
      cpu.step()  // CLD
      
      expect(cpu.st & CPU.D).toBe(0)
    })

    test('should clear overflow flag (V)', () => {
      // CLV - Clear Overflow Flag (0xB8)
      memory[0x8000] = 0xB8
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.st |= CPU.V
      cpu.step()
      
      expect(cpu.st & CPU.V).toBe(0)
    })
  })

  describe('Load Instructions', () => {
    test('LDA immediate should load accumulator', () => {
      // LDA #$42
      memory[0x8000] = 0xA9  // LDA immediate
      memory[0x8001] = 0x42
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()
      
      expect(cpu.a).toBe(0x42)
    })

    test('LDA should set zero flag when loading zero', () => {
      // LDA #$00
      memory[0x8000] = 0xA9  // LDA immediate
      memory[0x8001] = 0x00
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()
      
      expect(cpu.a).toBe(0x00)
      expect(cpu.st & CPU.Z).toBe(CPU.Z)
    })

    test('LDA should set negative flag when loading negative value', () => {
      // LDA #$80
      memory[0x8000] = 0xA9  // LDA immediate
      memory[0x8001] = 0x80
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()
      
      expect(cpu.a).toBe(0x80)
      expect(cpu.st & CPU.N).toBe(CPU.N)
    })

    test('LDX immediate should load X register', () => {
      // LDX #$55
      memory[0x8000] = 0xA2  // LDX immediate
      memory[0x8001] = 0x55
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()
      
      expect(cpu.x).toBe(0x55)
    })

    test('LDY immediate should load Y register', () => {
      // LDY #$66
      memory[0x8000] = 0xA0  // LDY immediate
      memory[0x8001] = 0x66
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()
      
      expect(cpu.y).toBe(0x66)
    })

    test('LDA zero page should load from zero page', () => {
      memory[0x0010] = 0x77
      memory[0x8000] = 0xA5  // LDA zero page
      memory[0x8001] = 0x10
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()
      
      expect(cpu.a).toBe(0x77)
    })

    test('LDA absolute should load from absolute address', () => {
      memory[0x1234] = 0x88
      memory[0x8000] = 0xAD  // LDA absolute
      memory[0x8001] = 0x34
      memory[0x8002] = 0x12
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()
      
      expect(cpu.a).toBe(0x88)
    })

    test('LDA (zp) [65C02] should load via zero-page indirect', () => {
      // Zero-page pointer at $40/$41 -> $1234
      memory[0x0040] = 0x34
      memory[0x0041] = 0x12
      memory[0x1234] = 0x77
      memory[0x8000] = 0xB2  // LDA (zp)
      memory[0x8001] = 0x40
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80

      cpu.reset()
      cpu.step()

      expect(cpu.a).toBe(0x77)
    })

    test('LDA (zp) [65C02] should wrap pointer high byte at zero-page boundary', () => {
      // Pointer at $FF/$00 (wraps within zero page)
      memory[0x00FF] = 0xCD
      memory[0x0000] = 0xAB
      memory[0xABCD] = 0x55
      memory[0x8000] = 0xB2  // LDA (zp)
      memory[0x8001] = 0xFF
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80

      cpu.reset()
      cpu.step()

      expect(cpu.a).toBe(0x55)
    })

    test('CMP (zp) [65C02] should compare via zero-page indirect', () => {
      memory[0x0030] = 0x00
      memory[0x0031] = 0x90
      memory[0x9000] = 0x42
      memory[0x8000] = 0xA9  // LDA #$42
      memory[0x8001] = 0x42
      memory[0x8002] = 0xD2  // CMP (zp)
      memory[0x8003] = 0x30
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80

      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // CMP

      expect(cpu.st & CPU.Z).toBe(CPU.Z)
      expect(cpu.st & CPU.C).toBe(CPU.C)
    })
  })

  describe('Store Instructions', () => {
    test('STA zero page should store accumulator', () => {
      memory[0x8000] = 0xA9  // LDA #$42
      memory[0x8001] = 0x42
      memory[0x8002] = 0x85  // STA $10
      memory[0x8003] = 0x10
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // STA
      
      expect(memory[0x0010]).toBe(0x42)
    })

    test('STX zero page should store X register', () => {
      memory[0x8000] = 0xA2  // LDX #$55
      memory[0x8001] = 0x55
      memory[0x8002] = 0x86  // STX $20
      memory[0x8003] = 0x20
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDX
      cpu.step()  // STX
      
      expect(memory[0x0020]).toBe(0x55)
    })

    test('STY zero page should store Y register', () => {
      memory[0x8000] = 0xA0  // LDY #$66
      memory[0x8001] = 0x66
      memory[0x8002] = 0x84  // STY $30
      memory[0x8003] = 0x30
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDY
      cpu.step()  // STY
      
      expect(memory[0x0030]).toBe(0x66)
    })

    test('STA absolute should store to absolute address', () => {
      memory[0x8000] = 0xA9  // LDA #$99
      memory[0x8001] = 0x99
      memory[0x8002] = 0x8D  // STA $1234
      memory[0x8003] = 0x34
      memory[0x8004] = 0x12
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // STA
      
      expect(memory[0x1234]).toBe(0x99)
    })
  })

  describe('Transfer Instructions', () => {
    test('TAX should transfer A to X', () => {
      memory[0x8000] = 0xA9  // LDA #$42
      memory[0x8001] = 0x42
      memory[0x8002] = 0xAA  // TAX
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // TAX
      
      expect(cpu.x).toBe(0x42)
    })

    test('TAY should transfer A to Y', () => {
      memory[0x8000] = 0xA9  // LDA #$55
      memory[0x8001] = 0x55
      memory[0x8002] = 0xA8  // TAY
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // TAY
      
      expect(cpu.y).toBe(0x55)
    })

    test('TXA should transfer X to A', () => {
      memory[0x8000] = 0xA2  // LDX #$66
      memory[0x8001] = 0x66
      memory[0x8002] = 0x8A  // TXA
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDX
      cpu.step()  // TXA
      
      expect(cpu.a).toBe(0x66)
    })

    test('TYA should transfer Y to A', () => {
      memory[0x8000] = 0xA0  // LDY #$77
      memory[0x8001] = 0x77
      memory[0x8002] = 0x98  // TYA
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDY
      cpu.step()  // TYA
      
      expect(cpu.a).toBe(0x77)
    })

    test('TSX should transfer SP to X', () => {
      memory[0x8000] = 0xBA  // TSX
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.sp = 0xAB
      cpu.step()  // TSX
      
      expect(cpu.x).toBe(0xAB)
    })

    test('TXS should transfer X to SP', () => {
      memory[0x8000] = 0xA2  // LDX #$CD
      memory[0x8001] = 0xCD
      memory[0x8002] = 0x9A  // TXS
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDX
      cpu.step()  // TXS
      
      expect(cpu.sp).toBe(0xCD)
    })
  })

  describe('Increment and Decrement', () => {
    test('INX should increment X register', () => {
      memory[0x8000] = 0xA2  // LDX #$10
      memory[0x8001] = 0x10
      memory[0x8002] = 0xE8  // INX
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDX
      cpu.step()  // INX
      
      expect(cpu.x).toBe(0x11)
    })

    test('INX should wrap around from 0xFF to 0x00', () => {
      memory[0x8000] = 0xA2  // LDX #$FF
      memory[0x8001] = 0xFF
      memory[0x8002] = 0xE8  // INX
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDX
      cpu.step()  // INX
      
      expect(cpu.x).toBe(0x00)
      expect(cpu.st & CPU.Z).toBe(CPU.Z)
    })

    test('INY should increment Y register', () => {
      memory[0x8000] = 0xA0  // LDY #$20
      memory[0x8001] = 0x20
      memory[0x8002] = 0xC8  // INY
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDY
      cpu.step()  // INY
      
      expect(cpu.y).toBe(0x21)
    })

    test('DEX should decrement X register', () => {
      memory[0x8000] = 0xA2  // LDX #$10
      memory[0x8001] = 0x10
      memory[0x8002] = 0xCA  // DEX
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDX
      cpu.step()  // DEX
      
      expect(cpu.x).toBe(0x0F)
    })

    test('DEX should wrap around from 0x00 to 0xFF', () => {
      memory[0x8000] = 0xA2  // LDX #$00
      memory[0x8001] = 0x00
      memory[0x8002] = 0xCA  // DEX
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDX
      cpu.step()  // DEX
      
      expect(cpu.x).toBe(0xFF)
      expect(cpu.st & CPU.N).toBe(CPU.N)
    })

    test('DEY should decrement Y register', () => {
      memory[0x8000] = 0xA0  // LDY #$20
      memory[0x8001] = 0x20
      memory[0x8002] = 0x88  // DEY
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDY
      cpu.step()  // DEY
      
      expect(cpu.y).toBe(0x1F)
    })

    test('INC zero page should increment memory', () => {
      memory[0x0010] = 0x42
      memory[0x8000] = 0xE6  // INC $10
      memory[0x8001] = 0x10
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // INC
      
      expect(memory[0x0010]).toBe(0x43)
    })

    test('DEC zero page should decrement memory', () => {
      memory[0x0010] = 0x42
      memory[0x8000] = 0xC6  // DEC $10
      memory[0x8001] = 0x10
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // DEC
      
      expect(memory[0x0010]).toBe(0x41)
    })
  })

  describe('Arithmetic Operations', () => {
    test('ADC should add with carry', () => {
      memory[0x8000] = 0xA9  // LDA #$10
      memory[0x8001] = 0x10
      memory[0x8002] = 0x69  // ADC #$20
      memory[0x8003] = 0x20
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // ADC
      
      expect(cpu.a).toBe(0x30)
      expect(cpu.st & CPU.C).toBe(0)
    })

    test('ADC should set carry flag on overflow', () => {
      memory[0x8000] = 0xA9  // LDA #$FF
      memory[0x8001] = 0xFF
      memory[0x8002] = 0x69  // ADC #$02
      memory[0x8003] = 0x02
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // ADC
      
      expect(cpu.a).toBe(0x01)
      expect(cpu.st & CPU.C).toBe(CPU.C)
    })

    test('ADC should add carry flag to result', () => {
      memory[0x8000] = 0x38  // SEC (set carry)
      memory[0x8001] = 0xA9  // LDA #$10
      memory[0x8002] = 0x10
      memory[0x8003] = 0x69  // ADC #$20
      memory[0x8004] = 0x20
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // SEC
      cpu.step()  // LDA
      cpu.step()  // ADC
      
      expect(cpu.a).toBe(0x31)
    })

    test('SBC should subtract with borrow', () => {
      memory[0x8000] = 0x38  // SEC (required for SBC)
      memory[0x8001] = 0xA9  // LDA #$30
      memory[0x8002] = 0x30
      memory[0x8003] = 0xE9  // SBC #$10
      memory[0x8004] = 0x10
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // SEC
      cpu.step()  // LDA
      cpu.step()  // SBC
      
      expect(cpu.a).toBe(0x20)
      expect(cpu.st & CPU.C).toBe(CPU.C)
    })

    test('SBC should handle underflow', () => {
      memory[0x8000] = 0x38  // SEC
      memory[0x8001] = 0xA9  // LDA #$10
      memory[0x8002] = 0x10
      memory[0x8003] = 0xE9  // SBC #$20
      memory[0x8004] = 0x20
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // SEC
      cpu.step()  // LDA
      cpu.step()  // SBC
      
      expect(cpu.a).toBe(0xF0)
      expect(cpu.st & CPU.C).toBe(0)
    })
  })

  describe('Logical Operations', () => {
    test('AND should perform bitwise AND', () => {
      memory[0x8000] = 0xA9  // LDA #$FF
      memory[0x8001] = 0xFF
      memory[0x8002] = 0x29  // AND #$0F
      memory[0x8003] = 0x0F
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // AND
      
      expect(cpu.a).toBe(0x0F)
    })

    test('ORA should perform bitwise OR', () => {
      memory[0x8000] = 0xA9  // LDA #$0F
      memory[0x8001] = 0x0F
      memory[0x8002] = 0x09  // ORA #$F0
      memory[0x8003] = 0xF0
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // ORA
      
      expect(cpu.a).toBe(0xFF)
    })

    test('EOR should perform bitwise XOR', () => {
      memory[0x8000] = 0xA9  // LDA #$FF
      memory[0x8001] = 0xFF
      memory[0x8002] = 0x49  // EOR #$0F
      memory[0x8003] = 0x0F
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // EOR
      
      expect(cpu.a).toBe(0xF0)
    })

    test('BIT should test bits', () => {
      memory[0x0010] = 0xC0  // Bits 7 and 6 set
      memory[0x8000] = 0xA9  // LDA #$C0
      memory[0x8001] = 0xC0
      memory[0x8002] = 0x24  // BIT $10
      memory[0x8003] = 0x10
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // BIT
      
      expect(cpu.st & CPU.N).toBe(CPU.N)  // Bit 7
      expect(cpu.st & CPU.V).toBe(CPU.V)  // Bit 6
      expect(cpu.st & CPU.Z).toBe(0)      // Result not zero
    })
  })

  describe('Shift and Rotate Operations', () => {
    test('ASL accumulator should shift left', () => {
      memory[0x8000] = 0xA9  // LDA #$42
      memory[0x8001] = 0x42
      memory[0x8002] = 0x0A  // ASL A
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // ASL
      
      expect(cpu.a).toBe(0x84)
    })

    test('ASL should set carry flag on bit 7', () => {
      memory[0x8000] = 0xA9  // LDA #$80
      memory[0x8001] = 0x80
      memory[0x8002] = 0x0A  // ASL A
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // ASL
      
      expect(cpu.a).toBe(0x00)
      expect(cpu.st & CPU.C).toBe(CPU.C)
    })

    test('LSR accumulator should shift right', () => {
      memory[0x8000] = 0xA9  // LDA #$42
      memory[0x8001] = 0x42
      memory[0x8002] = 0x4A  // LSR A
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // LSR
      
      expect(cpu.a).toBe(0x21)
    })

    test('LSR should set carry flag on bit 0', () => {
      memory[0x8000] = 0xA9  // LDA #$01
      memory[0x8001] = 0x01
      memory[0x8002] = 0x4A  // LSR A
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // LSR
      
      expect(cpu.a).toBe(0x00)
      expect(cpu.st & CPU.C).toBe(CPU.C)
    })

    test('ROL accumulator should rotate left through carry', () => {
      memory[0x8000] = 0x38  // SEC
      memory[0x8001] = 0xA9  // LDA #$42
      memory[0x8002] = 0x42
      memory[0x8003] = 0x2A  // ROL A
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // SEC
      cpu.step()  // LDA
      cpu.step()  // ROL
      
      expect(cpu.a).toBe(0x85)  // 0x42 << 1 | 1
    })

    test('ROR accumulator should rotate right through carry', () => {
      memory[0x8000] = 0x38  // SEC
      memory[0x8001] = 0xA9  // LDA #$42
      memory[0x8002] = 0x42
      memory[0x8003] = 0x6A  // ROR A
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // SEC
      cpu.step()  // LDA
      cpu.step()  // ROR
      
      expect(cpu.a).toBe(0xA1)  // 0x80 | (0x42 >> 1)
    })
  })

  describe('Compare Operations', () => {
    test('CMP should set carry when A >= operand', () => {
      memory[0x8000] = 0xA9  // LDA #$50
      memory[0x8001] = 0x50
      memory[0x8002] = 0xC9  // CMP #$30
      memory[0x8003] = 0x30
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // CMP
      
      expect(cpu.st & CPU.C).toBe(CPU.C)
      expect(cpu.st & CPU.Z).toBe(0)
    })

    test('CMP should set zero flag when A == operand', () => {
      memory[0x8000] = 0xA9  // LDA #$42
      memory[0x8001] = 0x42
      memory[0x8002] = 0xC9  // CMP #$42
      memory[0x8003] = 0x42
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // CMP
      
      expect(cpu.st & CPU.Z).toBe(CPU.Z)
      expect(cpu.st & CPU.C).toBe(CPU.C)
    })

    test('CPX should compare X register', () => {
      memory[0x8000] = 0xA2  // LDX #$50
      memory[0x8001] = 0x50
      memory[0x8002] = 0xE0  // CPX #$50
      memory[0x8003] = 0x50
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDX
      cpu.step()  // CPX
      
      expect(cpu.st & CPU.Z).toBe(CPU.Z)
      expect(cpu.st & CPU.C).toBe(CPU.C)
    })

    test('CPY should compare Y register', () => {
      memory[0x8000] = 0xA0  // LDY #$50
      memory[0x8001] = 0x50
      memory[0x8002] = 0xC0  // CPY #$30
      memory[0x8003] = 0x30
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDY
      cpu.step()  // CPY
      
      expect(cpu.st & CPU.C).toBe(CPU.C)
    })
  })

  describe('Branch Operations', () => {
    test('BEQ should branch when zero flag is set', () => {
      memory[0x8000] = 0xA9  // LDA #$00
      memory[0x8001] = 0x00
      memory[0x8002] = 0xF0  // BEQ +2
      memory[0x8003] = 0x02
      memory[0x8004] = 0xA9  // LDA #$FF (should be skipped)
      memory[0x8005] = 0xFF
      memory[0x8006] = 0xEA  // NOP
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // BEQ
      
      expect(cpu.pc).toBe(0x8006)
    })

    test('BNE should branch when zero flag is clear', () => {
      memory[0x8000] = 0xA9  // LDA #$01
      memory[0x8001] = 0x01
      memory[0x8002] = 0xD0  // BNE +2
      memory[0x8003] = 0x02
      memory[0x8004] = 0xA9  // LDA #$FF (should be skipped)
      memory[0x8005] = 0xFF
      memory[0x8006] = 0xEA  // NOP
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // BNE
      
      expect(cpu.pc).toBe(0x8006)
    })

    test('BCS should branch when carry flag is set', () => {
      memory[0x8000] = 0x38  // SEC
      memory[0x8001] = 0xB0  // BCS +2
      memory[0x8002] = 0x02
      memory[0x8003] = 0xA9  // LDA #$FF (should be skipped)
      memory[0x8004] = 0xFF
      memory[0x8005] = 0xEA  // NOP
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // SEC
      cpu.step()  // BCS
      
      expect(cpu.pc).toBe(0x8005)
    })

    test('BCC should branch when carry flag is clear', () => {
      memory[0x8000] = 0x18  // CLC
      memory[0x8001] = 0x90  // BCC +2
      memory[0x8002] = 0x02
      memory[0x8003] = 0xA9  // LDA #$FF (should be skipped)
      memory[0x8004] = 0xFF
      memory[0x8005] = 0xEA  // NOP
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // CLC
      cpu.step()  // BCC
      
      expect(cpu.pc).toBe(0x8005)
    })

    test('BMI should branch when negative flag is set', () => {
      memory[0x8000] = 0xA9  // LDA #$80
      memory[0x8001] = 0x80
      memory[0x8002] = 0x30  // BMI +2
      memory[0x8003] = 0x02
      memory[0x8004] = 0xA9  // LDA #$FF (should be skipped)
      memory[0x8005] = 0xFF
      memory[0x8006] = 0xEA  // NOP
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // BMI
      
      expect(cpu.pc).toBe(0x8006)
    })

    test('BPL should branch when negative flag is clear', () => {
      memory[0x8000] = 0xA9  // LDA #$01
      memory[0x8001] = 0x01
      memory[0x8002] = 0x10  // BPL +2
      memory[0x8003] = 0x02
      memory[0x8004] = 0xA9  // LDA #$FF (should be skipped)
      memory[0x8005] = 0xFF
      memory[0x8006] = 0xEA  // NOP
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // BPL
      
      expect(cpu.pc).toBe(0x8006)
    })

    test('BVS should branch when overflow flag is set', () => {
      memory[0x8000] = 0xA9  // LDA #$7F
      memory[0x8001] = 0x7F
      memory[0x8002] = 0x69  // ADC #$01 (causes overflow)
      memory[0x8003] = 0x01
      memory[0x8004] = 0x70  // BVS +2
      memory[0x8005] = 0x02
      memory[0x8006] = 0xA9  // LDA #$FF (should be skipped)
      memory[0x8007] = 0xFF
      memory[0x8008] = 0xEA  // NOP
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // ADC
      cpu.step()  // BVS
      
      expect(cpu.pc).toBe(0x8008)
    })

    test('BVC should branch when overflow flag is clear', () => {
      memory[0x8000] = 0xB8  // CLV
      memory[0x8001] = 0x50  // BVC +2
      memory[0x8002] = 0x02
      memory[0x8003] = 0xA9  // LDA #$FF (should be skipped)
      memory[0x8004] = 0xFF
      memory[0x8005] = 0xEA  // NOP
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // CLV
      cpu.step()  // BVC
      
      expect(cpu.pc).toBe(0x8005)
    })
  })

  describe('Jump and Subroutine Operations', () => {
    test('JMP absolute should jump to address', () => {
      memory[0x8000] = 0x4C  // JMP $9000
      memory[0x8001] = 0x00
      memory[0x8002] = 0x90
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // JMP
      
      expect(cpu.pc).toBe(0x9000)
    })

    test('JSR should jump to subroutine and save return address', () => {
      memory[0x8000] = 0x20  // JSR $9000
      memory[0x8001] = 0x00
      memory[0x8002] = 0x90
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      const oldSP = cpu.sp
      cpu.step()  // JSR
      
      expect(cpu.pc).toBe(0x9000)
      expect(cpu.sp).toBe(oldSP - 2)
    })

    test('RTS should return from subroutine', () => {
      memory[0x8000] = 0x20  // JSR $9000
      memory[0x8001] = 0x00
      memory[0x8002] = 0x90
      memory[0x8003] = 0xEA  // NOP (return here)
      memory[0x9000] = 0x60  // RTS
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // JSR
      cpu.step()  // RTS
      
      expect(cpu.pc).toBe(0x8003)
    })
  })

  describe('Stack Operations', () => {
    test('PHA should push accumulator to stack', () => {
      memory[0x8000] = 0xA9  // LDA #$42
      memory[0x8001] = 0x42
      memory[0x8002] = 0x48  // PHA
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      const oldSP = cpu.sp
      cpu.step()  // LDA
      cpu.step()  // PHA
      
      expect(memory[0x0100 + oldSP]).toBe(0x42)
      expect(cpu.sp).toBe(oldSP - 1)
    })

    test('PLA should pull accumulator from stack', () => {
      memory[0x8000] = 0xA9  // LDA #$42
      memory[0x8001] = 0x42
      memory[0x8002] = 0x48  // PHA
      memory[0x8003] = 0xA9  // LDA #$00
      memory[0x8004] = 0x00
      memory[0x8005] = 0x68  // PLA
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA #$42
      cpu.step()  // PHA
      cpu.step()  // LDA #$00
      cpu.step()  // PLA
      
      expect(cpu.a).toBe(0x42)
    })

    test('PHP should push processor status to stack', () => {
      memory[0x8000] = 0x38  // SEC
      memory[0x8001] = 0x08  // PHP
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      const oldSP = cpu.sp
      cpu.step()  // SEC
      cpu.step()  // PHP
      
      const pushedStatus = memory[0x0100 + oldSP]
      expect(pushedStatus & CPU.C).toBe(CPU.C)
      expect(cpu.sp).toBe(oldSP - 1)
    })

    test('PLP should pull processor status from stack', () => {
      memory[0x8000] = 0x38  // SEC
      memory[0x8001] = 0x08  // PHP
      memory[0x8002] = 0x18  // CLC
      memory[0x8003] = 0x28  // PLP
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // SEC
      cpu.step()  // PHP
      cpu.step()  // CLC
      expect(cpu.st & CPU.C).toBe(0)
      cpu.step()  // PLP
      
      expect(cpu.st & CPU.C).toBe(CPU.C)
    })
  })

  describe('Interrupt Operations', () => {
    test('IRQ should trigger interrupt when I flag is clear', () => {
      memory[0xFFFE] = 0x00
      memory[0xFFFF] = 0x90
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.irq()
      
      expect(cpu.pc).toBe(0x9000)
      expect(cpu.st & CPU.I).toBe(CPU.I)
    })

    test('IRQ should not trigger when I flag is set', () => {
      memory[0xFFFE] = 0x00
      memory[0xFFFF] = 0x90
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      memory[0x8000] = 0x78  // SEI
      
      cpu.reset()
      cpu.step()  // SEI
      const oldPC = cpu.pc
      cpu.irq()
      
      expect(cpu.pc).toBe(oldPC)
    })

    test('NMI should always trigger interrupt', () => {
      memory[0xFFFA] = 0x00
      memory[0xFFFB] = 0x90
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      memory[0x8000] = 0x78  // SEI
      
      cpu.reset()
      cpu.step()  // SEI
      cpu.nmi()
      
      expect(cpu.pc).toBe(0x9000)
      expect(cpu.st & CPU.I).toBe(CPU.I)
    })

    test('BRK should trigger software interrupt', () => {
      memory[0xFFFE] = 0x00
      memory[0xFFFF] = 0x90
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      memory[0x8000] = 0x00  // BRK
      
      cpu.reset()
      cpu.step()  // BRK
      
      expect(cpu.pc).toBe(0x9000)
      expect(cpu.st & CPU.I).toBe(CPU.I)
    })

    test('RTI should return from interrupt', () => {
      memory[0xFFFE] = 0x00
      memory[0xFFFF] = 0x90
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      memory[0x9000] = 0x40  // RTI
      
      cpu.reset()
      const returnPC = cpu.pc
      cpu.irq()
      cpu.step()  // RTI
      
      expect(cpu.pc).toBe(returnPC)
    })
  })

  describe('Cycle Counting', () => {
    test('should count cycles correctly', () => {
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      memory[0x8000] = 0xA9  // LDA #$42 (2 cycles)
      memory[0x8001] = 0x42
      
      cpu.reset()
      const cyclesBeforeStep = cpu.cycles
      cpu.step()
      
      expect(cpu.cycles).toBeGreaterThan(cyclesBeforeStep)
    })

    test('step should return number of cycles executed', () => {
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      memory[0x8000] = 0xA9  // LDA #$42 (2 cycles)
      memory[0x8001] = 0x42
      
      cpu.reset()
      const cyclesTaken = cpu.step()
      
      expect(cyclesTaken).toBe(2)
    })

    test('tick should decrement cyclesRem', () => {
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      memory[0x8000] = 0xEA  // NOP
      
      cpu.reset()
      cpu.tick()  // Start executing NOP
      
      expect(cpu.cyclesRem).toBeGreaterThan(0)
    })
  })

  describe('Addressing Modes', () => {
    test('zero page X indexed should work correctly', () => {
      memory[0x0015] = 0x99  // Target location ($10 + $05)
      memory[0x8000] = 0xA2  // LDX #$05
      memory[0x8001] = 0x05
      memory[0x8002] = 0xB5  // LDA $10,X
      memory[0x8003] = 0x10
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDX
      cpu.step()  // LDA
      
      expect(cpu.a).toBe(0x99)
    })

    test('zero page Y indexed should work correctly', () => {
      memory[0x0025] = 0x88  // Target location ($20 + $05)
      memory[0x8000] = 0xA0  // LDY #$05
      memory[0x8001] = 0x05
      memory[0x8002] = 0xB6  // LDX $20,Y
      memory[0x8003] = 0x20
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDY
      cpu.step()  // LDX
      
      expect(cpu.x).toBe(0x88)
    })

    test('absolute X indexed should work correctly', () => {
      memory[0x1235] = 0x77  // Target location ($1230 + $05)
      memory[0x8000] = 0xA2  // LDX #$05
      memory[0x8001] = 0x05
      memory[0x8002] = 0xBD  // LDA $1230,X
      memory[0x8003] = 0x30
      memory[0x8004] = 0x12
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDX
      cpu.step()  // LDA
      
      expect(cpu.a).toBe(0x77)
    })

    test('absolute Y indexed should work correctly', () => {
      memory[0x1245] = 0x66  // Target location ($1240 + $05)
      memory[0x8000] = 0xA0  // LDY #$05
      memory[0x8001] = 0x05
      memory[0x8002] = 0xB9  // LDA $1240,Y
      memory[0x8003] = 0x40
      memory[0x8004] = 0x12
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDY
      cpu.step()  // LDA
      
      expect(cpu.a).toBe(0x66)
    })

    test('indirect addressing should work correctly', () => {
      memory[0x0120] = 0x00  // Low byte of target address
      memory[0x0121] = 0x90  // High byte of target address
      memory[0x8000] = 0x6C  // JMP ($0120)
      memory[0x8001] = 0x20
      memory[0x8002] = 0x01
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // JMP
      
      expect(cpu.pc).toBe(0x9000)
    })
  })

  describe('Edge Cases', () => {
    test('should handle PC wraparound', () => {
      memory[0xFFFC] = 0xFE
      memory[0xFFFD] = 0xFF
      memory[0xFFFE] = 0xEA  // NOP
      memory[0xFFFF] = 0xEA  // NOP
      
      cpu.reset()
      expect(cpu.pc).toBe(0xFFFE)
      cpu.step()  // Execute NOP at 0xFFFE
      expect(cpu.pc).toBe(0xFFFF)
      cpu.step()  // Execute NOP at 0xFFFF
      expect(cpu.pc).toBe(0x0000)  // Should wrap around
    })

    test('should handle SP wraparound on underflow', () => {
      cpu.sp = 0x00
      memory[0x8000] = 0xA9  // LDA #$42
      memory[0x8001] = 0x42
      memory[0x8002] = 0x48  // PHA
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.sp = 0x00
      cpu.step()  // LDA
      cpu.step()  // PHA
      
      expect(cpu.sp).toBe(0xFF)
    })

    test('should handle zero page wraparound', () => {
      memory[0x0000] = 0x55  // Wrapped address
      memory[0x8000] = 0xA2  // LDX #$05
      memory[0x8001] = 0x05
      memory[0x8002] = 0xB5  // LDA $FB,X  ($FB + $05 = $100, wraps to $00)
      memory[0x8003] = 0xFB
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDX
      cpu.step()  // LDA
      
      expect(cpu.a).toBe(0x55)
    })

    test('NOP should do nothing', () => {
      memory[0x8000] = 0xEA  // NOP
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      const oldA = cpu.a
      const oldX = cpu.x
      const oldY = cpu.y
      const oldST = cpu.st
      cpu.step()  // NOP
      
      expect(cpu.a).toBe(oldA)
      expect(cpu.x).toBe(oldX)
      expect(cpu.y).toBe(oldY)
      expect(cpu.st).toBe(oldST)
    })

    test('should handle negative branch offsets', () => {
      memory[0x8000] = 0xA9  // LDA #$00
      memory[0x8001] = 0x00
      memory[0x8002] = 0xF0  // BEQ -4 (branch back to LDA)
      memory[0x8003] = 0xFC  // -4 in signed byte
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // BEQ
      
      expect(cpu.pc).toBe(0x8000)
    })
  })

  describe('65C02 Instructions', () => {
    describe('BRA - Branch Always', () => {
      test('should always branch forward', () => {
        memory[0x8000] = 0x80  // BRA +4
        memory[0x8001] = 0x04
        memory[0x8002] = 0xEA  // NOP (should be skipped)
        memory[0x8003] = 0xEA  // NOP (should be skipped)
        memory[0x8004] = 0xEA  // NOP (should be skipped)
        memory[0x8005] = 0xEA  // NOP (should be skipped)
        memory[0x8006] = 0xA9  // LDA #$AA
        memory[0x8007] = 0xAA
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        cpu.reset()
        cpu.step()  // BRA
        cpu.step()  // LDA
        
        expect(cpu.a).toBe(0xAA)
        expect(cpu.pc).toBe(0x8008)
      })

      test('should always branch backward', () => {
        memory[0x8000] = 0xA9  // LDA #$55
        memory[0x8001] = 0x55
        memory[0x8002] = 0x80  // BRA -4 (back to LDA)
        memory[0x8003] = 0xFC  // -4 in signed byte
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        cpu.reset()
        cpu.step()  // LDA (first time)
        cpu.step()  // BRA
        
        expect(cpu.pc).toBe(0x8000)
        expect(cpu.a).toBe(0x55)
      })
    })

    describe('PHX/PLX - Push/Pull X Register', () => {
      test('PHX should push X register to stack', () => {
        memory[0x8000] = 0xDA  // PHX
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        cpu.reset()
        cpu.x = 0x42
        const initialSP = cpu.sp
        
        cpu.step()
        
        expect(memory[0x0100 + initialSP]).toBe(0x42)
        expect(cpu.sp).toBe(initialSP - 1)
      })

      test('PLX should pull X register from stack', () => {
        memory[0x8000] = 0xFA  // PLX
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        cpu.reset()
        memory[0x0100 + cpu.sp + 1] = 0x77
        
        cpu.step()
        
        expect(cpu.x).toBe(0x77)
      })

      test('PLX should set zero flag when pulling zero', () => {
        memory[0x8000] = 0xFA  // PLX
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        cpu.reset()
        memory[0x0100 + cpu.sp + 1] = 0x00
        
        cpu.step()
        
        expect(cpu.x).toBe(0x00)
        expect(cpu.st & CPU.Z).toBe(CPU.Z)
      })

      test('PLX should set negative flag when pulling negative value', () => {
        memory[0x8000] = 0xFA  // PLX
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        cpu.reset()
        memory[0x0100 + cpu.sp + 1] = 0x80
        
        cpu.step()
        
        expect(cpu.x).toBe(0x80)
        expect(cpu.st & CPU.N).toBe(CPU.N)
      })
    })

    describe('PHY/PLY - Push/Pull Y Register', () => {
      test('PHY should push Y register to stack', () => {
        memory[0x8000] = 0x5A  // PHY
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        cpu.reset()
        cpu.y = 0x33
        const initialSP = cpu.sp
        
        cpu.step()
        
        expect(memory[0x0100 + initialSP]).toBe(0x33)
        expect(cpu.sp).toBe(initialSP - 1)
      })

      test('PLY should pull Y register from stack', () => {
        memory[0x8000] = 0x7A  // PLY
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        cpu.reset()
        memory[0x0100 + cpu.sp + 1] = 0x99
        
        cpu.step()
        
        expect(cpu.y).toBe(0x99)
      })

      test('PLY should set flags correctly', () => {
        memory[0x8000] = 0x7A  // PLY
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        cpu.reset()
        memory[0x0100 + cpu.sp + 1] = 0x80
        
        cpu.step()
        
        expect(cpu.y).toBe(0x80)
        expect(cpu.st & CPU.N).toBe(CPU.N)
      })
    })

    describe('STZ - Store Zero', () => {
      test('STZ zero page should store zero', () => {
        memory[0x8000] = 0x64  // STZ $10
        memory[0x8001] = 0x10
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x0010] = 0xFF  // Set to non-zero first
        
        cpu.reset()
        cpu.step()
        
        expect(memory[0x0010]).toBe(0x00)
      })

      test('STZ zero page,X should store zero with X offset', () => {
        memory[0x8000] = 0x74  // STZ $10,X
        memory[0x8001] = 0x10
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x0015] = 0xFF
        
        cpu.reset()
        cpu.x = 0x05
        cpu.step()
        
        expect(memory[0x0015]).toBe(0x00)
      })

      test('STZ absolute should store zero', () => {
        memory[0x8000] = 0x9C  // STZ $1234
        memory[0x8001] = 0x34
        memory[0x8002] = 0x12
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x1234] = 0xFF
        
        cpu.reset()
        cpu.step()
        
        expect(memory[0x1234]).toBe(0x00)
      })

      test('STZ absolute,X should store zero with X offset', () => {
        memory[0x8000] = 0x9E  // STZ $1234,X
        memory[0x8001] = 0x34
        memory[0x8002] = 0x12
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x1239] = 0xFF
        
        cpu.reset()
        cpu.x = 0x05
        cpu.step()
        
        expect(memory[0x1239]).toBe(0x00)
      })
    })

    describe('TRB - Test and Reset Bits', () => {
      test('TRB zero page should reset bits and test', () => {
        memory[0x8000] = 0x14  // TRB $10
        memory[0x8001] = 0x10
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x0010] = 0xFF
        
        cpu.reset()
        cpu.a = 0x0F  // Lower 4 bits
        cpu.step()
        
        expect(memory[0x0010]).toBe(0xF0)  // Lower 4 bits cleared
        expect(cpu.st & CPU.Z).toBe(0)  // Not zero because A & memory was non-zero
      })

      test('TRB should set zero flag when A & memory is zero', () => {
        memory[0x8000] = 0x14  // TRB $10
        memory[0x8001] = 0x10
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x0010] = 0xF0
        
        cpu.reset()
        cpu.a = 0x0F
        cpu.step()
        
        expect(cpu.st & CPU.Z).toBe(CPU.Z)
      })

      test('TRB absolute should work', () => {
        memory[0x8000] = 0x1C  // TRB $1234
        memory[0x8001] = 0x34
        memory[0x8002] = 0x12
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x1234] = 0xAA  // 10101010
        
        cpu.reset()
        cpu.a = 0x55  // 01010101
        cpu.step()
        
        expect(memory[0x1234]).toBe(0xAA)  // No bits cleared since no overlap
        expect(cpu.st & CPU.Z).toBe(CPU.Z)
      })
    })

    describe('TSB - Test and Set Bits', () => {
      test('TSB zero page should set bits and test', () => {
        memory[0x8000] = 0x04  // TSB $10
        memory[0x8001] = 0x10
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x0010] = 0xF0
        
        cpu.reset()
        cpu.a = 0x0F
        cpu.step()
        
        expect(memory[0x0010]).toBe(0xFF)  // All bits set
        expect(cpu.st & CPU.Z).toBe(CPU.Z)  // Was zero because A & original memory was zero
      })

      test('TSB should not set zero flag when A & memory is non-zero', () => {
        memory[0x8000] = 0x04  // TSB $10
        memory[0x8001] = 0x10
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x0010] = 0xFF
        
        cpu.reset()
        cpu.a = 0x0F
        cpu.step()
        
        expect(memory[0x0010]).toBe(0xFF)
        expect(cpu.st & CPU.Z).toBe(0)
      })

      test('TSB absolute should work', () => {
        memory[0x8000] = 0x0C  // TSB $1234
        memory[0x8001] = 0x34
        memory[0x8002] = 0x12
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x1234] = 0x00
        
        cpu.reset()
        cpu.a = 0x42
        cpu.step()
        
        expect(memory[0x1234]).toBe(0x42)
      })
    })

    describe('BIT Immediate', () => {
      test('BIT immediate should test bits without affecting N and V flags', () => {
        memory[0x8000] = 0x89  // BIT #$42
        memory[0x8001] = 0x42
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        cpu.reset()
        cpu.a = 0x42
        cpu.step()
        
        expect(cpu.st & CPU.Z).toBe(0)  // Not zero because 0x42 & 0x42 = 0x42
      })

      test('BIT immediate should set zero flag when result is zero', () => {
        memory[0x8000] = 0x89  // BIT #$0F
        memory[0x8001] = 0x0F
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        cpu.reset()
        cpu.a = 0xF0
        cpu.step()
        
        expect(cpu.st & CPU.Z).toBe(CPU.Z)
      })
    })

    describe('JMP (addr,X) - Indexed Indirect', () => {
      test('JMP (addr,X) should jump to address in table indexed by X', () => {
        memory[0x8000] = 0x7C  // JMP ($1000,X)
        memory[0x8001] = 0x00
        memory[0x8002] = 0x10
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        // Jump table at $1005 (when X=5) contains address $2000
        memory[0x1005] = 0x00
        memory[0x1006] = 0x20
        
        cpu.reset()
        cpu.x = 0x05
        cpu.step()
        
        expect(cpu.pc).toBe(0x2000)
      })

      test('JMP (addr,X) should work with different X values', () => {
        memory[0x8000] = 0x7C  // JMP ($1000,X)
        memory[0x8001] = 0x00
        memory[0x8002] = 0x10
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x100A] = 0x50
        memory[0x100B] = 0x30
        
        cpu.reset()
        cpu.x = 0x0A
        cpu.step()
        
        expect(cpu.pc).toBe(0x3050)
      })
    })
  })

  describe('WDC 65C02 Instructions', () => {
    describe('RMB/SMB - Reset/Set Memory Bit', () => {
      test('RMB0 should clear bit 0', () => {
        memory[0x8000] = 0x07  // RMB0 $10
        memory[0x8001] = 0x10
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x0010] = 0xFF
        
        cpu.reset()
        cpu.step()
        
        expect(memory[0x0010]).toBe(0xFE)  // 11111110
      })

      test('RMB7 should clear bit 7', () => {
        memory[0x8000] = 0x77  // RMB7 $10
        memory[0x8001] = 0x10
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x0010] = 0xFF
        
        cpu.reset()
        cpu.step()
        
        expect(memory[0x0010]).toBe(0x7F)  // 01111111
      })

      test('SMB0 should set bit 0', () => {
        memory[0x8000] = 0x87  // SMB0 $10
        memory[0x8001] = 0x10
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x0010] = 0x00
        
        cpu.reset()
        cpu.step()
        
        expect(memory[0x0010]).toBe(0x01)
      })

      test('SMB7 should set bit 7', () => {
        memory[0x8000] = 0xF7  // SMB7 $10
        memory[0x8001] = 0x10
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x0010] = 0x00
        
        cpu.reset()
        cpu.step()
        
        expect(memory[0x0010]).toBe(0x80)
      })

      test('SMB3 should set bit 3', () => {
        memory[0x8000] = 0xB7  // SMB3 $10
        memory[0x8001] = 0x10
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x0010] = 0x00
        
        cpu.reset()
        cpu.step()
        
        expect(memory[0x0010]).toBe(0x08)  // 00001000
      })

      test('RMB4 should clear bit 4', () => {
        memory[0x8000] = 0x47  // RMB4 $10
        memory[0x8001] = 0x10
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x0010] = 0xFF
        
        cpu.reset()
        cpu.step()
        
        expect(memory[0x0010]).toBe(0xEF)  // 11101111
      })
    })

    describe('BBR/BBS - Branch on Bit Reset/Set', () => {
      test('BBR0 should branch when bit 0 is clear', () => {
        memory[0x8000] = 0x0F  // BBR0 $10, +4
        memory[0x8001] = 0x10
        memory[0x8002] = 0x04
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x0010] = 0xFE  // Bit 0 is clear
        
        cpu.reset()
        cpu.step()
        
        expect(cpu.pc).toBe(0x8007)  // Branched forward 4 bytes
      })

      test('BBR0 should not branch when bit 0 is set', () => {
        memory[0x8000] = 0x0F  // BBR0 $10, +4
        memory[0x8001] = 0x10
        memory[0x8002] = 0x04
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x0010] = 0x01  // Bit 0 is set
        
        cpu.reset()
        cpu.step()
        
        expect(cpu.pc).toBe(0x8003)  // Did not branch
      })

      test('BBS7 should branch when bit 7 is set', () => {
        memory[0x8000] = 0xFF  // BBS7 $10, +4
        memory[0x8001] = 0x10
        memory[0x8002] = 0x04
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x0010] = 0x80  // Bit 7 is set
        
        cpu.reset()
        cpu.step()
        
        expect(cpu.pc).toBe(0x8007)  // Branched
      })

      test('BBS7 should not branch when bit 7 is clear', () => {
        memory[0x8000] = 0xFF  // BBS7 $10, +4
        memory[0x8001] = 0x10
        memory[0x8002] = 0x04
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x0010] = 0x7F  // Bit 7 is clear
        
        cpu.reset()
        cpu.step()
        
        expect(cpu.pc).toBe(0x8003)  // Did not branch
      })

      test('BBS3 should branch when bit 3 is set', () => {
        memory[0x8000] = 0xBF  // BBS3 $10, +2
        memory[0x8001] = 0x10
        memory[0x8002] = 0x02
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x0010] = 0x08  // Bit 3 is set
        
        cpu.reset()
        cpu.step()
        
        expect(cpu.pc).toBe(0x8005)  // Branched
      })

      test('BBR4 should branch backward when bit 4 is clear', () => {
        memory[0x8000] = 0xA9  // LDA #$55
        memory[0x8001] = 0x55
        memory[0x8002] = 0x4F  // BBR4 $10, -5
        memory[0x8003] = 0x10
        memory[0x8004] = 0xFB  // -5 in signed byte
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        memory[0x0010] = 0xEF  // Bit 4 is clear
        
        cpu.reset()
        cpu.step()  // LDA
        cpu.step()  // BBR4
        
        expect(cpu.pc).toBe(0x8000)  // Branched back
      })
    })

    describe('WAI - Wait for Interrupt', () => {
      test('WAI should execute and consume cycles', () => {
        memory[0x8000] = 0xCB  // WAI
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        cpu.reset()
        const initialCycles = cpu.cycles
        cpu.step()
        
        // WAI executes and consumes cycles (instruction completes)
        expect(cpu.cycles).toBeGreaterThan(initialCycles)
        expect(cpu.pc).toBe(0x8001)  // PC advanced past WAI
      })
    })

    describe('STP - Stop the Processor', () => {
      test('STP should execute and consume cycles', () => {
        memory[0x8000] = 0xDB  // STP
        memory[0xFFFC] = 0x00
        memory[0xFFFD] = 0x80
        
        cpu.reset()
        const initialCycles = cpu.cycles
        cpu.step()
        
        // STP executes and consumes cycles (instruction completes)
        expect(cpu.cycles).toBeGreaterThan(initialCycles)
        expect(cpu.pc).toBe(0x8001)  // PC advanced past STP
      })
    })
  })

  describe('Complex Programs', () => {
    test('should execute a simple loop correctly', () => {
      // Loop that adds 1 to accumulator 5 times
      memory[0x8000] = 0xA9  // LDA #$00
      memory[0x8001] = 0x00
      memory[0x8002] = 0xA2  // LDX #$05
      memory[0x8003] = 0x05
      memory[0x8004] = 0x18  // loop: CLC
      memory[0x8005] = 0x69  // ADC #$01
      memory[0x8006] = 0x01
      memory[0x8007] = 0xCA  // DEX
      memory[0x8008] = 0xD0  // BNE loop
      memory[0x8009] = 0xFA  // -6
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      cpu.reset()
      cpu.step()  // LDA
      cpu.step()  // LDX
      
      // Execute loop 5 times
      for (let i = 0; i < 5; i++) {
        cpu.step()  // CLC
        cpu.step()  // ADC
        cpu.step()  // DEX
        cpu.step()  // BNE (or fall through on last iteration)
      }
      
      expect(cpu.a).toBe(0x05)
      expect(cpu.x).toBe(0x00)
    })

    test('should use 65C02 instructions in a program', () => {
      // Use STZ and BRA in a program
      memory[0x8000] = 0x9C  // STZ $1234 - Clear memory location
      memory[0x8001] = 0x34
      memory[0x8002] = 0x12
      memory[0x8003] = 0xA9  // LDA #$42
      memory[0x8004] = 0x42
      memory[0x8005] = 0x8D  // STA $1234
      memory[0x8006] = 0x34
      memory[0x8007] = 0x12
      memory[0x8008] = 0x80  // BRA +2
      memory[0x8009] = 0x02
      memory[0x800A] = 0xEA  // NOP (skipped)
      memory[0x800B] = 0xEA  // NOP (skipped)
      memory[0x800C] = 0xAD  // LDA $1234
      memory[0x800D] = 0x34
      memory[0x800E] = 0x12
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      memory[0x1234] = 0xFF  // Initially set
      
      cpu.reset()
      cpu.step()  // STZ
      expect(memory[0x1234]).toBe(0x00)
      
      cpu.step()  // LDA
      cpu.step()  // STA
      expect(memory[0x1234]).toBe(0x42)
      
      cpu.step()  // BRA
      expect(cpu.pc).toBe(0x800C)
      
      cpu.step()  // LDA
      expect(cpu.a).toBe(0x42)
    })

    test('should use WDC 65C02 bit manipulation in a program', () => {
      // Set bit 3, then test it and branch
      memory[0x8000] = 0xB7  // SMB3 $10
      memory[0x8001] = 0x10
      memory[0x8002] = 0xBF  // BBS3 $10, +2
      memory[0x8003] = 0x10
      memory[0x8004] = 0x02
      memory[0x8005] = 0xA9  // LDA #$00 (should be skipped)
      memory[0x8006] = 0x00
      memory[0x8007] = 0xA9  // LDA #$FF (should execute)
      memory[0x8008] = 0xFF
      memory[0xFFFC] = 0x00
      memory[0xFFFD] = 0x80
      
      memory[0x0010] = 0x00
      
      cpu.reset()
      cpu.step()  // SMB3
      expect(memory[0x0010]).toBe(0x08)
      
      cpu.step()  // BBS3
      expect(cpu.pc).toBe(0x8007)  // Branched (0x8005 + 2)
      
      cpu.step()  // LDA #$FF
      expect(cpu.a).toBe(0xFF)
    })
  })
})

// TODO: Move to using https://github.com/SingleStepTests/65x02/tree/main/6502 test suite for more comprehensive testing of CPU behavior