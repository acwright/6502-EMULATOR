#!/usr/bin/env node

/**
 * Record the golden fixtures' VDP port traffic as traces, for 6502-PICOVDP.
 *
 *   npm run record:traces              record every fixture
 *   npm run record:traces -- bios      record one
 *   npm run record:traces -- --check   record nothing; report what would change
 *
 * Each fixture is booted by `fixtures.js`'s recipe with a recorder on its video
 * card, and the trace is written beside its goldens as `<fixture>.vdpt.gz`, in
 * `6502-PICOVDP/docs/TRACE.md`'s format. What a trace is and how it is replayed
 * are in `src/tests/goldens/traces.js`; this file finds a build, refuses
 * anything that is not the oracle, and writes the files.
 *
 * A trace is only written if it is the goldens, three ways over: the recorded
 * run's captures are the goldens (so recording changed nothing), the trace
 * replayed into a card with no CPU reproduces them (so the trace is complete),
 * and every checkpoint has a settle point and a class, which the replay decides
 * and writes into the trace's checkpoint lines. A golden that has moved is
 * re-captured first, deliberately — see `capture-goldens.mjs` — and never here.
 *
 * A trace whose events are unchanged is left alone, header and all, so
 * re-recording a tree whose card has not changed changes no file.
 */

import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(ROOT, 'package.json'))

const fixtures = require(join(ROOT, 'src', 'tests', 'goldens', 'fixtures.js'))
const traces = require(join(ROOT, 'src', 'tests', 'goldens', 'traces.js'))

const OUT = join(ROOT, 'out', 'core')

function main() {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const names = args.filter((arg) => !arg.startsWith('--'))

  if (!existsSync(join(OUT, 'Machine.js'))) {
    fail(`no compiled engine in ${relative(ROOT, OUT)} — run \`npm run build:cli\``)
  }
  const engine = {
    Machine: require(join(OUT, 'Machine.js')).Machine,
    RTC: require(join(OUT, 'IO', 'RTC.js')).RTC,
    Video: require(join(OUT, 'IO', 'Video.js')).Video
  }

  const selected = names.length
    ? fixtures.FIXTURES.filter((fixture) => names.includes(fixture.name))
    : fixtures.FIXTURES
  if (!selected.length) {
    fail(`no such fixture: ${names.join(', ')} (have ${fixtures.FIXTURES.map((f) => f.name).join(', ')})`)
  }

  const emulator = emulatorCommit()
  let changed = 0

  for (const fixture of selected) {
    process.stdout.write(`${fixture.name} — ${fixture.description}\n`)
    const started = Date.now()

    const { trace, captures } = traces.recordFixture(engine, fixture, { emulator })
    for (const [checkpoint, capture] of captures) {
      const difference = differenceFromGolden(fixture.name, checkpoint, capture)
      if (difference) {
        fail(
          `${fixture.name}/${checkpoint} is not its golden with the recorder attached: ${difference}. ` +
            'Run `npm run capture:goldens -- --check` first; a trace is only recorded from goldens that hold.'
        )
      }
    }

    let analysed
    try {
      analysed = traces.analyseTrace(engine, trace)
    } catch (error) {
      fail(`${fixture.name}: the trace does not replay: ${error.message}`)
    }
    for (const checkpoint of analysed) {
      const difference = differenceFromGolden(fixture.name, checkpoint.name, checkpoint.capture)
      if (difference) fail(`${fixture.name}/${checkpoint.name} replays wrong: ${difference}`)
    }
    const annotated = traces.annotateTrace(trace, analysed)

    const path = traces.tracePath(fixture.name)
    const existing = existsSync(path) ? traces.decodeTrace(readFileSync(path)) : null
    const same = existing && sameLines(existing.lines, annotated.lines)

    for (const checkpoint of analysed) {
      process.stdout.write(
        `  ${checkpoint.class.padEnd(7)} ${fixture.name}/${checkpoint.name} — frame ${checkpoint.frame}, ` +
          `settle ${checkpoint.settle}, ${checkpoint.window} in the window\n`
      )
    }

    const events = `${annotated.lines.length} events`
    if (same) {
      process.stdout.write(`  same    ${relative(ROOT, path)} (${events})\n`)
    } else {
      changed++
      if (check) {
        process.stdout.write(`  ${existing ? 'CHANGED' : 'new    '} ${relative(ROOT, path)} (${events})\n`)
      } else {
        const file = traces.encodeTrace(annotated)
        writeFileSync(path, file)
        process.stdout.write(
          `  ${existing ? 'rewrite' : 'write  '} ${relative(ROOT, path)} (${events}, ${Math.round(file.length / 1024)} KB)\n`
        )
      }
    }
    process.stdout.write(`  ${((Date.now() - started) / 1000).toFixed(1)}s\n\n`)
  }

  if (check) {
    process.stdout.write(
      changed === 0
        ? 'Every trace is current.\n'
        : `${changed} trace(s) would change — run \`npm run record:traces\` and commit them on their own.\n`
    )
    process.exit(changed === 0 ? 0 : 1)
  }
  if (changed > 0) {
    process.stdout.write(`${changed} trace(s) written — commit them on their own, and re-sync 6502-PICOVDP.\n`)
  }
}

/** HEAD, marked dirty if anything but the traces themselves differs from it. */
function emulatorCommit() {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
    const dirty = status.split('\n').some((line) => line.trim() && !line.endsWith('.vdpt.gz'))
    return dirty ? `${head}-dirty` : head
  } catch {
    return 'unknown'
  }
}

function differenceFromGolden(fixtureName, checkpoint, capture) {
  const golden = fixtures.readGolden(fixtureName, checkpoint)
  if (JSON.stringify(capture.structural) !== JSON.stringify(golden.structural)) return 'structural state differs'
  const vram = fixtures.diffBytes(capture.vram, golden.vram, { label: 'address' })
  if (vram) return `VRAM: ${vram}`
  const frame = fixtures.diffFrame(capture.indices, golden.indices)
  if (frame) return `index frame: ${frame}`
  return null
}

function sameLines(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function fail(message) {
  process.stderr.write(`record-traces: ${message}\n`)
  process.exit(1)
}

main()
