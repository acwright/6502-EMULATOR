#!/usr/bin/env node

/**
 * Headless throughput, and the gate PLAN.md risk 4 asks for.
 *
 *   npm run bench                         every workload, gate enforced
 *   npm run bench -- wizardslab worst     some of them
 *   npm run bench -- --engine <dir>       drive another build's `out/`
 *   npm run bench -- --json               one JSON document on stdout
 *
 * The question is not "how fast is the renderer" but "does the machine still
 * keep up": the whole machine — CPU, all eight slots, the SID included — run
 * for a fixed number of emulated seconds and timed against the wall. A result
 * is a real-time multiple at a clock frequency, because that is what a user
 * feels: 1.0 is a machine running exactly as fast as the hardware, and the
 * desktop app and the browser need somewhere above that to spend on a slower
 * host, a busy main thread and the audio path.
 *
 * Real time is *both* halves of the load at once. At 2 MHz one emulated second
 * is two million CPU cycles *and* sixty frames, so the per-cycle cost of the
 * VDP halves while the CPU's doubles; neither frequency is a special case of
 * the other, and each workload is measured at both.
 *
 * Each workload runs in a process of its own. V8 optimizes for the shapes it
 * has seen, and a Video instance that has drawn four kinds of picture in one
 * process is not the one the app runs — it would make the fifth workload
 * measure the first four.
 *
 * Like `capture-goldens.mjs` it drives the compiled engine in `out/`, and the
 * fixtures come from `src/tests/goldens/fixtures.js`, so a workload boots
 * exactly the machine its golden was captured from. `--engine` points at any
 * other build with the same layout, which is how the v2.6.9 baseline in
 * PLAN.md was measured: a TMS9918 build is simply skipped for the workloads it
 * cannot draw.
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SELF = fileURLToPath(import.meta.url)
const require = createRequire(join(ROOT, 'package.json'))

const fixtures = require(join(ROOT, 'src', 'tests', 'goldens', 'fixtures.js'))

/** The clock frequencies the board offers (README: the toolbar's toggle). */
const FREQUENCIES = [1_000_000, 2_000_000]

/** Emulated seconds run, untimed, at each frequency before any are timed. */
const WARM_SECONDS = 1

/** Timed runs per frequency; the median is reported. */
const REPEATS = 5

/**
 * The gate, as real-time multiples at 2 MHz, the heavier of the two clocks.
 *
 * Measured headless, which is the most favourable place the engine runs. The
 * desktop app and the browser run the same engine on a thread they share with
 * drawing, audio and the UI, and the browser build runs on phones and tablets
 * that are slower than the machine a developer benchmarks on. A floor of 1.0
 * would be a gate that passes here and fails those users, so the floors are
 * headroom, and they were set before the first measurement rather than fitted
 * to it:
 *
 * - **Programs** — anything real software draws, legacy or not — must run at
 *   4× real time.
 * - **The worst case** is §18's worst line held on all 240 lines, which no
 *   program can produce (see {@link worstCase}), and needs only 2×: it is the
 *   ceiling rather than a workload.
 *
 * Neither is a claim about any particular slower host, none of which this
 * measures. They are a statement that a fast machine must have margin to give.
 */
const GATE = {
  program: 4,
  worst: 2
}

// ================================================================
//  Workloads
// ================================================================

/**
 * Cycles to boot the BIOS to its prompt: past the boot menu's ~5.4 million
 * cycle countdown, as the `bios` fixture does.
 */
const BOOT_CYCLES = 7_000_000

/**
 * `gate` names which floor in {@link GATE} applies. `vdp` marks a workload a
 * TMS9918 build cannot run meaningfully, so an old `--engine` skips it.
 */
const WORKLOADS = [
  {
    name: 'serial',
    description: 'BIOS at the BASIC prompt, no video card — the `run --headless` default',
    gate: 'program',
    vdp: false,
    build: (engine) => {
      const machine = new engine.Machine({ io3: fixedClock(engine), io8: new engine.Empty() })
      machine.loadROM(fixtureFile('src/renderer/public/roms/BIOS.bin'))
      machine.reset(true)
      machine.runCycles(BOOT_CYCLES)
      return { machine, advance: (cycles) => machine.runCycles(cycles) }
    }
  },
  fixtureWorkload('bios', 'program', false, 'BIOS at the BASIC prompt on the video console — Text, legacy'),
  fixtureWorkload('wizardslab', 'program', false, 'Wizards Lab playing itself — Graphics I, legacy sprites'),
  fixtureWorkload('vdp-modes', 'program', true, 'the VDP Modes sample cycling all four geometries'),
  fixtureWorkload('vdp-layers', 'program', true, 'the VDP Layers sample — Full mode, two 4bpp layers, sprites'),
  {
    name: 'worst',
    description: '§18’s worst line on every line — see worstCase()',
    gate: 'worst',
    vdp: true,
    build: (engine) => worstCase(engine)
  }
]

