import { CPU } from '../core/CPU'

/**
 * The interrupt sequence, tested against the ways emulators usually get it wrong.
 *
 * This is the least externally-verified corner of the core. Harte's suite steps
 * one instruction at a time and so cannot express an interrupt at all, and the
 * one third-party suite that does cover interrupts — Klaus Dormann's
 * 6502_interrupt_test — exists only for an assembler that does not run on this
 * machine. So the failure modes are enumerated here by hand instead, from what
 * the sequence is documented to do and from the mistakes that recur in other
 * implementations.
 *
 * Each test names the specific way it can go wrong, because the interesting
 * thing about interrupt bugs is that the handler usually still *runs* — what
 * breaks is the return, one layer down, much later.
 */
describe('interrupts', () => {
  let memory: Uint8Array
  let cpu: CPU

  const RESET = 0x8000
  const IRQ = 0x9000
  const NMI = 0x9100

  beforeEach(() => {
    memory = new Uint8Array(0x10000)
    cpu = new CPU(
      (address) => memory[address & 0xffff],
      (address, data) => {
        memory[address & 0xffff] = data & 0xff
      }
    )
    memory[0xfffc] = RESET & 0xff
    memory[0xfffd] = RESET >> 8
    memory[0xfffe] = IRQ & 0xff
    memory[0xffff] = IRQ >> 8
    memory[0xfffa] = NMI & 0xff
    memory[0xfffb] = NMI >> 8

    // The program page is NOPs, not zeroes. Zero is BRK, which vectors through
    // $FFFE exactly as an IRQ does — so a test that runs off the end of what it
    // meant to place lands in the handler anyway and passes for the wrong reason.
    memory.fill(0xea, RESET, RESET + 0x100)
  })

  function place(address: number, ...bytes: number[]): void {
    bytes.forEach((byte, i) => {
      memory[(address + i) & 0xffff] = byte
    })
  }

  /** Boot, then run the CLI that reset's I mask makes necessary. */
  function bootWithInterruptsOn(): void {
    place(RESET, 0x58) // CLI
    cpu.reset()
    cpu.step()
  }

  /** The three bytes an interrupt leaves on the stack, given the SP before it. */
  function frame(spBefore: number): { pch: number; pcl: number; status: number } {
    return {
      pch: memory[0x0100 + ((spBefore - 0) & 0xff)],
      pcl: memory[0x0100 + ((spBefore - 1) & 0xff)],
      status: memory[0x0100 + ((spBefore - 2) & 0xff)]
    }
  }

  describe('the status byte an interrupt pushes', () => {
    it('pushes I as the interrupted code had it, so RTI gives interrupts back', () => {
      // The one that hides the longest. Set I before pushing and the handler's
      // RTI returns with interrupts masked, so the machine takes exactly one
      // interrupt and then goes deaf — with nothing wrong at the point of
      // failure to look at. BRK had this bug.
      bootWithInterruptsOn()
      const sp = cpu.sp

      cpu.irq()

      expect(frame(sp).status & CPU.I).toBe(0)
      expect(cpu.st & CPU.I).toBe(CPU.I) // but the handler itself runs masked
    })

    it('clears B on an IRQ and sets it on a BRK, which is how a handler tells them apart', () => {
      // Both vector through $FFFE. The pushed B bit is the only thing that
      // distinguishes them, so a handler that serves both reads it off the
      // stack. Get it wrong and BRK-based debuggers and syscall ABIs break.
      bootWithInterruptsOn()

      const irqSp = cpu.sp
      cpu.irq()
      expect(frame(irqSp).status & CPU.B).toBe(0)

      place(IRQ, 0x40) // RTI, back to the interrupted code
      cpu.step()

      place(cpu.pc, 0x00, 0xea) // BRK and its signature byte
      const brkSp = cpu.sp
      cpu.step()
      expect(frame(brkSp).status & CPU.B).toBe(CPU.B)
    })

    it('pushes bit 5 set, as it reads on real silicon', () => {
      bootWithInterruptsOn()
      const sp = cpu.sp

      cpu.irq()

      expect(frame(sp).status & CPU.U).toBe(CPU.U)
    })

    it('pushes D as the interrupted code had it, then runs the handler in binary', () => {
      place(RESET, 0x58, 0xf8) // CLI, SED
      cpu.reset()
      cpu.step()
      cpu.step()
      const sp = cpu.sp

      cpu.irq()

      expect(frame(sp).status & CPU.D).toBe(CPU.D)
      expect(cpu.st & CPU.D).toBe(0)
    })

    it('pushes the same frame for an NMI', () => {
      place(RESET, 0x58, 0xf8) // CLI, SED
      cpu.reset()
      cpu.step()
      cpu.step()
      const sp = cpu.sp

      cpu.nmi()

      const pushed = frame(sp).status
      expect(pushed & CPU.B).toBe(0)
      expect(pushed & CPU.U).toBe(CPU.U)
      expect(pushed & CPU.I).toBe(0)
      expect(pushed & CPU.D).toBe(CPU.D)
      expect(cpu.st & CPU.I).toBe(CPU.I)
      expect(cpu.st & CPU.D).toBe(0)
    })
  })

  describe('the return address', () => {
    it('pushes the instruction that was about to run, and RTI resumes exactly there', () => {
      bootWithInterruptsOn()
      const resume = cpu.pc
      const sp = cpu.sp

      cpu.irq()

      const { pch, pcl } = frame(sp)
      expect((pch << 8) | pcl).toBe(resume)

      place(IRQ, 0x40) // RTI
      cpu.step()
      // Not resume + 1. RTI pulls the address and uses it as-is, where RTS adds
      // one — sharing that code between them re-runs a byte of the interrupted
      // instruction as an opcode.
      expect(cpu.pc).toBe(resume)
    })

    it('restores the whole status byte through RTI, D and carry included', () => {
      place(RESET, 0x58, 0xf8, 0x38) // CLI, SED, SEC
      cpu.reset()
      cpu.step()
      cpu.step()
      cpu.step()
      const before = cpu.st

      cpu.irq()
      place(IRQ, 0x18, 0xd8, 0x40) // CLC, CLD, RTI — trample what it restores
      cpu.step()
      cpu.step()
      cpu.step()

      expect(cpu.st).toBe(before)
    })
  })

  describe('the stack', () => {
    it('wraps inside page one rather than writing outside it', () => {
      // A machine whose interrupt frame escapes page one corrupts whatever is
      // below $0100 — zero page, which is where everything lives.
      bootWithInterruptsOn()
      cpu.sp = 0x01
      const before = cpu.st

      cpu.irq()

      expect(cpu.sp).toBe(0xfe)
      expect(memory[0x0101]).toBe(RESET >> 8) // PCH at $0101
      expect(memory[0x0100]).toBe(0x01) // PCL at $0100
      expect(memory[0x01ff]).toBe(before) // status wrapped round to $01FF
      expect(memory[0x00ff]).toBe(0) // zero page untouched
    })

    it('unwinds back through the wrap on RTI', () => {
      bootWithInterruptsOn()
      const resume = cpu.pc
      cpu.sp = 0x01

      cpu.irq()
      place(IRQ, 0x40)
      cpu.step()

      expect(cpu.sp).toBe(0x01)
      expect(cpu.pc).toBe(resume)
    })
  })

  describe('masking', () => {
    it('does not take an IRQ while I is set, and does not lose it either', () => {
      // Reset leaves I set. The line stays asserted, so the interrupt is still
      // waiting when the program is ready for it.
      place(RESET, 0xea, 0x58, 0xea) // NOP, CLI, NOP
      cpu.reset()
      cpu.irqTrigger()

      cpu.step() // NOP, with I still set from reset
      expect(cpu.pc).toBe(RESET + 1)

      cpu.step() // CLI
      cpu.step() // and now it is taken
      expect(cpu.pc).toBe(IRQ)
    })

    it('costs nothing while it is masked', () => {
      place(RESET, 0xea)
      cpu.reset()
      while (cpu.cyclesRem > 0) cpu.tick()

      const before = cpu.cycles
      cpu.irq() // I is set, so this must not push, vector, or charge cycles
      expect(cpu.cycles).toBe(before)
      expect(cpu.sp).toBe(0xfd)
    })

    it('takes an NMI regardless of I, including inside an IRQ handler', () => {
      bootWithInterruptsOn()

      cpu.irq()
      expect(cpu.pc).toBe(IRQ)
      expect(cpu.st & CPU.I).toBe(CPU.I)

      const sp = cpu.sp
      cpu.nmi()

      expect(cpu.pc).toBe(NMI)
      expect(frame(sp).status & CPU.I).toBe(CPU.I) // the handler's own masked state
      expect(cpu.sp).toBe((sp - 3) & 0xff)
    })
  })

  describe('the line, not the event', () => {
    it('re-enters the handler after RTI while the line is still asserted', () => {
      // Level-triggered, like the real pin: a handler that returns without
      // clearing the source at the device is supposed to be called straight
      // back. An emulator that treats the request as a one-shot event runs the
      // handler once and then silently drops the device's interrupts.
      bootWithInterruptsOn()
      place(IRQ, 0x40) // RTI, without acknowledging anything
      cpu.irqTrigger()

      cpu.step()
      expect(cpu.pc).toBe(IRQ)

      cpu.step() // RTI, and straight back in
      expect(cpu.pc).toBe(IRQ)
    })

    it('stops re-entering once the line is released', () => {
      bootWithInterruptsOn()
      place(IRQ, 0x40)
      cpu.irqTrigger()

      cpu.step()
      expect(cpu.pc).toBe(IRQ)

      cpu.irqClear() // the handler acknowledged the device
      cpu.step() // RTI, resuming after the instruction that was interrupted
      expect(cpu.pc).toBe(RESET + 2)
      cpu.step() // and carrying on, not straight back into the handler
      expect(cpu.pc).toBe(RESET + 3)
    })

    it('never pushes a frame in the middle of an instruction', () => {
      // Asserted two cycles into a six-cycle instruction. Taken there, the
      // interrupt would push a PC pointing into the middle of an operand and
      // the RTI would return into the second byte of an address.
      place(RESET, 0x58, 0xee, 0x00, 0x20) // CLI, INC $2000 (6 cycles)
      cpu.reset()
      cpu.step() // CLI
      const sp = cpu.sp

      cpu.tick() // first cycle of INC
      cpu.irqTrigger()
      cpu.tick()
      cpu.tick()

      expect(cpu.sp).toBe(sp) // nothing pushed while the INC is in flight
      expect(cpu.pc).toBe(RESET + 4) // PC is past the operand, not inside it

      while (cpu.cyclesRem > 0) cpu.tick()
      cpu.step()

      expect(cpu.pc).toBe(IRQ)
      // Whatever it pushed, it is an instruction boundary.
      const resumed = (memory[0x0100 + cpu.sp + 3] << 8) | memory[0x0100 + cpu.sp + 2]
      expect(resumed).toBeGreaterThanOrEqual(RESET + 4)
    })
  })

  describe('cost', () => {
    it('charges 7 cycles for a serviced IRQ, on top of the instruction', () => {
      place(RESET, 0x58, 0xea)
      cpu.reset()
      while (cpu.cyclesRem > 0) cpu.tick()
      cpu.step() // CLI
      cpu.irqTrigger()

      const before = cpu.cycles
      cpu.step() // NOP, then the interrupt
      expect(cpu.cycles - before).toBe(2 + 7)
    })

    it('charges 7 for an NMI and 6 for the RTI that ends it', () => {
      place(RESET, 0xea)
      cpu.reset()
      while (cpu.cyclesRem > 0) cpu.tick()
      place(NMI, 0x40)

      const beforeNmi = cpu.cycles
      cpu.nmi()
      expect(cpu.cycles - beforeNmi).toBe(7)

      const beforeRti = cpu.cycles
      cpu.step()
      expect(cpu.cycles - beforeRti).toBe(6)
    })
  })

  describe('nesting', () => {
    it('unwinds a BRK taken inside an IRQ handler through both RTIs', () => {
      bootWithInterruptsOn()
      const resume = cpu.pc

      cpu.irq()
      place(IRQ, 0x00, 0xea, 0x40) // BRK, signature, RTI
      cpu.step() // BRK — vectors back to $9000, one level down

      expect(cpu.pc).toBe(IRQ)
      expect(cpu.sp).toBe(0xf7) // two frames of three, from $FD

      // Skip past the BRK handler's own entry to the RTI that ends the inner one.
      cpu.pc = IRQ + 2
      cpu.step() // inner RTI, back to after the BRK signature
      expect(cpu.pc).toBe(IRQ + 2)

      cpu.step() // outer RTI, back to the interrupted program
      expect(cpu.pc).toBe(resume)
      expect(cpu.sp).toBe(0xfd)
    })
  })

  describe('when the interrupt is sampled', () => {
    it('waits one instruction after CLI before taking a request already waiting', () => {
      // The classic one. The mask is read before CLI's final cycle, and CLI
      // writes I in that cycle — so at the moment of the decision interrupts
      // were still masked, and the request has to wait for the end of the next
      // instruction. Service it as soon as CLI retires and the instruction the
      // CLI was protecting never gets to run.
      place(RESET, 0x78, 0x58, 0xea, 0xea) // SEI, CLI, NOP, NOP
      cpu.reset()
      cpu.step() // SEI
      cpu.irqTrigger()

      cpu.step() // CLI — the request is not serviced yet
      expect(cpu.pc).toBe(RESET + 2)

      cpu.step() // the NOP runs, and *then* the interrupt is taken
      expect(cpu.pc).toBe(IRQ)
      // Proof that the NOP ran first: the pushed return address is past it.
      expect((memory[0x0100 + cpu.sp + 3] << 8) | memory[0x0100 + cpu.sp + 2]).toBe(RESET + 3)
    })

    it('takes one last request at SEI, which was already decided before I was set', () => {
      // The same rule the other way round, and the one with teeth. The mask was
      // clear when it was read, so the interrupt is taken once as SEI retires,
      // even though SEI has by then masked interrupts. Suppress it and a
      // critical section opened with SEI looks tighter here than on the board.
      place(RESET, 0x58, 0x78, 0xea) // CLI, SEI, NOP
      cpu.reset()
      cpu.step() // CLI
      cpu.irqTrigger()

      cpu.step() // SEI

      expect(cpu.pc).toBe(IRQ)
      expect(cpu.st & CPU.I).toBe(CPU.I)
      // The status byte it pushed has I *set* — SEI did run, and RTI will put
      // the critical section back the way the program asked for it.
      expect(memory[0x0100 + cpu.sp + 1] & CPU.I).toBe(CPU.I)
    })

    it('does not delay RTI, whose pulled mask is in place before the lines are read', () => {
      // RTI restores the status byte three cycles before it ends, so unlike CLI
      // the mask it brings back is already current at the moment of the
      // decision. An interrupt still asserted is taken immediately on return,
      // not an instruction later — which is what makes a handler that returns
      // without acknowledging its device loop tightly rather than leaking one
      // instruction of the interrupted program per pass.
      bootWithInterruptsOn()
      place(IRQ, 0x40) // RTI, acknowledging nothing
      cpu.irqTrigger()

      cpu.step() // NOP, then the interrupt
      expect(cpu.pc).toBe(IRQ)

      cpu.step() // RTI, and straight back in with no instruction in between
      expect(cpu.pc).toBe(IRQ)
      expect((memory[0x0100 + cpu.sp + 3] << 8) | memory[0x0100 + cpu.sp + 2]).toBe(RESET + 2)
    })

    it('delays a PLP that unmasks, and honours a PLP that masks', () => {
      // PLP pulls the status byte in its own final cycle, so it behaves exactly
      // as CLI and SEI do: whichever way it moves I, the decision was already
      // made against the mask from before it ran.
      place(RESET, 0x78, 0x28, 0xea, 0xea) // SEI, PLP, NOP, NOP
      cpu.reset()
      memory[0x01fd] = CPU.U // a status byte with I clear, ready to pull
      cpu.sp = 0xfc
      cpu.step() // SEI
      cpu.irqTrigger()

      cpu.step() // PLP unmasks, but too late to be noticed
      expect(cpu.st & CPU.I).toBe(0)
      expect(cpu.pc).toBe(RESET + 2)

      cpu.step() // the NOP, and then the interrupt
      expect(cpu.pc).toBe(IRQ)
    })

    it('runs one more instruction than the part does when the line rises mid-instruction', () => {
      // RECORDED, NOT BLESSED — the last known divergence in the sampling
      // rule, and the one a running machine actually meets, because timers do
      // not politely fire between instructions.
      //
      // The two above are fixed: what the mask *was* at the sampling moment is
      // now modelled. When the sampling moment happens is not. The lines are
      // read here at the instant an instruction is decoded, so a device that
      // asserts IRQ *during* an instruction has missed that instruction's read
      // and is not noticed until the end of the next one. The part reads before
      // the final cycle of the instruction in progress and vectors at that
      // instruction's own boundary, with nothing in between.
      //
      // The cost is up to one instruction of extra interrupt latency — jitter in
      // anything that times itself off an interrupt, not a wrong result from any
      // instruction.
      //
      // Not fixed because it is not a bug in the rule, it is the resolution of
      // the clock the rule is evaluated on. This core runs an instruction's
      // memory accesses all at once when it decodes, so "before the final cycle"
      // is not a moment it currently has. Getting it needs a two-phase latch —
      // read the lines when cyclesRem falls to 1, act on that at the boundary —
      // which brings two consequences worth deciding on deliberately: the latch
      // becomes state a snapshot has to carry, and the interrupt sequence stops
      // sharing a tick with an instruction decode, so one cpu.step() in the
      // debugger becomes "the interrupt" rather than "the instruction and then
      // the interrupt". Both are fine; neither is a quiet change.
      place(RESET, 0x58, 0xee, 0x00, 0x20) // CLI, INC $2000 (6 cycles)
      cpu.reset()
      cpu.step() // CLI

      cpu.tick() // INC starts; the sample for it has already been taken
      cpu.irqTrigger()
      while (cpu.cyclesRem > 0) cpu.tick() // INC finishes — the part vectors here

      expect(cpu.pc).toBe(RESET + 4) // but this core has not vectored yet

      cpu.step() // it runs the NOP at $8004 first, and only then vectors
      expect(cpu.pc).toBe(IRQ)
      expect((memory[0x0100 + cpu.sp + 3] << 8) | memory[0x0100 + cpu.sp + 2]).toBe(RESET + 5)
    })
  })
})
