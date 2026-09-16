'use strict'

/**
 * The golden fixtures' VDP port traffic, exported for the firmware project.
 *
 * `6502-PICOVDP` builds this card in C, and its oracle is these goldens. It
 * has no 6502 to boot the fixtures with, so it takes them as a **trace**: every
 * read and write the program made to the card's four ports, with the tick it
 * made it at, the line starts between them, `/INT`, and the checkpoints. Replayed
 * into a card with no CPU attached, a trace has to reproduce every checkpoint's
 * golden byte for byte — which is what makes it a faithful copy of the fixture as
 * far as the card can tell. The format is `6502-PICOVDP/docs/TRACE.md`,
 * version 1; this file is the reference reader and writer.
 *
 * Plain CommonJS for the same reason as `fixtures.js`, and on the same terms:
 * it takes the engine's classes as an argument, so `Traces.test.ts` runs it
 * against `src/` under ts-jest and `scripts/record-traces.mjs` and
 * `scripts/replay-trace.mjs` run it against `out/`.
 *
 * A trace is recorded through `Video.observer`, not `Machine.onRead`/`onWrite`:
 * the debugger's `Session.syncBusTaps` reassigns those, and the card is what is
 * being recorded, not the bus.
 */

const { gzipSync, gunzipSync } = require('node:zlib')
const { join } = require('node:path')
const fixtures = require('./fixtures')

const TRACE_VERSION = 1

/** The header ends, and events begin, at this line. */
const HEADER_END = '---'

/** Screen lines in a frame (§3). */
const SCREEN_LINES = 262

/**
 * The line starts that build a frame's first and last rows (§3).
 *
 * Screen line S is built as screen line S − 1 begins, so row 0 of frame k is
 * built from the state at the start of frame k − 1's screen line 261, and row
 * 239 at the start of frame k's screen line 238 — which is also when the frame
 * is presented.
 */
const FIRST_ROW_LATCH = SCREEN_LINES - 1
const LAST_ROW_LATCH = fixtures.FRAME_HEIGHT - 2

/** Where a fixture's trace is kept: beside its goldens. */
function tracePath(fixtureName) {
  return join(fixtures.GOLDENS_DIR, fixtureName, `${fixtureName}.vdpt.gz`)
}

// ================================================================
//  Recording
// ================================================================

const hex = (value) => (value < 0x10 ? '0' : '') + value.toString(16)

/**
 * A `VideoObserver` that writes TRACE.md's event lines.
 *
 * Both sides use it. The recorder attaches it to a machine's card; the replay
 * attaches one to its own bare card, and the two streams have to agree line for
 * line. So "every recorded read matches" is not a separate check: a read that
 * returned something else is a line that differs.
 *
 * `/INT` is sampled after every event and written only when it changes. It is
 * released after a cold reset (§15), which is where every trace starts.
 */
class TraceRecorder {
  constructor(video) {
    this.video = video
    this.lines = []
    this.lastTick = 0
    this.interrupt = 0
    this.started = false
  }

  push(type, fields) {
    const tick = this.video.tickCount
    this.lines.push(`${tick - this.lastTick} ${type} ${fields}`)
    this.lastTick = tick
  }

  sampleInterrupt() {
    const level = this.video.peekStatus(1) !== 0 ? 1 : 0
    if (level === this.interrupt) return
    this.interrupt = level
    this.push('I', level)
  }

  read(port, value) {
    this.push('R', `${port} ${hex(value)}`)
    this.sampleInterrupt()
  }

  write(port, value) {
    this.push('W', `${port} ${hex(value)}`)
    this.sampleInterrupt()
  }

  lineStart(screenLine, displayLine) {
    this.push('L', `${screenLine} ${displayLine}`)
    this.sampleInterrupt()
  }

  reset(coldStart, screenLine) {
    // A cold start zeroes the card's tick count, so the ticks between the last
    // event and the reset are gone by the time this hears of it. Version 1
    // therefore holds exactly one, as its first event.
    if (coldStart) {
      if (this.started) throw new Error('trace: a version 1 trace holds one cold start, first')
      this.lastTick = 0
    } else if (!this.started) {
      throw new Error('trace: a trace starts with a cold reset')
    }
    this.started = true
    this.push('X', `${coldStart ? 'cold' : 'warm'} ${screenLine}`)
    this.sampleInterrupt()
  }

  checkpoint(name) {
    this.push('C', `${name} ${this.video.tickCount}`)
  }
}

/**
 * Boot a fixture with a recorder on its video card.
 *
 * The same `runFixture` the goldens are captured by, so the captures come back
 * too: a recording whose captures differ from the goldens would mean attaching
 * the observer changed the machine, and `Traces.test.ts` says it does not.
 */