/**
 * A golden fixture as a workload: booted by the fixture's own recipe up to its
 * first checkpoint, so the machine is in a state its golden says is right.
 */
function fixtureWorkload(name, gate, vdp, description) {
  const fixture = fixtures.FIXTURES.find((candidate) => candidate.name === name)
  if (!fixture) throw new Error(`no golden fixture named ${name}`)
  return {
    name,
    description,
    gate,
    vdp,
    build: (engine) => {
      const steps = fixture.steps.slice(0, fixture.steps.findIndex((step) => step.capture !== undefined))
      const machine = fixtures.runFixture(engine, { ...fixture, steps }, () => {})
      return { machine, advance: (cycles) => machine.runCycles(cycles) }
    }
  }
}

/**
 * §18's worst case, on every line of the picture rather than one.
 *
 * §18 prices one line: two Full-mode 4bpp layers, and 32 magnified 16 × 16
 * sprites at 4bpp on it — and the card evaluates 64, so 32 more are covering
 * the line and dropped. Collision on, detailed collision on, which is §18's
 * "plus". Everything here is chosen to make the engine do the most it can:
 *
 * - both layers enabled, per-cell attributes, scrolled off the cell grid in both
 *   axes and moving every frame, so every line starts and ends on a partial cell
 *   and X crosses the ninth bit
 * - a quarter of the cells with the priority bit set and layer 1 transparent at
 *   index 0, so the §12 compositor cannot switch itself off
 * - flips and the ninth pattern bit set at random, so no attribute is constant
 * - SPRCOUNT 64, the `$D0` terminator off, sprites overlapping, so every one of
 *   them is evaluated and every pair collides
 *
 * No program can hold that line on every line: 64 slots of 32-pixel sprites
 * cover 32 lines at most. So the sprites are *moved down the raster* — every
 * eight display lines their Y is rewritten to sit across the lines about to be
 * drawn. That is what a program would do with scanline interrupts, done for free
 * from outside the machine, and it is the one thing here that is not the card
 * doing the work: 64 VRAM pokes 33 times a frame, which is nothing beside
 * rendering 64 sprites a line.
 *
 * The CPU runs a `JMP` to itself. Its cost per cycle is not what this measures —
 * the program workloads cover that — but it is ticked, as are the other seven
 * slots, because a worst case that left them out would be a renderer benchmark.
 */
