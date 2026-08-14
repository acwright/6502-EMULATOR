import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

import { CPU } from '../../core/CPU'

/**
 * Shared plumbing for the third-party conformance suites.
 *
 * These suites are not ours and are not in the repository — see
 * scripts/fetch-conformance-tests.mjs. Everything here is about giving the CPU a
 * flat 64K of RAM and no I/O, which is what all of them assume.
 */

export const SUITE_ROOT = join(__dirname, '..', '..', '..', 'test-suites')

export function suitePath(...parts: string[]): string {
  return join(SUITE_ROOT, ...parts)
}

export function suiteExists(...parts: string[]): boolean {
  return existsSync(suitePath(...parts))
}

/**
 * Announce a suite that cannot run because it has not been downloaded.
 *
 * Warns as well as returning the message, deliberately. Jest prints "3 skipped"
 * and not the reason, and a skip nobody notices is how a suite quietly stops
 * being run at all — which defeats the point of having it. `npm run
 * test:conformance` and CI both fetch before running, so this should only ever
 * be seen by someone invoking the Jest config directly.
 */
export function missingSuiteMessage(what: string): string {
  const message =
    `${what} is not in test-suites/, so it was SKIPPED, not passed. Run ` +
    '"npm run test:conformance", which fetches the suites first, or ' +
    '"node scripts/fetch-conformance-tests.mjs".'
  // Straight to stderr, not console.warn: Jest buffers a file's console output
  // and then discards it when every test in that file was skipped, which is
  // exactly the case this needs to be heard in.
  process.stderr.write(`\n  !! ${message}\n\n`)
  return message
}

/** A CPU wired to a flat 64K array, with every write recorded. */
export interface Bus {
  cpu: CPU
  memory: Uint8Array
  /** Addresses written since `writes` was last cleared. May contain repeats. */
  writes: number[]
}

export function createBus(): Bus {
  const memory = new Uint8Array(0x10000)
  const writes: number[] = []
  const cpu = new CPU(
    (address) => memory[address & 0xffff],
    (address, data) => {
      memory[address & 0xffff] = data & 0xff
      writes.push(address & 0xffff)
    }
  )
  return { cpu, memory, writes }
}

/** Load a full 64K memory image, as all of the Klaus binaries are. */
export function loadImage(bus: Bus, ...parts: string[]): void {
  const image = readFileSync(suitePath(...parts))
  if (image.length !== 0x10000) {
    throw new Error(`${parts.join('/')} is ${image.length} bytes, expected a 65536-byte image`)
  }
  bus.memory.set(image)
}

/** Load a raw image at `address`, for suites that are not whole-memory images. */
export function loadAt(bus: Bus, address: number, ...parts: string[]): void {
  const image = readFileSync(suitePath(...parts))
  if (address + image.length > 0x10000) {
    throw new Error(`${parts.join('/')} is ${image.length} bytes, too long to load at ${address}`)
  }
  bus.memory.set(image, address)
}

/**
 * Put the processor at `pc` with the registers a monitor would leave behind.
 *
 * Not reset(): the Klaus binaries are loaded and jumped into rather than booted,
 * exactly as their headers instruct ("alter PC to 400 hex and enter a go
 * command"), and one of them writes over the reset vector on purpose.
 */
export function enter(bus: Bus, pc: number): void {
  const { cpu } = bus
  cpu.pc = pc
  cpu.a = 0
  cpu.x = 0
  cpu.y = 0
  cpu.sp = 0xfd
  cpu.st = CPU.U | CPU.I
  cpu.cyclesRem = 0
  cpu.waiting = false
  cpu.stopped = false
  cpu.irqClear()
}

export interface RunResult {
  /** Where the processor came to rest. */
  pc: number
  instructions: number
  cycles: number
  /** True when it stopped because it ran out of budget rather than trapping. */
  exhausted: boolean
}

/**
 * Run until the processor stops making progress, which is how these suites end.
 *
 * Klaus's tests report by trapping: every failure is a `bne *` or `jmp *` at the
 * failing instruction, and success is the same thing at one known address. So
 * "PC did not move" is the universal end condition — no instruction on this part
 * leaves PC where it was, WAI and STP aside, and those halt too.
 */
export function runToTrap(bus: Bus, maxInstructions: number): RunResult {
  const { cpu } = bus
  const startCycles = cpu.cycles

  for (let instructions = 1; instructions <= maxInstructions; instructions++) {
    const pc = cpu.pc
    cpu.step()
    if (cpu.pc === pc || cpu.stopped) {
      return { pc, instructions, cycles: cpu.cycles - startCycles, exhausted: false }
    }
  }

  return {
    pc: cpu.pc,
    instructions: maxInstructions,
    cycles: cpu.cycles - startCycles,
    exhausted: true
  }
}

export function hex(value: number, digits = 2): string {
  return `$${value.toString(16).toUpperCase().padStart(digits, '0')}`
}

/** Render a status byte the way a monitor would, e.g. "NV-BDIzc" for set/clear. */
export function flags(status: number): string {
  return ['N', 'V', 'U', 'B', 'D', 'I', 'Z', 'C']
    .map((name, index) => {
      const bit = 0x80 >> index
      if (name === 'U') return '-'
      return (status & bit) !== 0 ? name : name.toLowerCase()
    })
    .join('')
}

/** Which flag bits differ between two status bytes, e.g. "V, Z". */
export function flagDiff(expected: number, actual: number): string {
  const names = ['C', 'Z', 'I', 'D', 'B', 'U', 'V', 'N']
  const differing = expected ^ actual
  return names
    .filter((_, index) => (differing & (1 << index)) !== 0)
    .join(', ')
}