function recordFixture(engine, fixture, options = {}) {
  let recorder = null
  const captures = new Map()

  fixtures.runFixture(
    engine,
    fixture,
    (checkpoint, capture) => {
      // A trace is timed by the card's ticks and a golden by the machine's
      // cycles. They are the same count from a cold start, and a checkpoint is
      // where that is checked.
      if (recorder.video.tickCount !== capture.structural.cycles) {
        throw new Error(
          `${fixture.name}/${checkpoint}: card ticked ${recorder.video.tickCount} times in ` +
            `${capture.structural.cycles} cycles`
        )
      }
      recorder.checkpoint(checkpoint)
      captures.set(checkpoint, capture)
    },
    {
      beforeReset(machine) {
        const video = machine.video()
        if (!video) throw new Error(`${fixture.name}: the machine has no video card`)
        recorder = new TraceRecorder(video)
        video.observer = recorder
      }
    }
  )

  return {
    trace: {
      header: {
        fixture: fixture.name,
        emulator: options.emulator ?? 'unknown',
        frequency: fixtures.FREQUENCY
      },
      lines: recorder.lines
    },
    captures
  }
}

// ================================================================
//  The file
// ================================================================

/** A trace as the gzip-compressed text TRACE.md specifies. */
function encodeTrace(trace) {
  const { fixture, emulator, frequency } = trace.header
  const head = [`vdpt ${TRACE_VERSION}`, `fixture ${fixture}`, `emulator ${emulator}`, `frequency ${frequency}`, HEADER_END]
  const text = head.join('\n') + '\n' + trace.lines.join('\n') + `\nend ${trace.lines.length}\n`
  return gzipSync(Buffer.from(text, 'utf8'), { level: 9 })
}

function decodeTrace(file) {
  const all = gunzipSync(file).toString('utf8').split('\n')
  if (all[all.length - 1] === '') all.pop()

  const [magic, version] = (all[0] ?? '').split(' ')
  if (magic !== 'vdpt') throw new Error('trace: not a VDP trace')
  if (Number(version) !== TRACE_VERSION) {
    throw new Error(`trace: version ${version}, and this reads version ${TRACE_VERSION}`)
  }

  const header = {}
  let index = 1
  for (; index < all.length && all[index] !== HEADER_END; index++) {
    const space = all[index].indexOf(' ')
    header[all[index].slice(0, space)] = all[index].slice(space + 1)
  }
  if (index === all.length) throw new Error('trace: no end to the header')
  for (const key of ['fixture', 'emulator', 'frequency']) {
    if (header[key] === undefined) throw new Error(`trace: header has no ${key}`)
  }
  header.frequency = Number(header.frequency)

  const footer = all.pop() ?? ''
  const lines = all.slice(index + 1)
  if (footer !== `end ${lines.length}`) {
    throw new Error(`trace: truncated — ends "${footer}", with ${lines.length} events`)
  }
  return { header, lines }
}

/** A `C` line without the `key=value` fields the replay adds to it. */
function withoutAnnotations(line) {
  return line
    .split(' ')
    .filter((field) => !field.includes('='))
    .join(' ')
}

/** The events that are the program's, not the analysis's. */
function eventsOf(trace) {
  return trace.lines.map((line) => (line.includes(' C ') ? withoutAnnotations(line) : line))
}

// ================================================================
//  Replay
// ================================================================

class TraceDivergence extends Error {}

function divergence(trace, index, expected, actual) {
  return new TraceDivergence(
    `${trace.header.fixture}: event ${index + 1} is "${expected}", the replay made "${actual}"`
  )
}

/**
 * Replay a trace into a bare card, and check it produces the same trace.
 *
 * Only the program's side is fed in — resets, reads, writes and checkpoints, at
 * the ticks they were recorded at. Line starts and `/INT` are the card's side:
 * they happen by themselves as it is ticked, and are compared. The first line
 * that differs throws.
 *
 * Returns each checkpoint, in order, with the capture a golden holds and where
 * the golden frame was built: `frame`, the frame it is (counting the one in
 * progress at the cold start as 0); `settle`, how many reads and writes came
 * before its first row was latched; and `window`, how many came while its rows
 * were — between that latch and the last row's.
 *
 * `options.freezeAt = { settle, frame }` stops following the trace at that
 * frame's first-row latch, with `settle` operations applied, and ticks on with
 * no more until the frame is presented. Its index frame is returned as
 * `frozen`. See `analyseTrace`.
 */
