#!/usr/bin/env node

/**
 * Replay VDP traces into a card with no CPU, and check them against the goldens.
 *
 *   npm run replay:traces                          every fixture's trace
 *   npm run replay:traces -- bios                  one fixture's
 *   npm run replay:traces -- path/to/x.vdpt.gz     any trace file
 *   npm run replay:traces -- --out <dir>           also write what each checkpoint shows
 *
 * The reference executor of `6502-PICOVDP/PLAN.md` section 4: a fresh `Video`,
 * ticked to each recorded event, with every read asserted and every line start
 * and `/INT` change compared (`src/tests/goldens/traces.js`). At each checkpoint
 * the index frame, VRAM and structural JSON are compared with the fixture's
 * goldens, byte for byte, and the checkpoint's class is decided again and
 * compared with what the trace says. `--out` writes the four golden files for
 * every checkpoint under `<dir>/<fixture>/`, for comparing with something that
 * is not this emulator.
 *
 * Exits 1 if anything differs.
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(ROOT, 'package.json'))

const fixtures = require(join(ROOT, 'src', 'tests', 'goldens', 'fixtures.js'))
const traces = require(join(ROOT, 'src', 'tests', 'goldens', 'traces.js'))

const VIDEO = join(ROOT, 'out', 'core', 'IO', 'Video.js')

function main() {
  const args = process.argv.slice(2)
  const outIndex = args.indexOf('--out')
  const outDir = outIndex >= 0 ? resolve(args[outIndex + 1] ?? fail('--out needs a directory')) : null
  const targets = args.filter((arg, i) => !arg.startsWith('--') && (outIndex < 0 || i !== outIndex + 1))

  if (!existsSync(VIDEO)) fail(`no compiled engine at ${relative(ROOT, VIDEO)} — run \`npm run build:cli\``)
  const engine = { Video: require(VIDEO).Video }

  const paths = targets.length
    ? targets.map((target) =>
        fixtures.FIXTURES.some((fixture) => fixture.name === target) ? traces.tracePath(target) : resolve(target)
      )
    : fixtures.FIXTURES.map((fixture) => traces.tracePath(fixture.name))

  let failures = 0
  for (const path of paths) {
    if (!existsSync(path)) fail(`no trace at ${relative(ROOT, path)} — run \`npm run record:traces\``)
    const trace = traces.decodeTrace(readFileSync(path))
    const { fixture, emulator } = trace.header
    process.stdout.write(`${fixture} — ${relative(ROOT, path)}, recorded at ${emulator.slice(0, 12)}\n`)
    const started = Date.now()

    let checkpoints
    try {
      checkpoints = traces.analyseTrace(engine, trace)
    } catch (error) {
      process.stdout.write(`  FAILED  ${error.message}\n\n`)
      failures++
      continue
    }

    const annotations = traces.annotationsOf(trace)
    for (const checkpoint of checkpoints) {
      const problems = []
      const golden = fixtures.readGolden(fixture, checkpoint.name)
      if (JSON.stringify(checkpoint.capture.structural) !== JSON.stringify(golden.structural)) {
        problems.push('JSON differs')
      }
      const vram = fixtures.diffBytes(checkpoint.capture.vram, golden.vram, { label: 'address' })
      if (vram) problems.push(`VRAM: ${vram}`)
      const frame = fixtures.diffFrame(checkpoint.capture.indices, golden.indices)
      if (frame) problems.push(`index frame: ${frame}`)

      const recorded = annotations.get(checkpoint.name) ?? {}
      for (const key of ['frame', 'settle', 'window', 'class']) {
        if (recorded[key] !== checkpoint[key]) {
          problems.push(`${key} is ${checkpoint[key]}, the trace says ${recorded[key]}`)
        }
      }

      if (outDir) writeCheckpoint(outDir, fixture, checkpoint)
      if (problems.length) failures++
      process.stdout.write(
        `  ${problems.length ? 'DIFFERS' : 'exact  '} ${fixture}/${checkpoint.name} — ${checkpoint.class}, ` +
          `frame ${checkpoint.frame}, settle ${checkpoint.settle}` +
          (problems.length ? `\n          ${problems.join('\n          ')}` : '') +
          '\n'
      )
    }
    process.stdout.write(`  ${trace.lines.length} events, ${((Date.now() - started) / 1000).toFixed(1)}s\n\n`)
  }

  if (outDir) process.stdout.write(`Wrote the replayed checkpoints under ${outDir}/.\n`)
  process.stdout.write(failures === 0 ? 'Every checkpoint replays exactly.\n' : `${failures} failure(s).\n`)
  process.exit(failures === 0 ? 0 : 1)
}

function writeCheckpoint(outDir, fixture, checkpoint) {
  const base = join(outDir, fixture, checkpoint.name)
  mkdirSync(dirname(base), { recursive: true })
  const { structural, vram, indices, rgba } = checkpoint.capture
  writeFileSync(`${base}.json`, JSON.stringify(structural, null, 2) + '\n')
  writeFileSync(`${base}.vram.bin`, vram)
  writeFileSync(`${base}.idx.bin`, indices)
  writeFileSync(`${base}.png`, fixtures.encodePNG(fixtures.FRAME_WIDTH, fixtures.FRAME_HEIGHT, rgba))
}

function fail(message) {
  process.stderr.write(`replay-trace: ${message}\n`)
  process.exit(1)
}

main()