function worstCase(engine) {
  const random = xorshift(0x6502)

  // A ROM that is a JMP to itself, with every vector pointing at it.
  const rom = new Uint8Array(0x8000).fill(0xea)
  rom.set([0x4c, 0x00, 0x80], 0x0000)
  rom.set([0x00, 0x80, 0x00, 0x80, 0x00, 0x80], 0x7ffa)

  const machine = new engine.Machine({ io3: fixedClock(engine) })
  machine.frequency = fixtures.FREQUENCY
  machine.loadROM(rom)
  machine.reset(true)

  const video = machine.video()
  if (!video || typeof video.getDisplayLine !== 'function') {
    throw new Error('worst: this engine has no 6502-PICOVDP')
  }
  const register = (index, value) => video.setRegister(index, value)
  const vram = (address, value) => video.writeVRAM(address, value)

  // §7's recommended layout, stretched for Full mode's 1200-byte tables.
  const L0NAME = 0x0000
  const L0ATTR = 0x0800
  const L1NAME = 0x1000
  const L1ATTR = 0x1800
  const SPRATTR = 0x2000
  const L0PAT = 0x4000
  const L1PAT = 0x8000
  const SPRPAT = 0xc000
  const CELLS = 40 * 30

  for (let cell = 0; cell < CELLS; cell++) {
    for (const [name, attr] of [
      [L0NAME, L0ATTR],
      [L1NAME, L1ATTR]
    ]) {
      vram(name + cell, random() & 0xff)
      // b3:0 sub-palette, b4/b5 flips, b6 priority a quarter of the time, b7
      // the ninth pattern bit (§8).
      const priority = (random() & 3) === 0 ? 0x40 : 0
      vram(attr + cell, (random() & 0xbf) | priority)
    }
  }

  // Pattern data: random nibbles, about one in eight of them zero, so layer 1
  // and the sprites are transparent in places and layer 0 is not uniform.
  for (const [base, size] of [
    [L0PAT, 0x4000],
    [L1PAT, 0x4000],
    [SPRPAT, 0x2000]
  ]) {
    for (let offset = 0; offset < size; offset++) {
      const high = random() & 7 ? (random() & 0x0f) | 1 : 0
      const low = random() & 7 ? (random() & 0x0f) | 1 : 0
      vram(base + offset, (high << 4) | low)
    }
  }

  const sprites = []
  for (let slot = 0; slot < 64; slot++) {
    const x = slot * 4 // 0-252: every sprite overlaps its neighbours
    const attributes = (random() & 0x3f) | (slot & 1 ? 0x40 : 0)
    sprites.push(SPRATTR + slot * 4)
    vram(SPRATTR + slot * 4 + 1, x)
    vram(SPRATTR + slot * 4 + 2, random() & 0xff)
    vram(SPRATTR + slot * 4 + 3, attributes)
  }

  register(0x0d, 0x04) // VMODE: Full
  register(0x01, 0x43) // MODE1: display on, 16 x 16, magnified
  register(0x10, L0NAME >> 10)
  register(0x11, L0ATTR >> 10)
  register(0x12, L0PAT >> 11)
  register(0x15, 0x32) // L0CTRL: 4bpp, per cell, enabled, index 0 opaque
  register(0x18, L1NAME >> 10)
  register(0x19, L1ATTR >> 10)
  register(0x1a, L1PAT >> 11)
  register(0x1d, 0x12) // L1CTRL: 4bpp, per cell, enabled, index 0 transparent
  register(0x20, SPRATTR >> 7)
  register(0x21, SPRPAT >> 11)
  register(0x22, 64) // SPRCOUNT
  register(0x23, 0x2b) // SPRCTRL: enabled, collision, no $D0, detailed, 4bpp
  register(0x24, 32) // SPRLIMIT

  let frame = 0
  let lastLine = -1

  const placeSprites = () => {
    const line = video.getDisplayLine()
    // Across the next eight lines: a 32-line sprite whose top is 12 lines up
    // covers this line and the 19 below it. Negative tops wrap to 241-255,
    // which §10 reads as -15...-1.
    const top = (line - 12) & 0xff
    for (const address of sprites) vram(address, top)

    if (line < lastLine) {
      // A new frame: both layers move, at different speeds and never by a
      // whole cell, with X running through the ninth bit.
      frame++
      const x0 = (frame * 3) % 320
      const x1 = (frame * 5) % 320
      register(0x13, x0 & 0xff)
      register(0x15, 0x32 | (x0 > 0xff ? 0x40 : 0))
      register(0x14, (frame * 1) % 240)
      register(0x1b, x1 & 0xff)
      register(0x1d, 0x12 | (x1 > 0xff ? 0x40 : 0))
      register(0x1c, (frame * 2) % 240)
    }
    lastLine = line
  }

  const advance = (cycles) => {
    const chunk = Math.max(1, Math.floor((machine.frequency / 60 / 262) * 8))
    let left = cycles
    while (left > 0) {
      placeSprites()
      const run = Math.min(chunk, left)
      machine.runCycles(run)
      left -= run
    }
  }

  // One frame to settle the first placement before anything is measured.
  advance(Math.round(fixtures.CYCLES_PER_FRAME))
  return { machine, advance }
}

/** The fixtures' RTC reading, so no workload depends on the wall clock. */
function fixedClock(engine) {
  return new engine.RTC(() => ({ year: 2026, month: 1, date: 1, hours: 0, minutes: 0, seconds: 0 }))
}

function fixtureFile(relativePath) {
  return new Uint8Array(require('node:fs').readFileSync(join(ROOT, relativePath)))
}

/** Deterministic, so every run of the worst case draws the same picture. */
function xorshift(seed) {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
}

// ================================================================
//  Measuring
// ================================================================

function loadEngine(dir) {
  const machinePath = join(dir, 'core', 'Machine.js')
  if (!existsSync(machinePath)) {
    fail(`no compiled engine at ${relative(ROOT, machinePath) || machinePath} — run \`npm run build:cli\``)
  }
  return {
    Machine: require(machinePath).Machine,
    RTC: require(join(dir, 'core', 'IO', 'RTC.js')).RTC,
    Empty: require(join(dir, 'core', 'IO', 'Empty.js')).Empty
  }
}

/** True when the engine's video card is a 6502-PICOVDP rather than a TMS9918. */
function engineHasVdp(engine) {
  const video = new engine.Machine().video()
  return Boolean(video && typeof video.getDisplayLine === 'function' && video.vramSize === 0x10000)
}

/** Run one workload in this process and return its measurements. */
function measure(engine, workload, seconds) {
  const { machine, advance } = workload.build(engine)
  const results = []

  for (const frequency of FREQUENCIES) {
    machine.frequency = frequency
    advance(WARM_SECONDS * frequency)

    const cycles = Math.round(seconds * frequency)
    const samples = []
    for (let repeat = 0; repeat < REPEATS; repeat++) {
      const started = performance.now()
      advance(cycles)
      samples.push(performance.now() - started)
    }
    samples.sort((a, b) => a - b)
    const wallMs = samples[Math.floor(samples.length / 2)]
    const realtime = (seconds * 1000) / wallMs

    results.push({
      frequency,
      wallMs: round(wallMs, 1),
      realtime: round(realtime, 2),
      mhz: round((cycles / wallMs) * 1000 / 1e6, 2),
      fps: Math.round(realtime * 60)
    })
  }

  return results
}