function replayTrace(engine, trace, options = {}) {
  const { Video } = engine
  const { frequency } = trace.header
  const lines = trace.lines
  const freezeAt = options.freezeAt

  const video = new Video()
  const produced = new TraceRecorder(video)
  video.observer = produced

  let compared = 0
  const check = () => {
    for (; compared < produced.lines.length; compared++) {
      const actual = produced.lines[compared]
      const expected = actual.includes(' C ') ? withoutAnnotations(lines[compared] ?? '') : lines[compared]
      if (actual !== expected) throw divergence(trace, compared, expected, actual)
    }
  }

  let tick = 0
  let ops = 0
  let frame = 0
  let latch = null
  let presented = null
  const checkpoints = []

  // An input happens at its tick, and ticking there must not make an event the
  // trace does not have first.
  const advanceTo = (index) => {
    while (video.tickCount < tick) {
      video.tick(frequency)
      if (produced.lines.length > index) check()
    }
  }

  let frozeAtLatch = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const fields = line.split(' ')
    tick += Number(fields[0])

    switch (fields[1]) {
      case 'X':
        if (index !== 0 || fields[2] !== 'cold') {
          throw new Error(`${trace.header.fixture}: event ${index + 1}: only a leading cold reset replays`)
        }
        video.reset(true)
        break

      case 'L':
      case 'I':
        while (produced.lines.length <= index && video.tickCount < tick) video.tick(frequency)
        if (produced.lines.length <= index) {
          throw divergence(trace, index, line, `nothing by tick ${video.tickCount}`)
        }
        break

      case 'W':
      case 'R': {
        advanceTo(index)
        const port = Number(fields[2])
        if (fields[1] === 'W') video.write(port, parseInt(fields[3], 16))
        else video.read(port)
        ops++
        break
      }

      case 'C': {
        advanceTo(index)
        produced.checkpoint(fields[2])
        check()
        if (!presented) {
          throw new Error(`${trace.header.fixture}/${fields[2]}: no complete frame before it`)
        }
        const capture = fixtures.captureState({ cycles: tick, video: () => video })
        checkpoints.push({ name: fields[2], cycles: tick, capture, ...presented })
        break
      }

      default:
        throw new Error(`${trace.header.fixture}: event ${index + 1}: unknown event "${line}"`)
    }
    check()

    if (fields[1] === 'L') {
      const screenLine = Number(fields[2])
      if (screenLine === 0) frame++
      if (screenLine === FIRST_ROW_LATCH) {
        latch = { settle: ops }
        if (freezeAt && freezeAt.frame === frame + 1 && freezeAt.settle === ops) {
          frozeAtLatch = true
          break
        }
      }
      if (screenLine === LAST_ROW_LATCH && latch) {
        presented = { frame, settle: latch.settle, window: ops - latch.settle }
        latch = null
      }
    }
  }

  if (!freezeAt) return { checkpoints }
  if (!frozeAtLatch) {
    throw new Error(`${trace.header.fixture}: no first-row latch of frame ${freezeAt.frame} after ${freezeAt.settle} operations`)
  }

  // The program stops here. The card goes on scanning.
  let done = false
  video.observer = {
    read() {},
    write() {},
    reset() {},
    lineStart(screenLine) {
      if (screenLine === 0) frame++
      if (screenLine === LAST_ROW_LATCH && frame === freezeAt.frame) done = true
    }
  }
  const limit = video.tickCount + 2 * Math.ceil(frequency / 60)
  while (!done && video.tickCount < limit) video.tick(frequency)
  if (!done) throw new Error(`${trace.header.fixture}: frame ${freezeAt.frame} was never presented`)
  return { checkpoints, frozen: Uint8Array.from(video.frameIndices()) }
}

/**
 * Replay a trace, then settle each checkpoint's class.
 *
 * A checkpoint is **static** when its golden frame is a function of the state
 * at its settle point alone: replayed that far and left to run with nothing
 * more applied, the card presents the same frame. Otherwise it is **dynamic**,
 * and only a replay timed to the line reproduces it. Operations inside the
 * window do not make a checkpoint dynamic by being there — a vertical blank
 * handler moving the next frame's sprites while the bottom border is built
 * changes nothing that border shows — so the class is decided by running it,
 * not by counting them.
 */
function analyseTrace(engine, trace) {
  const { checkpoints } = replayTrace(engine, trace)
  for (const checkpoint of checkpoints) {
    const { frozen } = replayTrace(engine, trace, {
      freezeAt: { settle: checkpoint.settle, frame: checkpoint.frame }
    })
    checkpoint.class = fixtures.diffFrame(frozen, checkpoint.capture.indices) === null ? 'static' : 'dynamic'
  }
  return checkpoints
}

/** The trace with each `C` line carrying what `analyseTrace` found. */
function annotateTrace(trace, checkpoints) {
  const byName = new Map(checkpoints.map((checkpoint) => [checkpoint.name, checkpoint]))
  return {
    header: trace.header,
    lines: trace.lines.map((line) => {
      if (!line.includes(' C ')) return line
      const bare = withoutAnnotations(line)
      const found = byName.get(bare.split(' ')[2])
      if (!found || found.class === undefined) return bare
      return `${bare} frame=${found.frame} settle=${found.settle} window=${found.window} class=${found.class}`
    })
  }
}

/** The annotations on a trace's `C` lines, by checkpoint name. */
function annotationsOf(trace) {
  const result = new Map()
  for (const line of trace.lines) {
    if (!line.includes(' C ')) continue
    const fields = line.split(' ')
    const values = {}
    for (const field of fields.slice(4)) {
      const [key, value] = field.split('=')
      values[key] = key === 'class' ? value : Number(value)
    }
    result.set(fields[2], values)
  }
  return result
}

module.exports = {
  TRACE_VERSION,
  TraceRecorder,
  TraceDivergence,
  tracePath,
  recordFixture,
  encodeTrace,
  decodeTrace,
  eventsOf,
  replayTrace,
  analyseTrace,
  annotateTrace,
  annotationsOf
}
