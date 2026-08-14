#!/usr/bin/env node
// Downloads the third-party CPU conformance suites into test-suites/.
//
// Nothing here is ours: these are the reference suites the wider 6502 community
// uses to certify a core, and the point of running them is that their
// expectations were derived from real silicon rather than from our emulator. The
// directory is gitignored — the Harte suite alone is about a gigabyte — so this
// script is how a fresh checkout gets them.
//
// Usage:
//   node scripts/fetch-conformance-tests.mjs            # everything
//   node scripts/fetch-conformance-tests.mjs klaus      # one suite
//   node scripts/fetch-conformance-tests.mjs harte 00 01 7f
//
// Re-running is cheap: a file already on disk at the expected size is skipped,
// so an interrupted download resumes where it left off.

import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const suites = join(root, 'test-suites')

const KLAUS = 'https://raw.githubusercontent.com/Klaus2m5/6502_65C02_functional_tests/master'
const HARTE = 'https://raw.githubusercontent.com/SingleStepTests/ProcessorTests/main/wdc65c02/v1'
// Klaus assembles with as65, which is Windows-only. amb5l's fork carries ca65
// translations whose output is byte-compared against Klaus's own binaries, so
// building the decimal test from there is not a hand translation of ours.
const AMB5L = 'https://raw.githubusercontent.com/amb5l/6502_65C02_functional_tests/master/ca65'
// AllSuiteA comes from the HMC-6502 project, whose original Google Code home is
// gone; this is the long-standing mirror alongside its source and Makefile.
const HMC = 'https://raw.githubusercontent.com/pmonta/FPGA-netlist-tools/master/6502-test-code'

const klausFiles = [
  [`${KLAUS}/bin_files/6502_functional_test.bin`, 'klaus/6502_functional_test.bin'],
  [`${KLAUS}/bin_files/65C02_extended_opcodes_test.bin`, 'klaus/65C02_extended_opcodes_test.bin'],
  // Bruce Clark's decimal test ships as source, not a binary, because which CPU
  // it predicts results for is an assembly-time switch. buildDecimalTest() sets
  // it to the 65C02 and assembles.
  [`${AMB5L}/6502_decimal_test.ca65`, 'klaus/6502_decimal_test.ca65'],
  [`${AMB5L}/example.cfg`, 'klaus/example.cfg'],
  // A raw image that loads and runs at $4000. The .asm is fetched too — it is
  // the only documentation of which numbered test a failure refers to.
  [`${HMC}/AllSuiteA.bin`, 'hmc/AllSuiteA.bin'],
  [`${HMC}/AllSuiteA.asm`, 'hmc/AllSuiteA.asm']
]

const harteOpcodes = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

// WAI and STP cannot be expressed as a single-step test — the processor stops —
// so Harte ships them as zero-byte files. They are covered by W65C02S.test.ts.
const harteOmitted = new Set(['cb', 'db'])

async function sizeOf(path) {
  try {
    return (await stat(path)).size
  } catch {
    return -1
  }
}