function round(value, places) {
  const scale = 10 ** places
  return Math.round(value * scale) / scale
}

// ================================================================
//  Driver
// ================================================================

function main() {
  const args = process.argv.slice(2)
  const option = (name) => {
    const index = args.indexOf(name)
    if (index < 0) return undefined
    const value = args[index + 1]
    args.splice(index, 2)
    return value
  }
  const flag = (name) => {
    const index = args.indexOf(name)
    if (index < 0) return false
    args.splice(index, 1)
    return true
  }

  const engineDir = resolve(option('--engine') ?? join(ROOT, 'out'))
  const seconds = Number(option('--seconds') ?? 2)
  const one = option('--one')
  const json = flag('--json')
  const noGate = flag('--no-gate')

  // The child: measure one workload, print JSON, exit.
  if (one) {
    const engine = loadEngine(engineDir)
    const workload = WORKLOADS.find((candidate) => candidate.name === one)
    process.stdout.write(JSON.stringify(measure(engine, workload, seconds)))
    return
  }

  const names = args.filter((arg) => !arg.startsWith('--'))
  const selected = names.length
    ? WORKLOADS.filter((workload) => names.some((name) => workload.name.startsWith(name)))
    : WORKLOADS
  if (!selected.length) {
    fail(`no such workload: ${names.join(', ')} (have ${WORKLOADS.map((w) => w.name).join(', ')})`)
  }

  const engine = loadEngine(engineDir)
  const hasVdp = engineHasVdp(engine)
  const report = {
    engine: relative(ROOT, engineDir).startsWith('..') ? engineDir : relative(ROOT, engineDir) || '.',
    vdp: hasVdp,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    seconds,
    gate: GATE,
    workloads: []
  }

  if (!json) {
    process.stdout.write(
      `engine ${report.engine} (${hasVdp ? '6502-PICOVDP' : 'TMS9918'}), node ${process.version}, ` +
        `${report.platform}, ${seconds} emulated s × ${REPEATS}, median\n\n`
    )
    process.stdout.write(
      `${'workload'.padEnd(12)}${'1 MHz'.padStart(22)}${'2 MHz'.padStart(22)}   floor\n`
    )
  }

  let failed = 0
  for (const workload of selected) {
    if (workload.vdp && !hasVdp) {
      report.workloads.push({ name: workload.name, skipped: 'needs a 6502-PICOVDP' })
      if (!json) process.stdout.write(`${workload.name.padEnd(12)}${'skipped — needs a 6502-PICOVDP'.padStart(44)}\n`)
      continue
    }

    const child = spawnSync(
      process.execPath,
      [SELF, '--one', workload.name, '--engine', engineDir, '--seconds', String(seconds)],
      { encoding: 'utf8', maxBuffer: 1 << 20 }
    )
    if (child.status !== 0) {
      fail(`${workload.name}: ${child.stderr.trim() || `exited ${child.status}`}`)
    }

    const results = JSON.parse(child.stdout)
    const floor = GATE[workload.gate]
    const atTwo = results.find((result) => result.frequency === 2_000_000)
    const passed = noGate || atTwo.realtime >= floor
    if (!passed) failed++

    report.workloads.push({ name: workload.name, description: workload.description, floor, passed, results })

    if (!json) {
      const cell = (result) => `${result.realtime.toFixed(2)}× ${`(${result.mhz.toFixed(1)} MHz)`.padStart(11)}`
      process.stdout.write(
        `${workload.name.padEnd(12)}${cell(results[0]).padStart(22)}${cell(results[1]).padStart(22)}` +
          `   ${floor}×${passed ? '' : '  BELOW'}\n`
      )
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    process.stdout.write(
      '\n× is emulated seconds per wall second; MHz is CPU cycles per wall second. ' +
        'The floor applies at 2 MHz.\n'
    )
    process.stdout.write(
      noGate
        ? 'Gate not enforced (--no-gate).\n'
        : failed === 0
          ? 'Every workload clears its floor.\n'
          : `${failed} workload(s) below the floor — PLAN.md risk 4.\n`
    )
  }

  process.exit(noGate || failed === 0 ? 0 : 1)
}

function fail(message) {
  process.stderr.write(`bench: ${message}\n`)
  process.exit(1)
}

// Importable, for checking a workload draws what it says it draws.
export { WORKLOADS, loadEngine }

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
