// 65c02 CPU
// Adapted from: https://github.com/OneLoneCoder/olcNES

import { expectKind, readBoolean, readBooleanOr, readNumber } from './DeviceState'
import type { DeviceState } from './DeviceState'

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

  /**
   * WAI has pulled RDY low — the processor is asleep until an interrupt.
   *
   * Public because it is not an internal detail: the debug layer and the host
   * both need to be able to tell a machine that is idle on purpose from one
   * that has wedged.
   */
  waiting: boolean = false

  /** STP has stopped the clock to the processor. Only reset() restarts it. */
  stopped: boolean = false

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
    // RESET masks interrupts and, on a CMOS part, clears decimal mode. The NMOS
    // 6502 leaves D undefined through reset, which is why NMOS code opens with
    // CLD; the W65C02S guarantees it clear (data sheet section 3.10) and its
    // reset routine does not have to. I is set on both parts — a handler that
    // wants interrupts has to CLI for them.
    this.st = CPU.U | CPU.I

    // Clear our helper variables
    this.addrRel = 0x0000
    this.addrAbs = 0x0000
    this.fetched = 0x00

    // RESET is the only thing that lifts STP, and it lifts WAI too.
    this.waiting = false
    this.stopped = false

    // Reset takes 7 clock cycles
    this.cyclesRem = 7
    this.cycles += 7
  }

  /**
   * Take the IRQ sequence, without asking whether I permits it.
   *
   * Separate from irq() because the mask test and the sequence happen at
   * different moments on the real part. The processor samples the interrupt
   * lines — and the mask — before an instruction's final cycle, and acts on what
   * it sampled at the end of that instruction. By then the instruction may have
   * changed I, and that does not un-decide the interrupt. See tick().
   */
  private enterIrq(): void {
    // Push the program counter onto the stack
    this.write(0x0100 + this.sp, (this.pc >> 8) & 0x00FF)
    this.decSP()
    this.write(0x0100 + this.sp, this.pc & 0x00FF)
    this.decSP()

    // Push the status register onto the stack (B=0, I unchanged)
    this.setFlag(CPU.B, false)
    this.write(0x0100 + this.sp, this.st)
    this.decSP()

    // Now set I to prevent nested interrupts, and clear D. Clearing D is a
    // CMOS addition: the NMOS 6502 carries decimal mode into the handler, so
    // NMOS handlers open with CLD. The W65C02S clears it as part of taking
    // the interrupt, after the status byte is pushed — so the D the handler
    // pulls back with RTI is the one the interrupted code was using.
    this.setFlag(CPU.I, true)
    this.setFlag(CPU.D, false)

    // Read new PC location from IRQ vector
    const irqVector = 0xFFFE
    const lo: number = this.read(irqVector + 0)
    const hi: number = this.read(irqVector + 1)
    this.pc = (hi << 8) | lo

    // IRQ takes 7 clock cycles
    this.cyclesRem = 7
    this.cycles += 7
  }

  irq(): void {
    // Are interrupts enabled?
    if (this.getFlag(CPU.I) == 0) {
      this.enterIrq()
    }
  }

  irqTrigger(): void {
    this.irqLine = true
  }

  irqClear(): void {
    this.irqLine = false
  }

  nmi(): void {
      // STP stops the clock to the processor, so an NMI arriving afterwards is
      // not merely ignored — nothing latches it at all. Only RESET restarts it.
      if (this.stopped) return

      // WAI wakes on NMI. PC is already past the WAI byte, so the address
      // pushed below is the instruction after it, which is where RTI returns.
      this.waiting = false

      // Push the program counter onto the stack
      this.write(0x0100 + this.sp, (this.pc >> 8) & 0x00FF)
      this.decSP()
      this.write(0x0100 + this.sp, this.pc & 0x00FF)
      this.decSP()

      // Push the status register onto the stack (B=0, I unchanged)
      this.setFlag(CPU.B, false)
      this.write(0x0100 + this.sp, this.st)
      this.decSP()

      // Now set I to prevent nested interrupts, and clear D — see irq().
      this.setFlag(CPU.I, true)
      this.setFlag(CPU.D, false)

      // Read new PC location from NMI vector
      const nmiVector = 0xFFFA
      const lo: number = this.read(nmiVector + 0)
      const hi: number = this.read(nmiVector + 1)
      this.pc = (hi << 8) | lo

      // NMI takes 7 clock cycles
      this.cyclesRem = 7
      this.cycles += 7
  }

  /**
   * Decide whether a halted processor may run this cycle, waking it if so.
   *
   * Only called at an instruction boundary, so WAI and STP retire their own
   * three cycles normally and the halt takes effect after them.
   *
   * STP is left only by reset(). WAI is left by IRQ, NMI or RESET — nmi() and
   * reset() clear `waiting` themselves, which leaves the IRQ line as the one
   * thing to test here.
   *
   * The interrupt is serviced *here* rather than by the post-decode check in
   * tick(), so the address pushed is the instruction after WAI and not the one
   * after that. When I is set irq() does nothing, which is precisely the
   * documented behaviour: the processor wakes and carries straight on without
   * servicing anything.
   */
  private releaseHalt(): boolean {
    if (this.stopped) return false
    if (!this.irqLine) return false

    this.waiting = false
    this.irq()
    return true
  }

  tick(): void {
    if (this.cyclesRem == 0) {
      if ((this.stopped || this.waiting) && !this.releaseHalt()) {
        // Still halted — but the clock keeps running. PHI2 comes from the
        // board's oscillator divider, not from the CPU, so the I/O cards go on
        // ticking and this counter goes on counting. Every cycle budget and
        // `wait.for {cycles}` in the debug protocol is denominated in it, and
        // freezing it would turn a program sitting in WAI into a hung timeout
        // rather than a wait that can be woken.
        this.cycles++
        return
      }

      // An interrupt taken on the way out of WAI has already claimed this
      // cycle and set cyclesRem, so only decode when nothing else did.
      if (this.cyclesRem == 0) {
        // The mask as it stands before this instruction runs. Captured because
        // the interrupt decision is made against the mask of a moment that has
        // already passed by the time the instruction is finished — see below.
        const maskedBefore = this.getFlag(CPU.I)

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

        // Level-triggered IRQ, sampled the way the part samples it.
        //
        // The processor reads the interrupt lines and the I mask *before* an
        // instruction's final cycle, and acts on what it read once the
        // instruction is done. Three instructions write I in that final cycle —
        // CLI, SEI and PLP — which is after the mask has already been read. So
        // for those three the decision uses the mask from before the
        // instruction, not the one it just wrote:
        //
        //   CLI with a request already waiting is *not* serviced when the CLI
        //   finishes. The mask was still set when it was read, so the request
        //   waits for the end of the following instruction — the well-known
        //   one-instruction delay, which is why an interrupt does not arrive
        //   until after whatever the CLI was protecting.
        //
        //   SEI with a request already waiting *is* serviced once, when the SEI
        //   finishes, because the mask was still clear when it was read. A
        //   critical section opened with SEI therefore takes one last interrupt
        //   on the way in, and code that assumes otherwise works here and fails
        //   on the board.
        //
        // RTI is deliberately not in that list. It pulls the status byte three
        // cycles before it ends, so the mask it restores is already in place
        // when the lines are read, and an interrupt still asserted is taken
        // immediately on return rather than an instruction later.
        const writesMaskLate =
          this.opcode === 0x58 || this.opcode === 0x78 || this.opcode === 0x28
        const maskedAtSample = writesMaskLate ? maskedBefore : this.getFlag(CPU.I)

        if (this.irqLine && maskedAtSample === 0) {
          this.enterIrq()
        }
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
  // Snapshots
  //

  /**
   * Everything that decides what this CPU does next.
   *
   * The mid-instruction working registers are in here, not just the programmer's
   * model: `cyclesRem`, the latched `opcode` and the resolved address are what
   * make a snapshot taken between two ticks resume as the same instruction
   * rather than re-decoding from a PC that has already advanced.
   *
   * `cycles` is deliberately absent. It is a monotonic counter the host reads to
   * measure elapsed time, not state the processor acts on, and rewinding it
   * would make every cycle budget and `wait.for {cycles}` measurement across a
   * restore report negative progress.
   */
  serialize(): DeviceState {
    return {
      kind: 'cpu',
      a: this.a,
      x: this.x,
      y: this.y,
      pc: this.pc,
      sp: this.sp,
      st: this.st,
      cyclesRem: this.cyclesRem,
      fetched: this.fetched,
      temp: this.temp,
      addrAbs: this.addrAbs,
      addrRel: this.addrRel,
      opcode: this.opcode,
      irqLine: this.irqLine,
      waiting: this.waiting,
      stopped: this.stopped
    }
  }

  deserialize(state: DeviceState): void {
    expectKind(state, 'cpu')
    this.a = readNumber(state, 'a')
    this.x = readNumber(state, 'x')
    this.y = readNumber(state, 'y')
    this.pc = readNumber(state, 'pc')
    this.sp = readNumber(state, 'sp')
    this.st = readNumber(state, 'st')
    this.cyclesRem = readNumber(state, 'cyclesRem')
    this.fetched = readNumber(state, 'fetched')
    this.temp = readNumber(state, 'temp')
    this.addrAbs = readNumber(state, 'addrAbs')
    this.addrRel = readNumber(state, 'addrRel')
    this.opcode = readNumber(state, 'opcode')
    this.irqLine = readBoolean(state, 'irqLine')
    // Snapshots taken before WAI and STP halted anything carry neither field.
    // They restore as a running processor, which is what they were.
    this.waiting = readBooleanOr(state, 'waiting', false)
    this.stopped = readBooleanOr(state, 'stopped', false)
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

  /**
   * Charge cycles that an instruction only discovers once it is running.
   *
   * tick() budgets an instruction's cost at decode time, before the handler is
   * called, and adds the page-crossing cycle itself afterwards. Everything a
   * handler decides for itself — a branch being taken, decimal mode on ADC and
   * SBC — has to land in *both* counters. Bumping `cyclesRem` alone leaves the
   * instruction running a cycle longer than `cycles` says it did, and `step()`
   * returns the difference of `cycles`, so Machine.step() would tick the I/O
   * cards fewer times than the instruction actually took and its own clock
   * would drift behind a run of the same code.
   */
  private addCycles(count: number): void {
    this.cyclesRem += count
    this.cycles += count
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

  /**
   * Program counter relative, as the branches use it.
   *
   * The offset is sign-extended past 16 bits on purpose, so that adding it to
   * the PC subtracts. That makes every branch site responsible for masking the
   * sum back to 16 bits: a backward branch from low memory otherwise lands on a
   * negative PC, and a forward branch from $FFxx lands past $FFFF, where the
   * real part wraps within the address space.
   */
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
      //
      // Decimal mode costs one extra cycle on the W65C02S, where the NMOS part
      // runs it in the same time as binary — the CMOS die spends the cycle
      // doing the adjust properly rather than leaving the flags wrong.
      this.addCycles(1)

      const c = this.getFlag(CPU.C)

      let lo = (this.a & 0x0F) + (this.fetched & 0x0F) + c
      if (lo > 0x09) lo += 0x06
      let hi = (this.a >> 4) + (this.fetched >> 4) + (lo > 0x0F ? 1 : 0)

      // V is read off the high nybble *before* it is corrected — the sign the
      // adder produced, not the sign of the decimal answer. Taking it from the
      // plain binary sum instead is wrong in about 1% of decimal adds, because
      // the low nybble's correction has already carried into this sum and the
      // binary one knows nothing about it.
      const midway = (hi << 4) & 0xFF
      const overflow = (~(this.a ^ this.fetched) & (this.a ^ midway) & 0x80) !== 0

      if (hi > 0x09) hi += 0x06

      const result = ((hi << 4) | (lo & 0x0F)) & 0xFF

      // N and Z come from the decimal result on the W65C02S. On the NMOS 6502
      // they fall out of the binary sum the ALU produced before the adjust,
      // which is why they are documented as invalid in decimal mode there —
      // $50 + $50 leaves N set on an NMOS part and clear on this one.
      this.setFlag(CPU.Z, result === 0)
      this.setFlag(CPU.N, (result & 0x80) !== 0)
      this.setFlag(CPU.C, hi > 0x0F)
      this.setFlag(CPU.V, overflow)

      this.a = result
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
    // Read-modify-write in absolute indexed with X is 4 + 2 cycles, and note 1
    // still applies: add 1 more if the page boundary is crossed (W65C02S data
    // sheet, Table 4-1).  Returning 1 lets ABX's own page-crossing result
    // through; every other mode this instruction has returns 0 there, so the
    // extra cycle can only ever be added where the data sheet allows it.
    return 1
  }

  private BCC(): number {
    if (this.getFlag(CPU.C) == 0) {
      this.addCycles(1)
      this.addrAbs = (this.pc + this.addrRel) & 0xFFFF

      if ((this.addrAbs & 0xFF00) != (this.pc & 0xFF00)) {
        this.addCycles(1)
      }

      this.pc = this.addrAbs
    }
    return 0
  }

  private BCS(): number {
    if (this.getFlag(CPU.C) == 1) {
      this.addCycles(1)
      this.addrAbs = (this.pc + this.addrRel) & 0xFFFF

      if ((this.addrAbs & 0xFF00) != (this.pc & 0xFF00)) {
        this.addCycles(1)
      }

      this.pc = this.addrAbs
    }
    return 0
  }

  private BEQ(): number {
    if (this.getFlag(CPU.Z) == 1) {
      this.addCycles(1)
      this.addrAbs = (this.pc + this.addrRel) & 0xFFFF
      if ((this.addrAbs & 0xFF00) != (this.pc & 0xFF00)) {
        this.addCycles(1)
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
    // BIT $nnnn,X is one of the CMOS additions and note 1 applies to it: 4
    // cycles, 5 across a page. Returning 1 lets ABX's crossing result through;
    // the zero page and absolute forms return 0 there, so it cannot add a cycle
    // where the table does not.
    return 1
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
      this.addCycles(1)
      this.addrAbs = (this.pc + this.addrRel) & 0xFFFF

      if ((this.addrAbs & 0xFF00) != (this.pc & 0xFF00)) {
        this.addCycles(1)
      }

      this.pc = this.addrAbs
    }
    return 0
  }

  private BNE(): number {
    if (this.getFlag(CPU.Z) == 0) {
      this.addCycles(1)
      this.addrAbs = (this.pc + this.addrRel) & 0xFFFF

      if ((this.addrAbs & 0xFF00) != (this.pc & 0xFF00)) {
        this.addCycles(1)
      }

      this.pc = this.addrAbs
    }
    return 0
  }

  private BPL(): number {
    if (this.getFlag(CPU.N) == 0) {
      this.addCycles(1)
      this.addrAbs = (this.pc + this.addrRel) & 0xFFFF

      if ((this.addrAbs & 0xFF00) != (this.pc & 0xFF00)) {
        this.addCycles(1)
      }

      this.pc = this.addrAbs
    }
    return 0
  }

  private BRK(): number {
    // No incPC() here. BRK's addressing mode is IMM, which has already stepped
    // the PC past the signature byte, so the PC is opcode+2 — exactly what has
    // to be pushed for RTI to resume after the BRK. Incrementing again pushed
    // opcode+3 and left every BRK handler's return address one byte late.
    this.write(0x0100 + this.sp, (this.pc >> 8) & 0x00FF)
    this.decSP()
    this.write(0x0100 + this.sp, this.pc & 0x00FF)
    this.decSP()

    this.setFlag(CPU.B, true)
    this.write(0x0100 + this.sp, this.st)
    this.decSP()
    this.setFlag(CPU.B, false)

    // I is set *after* the push, not before. The byte on the stack has to carry
    // the I the interrupted code was running under, or the RTI at the end of the
    // handler comes back with interrupts still masked — a BRK handler in a
    // program that had interrupts enabled would silently disable them for good.
    //
    // BRK is an interrupt, so the CMOS D-flag clear applies to it too, and for
    // the same reason it happens after the push: RTI restores the caller's
    // decimal mode. On the NMOS part a BRK taken with D set runs the handler
    // in decimal mode.
    this.setFlag(CPU.I, true)
    this.setFlag(CPU.D, false)

    this.pc = this.read(0xFFFE) | this.read(0xFFFF) << 8

    return 0
  }
  
  private BVC(): number {
    if (this.getFlag(CPU.V) == 0) {
      this.addCycles(1)
      this.addrAbs = (this.pc + this.addrRel) & 0xFFFF

      if ((this.addrAbs & 0xFF00) != (this.pc & 0xFF00)) {
        this.addCycles(1)
      }

      this.pc = this.addrAbs
    }
    return 0
  }

  private BVS(): number {
    if (this.getFlag(CPU.V) == 1) {
      this.addCycles(1)
      this.addrAbs = (this.pc + this.addrRel) & 0xFFFF

      if ((this.addrAbs & 0xFF00) != (this.pc & 0xFF00)) {
        this.addCycles(1)
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
    // DEC $nnnn,X is a flat 7, crossing or not — the one place the shifts and
    // the counters part company. Table 4-1 prices addressing modes, so reading
    // it alone gives 4 + 2 for read-modify-write and note 1 on top, which is
    // what ASL, ROL, LSR and ROR do get. The CMOS optimisation only reached the
    // shifters: the data sheet's own opcode matrix, and every published table
    // after it, keeps INC and DEC at the NMOS 7. Hence 7 in the table here and
    // 0 returned, so ABX's page-crossing result cannot make it 8.
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
    // INC $nnnn,X is a flat 7, crossing or not — see DEC().
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
    // Read-modify-write in absolute indexed with X is 4 + 2 cycles, and note 1
    // still applies: add 1 more if the page boundary is crossed (W65C02S data
    // sheet, Table 4-1).  Returning 1 lets ABX's own page-crossing result
    // through; every other mode this instruction has returns 0 there, so the
    // extra cycle can only ever be added where the data sheet allows it.
    return 1
  }

  private NOP(): number {
    // Every W65C02S NOP has a fixed cycle count, including the multi-byte ones
    // in the unused opcode space — none of them take the extra page-crossing
    // cycle. Their operand bytes are consumed by the addressing mode in the
    // instruction table, which is what makes the PC land in the right place.
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
    // Bits 4 and 5 are not flip-flops in the processor — bit 5 reads as 1
    // always and bit 4 is a marker only ever written to the stack, set here
    // because this push came from an instruction rather than an interrupt.
    // Pushing them does not disturb the register they were merged into.
    this.write(0x0100 + this.sp, this.st | CPU.B | CPU.U)
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
    // Neither bit survives the pull: bit 5 always reads back as 1, and bit 4
    // has nowhere to be stored. Same normalisation as RTI.
    this.setFlag(CPU.B, false)
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
    // Read-modify-write in absolute indexed with X is 4 + 2 cycles, and note 1
    // still applies: add 1 more if the page boundary is crossed (W65C02S data
    // sheet, Table 4-1).  Returning 1 lets ABX's own page-crossing result
    // through; every other mode this instruction has returns 0 there, so the
    // extra cycle can only ever be added where the data sheet allows it.
    return 1
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
    // Read-modify-write in absolute indexed with X is 4 + 2 cycles, and note 1
    // still applies: add 1 more if the page boundary is crossed (W65C02S data
    // sheet, Table 4-1).  Returning 1 lets ABX's own page-crossing result
    // through; every other mode this instruction has returns 0 there, so the
    // extra cycle can only ever be added where the data sheet allows it.
    return 1
  }

  private RTI(): number {
    this.incSP()
    this.st = this.read(0x0100 + this.sp)
    // Bit 5 reads as 1 on real silicon, so it comes back set, not cleared. It
    // was clearing it here and relying on the next decode in tick() to put it
    // back, which left the status byte wrong for anything that looked at it in
    // between — a breakpoint on the RTI, or a snapshot taken there.
    this.st &= ~CPU.B
    this.st |= CPU.U
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
      // BCD decimal mode (65C02) — one extra cycle, as for ADC.
      this.addCycles(1)

      const borrow = 1 - this.getFlag(CPU.C)

      // Decimal subtract on the CMOS part is the binary difference with the
      // corrections applied to the whole byte, not a pair of nybbles assembled
      // separately: $06 off when the low nybble borrowed, $60 off when the byte
      // did. Correcting each nybble in isolation and re-joining them lands $10
      // out whenever the low nybble's borrow has to propagate — which is what
      // this did, for a few percent of every decimal SBC.
      const bin = this.a - this.fetched - borrow
      const lowBorrowed = (this.a & 0x0F) - (this.fetched & 0x0F) - borrow < 0

      let adjusted = bin
      if (bin < 0) adjusted -= 0x60
      if (lowBorrowed) adjusted -= 0x06

      const result = adjusted & 0xFF

      // As for ADC: N and Z describe the decimal result on the W65C02S, not the
      // binary difference the NMOS part reports. $00 - $50 leaves N set on an
      // NMOS part; the answer is $50, so this one clears it.
      //
      // C and V come from the binary difference, before either correction.
      this.setFlag(CPU.Z, result === 0)
      this.setFlag(CPU.N, (result & 0x80) !== 0)
      this.setFlag(CPU.C, bin >= 0)
      this.setFlag(
        CPU.V,
        ((this.a ^ this.fetched) & (this.a ^ (bin & 0xFF)) & 0x80) !== 0
      )

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
    //
    // Program counter relative is 2 cycles, add 1 if the branch is taken and
    // 1 more if it crosses a page boundary — W65C02S data sheet, Table 4-1,
    // notes 1 and 2.  BRA is always taken, so the taken cycle is added
    // unconditionally here and the opcode table's base stays 2, exactly as it
    // is for every conditional branch.
    this.addCycles(1)
    this.addrAbs = (this.pc + this.addrRel) & 0xFFFF

    if ((this.addrAbs & 0xFF00) != (this.pc & 0xFF00)) {
      this.addCycles(1)
    }

    this.pc = this.addrAbs

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
    // Stop the processor: the clock to the CPU is gated off. Interrupts do not
    // restart it, only RESET does. The instruction's own three cycles run
    // first — tick() applies the halt at the following instruction boundary.
    this.stopped = true
    return 0
  }

  private WAI(): number {
    // Wait for Interrupt: pull RDY low and sleep until IRQ, NMI or RESET.
    // PC is already past the WAI byte, so whether the interrupt is serviced
    // (I clear) or merely wakes the processor (I set), execution continues at
    // the instruction after this one. See releaseHalt().
    this.waiting = true
    return 0
  }

  /**
   * Branch on Bit Reset — a flat 6 cycles, taken or not.
   *
   * The bit branches do not behave like the ordinary ones. Table 4-1's note 2,
   * "branch taken, add 1", belongs to program-counter-relative addressing, and
   * zero page + relative is not one of that table's modes — it came from
   * Rockwell, and the W65C02S data sheet prices it nowhere. Secondary tables
   * commonly print 5, which is where the 5-plus-penalties model here came from.
   *
   * Harte's wdc65c02 suite settles it: all 10,000 cases of every BBR and BBS
   * opcode take exactly 6, and the bus trace says why. The part reads the zero
   * page byte and writes it straight back unchanged — the same
   * read-modify-write sequence RMB and SMB use, since they share the silicon —
   * and then reads the branch target whether or not it is going to take the
   * branch. Six accesses, always, so there is no penalty to add.
   *
   * The write-back itself is not emulated, only paid for. It is unobservable
   * here: the value written is the one already there, and zero page + relative
   * can only address page zero, which on this machine is RAM with no device
   * behind it. Performing it would fire a debugger watchpoint on an instruction
   * that did not change anything.
   */
  private BBR(bit: number): number {
    this.fetch()
    if ((this.fetched & (1 << bit)) == 0) {
      this.pc = (this.pc + this.addrRel) & 0xFFFF
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

  /** Branch on Bit Set — a flat 6 cycles, taken or not. See BBR. */
  private BBS(bit: number): number {
    this.fetch()
    if ((this.fetched & (1 << bit)) != 0) {
      this.pc = (this.pc + this.addrRel) & 0xFFFF
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
    { name: '???', cycles: 2, opcode: this.NOP.bind(this), addrMode: this.IMM.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'TSB', cycles: 5, opcode: this.TSB.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'ORA', cycles: 3, opcode: this.ORA.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'ASL', cycles: 5, opcode: this.ASL.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'RMB0', cycles: 5, opcode: this.RMB0.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'PHP', cycles: 3, opcode: this.PHP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'ORA', cycles: 2, opcode: this.ORA.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'ASL', cycles: 2, opcode: this.ASL.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'TSB', cycles: 6, opcode: this.TSB.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'ORA', cycles: 4, opcode: this.ORA.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'ASL', cycles: 6, opcode: this.ASL.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'BBR0', cycles: 6, opcode: this.BBR0.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'BPL', cycles: 2, opcode: this.BPL.bind(this), addrMode: this.REL.bind(this) },
    { name: 'ORA', cycles: 5, opcode: this.ORA.bind(this), addrMode: this.IZY.bind(this) },
    { name: 'ORA', cycles: 5, opcode: this.ORA.bind(this), addrMode: this.IZP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'TRB', cycles: 5, opcode: this.TRB.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'ORA', cycles: 4, opcode: this.ORA.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'ASL', cycles: 6, opcode: this.ASL.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'RMB1', cycles: 5, opcode: this.RMB1.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'CLC', cycles: 2, opcode: this.CLC.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'ORA', cycles: 4, opcode: this.ORA.bind(this), addrMode: this.ABY.bind(this) },
    { name: 'INC', cycles: 2, opcode: this.INC.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'TRB', cycles: 6, opcode: this.TRB.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'ORA', cycles: 4, opcode: this.ORA.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'ASL', cycles: 6, opcode: this.ASL.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'BBR1', cycles: 6, opcode: this.BBR1.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'JSR', cycles: 6, opcode: this.JSR.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'AND', cycles: 6, opcode: this.AND.bind(this), addrMode: this.IZX.bind(this) },
    { name: '???', cycles: 2, opcode: this.NOP.bind(this), addrMode: this.IMM.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'BIT', cycles: 3, opcode: this.BIT.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'AND', cycles: 3, opcode: this.AND.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'ROL', cycles: 5, opcode: this.ROL.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'RMB2', cycles: 5, opcode: this.RMB2.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'PLP', cycles: 4, opcode: this.PLP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'AND', cycles: 2, opcode: this.AND.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'ROL', cycles: 2, opcode: this.ROL.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'BIT', cycles: 4, opcode: this.BIT.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'AND', cycles: 4, opcode: this.AND.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'ROL', cycles: 6, opcode: this.ROL.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'BBR2', cycles: 6, opcode: this.BBR2.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'BMI', cycles: 2, opcode: this.BMI.bind(this), addrMode: this.REL.bind(this) },
    { name: 'AND', cycles: 5, opcode: this.AND.bind(this), addrMode: this.IZY.bind(this) },
    { name: 'AND', cycles: 5, opcode: this.AND.bind(this), addrMode: this.IZP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'BIT', cycles: 4, opcode: this.BIT.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'AND', cycles: 4, opcode: this.AND.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'ROL', cycles: 6, opcode: this.ROL.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'RMB3', cycles: 5, opcode: this.RMB3.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'SEC', cycles: 2, opcode: this.SEC.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'AND', cycles: 4, opcode: this.AND.bind(this), addrMode: this.ABY.bind(this) },
    { name: 'DEC', cycles: 2, opcode: this.DEC.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'BIT', cycles: 4, opcode: this.BIT.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'AND', cycles: 4, opcode: this.AND.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'ROL', cycles: 6, opcode: this.ROL.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'BBR3', cycles: 6, opcode: this.BBR3.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'RTI', cycles: 6, opcode: this.RTI.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'EOR', cycles: 6, opcode: this.EOR.bind(this), addrMode: this.IZX.bind(this) },
    { name: '???', cycles: 2, opcode: this.NOP.bind(this), addrMode: this.IMM.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 3, opcode: this.NOP.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'EOR', cycles: 3, opcode: this.EOR.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'LSR', cycles: 5, opcode: this.LSR.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'RMB4', cycles: 5, opcode: this.RMB4.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'PHA', cycles: 3, opcode: this.PHA.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'EOR', cycles: 2, opcode: this.EOR.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'LSR', cycles: 2, opcode: this.LSR.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'JMP', cycles: 3, opcode: this.JMP.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'EOR', cycles: 4, opcode: this.EOR.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'LSR', cycles: 6, opcode: this.LSR.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'BBR4', cycles: 6, opcode: this.BBR4.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'BVC', cycles: 2, opcode: this.BVC.bind(this), addrMode: this.REL.bind(this) },
    { name: 'EOR', cycles: 5, opcode: this.EOR.bind(this), addrMode: this.IZY.bind(this) },
    { name: 'EOR', cycles: 5, opcode: this.EOR.bind(this), addrMode: this.IZP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 4, opcode: this.NOP.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'EOR', cycles: 4, opcode: this.EOR.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'LSR', cycles: 6, opcode: this.LSR.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'RMB5', cycles: 5, opcode: this.RMB5.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'CLI', cycles: 2, opcode: this.CLI.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'EOR', cycles: 4, opcode: this.EOR.bind(this), addrMode: this.ABY.bind(this) },
    { name: 'PHY', cycles: 3, opcode: this.PHY.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 8, opcode: this.NOP.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'EOR', cycles: 4, opcode: this.EOR.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'LSR', cycles: 6, opcode: this.LSR.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'BBR5', cycles: 6, opcode: this.BBR5.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'RTS', cycles: 6, opcode: this.RTS.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'ADC', cycles: 6, opcode: this.ADC.bind(this), addrMode: this.IZX.bind(this) },
    { name: '???', cycles: 2, opcode: this.NOP.bind(this), addrMode: this.IMM.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'STZ', cycles: 3, opcode: this.STZ.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'ADC', cycles: 3, opcode: this.ADC.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'ROR', cycles: 5, opcode: this.ROR.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'RMB6', cycles: 5, opcode: this.RMB6.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'PLA', cycles: 4, opcode: this.PLA.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'ADC', cycles: 2, opcode: this.ADC.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'ROR', cycles: 2, opcode: this.ROR.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'JMP', cycles: 6, opcode: this.JMP.bind(this), addrMode: this.IND.bind(this) },
    { name: 'ADC', cycles: 4, opcode: this.ADC.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'ROR', cycles: 6, opcode: this.ROR.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'BBR6', cycles: 6, opcode: this.BBR6.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'BVS', cycles: 2, opcode: this.BVS.bind(this), addrMode: this.REL.bind(this) },
    { name: 'ADC', cycles: 5, opcode: this.ADC.bind(this), addrMode: this.IZY.bind(this) },
    { name: 'ADC', cycles: 5, opcode: this.ADC.bind(this), addrMode: this.IZP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'STZ', cycles: 4, opcode: this.STZ.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'ADC', cycles: 4, opcode: this.ADC.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'ROR', cycles: 6, opcode: this.ROR.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'RMB7', cycles: 5, opcode: this.RMB7.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'SEI', cycles: 2, opcode: this.SEI.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'ADC', cycles: 4, opcode: this.ADC.bind(this), addrMode: this.ABY.bind(this) },
    { name: 'PLY', cycles: 4, opcode: this.PLY.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'JMP', cycles: 6, opcode: this.JMP.bind(this), addrMode: this.IAX.bind(this) },
    { name: 'ADC', cycles: 4, opcode: this.ADC.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'ROR', cycles: 6, opcode: this.ROR.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'BBR7', cycles: 6, opcode: this.BBR7.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'BRA', cycles: 2, opcode: this.BRA.bind(this), addrMode: this.REL.bind(this) },
    { name: 'STA', cycles: 6, opcode: this.STA.bind(this), addrMode: this.IZX.bind(this) },
    { name: '???', cycles: 2, opcode: this.NOP.bind(this), addrMode: this.IMM.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'STY', cycles: 3, opcode: this.STY.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'STA', cycles: 3, opcode: this.STA.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'STX', cycles: 3, opcode: this.STX.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'SMB0', cycles: 5, opcode: this.SMB0.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'DEY', cycles: 2, opcode: this.DEY.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'BIT', cycles: 2, opcode: this.BIT_IMM.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'TXA', cycles: 2, opcode: this.TXA.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'STY', cycles: 4, opcode: this.STY.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'STA', cycles: 4, opcode: this.STA.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'STX', cycles: 4, opcode: this.STX.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'BBS0', cycles: 6, opcode: this.BBS0.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'BCC', cycles: 2, opcode: this.BCC.bind(this), addrMode: this.REL.bind(this) },
    { name: 'STA', cycles: 6, opcode: this.STA.bind(this), addrMode: this.IZY.bind(this) },
    { name: 'STA', cycles: 5, opcode: this.STA.bind(this), addrMode: this.IZP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'STY', cycles: 4, opcode: this.STY.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'STA', cycles: 4, opcode: this.STA.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'STX', cycles: 4, opcode: this.STX.bind(this), addrMode: this.ZPY.bind(this) },
    { name: 'SMB1', cycles: 5, opcode: this.SMB1.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'TYA', cycles: 2, opcode: this.TYA.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'STA', cycles: 5, opcode: this.STA.bind(this), addrMode: this.ABY.bind(this) },
    { name: 'TXS', cycles: 2, opcode: this.TXS.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'STZ', cycles: 4, opcode: this.STZ.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'STA', cycles: 5, opcode: this.STA.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'STZ', cycles: 5, opcode: this.STZ.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'BBS1', cycles: 6, opcode: this.BBS1.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'LDY', cycles: 2, opcode: this.LDY.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'LDA', cycles: 6, opcode: this.LDA.bind(this), addrMode: this.IZX.bind(this) },
    { name: 'LDX', cycles: 2, opcode: this.LDX.bind(this), addrMode: this.IMM.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'LDY', cycles: 3, opcode: this.LDY.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'LDA', cycles: 3, opcode: this.LDA.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'LDX', cycles: 3, opcode: this.LDX.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'SMB2', cycles: 5, opcode: this.SMB2.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'TAY', cycles: 2, opcode: this.TAY.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'LDA', cycles: 2, opcode: this.LDA.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'TAX', cycles: 2, opcode: this.TAX.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'LDY', cycles: 4, opcode: this.LDY.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'LDA', cycles: 4, opcode: this.LDA.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'LDX', cycles: 4, opcode: this.LDX.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'BBS2', cycles: 6, opcode: this.BBS2.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'BCS', cycles: 2, opcode: this.BCS.bind(this), addrMode: this.REL.bind(this) },
    { name: 'LDA', cycles: 5, opcode: this.LDA.bind(this), addrMode: this.IZY.bind(this) },
    { name: 'LDA', cycles: 5, opcode: this.LDA.bind(this), addrMode: this.IZP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'LDY', cycles: 4, opcode: this.LDY.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'LDA', cycles: 4, opcode: this.LDA.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'LDX', cycles: 4, opcode: this.LDX.bind(this), addrMode: this.ZPY.bind(this) },
    { name: 'SMB3', cycles: 5, opcode: this.SMB3.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'CLV', cycles: 2, opcode: this.CLV.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'LDA', cycles: 4, opcode: this.LDA.bind(this), addrMode: this.ABY.bind(this) },
    { name: 'TSX', cycles: 2, opcode: this.TSX.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'LDY', cycles: 4, opcode: this.LDY.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'LDA', cycles: 4, opcode: this.LDA.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'LDX', cycles: 4, opcode: this.LDX.bind(this), addrMode: this.ABY.bind(this) },
    { name: 'BBS3', cycles: 6, opcode: this.BBS3.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'CPY', cycles: 2, opcode: this.CPY.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'CMP', cycles: 6, opcode: this.CMP.bind(this), addrMode: this.IZX.bind(this) },
    { name: '???', cycles: 2, opcode: this.NOP.bind(this), addrMode: this.IMM.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'CPY', cycles: 3, opcode: this.CPY.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'CMP', cycles: 3, opcode: this.CMP.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'DEC', cycles: 5, opcode: this.DEC.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'SMB4', cycles: 5, opcode: this.SMB4.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'INY', cycles: 2, opcode: this.INY.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'CMP', cycles: 2, opcode: this.CMP.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'DEX', cycles: 2, opcode: this.DEX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'WAI', cycles: 3, opcode: this.WAI.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'CPY', cycles: 4, opcode: this.CPY.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'CMP', cycles: 4, opcode: this.CMP.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'DEC', cycles: 6, opcode: this.DEC.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'BBS4', cycles: 6, opcode: this.BBS4.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'BNE', cycles: 2, opcode: this.BNE.bind(this), addrMode: this.REL.bind(this) },
    { name: 'CMP', cycles: 5, opcode: this.CMP.bind(this), addrMode: this.IZY.bind(this) },
    { name: 'CMP', cycles: 5, opcode: this.CMP.bind(this), addrMode: this.IZP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 4, opcode: this.NOP.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'CMP', cycles: 4, opcode: this.CMP.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'DEC', cycles: 6, opcode: this.DEC.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'SMB5', cycles: 5, opcode: this.SMB5.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'CLD', cycles: 2, opcode: this.CLD.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'CMP', cycles: 4, opcode: this.CMP.bind(this), addrMode: this.ABY.bind(this) },
    { name: 'PHX', cycles: 3, opcode: this.PHX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'STP', cycles: 3, opcode: this.STP.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 4, opcode: this.NOP.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'CMP', cycles: 4, opcode: this.CMP.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'DEC', cycles: 7, opcode: this.DEC.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'BBS5', cycles: 6, opcode: this.BBS5.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'CPX', cycles: 2, opcode: this.CPX.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'SBC', cycles: 6, opcode: this.SBC.bind(this), addrMode: this.IZX.bind(this) },
    { name: '???', cycles: 2, opcode: this.NOP.bind(this), addrMode: this.IMM.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'CPX', cycles: 3, opcode: this.CPX.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'SBC', cycles: 3, opcode: this.SBC.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'INC', cycles: 5, opcode: this.INC.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'SMB6', cycles: 5, opcode: this.SMB6.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'INX', cycles: 2, opcode: this.INX.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'SBC', cycles: 2, opcode: this.SBC.bind(this), addrMode: this.IMM.bind(this) },
    { name: 'NOP', cycles: 2, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'CPX', cycles: 4, opcode: this.CPX.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'SBC', cycles: 4, opcode: this.SBC.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'INC', cycles: 6, opcode: this.INC.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'BBS6', cycles: 6, opcode: this.BBS6.bind(this), addrMode: this.ZPR.bind(this) },

    { name: 'BEQ', cycles: 2, opcode: this.BEQ.bind(this), addrMode: this.REL.bind(this) },
    { name: 'SBC', cycles: 5, opcode: this.SBC.bind(this), addrMode: this.IZY.bind(this) },
    { name: 'SBC', cycles: 5, opcode: this.SBC.bind(this), addrMode: this.IZP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 4, opcode: this.NOP.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'SBC', cycles: 4, opcode: this.SBC.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'INC', cycles: 6, opcode: this.INC.bind(this), addrMode: this.ZPX.bind(this) },
    { name: 'SMB7', cycles: 5, opcode: this.SMB7.bind(this), addrMode: this.ZP0.bind(this) },
    { name: 'SED', cycles: 2, opcode: this.SED.bind(this), addrMode: this.IMP.bind(this) },
    { name: 'SBC', cycles: 4, opcode: this.SBC.bind(this), addrMode: this.ABY.bind(this) },
    { name: 'PLX', cycles: 4, opcode: this.PLX.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 1, opcode: this.NOP.bind(this), addrMode: this.IMP.bind(this) },
    { name: '???', cycles: 4, opcode: this.NOP.bind(this), addrMode: this.ABS.bind(this) },
    { name: 'SBC', cycles: 4, opcode: this.SBC.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'INC', cycles: 7, opcode: this.INC.bind(this), addrMode: this.ABX.bind(this) },
    { name: 'BBS7', cycles: 6, opcode: this.BBS7.bind(this), addrMode: this.ZPR.bind(this) } 
  ]

}