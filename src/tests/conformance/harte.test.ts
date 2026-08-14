import { readFileSync } from 'fs'

import { createBus, flagDiff, flags, hex, missingSuiteMessage, suiteExists, suitePath } from './support'
import type { Bus } from './support'

/**
 * Tom Harte's ProcessorTests, wdc65c02 v1.
 *
 * 10,000 generated cases for each of the 254 single-steppable opcodes: an
 * initial processor and memory state, the state a real W65C02S ends in, and the
 * bus activity cycle by cycle. Nothing in it was written against this emulator,
 * which is the entire point — it is the outside opinion on what the part does.
 *
 * WHAT THIS CHECKS, AND WHAT IT DOES NOT
 *
 * Registers, PC, stack pointer, every status bit, memory, and the total cycle
 * count, per case. That is 2.5 million assertions about behaviour, and it is
 * where the subtle things live: the extra cycle a decimal ADC takes, the flags a
 * CMOS decimal SBC leaves behind, whether an indexed read crossing a page pays
 * for the crossing, how wide an undefined opcode is.
 *
 * It does not check the order of bus accesses within an instruction. This core
 * executes an instruction's reads and writes together and then accounts for the
 * cycles, rather than doing one bus access per tick, so the trace would not line
 * up even when the instruction is perfectly correct. Cycle *counts* are checked,
 * which is what the rest of the machine is timed against; per-cycle bus ordering
 * would only be observable to an I/O device sitting on a dummy read.
 */

interface HarteState {
  pc: number
  s: number
  a: number
  x: number
  y: number
  p: number
  ram: [number, number][]
}

interface HarteCase {
  name: string
  initial: HarteState
  final: HarteState
  cycles: [number, number, string][]
}

/** How many failing cases to describe before summarising the rest. */
const REPORTED = 4

/**
 * The one place we knowingly disagree with this suite.
 *
 * $5C is an undefined opcode. The W65C02S data sheet's own opcode matrix prices
 * it at three bytes and eight cycles — conspicuously, since every other
 * three-byte undefined opcode in that table is four, including $DC and $FC,
 * which this suite and this emulator both agree are four. A manufacturer does
 * not single one out as eight unless the silicon does something unusual there.
 * Harte's data says four, with the last operand byte read twice, which is what a
 * generic three-byte no-op looks like when a model has nothing specific to say.
 *
 * So the data sheet wins for the part we claim to be, and the disagreement is
 * pinned rather than waved through: the exception asserts the exact numbers on
 * both sides, and fires if either of them moves.
 */
const CYCLE_DIVERGENCE = new Map<number, { ours: number; theirs: number; why: string }>([
  [0x5c, { ours: 8, theirs: 4, why: 'undefined opcode; data sheet says 8, this suite says 4' }]
])

const OPCODES = Array.from({ length: 256 }, (_, i) => i)
  // WAI and STP stop the processor, so Harte ships no cases for them; they are
  // covered by W65C02S.test.ts instead.
  .filter((opcode) => opcode !== 0xcb && opcode !== 0xdb)

function fileFor(opcode: number): string {
  return `${opcode.toString(16).padStart(2, '0')}.json`
}

function describeCase(test: HarteCase, problems: string[]): string {
  const { initial } = test
  return (
    `  ${test.name}  ` +
    `pc=${hex(initial.pc, 4)} a=${hex(initial.a)} x=${hex(initial.x)} y=${hex(initial.y)} ` +
    `s=${hex(initial.s)} p=${flags(initial.p)}\n` +
    problems.map((problem) => `      ${problem}`).join('\n')
  )
}

/**
 * Run every case in one opcode's file, returning a report of what failed.
 *
 * Memory is a single 64K buffer reused across all 10,000 cases, restored by
 * touched address rather than being cleared wholesale — zeroing 64K a few
 * million times costs more than running the instructions does.
 */
function runOpcode(bus: Bus, opcode: number): string {
  const cases: HarteCase[] = JSON.parse(readFileSync(suitePath('harte', fileFor(opcode)), 'utf8'))
  const { cpu, memory, writes } = bus

  let failed = 0
  const reports: string[] = []

  for (const test of cases) {
    const { initial, final } = test

    for (const [address, value] of initial.ram) memory[address] = value

    cpu.pc = initial.pc
    cpu.a = initial.a
    cpu.x = initial.x
    cpu.y = initial.y
    cpu.sp = initial.s
    cpu.st = initial.p
    cpu.cyclesRem = 0
    cpu.waiting = false
    cpu.stopped = false

    writes.length = 0
    const cycles = cpu.step()

    const problems: string[] = []
    if (cpu.pc !== final.pc) problems.push(`pc ${hex(final.pc, 4)} expected, got ${hex(cpu.pc, 4)}`)
    if (cpu.a !== final.a) problems.push(`a ${hex(final.a)} expected, got ${hex(cpu.a)}`)
    if (cpu.x !== final.x) problems.push(`x ${hex(final.x)} expected, got ${hex(cpu.x)}`)
    if (cpu.y !== final.y) problems.push(`y ${hex(final.y)} expected, got ${hex(cpu.y)}`)
    if (cpu.sp !== final.s) problems.push(`s ${hex(final.s)} expected, got ${hex(cpu.sp)}`)
    if (cpu.st !== final.p) {
      problems.push(
        `p ${flags(final.p)} expected, got ${flags(cpu.st)} (${flagDiff(final.p, cpu.st)})`
      )
    }
    const divergence = CYCLE_DIVERGENCE.get(opcode)
    if (divergence) {
      if (cycles !== divergence.ours || test.cycles.length !== divergence.theirs) {
        problems.push(
          `cycle divergence for this opcode is recorded as ours=${divergence.ours} ` +
            `theirs=${divergence.theirs} (${divergence.why}), but this case is ` +
            `ours=${cycles} theirs=${test.cycles.length} — revisit the exception`
        )
      }
    } else if (cycles !== test.cycles.length) {
      problems.push(`${test.cycles.length} cycles expected, took ${cycles}`)
    }

    // Every address the case names, plus anywhere we wrote of our own accord —
    // a write outside the named set is a bug the final state would otherwise
    // hide, since it only lists memory the instruction is supposed to touch.
    const expected = new Map<number, number>()
    for (const [address, value] of initial.ram) expected.set(address, value)
    for (const [address, value] of final.ram) expected.set(address, value)
    for (const address of writes) if (!expected.has(address)) expected.set(address, 0)

    for (const [address, value] of expected) {
      if (memory[address] !== value) {
        problems.push(`${hex(address, 4)} = ${hex(value)} expected, got ${hex(memory[address])}`)
      }
    }

    if (problems.length > 0) {
      failed++
      if (reports.length < REPORTED) reports.push(describeCase(test, problems))
    }

    // Restore only what moved, ready for the next case.
    for (const [address] of expected) memory[address] = 0
  }

  if (failed === 0) return ''
  return (
    `${failed} of ${cases.length} cases failed for opcode ${hex(opcode)}:\n` +
    reports.join('\n') +
    (failed > reports.length ? `\n  ... and ${failed - reports.length} more` : '')
  )
}

const available = suiteExists('harte', fileFor(0))

;(available ? describe : describe.skip)("Tom Harte's ProcessorTests (wdc65c02 v1)", () => {
  if (!available) {
    it.skip(missingSuiteMessage("Tom Harte's wdc65c02 suite"), () => {})
    return
  }

  const bus = createBus()

  for (const opcode of OPCODES) {
    it(`opcode ${hex(opcode)}`, () => {
      const report = runOpcode(bus, opcode)
      if (report !== '') throw new Error(report)
    })
  }
})
