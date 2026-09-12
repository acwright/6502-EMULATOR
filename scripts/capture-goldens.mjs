#!/usr/bin/env node

/**
 * Capture the golden frames the VDP rewrite is measured against (PLAN.md §3).
 *
 *   npm run capture:goldens              capture every fixture
 *   npm run capture:goldens -- bios      capture one
 *   npm run capture:goldens -- --check   capture nothing; report what would move
 *
 * What a golden is, how far each fixture is run, and what is read off it are all
 * in `src/tests/goldens/fixtures.js`, shared with `Goldens.test.ts` so that the
 * run this script records and the run the test checks are the same run. This
 * file is only the part that cannot be shared: finding a build of the engine,
 * writing the files, and saying what changed.
 *
 * It drives the compiled engine in `out/`, so `npm run build:cli` has to have
 * been run — `npm run capture:goldens` does that first. The test drives `src/`
 * through ts-jest instead, which is the point: a golden that only reproduces
 * inside one toolchain is not evidence of anything.
 *
 * **Re-capturing is a deliberate act.** PLAN.md ground rule 4: a golden that
 * moves is either an intended change — re-captured in its own commit, with the
 * reason in the message — or a bug. Editing one to turn a red test green is how
 * the oracle stops being an oracle. `--check` exists so that "did anything
 * move?" never requires overwriting the answer.
 */

import { createRequire } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(ROOT, 'package.json'))

const fixtures = require(join(ROOT, 'src', 'tests', 'goldens', 'fixtures.js'))

const OUT_ENGINE = join(ROOT, 'out', 'core', 'Machine.js')

function main() {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const names = args.filter((arg) => !arg.startsWith('--'))

  if (!existsSync(OUT_ENGINE)) {
    fail(`no compiled engine at ${relative(ROOT, OUT_ENGINE)} — run \`npm run build:cli\``)
  }

  const engine = {
    Machine: require(OUT_ENGINE).Machine,
    RTC: require(join(ROOT, 'out', 'core', 'IO', 'RTC.js')).RTC
  }

  const selected = names.length
    ? fixtures.FIXTURES.filter((fixture) => names.includes(fixture.name))
    : fixtures.FIXTURES
  if (!selected.length) {
    fail(`no such fixture: ${names.join(', ')} (have ${fixtures.FIXTURES.map((f) => f.name).join(', ')})`)
  }

  let moved = 0
  let written = 0

  for (const fixture of selected) {
    process.stdout.write(`${fixture.name} — ${fixture.description}\n`)
    const started = Date.now()

    // Boot twice and compare before writing anything. The whole oracle rests on
    // the machine producing the same frames from the same cold start, and a
    // golden captured from a fixture that does not is worse than no golden at
    // all — it fails later, in another phase, looking like that phase's bug.
    // PLAN.md risk 6 says verify this here rather than discovering it in Phase 5.
    const first = capture(engine, fixture)
    const second = capture(engine, fixture)
    for (const [checkpoint, capturedFirst] of first) {
      const drift = describeDifference(capturedFirst, second.get(checkpoint))
      if (drift) fail(`${fixture.name}/${checkpoint} is not deterministic: ${drift}`)
    }

    for (const [checkpoint, captured] of first) {
      const existing = readExisting(fixture.name, checkpoint)
      const difference = existing ? describeDifference(captured, existing) : null

      if (!existing) {
        report(check ? 'new' : 'write', fixture.name, checkpoint, 'no golden yet')
        moved++
      } else if (difference) {
        report(check ? 'MOVED' : 'rewrite', fixture.name, checkpoint, difference)
        moved++
      } else {
        report('same', fixture.name, checkpoint, '')
      }

      if (!check) {
        const paths = fixtures.writeGolden(fixture.name, checkpoint, captured)
        written += Object.keys(paths).length
      }
    }

    process.stdout.write(`  ${((Date.now() - started) / 1000).toFixed(1)}s, deterministic\n\n`)
  }

  if (check) {
    process.stdout.write(
      moved === 0
        ? 'Every golden still matches the emulator.\n'
        : `${moved} checkpoint(s) would change. Re-capture deliberately: see PLAN.md ground rule 4.\n`
    )
    process.exit(moved === 0 ? 0 : 1)
  }

  process.stdout.write(`Wrote ${written} file(s) under ${relative(ROOT, fixtures.GOLDENS_DIR)}/.\n`)
  if (moved > 0) {
    process.stdout.write(
      `${moved} checkpoint(s) changed — commit them on their own, and say why.\n`
    )
  }
}

/** Run one fixture, returning its checkpoints in order. */
function capture(engine, fixture) {
  const captures = new Map()
  fixtures.runFixture(engine, fixture, (checkpoint, state) => captures.set(checkpoint, state))
  return captures
}

function readExisting(fixtureName, checkpoint) {
  const paths = fixtures.goldenPaths(fixtureName, checkpoint)
  if (!Object.values(paths).every((path) => existsSync(path) && statSync(path).isFile())) {
    return null
  }
  return fixtures.readGolden(fixtureName, checkpoint)
}

/** The first way two captures differ, most structural first, or null. */
function describeDifference(actual, expected) {
  if (!expected) return 'missing'

  const actualStructure = JSON.stringify(actual.structural)
  if (actualStructure !== JSON.stringify(expected.structural)) {
    return firstStructuralDifference(actual.structural, expected.structural)
  }
  return (
    labelled('VRAM', fixtures.diffBytes(actual.vram, expected.vram)) ??
    labelled('index frame', fixtures.diffFrame(actual.indices, expected.indices)) ??
    labelled(
      'pixel frame',
      fixtures.diffFrame(actual.rgba, expected.rgba, {
        channels: 4,
        tolerance: fixtures.PIXEL_TOLERANCE
      })
    )
  )
}

function firstStructuralDifference(actual, expected) {
  for (const key of Object.keys(actual)) {
    const a = JSON.stringify(actual[key])
    const b = JSON.stringify(expected[key])
    if (a !== b) return `${key}: ${truncate(a)}, was ${truncate(b)}`
  }
  return 'structural state'
}

function truncate(text) {
  return text.length > 72 ? `${text.slice(0, 69)}...` : text
}

function labelled(what, difference) {
  return difference === null ? null : `${what}: ${difference}`
}

function report(verdict, fixtureName, checkpoint, detail) {
  process.stdout.write(
    `  ${verdict.padEnd(7)} ${fixtureName}/${checkpoint}${detail ? ` — ${detail}` : ''}\n`
  )
}

function fail(message) {
  process.stderr.write(`capture-goldens: ${message}\n`)
  process.exit(1)
}

main()
