import { readFileSync } from 'fs'

import {
  createBus,
  enter,
  flags,
  hex,
  loadImage,
  missingSuiteMessage,
  runToTrap,
  suiteExists,
  suitePath
} from './support'

/**
 * Klaus Dormann's functional tests, and Bruce Clark's decimal test.
 *
 * Where Harte's suite checks 254 opcodes one at a time in isolation, these are
 * programs. They run tens of millions of cycles of real 6502 code that computes
 * with its own results, so an instruction that is wrong in a way no single-step
 * comparison notices — because it only shows up once a branch, an index and a
 * flag interact — still ends up trapping. Between them they are the standard the
 * wider 6502 world certifies a core against.
 *
 * All three report the same way: a failure branches to itself at the failing
 * instruction, so the address the processor comes to rest at is the diagnosis.
 * Look it up in the .lst next to the binary in test-suites/klaus.
 */

const MAX_INSTRUCTIONS = 200_000_000

describe("Klaus Dormann's functional tests", () => {
  const suite = '6502_functional_test.bin'
  const available = suiteExists('klaus', suite)

  // The test's own report of which numbered case it is on, at the address its
  // listing gives for test_case. Turns a trap address into a place to start.
  const TEST_CASE = 0x0200
  const SUCCESS = 0x3469

  ;(available ? it : it.skip)(
    available ? 'passes all 6502 opcodes and addressing modes' : missingSuiteMessage(suite),
    () => {
      const bus = createBus()
      loadImage(bus, 'klaus', suite)
      enter(bus, 0x0400)

      const result = runToTrap(bus, MAX_INSTRUCTIONS)

      expect(result.exhausted).toBe(false)
      if (result.pc !== SUCCESS) {
        throw new Error(
          `trapped at ${hex(result.pc, 4)} during test_case ` +
            `${hex(bus.memory[TEST_CASE])} after ${result.cycles} cycles ` +
            `(a=${hex(bus.cpu.a)} x=${hex(bus.cpu.x)} y=${hex(bus.cpu.y)} ` +
            `s=${hex(bus.cpu.sp)} p=${flags(bus.cpu.st)}). ` +
            `Success is ${hex(SUCCESS, 4)}; look up the trap address in ` +
            'test-suites/klaus/6502_functional_test.lst.'
        )
      }
    }
  )
})

describe("Klaus Dormann's 65C02 extended opcodes test", () => {
  const suite = '65C02_extended_opcodes_test.bin'
  const available = suiteExists('klaus', suite)

  // This one puts test_case two bytes further up than the functional test does.
  const TEST_CASE = 0x0202
  const SUCCESS = 0x24f1

  ;(available ? it : it.skip)(
    available ? 'passes every opcode the CMOS part added, defined and undefined' : missingSuiteMessage(suite),
    () => {
      const bus = createBus()
      loadImage(bus, 'klaus', suite)
      enter(bus, 0x0400)

      const result = runToTrap(bus, MAX_INSTRUCTIONS)

      expect(result.exhausted).toBe(false)
      if (result.pc !== SUCCESS) {
        throw new Error(
          `trapped at ${hex(result.pc, 4)} during test_case ` +
            `${hex(bus.memory[TEST_CASE])} after ${result.cycles} cycles ` +
            `(a=${hex(bus.cpu.a)} x=${hex(bus.cpu.x)} y=${hex(bus.cpu.y)} ` +
            `s=${hex(bus.cpu.sp)} p=${flags(bus.cpu.st)}). ` +
            `Success is ${hex(SUCCESS, 4)}; look up the trap address in ` +
            'test-suites/klaus/65C02_extended_opcodes_test.lst.'
        )
      }
    }
  )
})

describe("Bruce Clark's decimal mode test", () => {
  const suite = '65C02_decimal_test.bin'
  const available = suiteExists('klaus', suite) && suiteExists('klaus', '65C02_decimal_test.symbols.json')

  ;(available ? it : it.skip)(
    available
      ? 'adds and subtracts every pair of bytes in decimal mode, both carries'
      : missingSuiteMessage(`${suite} (needs cc65 installed to assemble)`),
    () => {
      const symbols: Record<string, number> = JSON.parse(
        readFileSync(suitePath('klaus', '65C02_decimal_test.symbols.json'), 'utf8')
      )

      const bus = createBus()
      loadImage(bus, 'klaus', suite)
      enter(bus, symbols.TEST)

      // The program's second instruction stores 1 in ERROR and only clears it
      // once every case has passed, so seeing that happen confirms the symbol
      // addresses scraped from the listing line up with the binary.
      bus.cpu.step()
      bus.cpu.step()
      expect(bus.memory[symbols.ERROR]).toBe(1)

      const result = runToTrap(bus, MAX_INSTRUCTIONS)
      expect(result.exhausted).toBe(false)
      expect(result.pc).toBe(symbols.DONE)

      if (bus.memory[symbols.ERROR] !== 0) {
        // N1 and N2 are the operands it stopped on and Y is the carry in. DA and
        // DNVZC are what this CPU produced; AR, NF, VF, ZF and CF are what the
        // test predicted for a W65C02S using binary arithmetic only.
        const at = (name: string): number => bus.memory[symbols[name]]
        throw new Error(
          `decimal mode is wrong for N1=${hex(at('N1'))} N2=${hex(at('N2'))} ` +
            `carry-in=${bus.cpu.y}: got a=${hex(at('DA'))} p=${flags(at('DNVZC'))}, ` +
            `predicted a=${hex(at('AR'))} ` +
            `n=${(at('NF') >> 7) & 1} v=${(at('VF') >> 6) & 1} ` +
            `z=${(at('ZF') >> 1) & 1} c=${at('CF') & 1}`
        )
      }
    }
  )
})