async function download(url, dest, { minSize = 1 } = {}) {
  const existing = await sizeOf(dest)
  if (existing >= minSize) return 'skipped'

  const response = await fetch(url)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`)
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length < minSize) throw new Error(`${url} returned only ${body.length} bytes`)

  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, body)
  return 'downloaded'
}

/** Run `jobs` with a bounded number in flight, reporting as they land. */
async function pool(jobs, limit, label) {
  let next = 0
  let done = 0
  let downloaded = 0
  const failures = []

  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++]
      try {
        if ((await job.run()) === 'downloaded') downloaded++
      } catch (error) {
        failures.push(`${job.name}: ${error.message}`)
      }
      done++
      if (done % 16 === 0 || done === jobs.length) {
        process.stdout.write(`\r  ${label}: ${done}/${jobs.length}`)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker))
  process.stdout.write(`\r  ${label}: ${done}/${jobs.length} (${downloaded} new)\n`)
  for (const failure of failures) console.error(`  FAILED ${failure}`)
  return failures.length === 0
}

async function fetchKlaus() {
  console.log("Klaus Dormann's functional tests + Bruce Clark's decimal test")
  const jobs = klausFiles.map(([from, to]) => ({
    name: to,
    run: () => download(from, join(suites, to), { minSize: 256 })
  }))
  const ok = await pool(jobs, 4, 'klaus')
  return (await buildDecimalTest()) && ok
}

/**
 * Assemble Bruce Clark's decimal test with cputype switched to the 65C02.
 *
 * The switch is the source's own documented configuration line, and flipping it
 * changes which predicted-result routine gets assembled: the 65C02 one, where N
 * and Z are valid after a decimal add and the SBC prediction accounts for the
 * CMOS low-nybble correction. Left at 0 the test predicts NMOS results and a
 * correct W65C02S fails it.
 *
 * Also emits a symbol table scraped from the ca65 listing, so the test reads
 * ERROR and the operands from wherever they actually landed.
 */
async function buildDecimalTest() {
  const dir = join(suites, 'klaus')
  const bin = join(dir, '65C02_decimal_test.bin')
  if ((await sizeOf(bin)) === 65536) return true

  try {
    await run('ca65', ['--version'])
  } catch {
    console.error('  ca65 not found — skipping the decimal test build.')
    console.error('  Install cc65 (brew install cc65) and re-run to enable it.')
    return true
  }

  const source = await readFile(join(dir, '6502_decimal_test.ca65'), 'utf8')
  const patched = source.replace(/^cputype = 0/m, 'cputype = 1')
  if (patched === source) {
    console.error('  Could not find the cputype switch in 6502_decimal_test.ca65.')
    return false
  }

  const src = join(dir, '65C02_decimal_test.ca65')
  await writeFile(src, patched)
  const lst = join(dir, '65C02_decimal_test.lst')
  const obj = join(dir, '65C02_decimal_test.o')

  try {
    await run('ca65', ['--cpu', '65c02', '-l', lst, src])
    await run('ld65', [obj, '-o', bin, '-C', join(dir, 'example.cfg')])
  } catch (error) {
    console.error(`  Assembling the decimal test failed: ${error.message}`)
    return false
  }

  // Listing lines look like "000400  1  A0 01        TEST:   ldy #1", with the
  // address column already absolute because the source .orgs both segments.
  const symbols = {}
  for (const line of (await readFile(lst, 'utf8')).split('\n')) {
    const address = /^([0-9A-F]{6})\s/.exec(line)
    const label = /\s([A-Za-z_][A-Za-z0-9_]*):/.exec(line)
    if (address && label) symbols[label[1]] = parseInt(address[1], 16)
  }
  await writeFile(join(dir, '65C02_decimal_test.symbols.json'), JSON.stringify(symbols, null, 2))
  console.log(`  built 65C02_decimal_test.bin (${Object.keys(symbols).length} symbols)`)
  return true
}

async function fetchHarte(only) {
  const requested = only.length > 0 ? only.map((o) => o.toLowerCase().padStart(2, '0')) : harteOpcodes
  const wanted = requested.filter((op) => !harteOmitted.has(op))
  console.log(`Tom Harte's ProcessorTests, wdc65c02 v1 (${wanted.length} files, ~4MB each)`)
  const jobs = wanted.map((op) => ({
    name: `${op}.json`,
    // 10,000 cases per opcode; anything under a megabyte is a truncated file.
    run: () => download(`${HARTE}/${op}.json`, join(suites, 'harte', `${op}.json`), { minSize: 1_000_000 })
  }))
  return pool(jobs, 8, 'harte')
}

const [which, ...rest] = process.argv.slice(2)
const wantKlaus = !which || which === 'klaus'
const wantHarte = !which || which === 'harte'

if (which && !wantKlaus && !wantHarte) {
  console.error(`Unknown suite "${which}". Expected "klaus" or "harte".`)
  process.exit(2)
}

let ok = true
if (wantKlaus) ok = (await fetchKlaus()) && ok
if (wantHarte) ok = (await fetchHarte(wantHarte && which === 'harte' ? rest : [])) && ok

console.log(ok ? '\nAll requested suites present.' : '\nSome downloads failed — re-run to retry.')
process.exit(ok ? 0 : 1)
