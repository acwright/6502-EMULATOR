import { createBus, enter, hex, loadAt, missingSuiteMessage, runToTrap, suiteExists } from './support'

/**
 * AllSuiteA, from the HMC-6502 project.
 *
 * Fourteen numbered tests of the basic instruction set, each one storing its
 * result and comparing it against a value the test wrote down in advance. Much
 * narrower than the other suites here — Klaus's functional test covers
 * everything it covers and more — but it is a fourth independent author, it is
 * the traditional first thing a new 6502 core is pointed at, and it costs a few
 * milliseconds to keep running.
 *
 * It reports through $0210: $FF once every test has passed, otherwise the number
 * of the test that did not. The numbers are documented only in AllSuiteA.asm,
 * which is downloaded alongside the binary.
 */

const RESULT = 0x0210
const PASSED = 0xff
const LOAD = 0x4000

const available = suiteExists('hmc', 'AllSuiteA.bin')

describe('AllSuiteA (HMC-6502)', () => {
  ;(available ? it : it.skip)(
    available ? 'passes all fourteen tests' : missingSuiteMessage('AllSuiteA'),
    () => {
      const bus = createBus()
      loadAt(bus, LOAD, 'hmc', 'AllSuiteA.bin')
      enter(bus, LOAD)

      const result = runToTrap(bus, 1_000_000)

      expect(result.exhausted).toBe(false)
      if (bus.memory[RESULT] !== PASSED) {
        throw new Error(
          `test ${hex(bus.memory[RESULT])} failed — it came to rest at ` +
            `${hex(result.pc, 4)} after ${result.cycles} cycles. The test numbers ` +
            'are documented in test-suites/hmc/AllSuiteA.asm.'
        )
      }
    }
  )
})
